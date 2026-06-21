'use strict';
const fs = require('fs');

async function run() {
  const response = await fetch('https://api.example.com/data');
  const data = await response.json();

  const outputFile = process.env['GITHUB_OUTPUT'];
  if (outputFile) {
    fs.appendFileSync(outputFile, `body=${data.message}\n`);
  }
}

run().catch(err => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exitCode = 1;
});
