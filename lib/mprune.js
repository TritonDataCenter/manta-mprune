/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

/*
 * lib/mprune.js: implements "mprune" functionality
 *
 * A single "mprune" operation prunes some number of objects from a specific
 * date range under a single directory tree according to a single policy.  An
 * example description of a single operation might be:
 *
 *     "prune objects under '/poseidon/stor/manatee_backups/2.moray' from
 *     2013-06-01 through 2014-12-31 so that we keep exactly two objects per
 *     month"
 *
 * Broadly, this looks like this:
 *
 *     +----------------------------------------------------------------+
 *     | MpruneOperation: drives the overall operation.  This object	|
 *     | is responsible for traversing the Manta directory tree and	|
 *     | identifying the timestamps associated with objects based on	|
 *     | information encoded in each object's pathname.			|
 *     |								|
 *     |   +----------------------------------------------------+	|
 *     |   | MantaFinder: object-mode readable stream that	|	|
 *     |   | traverses a Manta directory tree			|	|
 *     |   +----------------------------------------------------+	|
 *     |        |							|
 *     |        | (pipe: objects representing objects found)		|
 *     |        v							|
 *     |   +----------------------------------------------------+	|
 *     |   | Policy (currently only supports			|	|
 *     |   | MprunePolicyTwiceMonthly).  This takes the objects	|	|
 *     |   | found and decides what to do with them.		|	|
 *     |   +----------------------------------------------------+	|
 *     |        |							|
 *     |        | (pipe: objects representing instructions		|
 *     |        v							|
 *     |   +----------------------------------------------------+	|
 *     |   | Target: either MpruneTargetDryRun (which just	|	|
 *     |   | prints the instructions) or MpruneTargetRemover	|	|
 *     |   | (which actually removes objects as requested)	|	|
 *     |   +----------------------------------------------------+	|
 *     |								|
 *     +----------------------------------------------------------------+
 */

var mod_assertplus = require('assert-plus');
var mod_cmdutil = require('cmdutil');
var mod_events = require('events');
var mod_extsprintf = require('extsprintf');
var mod_jsprim = require('jsprim');
var mod_path = require('path');
var mod_stream = require('stream');
var mod_util = require('util');
var mod_vstream = require('vstream');
var VError = require('verror');

var MantaFinder = require('manta-finder');

/* Exported interface */
exports.policyForName = policyForName;
exports.mprune = mprune;

var mpPolicies = {
    'twicemonthly': MprunePolicyTwiceMonthly
};

/*
 * Returns a named Policy (suitable for passing to mprune()) that describes how
 * to prune a set of objects.  If no policy exists, then returns an Error.
 */
function policyForName(name)
{
	var t;

	mod_assertplus.string(name, 'name');
	t = name.toLowerCase();
	if (!mpPolicies.hasOwnProperty(t)) {
		return (new VError('unsupported policy: %s', name));
	}

	return (mpPolicies[t]);
}

/*
 * Implements a single "mprune" operation, which prunes objects according to the
 * specified policy.  By the time callers get here, it's expected that they've
 * validated the arguments.
 *
 *     p_start (optional Date)    only look at objects after this timestamp
 *
 *     p_end (optional Date)      only look at objects before this timestamp
 *
 *     p_policy (constructor)     describes how to prune objects.  This should
 *                                be a return value from policyForName.
 *
 *     p_force (boolean)          do not prompt for confirmation to continue
 *                                when encountering recoverable errors
 *
 *     p_dryrun (boolean)         just report what would be removed without
 *                                actually removing anything
 *
 *     p_root (string)            root of tree to be pruned
 *
 *     p_expect (array)		  array of regular expressions.  There must be
 *				  at least one object whose basename matches
 *				  each of these regular expressions for a given
 *				  date to be satisfied.  That is, if the policy
 *				  is twice-monthly, but no day in that month has
 *				  objects that match the regular expressions in
 *				  that array, then no days' objects will be
 *				  removed.
 *
 *     p_timefmt (object)         time-format filter (see timefilter)
 *
 *     p_log (object)             bunyan-style logger
 *
 *     p_manta (object)           Manta client
 */
function mprune(args)
{
	var rv = new MpruneOperation(args);
	rv.start();
	return (rv);
}

function MpruneOperation(args)
{
	mod_assertplus.object(args, 'args');
	mod_assertplus.optionalObject(args.p_start, 'args.p_start');
	mod_assertplus.optionalObject(args.p_end, 'args.p_end');
	mod_assertplus.bool(args.p_force, 'args.p_force');
	mod_assertplus.bool(args.p_dryrun, 'args.p_dryrun');
	mod_assertplus.string(args.p_root, 'args.p_root');
	mod_assertplus.object(args.p_timefmt, 'args.p_timefmt');
	mod_assertplus.object(args.p_log, 'args.p_log');
	mod_assertplus.object(args.p_manta, 'args.p_manta');
	mod_assertplus.ok(Array.isArray(args.p_expect));
	mod_assertplus.func(args.p_policy, 'args.p_policy');

	/*
	 * This is the only supported policy for now.
	 */
	mod_assertplus.ok(args.p_policy == MprunePolicyTwiceMonthly,
	    'invalid policy');

	/* Parameters. */
	this.mp_start = args.p_start ?
	    new Date(args.p_start.getTime()) : null;
	this.mp_end = args.p_end ?
	    new Date(args.p_end.getTime()) : null;
	this.mp_force = args.p_force;
	this.mp_dryrun = args.p_dryrun;
	this.mp_root = args.p_root;
	this.mp_filter = args.p_timefmt;

	/* Helpers. */
	this.mp_log = args.p_log;
	this.mp_manta = args.p_manta;
	this.mp_policy = new (args.p_policy)({
	    'log': this.mp_log.child({ 'component': 'Policy' }),
	    'expect': args.p_expect.slice(0)
	});
	this.mp_reporter = new MpruneReporter(this.mp_dryrun);

	if (!this.mp_dryrun) {
		this.mp_target = new MpruneTargetRemover({
		    'manta': this.mp_manta,
		    'log': this.mp_log.child({
		        'component': 'MpruneTargetRemover'
		    })
		});
	} else {
		this.mp_target = null;
	}

	this.mp_filterfunc = makeFindFilter(this.mp_filter,
	    this.mp_start, this.mp_end);
	this.mp_xform = new MpruneTransformPath(this.mp_filter);

	this.mp_finder = new MantaFinder({
	    'log': this.mp_log.child({ 'component': 'MantaFinder' }),
	    'manta': this.mp_manta,
	    'root': this.mp_root,
	    'filter': this.mp_filterfunc
	});

	mod_events.EventEmitter.call(this);
}

mod_util.inherits(MpruneOperation, mod_events.EventEmitter);

MpruneOperation.prototype.start = function ()
{
	this.mp_finder.pipe(this.mp_xform);
	this.mp_xform.pipe(this.mp_policy);
	this.mp_policy.pipe(this.mp_reporter);

	if (this.mp_target !== null) {
		mod_assertplus.ok(!this.mp_dryrun);
		this.mp_reporter.pipe(this.mp_target);
		this.mp_target.on('error', this.proxyEmitError('remover'));
	} else {
		mod_assertplus.ok(this.mp_dryrun);
	}

	this.mp_finder.on('error', this.proxyEmitError('finder'));
	this.mp_policy.on('error', this.proxyEmitError('policy'));
	this.mp_reporter.on('error', this.emit.bind(this, 'error'));
	this.mp_policy.on('warn', this.emit.bind(this, 'warn'));
};

MpruneOperation.prototype.proxyEmitError = function (label)
{
	var self = this;
	return (function (error) {
		error = new VError(error, '%s', label);
		self.emit('error', error);
	});
};


/*
 * This transform stream simply parses the timestamp out of the object's path
 * and caches object basenames.
 */
function MpruneTransformPath(filter)
{
	mod_assertplus.object(filter, 'filter');
	this.mtp_filter = filter;
	mod_stream.Transform.call(this, {
	    'objectMode': true,
	    'highWaterMark': 16
	});
}

mod_util.inherits(MpruneTransformPath, mod_stream.Transform);

MpruneTransformPath.prototype._transform = function (obj, _, callback)
{
	mod_assertplus.object(obj, 'obj');
	mod_assertplus.string(obj.type, 'obj.type');
	mod_assertplus.string(obj.path, 'obj.path');

	/*
	 * We could defensively copy here, but it's probably not worth it.
	 */
	obj.start = this.mtp_filter.extractBeginTimeFor(obj.path);
	obj.basename = mod_path.basename(obj.path);
	this.push(obj);
	setImmediate(callback);
};


/*
 * Targets are object-mode streams that accept objects with properties:
 *
 *     type (string)     one of "remove", "removeDirectory", or "skip"
 *
 *     path (string)     path to an object to be removed or skipped, depending
 *                       on the type.
 *
 * If type = "skip":
 *
 *     reason (string)	 reason why an object was skipped, if type = "skip"
 */

function validateRecord(obj)
{
	mod_assertplus.object(obj, 'obj');
	mod_assertplus.string(obj.path, 'obj.path');
	if (obj.type == 'skip') {
		mod_assertplus.string(obj.reason, 'obj.reason');
	} else {
		mod_assertplus.ok(obj.type == 'remove' ||
		    obj.type == 'removeDirectory', 'unsupported type');
		mod_assertplus.ok(obj.reason === undefined);
	}
}

/*
 * The reporter prints out what would be done as we receive instructions.  In
 * dry-run mode, that's it.  In non-dry-run mode, this buffers all the objects,
 * issues a confirmation at the end, and potentially emits the objects back out
 * the other side.  It's annoying to buffer everything like this, but this is
 * already a buffering operation, and it's much better if the user gets the
 * confirmation prompt after they know exactly what's going to happen.
 */
function MpruneReporter(dryrun)
{
	mod_stream.Transform.call(this, {
	    'objectMode': true,
	    'highWaterMark': 16
	});

	this.mpr_dryrun = dryrun;
	this.mpr_buffered = [];
}

mod_util.inherits(MpruneReporter, mod_stream.Transform);

MpruneReporter.prototype._transform = function (obj, _, callback)
{
	validateRecord(obj);

	if (obj.type == 'skip') {
		console.log('would skip (%s): %s', obj.reason,
		    JSON.stringify(obj.path));
	} else {
		console.log('would remove: %s', JSON.stringify(obj.path));
		if (!this.mpr_dryrun) {
			this.mpr_buffered.push(obj);
		}
	}

	setImmediate(callback);
};

MpruneReporter.prototype._flush = function (callback)
{
	var self = this;

	if (this.mpr_buffered.length === 0) {
		self.push(null);
		callback();
		return;
	}

	mod_assertplus.ok(!this.mpr_dryrun);
	mod_cmdutil.confirm({
	    'message': 'Are you sure you want to proceed? (y/[n]) '
	}, function (result) {

		if (!result) {
			callback(new VError('aborted by user'));
			return;
		}

		self.mpr_buffered.forEach(function (o) {
			self.push(o);
		});

		self.push(null);
		callback();
	});
};


/*
 * The remover target actually removes objects.
 */
function MpruneTargetRemover(args)
{
	mod_assertplus.object(args, 'args');
	mod_assertplus.object(args.log, 'args.log');
	mod_assertplus.object(args.manta, 'args.manta');

	mod_stream.Writable.call(this, {
	    'objectMode': true,
	    'highWaterMark': 16
	});

	this.mtr_log = args.log;
	this.mtr_manta = args.manta;
}

mod_util.inherits(MpruneTargetRemover, mod_stream.Writable);

MpruneTargetRemover.prototype._write = function (obj, _, callback)
{
	var self = this;

	validateRecord(obj);
	mod_assertplus.ok(obj.type == 'remove' ||
	    obj.type == 'removeDirectory');
	console.log('mrm %s', JSON.stringify(obj.path));
	this.mtr_log.debug(obj, 'removing entry');
	this.mtr_manta.unlink(obj.path, function (err, result) {
		/*
		 * Do not stop for failures.  Do as much as we can before
		 * bailing out.
		 */
		if (err) {
			err = new VError(err, 'error removing %s',
			    JSON.stringify(obj.path));
			self.mtr_log.warn(err);
			mod_cmdutil.warn(err);
		}

		callback();
	});
};


/*
 * Policies are responsible for driving the Manta traversal and deciding what
 * actions to take.  Policies are configured with:
 *
 *     log (object)		bunyan-style logger
 *
 *     expect (array)		see p_expect in MpruneOperation constructor.
 */
function MprunePolicyTwiceMonthly(args)
{
	mod_assertplus.object(args, 'args');
	mod_assertplus.object(args.log, 'args.log');

	mod_stream.Transform.call(this, {
	    'objectMode': true,
	    'highWaterMark': 16
	});

	this.mpm_root = {};
	this.mpm_log = args.log;
	this.mpm_expect = args.expect;

	mod_vstream.wrapTransform(this);
}

mod_util.inherits(MprunePolicyTwiceMonthly, mod_stream.Transform);

/*
 * Buffer up everything we find until we're done.  Group all objects by month so
 * that we can process each month at a time.  This kind of sucks, but we need to
 * at least wait until we have an entire month's worth of information at a time,
 * and there's no easy way to know that when we're streaming through results
 * that may come in out-of-order.  Plus, there shouldn't actually be all that
 * many objects here.
 */
MprunePolicyTwiceMonthly.prototype._transform = function (obj, _, callback)
{
	var node, when, v;

	node = this.mpm_root;
	when = obj.start;
	if (when === null) {
		setImmediate(callback,
		    new VError('found entry not under a particular ' +
		    'time bucket: %s', obj.path));
		return;
	}

	v = when.getUTCFullYear();
	if (!node.hasOwnProperty(v)) {
		node[v] = {};
	}
	node = node[v];

	v = when.getUTCMonth() + 1;
	if (!node.hasOwnProperty(v)) {
		node[v] = {};
	}
	node = node[v];

	v = when.getUTCDate();
	if (!node.hasOwnProperty(v)) {
		node[v] = [];
	}
	node = node[v];
	node.push(obj);
	setImmediate(callback);
};

/*
 * Now that we've received everything, figure out exactly what we need to keep
 * and discard for each month and emit the corresponding entries.
 */
MprunePolicyTwiceMonthly.prototype._flush = function (callback)
{
	var self = this;
	mod_jsprim.forEachKey(this.mpm_root, function (year, yeartree) {
		mod_jsprim.forEachKey(yeartree, function (month, monthtree) {
			var label = mod_extsprintf.sprintf('%s-%02d',
			    year, month);
			self.processMonth(label, monthtree);
		});
	});

	this.push(null);
	setImmediate(callback);
};

MprunePolicyTwiceMonthly.prototype.processMonth = function (label, monthtree)
{
	var first, second, skip, objects, dirs, dirnames, i;
	var type, reason;
	var self = this;

	for (first = 1; first < 15; first++) {
		if (this.dayIsComplete(monthtree, first)) {
			break;
		}
	}

	if (first == 15) {
		this.vsWarn(new VError('%s: no valid objects found ' +
		    'in days 1-14', label), 'nerr_missing');
		skip = true;
	}

	for (second = 15; second <= 31; second++) {
		if (this.dayIsComplete(monthtree, second)) {
			break;
		}
	}

	if (second == 32) {
		this.vsWarn(new VError('%s: no valid objects found ' +
		    'after day 15', label), 'nerr_missing');
		skip = true;
	}

	/*
	 * TODO if first != 1 || second != 15, then we should confirm with the
	 * user that it's okay we picked a different one.
	 */
	if (!skip && first != 1) {
		this.vsWarn(new VError('%s: missing objects from day 1', label),
		    'nwarn_noday1');
	}
	if (!skip && second != 15) {
		this.vsWarn(new VError('%s: missing objects from day 1', label),
		    'nwarn_noday2');
	}

	mod_assertplus.ok(skip || first != second);
	for (i = 0; i < 32; i++) {
		if (!monthtree.hasOwnProperty(i)) {
			continue;
		}

		objects = monthtree[i];
		mod_assertplus.ok(Array.isArray(objects));
		mod_assertplus.ok(objects.length > 0);
		dirs = {};

		if (skip) {
			type = 'skip';
			reason = 'could not determine which objects ' +
			    'to keep in this month';
		} else if (i == first || i == second) {
			type = 'skip';
			reason = 'designated for keeping';
		} else {
			type = 'remove';
			reason = undefined;
		}

		objects.forEach(function (o) {
			dirs[mod_path.dirname(o.path)] = true;
			self.push({
			    'type': type,
			    'path': o.path,
			    'reason': reason
			});
		});

		/*
		 * We want to clean up directories that we're now emptying.
		 * However, the approach we used to identify the date for each
		 * object does not require that all the objects for a particular
		 * day reside in a single directory, or even necessarily in
		 * different directories from other days.
		 *
		 * To deal with this, we emit an instruction to remove
		 * directories whose objects we just removed.  This is not a
		 * recursive request, so it will fail if the directory is not
		 * empty (e.g., because it contains other days' objects that we
		 * haven't removed).
		 *
		 * We sort the directories by number of components so that if
		 * there was a nested structure here, we'll remove the deepest
		 * ones first.
		 */
		dirnames = Object.keys(dirs);
		dirnames.sort(function (d1, d2) {
			var c = d2.split('/').length - d1.split('/').length;
			return (c < 0 ? -1 : (c > 0 ? 1 : 0));
		});
		dirnames.forEach(function (d) {
			self.push({
			    'type': type == 'skip' ? 'skip' :
			        'removeDirectory',
			    'path': d,
			    'reason': reason
			});
		});
	}
};

MprunePolicyTwiceMonthly.prototype.dayIsComplete = function (tree, which)
{
	var regexps;

	if (!tree.hasOwnProperty(which) || !Array.isArray(tree[which]) ||
	    tree[which].length === 0) {
		return (false);
	}

	if (this.mpm_expect.length === 0) {
		return (true);
	}

	regexps = this.mpm_expect.slice(0);
	tree[which].forEach(function (o) {
		var i;

		mod_assertplus.string(o.basename);
		for (i = 0; i < regexps.length; i++) {
			if (regexps[i].test(o.basename)) {
				regexps.splice(i, 1);
				i--;
			}
		}
	});

	return (regexps.length === 0);
};


/*
 * This is duplicated from Dragnet, but is pretty minimal.  It's not clear where
 * else this should live, since it's specific to both "manta-finder" and
 * "timefilter", and neither one knows about the other.  Most of the logic is
 * inside "timefilter" anyway.
 */
var FINDFILTER_TRUE = function () { return (true); };
function makeFindFilter(filter, start, end)
{
	if (start === null && end === null)
		return (FINDFILTER_TRUE);

	return (function filterPathByTime(path) {
		return (filter.rangeContains(start, end, path));
	});
}
