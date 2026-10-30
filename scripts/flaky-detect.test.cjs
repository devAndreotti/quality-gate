const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  UsageError,
  classify,
  formatSummary,
  listTestFiles,
  loadQuarantine,
  main,
  parseArgs,
  parseTap,
  runFlakyDetection,
  runRound,
  todayUtc,
  validateQuarantine,
} = require('./flaky-detect.cjs');

const TODAY = '2026-10-30';
const FUTURE = '2999-12-31';
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flaky-detect-test-'));
test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

/** TAP minimo: entries = [['ok'|'not ok', nome], ...]. */
function tap(entries) {
  return ['TAP version 13', ...entries.map(([state, name], i) => `${state} ${i + 1} - ${name}`)].join('\n');
}

/** Runner falso: devolve uma saida por rodada, na ordem. Sem saida restante = rodada sem TAP. */
function scriptedRunner(outputs) {
  const queue = [...outputs];
  return () => {
    const next = queue.shift();
    if (next === undefined) return { stdout: '', error: null };
    return typeof next === 'string' ? { stdout: next, error: null } : next;
  };
}

function quarantineOf(list, today = TODAY) {
  return { path: 'q.json', present: true, ...validateQuarantine(list, today) };
}

function freshDir(name) {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function captureIo() {
  const out = [];
  const err = [];
  return { out, err, stdout: (text) => out.push(text), stderr: (text) => err.push(text) };
}

test('parseArgs uses defaults when no flag is given', () => {
  assert.deepEqual(parseArgs([]), {
    runs: 3,
    jsonOut: null,
    dir: 'scripts',
    quarantine: path.join('.quality-gate', 'flaky-quarantine.json'),
    checkQuarantine: false,
  });
});

test('parseArgs accepts "--flag value" and "--flag=value" forms', () => {
  const args = parseArgs(['--runs', '5', '--dir', 'x', '--json-out', 'a.json', '--quarantine', 'q.json']);
  assert.equal(args.runs, 5);
  assert.equal(args.dir, 'x');
  assert.equal(args.jsonOut, 'a.json');
  assert.equal(args.quarantine, 'q.json');
  assert.equal(parseArgs(['--runs=10', '--json-out=b.json']).runs, 10);
  assert.equal(parseArgs(['--json-out=b.json']).jsonOut, 'b.json');
  assert.equal(parseArgs(['--check-quarantine']).checkQuarantine, true);
});

test('parseArgs rejects invalid --runs values with a usage error', () => {
  for (const bad of [['--runs', '0'], ['--runs', '11'], ['--runs', 'abc'], ['--runs=']]) {
    assert.throws(() => parseArgs(bad), UsageError, bad.join(' '));
  }
});

test('parseArgs rejects missing values, unknown flags and bool flags with =', () => {
  assert.throws(() => parseArgs(['--json-out']), /--json-out exige um valor/);
  assert.throws(() => parseArgs(['--dir', '--runs']), /--dir exige um valor/);
  assert.throws(() => parseArgs(['--json-out=']), /exige um valor/);
  assert.throws(() => parseArgs(['--foo']), /argumento desconhecido: --foo/);
  assert.throws(() => parseArgs(['--check-quarantine=1']), /argumento desconhecido/);
});

test('parseTap reads ok, not ok, nested subtests and SKIP/TODO directives', () => {
  const text = [
    'TAP version 13',
    '# Subtest: a',
    'ok 1 - top ok',
    '  ---',
    '  duration_ms: 1',
    '  ...',
    'not ok 2 - top fail',
    'ok 3 - skipped # SKIP',
    'not ok 4 - todo fail # TODO known bug',
    '    ok 1 - inner ok',
    '    not ok 2 - inner bad',
    'ok 9 # SKIP',
    'ok 10',
    '1..10',
  ].join('\n');
  const parsed = parseTap(text);
  assert.equal(parsed.hasHeader, true);
  assert.deepEqual(
    [...parsed.tests],
    [
      ['top ok', 'pass'],
      ['top fail', 'fail'],
      ['skipped', 'skip'],
      ['todo fail', 'skip'],
      ['inner ok', 'pass'],
      ['inner bad', 'fail'],
    ],
  );
});

test('parseTap keeps the worst result for a name repeated in one run', () => {
  const parsed = parseTap(
    tap([
      ['ok', 'same'],
      ['not ok', 'same'],
      ['ok', 'skip-then-pass # SKIP'],
      ['ok', 'skip-then-pass'],
      ['ok', 'only-skip # SKIP'],
    ]),
  );
  assert.equal(parsed.tests.get('same'), 'fail');
  assert.equal(parsed.tests.get('skip-then-pass'), 'pass');
  assert.equal(parsed.tests.get('only-skip'), 'skip');
  assert.equal(parsed.tests.get('only-skip # SKIP'), undefined);
});

test('parseTap reports a missing header for empty or non-TAP output', () => {
  assert.deepEqual(parseTap(undefined), { hasHeader: false, tests: new Map() });
  assert.deepEqual(parseTap('Error: boom'), { hasHeader: false, tests: new Map() });
  assert.equal(parseTap('TAP version 13').hasHeader, true);
});

test('validateQuarantine accepts a valid active entry and an entry expiring today', () => {
  const result = validateQuarantine(
    [
      { test: 'a', reason: 'race no mock', expires: FUTURE },
      { test: 'b', reason: 'vence hoje', expires: TODAY },
    ],
    TODAY,
  );
  assert.deepEqual([...result.active.keys()], ['a', 'b']);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.expired, []);
});

test('validateQuarantine reports missing fields, bad dates and non-object entries', () => {
  const result = validateQuarantine(
    [
      { reason: 'sem nome', expires: FUTURE },
      { test: 'sem motivo', expires: FUTURE },
      { test: '   ', reason: 'nome vazio', expires: FUTURE },
      { test: 'data ruim', reason: 'r', expires: '2026/01/01' },
      { test: 'dia impossivel', reason: 'r', expires: '2026-02-30' },
      { test: 'numero', reason: 'r', expires: 20991231 },
      null,
      'texto',
    ],
    TODAY,
  );
  assert.equal(result.active.size, 0);
  assert.deepEqual(result.errors, [
    'entrada 1: campo "test" obrigatório (texto)',
    'entrada 2: campo "reason" obrigatório (texto)',
    'entrada 3: campo "test" obrigatório (texto)',
    'entrada 4: campo "expires" deve ser data YYYY-MM-DD válida',
    'entrada 5: campo "expires" deve ser data YYYY-MM-DD válida',
    'entrada 6: campo "expires" deve ser data YYYY-MM-DD válida',
    'entrada 7: deve ser um objeto',
    'entrada 8: deve ser um objeto',
  ]);
});

test('validateQuarantine moves expired entries out of the active set and reports them', () => {
  const result = validateQuarantine([{ test: 'velha', reason: 'r', expires: '2026-10-29' }], TODAY);
  assert.equal(result.active.size, 0);
  assert.deepEqual(result.expired, [{ test: 'velha', reason: 'r', expires: '2026-10-29' }]);
  assert.deepEqual(result.errors, ['entrada 1: quarentena vencida em 2026-10-29 ("velha")']);
});

test('validateQuarantine rejects duplicated test names, including expired duplicates', () => {
  const result = validateQuarantine(
    [
      { test: 'dup', reason: 'r', expires: FUTURE },
      { test: 'dup', reason: 'outra', expires: FUTURE },
      { test: 'velho', reason: 'r', expires: '2000-01-01' },
      { test: 'velho', reason: 'de novo', expires: FUTURE },
    ],
    TODAY,
  );
  assert.deepEqual([...result.active.keys()], ['dup']);
  assert.equal(result.errors[0], 'entrada 2: teste duplicado "dup"');
  assert.equal(result.errors[2], 'entrada 4: teste duplicado "velho"');
});

test('validateQuarantine requires a top-level list', () => {
  const result = validateQuarantine({ test: 'a' }, TODAY);
  assert.equal(result.active.size, 0);
  assert.deepEqual(result.errors, ['o arquivo deve conter uma lista JSON']);
});

test('loadQuarantine treats a missing file as empty and no errors', () => {
  const loaded = loadQuarantine(path.join(tmpRoot, 'nao-existe.json'), TODAY);
  assert.equal(loaded.present, false);
  assert.equal(loaded.active.size, 0);
  assert.deepEqual(loaded.errors, []);
});

test('loadQuarantine reports invalid JSON as an error', () => {
  const file = path.join(freshDir('quarantine-json'), 'q.json');
  fs.writeFileSync(file, '[{ "test": ');
  const loaded = loadQuarantine(file, TODAY);
  assert.equal(loaded.present, true);
  assert.match(loaded.errors[0], /^JSON inválido: /);
});

test('loadQuarantine reads a valid file from disk', () => {
  const file = path.join(freshDir('quarantine-ok'), 'q.json');
  fs.writeFileSync(file, JSON.stringify([{ test: 'a', reason: 'r', expires: FUTURE }]));
  const loaded = loadQuarantine(file, TODAY);
  assert.equal(loaded.present, true);
  assert.deepEqual([...loaded.active.keys()], ['a']);
});

test('listTestFiles returns sorted *.test.cjs files and nothing for a missing dir', () => {
  const dir = freshDir('list');
  fs.writeFileSync(path.join(dir, 'b.test.cjs'), '');
  fs.writeFileSync(path.join(dir, 'a.test.cjs'), '');
  fs.writeFileSync(path.join(dir, 'helper.cjs'), '');
  assert.deepEqual(listTestFiles(dir), [path.join(dir, 'a.test.cjs'), path.join(dir, 'b.test.cjs')]);
  assert.deepEqual(listTestFiles(path.join(tmpRoot, 'missing')), []);
});

test('classify covers quarantine, skip-only, flaky, real failure and stable pass', () => {
  const quarantine = quarantineOf([{ test: 'q', reason: 'r', expires: FUTURE }]);
  assert.equal(classify('q', ['fail', 'pass'], quarantine), 'quarentena');
  assert.equal(classify('s', ['skip', 'skip'], quarantine), 'skip');
  assert.equal(classify('f', ['pass', 'fail', 'skip'], quarantine), 'flaky');
  assert.equal(classify('r', ['fail', 'fail'], quarantine), 'falha');
  assert.equal(classify('ok', ['pass', 'pass'], quarantine), 'ok');
});

test('runRound marks a round executed when TAP is produced, keeping any runner error', () => {
  const ok = runRound(['a.test.cjs'], scriptedRunner([tap([['ok', 'x']])]));
  assert.equal(ok.executed, true);
  assert.equal(ok.error, null);
  const partial = runRound(['a.test.cjs'], () => ({ stdout: tap([['ok', 'x']]), error: 'ETIMEDOUT' }));
  assert.equal(partial.executed, true);
  assert.equal(partial.error, 'ETIMEDOUT');
});

test('runRound marks a round not executed when there is no TAP output', () => {
  const withError = runRound(['a.test.cjs'], () => ({ stdout: '', error: 'spawn ENOENT' }));
  assert.deepEqual([withError.executed, withError.error, withError.tests.size], [false, 'spawn ENOENT', 0]);
  const silent = runRound(['a.test.cjs'], () => ({ stdout: 'crash', error: null }));
  assert.equal(silent.executed, false);
  assert.equal(silent.error, 'node --test não produziu saída TAP');
});

test('runFlakyDetection detects flaky tests and keeps stable failures apart', () => {
  const quarantine = quarantineOf([
    { test: 'quarentenado', reason: 'race', expires: FUTURE },
    { test: 'sumiu', reason: 'removido', expires: FUTURE },
  ]);
  const runner = scriptedRunner([
    tap([
      ['ok', 'estavel'],
      ['not ok', 'flaky'],
      ['not ok', 'sempre falha'],
      ['ok', 'quarentenado'],
    ]),
    tap([
      ['ok', 'estavel'],
      ['ok', 'flaky'],
      ['not ok', 'sempre falha'],
      ['not ok', 'quarentenado'],
    ]),
    tap([
      ['ok', 'estavel'],
      ['not ok', 'sempre falha'],
      ['ok', 'pulado # SKIP'],
    ]),
  ]);
  const report = runFlakyDetection({ runs: 3, files: ['a.test.cjs'], runner, quarantine });
  assert.equal(report.runsExecuted, 3);
  assert.deepEqual(
    report.flaky.map((t) => [t.name, t.outcomes]),
    [['flaky', ['fail', 'pass']]],
  );
  assert.deepEqual(
    report.realFailures.map((t) => t.name),
    ['sempre falha'],
  );
  assert.deepEqual(
    report.quarantined.map((t) => [t.name, t.reason, t.expires]),
    [['quarentenado', 'race', FUTURE]],
  );
  assert.deepEqual(report.missingFromRun, ['sumiu']);
  assert.equal(report.tests.find((t) => t.name === 'estavel').status, 'ok');
  assert.equal(report.tests.find((t) => t.name === 'pulado').status, 'skip');
});

test('a test that always passes is not flaky', () => {
  const runner = scriptedRunner([tap([['ok', 'sempre passa']]), tap([['ok', 'sempre passa']])]);
  const report = runFlakyDetection({ runs: 2, files: ['a.test.cjs'], runner, quarantine: quarantineOf([]) });
  assert.deepEqual(report.flaky, []);
  assert.deepEqual(
    report.tests.map((t) => t.status),
    ['ok'],
  );
});

test('a test that always fails is a real failure, not flaky', () => {
  const runner = scriptedRunner([tap([['not ok', 'sempre falha']]), tap([['not ok', 'sempre falha']])]);
  const report = runFlakyDetection({ runs: 2, files: ['a.test.cjs'], runner, quarantine: quarantineOf([]) });
  assert.deepEqual(report.flaky, []);
  assert.deepEqual(
    report.realFailures.map((t) => t.name),
    ['sempre falha'],
  );
});

test('runFlakyDetection with no executed round reports zero runs and the round errors', () => {
  const runner = () => ({ stdout: '', error: 'ETIMEDOUT' });
  const report = runFlakyDetection({ runs: 2, files: ['a.test.cjs'], runner, quarantine: quarantineOf([]) });
  assert.equal(report.runsExecuted, 0);
  assert.deepEqual(
    report.rounds.map((r) => [r.executed, r.error]),
    [
      [false, 'ETIMEDOUT'],
      [false, 'ETIMEDOUT'],
    ],
  );
});

test('formatSummary lists flaky, real failures and quarantine with empty markers', () => {
  const runner = scriptedRunner([tap([['not ok', 'x']]), tap([['ok', 'x']])]);
  const report = runFlakyDetection({
    runs: 2,
    files: ['a.test.cjs'],
    runner,
    quarantine: quarantineOf([{ test: 'y', reason: 'motivo y', expires: FUTURE }]),
  });
  const text = formatSummary(report);
  assert.match(text, /^Detecção de flaky: 2 de 2 rodada\(s\) executada\(s\); 1 arquivo\(s\); 1 teste\(s\)/);
  assert.match(text, /Testes flaky .*: 1\n {2}- x \[fail, pass\]/);
  assert.match(text, /Falhas reais .*: 0\n {2}\(nenhum\)/);
  assert.match(text, /Em quarentena .*: 0\n {2}\(nenhum\)/);
  assert.match(text, /Quarentena sem resultado nesta execução \(teste ausente\):\n {2}- y/);
  assert.match(text, /Modo advisory: este resultado não bloqueia o CI\.$/);
});

test('formatSummary shows quarantined rows, validation errors and round errors', () => {
  const quarantine = quarantineOf([
    { test: 'y', reason: 'motivo y', expires: FUTURE },
    { test: 'velho', reason: 'r', expires: '2000-01-01' },
  ]);
  const runner = scriptedRunner([{ stdout: tap([['not ok', 'y']]), error: 'ETIMEDOUT' }, tap([['ok', 'y']])]);
  const report = runFlakyDetection({ runs: 2, files: ['a.test.cjs'], runner, quarantine });
  const text = formatSummary(report);
  assert.match(text, /\n {2}- y \[fail, pass\] motivo: motivo y \(expira 2999-12-31\)/);
  assert.match(text, /Quarentena: 1 erro\(s\) de validação/);
  assert.match(text, /\n {2}- entrada 2: quarentena vencida em 2000-01-01/);
  assert.match(text, /Rodadas com erro:\n {2}- rodada 1: ETIMEDOUT/);
});

test('main prints usage with exit 2 on bad arguments', () => {
  const io = captureIo();
  assert.equal(main(['--runs', '0'], io), 2);
  assert.match(io.err.join(''), /--runs deve ser inteiro entre 1 e 10/);
  assert.match(io.err.join(''), /uso: node scripts\/flaky-detect\.cjs/);
});

test('main exits 2 with an error message on unexpected failures', () => {
  const dir = freshDir('blocked-json');
  fs.writeFileSync(path.join(dir, 'a.test.cjs'), '');
  const blocker = path.join(dir, 'arquivo');
  fs.writeFileSync(blocker, '');
  const io = captureIo();
  const code = main(['--dir', dir, '--json-out', path.join(blocker, 'x.json')], {
    ...io,
    today: TODAY,
    runner: scriptedRunner([tap([['ok', 'x']])]),
  });
  assert.equal(code, 2);
  assert.match(io.err.join(''), /^flaky-detect: erro: /);
});

test('main exits 2 when there are no test files', () => {
  const io = captureIo();
  assert.equal(main(['--dir', freshDir('vazia')], io), 2);
  assert.match(io.err.join(''), /nenhum \*\.test\.cjs/);
});

test('main exits 2 when no round executes, and still writes the JSON report', () => {
  const dir = freshDir('zero-rounds');
  fs.writeFileSync(path.join(dir, 'a.test.cjs'), '');
  const json = path.join(tmpRoot, 'zero', 'report.json');
  const io = captureIo();
  const code = main(['--dir', dir, '--runs', '2', '--json-out', json], {
    ...io,
    today: TODAY,
    runner: () => ({ stdout: '', error: 'spawn ENOENT' }),
  });
  assert.equal(code, 2);
  assert.match(io.err.join(''), /nenhuma rodada conseguiu executar a suíte \(spawn ENOENT; spawn ENOENT\)/);
  assert.equal(JSON.parse(fs.readFileSync(json, 'utf8')).runsExecuted, 0);
});

test('main exits 0 in advisory mode even with flaky and failing tests', () => {
  const dir = freshDir('advisory');
  fs.writeFileSync(path.join(dir, 'a.test.cjs'), '');
  const io = captureIo();
  const code = main(['--dir', dir, '--runs', '2'], {
    ...io,
    today: TODAY,
    runner: scriptedRunner([tap([['not ok', 'f']]), tap([['ok', 'f']])]),
  });
  assert.equal(code, 0);
  assert.match(io.out.join(''), /Testes flaky .*: 1/);
});

test('main --check-quarantine validates the file and exits 1 on errors', () => {
  const dir = freshDir('check');
  const file = path.join(dir, 'q.json');
  const io = captureIo();

  assert.equal(main(['--check-quarantine', '--quarantine', file], io), 0);
  assert.match(io.out.join(''), /arquivo ausente/);

  fs.writeFileSync(file, JSON.stringify([{ test: 'a', reason: 'r', expires: FUTURE }]));
  const ok = captureIo();
  assert.equal(main(['--check-quarantine', '--quarantine', file], ok), 0);
  assert.match(ok.out.join(''), /1 ativa\(s\), 0 vencida\(s\), 0 erro\(s\)/);

  fs.writeFileSync(file, JSON.stringify([{ test: 'a', reason: 'r', expires: '2000-01-01' }]));
  const expired = captureIo();
  assert.equal(main(['--check-quarantine', '--quarantine', file], expired), 1);
  assert.match(expired.out.join(''), /0 ativa\(s\), 1 vencida\(s\), 1 erro\(s\)/);
  assert.match(expired.out.join(''), /quarentena vencida em 2000-01-01/);
});

test('todayUtc formats the given date as YYYY-MM-DD in UTC', () => {
  assert.equal(todayUtc(new Date('2026-10-30T23:59:00Z')), '2026-10-30');
  assert.match(todayUtc(), /^\d{4}-\d{2}-\d{2}$/);
});

test('end to end: real node --test run finds a flaky test and honors the quarantine', () => {
  const dir = freshDir('e2e');
  const counter = path.join(dir, 'counter.txt');
  fs.writeFileSync(
    path.join(dir, 'flaky.test.cjs'),
    [
      "const test = require('node:test');",
      "const assert = require('node:assert/strict');",
      "const fs = require('node:fs');",
      `const counter = ${JSON.stringify(counter)};`,
      "test('flaky na primeira', () => {",
      '  const seen = fs.existsSync(counter);',
      "  fs.writeFileSync(counter, 'x');",
      '  assert.equal(seen, true);',
      '});',
      "test('sempre falha em quarentena', () => assert.fail('boom'));",
      "test('falha real', () => assert.fail('boom'));",
      '',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(dir, 'ok.test.cjs'), "require('node:test')('sempre passa', () => {});\n");
  const quarantine = path.join(dir, 'q.json');
  fs.writeFileSync(
    quarantine,
    JSON.stringify([
      { test: 'sempre falha em quarentena', reason: 'conhecido', expires: FUTURE },
      { test: 'antiga', reason: 'vencida', expires: '2000-01-01' },
    ]),
  );
  const jsonOut = path.join(dir, 'out', 'report.json');
  const io = captureIo();

  const code = main(['--dir', dir, '--runs', '2', '--json-out', jsonOut, '--quarantine', quarantine], {
    ...io,
    today: TODAY,
  });

  assert.equal(code, 0, io.err.join(''));
  const report = JSON.parse(fs.readFileSync(jsonOut, 'utf8'));
  assert.equal(report.runsExecuted, 2);
  assert.deepEqual(
    report.flaky.map((t) => t.name),
    ['flaky na primeira'],
  );
  assert.deepEqual(
    report.realFailures.map((t) => t.name),
    ['falha real'],
  );
  assert.deepEqual(
    report.quarantined.map((t) => t.name),
    ['sempre falha em quarentena'],
  );
  assert.equal(report.quarantineErrors.length, 1);
  assert.match(report.quarantineErrors[0], /vencida/);
  assert.match(io.out.join(''), /Testes flaky \(falharam e passaram entre rodadas\): 1/);
});
