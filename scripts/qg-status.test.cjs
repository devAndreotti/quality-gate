const { test } = require('node:test');
const assert = require('node:assert/strict');
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
