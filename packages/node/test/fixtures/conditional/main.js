'use strict';
const fs = require('fs');

const outputFile = process.env['GITHUB_OUTPUT'];
if (outputFile) {
  fs.appendFileSync(outputFile, 'ran=true\n');
}
