const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { appendSnapshot, makeSnapshot, readSnapshots, series } = require('./lib/metrics-history.cjs');

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qg-hist-')), 'metrics.jsonl');
}

test('makeSnapshot truncates date and commit and nulls non-numeric metrics', () => {
  const s = makeSnapshot({
    date: '2026-11-01T10:00:00Z',
    commit: 'abcdef1234567890',
    coverage: 91.3,
    codeScanningOpen: '5',
  });
  assert.deepEqual(s, {
    date: '2026-11-01',
    commit: 'abcdef123456',
    coverage: 91.3,
    codeScanningOpen: null,
    dependabotOpen: null,
  });
});

test('appendSnapshot writes once per day and commit', () => {
  const file = tmpFile();
  const snap = makeSnapshot({ date: '2026-11-01', commit: 'a1', coverage: 90 });
  assert.equal(appendSnapshot(file, snap).added, true);
  assert.equal(appendSnapshot(file, snap).added, false);
  assert.equal(
    appendSnapshot(file, makeSnapshot({ date: '2026-11-01', commit: 'b2', coverage: 91 })).added,
    true,
  );
  assert.equal(readSnapshots(file).length, 2);
});

test('readSnapshots skips corrupt lines, non-objects and missing dates', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{"date":"2026-11-01","commit":"a"}\nnot json\n42\n{"nodate":1}\n\n');
  const rows = readSnapshots(file);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].commit, 'a');
});

test('readSnapshots returns empty for a missing file', () => {
  assert.deepEqual(readSnapshots(path.join(os.tmpdir(), 'nao-existe-qg.jsonl')), []);
});

test('series sorts by date and drops missing values', () => {
  const rows = [
    makeSnapshot({ date: '2026-11-03', commit: 'c', coverage: 92 }),
    makeSnapshot({ date: '2026-11-01', commit: 'a', coverage: 90 }),
    makeSnapshot({ date: '2026-11-02', commit: 'b' }),
  ];
  assert.deepEqual(series(rows, 'coverage'), [
    { date: '2026-11-01', value: 90 },
    { date: '2026-11-03', value: 92 },
  ]);
});
