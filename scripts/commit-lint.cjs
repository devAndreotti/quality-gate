#!/usr/bin/env node
/**
 * commit-lint.cjs — validador nativo de Conventional Commits.
 */
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

function parseArgs(argv = process.argv.slice(2)) {
  const args = { message: null, file: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--file' || arg === '-F') args.file = argv[++i];
    else if (arg.startsWith('--file=')) args.file = arg.slice('--file='.length);
    else if (arg === '--json') args.json = true;
    else if (!args.message && !arg.startsWith('-')) args.message = arg;
  }
  return args;
}

function main() {
  const args = parseArgs();
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
  validateCommitMessage,
};