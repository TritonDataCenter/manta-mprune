#
# Copyright (c) 2016, Joyent, Inc. All rights reserved.
#
# Makefile: top-level Makefile
#
# This Makefile contains only repo-specific logic and uses included makefiles
# to supply common targets (javascriptlint, jsstyle, restdown, etc.), which are
# used by other repos as well.
#

#
# Tools
#
NPM		 = npm

#
# Files
#
JSON_FILES	 = package.json
JS_FILES	:= bin/mprune tools/mktree $(shell find lib -name '*.js')
JSL_FILES_NODE	 = $(JS_FILES)
JSSTYLE_FILES	 = $(JS_FILES)
JSL_CONF_NODE	 = tools/jsl.node.conf

#
# Manual page definitions and targets.
#
# These were copied from node-manta, and we should move these into common code
# in eng.git.
#
MAN_INROOT	 = docs/man
MAN_OUTROOT	 = man
MAN_SECTION	:= 1
include ./Makefile.manpages.defs

.PHONY: all
all:
	$(NPM) install

.PHONY: manpages
manpages: $(MAN_OUTPUTS)

MAN_SECTION	:= 1
include ./Makefile.manpages.targ

include ./Makefile.targ
