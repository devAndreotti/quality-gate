const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { HOOK_MARKER, auditRepo, isZeroBaseline } = require('./lib/fleet-audit.cjs');
const { auditFleet, expandHome, formatTable, loadCatalog, parseArgs, parseCatalog } = require('./fleet.cjs');

// Os repos de teste nascem em os.tmpdir(). Se esse diretorio estiver dentro de outro repo,
// git acharia o pai e o caso "sem git" mudaria. O teto impede que git suba acima do tmp.
process.env.GIT_CEILING_DIRECTORIES = [process.env.GIT_CEILING_DIRECTORIES, os.tmpdir()].filter(Boolean).join(path.delimiter);
const FLEET_CLI = path.join(__dirname, 'fleet.cjs');

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

// Repo gerenciado; cada opção remove ou altera uma peça para testar o diagnóstico.
function makeRepo({
  git = true,
  policy = JSON.stringify({ schemaVersion: 1 }),
  baseline = JSON.stringify({ coverage: { lines: 88 } }),
  hook = true,
  ci = true,
} = {}) {
  const root = tmp('qg-fleet-');
  if (git) childProcess.execFileSync('git', ['init', '-q', root]);
  if (policy !== null) write(root, '.quality-gate/policy.json', policy);
  if (baseline !== null) write(root, 'scripts/baseline.json', baseline);
  if (ci) write(root, '.github/workflows/quality-gate.yml', 'name: Quality Gate\n');
  if (git && hook) {
    write(root, '.git/hooks/pre-push', `#!/bin/sh\n${HOOK_MARKER} version 1\n`);
  }
  return root;
}

test('auditRepo reports a fully managed repo as ok', () => {
  const r = auditRepo(makeRepo());
  assert.equal(r.status, 'ok');
  assert.equal(r.policy, 'ok');
  assert.equal(r.baseline, 'ok');
  assert.equal(r.hooks, 'ok');
  assert.equal(r.ci, 'ok');
  assert.deepEqual(r.issues, []);
});

test('auditRepo reports a missing path', () => {
  const r = auditRepo(path.join(tmp('qg-fleet-none-'), 'nao-existe'));
  assert.equal(r.status, 'caminho ausente');
});

test('auditRepo reports an unmanaged repo when policy.json is absent', () => {
  const r = auditRepo(makeRepo({ policy: null }));
  assert.equal(r.status, 'nao gerenciado');
  assert.match(r.issues[0], /policy\.json/);
});

test('auditRepo flags missing baseline, missing hook and missing CI', () => {
  const r = auditRepo(makeRepo({ baseline: null, hook: false, ci: false }));
  assert.equal(r.status, 'atencao');
  assert.equal(r.baseline, 'ausente');
  assert.equal(r.hooks, 'falta');
  assert.equal(r.ci, 'falta');
  assert.equal(r.issues.length, 3);
});

test('auditRepo flags a zeroed baseline as a release blocker', () => {
  const r = auditRepo(makeRepo({ baseline: JSON.stringify({ coverage: { lines: 0, branches: 0 } }) }));
  assert.equal(r.baseline, 'zerado');
  assert.match(r.issues.join(' '), /cobertura zerada/);
});

test('auditRepo flags an unparseable policy and wrong schemaVersion', () => {
  assert.equal(auditRepo(makeRepo({ policy: '{ nao e json' })).policy, 'invalida');
  const wrong = auditRepo(makeRepo({ policy: JSON.stringify({ schemaVersion: 2 }) }));
  assert.equal(wrong.policy, 'versao invalida');
});

test('auditRepo reports hooks as unverifiable outside a git repository', () => {
  const r = auditRepo(makeRepo({ git: false }));
  assert.equal(r.hooks, 'sem git');
});

test('isZeroBaseline only true when every numeric metric is zero', () => {
  assert.equal(isZeroBaseline({ coverage: { lines: 0, branches: 0 } }), true);
  assert.equal(isZeroBaseline({ coverage: { lines: 0, branches: 5 } }), false);
  assert.equal(isZeroBaseline({}), false);
});

test('parseCatalog accepts strings, objects and the { repos } wrapper', () => {
  const a = parseCatalog(['/tmp/x/alpha']);
  assert.equal(a[0].name, 'alpha');
  const b = parseCatalog({ repos: [{ path: '/tmp/x/beta', name: 'B' }] });
  assert.equal(b[0].name, 'B');
  assert.equal(b[0].path, path.resolve('/tmp/x/beta'));
});

test('parseCatalog rejects malformed catalogs', () => {
  assert.throws(() => parseCatalog({ nope: [] }), /lista ou/);
  assert.throws(() => parseCatalog([{ name: 'sem-path' }]), /sem "path"/);
  assert.throws(() => parseCatalog(['   ']), /sem "path"/);
});

test('expandHome expands ~ and leaves other paths alone', () => {
  assert.equal(expandHome('~'), os.homedir());
  assert.equal(expandHome('~/x'), path.join(os.homedir(), 'x'));
  assert.equal(expandHome('/abs/y'), '/abs/y');
});

test('loadCatalog reports a missing catalog with a clear code', () => {
  try {
    loadCatalog(path.join(tmp('qg-fleet-cat-'), 'fleet.json'));
    assert.fail('expected throw');
  } catch (err) {
    assert.equal(err.code, 'NO_CATALOG');
    assert.match(err.message, /fleet\.example\.json/);
  }
});

test('auditFleet keeps catalog names and uses the injected auditor', () => {
  const rows = auditFleet([{ name: 'one', path: '/x' }], () => ({
    path: '/x',
    status: 'ok',
    policy: 'ok',
    baseline: 'ok',
    hooks: 'ok',
    ci: 'ok',
    issues: [],
  }));
  assert.equal(rows[0].name, 'one');
  assert.equal(rows[0].status, 'ok');
});

test('formatTable lists problems and totals', () => {
  const rows = [
    { name: 'a', status: 'ok', policy: 'ok', baseline: 'ok', hooks: 'ok', ci: 'ok', issues: [] },
    {
      name: 'b',
      status: 'atencao',
      policy: 'ok',
      baseline: 'ausente',
      hooks: 'falta',
      ci: 'ok',
      issues: ['sem scripts/baseline.json'],
    },
  ];
  const text = formatTable(rows);
  assert.match(text, /repo\s+policy\s+baseline/);
  assert.match(text, /b:\n {2}- sem scripts\/baseline\.json/);
  assert.match(text, /2 repos, 1 com atencao\./);
});

test('parseArgs reads --catalog, --json and --strict', () => {
  const a = parseArgs(['--catalog', 'c.json', '--json', '--strict']);
  assert.equal(a.catalog, 'c.json');
  assert.equal(a.json, true);
  assert.equal(a.strict, true);
});

test('CLI is read-only and --strict exits 1 when a repo has problems', () => {
  const healthy = makeRepo();
  const broken = makeRepo({ ci: false });
  const dir = tmp('qg-fleet-cli-');
  const catalog = path.join(dir, 'fleet.json');
  fs.writeFileSync(catalog, JSON.stringify({ repos: [healthy, broken] }));
  const script = path.join(__dirname, 'fleet.cjs');
  const before = fs.readFileSync(path.join(broken, '.quality-gate/policy.json'), 'utf8');

  const normal = childProcess.spawnSync('node', [script, '--catalog', catalog], { encoding: 'utf8' });
  assert.equal(normal.status, 0);
  assert.match(normal.stdout, /1 com atencao/);

  const strict = childProcess.spawnSync('node', [script, '--catalog', catalog, '--strict'], {
    encoding: 'utf8',
  });
  assert.equal(strict.status, 1);

  assert.equal(fs.readFileSync(path.join(broken, '.quality-gate/policy.json'), 'utf8'), before);
});

test('CLI exits 2 when the catalog is missing', () => {
  const script = path.join(__dirname, 'fleet.cjs');
  const r = childProcess.spawnSync(
    'node',
    [script, '--catalog', path.join(tmp('qg-fleet-miss-'), 'x.json')],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 2);
  assert.match(r.stderr, /catalogo nao encontrado/);
});

test('parseArgs accepts the --catalog=<path> form', () => {
  const a = parseArgs(['--catalog=frota/fleet.json', '--json']);
  assert.equal(a.catalog, 'frota/fleet.json');
  assert.equal(a.json, true);
  assert.notEqual(a.catalog, path.join('.quality-gate', 'fleet.json'));
});

test('GIT_CEILING_DIRECTORIES includes os.tmpdir() for the whole test process', () => {
  const ceilings = (process.env.GIT_CEILING_DIRECTORIES || '').split(path.delimiter);
  assert.ok(ceilings.includes(os.tmpdir()));
});

test('git does not climb above the ceiling, so a tmp dir under a repo is not a repo', () => {
  const parent = tmp('qg-fleet-ceil-');
  childProcess.execFileSync('git', ['init', '-q', parent]);
  const ceiling = path.join(parent, 'teto');
  const child = path.join(ceiling, 'filho');
  fs.mkdirSync(child, { recursive: true });
  const probe = (env) => childProcess.spawnSync('git', ['-C', child, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8', env });

  const withCeiling = probe({ ...process.env, GIT_CEILING_DIRECTORIES: ceiling });
  assert.notEqual(withCeiling.status, 0);

  // Controle: sem teto, o repo pai e encontrado; logo o teste acima e significativo.
  const noEnv = { ...process.env };
  delete noEnv.GIT_CEILING_DIRECTORIES;
  const withoutCeiling = probe(noEnv);
  assert.equal(withoutCeiling.stdout.trim(), 'true');
});

test('CLI uses .quality-gate/fleet.json from the cwd when --catalog is omitted', () => {
  const repo = makeRepo();
  const cwd = tmp('qg-fleet-default-');
  write(cwd, '.quality-gate/fleet.json', JSON.stringify({ repos: [{ path: repo, name: 'frota-padrao' }] }));
  const r = childProcess.spawnSync(process.execPath, [FLEET_CLI], { cwd, encoding: 'utf8', env: { ...process.env } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /frota-padrao/);
  assert.match(r.stdout, /1 repos, 0 com atencao\./);
});

test('CLI exits 2 with a catalog message when --catalog is omitted and the default file is absent', () => {
  const cwd = tmp('qg-fleet-default-miss-');
  const r = childProcess.spawnSync(process.execPath, [FLEET_CLI], { cwd, encoding: 'utf8', env: { ...process.env } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /catalogo nao encontrado/);
  assert.ok(r.stderr.includes(path.join('.quality-gate', 'fleet.json')));
});
