#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_ROOT = path.resolve(__dirname, '..');

// A metric with zero total is unmeasured, not fully covered: report null so the gate fails.
function pct(covered, total) {
  if (!total) return null;
  return Number(((covered / total) * 100).toFixed(2));
}

function parseLcov(text) {
  const totals = {
    lines: { covered: 0, total: 0 },
    functions: { covered: 0, total: 0 },
    branches: { covered: 0, total: 0 },
  };

  for (const line of String(text || '').split(/\r?\n/)) {
    const match = /^(LH|LF|FNH|FNF|BRH|BRF):(\d+)$/.exec(line);
    if (!match) continue;
    const value = Number(match[2]);
    if (match[1] === 'LH') totals.lines.covered += value;
    if (match[1] === 'LF') totals.lines.total += value;
    if (match[1] === 'FNH') totals.functions.covered += value;
    if (match[1] === 'FNF') totals.functions.total += value;
    if (match[1] === 'BRH') totals.branches.covered += value;
    if (match[1] === 'BRF') totals.branches.total += value;
  }

  return totals;
}

function metricSummary(metric) {
  return {
    total: metric.total,
    covered: metric.covered,
    skipped: 0,
    pct: pct(metric.covered, metric.total),
  };
}

function lcovToCoverageSummary(lcovText) {
  const totals = parseLcov(lcovText);
  const lines = metricSummary(totals.lines);
  return {
    total: {
      lines,
      statements: { ...lines },
      functions: metricSummary(totals.functions),
      branches: metricSummary(totals.branches),
    },
  };
}

function parseLcovFiles(text, root = DEFAULT_ROOT) {
  const files = new Set();
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.startsWith('SF:')) continue;
    let file = line.slice(3).trim();
    if (path.isAbsolute(file)) file = path.relative(root, file);
    files.add(file.replace(/\\/g, '/'));
  }
  return files;
}

function listProductionFiles(root = DEFAULT_ROOT) {
  const scriptsRoot = path.join(root, 'scripts');
  if (!fs.existsSync(scriptsRoot)) return [];
  return fs
    .readdirSync(scriptsRoot)
    .filter((name) => /\.(cjs|js)$/.test(name) && !/\.test\./.test(name))
    .sort((left, right) => left.localeCompare(right))
    .map((name) => `scripts/${name}`);
}

function evaluateCoverage({ lcovText, root = DEFAULT_ROOT, summary = lcovToCoverageSummary(lcovText) }) {
  const failures = [];
  for (const metric of ['lines', 'statements', 'functions', 'branches']) {
    if (summary.total[metric].pct == null) {
      failures.push({ metric, reason: 'not measured (total is 0)' });
    }
  }

  const loaded = parseLcovFiles(lcovText, root);
  for (const file of listProductionFiles(root)) {
    if (!loaded.has(file)) {
      failures.push({ file, reason: 'not covered: no coverage record in lcov' });
    }
  }

  return { passed: failures.length === 0, failures };
}

function collectTestFiles(root = DEFAULT_ROOT) {
  const scriptsRoot = path.join(root, 'scripts');
  return fs
    .readdirSync(scriptsRoot)
    .filter((name) => name.endsWith('.test.cjs'))
    .sort((left, right) => left.localeCompare(right))
    .map((name) => path.join('scripts', name));
}

function writeCoverageSummary(root = DEFAULT_ROOT) {
  const coverageDir = path.join(root, 'coverage');
  const lcovPath = path.join(coverageDir, 'lcov.info');
  const summaryPath = path.join(coverageDir, 'coverage-summary.json');
  const summary = lcovToCoverageSummary(fs.readFileSync(lcovPath, 'utf8'));
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

function main() {
  const lcovText = fs.readFileSync(path.join(DEFAULT_ROOT, 'coverage', 'lcov.info'), 'utf8');
  const summary = writeCoverageSummary();
  console.log('coverage/coverage-summary.json atualizado');

  const evaluation = evaluateCoverage({ lcovText, root: DEFAULT_ROOT, summary });
  if (!evaluation.passed) {
    for (const failure of evaluation.failures) {
      const subject = failure.file ? `${failure.file}` : `metric ${failure.metric}`;
      console.error(`❌ ${subject}: ${failure.reason}`);
    }
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  collectTestFiles,
  evaluateCoverage,
  listProductionFiles,
  lcovToCoverageSummary,
  parseLcov,
  parseLcovFiles,
  writeCoverageSummary,
};
