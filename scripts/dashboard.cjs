#!/usr/bin/env node
/**
 * dashboard.cjs — painel de status ao vivo (padrao "radar"), local-only.
 *
 * Zero dependencia nova: so stdlib do Node + scripts ja existentes do pacote
 * (console-ui.cjs, quality-gate.js). Poll local (git/fs), nunca chama GitHub —
 * a secao de PR le o ultimo snapshot salvo em disco, nao dispara request nova
 * a cada refresh (evitaria rate limit e deixaria o loop lento).
 *
 * Copiado para projetos-alvo pelo qg-init como qualquer outro arquivo em
 * scripts/ (nao esta em $cleanScripts do QualityGate.ps1). E o fallback
 * garantido do dashboard: funciona em qualquer Node, com ou sem TTY. O modo
 * rico (ink/React) fica em scripts/dashboard-tui.mjs, quando presente e o
 * Node e >=22 -- ver Invoke-DashboardAction em QualityGate.ps1.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { renderHeaderBox, renderSection, padEnd } = require('./lib/console-ui.cjs');

const REFRESH_MS = 5000;

function sh(cmd, args, cwd) {
  try {
    return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function readJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function collectState(root) {
  const branch = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD'], root);
  const remote = sh('git', ['remote', 'get-url', 'origin'], root);
  const tokenEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN ? 'sim' : 'nao';

  let ratchet = null;
  const gateJsPath = path.join(root, 'scripts', 'quality-gate.js');
  if (fs.existsSync(gateJsPath)) {
    try {
      delete require.cache[require.resolve(gateJsPath)];
      const { runQualityGate } = require(gateJsPath);
      ratchet = runQualityGate({ root, command: 'check' });
    } catch (error) {
      ratchet = { error: error.message };
    }
  }

  const snapshotPath = path.join(root, '.quality-gate', 'reports', 'pr-snapshot.json');
  let snapshot = null;
  let snapshotAge = null;
  if (fs.existsSync(snapshotPath)) {
    snapshot = readJSON(snapshotPath);
    snapshotAge = fs.statSync(snapshotPath).mtime;
  }

  return { branch, remote, tokenEnv, ratchet, snapshot, snapshotAge, now: new Date() };
}

function formatAge(date) {
  if (!date) return null;
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s atras`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}min atras`;
  const hours = Math.round(minutes / 60);
  return `${hours}h atras`;
}

function render(root, state) {
  const lines = [];
  lines.push(renderHeaderBox('Quality Gate Dashboard', { icon: '◆', right: state.now.toLocaleTimeString() }));
  lines.push('');
  lines.push(renderSection('Estado', '◉'));
  lines.push(`    ${padEnd('Repo', 12)} ${root}`);
  lines.push(`    ${padEnd('Branch', 12)} ${state.branch || 'desconhecida'}`);
  lines.push(`    ${padEnd('Remoto', 12)} ${state.remote || 'nao configurado'}`);
  lines.push(`    ${padEnd('Token env', 12)} ${state.tokenEnv}`);
  lines.push('');

  lines.push(renderSection('Ratchet', '▤'));
  if (state.ratchet?.error) {
    lines.push(`    ⚠️  ${state.ratchet.error}`);
  } else if (state.ratchet) {
    for (const row of state.ratchet.rows || []) {
      const icon = row.passed ? '✅' : '❌';
      lines.push(`    ${icon} ${padEnd(`${row.group}/${row.metric}`, 22)} ${row.baseline} -> ${row.current} (${row.delta})`);
    }
    if (!state.ratchet.rows?.length) lines.push('    (sem metricas coletadas ainda)');
  } else {
    lines.push('    scripts/quality-gate.js nao encontrado neste projeto');
  }
  lines.push('');

  lines.push(renderSection('PR (ultimo snapshot local)', '◇'));
  if (state.snapshot) {
    const merge = state.snapshot.merge || {};
    const label = merge.status === 'ready' ? 'ready' : merge.status === 'ready_with_advisory' ? 'advisory' : 'blocked';
    lines.push(`    #${state.snapshot.pr?.number ?? '?'} ${state.snapshot.pr?.title ?? ''}`);
    lines.push(`    ${padEnd('Status', 12)} ${label}  (${formatAge(state.snapshotAge)})`);
    for (const blocker of merge.blockers || []) {
      lines.push(`    ⚠️  ${blocker.message}`);
    }
  } else {
    lines.push('    nenhum snapshot salvo ainda — rode "PR snapshot" no menu (qg)');
  }

  lines.push('');
  lines.push(`  atualizado ${state.now.toLocaleTimeString()} — a cada ${REFRESH_MS / 1000}s — [r] refresh agora  [q] sair`);
  return lines.join('\n');
}

function main() {
  const root = path.resolve(process.argv[2] || process.cwd());
  let stopped = false;

  const draw = () => {
    console.clear();
    console.log(render(root, collectState(root)));
  };

  draw();
  const timer = setInterval(draw, REFRESH_MS);

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    console.clear();
    process.exit(0);
  };

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (key) => {
      if (key === 'q' || key === '') stop();
      else if (key === 'r') draw();
    });
  } else {
    // sem TTY (ex: capturado por pipe/CI) -- roda um ciclo e sai, nao trava.
    stop();
  }

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (require.main === module) {
  main();
}

module.exports = { collectState, render, formatAge };
