// E2E: roda o CLI de verdade (processo filho) com um `gh` falso no PATH.
// O `gh` falso responde como a API responderia; o resto do caminho (exec, histórico, HTML, exit codes) é real.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, 'fleet-github.cjs');

const FAKE_GH = `#!/usr/bin/env node
const args = process.argv.slice(2).join(' ');
const out = (s) => process.stdout.write(s);
const fail = () => { process.stderr.write('HTTP 404\\n'); process.exit(1); };
const runs = JSON.stringify([
  { workflowName: 'CI', conclusion: 'failure', status: 'completed', createdAt: '2026-11-01T10:00:00Z', headSha: 'abc1234def' },
  { workflowName: 'Dependabot Updates', conclusion: 'success', status: 'completed', createdAt: '2026-11-01T09:00:00Z', headSha: 'fff' },
]);
const okRuns = JSON.stringify([{ workflowName: 'CI', conclusion: 'success', status: 'completed', createdAt: '2026-11-01T10:00:00Z', headSha: 'ccc1234' }]);
const base64 = Buffer.from(JSON.stringify({ coverage: { lines: 91.3, branches: 80.9, functions: 92.3 } })).toString('base64');
if (args.includes('repos/o/bad ')) fail();
if (args.startsWith('api repos/o/ok --jq')) return out('main');
if (args.startsWith('api repos/o/nogate --jq')) return out('main');
if (args.includes('repos/o/ok/contents/.quality-gate/policy.json')) return out('policy.json');
if (args.includes('repos/o/nogate/contents/.quality-gate/policy.json')) return fail();
if (args.startsWith('api repos/o/ok2 --jq')) return out('main');
if (args.includes('repos/o/ok2/contents/.quality-gate/policy.json')) return out('policy.json');
if (args.includes('repos/o/ok2/contents/scripts/baseline.json')) return out(base64);
if (args.includes('run list')) {
  if (args.includes('--repo o/ok2 ')) return out(okRuns);
  if (args.includes('--repo o/nogate ')) return out('[]');
  return out(runs);
}
if (args.includes('/code-scanning/alerts')) return out('2');
if (args.includes('/dependabot/alerts')) return out('0');
if (args.startsWith('api repos/o/ok2/')) return out('0');
fail();
`;

function setup(catalog) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-e2e-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), FAKE_GH);
  fs.chmodSync(path.join(bin, 'gh'), 0o755);
  const catalogFile = path.join(dir, 'fleet-github.json');
  fs.writeFileSync(catalogFile, JSON.stringify(catalog));
  return {
    dir,
    bin,
    catalogFile,
    history: path.join(dir, 'h.jsonl'),
    dashboard: path.join(dir, 'painel.html'),
  };
}

function run(env, args) {
  return childProcess.spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${env.bin}${path.delimiter}${process.env.PATH}` },
  });
}

const CATALOG = {
  owner: 'o',
  repos: ['ok', 'bad', 'nogate', { name: 'ok2', coverage: 'scripts/baseline.json' }],
};

test('e2e: collects every repo through the real CLI, prints a summary and writes history and dashboard', () => {
  const env = setup(CATALOG);
  const r = run(env, ['--catalog', env.catalogFile, '--history', env.history, '--dashboard', env.dashboard]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /falha +ok/);
  assert.match(r.stdout, /erro +bad/);
  assert.match(r.stdout, /ok +ok2\n/);
  assert.match(r.stdout, /sem runs +nogate +\(sem gate\)/);
  assert.match(r.stdout, /4 repos, 1 em falha/);
  const lines = fs.readFileSync(env.history, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 4);
  const ok2 = lines.find((x) => x.repo === 'ok2');
  assert.equal(ok2.coverage.lines, 91.3);
  assert.equal(ok2.codeScanningOpen, 2);
  assert.equal(lines.find((x) => x.repo === 'ok').gate, true);
  assert.equal(lines.find((x) => x.repo === 'bad').error !== undefined, true);
  assert.match(fs.readFileSync(env.dashboard, 'utf8'), /Quality Gate · frota/);
});

test('e2e: --json prints machine-readable status per repo', () => {
  const env = setup(CATALOG);
  const r = run(env, ['--catalog', env.catalogFile, '--history', env.history, '--json']);
  assert.equal(r.status, 0, r.stderr);
  const data = JSON.parse(r.stdout);
  assert.deepEqual(
    data.map((x) => x.status),
    ['falha', 'erro', 'sem runs', 'ok'],
  );
});

test('e2e: --strict exits 1 when any repo is failing, 0 when none is', () => {
  const env = setup(CATALOG);
  assert.equal(run(env, ['--catalog', env.catalogFile, '--history', env.history, '--strict']).status, 1);
  const healthy = setup({ owner: 'o', repos: ['nogate'] });
  assert.equal(
    run(healthy, ['--catalog', healthy.catalogFile, '--history', healthy.history, '--strict']).status,
    0,
  );
});

test('e2e: a missing catalog exits 2 with the example hint', () => {
  const env = setup(CATALOG);
  const r = run(env, ['--catalog', path.join(env.dir, 'nao-existe.json'), '--history', env.history]);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /fleet-github\.example\.json/);
});
