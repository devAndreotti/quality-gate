#!/usr/bin/env node
// fleet-github.cjs — estado do Quality Gate em vários repos do GitHub. Somente leitura (via gh).
//
// Uso:  node scripts/fleet-github.cjs [--catalog <arquivo>] [--json] [--strict]
//                                     [--dashboard <arquivo.html>] [--history <arquivo.jsonl>]
// Catálogo padrão: .quality-gate/fleet-github.json (local, fora do git). Modelo: scripts/fleet-github.example.json
// Histórico padrão: $XDG_DATA_HOME/quality-gate/fleet-history.jsonl (fora do repo).
// Exit: 0 normal; 1 com --strict e algum repo em falha; 2 erro de uso ou de catálogo.

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_CATALOG = '.quality-gate/fleet-github.json';
const DEFAULT_IGNORE = ['Dependabot Updates'];
const FAILURES = new Set(['failure', 'timed_out', 'startup_failure', 'action_required']);

class UsageError extends Error {}

function defaultHistoryPath(env = process.env) {
  const base = env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'quality-gate', 'fleet-history.jsonl');
}

function parseCatalog(data) {
  const owner = data && typeof data.owner === 'string' ? data.owner.trim() : '';
  if (!owner) throw new Error('catálogo sem "owner"');
  if (!Array.isArray(data.repos)) throw new Error('catálogo sem lista "repos"');
  const repos = data.repos.map((item, i) => {
    const name = typeof item === 'string' ? item : item && item.name;
    if (typeof name !== 'string' || name.trim() === '') throw new Error(`repos[${i}] sem "name"`);
    const coverage =
      item && typeof item === 'object' && typeof item.coverage === 'string' ? item.coverage : null;
    return { name: name.trim(), coverage };
  });
  const ignore = Array.isArray(data.ignoreWorkflows) ? data.ignoreWorkflows : DEFAULT_IGNORE;
  return { owner, repos, ignore };
}

function loadCatalog(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    const error = new Error(
      `catálogo não encontrado: ${file}. Copie scripts/fleet-github.example.json para lá e ajuste.`,
    );
    error.code = 'NO_CATALOG';
    throw error;
  }
  return parseCatalog(JSON.parse(raw));
}

function gh(args, exec) {
  try {
    return exec('gh', args);
  } catch {
    return null;
  }
}

function parseJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function countAlerts(full, endpoint, exec) {
  const out = gh(
    ['api', '--paginate', `repos/${full}/${endpoint}?state=open&per_page=100`, '--jq', 'length'],
    exec,
  );
  if (out === null) return null;
  return out
    .split('\n')
    .filter(Boolean)
    .reduce((sum, n) => sum + Number(n), 0);
}

function readCoverage(full, branch, file, exec) {
  if (!file) return null;
  const content = gh(['api', `repos/${full}/contents/${file}?ref=${branch}`, '--jq', '.content'], exec);
  if (!content) return null;
  const json = parseJson(Buffer.from(content.replace(/\s/g, ''), 'base64').toString('utf8'), null);
  const cov = json && (json.coverage || (json.metrics && json.metrics.coverage));
  if (!cov || typeof cov.lines !== 'number') return null;
  return {
    lines: cov.lines,
    branches: typeof cov.branches === 'number' ? cov.branches : null,
    functions: typeof cov.functions === 'number' ? cov.functions : null,
  };
}

function collectRepo(owner, entry, ignore, exec, now) {
  const full = `${owner}/${entry.name}`;
  const ts = now.toISOString();
  const branch = gh(['api', `repos/${full}`, '--jq', '.default_branch'], exec);
  if (!branch) return { ts, repo: entry.name, error: 'inacessível ou sem permissão' };
  const gate =
    gh(['api', `repos/${full}/contents/.quality-gate/policy.json`, '--jq', '.name'], exec) !== null;
  const runs = parseJson(
    gh(
      [
        'run',
        'list',
        '--repo',
        full,
        '--branch',
        branch,
        '--limit',
        '40',
        '--json',
        'workflowName,conclusion,status,createdAt,headSha',
      ],
      exec,
    ) || '[]',
    [],
  );
  const latest = new Map();
  for (const run of runs)
    if (run.status === 'completed' && !latest.has(run.workflowName)) latest.set(run.workflowName, run);
  const workflows = [...latest.values()]
    .filter((run) => !ignore.includes(run.workflowName))
    .map((run) => ({
      name: run.workflowName,
      conclusion: run.conclusion,
      at: run.createdAt,
      sha: String(run.headSha || '').slice(0, 7),
    }));
  return {
    ts,
    repo: entry.name,
    branch,
    gate,
    workflows,
    coverage: readCoverage(full, branch, entry.coverage, exec),
    codeScanningOpen: countAlerts(full, 'code-scanning/alerts', exec),
    dependabotOpen: countAlerts(full, 'dependabot/alerts', exec),
  };
}

function statusOf(record) {
  if (record.error) return 'erro';
  if (!record.workflows || record.workflows.length === 0) return 'sem runs';
  if (record.workflows.some((w) => FAILURES.has(w.conclusion))) return 'falha';
  if (record.workflows.every((w) => w.conclusion === 'success' || w.conclusion === 'skipped')) return 'ok';
  return 'parcial';
}

function appendHistory(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function readHistory(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => parseJson(line, null))
    .filter(Boolean);
}

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function renderHtml(records, now) {
  const colors = {
    ok: '#16a34a',
    falha: '#dc2626',
    parcial: '#d97706',
    'sem runs': '#64748b',
    erro: '#7c3aed',
  };
  const rows = records
    .map((r) => {
      const st = statusOf(r);
      const cov = r.coverage ? `${Math.round(r.coverage.lines * 10) / 10}%` : 'n/d';
      const alerts =
        r.codeScanningOpen == null && r.dependabotOpen == null
          ? 'n/d'
          : `${r.codeScanningOpen ?? 'n/d'} / ${r.dependabotOpen ?? 'n/d'}`;
      const wfs =
        (r.workflows || []).map((w) => `${escapeHtml(w.name)}: ${escapeHtml(w.conclusion)}`).join('<br>') ||
        '—';
      return `<tr><td>${escapeHtml(r.repo)}</td><td><span class="st" style="background:${colors[st]}">${st}</span></td><td>${r.gate ? 'sim' : 'não'}</td><td>${cov}</td><td>${alerts}</td><td class="wf">${wfs}</td></tr>`;
    })
    .join('\n');
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Quality Gate · frota</title><style>
body{font:14px system-ui,sans-serif;margin:24px;color:#0f172a;background:#f8fafc}h1{font-size:20px}table{border-collapse:collapse;width:100%;background:#fff}th,td{padding:8px;border-bottom:1px solid #e2e8f0;text-align:left;vertical-align:top}th{color:#64748b;font-size:12px}.st{color:#fff;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:600}.wf{font-size:12px;color:#475569}
@media (prefers-color-scheme:dark){body{background:#0b1020;color:#e2e8f0}table{background:#131a2e}th,td{border-color:#243050}.wf{color:#94a3b8}}
</style></head><body><h1>Quality Gate · frota</h1><p>Atualizado ${escapeHtml(now.toISOString())}</p>
<div style="overflow-x:auto"><table><thead><tr><th>Repo</th><th>Situação</th><th>Gate</th><th>Cobertura</th><th>Alertas (CS / Dependabot)</th><th>Workflows</th></tr></thead><tbody>${rows}</tbody></table></div></body></html>`;
}

function parseArgs(argv) {
  const args = {
    catalog: DEFAULT_CATALOG,
    json: false,
    strict: false,
    dashboard: null,
    history: defaultHistoryPath(),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--strict') args.strict = true;
    else if (arg === '--catalog' || arg === '--dashboard' || arg === '--history') {
      const value = argv[++i];
      if (!value) throw new UsageError(`${arg} precisa de um valor`);
      args[arg.slice(2)] = value;
    } else throw new UsageError(`argumento desconhecido: ${arg}`);
  }
  return args;
}

function defaultExec(file, args) {
  return childProcess
    .execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    .trim();
}

function main(argv, deps = {}) {
  const exec = deps.exec || defaultExec;
  const now = deps.now || new Date();
  let args;
  let catalog;
  try {
    args = parseArgs(argv);
    catalog = loadCatalog(args.catalog);
  } catch (err) {
    const msg = err instanceof UsageError ? err.message : `erro: ${err.message}`;
    return { code: 2, out: msg };
  }
  const records = catalog.repos.map((entry) => collectRepo(catalog.owner, entry, catalog.ignore, exec, now));
  appendHistory(args.history, records);
  if (args.dashboard) fs.writeFileSync(args.dashboard, renderHtml(records, now), 'utf8');
  const failing = records.filter((r) => statusOf(r) === 'falha').length;
  const out = args.json
    ? JSON.stringify(
        records.map((r) => ({ ...r, status: statusOf(r) })),
        null,
        2,
      )
    : records.map((r) => `${statusOf(r).padEnd(9)} ${r.repo}${r.gate ? '' : '  (sem gate)'}`).join('\n') +
      `\n${records.length} repos, ${failing} em falha. Histórico: ${args.history}`;
  return { code: args.strict && failing > 0 ? 1 : 0, out };
}

module.exports = {
  collectRepo,
  countAlerts,
  defaultHistoryPath,
  loadCatalog,
  main,
  parseArgs,
  parseCatalog,
  readCoverage,
  readHistory,
  renderHtml,
  statusOf,
  appendHistory,
};

if (require.main === module) {
  const r = main(process.argv.slice(2));
  console.log(r.out);
  process.exitCode = r.code;
}
