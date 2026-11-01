const { test } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { COMMANDS, HELP, main, resolve } = require('./qg.cjs');

const QG = path.join(__dirname, 'qg.cjs');
const ROOT = path.join(__dirname, '..');

test('resolve prints help for no command, help, --help and -h', () => {
  for (const args of [[], ['help'], ['--help'], ['-h']]) assert.equal(resolve(args, ROOT).out, HELP);
});

test('resolve prints the package version from VERSION', () => {
  assert.equal(resolve(['version'], ROOT).out, fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim());
  assert.equal(resolve(['--version'], ROOT).code, 0);
  assert.equal(resolve(['version'], path.join(os.tmpdir(), 'nao-existe-qg')).out, 'desconhecida');
});

test('resolve rejects an unknown command with exit 2 and the help text', () => {
  const r = resolve(['nope'], ROOT);
  assert.equal(r.code, 2);
  assert.match(r.out, /comando desconhecido: nope/);
  assert.match(r.out, /Uso: qg/);
});

test('resolve maps every command to its script and default arguments, passing extras through', () => {
  const r = resolve(['pr', '--json'], ROOT);
  assert.equal(r.run.script, path.join(ROOT, 'scripts', 'local-validate.cjs'));
  assert.deepEqual(r.run.args, ['--profile', 'pr', '--json']);
  assert.deepEqual(resolve(['diff'], ROOT).run.args, ['--base', 'origin/main']);
  assert.deepEqual(resolve(['coverage'], ROOT).run.args, ['check']);
  for (const name of Object.keys(COMMANDS)) {
    assert.ok(fs.existsSync(resolve([name], ROOT).run.script), `script de ${name} existe`);
  }
});

test('main delegates to the script through the injected spawner and returns its exit code', () => {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { status: 3 };
  };
  const r = main(['secrets', '--all'], { root: ROOT, spawn });
  assert.equal(r.code, 3);
  assert.equal(calls[0].cmd, process.execPath);
  assert.deepEqual(calls[0].args, [path.join(ROOT, 'scripts', 'secret-scan.cjs'), '--all']);
  assert.equal(calls[0].opts.stdio, 'inherit');
  assert.equal(main(['secrets'], { root: ROOT, spawn: () => ({ status: null }) }).code, 1);
});

test('e2e: qg help runs the real CLI and prints the commands', () => {
  const r = childProcess.spawnSync(process.execPath, [QG, 'help'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /secrets/);
  assert.match(r.stdout, /fleet/);
});

test('e2e: qg nope exits 2 with a clear message', () => {
  const r = childProcess.spawnSync(process.execPath, [QG, 'nope'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /desconhecido/);
});

test('e2e: qg secrets runs the scanner in a clean repo and exits 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-e2e-'));
  childProcess.execFileSync('git', ['init', '-q', dir]);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'texto normal\n');
  const r = childProcess.spawnSync(process.execPath, [QG, 'secrets', '--all'], {
    cwd: dir,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /PASSED/);
});
