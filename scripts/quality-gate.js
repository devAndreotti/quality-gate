#!/usr/bin/env node
/**
 * quality-gate.js — coverage/lint/file-size ratchet.
 */

const fs = require('node:fs');
const path = require('node:path');
const { renderTable } = require('./lib/console-ui.cjs');

function parseArgs(argv) {
  return {
    command: argv.find((arg) => !arg.startsWith('--')) || 'check',
    dryRun: argv.includes('--dry-run'),
    json: argv.includes('--json'),
  };
}

function paths(root) {
  return {
    baseline: path.join(root, 'scripts', 'baseline.json'),
    coverageSummary: path.join(root, 'coverage', 'coverage-summary.json'),
    coverageJson: path.join(root, 'coverage', 'coverage.json'),
    eslintReport: path.join(root, 'coverage', 'eslint-report.json'),
    ruffReport: path.join(root, 'coverage', 'ruff.json'),
    srcCandidates: [path.join(root, 'src'), path.join(root, 'pipeline', 'src')],
  };
}

function readJSON(filePath) {
  return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : null;
}

function readMaxFileLines(root) {
  const policy = readJSON(path.join(root, '.quality-gate', 'policy.json'));
  const value = policy?.ci?.maxFileLines;
  return Number.isInteger(value) && value > 0 ? value : 300;
}

function patternToRegExp(pattern) {
  const escaped = String(pattern)
    .replace(/\\/g, '/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '::DOUBLE_STAR::')
    .replace(/\*/g, '[^/]*')
    .replace(/::DOUBLE_STAR::/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function isPathAllowedByPattern(filePath, pattern) {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  return patternToRegExp(pattern).test(normalized);
}

function parseGitStatusPath(line) {
  return String(line || '').slice(3).trim().replace(/^"|"$/g, '');
}

function filterGitStatusEntries(lines, allowlist = []) {
  return (lines || []).filter((line) => {
    if (!String(line).startsWith('?? ')) return true;
    const filePath = parseGitStatusPath(line);
    return !allowlist.some((pattern) => isPathAllowedByPattern(filePath, pattern));
  });
}

function pct(value) {
  return typeof value === 'number' ? `${value.toFixed(1)}%` : 'n/a';
}

function count(value) {
  return typeof value === 'number' ? String(value) : 'n/a';
}

function delta(current, baseline, higherIsBetter = true) {
  if (baseline == null || current == null) return '-';
  const diff = current - baseline;
  if (Math.abs(diff) < 0.01) return 'igual';
  if (higherIsBetter) return diff > 0 ? `+${diff.toFixed(1)}` : diff.toFixed(1);
  return diff < 0 ? `-${Math.abs(diff).toFixed(1)}` : `+${diff.toFixed(1)}`;
}

function collectCoverage(root) {
  const projectPaths = paths(root);
  const summary = readJSON(projectPaths.coverageSummary);
  if (!summary?.total) return null;
  const total = summary.total;
  return {
    lines: total.lines.pct,
    statements: total.statements.pct,
    functions: total.functions.pct,
    branches: total.branches.pct,
  };
}

function collectPythonCoverage(root) {
  const coverage = readJSON(paths(root).coverageJson);
  const totals = coverage?.totals;
  if (!totals) return null;

  const linePct = Number(totals.percent_covered);
  if (!Number.isFinite(linePct)) return null;
  const branchPct = Number(totals.num_branches) > 0
    ? (Number(totals.covered_branches || 0) / Number(totals.num_branches)) * 100
    : null;
  return {
    lines: linePct,
    statements: null,
    functions: null,
    branches: branchPct == null ? null : Number(branchPct.toFixed(2)),
    // Métricas que esta fonte nunca mede: não são "não medidas", são não aplicáveis.
    unsupported: ['statements', 'functions'],
  };
}

function collectLintViolations(root) {
  const projectPaths = paths(root);
  const eslintReport = readJSON(projectPaths.eslintReport);
  if (eslintReport) {
    return eslintReport.reduce((sum, file) => sum + Number(file.errorCount || 0), 0);
  }
  const ruffReport = readJSON(projectPaths.ruffReport);
  if (Array.isArray(ruffReport)) return ruffReport.length;
  return null;
}

function collectFileSizes(root, maxFileLines = 300) {
  const srcDirs = paths(root).srcCandidates.filter((candidate) => fs.existsSync(candidate));
  if (srcDirs.length === 0) return null;
  let oversized = 0;
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx|js|jsx|py)$/.test(entry.name)) continue;
      if (fs.readFileSync(full, 'utf8').split(/\r?\n/).length > maxFileLines) oversized += 1;
    }
  }
  for (const srcDir of srcDirs) walk(srcDir);
  return oversized;
}

function collectAll(root) {
  const coverage = collectCoverage(root) || collectPythonCoverage(root);
  if (!coverage) {
    const missing = new Error('coverage nao encontrado. Rode node --test --experimental-test-coverage --test-reporter=lcov --test-reporter-destination=coverage/lcov.info scripts/*.test.cjs ou uv run pytest --cov=src --cov-report=json:../coverage/coverage.json');
    missing.code = 'COVERAGE_MISSING';
    throw missing;
  }
  return {
    coverage,
    lintErrors: collectLintViolations(root),
    oversizedFiles: collectFileSizes(root, readMaxFileLines(root)),
    collectedAt: new Date().toISOString(),
  };
}

function compareMetrics(current, baseline) {
  const failures = [];
  const rows = [];
  const notApplicable = new Set(current.coverage?.unsupported || []);
  for (const key of ['lines', 'statements', 'functions', 'branches']) {
    const cur = current.coverage?.[key] ?? null;
    const base = baseline.coverage?.[key] ?? null;
    if (notApplicable.has(key)) {
      rows.push({ group: 'Coverage', metric: key, baseline: pct(base), current: pct(cur), delta: '-', passed: true, status: 'pass' });
      continue;
    }
    // Baseline 0 ou ausente: null segue não aplicável. Baseline > 0 sem medição: falha.
    const passed = cur == null ? !(base > 0) : base == null || cur >= base - 0.01;
    if (!passed) {
      const failure = { group: 'coverage', metric: key, baseline: base, current: cur };
      if (cur == null) failure.message = `${key} não medido: baseline ${base}% exige medição, mas a métrica veio nula`;
      failures.push(failure);
    }
    rows.push({ group: 'Coverage', metric: key, baseline: pct(base), current: pct(cur), delta: delta(cur, base), passed, status: passed ? 'pass' : 'fail' });
  }

  if (current.lintErrors != null) {
    const cur = current.lintErrors;
    const base = baseline.lintErrors ?? null;
    if (base == null) {
      rows.push({ group: 'Lint', metric: 'errors', baseline: 'sem baseline', current: count(cur), delta: '-', passed: true, status: 'warn' });
    } else {
      const passed = cur <= base;
      if (!passed) failures.push({ group: 'lint', metric: 'errors', baseline: base, current: cur });
      rows.push({ group: 'Lint', metric: 'errors', baseline: count(base), current: count(cur), delta: delta(cur, base, false), passed, status: passed ? 'pass' : 'fail' });
    }
  }

  if (current.oversizedFiles != null) {
    const cur = current.oversizedFiles;
    const base = baseline.oversizedFiles ?? null;
    if (base == null) {
      rows.push({ group: 'Files', metric: 'oversized (>300 linhas)', baseline: 'sem baseline', current: count(cur), delta: '-', passed: true, status: 'warn' });
    } else {
      const passed = cur <= base;
      if (!passed) failures.push({ group: 'files', metric: 'oversized (>300 linhas)', baseline: base, current: cur });
      rows.push({ group: 'Files', metric: 'oversized (>300 linhas)', baseline: count(base), current: count(cur), delta: delta(cur, base, false), passed, status: passed ? 'pass' : 'fail' });
    }
  }

  return { rows, failures };
}

// Lint errors and oversized files may only go down: a regression is never accepted by update.
function ratchetDown(current, existing) {
  if (typeof current !== 'number') return existing;
  return typeof existing === 'number' ? Math.min(current, existing) : current;
}

function buildUpdatedBaseline({ current, existing, now = new Date().toISOString() }) {
  const coverage = {};
  for (const key of ['lines', 'statements', 'functions', 'branches']) {
    const cur = current.coverage?.[key];
    const base = existing.coverage?.[key];
    if (typeof cur === 'number') {
      coverage[key] = Math.max(cur, typeof base === 'number' ? base : 0);
    } else if (typeof base === 'number') {
      coverage[key] = base;
    }
  }

  return {
    ...existing,
    coverage,
    lintErrors: ratchetDown(current.lintErrors, existing.lintErrors),
    oversizedFiles: ratchetDown(current.oversizedFiles, existing.oversizedFiles),
    updatedAt: now,
  };
}

function writeBaseline(root, baseline) {
  const baselinePath = paths(root).baseline;
  fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
  fs.writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
}

function runQualityGate(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const command = options.command || 'check';
  const dryRun = Boolean(options.dryRun);
  const now = options.now || new Date().toISOString();
  const baselineFile = readJSON(paths(root).baseline);
  const existing = baselineFile || {};
  let current;
  try {
    current = collectAll(root);
  } catch (error) {
    // report é consulta: sem coverage ele avisa e sai 0. check continua falhando.
    if (command === 'report' && error.code === 'COVERAGE_MISSING') {
      return { status: 'warning', command, current: null, baseline: existing, rows: [], failures: [], warning: error.message };
    }
    throw error;
  }

  if (command === 'check' || command === 'report') {
    const compared = compareMetrics(current, existing);
    if (!baselineFile) {
      compared.failures.unshift({
        group: 'baseline',
        metric: 'baseline.json ausente',
        baseline: null,
        current: null,
        message: 'scripts/baseline.json nao encontrado. Rode "node scripts/quality-gate.js init" e commite o arquivo.',
      });
    }
    return {
      status: compared.failures.length > 0 ? 'failed' : 'passed',
      command,
      current,
      baseline: existing,
      ...compared,
    };
  }

  if (command === 'update' || command === 'init') {
    const updated = buildUpdatedBaseline({ current, existing, now });
    if (dryRun) {
      return { status: 'planned', command, current, baseline: existing, updated };
    }
    writeBaseline(root, updated);
    return { status: 'updated', command, current, baseline: existing, updated };
  }

  throw new Error(`Comando desconhecido: "${command}". Use: check | update | init | report`);
}

function toMetricsTableRows(rows) {
  const icons = { pass: '✅', warn: '⚠️', fail: '❌' };
  return rows.map((row) => [
    icons[row.status] || (row.passed ? '✅' : '❌'),
    row.group,
    row.metric,
    row.baseline,
    row.current,
    row.delta,
  ]);
}

function renderWorkflowAnnotations(failures = []) {
  if (!process.env.GITHUB_ACTIONS && !process.env.CI) return;
  for (const failure of failures) {
    const title = `Quality Gate: ${failure.group} - ${failure.metric}`;
    const message = `Regressao detectada: baseline ${failure.baseline} vs atual ${failure.current}`;
    console.log(`::error title=${title}::${message}`);
  }
}

function printReport(result) {
  console.log('\nQuality Gate — Ratchet\n');
  if ((result.rows || []).length > 0) {
    console.log(renderTable(['Status', 'Grupo', 'Métrica', 'Baseline', 'Atual', 'Delta'], toMetricsTableRows(result.rows)));
  }
  // check e report leem o mesmo compareMetrics; a unica diferenca real e o exit code
  // (main() abaixo). Essa linha final deixa isso visivel pra quem so olha o terminal.
  if (result.command === 'check') {
    if (result.status === 'failed') renderWorkflowAnnotations(result.failures);
    for (const failure of result.failures || []) {
      if (failure.message) console.log(`❌ ${failure.message}`);
    }
    console.log('');
    console.log(result.status === 'failed'
      ? `❌ GATE FALHOU — ${(result.failures || []).length} métrica(s) regrediram (exit 1)`
      : '✅ GATE PASSOU — nenhuma métrica regrediu');
  } else if (result.command === 'report') {
    if (result.warning) console.log(`⚠️  ${result.warning}`);
    console.log('');
    console.log('ℹ️  modo consulta — nunca falha o build (use "qg-chk" para o gate real de CI)');
  }
  if (result.updated) {
    console.log('');
    console.log(`${result.status === 'planned' ? '⚠️ ' : '✅'} baseline.json ${result.status}`);
    console.log(JSON.stringify(result.updated, null, 2));
  }
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  try {
    const result = runQualityGate({ command: args.command, dryRun: args.dryRun });
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else printReport(result);
    process.exitCode = result.status === 'failed' && args.command === 'check' ? 1 : 0;
  } catch (error) {
    console.error(`❌ quality-gate: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  renderWorkflowAnnotations,
  buildUpdatedBaseline,
  compareMetrics,
  filterGitStatusEntries,
  isPathAllowedByPattern,
  parseArgs,
  runQualityGate,
};
