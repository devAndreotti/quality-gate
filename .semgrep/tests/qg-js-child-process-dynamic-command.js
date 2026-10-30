const cp = require('child_process');
const { exec } = require('child_process');

function run(name) {
  const dir = process.env.QG_DIR;
  // ruleid: qg-js-child-process-dynamic-command
  cp.exec(`git log ${name}`, () => {});
  // ruleid: qg-js-child-process-dynamic-command
  cp.execSync('git show ' + name);
  // ruleid: qg-js-child-process-dynamic-command
  exec(`ls ${dir}`);
  // ok: qg-js-child-process-dynamic-command
  cp.exec('git status --porcelain', () => {});
  // ok: qg-js-child-process-dynamic-command
  cp.execFileSync('git', ['show', name]);
}
module.exports = { run };
