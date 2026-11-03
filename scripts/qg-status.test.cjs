const { test } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildStatus, main, render, repoSlug, readCoverage } = require('./qg-status.cjs');

function fakeGh(handlers) {
  return (file, args) => {
    const endpoint = args.find((a) => a.startsWith('repos/')) || '';
    for (const [pattern, reply] of Object.entries(handlers)) {
      if (endpoint.includes(pattern)) {
        if (reply instanceof Error) throw reply;
        return reply;
      }
    }
    throw new Error(`sem resposta para ${endpoint}`);
  };
}

function tempRepo(baseline) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-status-'));
  if (baseline !== undefined) {
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.writeFileSync(path.join(dir, 'scripts', 'baseline.json'), JSON.stringify(baseline));
  }
  return dir;
}

test('repoSlug accepts https and ssh GitHub remotes and rejects others', () => {
  assert.equal(repoSlug('https://github.com/o/r.git'), 'o/r');
  assert.equal(repoSlug('git@github.com:o/r'), 'o/r');
  assert.equal(repoSlug('https://gitlab.com/o/r'), null);
  assert.equal(repoSlug(null), null);
});

test('readCoverage reads the baseline shape and tolerates a missing file', () => {
  assert.deepEqual(readCoverage(tempRepo({ coverage: { lines: 93.3 } })), { lines: 93.3 });
  assert.deepEqual(readCoverage(tempRepo({ metrics: { coverage: { lines: 80 } } })), { lines: 80 });
  assert.equal(readCoverage(tempRepo()), null);
});

test('buildStatus combines coverage, code scanning and dependabot', () => {
  const s = buildStatus({
    root: tempRepo({ coverage: { lines: 90 } }),
    remote: 'https://github.com/o/r.git',
    exec: fakeGh({
      'code-scanning': 'semgrep\thigh\t\tr1\t1\t2026-01-01T00:00:00Z',
      dependabot: '2\n3',
    }),
  });
  assert.equal(s.repo, 'o/r');
  assert.equal(s.coverage.lines, 90);
  assert.equal(s.codeScanning.total, 1);
  assert.equal(s.dependabotOpen, 5);
});

test('buildStatus marks unavailable items as null instead of failing', () => {
  const s = buildStatus({
    root: tempRepo(),
    remote: 'https://github.com/o/r.git',
    exec: fakeGh({ 'code-scanning': new Error('403'), dependabot: new Error('403') }),
  });
  assert.equal(s.coverage, null);
  assert.equal(s.codeScanning, null);
  assert.equal(s.dependabotOpen, null);
});

test('main exits 2 without a GitHub remote and renders the error', () => {
  const r = main([], { root: tempRepo(), remote: null, exec: fakeGh({}) });
  assert.equal(r.code, 2);
  assert.match(r.out, /remoto GitHub não encontrado/);
});

test('main --json prints valid JSON and text mode prints the summary', () => {
  const deps = {
    root: tempRepo({ coverage: { lines: 50 } }),
    remote: 'https://github.com/o/r.git',
    exec: fakeGh({ 'code-scanning': '', dependabot: '0' }),
  };
  const json = JSON.parse(main(['--json'], deps).out);
  assert.equal(json.repo, 'o/r');
  assert.equal(json.codeScanning.total, 0);
  const text = main([], deps).out;
  assert.match(text, /cobertura \(linhas\): 50%/);
  assert.match(text, /code scanning: 0 abertos/);
  assert.match(text, /dependabot: 0 abertos/);
});

test('render shows n/d for unavailable items and per-tool counts when present', () => {
  const text = render({ repo: 'o/r', coverage: null, codeScanning: null, dependabotOpen: null });
  assert.match(text, /cobertura \(linhas\): n\/d/);
  assert.match(text, /code scanning: n\/d/);
  assert.match(text, /dependabot: n\/d/);
  const withTools = render({
    repo: 'o/r',
    coverage: { lines: 1 },
    codeScanning: { total: 3, byTool: { semgrep: { total: 2 }, codeql: { total: 1 } } },
    dependabotOpen: 0,
  });
  assert.match(withTools, /3 abertos \(semgrep: 2, codeql: 1\)/);
});

test('repoSlug requires the whole remote to be owner/repo', () => {
  assert.equal(repoSlug('https://github.com/devAndreotti/quality-gate.git'), 'devAndreotti/quality-gate');
  assert.equal(repoSlug('https://github.com/o/r/tree/main'), null);
});

test('readCoverage returns null when line coverage is not a number', () => {
  assert.equal(readCoverage(tempRepo({ coverage: { lines: '90' } })), null);
  assert.equal(readCoverage(tempRepo({ coverage: {} })), null);
});

test('readRemote asks git for origin and the slug drives the gh calls', () => {
  const root = tempRepo({ coverage: { lines: 50 } });
  const calls = [];
  const gh = fakeGh({ 'code-scanning': '', dependabot: '1' });
  const exec = (file, args) => {
    calls.push([file, args]);
    return file === 'git' ? 'https://github.com/o/r.git' : gh(file, args);
  };
  const r = main(['--json'], { root, exec });
  assert.equal(r.code, 0);
  assert.deepEqual(calls[0], ['git', ['-C', root, 'remote', 'get-url', 'origin']]);
  assert.equal(JSON.parse(r.out).repo, 'o/r');
});

test('main exits 2 when git cannot read the origin remote', () => {
  const r = main([], {
    root: tempRepo(),
    exec: () => {
      throw new Error('not a git repository');
    },
  });
  assert.equal(r.code, 2);
  assert.match(r.out, /remoto GitHub não encontrado/);
});

test('gh is called with the exact dependabot arguments', () => {
  const calls = [];
  buildStatus({
    root: tempRepo(),
    remote: 'https://github.com/o/r.git',
    exec: (file, args) => {
      calls.push([file, args]);
      return '';
    },
  });
  const dependabot = calls.find(([, args]) => args.some((a) => a.includes('dependabot')));
  assert.deepEqual(dependabot, [
    'gh',
    ['api', '--paginate', 'repos/o/r/dependabot/alerts?state=open&per_page=100', '--jq', 'length'],
  ]);
});

test('dependabot count sums every page, including multi-digit ones', () => {
  const s = buildStatus({
    root: tempRepo(),
    remote: 'https://github.com/o/r.git',
    exec: fakeGh({ 'code-scanning': '', dependabot: '10\n5' }),
  });
  assert.equal(s.dependabotOpen, 15);
});

test('render prints one line per field and shows nenhum when no tool has alerts', () => {
  const lines = render({
    repo: 'o/r',
    coverage: { lines: 91.25 },
    codeScanning: { total: 0, byTool: {} },
    dependabotOpen: 2,
  }).split('\n');
  assert.deepEqual(lines, [
    'repo: o/r',
    'cobertura (linhas): 91.3%',
    'code scanning: 0 abertos (nenhum)',
    'dependabot: 2 abertos',
  ]);
});

test(
  'qg status CLI reads origin and the gh output from the command line',
  {
    skip: process.platform === 'win32',
  },
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-status-cli-'));
    childProcess.execFileSync('git', ['init', '-q'], { cwd: root });
    childProcess.execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/o/r.git'], {
      cwd: root,
    });
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.writeFileSync(
      path.join(root, 'scripts', 'baseline.json'),
      JSON.stringify({ coverage: { lines: 90 } }),
    );
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-status-bin-'));
    const gh = path.join(bin, 'gh');
    fs.writeFileSync(
      gh,
      [
        '#!/bin/sh',
        'case "$*" in',
        "  *code-scanning*) printf 'semgrep\\thigh\\t\\tr1\\t1\\t2026-01-01T00:00:00Z\\n' ;;",
        "  *dependabot*) printf '2\\n3\\n' ;;",
        'esac',
        '',
      ].join('\n'),
    );
    fs.chmodSync(gh, 0o755);
    const script = path.join(__dirname, 'qg-status.cjs');
    const r = childProcess.spawnSync(process.execPath, [script, '--json'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
    });
    assert.equal(r.status, 0);
    const json = JSON.parse(r.stdout);
    assert.equal(json.repo, 'o/r');
    assert.equal(json.coverage.lines, 90);
    assert.equal(json.codeScanning.total, 1);
    assert.equal(json.dependabotOpen, 5);
  },
);

test('qg status CLI exits 2 outside a GitHub remote and prints the error', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-status-nogit-'));
  const script = path.join(__dirname, 'qg-status.cjs');
  const r = childProcess.spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /qg status: remoto GitHub não encontrado/);
});

test('repoSlug ignores surrounding whitespace such as a trailing newline', () => {
  assert.equal(repoSlug('git@github.com:o/r.git\n'), 'o/r');
});

test('requiring the module prints nothing and sets no exit code', () => {
  const script = path.join(__dirname, 'qg-status.cjs');
  const r = childProcess.spawnSync(process.execPath, ['-e', `require(${JSON.stringify(script)})`], {
    cwd: tempRepo(),
    encoding: 'utf8',
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});
