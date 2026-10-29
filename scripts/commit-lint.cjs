#!/usr/bin/env node
/**
 * commit-lint.cjs — validador nativo de Conventional Commits.
 */
const childProcess = require('node:child_process');
const fs = require('node:fs');

const ALLOWED_TYPES = new Set([
  'feat',
  'fix',
  'docs',
  'style',
  'refactor',
  'perf',
  'test',
  'chore',
  'ci',
  'build',
  'revert',
]);

const COMMIT_PATTERN = /^([a-z]+)(?:\(([a-zA-Z0-9_\-\.\/]+)\))?(!)?:\s+(.+)$/;

function validateCommitMessage(message) {
  const firstLine = String(message || '').split(/\r?\n/)[0].trim();
  if (!firstLine) {
    return { valid: false, reason: 'mensagem de commit vazia', header: '' };
  }

  // Ignora commits de merge gerados automaticamente
  if (/^Merge (?:branch|pull request|remote-tracking branch)/i.test(firstLine)) {
    return { valid: true, type: 'merge', header: firstLine };
  }

  if (firstLine.length > 100) {
    return { valid: false, reason: `cabecalho excede 100 caracteres (${firstLine.length})`, header: firstLine };
  }

  const match = firstLine.match(COMMIT_PATTERN);
  if (!match) {
    return {
      valid: false,
      reason: 'formato invalido. Use: <type>(<scope>): <subject> (ex: feat(auth): add login)',
      header: firstLine,
    };
  }

  const [, type, scope, breaking, subject] = match;
  if (!ALLOWED_TYPES.has(type)) {
    return {
      valid: false,
      reason: `tipo "${type}" nao permitido. Tipos validos: ${Array.from(ALLOWED_TYPES).join(', ')}`,
      header: firstLine,
    };
  }

  if (subject.length < 3) {
    return { valid: false, reason: 'descricao muito curta (minimo 3 caracteres)', header: firstLine };
  }

  return {
    valid: true,
    type,
    scope: scope || null,
    breaking: Boolean(breaking),
    subject,
    header: firstLine,
  };
}

// Lista os commits do range (ex: "origin/main..HEAD") sem merges.
// Merges sao ignorados: o validador ja os aceita, e o merge sintetico
// refs/pull/N/merge do GitHub nao deve reprovar o PR.
function readRangeCommits(range, exec = childProcess.execFileSync) {
  const output = exec('git', ['log', '--no-merges', '--format=%H%x1e%B%x1f', range], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return output
    .split('\x1f')
    .map((record) => record.replace(/^\n/, ''))
    .filter((record) => record.trim())
    .map((record) => {
      const [sha, ...body] = record.split('\x1e');
      return { sha: sha.trim(), message: body.join('\x1e') };
    });
}

// Valida cada commit do range. Retorna { valid, results } onde results traz sha e resultado.
function validateRange(commits) {
  const results = commits.map((commit) => ({
    sha: commit.sha,
    ...validateCommitMessage(commit.message),
  }));
  return { valid: results.every((r) => r.valid), results };
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = { message: null, file: null, json: false, range: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--file' || arg === '-F') args.file = argv[++i];
    else if (arg.startsWith('--file=')) args.file = arg.slice('--file='.length);
    else if (arg === '--range') args.range = argv[++i];
    else if (arg.startsWith('--range=')) args.range = arg.slice('--range='.length);
    else if (arg === '--json') args.json = true;
    else if (!args.message && !arg.startsWith('-')) args.message = arg;
  }
  return args;
}

function runRange(range, exec) {
  const commits = readRangeCommits(range, exec);
  const summary = validateRange(commits);
  return { range, ...summary, total: commits.length, invalid: summary.results.filter((r) => !r.valid).length };
}

function main() {
  const args = parseArgs();

  if (args.range) {
    let summary;
    try {
      summary = runRange(args.range);
    } catch (err) {
      console.error(`❌ Nao foi possivel listar commits de ${args.range}: ${err.message.split('\n')[0]}`);
      process.exitCode = 2;
      return;
    }
    if (args.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      for (const r of summary.results) {
        if (r.valid) console.log(`✅ ${r.sha.slice(0, 8)} [${r.type}] ${r.header}`);
        else console.error(`❌ ${r.sha.slice(0, 8)} ${r.reason} | Recebido: "${r.header}"`);
      }
      console.log(`${summary.invalid === 0 ? '✅' : '❌'} ${summary.total - summary.invalid}/${summary.total} commits validos em ${args.range}`);
    }
    process.exitCode = summary.valid ? 0 : 1;
    return;
  }

  let message = args.message;
  if (args.file && fs.existsSync(args.file)) {
    message = fs.readFileSync(args.file, 'utf8');
  }

  const result = validateCommitMessage(message);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (result.valid) {
      console.log(`✅ Commit valido: [${result.type}] ${result.header}`);
    } else {
      console.error(`❌ Commit invalido: ${result.reason}`);
      console.error(`   Recebido: "${result.header}"`);
    }
  }
  process.exitCode = result.valid ? 0 : 1;
}

if (require.main === module) main();

module.exports = {
  ALLOWED_TYPES,
  COMMIT_PATTERN,
  parseArgs,
  readRangeCommits,
  runRange,
  validateCommitMessage,
  validateRange,
};