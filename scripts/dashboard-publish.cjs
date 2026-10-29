#!/usr/bin/env node
/**
 * dashboard-publish.cjs — gera o painel do quality gate como HTML estático.
 *
 * scripts/dashboard.cjs não tem modo --json nem de exportação; só renderiza no
 * terminal em loop. Por isso este script usa o mesmo coletor (collectState
 * exportado por dashboard.cjs) e escreve um HTML autocontido em
 * `dashboard/index.html`. Caminhos absolutos da máquina são removidos do
 * conteúdo antes de gravar, para o artefato poder ser publicado.
 *
 * Uso: node scripts/dashboard-publish.cjs [--root <repo>] [--out <arquivo.html>]
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectState } = require('./dashboard.cjs');

const DEFAULT_ROOT = path.resolve(__dirname, '..');

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Remove caminhos absolutos da máquina: raiz do repo, home do usuário e
// padrões comuns de Linux/macOS/Windows que aparecem em mensagens de erro.
function scrubPaths(text, root) {
  let out = String(text ?? '');
  const replacements = [
    [root, '<repo>'],
    [os.homedir(), '~'],
  ].filter(([from]) => from && from.length > 1);
  for (const [from, to] of replacements) {
    out = out.replace(new RegExp(escapeRegExp(from), 'g'), to);
  }
  return out
    .replace(/\/(?:home|Users|root|tmp|var|opt|mnt)\/[^\s'"`<>)]*/g, '<caminho>')
    .replace(/[A-Za-z]:\\[^\s'"`<>)]*/g, '<caminho>');
}

function renderRatchet(ratchet, root) {
  if (!ratchet) return '<p class="muted">scripts/quality-gate.js não encontrado neste projeto.</p>';
  if (ratchet.error) return `<p class="warn">${escapeHtml(scrubPaths(ratchet.error, root))}</p>`;
  const rows = ratchet.rows || [];
  if (!rows.length) return '<p class="muted">Sem métricas coletadas ainda.</p>';
  const body = rows
    .map((row) => {
      const cls = row.passed ? 'ok' : 'fail';
      const label = row.passed ? 'passou' : 'falhou';
      return `<tr class="${cls}"><td>${escapeHtml(`${row.group}/${row.metric}`)}</td>` +
        `<td>${escapeHtml(row.baseline)}</td><td>${escapeHtml(row.current)}</td>` +
        `<td>${escapeHtml(row.delta)}</td><td>${label}</td></tr>`;
    })
    .join('\n');
  return '<table><thead><tr><th>Métrica</th><th>Baseline</th><th>Atual</th><th>Delta</th><th>Situação</th></tr></thead>' +
    `<tbody>\n${body}\n</tbody></table>`;
}

function renderSnapshot(snapshot, root) {
  if (!snapshot) return '<p class="muted">Nenhum snapshot de PR salvo.</p>';
  const merge = snapshot.merge || {};
  const status = merge.status === 'ready' ? 'pronto' : merge.status === 'ready_with_advisory' ? 'com avisos' : 'bloqueado';
  const blockers = (merge.blockers || [])
    .map((b) => `<li>${escapeHtml(scrubPaths(b.message, root))}</li>`)
    .join('');
  return `<p>#${escapeHtml(snapshot.pr?.number ?? '?')} ${escapeHtml(scrubPaths(snapshot.pr?.title ?? '', root))}</p>` +
    `<p>Situação para merge: <strong>${status}</strong></p>` +
    (blockers ? `<ul>${blockers}</ul>` : '');
}

function buildHtml(state, root) {
  const generatedAt = state.now instanceof Date ? state.now.toISOString() : new Date().toISOString();
  const repoName = path.basename(root);
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Quality Gate Dashboard</title>
<style>
  :root { color-scheme: light dark; --fg: #1d1f23; --bg: #ffffff; --muted: #6b7280; --ok: #15803d; --fail: #b91c1c; --warn: #b45309; }
  @media (prefers-color-scheme: dark) { :root { --fg: #e5e7eb; --bg: #111418; --muted: #9ca3af; } }
  body { margin: 0; padding: 16px; font: 15px/1.5 system-ui, sans-serif; color: var(--fg); background: var(--bg); }
  h1 { font-size: 1.4em; margin: 0 0 4px; }
  h2 { font-size: 1.1em; border-bottom: 1px solid var(--muted); padding-bottom: 4px; margin-top: 24px; }
  table { border-collapse: collapse; width: 100%; overflow-x: auto; display: block; }
  th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid #8884; }
  tr.ok td:last-child { color: var(--ok); }
  tr.fail td:last-child { color: var(--fail); }
  .muted { color: var(--muted); }
  .warn { color: var(--warn); }
</style>
</head>
<body>
<h1>Quality Gate Dashboard</h1>
<p class="muted">Repositório ${escapeHtml(repoName)} · gerado em ${escapeHtml(generatedAt)}</p>

<h2>Estado</h2>
<ul>
  <li>Branch: ${escapeHtml(state.branch || 'desconhecida')}</li>
  <li>Token de API: ${escapeHtml(state.tokenEnv)}</li>
</ul>

<h2>Ratchet</h2>
${renderRatchet(state.ratchet, root)}

<h2>PR (último snapshot local)</h2>
${renderSnapshot(state.snapshot, root)}
</body>
</html>
`;
}

function parseArgs(argv) {
  const opts = { root: DEFAULT_ROOT, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') opts.root = path.resolve(argv[++i] || '');
    else if (arg === '--out') opts.out = path.resolve(argv[++i] || '');
    else throw new Error(`argumento desconhecido: ${arg}`);
  }
  opts.out = opts.out || path.join(opts.root, 'dashboard', 'index.html');
  return opts;
}

function publishDashboard({ root = DEFAULT_ROOT, out } = {}) {
  const resolvedRoot = path.resolve(root);
  const target = out ? path.resolve(out) : path.join(resolvedRoot, 'dashboard', 'index.html');
  const state = collectState(resolvedRoot);
  const html = buildHtml(state, resolvedRoot);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, html, 'utf8');
  return target;
}

if (require.main === module) {
  try {
    const written = publishDashboard(parseArgs(process.argv.slice(2)));
    console.log(`Dashboard gerado: ${path.relative(process.cwd(), written) || written}`);
  } catch (error) {
    console.error(`dashboard-publish: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { buildHtml, publishDashboard, scrubPaths };
