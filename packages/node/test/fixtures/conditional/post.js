'use strict';
// This file should never execute — post-if evaluates to false.
process.stderr.write('ERROR: conditional post.js ran unexpectedly\n');
process.exitCode = 1;
