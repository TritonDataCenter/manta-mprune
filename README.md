# mprune: prune Manta objects in date-organized directory trees

This is an unsupported tool for pruning Manta objects in date-organized
directory trees.  Download and build it using:

    $ git clone https://github.com/joyent/manta-mprune
    $ cd manta-mprune
    $ npm install

For usage information, see the included [manual page for
mprune](docs/man/man1/mprune.md).  You can view the manual page locally using
`man -M man mprune`.


# Contributions

Contributions welcome.  Code should be "make prepush" clean.  To run "make
prepush", you'll need these tools:

* https://github.com/davepacheco/jsstyle
* https://github.com/davepacheco/javascriptlint

If you're changing something non-trivial or user-facing, you may want to submit
an issue first.
