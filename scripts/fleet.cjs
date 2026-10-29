#!/usr/bin/env node
// fleet.cjs — audita a frota de repositórios gerenciados pelo Quality Gate. Somente leitura.
//
// Uso:    node scripts/fleet.cjs [--catalog <arquivo>] [--json] [--strict]
// Catálogo padrão: .quality-gate/fleet.json (local, fora do git).
// Modelo versionado: scripts/fleet.example.json
//
// Formato do catálogo: { "repos": ["~/Projetos/a", { "path": "/abs/b", "name": "b" }] }
// Exit: 0 normal; 2 catálogo inválido ou ausente; 1 com --strict e algum repo com problema.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { auditRepo } = require('./lib/fleet-audit.cjs');

const DEFAULT_CATALOG = '.quality-gate/fleet.json';

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function parseCatalog(data) {
  const list = Array.isArray(data) ? data : data && data.repos;
  if (!Array.isArray(list)) throw new Error('catalogo deve ser uma lista ou { "repos": [...] }');
  return list.map((entry, i) => {
    const raw = typeof entry === 'string' ? entry : entry && entry.path;
    if (typeof raw !== 'string' || raw.trim() === '') throw new Error(`repos[${i}] sem "path"`);
    const resolved = path.resolve(expandHome(raw));
    const name = (entry && typeof entry === 'object' && entry.name) || path.basename(resolved);
    return { name, path: resolved };
  });
}

function loadCatalog(catalogPath) {
  if (!fs.existsSync(catalogPath)) {
    const err = new Error(
      `catalogo nao encontrado: ${catalogPath}. Copie scripts/fleet.example.json e ajuste os caminhos.`,
    );
    err.code = 'NO_CATALOG';
    throw err;
  }
  return parseCatalog(JSON.parse(fs.readFileSync(catalogPath, 'utf8')));
}

function auditFleet(repos, audit = auditRepo) {
  return repos.map((repo) => ({ name: repo.name, ...audit(repo.path) }));
}

function formatTable(rows) {
  const header = ['repo', 'policy', 'baseline', 'hooks', 'ci', 'saude'];
  const body = rows.map((r) => [r.name, r.policy, r.baseline, r.hooks, r.ci, r.status]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => row[i].length)));
  const fmt = (cols) =>
    cols
      .map((c, i) => c.padEnd(widths[i]))
      .join('  ')
      .trimEnd();
  const lines = [fmt(header), fmt(widths.map((w) => '-'.repeat(w)))];
  for (const row of body) lines.push(fmt(row));
  const problems = rows.filter((r) => r.issues.length > 0);
  if (problems.length) {
    lines.push('');
    for (const r of problems) {
      lines.push(`${r.name}:`);
      for (const issue of r.issues) lines.push(`  - ${issue}`);
    }
  }
  lines.push('', `${rows.length} repos, ${problems.length} com atencao.`);
  return lines.join('\n');
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = { catalog: DEFAULT_CATALOG, json: false, strict: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--catalog') args.catalog = argv[++i];
    else if (arg.startsWith('--catalog=')) args.catalog = arg.slice('--catalog='.length);
    else if (arg === '--json') args.json = true;
    else if (arg === '--strict') args.strict = true;
  }
  return args;
}

function main() {
  const args = parseArgs();
  let repos;
  try {
    repos = loadCatalog(path.resolve(args.catalog));
  } catch (err) {
    console.error(`fleet: ${err.message}`);
    process.exitCode = 2;
    return;
  }
  const rows = auditFleet(repos);
  if (args.json) console.log(JSON.stringify(rows, null, 2));
  else console.log(formatTable(rows));
  const hasProblems = rows.some((r) => r.issues.length > 0);
  process.exitCode = args.strict && hasProblems ? 1 : 0;
}

if (require.main === module) main();

module.exports = {
  DEFAULT_CATALOG,
  auditFleet,
  expandHome,
  formatTable,
  loadCatalog,
  parseArgs,
  parseCatalog,
};
