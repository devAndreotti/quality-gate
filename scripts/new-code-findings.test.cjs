const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const { parseAddedLines } = require('./lib/diff-coverage.cjs');
const {
  collectNewCodeFindings,
  filterFindingsToAddedLines,
  parseArgs,
  runCli,
  runEslint,
  selectJsFiles,
  UsageError,
} = require('./new-code-findings.cjs');

const ROOT = path.resolve(__dirname, '..');
const FAKE_ROOT = '/repo';

function diffFor(file, addedLines, startLine = 1) {
  const body = addedLines.map((l) => `+${l}`).join('\n');
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${startLine - 1},0 +${startLine},${addedLines.length} @@`,
    body,
  ].join('\n');
}

function eslintResult(file, messages) {
  return { filePath: `${FAKE_ROOT}/${file}`, messages };
}

function msg(line, ruleId = 'no-unused-vars', column = 3) {
  return { ruleId, severity: 2, line, column, message: `problema na linha ${line}` };
}

function addedMap(file, lines) {
  return new Map([[file, new Map(lines.map((n) => [n, 'x']))]]);
}

// Fake de spawnSync: cada handler recebe (command, args) e devolve { status, stdout, stderr }.
function fakeSpawn(handler) {
  const calls = [];
  const spawn = (command, args) => {
    calls.push({ command, args });
    return handler(command, args);
  };
  return { spawn, calls };
}

const ok = (stdout = '', stderr = '') => ({ status: 0, stdout, stderr });

test('selectJsFiles keeps JS/CJS/MJS and drops other files and excluded folders', () => {
  const picked = selectJsFiles([
    'scripts/a.cjs',
    'scripts/b.js',
    'scripts/c.mjs',
    'README.md',
    'scripts/d.ts',
    'node_modules/x/index.js',
    'coverage/lcov-report/sorter.js',
    '.semgrep/rules/sample.js',
  ]);
  assert.deepEqual(picked, ['scripts/a.cjs', 'scripts/b.js', 'scripts/c.mjs']);
});

test('filterFindingsToAddedLines reports a finding on an added line', () => {
  const added = addedMap('scripts/a.cjs', [5]);
  const r = filterFindingsToAddedLines([eslintResult('scripts/a.cjs', [msg(5)])], added, { root: FAKE_ROOT });
  assert.deepEqual(r.findings, [
    {
      file: 'scripts/a.cjs',
      line: 5,
      column: 3,
      ruleId: 'no-unused-vars',
      message: 'problema na linha 5',
    },
  ]);
  assert.equal(r.ignoredOld, 0);
  assert.deepEqual(r.notAnalyzedFiles, []);
});

test('filterFindingsToAddedLines ignores and counts a finding on an old line', () => {
  const added = addedMap('scripts/a.cjs', [5]);
  const r = filterFindingsToAddedLines([eslintResult('scripts/a.cjs', [msg(1), msg(5), msg(9)])], added, {
    root: FAKE_ROOT,
  });
  assert.deepEqual(
    r.findings.map((f) => f.line),
    [5],
  );
  assert.equal(r.ignoredOld, 2);
});

test('filterFindingsToAddedLines counts findings of a file without added lines as old', () => {
  const r = filterFindingsToAddedLines([eslintResult('scripts/untouched.cjs', [msg(1), msg(2)])], new Map(), {
    root: FAKE_ROOT,
  });
  assert.deepEqual(r.findings, []);
  assert.equal(r.ignoredOld, 2);
});

test('filterFindingsToAddedLines keeps relative paths and reports parse errors as fatal', () => {
  const added = addedMap('scripts/rel.cjs', [2]);
  const relative = {
    filePath: 'scripts/rel.cjs',
    messages: [{ ruleId: null, severity: 2, line: 2, column: 1, message: 'Parsing error' }],
  };
  const r = filterFindingsToAddedLines([relative], added, { root: FAKE_ROOT });
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].file, 'scripts/rel.cjs');
  assert.equal(r.findings[0].ruleId, null);
});

test('filterFindingsToAddedLines separates messages without line as not analyzed', () => {
  const r = filterFindingsToAddedLines(
    [
      {
        filePath: `${FAKE_ROOT}/scripts/menu-tui.mjs`,
        messages: [
          { ruleId: null, severity: 1, message: 'File ignored because of a matching ignore pattern.' },
        ],
      },
    ],
    new Map(),
    { root: FAKE_ROOT },
  );
  assert.deepEqual(r.findings, []);
  assert.equal(r.ignoredOld, 0);
  assert.deepEqual(r.notAnalyzedFiles, ['scripts/menu-tui.mjs']);
});

test('filterFindingsToAddedLines works with the parseAddedLines output', () => {
  const diff = diffFor('scripts/x.cjs', ['const a = 1;', 'const b = 2;'], 10);
  const r = filterFindingsToAddedLines(
    [eslintResult('scripts/x.cjs', [msg(10), msg(11), msg(3)])],
    parseAddedLines(diff),
    { root: FAKE_ROOT },
  );
  assert.deepEqual(
    r.findings.map((f) => f.line),
    [10, 11],
  );
  assert.equal(r.ignoredOld, 1);
});

test('parseArgs reads defaults and every supported flag', () => {
  assert.deepEqual(parseArgs([]), { base: 'origin/main', json: false, strict: false });
  assert.deepEqual(parseArgs(['--base', 'abc', '--json', '--strict']), {
    base: 'abc',
    json: true,
    strict: true,
  });
  assert.equal(parseArgs(['--base=feature']).base, 'feature');
});

test('parseArgs rejects a missing or empty base and unknown flags with UsageError', () => {
  assert.throws(() => parseArgs(['--base']), UsageError);
  assert.throws(() => parseArgs(['--base', '--json']), UsageError);
  assert.throws(() => parseArgs(['--base=']), UsageError);
  assert.throws(() => parseArgs(['--what']), UsageError);
});

test('runEslint returns the parsed results when eslint exits 0 or 1', () => {
  const results = [eslintResult('scripts/a.cjs', [])];
  const clean = fakeSpawn(() => ok(JSON.stringify(results)));
  assert.deepEqual(runEslint(clean.spawn, FAKE_ROOT, ['scripts/a.cjs']), results);
  assert.equal(clean.calls[0].command, 'npx');
  assert.deepEqual(clean.calls[0].args.slice(0, 4), ['--no-install', 'eslint', '-f', 'json']);

  const withFindings = fakeSpawn(() => ({ status: 1, stdout: JSON.stringify(results), stderr: '' }));
  assert.deepEqual(runEslint(withFindings.spawn, FAKE_ROOT, ['scripts/a.cjs']), results);
});

test('runEslint throws with a message when eslint exits 2', () => {
  const { spawn } = fakeSpawn(() => ({ status: 2, stdout: '', stderr: 'Oops! Something went wrong\nmais' }));
  assert.throws(() => runEslint(spawn, FAKE_ROOT, ['scripts/a.cjs']), /eslint falhou \(exit 2\): Oops!/);
});

test('runEslint throws when npx cannot run, output is not JSON, or JSON is not an array', () => {
  const missing = fakeSpawn(() => ({ error: new Error('spawn npx ENOENT') }));
  assert.throws(() => runEslint(missing.spawn, FAKE_ROOT, ['a.cjs']), /npx não pôde rodar/);

  const notJson = fakeSpawn(() => ({ status: 0, stdout: 'não é json', stderr: '' }));
  assert.throws(() => runEslint(notJson.spawn, FAKE_ROOT, ['a.cjs']), /eslint não produziu JSON/);

  const notArray = fakeSpawn(() => ({ status: 0, stdout: '{"a":1}', stderr: '' }));
  assert.throws(() => runEslint(notArray.spawn, FAKE_ROOT, ['a.cjs']), /esperado array/);
});

test('runEslint runs the real eslint on a lint-clean file of this repo', () => {
  const results = runEslint(spawnSync, ROOT, ['scripts/diff-coverage-gate.cjs']);
  assert.equal(results.length, 1);
  assert.deepEqual(results[0].messages, []);
});

test('collectNewCodeFindings skips eslint when no JS file changed', () => {
  const { spawn, calls } = fakeSpawn((command, args) => {
    if (args.includes('--name-only')) return ok('README.md\n.github/workflows/x.yml\n');
    throw new Error(`nao era esperado: ${command} ${args.join(' ')}`);
  });
  const r = collectNewCodeFindings({ root: FAKE_ROOT, base: 'origin/main', spawn });
  assert.deepEqual(r.analyzedFiles, []);
  assert.deepEqual(r.findings, []);
  assert.equal(
    calls.some((c) => c.command === 'npx'),
    false,
  );
});

test('collectNewCodeFindings reports only findings on lines added by the PR', () => {
  const diff = diffFor('scripts/a.cjs', ['const added = 1;'], 7);
  const { spawn } = fakeSpawn((command, args) => {
    if (args.includes('--name-only')) return ok('scripts/a.cjs\n');
    if (args.includes('--unified=0')) return ok(diff);
    return {
      status: 1,
      stdout: JSON.stringify([eslintResult('scripts/a.cjs', [msg(7), msg(2)])]),
      stderr: '',
    };
  });
  const r = collectNewCodeFindings({ root: FAKE_ROOT, base: 'origin/main', spawn });
  assert.deepEqual(r.analyzedFiles, ['scripts/a.cjs']);
  assert.deepEqual(
    r.findings.map((f) => f.line),
    [7],
  );
  assert.equal(r.ignoredOld, 1);
});

test('collectNewCodeFindings passes git failures on as errors', () => {
  const { spawn } = fakeSpawn(() => ({ status: 128, stdout: '', stderr: 'fatal: bad revision origin/main' }));
  assert.throws(
    () => collectNewCodeFindings({ root: FAKE_ROOT, base: 'origin/main', spawn }),
    /git diff --name-only .* falhou: fatal: bad revision origin\/main\. Em CI, use fetch-depth: 0\./,
  );
});

test('runCli exits 0 in advisory mode with new findings and lists them', () => {
  const diff = diffFor('scripts/a.cjs', ['const added = 1;'], 7);
  const { spawn } = fakeSpawn((command, args) => {
    if (args.includes('--name-only')) return ok('scripts/a.cjs\n');
    if (args.includes('--unified=0')) return ok(diff);
    return {
      status: 1,
      stdout: JSON.stringify([eslintResult('scripts/a.cjs', [msg(7), msg(2)])]),
      stderr: '',
    };
  });
  const out = [];
  const err = [];
  const code = runCli(['--base', 'origin/main'], {
    spawn,
    root: FAKE_ROOT,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
  });
  assert.equal(code, 0);
  assert.deepEqual(err, []);
  assert.match(out[0], /Achados novos \(linhas adicionadas contra origin\/main\): 1/);
  assert.match(out[0], /scripts\/a\.cjs:7:3 \[no-unused-vars\]/);
  assert.match(out[0], /Achados antigos ignorados \(fora das linhas novas\): 1/);
  assert.match(out[0], /Modo advisory/);
});

test('runCli exits 1 with --strict when there is a new finding', () => {
  const diff = diffFor('scripts/a.cjs', ['x'], 1);
  const { spawn } = fakeSpawn((command, args) => {
    if (args.includes('--name-only')) return ok('scripts/a.cjs\n');
    if (args.includes('--unified=0')) return ok(diff);
    return { status: 1, stdout: JSON.stringify([eslintResult('scripts/a.cjs', [msg(1)])]), stderr: '' };
  });
  const out = [];
  const code = runCli(['--strict'], { spawn, root: FAKE_ROOT, stdout: (t) => out.push(t), stderr: () => {} });
  assert.equal(code, 1);
  assert.doesNotMatch(out[0], /Modo advisory/);
});

test('runCli exits 0 with --strict when there is no new finding', () => {
  const diff = diffFor('scripts/a.cjs', ['x'], 1);
  const { spawn } = fakeSpawn((command, args) => {
    if (args.includes('--name-only')) return ok('scripts/a.cjs\n');
    if (args.includes('--unified=0')) return ok(diff);
    return { status: 1, stdout: JSON.stringify([eslintResult('scripts/a.cjs', [msg(9)])]), stderr: '' };
  });
  const out = [];
  const code = runCli(['--strict'], { spawn, root: FAKE_ROOT, stdout: (t) => out.push(t), stderr: () => {} });
  assert.equal(code, 0);
  assert.match(out[0], /: 0\n/);
});

test('runCli prints machine-readable JSON with --json', () => {
  const { spawn } = fakeSpawn((command, args) => ok(args.includes('--name-only') ? 'README.md\n' : ''));
  const out = [];
  const code = runCli(['--json'], {
    spawn,
    root: FAKE_ROOT,
    stdout: (t) => out.push(t),
    stderr: () => {},
  });
  assert.equal(code, 0);
  const parsed = JSON.parse(out[0]);
  assert.equal(parsed.exitCode, 0);
  assert.equal(parsed.strict, false);
  assert.deepEqual(parsed.findings, []);
});

test('runCli lists files that eslint could not analyze', () => {
  const diff = diffFor('scripts/menu-tui.mjs', ['x'], 1);
  const { spawn } = fakeSpawn((command, args) => {
    if (args.includes('--name-only')) return ok('scripts/menu-tui.mjs\n');
    if (args.includes('--unified=0')) return ok(diff);
    return {
      status: 0,
      stdout: JSON.stringify([
        {
          filePath: `${FAKE_ROOT}/scripts/menu-tui.mjs`,
          messages: [{ ruleId: null, severity: 1, message: 'File ignored' }],
        },
      ]),
      stderr: '',
    };
  });
  const out = [];
  assert.equal(runCli([], { spawn, root: FAKE_ROOT, stdout: (t) => out.push(t), stderr: () => {} }), 0);
  assert.match(out[0], /Não analisado \(fora da config do ESLint\): scripts\/menu-tui\.mjs/);
});

test('runCli exits 2 with a usage message on a bad argument', () => {
  const err = [];
  const code = runCli(['--nope'], { stdout: () => {}, stderr: (t) => err.push(t) });
  assert.equal(code, 2);
  assert.match(err[0], /argumento desconhecido: --nope/);
  assert.match(err[0], /Uso:/);
});

test('runCli exits 2 with a message when eslint fails', () => {
  const diff = diffFor('scripts/a.cjs', ['x'], 1);
  const { spawn } = fakeSpawn((command, args) => {
    if (args.includes('--name-only')) return ok('scripts/a.cjs\n');
    if (args.includes('--unified=0')) return ok(diff);
    return { status: 2, stdout: '', stderr: 'ESLint: config invalida' };
  });
  const err = [];
  const out = [];
  const code = runCli([], { spawn, root: FAKE_ROOT, stdout: (t) => out.push(t), stderr: (t) => err.push(t) });
  assert.equal(code, 2);
  assert.deepEqual(out, []);
  assert.match(err[0], /new-code-findings: ERRO — eslint falhou \(exit 2\): ESLint: config invalida/);
});

test('runCli runs against the real git repo with no changes and exits 0', () => {
  const out = [];
  const code = runCli(['--base', 'HEAD'], { root: ROOT, stdout: (t) => out.push(t), stderr: () => {} });
  assert.equal(code, 0);
  assert.match(out[0], /Nenhum arquivo JS\/CJS\/MJS alterado/);
});
