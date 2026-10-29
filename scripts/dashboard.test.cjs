const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { collectState, render, formatAge } = require('./dashboard.cjs');

function makeTempRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-dashboard-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function baseState(overrides = {}) {
  return {
    branch: 'feature/x',
    remote: 'https://example.invalid/owner/repo.git',
    tokenEnv: 'nao',
    ratchet: null,
    snapshot: null,
    snapshotAge: null,
    now: new Date('2026-01-02T03:04:05'),
    ...overrides,
  };
}

test('formatAge reports seconds, minutes and hours relative to now', () => {
  assert.equal(formatAge(null), null);

  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
  assert.equal(formatAge(tenMinutesAgo), '10min atras');

  const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
  assert.equal(formatAge(threeHoursAgo), '3h atras');

  const future = new Date(Date.now() + 60 * 60 * 1000);
  assert.equal(formatAge(future), '0s atras', 'future timestamps are clamped to zero');
});

test('collectState returns nulls and no snapshot for a bare directory', (t) => {
  const root = makeTempRepo(t);
  const state = collectState(root);

  assert.equal(state.ratchet, null, 'no scripts/quality-gate.js means no ratchet');
  assert.equal(state.snapshot, null);
  assert.equal(state.snapshotAge, null);
  assert.ok(state.now instanceof Date);
  assert.ok(['sim', 'nao'].includes(state.tokenEnv));
});

test('collectState reads the remote URL and the saved PR snapshot', (t) => {
  const root = makeTempRepo(t);
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['remote', 'add', 'origin', 'https://example.invalid/owner/repo.git'], { cwd: root });

  const reportsDir = path.join(root, '.quality-gate', 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const snapshot = { pr: { number: 42, title: 'Titulo' }, merge: { status: 'ready', blockers: [] } };
  fs.writeFileSync(path.join(reportsDir, 'pr-snapshot.json'), JSON.stringify(snapshot));

  const state = collectState(root);
  assert.equal(state.remote, 'https://example.invalid/owner/repo.git');
  assert.deepEqual(state.snapshot, snapshot);
  assert.ok(state.snapshotAge instanceof Date);
});

test('collectState captures a ratchet error when scripts/quality-gate.js throws', (t) => {
  const root = makeTempRepo(t);
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(
    path.join(root, 'scripts', 'quality-gate.js'),
    "module.exports = { runQualityGate() { throw new Error('boom from gate'); } };\n",
  );

  const state = collectState(root);
  assert.deepEqual(state.ratchet, { error: 'boom from gate' });
});

test('render shows ratchet rows with pass and fail icons and the metric label', () => {
  const output = render(
    '/repo',
    baseState({
      ratchet: {
        rows: [
          { group: 'cov', metric: 'lines', baseline: 80, current: 85, delta: '+5', passed: true },
          { group: 'cov', metric: 'branches', baseline: 70, current: 60, delta: '-10', passed: false },
        ],
      },
    }),
  );

  assert.match(output, /✅ cov\/lines\s+80 -> 85 \(\+5\)/);
  assert.match(output, /❌ cov\/branches\s+70 -> 60 \(-10\)/);
  assert.doesNotMatch(output, /sem metricas coletadas/);
});

test('render handles empty input: no ratchet rows, no snapshot, unknown branch and remote', () => {
  const output = render(
    '/repo',
    baseState({
      branch: null,
      remote: null,
      ratchet: { rows: [] },
      snapshot: null,
    }),
  );

  assert.match(output, /\(sem metricas coletadas ainda\)/);
  assert.match(output, /nenhum snapshot salvo ainda/);
  assert.match(output, /Branch\s+desconhecida/);
  assert.match(output, /Remoto\s+nao configurado/);
});

test('render reports a missing quality-gate script and a ratchet error', () => {
  const missing = render('/repo', baseState({ ratchet: null }));
  assert.match(missing, /scripts\/quality-gate\.js nao encontrado neste projeto/);

  const failed = render('/repo', baseState({ ratchet: { error: 'kaboom' } }));
  assert.match(failed, /⚠️ {2}kaboom/);
});

test('render shows snapshot status label, PR header and merge blockers', () => {
  const ready = render(
    '/repo',
    baseState({
      snapshot: { pr: { number: 7, title: 'Feature' }, merge: { status: 'ready' } },
      snapshotAge: new Date(Date.now() - 5 * 60 * 1000),
    }),
  );
  assert.match(ready, /#7 Feature/);
  assert.match(ready, /Status\s+ready\s+\(5min atras\)/);

  const blocked = render(
    '/repo',
    baseState({
      snapshot: {
        pr: { number: 8, title: 'Bloqueado' },
        merge: { status: 'blocked', blockers: [{ message: 'CI vermelho' }] },
      },
      snapshotAge: new Date(Date.now() - 30 * 1000),
    }),
  );
  assert.match(blocked, /Status\s+blocked/);
  assert.match(blocked, /⚠️ {2}CI vermelho/);

  const advisory = render(
    '/repo',
    baseState({
      snapshot: { merge: { status: 'ready_with_advisory' } },
      snapshotAge: new Date(Date.now() - 60 * 1000),
    }),
  );
  assert.match(advisory, /Status\s+advisory/);
  assert.match(advisory, /#\? /, 'missing PR number falls back to ?');
});
