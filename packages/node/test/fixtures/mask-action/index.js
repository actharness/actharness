'use strict';
const fs = require('fs');

process.stdout.write('::add-mask::mysecret\n');

const outputFile = process.env['GITHUB_OUTPUT'];
if (outputFile) {
  fs.appendFileSync(outputFile, 'result=done\n');
}
