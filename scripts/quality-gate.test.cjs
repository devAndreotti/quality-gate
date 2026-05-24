const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildUpdatedBaseline,
  parseArgs,
  runQualityGate,
} = require('./quality-gate.js');

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qg-ratchet-'));
}

function writeCoverage(project, pct = 82) {
  fs.mkdirSync(path.join(project, 'coverage'), { recursive: true });
  fs.writeFileSync(path.join(project, 'coverage/coverage-summary.json'), JSON.stringify({
    total: {
      lines: { pct },
      statements: { pct },
      functions: { pct },
      branches: { pct },
    },
  }, null, 2));
}

test('parseArgs supports command and dry-run', () => {
  const args = parseArgs(['update', '--dry-run']);
  assert.equal(args.command, 'update');
  assert.equal(args.dryRun, true);
});

test('buildUpdatedBaseline ratchets upward only', () => {
  const updated = buildUpdatedBaseline({
    current: {
      coverage: { lines: 80, statements: 90, functions: 70, branches: 60 },
      lintErrors: 1,
      oversizedFiles: 0,
    },
    existing: {
      coverage: { lines: 85, statements: 80, functions: 70, branches: 65 },
      lintErrors: 0,
      oversizedFiles: 2,
    },
    now: '2026-05-24T00:00:00.000Z',
  });

  assert.deepEqual(updated.coverage, { lines: 85, statements: 90, functions: 70, branches: 65 });
  assert.equal(updated.lintErrors, 1);
  assert.equal(updated.oversizedFiles, 0);
});

test('update --dry-run does not write baseline', () => {
  const project = tempProject();
  fs.mkdirSync(path.join(project, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(project, 'scripts/baseline.json'), JSON.stringify({ coverage: { lines: 1 } }, null, 2));
  writeCoverage(project, 90);

  const result = runQualityGate({ root: project, command: 'update', dryRun: true, now: '2026-05-24T00:00:00.000Z' });

  assert.equal(result.status, 'planned');
  assert.match(fs.readFileSync(path.join(project, 'scripts/baseline.json'), 'utf8'), /"lines": 1/);
});

test('init creates baseline when coverage exists', () => {
  const project = tempProject();
  fs.mkdirSync(path.join(project, 'scripts'), { recursive: true });
  writeCoverage(project, 77);

  const result = runQualityGate({ root: project, command: 'init', now: '2026-05-24T00:00:00.000Z' });
  const baseline = JSON.parse(fs.readFileSync(path.join(project, 'scripts/baseline.json'), 'utf8'));

  assert.equal(result.status, 'updated');
  assert.equal(baseline.coverage.lines, 77);
  assert.equal(baseline.updatedAt, '2026-05-24T00:00:00.000Z');
});
