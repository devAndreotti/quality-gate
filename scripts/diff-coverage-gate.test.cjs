const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { evaluateDiffCoverage, isGatedSource } = require('./lib/diff-coverage.cjs');
const { formatReport, parseArgs, runDiffCoverageGate } = require('./diff-coverage-gate.cjs');

const ENABLED = { enabled: true, minPercentage: 90, blockOnFailure: true };

function diffFor(file, addedLines, startLine = 1) {
  const body = addedLines.map((l) => `+${l}`).join('\n');
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${startLine - 1},0 +${startLine},${addedLines.length} @@`,
    body,
  ].join('\n');
}

function lcovFor(file, hits) {
  const da = Object.entries(hits)
    .map(([line, h]) => `DA:${line},${h}`)
    .join('\n');
  return `SF:${file}\n${da}\nend_of_record\n`;
}

test('isGatedSource accepts production JS and excludes tests and build output', () => {
  assert.equal(isGatedSource('scripts/foo.cjs'), true);
  assert.equal(isGatedSource('src/app.tsx'), true);
  assert.equal(isGatedSource('scripts/foo.test.cjs'), false);
  assert.equal(isGatedSource('dist/bundle.js'), false);
  assert.equal(isGatedSource('README.md'), false);
});

test('evaluateDiffCoverage passes when every new executable line is covered', () => {
  const diff = diffFor('scripts/a.cjs', ['const x = 1;', 'const y = 2;']);
  const lcov = lcovFor('scripts/a.cjs', { 1: 3, 2: 1 });
  const r = evaluateDiffCoverage({ diffText: diff, lcovText: lcov, minDiffCoverage: 90 });
  assert.equal(r.passed, true);
  assert.equal(r.pct, 100);
  assert.deepEqual(r.untestedFiles, []);
});

test('evaluateDiffCoverage fails when a new executable line has zero hits', () => {
  const diff = diffFor('scripts/a.cjs', ['const x = 1;', 'const y = 2;']);
  const lcov = lcovFor('scripts/a.cjs', { 1: 3, 2: 0 });
  const r = evaluateDiffCoverage({ diffText: diff, lcovText: lcov, minDiffCoverage: 90 });
  assert.equal(r.passed, false);
  assert.equal(r.pct, 50);
  assert.deepEqual(r.uncovered, [{ file: 'scripts/a.cjs', line: 2, status: 'uncovered' }]);
});

test('evaluateDiffCoverage counts a changed production file with no LCOV record as untested', () => {
  const diff = diffFor('scripts/new-feature.cjs', ['function f() {', '  return 1;', '}']);
  const r = evaluateDiffCoverage({
    diffText: diff,
    lcovText: lcovFor('scripts/other.cjs', { 1: 1 }),
    minDiffCoverage: 90,
  });
  assert.equal(r.passed, false);
  assert.deepEqual(r.untestedFiles, ['scripts/new-feature.cjs']);
  assert.equal(r.totalLines, 3);
  assert.equal(r.coveredLines, 0);
});

test('evaluateDiffCoverage ignores blank lines in untested files', () => {
  const diff = diffFor('scripts/blank.cjs', ['', '   ', '']);
  const r = evaluateDiffCoverage({ diffText: diff, lcovText: '', minDiffCoverage: 90 });
  assert.equal(r.passed, true);
  assert.deepEqual(r.untestedFiles, []);
});

test('evaluateDiffCoverage ignores test files in the diff', () => {
  const diff = diffFor('scripts/foo.test.cjs', ['test("x", () => {});']);
  const r = evaluateDiffCoverage({ diffText: diff, lcovText: '', minDiffCoverage: 90 });
  assert.equal(r.totalLines, 0);
  assert.equal(r.passed, true);
});

test('evaluateDiffCoverage does not match a file by partial name suffix', () => {
  // "a.cjs" no diff não pode casar com "scripts/data.cjs" no LCOV.
  const diff = diffFor('a.cjs', ['const x = 1;']);
  const r = evaluateDiffCoverage({
    diffText: diff,
    lcovText: lcovFor('scripts/data.cjs', { 1: 1 }),
    minDiffCoverage: 90,
  });
  assert.deepEqual(r.untestedFiles, ['a.cjs']);
});

test('runDiffCoverageGate is skipped when ci.diffCoverage is disabled', () => {
  const r = runDiffCoverageGate({ config: { enabled: false }, diffText: '', lcovText: '' });
  assert.equal(r.status, 'skipped');
});

test('runDiffCoverageGate reports failed when blocking and advisory when not blocking', () => {
  const diff = diffFor('scripts/a.cjs', ['const x = 1;']);
  const lcov = lcovFor('scripts/a.cjs', { 1: 0 });
  const blocking = runDiffCoverageGate({ config: ENABLED, diffText: diff, lcovText: lcov });
  assert.equal(blocking.status, 'failed');
  const advisory = runDiffCoverageGate({
    config: { ...ENABLED, blockOnFailure: false },
    diffText: diff,
    lcovText: lcov,
  });
  assert.equal(advisory.status, 'advisory');
  assert.equal(advisory.blocking, false);
});

test('runDiffCoverageGate fails closed when the LCOV file is missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-dcg-'));
  const r = runDiffCoverageGate({
    root: dir,
    config: ENABLED,
    diffText: diffFor('scripts/a.cjs', ['const x = 1;']),
  });
  assert.equal(r.status, 'error');
  assert.match(r.reason, /LCOV nao encontrado/);
});

test('runDiffCoverageGate fails closed when git diff cannot run', () => {
  const r = runDiffCoverageGate({
    config: ENABLED,
    base: 'origin/nao-existe',
    lcovText: '',
    execFileSync: () => {
      throw new Error('fatal: bad revision');
    },
  });
  assert.equal(r.status, 'error');
  assert.match(r.reason, /git diff falhou/);
});

test('runDiffCoverageGate reads the policy from ci.diffCoverage', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-dcg-policy-'));
  fs.mkdirSync(path.join(dir, '.quality-gate'));
  fs.writeFileSync(
    path.join(dir, '.quality-gate', 'policy.json'),
    JSON.stringify({ ci: { diffCoverage: { enabled: true, minPercentage: 50, blockOnFailure: false } } }),
  );
  const r = runDiffCoverageGate({
    root: dir,
    diffText: diffFor('scripts/a.cjs', ['const x = 1;', 'const y = 2;']),
    lcovText: lcovFor('scripts/a.cjs', { 1: 1, 2: 0 }),
  });
  assert.equal(r.minDiffCoverage, 50);
  assert.equal(r.status, 'passed');
});

test('formatReport lists untested files and uncovered lines', () => {
  const r = evaluateDiffCoverage({
    diffText: diffFor('scripts/new.cjs', ['const x = 1;']),
    lcovText: '',
    minDiffCoverage: 90,
  });
  const text = formatReport({ status: 'failed', ...r });
  assert.match(text, /FAILED/);
  assert.match(text, /scripts\/new\.cjs/);
});

test('parseArgs reads --base, --lcov and --json', () => {
  const a = parseArgs(['--base', 'abc123', '--lcov=out/lcov.info', '--json']);
  assert.equal(a.base, 'abc123');
  assert.equal(a.lcov, 'out/lcov.info');
  assert.equal(a.json, true);
});

test('runDiffCoverageGate reads the diff from git when no diffText is given', () => {
  const diff = diffFor('scripts/a.cjs', ['const x = 1;']);
  const r = runDiffCoverageGate({
    config: ENABLED,
    base: 'origin/main',
    lcovText: lcovFor('scripts/a.cjs', { 1: 1 }),
    execFileSync: (cmd, args) => {
      assert.equal(cmd, 'git');
      assert.deepEqual(args, ['diff', '--unified=0', 'origin/main...HEAD']);
      return diff;
    },
  });
  assert.equal(r.status, 'passed');
});

test('formatReport truncates long uncovered lists and marks advisory mode', () => {
  const addedLines = Array.from({ length: 60 }, (_, i) => `const v${i} = ${i};`);
  const r = evaluateDiffCoverage({
    diffText: diffFor('scripts/big.cjs', addedLines),
    lcovText: lcovFor('scripts/big.cjs', Object.fromEntries(addedLines.map((_, i) => [i + 1, 0]))),
    minDiffCoverage: 90,
  });
  const text = formatReport({ status: 'advisory', ...r });
  assert.match(text, /\.\.\. e mais 10/);
  assert.match(text, /advisory/);
});

test('evaluateDiffCoverage only gates files under include prefixes when set', () => {
  const diff = [diffFor('scripts/tool.cjs', ['const a = 1;']), diffFor('src/app.js', ['const b = 2;'])].join(
    '\n',
  );
  const r = evaluateDiffCoverage({
    diffText: diff,
    lcovText: lcovFor('src/app.js', { 1: 1 }),
    minDiffCoverage: 90,
    include: ['src/'],
  });
  assert.equal(r.passed, true);
  assert.deepEqual(r.untestedFiles, []);
});
