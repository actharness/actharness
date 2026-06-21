'use strict';
// This file should never execute — pre-if evaluates to false.
process.stderr.write('ERROR: conditional pre.js ran unexpectedly\n');
process.exitCode = 1;
