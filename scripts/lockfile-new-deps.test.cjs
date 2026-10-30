const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  annotateAges,
  describeItem,
  diffLockfiles,
  formatReport,
  main,
  npmViewFetcher,
  parseArgs,
  readBaseLockfile,
  readHeadLockfile,
  run,
} = require('./lockfile-new-deps.cjs');

const SCRIPT = path.join(__dirname, 'lockfile-new-deps.cjs');
const NOW = Date.parse('2026-10-30T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function lock(packages) {
  return {
    name: 'app',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: { '': { name: 'app', version: '1.0.0' }, ...packages },
  };
}

const pkg = (version, extra = {}) => ({ version, resolved: 'https://example.invalid/x.tgz', ...extra });

function fetcherReturning(dates) {
  return async (name, version) => dates[`${name}@${version}`];
}

test('diffLockfiles lists added, changed (with previous version) and removed packages', () => {
  const base = lock({
    'node_modules/kept': pkg('1.0.0'),
    'node_modules/bumped': pkg('1.0.0'),
    'node_modules/gone': pkg('2.0.0'),
  });
  const head = lock({
    'node_modules/kept': pkg('1.0.0'),
    'node_modules/bumped': pkg('1.1.0'),
    'node_modules/new-dep': pkg('3.0.0'),
  });
  const diff = diffLockfiles(base, head);
  assert.deepEqual(
    diff.added.map((item) => item.id),
    ['new-dep@3.0.0'],
  );
  assert.deepEqual(diff.changed, [
    { id: 'bumped@1.1.0', name: 'bumped', version: '1.1.0', dev: false, from: '1.0.0' },
  ]);
  assert.deepEqual(
    diff.removed.map((item) => item.id),
    ['gone@2.0.0'],
  );
});

test('diffLockfiles separates dev and prod, and ignores root, versionless entries and nested duplicates', () => {
  const base = lock({});
  const head = lock({
    'node_modules/runtime-lib': pkg('1.0.0'),
    'node_modules/test-tool': pkg('2.0.0', { dev: true }),
    'node_modules/parent/node_modules/nested': pkg('0.1.0'),
    'packages/workspace-link': { name: 'workspace-link' },
  });
  const diff = diffLockfiles(base, head);
  const byId = Object.fromEntries(diff.added.map((item) => [item.id, item]));
  assert.equal(byId['runtime-lib@1.0.0'].dev, false);
  assert.equal(byId['test-tool@2.0.0'].dev, true);
  assert.equal(byId['nested@0.1.0'].name, 'nested');
  assert.equal(diff.added.length, 3);
  assert.equal(diff.changed.length, 0);
  assert.equal(diff.removed.length, 0);
});

test('diffLockfiles tolerates a missing base or head packages map', () => {
  const diff = diffLockfiles({}, null);
  assert.deepEqual(diff, { added: [], changed: [], removed: [] });
  const onlyAdded = diffLockfiles({ packages: {} }, lock({ 'node_modules/a': pkg('1.0.0') }));
  assert.equal(onlyAdded.added[0].id, 'a@1.0.0');
});

test('annotateAges marks versions younger than the limit as too new', async () => {
  const items = [
    { id: 'fresh@1.0.0', name: 'fresh', version: '1.0.0' },
    { id: 'old@1.0.0', name: 'old', version: '1.0.0' },
  ];
  const dates = {
    'fresh@1.0.0': new Date(NOW - 2 * DAY).toISOString(),
    'old@1.0.0': new Date(NOW - 30 * DAY).toISOString(),
  };
  await annotateAges(items, { fetchPublishedAt: fetcherReturning(dates), now: NOW, maxAgeDays: 7 });
  assert.equal(items[0].age.status, 'verified');
  assert.equal(items[0].age.ageDays, 2);
  assert.equal(items[0].age.tooNew, true);
  assert.equal(items[1].age.tooNew, false);
  assert.equal(items[1].age.publishedAt, new Date(NOW - 30 * DAY).toISOString());
});

test('annotateAges reports unverified age when the fetcher returns nothing, an invalid date or fails', async () => {
  const items = [
    { id: 'empty@1.0.0', name: 'empty', version: '1.0.0' },
    { id: 'bad-date@1.0.0', name: 'bad-date', version: '1.0.0' },
    { id: 'offline@1.0.0', name: 'offline', version: '1.0.0' },
  ];
  const fetchPublishedAt = async (name) => {
    if (name === 'empty') return null;
    if (name === 'bad-date') return 'not-a-date';
    throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org\nmais detalhes');
  };
  await annotateAges(items, { fetchPublishedAt, now: NOW, maxAgeDays: 7 });
  assert.deepEqual(items[0].age, { status: 'unverified', reason: 'data de publicação indisponível' });
  assert.equal(items[1].age.status, 'unverified');
  assert.equal(items[2].age.status, 'unverified');
  assert.equal(items[2].age.reason, 'getaddrinfo ENOTFOUND registry.npmjs.org');
});

test('annotateAges accepts a thrown non-Error value as the reason', async () => {
  const items = [{ id: 'x@1.0.0', name: 'x', version: '1.0.0' }];
  await annotateAges(items, {
    fetchPublishedAt: async () => {
      throw 'timeout';
    },
    now: NOW,
    maxAgeDays: 7,
  });
  assert.deepEqual(items[0].age, { status: 'unverified', reason: 'timeout' });
});

test('npmViewFetcher reads the publish date of the exact version from npm view output', () => {
  const calls = [];
  const exec = (cmd, args, opts) => {
    calls.push({ cmd, args, timeout: opts.timeout });
    return JSON.stringify([{ created: 'x', '1.2.3': '2026-10-20T10:00:00.000Z' }]);
  };
  assert.equal(npmViewFetcher('left', '1.2.3', exec), '2026-10-20T10:00:00.000Z');
  assert.deepEqual(calls[0].args, ['view', 'left@1.2.3', 'time', '--json']);
  assert.equal(calls[0].cmd, 'npm');
  assert.ok(calls[0].timeout > 0);
});

test('npmViewFetcher accepts a bare object, and returns null for missing versions and null output', () => {
  assert.equal(
    npmViewFetcher('a', '1.0.0', () => JSON.stringify({ '1.0.0': 'x' })),
    'x',
  );
  assert.equal(
    npmViewFetcher('a', '1.0.0', () => JSON.stringify([{ '2.0.0': 'x' }])),
    null,
  );
  assert.equal(
    npmViewFetcher('a', '1.0.0', () => JSON.stringify([5, null])),
    null,
  );
  assert.equal(
    npmViewFetcher('a', '1.0.0', () => 'null'),
    null,
  );
  assert.throws(() => npmViewFetcher('a', '1.0.0', () => 'not json'), SyntaxError);
});

test('readBaseLockfile reads the lockfile from git and wraps git failures with the ref', () => {
  const exec = (cmd, args) => {
    assert.deepEqual(args, ['show', 'origin/main:package-lock.json']);
    return JSON.stringify(lock({}));
  };
  assert.equal(readBaseLockfile('origin/main', exec).lockfileVersion, 3);
  assert.throws(
    () =>
      readBaseLockfile('origin/main', () => {
        throw new Error("fatal: path 'package-lock.json' does not exist\nmore");
      }),
    /não foi possível ler package-lock\.json em origin\/main: fatal: path/,
  );
});

test('readHeadLockfile reads package-lock.json from a directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lnd-head-'));
  try {
    fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify(lock({})));
    assert.equal(readHeadLockfile(dir).name, 'app');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseArgs applies defaults and every supported flag', () => {
  assert.deepEqual(parseArgs([]), {
    base: 'origin/main',
    json: false,
    maxAgeDays: 7,
    checkAge: false,
    strict: false,
  });
  const parsed = parseArgs(['--base', 'v1', '--max-age-days', '3.5', '--json', '--check-age']);
  assert.equal(parsed.base, 'v1');
  assert.equal(parsed.maxAgeDays, 3.5);
  assert.equal(parsed.json, true);
  assert.equal(parsed.checkAge, true);
  assert.equal(parsed.strict, false);
  assert.equal(parseArgs(['--strict']).checkAge, true);
});

test('parseArgs rejects missing values, invalid days and unknown flags', () => {
  assert.throws(() => parseArgs(['--base']), /--base exige um valor/);
  assert.throws(() => parseArgs(['--max-age-days']), /--max-age-days exige um valor/);
  assert.throws(() => parseArgs(['--max-age-days', 'abc']), /número positivo/);
  assert.throws(() => parseArgs(['--max-age-days', '0']), /número positivo/);
  assert.throws(() => parseArgs(['--wat']), /argumento desconhecido: --wat/);
});

test('describeItem renders scope, previous version and age state', () => {
  const base = { id: 'a@2.0.0', name: 'a', version: '2.0.0', dev: true, from: '1.0.0' };
  assert.equal(describeItem(base), 'a@2.0.0 [dev] (era 1.0.0)');
  const young = {
    ...base,
    dev: false,
    from: undefined,
    age: { status: 'verified', ageDays: 1, tooNew: true },
  };
  assert.equal(describeItem(young), 'a@2.0.0 [prod] idade 1 dias <- mais nova que o limite');
  const old = { ...young, age: { status: 'verified', ageDays: 90, tooNew: false } };
  assert.equal(describeItem(old), 'a@2.0.0 [prod] idade 90 dias');
  const unknown = { ...young, age: { status: 'unverified', reason: 'offline' } };
  assert.equal(describeItem(unknown), 'a@2.0.0 [prod] idade não verificada (offline)');
});

test('run without --check-age never calls the age fetcher and exits 0 even with findings', async () => {
  let fetched = 0;
  const { code, result } = await run([], {
    readHead: () => lock({ 'node_modules/fresh': pkg('9.9.9') }),
    readBase: () => lock({}),
    fetchPublishedAt: async () => {
      fetched++;
      return null;
    },
    now: () => NOW,
  });
  assert.equal(code, 0);
  assert.equal(fetched, 0);
  assert.deepEqual(result.findings, []);
  assert.equal(result.changedOrAdded.length, 1);
  assert.match(formatReport(result), /Idade não consultada/);
});

test('run with --strict exits 1 when a new dependency is younger than the limit', async () => {
  const io = {
    readHead: () => lock({ 'node_modules/fresh': pkg('9.9.9') }),
    readBase: () => lock({}),
    fetchPublishedAt: fetcherReturning({ 'fresh@9.9.9': new Date(NOW - DAY).toISOString() }),
    now: () => NOW,
  };
  const { code, result } = await run(['--strict'], io);
  assert.equal(code, 1);
  assert.deepEqual(result.findings, ['fresh@9.9.9']);
  assert.match(formatReport(result), /Achados \(mais novas que 7 dias\): 1/);
});

test('run with --strict exits 0 when every new dependency is old enough', async () => {
  const io = {
    readHead: () => lock({ 'node_modules/old': pkg('1.0.0') }),
    readBase: () => lock({}),
    fetchPublishedAt: fetcherReturning({ 'old@1.0.0': new Date(NOW - 60 * DAY).toISOString() }),
    now: () => NOW,
  };
  const { code, result } = await run(['--strict'], io);
  assert.equal(code, 0);
  assert.deepEqual(result.findings, []);
});

test('run with --strict does not fail on unverified age but reports it', async () => {
  const io = {
    readHead: () => lock({ 'node_modules/offline': pkg('1.0.0') }),
    readBase: () => lock({}),
    fetchPublishedAt: async () => {
      throw new Error('ENETUNREACH');
    },
    now: () => NOW,
  };
  const { code, result } = await run(['--strict', '--max-age-days', '14'], io);
  assert.equal(code, 0);
  assert.equal(result.maxAgeDays, 14);
  assert.match(formatReport(result), /Idade não verificada: 1/);
  assert.match(formatReport(result), /idade não verificada \(ENETUNREACH\)/);
});

test('run with --check-age and no unverified items omits the unverified counter', async () => {
  const io = {
    readHead: () => lock({ 'node_modules/ok': pkg('1.0.0') }),
    readBase: () => lock({}),
    fetchPublishedAt: fetcherReturning({ 'ok@1.0.0': new Date(NOW - 90 * DAY).toISOString() }),
    now: () => NOW,
  };
  const { code, result } = await run(['--check-age'], io);
  assert.equal(code, 0);
  const report = formatReport(result);
  assert.match(report, /Achados \(mais novas que 7 dias\): 0/);
  assert.doesNotMatch(report, /Idade não verificada:/);
});

test('main prints the report or JSON to stdout and returns the exit code', async () => {
  const out = [];
  const err = [];
  const io = {
    readHead: () => lock({ 'node_modules/gone-soon': pkg('1.0.0') }),
    readBase: () => lock({ 'node_modules/removed': pkg('2.0.0') }),
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  };
  assert.equal(await main([], io), 0);
  assert.match(out[0], /Adicionadas: 1\n {2}\+ gone-soon@1\.0\.0 \[prod\]/);
  assert.match(out[0], /Removidas: 1\n {2}- removed@2\.0\.0/);

  assert.equal(await main(['--json'], io), 0);
  const parsed = JSON.parse(out[1]);
  assert.deepEqual(
    parsed.added.map((item) => item.id),
    ['gone-soon@1.0.0'],
  );
  assert.equal(err.length, 0);
});

test('main returns 2 with usage text for bad arguments and 2 without usage text for read errors', async () => {
  const err = [];
  const stdout = () => {};
  const usageCode = await main(['--nope'], { stdout, stderr: (text) => err.push(text) });
  assert.equal(usageCode, 2);
  assert.match(err[0], /argumento desconhecido: --nope/);
  assert.match(err[1], /^uso: /);

  const readCode = await main([], {
    stdout,
    stderr: (text) => err.push(text),
    readHead: () => lock({}),
    readBase: () => {
      throw new Error('sem histórico');
    },
  });
  assert.equal(readCode, 2);
  assert.equal(err[2], 'lockfile-new-deps: sem histórico');
  assert.equal(err.length, 3);
});

function makeRepoWithTwoLockfiles() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lnd-repo-'));
  const git = (...args) =>
    childProcess.execFileSync(
      'git',
      [
        '-c',
        'user.name=test',
        '-c',
        'user.email=test@example.invalid',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd: dir, stdio: 'pipe' },
    );
  const write = (packages) =>
    fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify(lock(packages), null, 2));
  git('init', '-q');
  write({ 'node_modules/base-dep': pkg('1.0.0') });
  git('add', 'package-lock.json');
  git('commit', '-qm', 'base');
  write({ 'node_modules/base-dep': pkg('1.0.0'), 'node_modules/added-dep': pkg('4.0.0', { dev: true }) });
  git('commit', '-qam', 'head');
  return dir;
}

test('CLI entrypoint compares the real git history of a repository', () => {
  const dir = makeRepoWithTwoLockfiles();
  try {
    const run = childProcess.spawnSync(process.execPath, [SCRIPT, '--base', 'HEAD~1'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Adicionadas: 1\n {2}\+ added-dep@4\.0\.0 \[dev\]/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI entrypoint exits 2 with a message for an invalid flag value', () => {
  const run = childProcess.spawnSync(process.execPath, [SCRIPT, '--max-age-days', '-1'], {
    cwd: os.tmpdir(),
    encoding: 'utf8',
  });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /--max-age-days exige número positivo/);
});
