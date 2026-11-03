const { test } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
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

test('readCoverage accepts the metrics.coverage shape and rejects non-numeric lines', () => {
  assert.equal(readCoverage(repoWith({ metrics: { coverage: { lines: 75 } } })), 75);
  assert.equal(readCoverage(repoWith({ coverage: { lines: '90' } })), null);
  assert.equal(readCoverage(repoWith({ coverage: {} })), null);
  assert.equal(readCoverage(repoWith({})), null);
});

test('main records the HEAD commit of a git repository', () => {
  const root = repoWith({ coverage: { lines: 90 } });
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'qg',
    GIT_AUTHOR_EMAIL: 'qg@example.invalid',
    GIT_COMMITTER_NAME: 'qg',
    GIT_COMMITTER_EMAIL: 'qg@example.invalid',
  };
  childProcess.execFileSync('git', ['init', '-q'], { cwd: root });
  childProcess.execFileSync(
    'git',
    ['-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'base'],
    { cwd: root, env },
  );
  const head = childProcess
    .execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
    .trim();
  const out = path.join(root, 'h.jsonl');
  main(['--out', out], { root, now: new Date('2026-11-01T00:00:00Z') });
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8').trim()).commit, head.slice(0, 12));
});

test('main --summary lists one line per day, oldest first', () => {
  const root = repoWith({ coverage: { lines: 90 } });
  const out = path.join(root, 'h.jsonl');
  main(['--out', out], { root, commit: 'b', now: new Date('2026-11-02T00:00:00Z') });
  main(['--out', out], { root, commit: 'a', now: new Date('2026-11-01T00:00:00Z') });
  assert.equal(
    main(['--summary', '--out', out], { root }).out,
    '2026-11-01  cobertura 90%\n2026-11-02  cobertura 90%',
  );
});

test('--svg charts every coverage point under the chart title', () => {
  const root = repoWith({ coverage: { lines: 90 } });
  const out = path.join(root, 'h.jsonl');
  const svgFile = path.join(root, 'cov.svg');
  main(['--out', out], { root, commit: 'a', now: new Date('2026-11-01T00:00:00Z') });
  main(['--out', out], { root, commit: 'b', now: new Date('2026-11-02T00:00:00Z') });
  main(['--svg', svgFile, '--out', out], { root });
  const svg = fs.readFileSync(svgFile, 'utf8');
  assert.match(svg, /<title>Cobertura de linhas<\/title>/);
  assert.equal((svg.match(/<circle /g) || []).length, 2);
});

test('running the script from the command line writes the snapshot and prints the result', () => {
  const root = repoWith({ coverage: { lines: 88 } });
  const out = path.join(root, 'h.jsonl');
  const script = path.join(__dirname, 'metrics-snapshot.cjs');
  const r = childProcess.spawnSync(process.execPath, [script, '--out', out], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /snapshot gravado/);
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8').trim()).coverage, 88);
});

test('requiring the module has no side effects', () => {
  const root = repoWith({ coverage: { lines: 90 } });
  const script = path.join(__dirname, 'metrics-snapshot.cjs');
  const r = childProcess.spawnSync(process.execPath, ['-e', `require(${JSON.stringify(script)})`], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(fs.existsSync(path.join(root, '.quality-gate')), false);
});
