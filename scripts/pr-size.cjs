#!/usr/bin/env node
// pr-size.cjs — conta linhas alteradas (adicionadas + removidas) do PR.
//
// Uso (CI, em PR):  node scripts/pr-size.cjs --base <sha-ou-ref>
// Configuração:     .quality-gate/policy.json -> ci.prSize
//                   { enabled, maxChangedLines, blockOnFailure }
//
// Exit: 0 = skipped / dentro do limite / acima com blockOnFailure=false (advisory)
//       1 = acima do limite com blockOnFailure=true
//       2 = erro (base ausente, git falhou, config inválida). Falha fechada.

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_CONFIG = { enabled: false, maxChangedLines: 800, blockOnFailure: false };

// Padrões sem "/" casam o basename; com "/" casam o caminho inteiro.
const EXCLUDED_GLOBS = [
  'package-lock.json',
  '*.lock',
  'coverage/**',
  'dist/**',
  'build/**',
  '*.min.*',
  'docs/**/*.md',
  'scripts/*-tui.mjs',
  'scripts/dashboard-tui.mjs',
];

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') {
      re += '[^/]*';
    } else {
      re += c.replace(/[.+^${}()|[\]\\?]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

const EXCLUDED_MATCHERS = EXCLUDED_GLOBS.map((glob) => ({
  re: globToRegExp(glob),
  basenameOnly: !glob.includes('/'),
}));

function isExcluded(file) {
  const normalized = String(file).replace(/\\/g, '/');
  const basename = normalized.split('/').pop();
  return EXCLUDED_MATCHERS.some(({ re, basenameOnly }) => re.test(basenameOnly ? basename : normalized));
}

// Formato de `git diff --numstat -z --no-renames`: "added\tdeleted\tpath\0". Binários vêm como "-".
function parseNumstatZ(text) {
  return String(text || '')
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      const [added, deleted, ...rest] = record.split('\t');
      return {
        file: rest.join('\t'),
        added: added === '-' ? 0 : Number(added),
        deleted: deleted === '-' ? 0 : Number(deleted),
      };
    });
}

function evaluatePrSize({ entries, config }) {
  const counted = entries
    .filter((entry) => !isExcluded(entry.file))
    .map((entry) => ({ file: entry.file, changed: entry.added + entry.deleted }));
  const total = counted.reduce((sum, entry) => sum + entry.changed, 0);
  const top = [...counted].sort((a, b) => b.changed - a.changed || a.file.localeCompare(b.file)).slice(0, 5);
  return {
    total,
    limit: config.maxChangedLines,
    over: total > config.maxChangedLines,
    top,
    excludedCount: entries.length - counted.length,
  };
}

function readConfig(policyPath) {
  if (!fs.existsSync(policyPath)) return { ...DEFAULT_CONFIG };
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  return { ...DEFAULT_CONFIG, ...((policy.ci && policy.ci.prSize) || {}) };
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = { root: process.cwd(), base: process.env.BASE_SHA || null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--base') args.base = argv[++i];
    else if (arg.startsWith('--base=')) args.base = arg.slice('--base='.length);
    else if (arg === '--root') args.root = argv[++i];
    else if (arg === '--json') args.json = true;
  }
  return args;
}

function runPrSize(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const policyPath = options.policyPath || path.join(root, '.quality-gate', 'policy.json');

  let config;
  try {
    config = options.config || readConfig(policyPath);
  } catch (err) {
    return { status: 'error', exitCode: 2, reason: `policy.json invalido: ${err.message.split('\n')[0]}` };
  }

  if (!config.enabled) {
    return { status: 'skipped', exitCode: 0, reason: 'ci.prSize.enabled = false' };
  }
  if (!Number.isInteger(config.maxChangedLines) || config.maxChangedLines < 1) {
    return { status: 'error', exitCode: 2, reason: 'ci.prSize.maxChangedLines deve ser inteiro >= 1' };
  }
  if (!options.base) {
    return {
      status: 'error',
      exitCode: 2,
      reason: 'base ausente: passe --base ou defina BASE_SHA. Falha fechada.',
    };
  }

  let numstatText = options.numstatText;
  if (numstatText === undefined) {
    const exec = options.execFileSync || childProcess.execFileSync;
    try {
      numstatText = exec('git', ['diff', '--numstat', '--no-renames', '-z', `${options.base}...HEAD`], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (err) {
      return {
        status: 'error',
        exitCode: 2,
        reason: `git diff falhou contra ${options.base}: ${err.message.split('\n')[0]}. Em CI, use fetch-depth: 0.`,
      };
    }
  }

  const evaluation = evaluatePrSize({ entries: parseNumstatZ(numstatText), config });
  const blocking = config.blockOnFailure === true;
  const status = !evaluation.over ? 'passed' : blocking ? 'failed' : 'advisory';
  return { status, exitCode: status === 'failed' ? 1 : 0, blocking, base: options.base, ...evaluation };
}

function formatReport(result) {
  if (result.status === 'skipped') return `PR size: SKIPPED (${result.reason})`;
  if (result.status === 'error') return `PR size: ERROR — ${result.reason}`;
  const head = `PR size: ${result.status.toUpperCase()} — ${result.total} linhas alteradas (limite ${result.limit})`;
  if (!result.over) return head;
  const lines = [head, 'Maiores arquivos:'];
  for (const entry of result.top) lines.push(`  - ${entry.file}: ${entry.changed}`);
  if (result.status === 'advisory') lines.push('Modo advisory (blockOnFailure=false): não bloqueia o CI.');
  return lines.join('\n');
}

function main() {
  const args = parseArgs();
  const result = runPrSize(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(formatReport(result));
  process.exitCode = result.exitCode;
}

if (require.main === module) main();

module.exports = {
  DEFAULT_CONFIG,
  EXCLUDED_GLOBS,
  evaluatePrSize,
  formatReport,
  isExcluded,
  parseArgs,
  parseNumstatZ,
  readConfig,
  runPrSize,
};
