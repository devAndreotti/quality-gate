#!/usr/bin/env node
/**
 * flaky-detect.cjs — detecta testes flaky rodando a suíte N vezes no mesmo checkout.
 *
 * Uso:  node scripts/flaky-detect.cjs [--runs <1-10>] [--json-out <arquivo>] [--dir <pasta>]
 *                                     [--quarantine <arquivo>] [--check-quarantine]
 *
 * - Roda `node --test --test-reporter=tap` em `<dir>/*.test.cjs` (default: scripts), `--runs` vezes
 *   (default 3, máximo 10). Parse do TAP do node:test: cada linha `ok N - nome` ou
 *   `not ok N - nome` (subtestes vêm indentados) vira um resultado. `# SKIP` e `# TODO` viram skip.
 *   Nome repetido na mesma rodada: vale o pior resultado (fail > pass > skip).
 * - Flaky: falhou em alguma rodada e passou em outra. Falhou em todas as rodadas em que apareceu
 *   = falha real (não é flaky).
 * - Quarentena: `.quality-gate/flaky-quarantine.json`, lista de
 *   { "test": "<nome exato>", "reason": "...", "expires": "YYYY-MM-DD" }.
 *   Entrada válida e não vencida separa o teste no resumo ("em quarentena") e nunca conta como falha.
 *   Vencida = `expires` anterior a hoje (UTC). Entrada inválida ou vencida NÃO é aplicada, então a
 *   falha volta a aparecer, e é reportada como erro de validação.
 * - Advisory: sai 0 mesmo com flaky, falha ou erro de quarentena, exceto:
 *   2 = erro de uso ou nenhuma rodada conseguiu executar; 1 = quarentena inválida em --check-quarantine.
 */
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_RUNS = 3;
const MAX_RUNS = 10;
const DEFAULT_DIR = 'scripts';
const DEFAULT_QUARANTINE = path.join('.quality-gate', 'flaky-quarantine.json');
const TEST_TIMEOUT_MS = 120000;
const ROUND_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_BUFFER = 64 * 1024 * 1024;
const USAGE =
  'uso: node scripts/flaky-detect.cjs [--runs <1-10>] [--json-out <arquivo>] [--dir <pasta>] [--quarantine <arquivo>] [--check-quarantine]';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TAP_RESULT_RE = /^\s*(not ok|ok) \d+(?: - (.*))?$/;
const TAP_DIRECTIVE_RE = /\s#\s*(SKIP|TODO)\b/i;
const RANK = { skip: 0, pass: 1, fail: 2 };
const VALUE_FLAGS = {
  '--runs': 'runs',
  '--json-out': 'jsonOut',
  '--dir': 'dir',
  '--quarantine': 'quarantine',
};
const BOOL_FLAGS = { '--check-quarantine': 'checkQuarantine' };

class UsageError extends Error {}

function parseRuns(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_RUNS) {
    throw new UsageError(`--runs deve ser inteiro entre 1 e ${MAX_RUNS}`);
  }
  return n;
}

/** Aceita `--flag valor` e `--flag=valor`. */
function parseArgs(argv) {
  const args = {
    runs: DEFAULT_RUNS,
    jsonOut: null,
    dir: DEFAULT_DIR,
    quarantine: DEFAULT_QUARANTINE,
    checkQuarantine: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const eq = argv[i].indexOf('=');
    const flag = eq === -1 ? argv[i] : argv[i].slice(0, eq);
    if (BOOL_FLAGS[flag] && eq === -1) {
      args[BOOL_FLAGS[flag]] = true;
    } else if (VALUE_FLAGS[flag]) {
      const value = eq === -1 ? argv[++i] : argv[i].slice(eq + 1);
      if (!value || value.startsWith('--')) throw new UsageError(`${flag} exige um valor`);
      args[VALUE_FLAGS[flag]] = value;
    } else {
      throw new UsageError(`argumento desconhecido: ${argv[i]}`);
    }
  }
  args.runs = parseRuns(args.runs);
  return args;
}

function record(tests, name, status) {
  const prev = tests.get(name);
  if (prev === undefined || RANK[status] > RANK[prev]) tests.set(name, status);
}

/** Parse do TAP do node:test. `hasHeader` diz se a rodada chegou a produzir saída TAP. */
function parseTap(text) {
  const tests = new Map();
  let hasHeader = false;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (line.startsWith('TAP version')) {
      hasHeader = true;
      continue;
    }
    const match = TAP_RESULT_RE.exec(line);
    if (!match || !match[2]) continue;
    const directive = TAP_DIRECTIVE_RE.exec(match[2]);
    const name = directive ? match[2].slice(0, directive.index) : match[2];
    if (!name) continue;
    const status = directive ? 'skip' : match[1] === 'ok' ? 'pass' : 'fail';
    record(tests, name, status);
  }
  return { hasHeader, tests };
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isRealDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function todayUtc(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/** Valida a lista da quarentena. Retorna os testes aplicáveis (`active`), os vencidos e os erros. */
function validateQuarantine(data, today) {
  const active = new Map();
  const expired = [];
  const errors = [];
  if (!Array.isArray(data)) {
    return { active, expired, errors: ['o arquivo deve conter uma lista JSON'] };
  }
  data.forEach((item, index) => {
    const label = `entrada ${index + 1}`;
    if (!item || typeof item !== 'object') {
      errors.push(`${label}: deve ser um objeto`);
      return;
    }
    const problems = [];
    if (!isNonEmptyString(item.test)) problems.push('campo "test" obrigatório (texto)');
    if (!isNonEmptyString(item.reason)) problems.push('campo "reason" obrigatório (texto)');
    if (!isRealDate(item.expires)) problems.push('campo "expires" deve ser data YYYY-MM-DD válida');
    if (problems.length) {
      errors.push(...problems.map((problem) => `${label}: ${problem}`));
      return;
    }
    if (active.has(item.test) || expired.some((e) => e.test === item.test)) {
      errors.push(`${label}: teste duplicado "${item.test}"`);
      return;
    }
    const entry = { test: item.test, reason: item.reason, expires: item.expires };
    if (item.expires < today) {
      expired.push(entry);
      errors.push(`${label}: quarentena vencida em ${item.expires} ("${item.test}")`);
      return;
    }
    active.set(item.test, entry);
  });
  return { active, expired, errors };
}

/** Lê o arquivo de quarentena. Arquivo ausente = nenhuma quarentena, sem erro. */
function loadQuarantine(filePath, today) {
  if (!fs.existsSync(filePath)) {
    return { path: filePath, present: false, ...validateQuarantine([], today) };
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    const message = `JSON inválido: ${err.message.split('\n')[0]}`;
    return { path: filePath, present: true, active: new Map(), expired: [], errors: [message] };
  }
  return { path: filePath, present: true, ...validateQuarantine(data, today) };
}

function listTestFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith('.test.cjs'))
    .sort()
    .map((file) => path.join(dir, file));
}

/** Roda `node --test` com reporter TAP. Sem NODE_TEST_CONTEXT, senão o filho vira "child" do runner pai. */
function runNodeTests(files) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = childProcess.spawnSync(
    process.execPath,
    ['--test', `--test-timeout=${TEST_TIMEOUT_MS}`, '--test-reporter=tap', ...files],
    { encoding: 'utf8', maxBuffer: MAX_BUFFER, timeout: ROUND_TIMEOUT_MS, env },
  );
  return { stdout: result.stdout || '', error: result.error ? result.error.message : null };
}

/** Uma rodada. Executada = saiu saída TAP. Exit code não nulo com TAP é falha de teste, não de execução. */
function runRound(files, runner) {
  const output = runner(files);
  const parsed = parseTap(output.stdout);
  if (!parsed.hasHeader) {
    return { executed: false, tests: new Map(), error: output.error || 'node --test não produziu saída TAP' };
  }
  return { executed: true, tests: parsed.tests, error: output.error };
}

function classify(name, outcomes, quarantine) {
  if (quarantine.active.has(name)) return 'quarentena';
  const real = outcomes.filter((outcome) => outcome !== 'skip');
  if (real.length === 0) return 'skip';
  if (real.includes('pass') && real.includes('fail')) return 'flaky';
  return real.includes('fail') ? 'falha' : 'ok';
}

function runFlakyDetection({ runs, files, runner, quarantine }) {
  const rounds = [];
  for (let index = 1; index <= runs; index++) {
    rounds.push({ index, ...runRound(files, runner) });
  }
  const executed = rounds.filter((round) => round.executed);
  const names = new Set();
  for (const round of executed) for (const name of round.tests.keys()) names.add(name);

  const tests = [...names].sort().map((name) => {
    const outcomes = executed.filter((round) => round.tests.has(name)).map((round) => round.tests.get(name));
    return { name, outcomes, status: classify(name, outcomes, quarantine) };
  });
  const byStatus = (status) => tests.filter((test) => test.status === status);
  const quarantined = byStatus('quarentena').map((test) => ({
    ...test,
    reason: quarantine.active.get(test.name).reason,
    expires: quarantine.active.get(test.name).expires,
  }));

  return {
    schemaVersion: 1,
    runsRequested: runs,
    runsExecuted: executed.length,
    files,
    rounds: rounds.map((round) => ({
      index: round.index,
      executed: round.executed,
      error: round.error,
      testsObserved: round.tests.size,
    })),
    flaky: byStatus('flaky'),
    realFailures: byStatus('falha'),
    quarantined,
    missingFromRun: [...quarantine.active.keys()].filter((name) => !names.has(name)),
    quarantineErrors: quarantine.errors,
    tests,
  };
}

function formatTests(list) {
  if (!list.length) return ['  (nenhum)'];
  return list.map((test) => `  - ${test.name} [${test.outcomes.join(', ')}]`);
}

function formatSummary(report) {
  const lines = [
    `Detecção de flaky: ${report.runsExecuted} de ${report.runsRequested} rodada(s) executada(s); ${report.files.length} arquivo(s); ${report.tests.length} teste(s) observado(s).`,
    `Testes flaky (falharam e passaram entre rodadas): ${report.flaky.length}`,
    ...formatTests(report.flaky),
    `Falhas reais (falharam em todas as rodadas em que apareceram): ${report.realFailures.length}`,
    ...formatTests(report.realFailures),
    `Em quarentena (não contam como falha): ${report.quarantined.length}`,
    ...(report.quarantined.length
      ? report.quarantined.map(
          (test) =>
            `  - ${test.name} [${test.outcomes.join(', ')}] motivo: ${test.reason} (expira ${test.expires})`,
        )
      : ['  (nenhum)']),
  ];
  if (report.missingFromRun.length) {
    lines.push('Quarentena sem resultado nesta execução (teste ausente):');
    lines.push(...report.missingFromRun.map((name) => `  - ${name}`));
  }
  if (report.quarantineErrors.length) {
    lines.push(`Quarentena: ${report.quarantineErrors.length} erro(s) de validação (entradas ignoradas):`);
    lines.push(...report.quarantineErrors.map((error) => `  - ${error}`));
  }
  const failed = report.rounds.filter((round) => round.error);
  if (failed.length) {
    lines.push('Rodadas com erro:');
    lines.push(...failed.map((round) => `  - rodada ${round.index}: ${round.error}`));
  }
  lines.push('Modo advisory: este resultado não bloqueia o CI.');
  return lines.join('\n');
}

function checkQuarantineOnly(quarantine, out) {
  if (!quarantine.present) {
    out(`Quarentena: arquivo ausente (${quarantine.path}), nenhuma entrada.\n`);
    return 0;
  }
  out(
    `Quarentena: ${quarantine.active.size} ativa(s), ${quarantine.expired.length} vencida(s), ${quarantine.errors.length} erro(s).\n`,
  );
  for (const error of quarantine.errors) out(`  - ${error}\n`);
  return quarantine.errors.length ? 1 : 0;
}

function writeJson(filePath, report) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(report, null, 2)}\n`);
}

function main(argv = process.argv.slice(2), deps = {}) {
  const out = deps.stdout || ((text) => process.stdout.write(text));
  const errOut = deps.stderr || ((text) => process.stderr.write(text));
  try {
    const args = parseArgs(argv);
    const quarantine = loadQuarantine(args.quarantine, deps.today || todayUtc());
    if (args.checkQuarantine) return checkQuarantineOnly(quarantine, out);

    const files = listTestFiles(args.dir);
    if (!files.length) throw new UsageError(`nenhum *.test.cjs em ${args.dir}`);
    const report = runFlakyDetection({
      runs: args.runs,
      files,
      runner: deps.runner || runNodeTests,
      quarantine,
    });
    if (args.jsonOut) writeJson(args.jsonOut, report);
    if (report.runsExecuted === 0) {
      const reasons = report.rounds.map((round) => round.error).join('; ');
      errOut(`flaky-detect: nenhuma rodada conseguiu executar a suíte (${reasons})\n`);
      return 2;
    }
    out(`${formatSummary(report)}\n`);
    return 0;
  } catch (err) {
    if (err instanceof UsageError) {
      errOut(`${err.message}\n${USAGE}\n`);
      return 2;
    }
    errOut(`flaky-detect: erro: ${err.message}\n`);
    return 2;
  }
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
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
};
