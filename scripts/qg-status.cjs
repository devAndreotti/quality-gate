#!/usr/bin/env node
// qg status — resumo do estado do repo: cobertura do ratchet, alertas de code scanning e Dependabot.
// Só leitura. Sem gh ou sem permissão, o item vira null (n/d) em vez de falhar.
// Uso: qg status [--json]. Exit: 0 normal; 2 se não houver remoto GitHub.

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { fetchCodeScanningAlerts, summarizeAlerts } = require('./lib/code-alerts.cjs');

function defaultExec(file, args) {
  return childProcess
    .execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    .trim();
}

function repoSlug(remoteUrl) {
  const match = String(remoteUrl || '')
    .trim()
    .match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  return match ? `${match[1]}/${match[2]}` : null;
}

function readRemote(root, exec) {
  try {
    return exec('git', ['-C', root, 'remote', 'get-url', 'origin']);
  } catch {
    return null;
  }
}

function readCoverage(root) {
  try {
    const json = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'baseline.json'), 'utf8'));
    const cov = json.coverage || (json.metrics && json.metrics.coverage);
    return cov && typeof cov.lines === 'number' ? { lines: cov.lines } : null;
  } catch {
    return null;
  }
}

function countDependabot(full, exec) {
  try {
    const out = exec('gh', [
      'api',
      '--paginate',
      `repos/${full}/dependabot/alerts?state=open&per_page=100`,
      '--jq',
      'length',
    ]);
    return out
      .split('\n')
      .filter(Boolean)
      .reduce((sum, n) => sum + Number(n), 0);
  } catch {
    return null;
  }
}

function buildStatus({ root, exec, remote }) {
  const coverage = readCoverage(root);
  const repo = repoSlug(remote);
  if (!repo)
    return {
      repo: null,
      coverage,
      codeScanning: null,
      dependabotOpen: null,
      error: 'remoto GitHub não encontrado',
    };
  return {
    repo,
    coverage,
    codeScanning: summarizeAlerts(fetchCodeScanningAlerts(repo, exec)),
    dependabotOpen: countDependabot(repo, exec),
  };
}

function render(status) {
  if (status.error) return `qg status: ${status.error}`;
  const cov = status.coverage ? `${Math.round(status.coverage.lines * 10) / 10}%` : 'n/d';
  const cs = status.codeScanning;
  const csText = cs
    ? `${cs.total} abertos (${
        Object.entries(cs.byTool)
          .map(([tool, g]) => `${tool}: ${g.total}`)
          .join(', ') || 'nenhum'
      })`
    : 'n/d';
  const dep = status.dependabotOpen === null ? 'n/d' : String(status.dependabotOpen);
  return [
    `repo: ${status.repo}`,
    `cobertura (linhas): ${cov}`,
    `code scanning: ${csText}`,
    `dependabot: ${dep} abertos`,
  ].join('\n');
}

function main(argv, deps = {}) {
  const root = deps.root || process.cwd();
  const exec = deps.exec || defaultExec;
  const remote = 'remote' in deps ? deps.remote : readRemote(root, exec);
  const status = buildStatus({ root, exec, remote });
  const out = argv.includes('--json') ? JSON.stringify(status, null, 2) : render(status);
  return { code: status.error ? 2 : 0, out };
}

module.exports = { buildStatus, main, render, repoSlug, readCoverage };

if (require.main === module) {
  const r = main(process.argv.slice(2));
  console.log(r.out);
  process.exitCode = r.code;
}
