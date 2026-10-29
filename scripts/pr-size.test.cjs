const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const { evaluatePrSize, formatReport, isExcluded, parseNumstatZ, runPrSize } = require('./pr-size.cjs');

const ENABLED = { enabled: true, maxChangedLines: 800, blockOnFailure: false };
const BLOCKING = { ...ENABLED, blockOnFailure: true };
const numstat = (rows) => rows.map(([added, deleted, file]) => `${added}\t${deleted}\t${file}\0`).join('');

test('disabled config skips without calling git and exits 0', () => {
  let called = false;
  const exec = () => { called = true; return ''; };
  const result = runPrSize({ config: { enabled: false }, base: 'abc', execFileSync: exec });
  assert.equal(result.status, 'skipped');
  assert.equal(result.exitCode, 0);
  assert.equal(called, false);
  assert.match(formatReport(result), /SKIPPED/);
});

test('under limit passes with exit 0', () => {
  const result = runPrSize({ config: ENABLED, base: 'abc', numstatText: numstat([[100, 50, 'scripts/a.cjs']]) });
  assert.equal(result.status, 'passed');
  assert.equal(result.exitCode, 0);
  assert.equal(result.total, 150);
});

test('over limit with advisory mode reports top files and exits 0', () => {
  const rows = [[500, 100, 'scripts/big.cjs'], [200, 0, 'scripts/mid.cjs'], [10, 10, 'src/small.js']];
  const result = runPrSize({ config: ENABLED, base: 'abc', numstatText: numstat(rows) });
  assert.equal(result.status, 'advisory');
  assert.equal(result.exitCode, 0);
  assert.equal(result.total, 820);
  assert.equal(result.top[0].file, 'scripts/big.cjs');
  const report = formatReport(result);
  assert.match(report, /820 linhas alteradas \(limite 800\)/);
  assert.match(report, /scripts\/big\.cjs: 600/);
  assert.match(report, /advisory/);
});

test('over limit with blockOnFailure exits 1', () => {
  const result = runPrSize({ config: BLOCKING, base: 'abc', numstatText: numstat([[900, 0, 'scripts/x.cjs']]) });
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCode, 1);
});

test('excluded files do not count toward the total', () => {
  const rows = [
    [5000, 3000, 'package-lock.json'],
    [400, 0, 'yarn.lock'],
    [900, 0, 'coverage/lcov.info'],
    [900, 0, 'dist/bundle.js'],
    [900, 0, 'build/out.js'],
    [900, 0, 'public/app.min.js'],
    [900, 0, 'docs/guide.md'],
    [900, 0, 'scripts/dashboard-tui.mjs'],
    [900, 0, 'scripts/menu-tui.mjs'],
    [30, 20, 'scripts/real.cjs'],
    [7, 3, 'docs/notes.txt'],
  ];
  const result = runPrSize({ config: ENABLED, base: 'abc', numstatText: numstat(rows) });
  assert.equal(result.total, 60);
  assert.equal(result.exitCode, 0);
  assert.equal(result.excludedCount, 9);
  assert.deepEqual(result.top.map((entry) => entry.file), ['scripts/real.cjs', 'docs/notes.txt']);
});

test('isExcluded matches the documented patterns only', () => {
  assert.equal(isExcluded('sub/package-lock.json'), true);
  assert.equal(isExcluded('docs/a/b.md'), true);
  assert.equal(isExcluded('docs/a.txt'), false);
  assert.equal(isExcluded('README.md'), false);
  assert.equal(isExcluded('scripts/quality-gate.js'), false);
  assert.equal(isExcluded('mydist/x.js'), false);
});

test('parseNumstatZ treats binary entries as zero and keeps tabs in paths', () => {
  const entries = parseNumstatZ('-\t-\tassets/logo.png\u00002\t1\todd\tname.js\u0000');
  assert.deepEqual(entries, [
    { file: 'assets/logo.png', added: 0, deleted: 0 },
    { file: 'odd\tname.js', added: 2, deleted: 1 },
  ]);
});

test('evaluatePrSize sorts top files by size and caps at five', () => {
  const entries = [1, 2, 3, 4, 5, 6].map((n) => ({ file: `scripts/f${n}.cjs`, added: n * 10, deleted: 0 }));
  const evaluation = evaluatePrSize({ entries, config: ENABLED });
  assert.equal(evaluation.top.length, 5);
  assert.equal(evaluation.top[0].file, 'scripts/f6.cjs');
});

test('missing base fails closed with exit 2 and never calls git', () => {
  let called = false;
  const exec = () => { called = true; return ''; };
  const result = runPrSize({ config: ENABLED, base: undefined, execFileSync: exec });
  assert.equal(result.status, 'error');
  assert.equal(result.exitCode, 2);
  assert.equal(called, false);
});

test('git failure against the base also fails closed with exit 2', () => {
  const exec = () => { throw new Error('fatal: bad revision'); };
  const result = runPrSize({ config: ENABLED, base: 'deadbeef', execFileSync: exec });
  assert.equal(result.exitCode, 2);
  assert.match(result.reason, /fetch-depth: 0/);
});

test('CLI in this repo prints SKIPPED while ci.prSize is disabled', () => {
  const script = path.join(__dirname, 'pr-size.cjs');
  const out = childProcess.execFileSync(process.execPath, [script], { encoding: 'utf8', env: { ...process.env, BASE_SHA: '' } });
  assert.match(out, /PR size: SKIPPED/);
});
