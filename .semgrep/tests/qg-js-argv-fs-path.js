const fs = require('fs');
const path = require('path');

const target = process.argv[2];
// ruleid: qg-js-argv-fs-path
fs.readFileSync(process.argv[2], 'utf8');
// ruleid: qg-js-argv-fs-path
fs.writeFileSync(target, 'x');
// ok: qg-js-argv-fs-path
fs.readFileSync(path.join(__dirname, 'fixed.txt'), 'utf8');
