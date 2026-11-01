#!/usr/bin/env node
// Grava um snapshot de métricas (cobertura do baseline) no histórico. Uso:
//   node scripts/metrics-snapshot.cjs [--out <arquivo.jsonl>] [--summary]
// Padrão de saída: .quality-gate/metrics.jsonl (fora do git). Alertas entram quando o qg status estiver no main.

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { appendSnapshot, makeSnapshot, readSnapshots, series } = require('./lib/metrics-history.cjs');
const { renderTrendSvg } = require('./lib/svg-trend.cjs');

function readCoverage(root) {
  try {
    const json = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'baseline.json'), 'utf8'));
    const cov = json.coverage || (json.metrics && json.metrics.coverage);
    return cov && typeof cov.lines === 'number' ? cov.lines : null;
  } catch {
    return null;
  }
}

function readCommit(root) {
  try {
    return childProcess
      .execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      .trim();
  } catch {
    return 'desconhecido';
  }
}

function main(argv, deps = {}) {
  const root = deps.root || process.cwd();
  const outIdx = argv.indexOf('--out');
  const out = outIdx >= 0 ? argv[outIdx + 1] : path.join(root, '.quality-gate', 'metrics.jsonl');
  if (argv.includes('--svg')) {
    const file = argv[argv.indexOf('--svg') + 1];
    const svg = renderTrendSvg(series(readSnapshots(out), 'coverage'), { title: 'Cobertura de linhas' });
    fs.writeFileSync(file, svg, 'utf8');
    return { code: 0, out: `gráfico gravado: ${file}` };
  }
  if (argv.includes('--summary')) {
    const rows = series(readSnapshots(out), 'coverage');
    return {
      code: 0,
      out: rows.map((r) => `${r.date}  cobertura ${r.value}%`).join('\n') || 'sem snapshots',
    };
  }
  const commit = deps.commit ?? readCommit(root);
  const now = deps.now || new Date();
  const snap = makeSnapshot({ date: now.toISOString(), commit, coverage: readCoverage(root) });
  const { added } = appendSnapshot(out, snap);
  return {
    code: 0,
    out: `${added ? 'snapshot gravado' : 'já existe snapshot de hoje para este commit'}: ${out}`,
  };
}

module.exports = { main, readCoverage };

if (require.main === module) {
  const r = main(process.argv.slice(2));
  console.log(r.out);
  process.exitCode = r.code;
}
