#!/usr/bin/env node
/**
 * lockfile-new-deps.cjs — lista dependências novas ou com versão alterada no package-lock.json.
 *
 * Uso:  node scripts/lockfile-new-deps.cjs [--base <ref>] [--json] [--max-age-days <n>]
 *                                          [--check-age] [--strict]
 *
 * - Compara o package-lock.json do diretório atual com `git show <base>:package-lock.json`
 *   (default origin/main).
 * - Modo advisory (padrão): exit 0 mesmo com achados.
 * - --check-age: consulta `npm view <nome>@<versão> time --json` para saber quando a versão foi
 *   publicada. Se a consulta falhar, o item sai como "idade não verificada" com o motivo.
 * - --strict: implica --check-age e sai com 1 se alguma dependência nova/alterada for mais nova que
 *   --max-age-days. Idade não verificada não reprova (aparece no relatório).
 * - Códigos de saída: 0 ok, 1 achado em --strict, 2 erro de uso ou de leitura.
 */
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BASE = 'origin/main';
const DEFAULT_MAX_AGE_DAYS = 7;
const LOCKFILE = 'package-lock.json';
const NPM_TIMEOUT_MS = 30000;
const USAGE =
  'uso: node scripts/lockfile-new-deps.cjs [--base <ref>] [--json] [--max-age-days <n>] [--check-age] [--strict]';

class UsageError extends Error {}

function packageName(key) {
  const marker = 'node_modules/';
  const index = key.lastIndexOf(marker);
  return index === -1 ? key : key.slice(index + marker.length);
}

/** Mapa chave-do-lockfile -> { id, name, version, dev }; ignora a raiz e entradas sem versão. */
function collectPackages(lockJson) {
  const packages = new Map();
  for (const [key, entry] of Object.entries((lockJson && lockJson.packages) || {})) {
    if (key === '' || !entry || !entry.version) continue;
    const name = packageName(key);
    packages.set(key, {
      id: `${name}@${entry.version}`,
      name,
      version: entry.version,
      dev: entry.dev === true,
    });
  }
  return packages;
}

function sortById(items) {
  return items.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Função pura: compara dois objetos de package-lock (v2/v3) e devolve pacotes adicionados,
 * alterados (versão anterior em `from`) e removidos. Sem rede e sem git.
 */
function diffLockfiles(baseJson, headJson) {
  const base = collectPackages(baseJson);
  const head = collectPackages(headJson);
  const added = [];
  const changed = [];
  const removed = [];
  for (const [key, item] of head) {
    const before = base.get(key);
    if (!before) added.push(item);
    else if (before.version !== item.version) changed.push({ ...item, from: before.version });
  }
  for (const [key, item] of base) {
    if (!head.has(key)) removed.push(item);
  }
  return { added: sortById(added), changed: sortById(changed), removed: sortById(removed) };
}

/**
 * Anota a idade de publicação de cada item adicionado/alterado.
 * fetchPublishedAt(name, version) devolve a data de publicação (string/Date) ou null.
 * Qualquer falha vira status "unverified" com o motivo.
 */
async function annotateAges(items, { fetchPublishedAt, now, maxAgeDays }) {
  for (const item of items) {
    try {
      const published = await fetchPublishedAt(item.name, item.version);
      const time = published ? new Date(published).getTime() : Number.NaN;
      if (Number.isNaN(time)) {
        item.age = { status: 'unverified', reason: 'data de publicação indisponível' };
        continue;
      }
      const ageDays = (now - time) / DAY_MS;
      item.age = {
        status: 'verified',
        publishedAt: new Date(time).toISOString(),
        ageDays: Math.round(ageDays * 10) / 10,
        tooNew: ageDays < maxAgeDays,
      };
    } catch (err) {
      item.age = {
        status: 'unverified',
        reason: String(err instanceof Error ? err.message : err).split('\n')[0],
      };
    }
  }
  return items;
}

/** Consulta a data de publicação exata de uma versão via `npm view`. Pode lançar erro. */
function npmViewFetcher(name, version, exec = childProcess.execFileSync) {
  const out = exec('npm', ['view', `${name}@${version}`, 'time', '--json'], {
    encoding: 'utf8',
    timeout: NPM_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // `npm view <pkg>@<versão> time --json` devolve um array com o objeto de tempos do pacote.
  const parsed = JSON.parse(out);
  const times = Array.isArray(parsed) ? parsed : [parsed];
  const hit = times.find((time) => time && typeof time === 'object' && time[version]);
  return hit ? hit[version] : null;
}

function readBaseLockfile(base, exec = childProcess.execFileSync) {
  let text;
  try {
    text = exec('git', ['show', `${base}:${LOCKFILE}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const reason = String(err instanceof Error ? err.message : err).split('\n')[0];
    throw new Error(`não foi possível ler ${LOCKFILE} em ${base}: ${reason}`, { cause: err });
  }
  return JSON.parse(text);
}

function readHeadLockfile(dir = process.cwd()) {
  return JSON.parse(fs.readFileSync(path.join(dir, LOCKFILE), 'utf8'));
}

function parseArgs(argv) {
  const options = {
    base: DEFAULT_BASE,
    json: false,
    maxAgeDays: DEFAULT_MAX_AGE_DAYS,
    checkAge: false,
    strict: false,
  };
  const takeValue = (flag, index) => {
    if (index + 1 >= argv.length) throw new UsageError(`${flag} exige um valor`);
    return argv[index + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--base') {
      options.base = takeValue(arg, i);
      i++;
    } else if (arg === '--max-age-days') {
      const value = Number(takeValue(arg, i));
      if (!Number.isFinite(value) || value <= 0) throw new UsageError('--max-age-days exige número positivo');
      options.maxAgeDays = value;
      i++;
    } else if (arg === '--json') options.json = true;
    else if (arg === '--check-age') options.checkAge = true;
    else if (arg === '--strict') options.strict = true;
    else throw new UsageError(`argumento desconhecido: ${arg}`);
  }
  if (options.strict) options.checkAge = true;
  return options;
}

function describeItem(item) {
  const scope = item.dev ? 'dev' : 'prod';
  const from = item.from ? ` (era ${item.from})` : '';
  let age = '';
  if (item.age && item.age.status === 'verified') {
    const tooNew = item.age.tooNew ? ' <- mais nova que o limite' : '';
    age = ` idade ${item.age.ageDays} dias${tooNew}`;
  } else if (item.age) {
    age = ` idade não verificada (${item.age.reason})`;
  }
  return `${item.id} [${scope}]${from}${age}`;
}

function formatReport(result) {
  const lines = [`Dependências no ${LOCKFILE} comparado com ${result.base}`];
  const section = (title, sign, items, render) => {
    lines.push(`${title}: ${items.length}`);
    for (const item of items) lines.push(`  ${sign} ${render(item)}`);
  };
  section('Adicionadas', '+', result.added, describeItem);
  section('Alteradas', '~', result.changed, describeItem);
  section('Removidas', '-', result.removed, (item) => item.id);
  if (result.checkAge) {
    lines.push(`Achados (mais novas que ${result.maxAgeDays} dias): ${result.findings.length}`);
    const unverified = result.changedOrAdded.filter((item) => item.age && item.age.status === 'unverified');
    if (unverified.length) lines.push(`Idade não verificada: ${unverified.length}`);
  } else {
    lines.push('Idade não consultada (use --check-age para consultar o npm)');
  }
  return lines.join('\n');
}

const DEFAULT_IO = {
  readHead: readHeadLockfile,
  readBase: readBaseLockfile,
  fetchPublishedAt: npmViewFetcher,
  now: Date.now,
};

/**
 * Executa a análise. `io` injeta leitura do base/head, fetcher de idade e relógio.
 * Devolve { code, options, result } e não chama process.exit.
 */
async function run(argv, io = {}) {
  const options = parseArgs(argv);
  const { readHead, readBase, fetchPublishedAt, now } = { ...DEFAULT_IO, ...io };

  const headJson = readHead();
  const baseJson = readBase(options.base);
  const diff = diffLockfiles(baseJson, headJson);
  const changedOrAdded = [...diff.added, ...diff.changed];
  if (options.checkAge) {
    await annotateAges(changedOrAdded, { fetchPublishedAt, now: now(), maxAgeDays: options.maxAgeDays });
  }
  const findings = changedOrAdded.filter(
    (item) => item.age && item.age.status === 'verified' && item.age.tooNew,
  );
  const result = {
    base: options.base,
    maxAgeDays: options.maxAgeDays,
    checkAge: options.checkAge,
    strict: options.strict,
    ...diff,
    changedOrAdded,
    findings: findings.map((item) => item.id),
  };
  const code = options.strict && findings.length > 0 ? 1 : 0;
  return { code, options, result };
}

const DEFAULT_OUTPUT = {
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
};

/** Ponto de entrada da CLI. Devolve o código de saída. */
async function main(argv = process.argv.slice(2), io = {}) {
  const { stdout, stderr } = { ...DEFAULT_OUTPUT, ...io };
  try {
    const { code, options, result } = await run(argv, io);
    stdout(options.json ? JSON.stringify(result, null, 2) : formatReport(result));
    return code;
  } catch (error) {
    stderr(`lockfile-new-deps: ${error.message}`);
    if (error instanceof UsageError) stderr(USAGE);
    return 2;
  }
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  });
}

module.exports = {
  annotateAges,
  describeItem,
  diffLockfiles,
  formatReport,
  main,
  npmViewFetcher,
  parseArgs,
  readBaseLockfile,
  readHeadLockfile,
  run,
};
