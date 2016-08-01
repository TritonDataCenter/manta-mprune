# mprune 1 "2016" Manta "mprune"

## NAME

mprune - prune Manta objects in date-organized directory trees


## SYNOPSIS

`mprune --policy=POLICY [--after DATETIME] [--before DATETIME] [--expect PATTERN ...] [--time-format TIME_FORMAT] [-n | --dry-run] PATH`


## DESCRIPTION

The `mprune` tool implements simple retention policies for data stored in Manta
that is organized in a date-based directory structure.  While this tool only
supports a simple retention policy today, it could form the basis of more
complex retention policies by running the tool multiple times using different
policies over different date ranges.

`mprune` scans the directory tree `PATH` and identifies which objects should be
kept and removed according to a retention policy `POLICY`.  The timestamp
associated with objects is inferred from the directory structure.  By default,
`mprune` assumes directories are organized as `PATH/YYYY/MM/DD`, where `PATH` is
the argument to the tool, `YYYY` is the 4-digit year, `MM` is the 2-digit month
number (1-12), and `DD` is the 2-digit day-of-month number (1-31).  Object
basenames, modification times, and other metadata are not used.  You can
configure the expected directory structure using the `--time-format` option.

There is currently only one supported `POLICY`, which is called `twicemonthly`.
This policy attempts to preserve objects from days 1 and 15, but will be
satisfied with any two days of each month as long as one is from days 1-14 and
the other is from day 15 or later.

With the `--expect` option, one or more regular expressions can be specified
that describe objects that should appear with each day in order for that day to
be considered eligible for keeping.  With some data sets, a given day's worth of
data may be missing for some reason or another.  This option allows users to
ensure that `mprune` doesn't end up retaining a day that's actually missing the
expected objects (for whatever reason) and then removing all nearby days.


## OPTIONS

Unless otherwise specified, when the same option is specified multiple times,
only the last instance of each option is used.

`--after TIMESTAMP, --before TIMESTAMP`
  Only examine directories and objects associated with times after (or before)
  `TIMESTAMP`, which should be an ISO8601 timestamp (or just the date portion of
  such a string).  See above for how objects are associated with particular
  times.  `mprune` prunes by time as it traverses the directory structure, so
  that it will not even descend into `$PATH/2015` if `--after 2016-01-01` was
  specified.

`-n`, `--dry-run`
  Do not actually remove any objects or directories, but print out what would be
  done.

`--expect PATTERN`
  Require that each group of data that `mprune` decides to retain contains an
  object matching JavaScript regular expression `PATTERN`.  For example, if
  objects are stored in directories by day, then each directory must have an
  object matching each of the `PATTERN`s specified with `--expect`.  The idea is
  that if each day is supposed to contain a specific object, and that object is
  missing, then `mprune` will assume that day's data is already missing.  In
  that case, the policy will generally select a different day to preserve.  See
  EXAMPLES below.  This option may be specified multiple times, with the result
  that each of the specified `PATTERN`s must be present in a given day's
  directory for that directory to be eligible to be retained.

`--policy POLICY`
  Specifies a built-in retention policy to use.  The only supported policy is
  `twicemonthly`, which is described above.

`--time-format TIME_FORMAT`
  Configures how directories under `PATH` are organized by timestamp.
  `TIME_FORMAT` is a printf-like format string that supports expansions "%Y",
  "%m", "%d", and "%H", each matching the corresponding expansion in
  strftime(3C).  These specifiers must appear in order from most specific to
  least specific (e.g., year, then month, then day). The default `TIME_FORMAT`
  is equivalent to `"%Y/%m/%d"`.

## EXAMPLES

Manta stores daily backups of its own Manatee databases under
`/poseidon/stor/manatee_backups/$SHARDNAME/YYYY/MM/DD`.  These can be pruned
using this tool.  This example prunes shard "2.moray.emy-10.joyent.us", keeping
only backups from the 1st and 15th of each month, up through June 30, 2016.
Backups after July 1, 2016 are untouched:

    mprune --policy=twicemonthly --before=2016-06-30 /poseidon/stor/manatee_backups/2.moray.emy-10.joyent.us

Now, suppose that the backup from June 1, 2016 was already missing as a result
of a bug, a transient error, or some operator action.  With the above
invocation, the dumps from June 2 through June 14, 2016 would be removed,
leaving the user with no backups from June 1 through June 15.  To avoid this,
you can specify the `--expect` option to describe objects you expect to appear
in each day's directories:

    mprune --policy=twicemonthly --expect='moray.*.gz' --before=2016-06-30 /poseidon/stor/manatee_backups/2.moray.emy-10.joyent.us

In this case, `mprune` will see that the expected objects are missing from June
1 and elect to retain the objects from June 2 instead.  If no objects are found
from June 2 through June 14, or no objects are found from June 15 through the
end of the month, then `mprune` will keep _all_ objects that month.


## ENVIRONMENT

This tool honors the same environment variables used by the official Manta CLI
tools, including `MANTA_USER`, `MANTA_SUBUSER`, `MANTA_KEY_ID`, `MANTA_URL`, and
`MANTA_TLS_INSECURE`.  See the documentation for the Manta CLI tools for
information about how these variables are used.  When using `mprune`, these
environment variables are the only way to configure these settings.

For debugging, this tool honors the convention of using `LOG_LEVEL` to determine
the debug level for the internal bunyan log.  This behavior may change in future
versions.


## EXIT STATUS

`0`
  Success

`1`
  Generic failure.

`2`
  The command-line options were not valid.


## SEE ALSO

mfind(1), mrm(1), strftime(3C)


## COPYRIGHT

Copyright (c) 2016 Joyent Inc.
