const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main, readCoverage } = require('./metrics-snapshot.cjs');

function repoWith(baseline) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-snap-'));
  if (baseline !== undefined) {
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.writeFileSync(path.join(dir, 'scripts', 'baseline.json'), JSON.stringify(baseline));
  }
  return dir;
}

test('readCoverage reads the baseline and tolerates a missing file', () => {
  assert.equal(readCoverage(repoWith({ coverage: { lines: 91.3 } })), 91.3);
  assert.equal(readCoverage(repoWith()), null);
});

test('main writes a snapshot and reports a second run for the same day and commit as already present', () => {
  const root = repoWith({ coverage: { lines: 90 } });
  const out = path.join(root, 'h.jsonl');
  const deps = { root, commit: 'abc123', now: new Date('2026-11-01T12:00:00Z') };
  assert.match(main(['--out', out], deps).out, /snapshot gravado/);
  assert.match(main(['--out', out], deps).out, /já existe/);
  const line = JSON.parse(fs.readFileSync(out, 'utf8').trim());
  assert.equal(line.coverage, 90);
  assert.equal(line.commit, 'abc123');
});

test('main --summary prints the coverage series, or a message when empty', () => {
  const root = repoWith({ coverage: { lines: 90 } });
  const out = path.join(root, 'h.jsonl');
  assert.equal(main(['--summary', '--out', out], { root }).out, 'sem snapshots');
  main(['--out', out], { root, commit: 'a', now: new Date('2026-11-01T00:00:00Z') });
  assert.equal(main(['--summary', '--out', out], { root }).out, '2026-11-01  cobertura 90%');
});

test('main uses the default output path under .quality-gate when --out is absent', () => {
  const root = repoWith({ coverage: { lines: 70 } });
  const r = main([], { root, commit: 'x', now: new Date('2026-11-01T00:00:00Z') });
  assert.ok(fs.existsSync(path.join(root, '.quality-gate', 'metrics.jsonl')));
  assert.match(r.out, /snapshot gravado/);
});

test('without a git repo the commit is recorded as desconhecido', () => {
  const root = repoWith({ coverage: { lines: 70 } });
  const out = path.join(root, 'h.jsonl');
  main(['--out', out], { root, now: new Date('2026-11-01T00:00:00Z') });
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8').trim()).commit, 'desconhecido');
});

test('--svg writes a chart of the coverage series', () => {
  const root = repoWith({ coverage: { lines: 90 } });
  const out = path.join(root, 'h.jsonl');
  const svgFile = path.join(root, 'cov.svg');
  main(['--out', out], { root, commit: 'a', now: new Date('2026-11-01T00:00:00Z') });
  assert.match(main(['--svg', svgFile, '--out', out], { root }).out, /gráfico gravado/);
  assert.match(fs.readFileSync(svgFile, 'utf8'), /^<svg /);
});
