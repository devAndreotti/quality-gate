const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  collectRepo,
  countAlerts,
  defaultHistoryPath,
  loadCatalog,
  main,
  parseArgs,
  parseCatalog,
  readCoverage,
  readHistory,
  renderHtml,
  statusOf,
  appendHistory,
} = require('./fleet-github.cjs');

const NOW = new Date('2026-11-01T12:00:00Z');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-gh-'));

// exec falso: respostas por trecho do comando; ausente = erro (como o gh com 404).
function fakeExec(answers) {
  return (file, args) => {
    const key = args.join(' ');
    for (const [needle, value] of answers) {
      if (key.includes(needle)) {
        if (value instanceof Error) throw value;
        return value;
      }
    }
    throw new Error('sem resposta: ' + key);
  };
}

const okRuns = JSON.stringify([
  {
    workflowName: 'CI',
    conclusion: 'success',
    status: 'completed',
    createdAt: '2026-11-01T10:00:00Z',
    headSha: 'abcdef123456',
  },
  {
    workflowName: 'Dependabot Updates',
    conclusion: 'failure',
    status: 'completed',
    createdAt: '2026-11-01T09:00:00Z',
    headSha: '111111',
  },
]);

test('parseCatalog accepts names as strings or objects and applies the default ignore list', () => {
  const c = parseCatalog({ owner: 'alguem', repos: ['a', { name: 'b', coverage: 'scripts/baseline.json' }] });
  assert.equal(c.owner, 'alguem');
  assert.deepEqual(c.repos, [
    { name: 'a', coverage: null },
    { name: 'b', coverage: 'scripts/baseline.json' },
  ]);
  assert.deepEqual(c.ignore, ['Dependabot Updates']);
  assert.deepEqual(parseCatalog({ owner: 'x', repos: [], ignoreWorkflows: ['Y'] }).ignore, ['Y']);
});

test('parseCatalog rejects a missing owner, a missing repos list and an unnamed repo', () => {
  assert.throws(() => parseCatalog({ repos: [] }), /sem "owner"/);
  assert.throws(() => parseCatalog({ owner: 'x' }), /sem lista "repos"/);
  assert.throws(() => parseCatalog({ owner: 'x', repos: [{ coverage: 'a' }] }), /sem "name"/);
  assert.throws(() => parseCatalog({ owner: 'x', repos: ['   '] }), /sem "name"/);
});

test('loadCatalog reports a missing file with a clear code', () => {
  try {
    loadCatalog(path.join(tmp(), 'nao-existe.json'));
    assert.fail('esperava erro');
  } catch (err) {
    assert.equal(err.code, 'NO_CATALOG');
    assert.match(err.message, /fleet-github\.example\.json/);
  }
});

test('statusOf covers error, no runs, failure, ok (with skipped) and partial', () => {
  assert.equal(statusOf({ error: 'x' }), 'erro');
  assert.equal(statusOf({ workflows: [] }), 'sem runs');
  assert.equal(statusOf({ workflows: [{ conclusion: 'failure' }] }), 'falha');
  assert.equal(statusOf({ workflows: [{ conclusion: 'success' }, { conclusion: 'skipped' }] }), 'ok');
  assert.equal(statusOf({ workflows: [{ conclusion: 'cancelled' }] }), 'parcial');
});

test('collectRepo reports an inaccessible repo as error', () => {
  const r = collectRepo('o', { name: 'x' }, [], fakeExec([]), NOW);
  assert.equal(r.error, 'inacessível ou sem permissão');
  assert.equal(statusOf(r), 'erro');
});

test('collectRepo gathers branch, gate, latest workflow per name and drops ignored workflows', () => {
  const exec = fakeExec([
    ['repos/o/x --jq .default_branch', 'main'],
    ['contents/.quality-gate/policy.json', 'policy.json'],
    ['run list', okRuns],
    ['code-scanning', '3\n2'],
    ['dependabot', '1'],
  ]);
  const r = collectRepo('o', { name: 'x' }, ['Dependabot Updates'], exec, NOW);
  assert.equal(r.branch, 'main');
  assert.equal(r.gate, true);
  assert.deepEqual(r.workflows, [
    { name: 'CI', conclusion: 'success', at: '2026-11-01T10:00:00Z', sha: 'abcdef1' },
  ]);
  assert.equal(r.codeScanningOpen, 5);
  assert.equal(r.dependabotOpen, 1);
  assert.equal(r.coverage, null);
});

test('collectRepo marks gate false when policy.json is absent and tolerates bad run JSON', () => {
  const exec = fakeExec([
    ['repos/o/x --jq .default_branch', 'main'],
    ['contents/.quality-gate/policy.json', new Error('404')],
    ['run list', 'nao-json'],
    ['code-scanning', new Error('sem permissão')],
    ['dependabot', new Error('sem permissão')],
  ]);
  const r = collectRepo('o', { name: 'x' }, [], exec, NOW);
  assert.equal(r.gate, false);
  assert.deepEqual(r.workflows, []);
  assert.equal(r.codeScanningOpen, null);
  assert.equal(r.dependabotOpen, null);
});

test('collectRepo keeps only the most recent completed run per workflow', () => {
  const runs = JSON.stringify([
    {
      workflowName: 'CI',
      conclusion: null,
      status: 'in_progress',
      createdAt: '2026-11-01T11:00:00Z',
      headSha: 'aaaaaaa',
    },
    {
      workflowName: 'CI',
      conclusion: 'failure',
      status: 'completed',
      createdAt: '2026-11-01T10:00:00Z',
      headSha: 'bbbbbbb',
    },
    {
      workflowName: 'CI',
      conclusion: 'success',
      status: 'completed',
      createdAt: '2026-10-31T10:00:00Z',
      headSha: 'ccccccc',
    },
  ]);
  const exec = fakeExec([
    ['repos/o/x --jq .default_branch', 'main'],
    ['policy.json', ''],
    ['run list', runs],
    ['alerts', '0'],
    ['code-scanning', '0'],
    ['dependabot', '0'],
  ]);
  const r = collectRepo('o', { name: 'x' }, [], exec, NOW);
  assert.deepEqual(
    r.workflows.map((w) => [w.conclusion, w.sha]),
    [['failure', 'bbbbbbb']],
  );
});

test('readCoverage reads lines and branches from a base64 baseline and returns null otherwise', () => {
  const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64');
  const good = fakeExec([
    ['contents/scripts/baseline.json', enc({ coverage: { lines: 91.3, branches: 80.9 } })],
  ]);
  assert.deepEqual(readCoverage('o/x', 'main', 'scripts/baseline.json', good), {
    lines: 91.3,
    branches: 80.9,
    functions: null,
  });
  const nested = fakeExec([['contents/b.json', enc({ metrics: { coverage: { lines: 70 } } })]]);
  assert.equal(readCoverage('o/x', 'main', 'b.json', nested).lines, 70);
  assert.equal(readCoverage('o/x', 'main', null, good), null);
  assert.equal(readCoverage('o/x', 'main', 'missing', fakeExec([])), null);
  const broken = fakeExec([['contents/b.json', Buffer.from('nao json').toString('base64')]]);
  assert.equal(readCoverage('o/x', 'main', 'b.json', broken), null);
  const noLines = fakeExec([['contents/b.json', enc({ coverage: { branches: 1 } })]]);
  assert.equal(readCoverage('o/x', 'main', 'b.json', noLines), null);
});

test('countAlerts sums paginated lengths and returns null when the API refuses', () => {
  assert.equal(countAlerts('o/x', 'dependabot/alerts', fakeExec([['dependabot', '2\n3']])), 5);
  assert.equal(countAlerts('o/x', 'dependabot/alerts', fakeExec([['dependabot', new Error('x')]])), null);
});

test('appendHistory and readHistory round-trip, skip bad lines and return [] when missing', () => {
  const dir = tmp();
  const file = path.join(dir, 'sub', 'h.jsonl');
  assert.deepEqual(readHistory(file), []);
  appendHistory(file, [{ repo: 'a' }, { repo: 'b' }]);
  fs.appendFileSync(file, 'linha quebrada\n');
  assert.deepEqual(
    readHistory(file).map((r) => r.repo),
    ['a', 'b'],
  );
});

test('renderHtml escapes names and shows status, gate, coverage and alerts', () => {
  const html = renderHtml(
    [
      {
        repo: '<script>x</script>',
        gate: true,
        workflows: [{ name: 'CI', conclusion: 'failure' }],
        coverage: { lines: 91.25 },
        codeScanningOpen: 2,
        dependabotOpen: null,
      },
      { repo: 'y', gate: false, workflows: [], error: 'erro' },
    ],
    NOW,
  );
  assert.doesNotMatch(html, /<script>x/);
  assert.match(html, /&lt;script&gt;x&lt;\/script&gt;/);
  assert.match(html, /falha/);
  assert.match(html, />91\.3%</);
  assert.match(html, /2 \/ n\/d/);
  assert.match(html, /erro/);
  assert.match(html, /<td>n\/d<\/td>/);
});

test('parseArgs reads flags and rejects unknown ones and flags without values', () => {
  const a = parseArgs([
    '--json',
    '--strict',
    '--catalog',
    'c.json',
    '--dashboard',
    'd.html',
    '--history',
    'h.jsonl',
  ]);
  assert.equal(a.json, true);
  assert.equal(a.strict, true);
  assert.equal(a.catalog, 'c.json');
  assert.equal(a.dashboard, 'd.html');
  assert.equal(a.history, 'h.jsonl');
  assert.throws(() => parseArgs(['--nope']), /desconhecido/);
  assert.throws(() => parseArgs(['--catalog']), /precisa de um valor/);
});

test('defaultHistoryPath uses XDG_DATA_HOME when set and the home folder otherwise', () => {
  assert.equal(
    defaultHistoryPath({ XDG_DATA_HOME: '/dados' }),
    path.join('/dados', 'quality-gate', 'fleet-history.jsonl'),
  );
  assert.equal(
    defaultHistoryPath({}),
    path.join(os.homedir(), '.local', 'share', 'quality-gate', 'fleet-history.jsonl'),
  );
});

test('main returns 2 for usage or catalog errors', () => {
  assert.equal(main(['--nope']).code, 2);
  const r = main(['--catalog', path.join(tmp(), 'x.json')]);
  assert.equal(r.code, 2);
  assert.match(r.out, /catálogo não encontrado/);
  const invalid = path.join(tmp(), 'bad.json');
  fs.writeFileSync(invalid, JSON.stringify({ repos: [] }));
  assert.match(main(['--catalog', invalid]).out, /^erro: catálogo sem "owner"/);
});

test('main collects, writes history and dashboard, and honours --json and --strict', () => {
  const dir = tmp();
  const catalog = path.join(dir, 'c.json');
  fs.writeFileSync(catalog, JSON.stringify({ owner: 'o', repos: ['a', 'b'] }));
  const exec = fakeExec([
    ['repos/o/a --jq', 'main'],
    ['repos/o/b --jq', new Error('sem acesso')],
    ['contents/.quality-gate/policy.json', 'policy.json'],
    [
      'run list',
      JSON.stringify([
        { workflowName: 'CI', conclusion: 'failure', status: 'completed', createdAt: 'x', headSha: 'a' },
      ]),
    ],
    ['code-scanning', '0'],
    ['dependabot', '0'],
  ]);
  const history = path.join(dir, 'h.jsonl');
  const dash = path.join(dir, 'd.html');
  const text = main(['--catalog', catalog, '--history', history, '--dashboard', dash], { exec, now: NOW });
  assert.equal(text.code, 0);
  assert.match(text.out, /falha +a/);
  assert.match(text.out, /erro +b/);
  assert.match(text.out, /2 repos, 1 em falha/);
  assert.equal(readHistory(history).length, 2);
  assert.match(fs.readFileSync(dash, 'utf8'), /Quality Gate · frota/);
  const strict = main(['--catalog', catalog, '--history', history, '--strict', '--json'], { exec, now: NOW });
  assert.equal(strict.code, 1);
  assert.equal(JSON.parse(strict.out)[0].status, 'falha');
});
