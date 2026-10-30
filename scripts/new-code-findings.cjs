#!/usr/bin/env node
// new-code-findings.cjs — reporta só achados de lint nas linhas que o PR adicionou.
//
// Uso (CI, em PR):  node scripts/new-code-findings.cjs --base origin/main [--json] [--strict]
//
// Advisory por padrão: lista os achados novos e sai com 0.
// --strict: sai com 1 se houver achado novo.
// Erro de uso, de git ou do eslint: sai com 2. Falha do eslint nunca vira "zero achados".

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { parseAddedLines } = require('./lib/diff-coverage.cjs');

const DEFAULT_BASE = 'origin/main';
const JS_FILE_PATTERN = /\.(?:c|m)?js$/;
const EXCLUDED_PATH_PATTERN = /(?:^|\/)(?:node_modules|coverage|\.semgrep)\//;
const MAX_BUFFER = 64 * 1024 * 1024;

class UsageError extends Error {}

function parseArgs(argv) {
  const args = { base: DEFAULT_BASE, json: false, strict: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--base') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new UsageError('--base exige um ref (ex.: origin/main)');
      args.base = value;
    } else if (arg.startsWith('--base=')) {
      args.base = arg.slice('--base='.length);
      if (!args.base) throw new UsageError('--base= exige um ref (ex.: origin/main)');
    } else if (arg === '--json') {
      args.json = true;
    } else if (arg === '--strict') {
      args.strict = true;
    } else {
      throw new UsageError(`argumento desconhecido: ${arg}`);
    }
  }
  return args;
}

function selectJsFiles(names) {
  return names.filter((name) => JS_FILE_PATTERN.test(name) && !EXCLUDED_PATH_PATTERN.test(name));
}

function firstLine(text) {
  return (
    String(text || '')
      .split(/\r?\n/)
      .find((line) => line.trim()) || 'sem saída em stderr'
  );
}

function run(spawn, root, command, args) {
  const proc = spawn(command, args, { cwd: root, encoding: 'utf8', maxBuffer: MAX_BUFFER });
  if (proc.error) throw new Error(`${command} não pôde rodar: ${proc.error.message}`);
  return proc;
}

function gitOutput(spawn, root, args) {
  const proc = run(spawn, root, 'git', args);
  if (proc.status !== 0) {
    throw new Error(`git ${args.join(' ')} falhou: ${firstLine(proc.stderr)}. Em CI, use fetch-depth: 0.`);
  }
  return proc.stdout;
}

// Roda o eslint com saída JSON. Exit 1 do eslint significa "há achados" (não é erro);
// exit 2 (ou qualquer outro) é erro de execução/configuração e vira exceção.
function runEslint(spawn, root, files) {
  const proc = run(spawn, root, 'npx', ['--no-install', 'eslint', '-f', 'json', ...files]);
  if (proc.status !== 0 && proc.status !== 1) {
    throw new Error(`eslint falhou (exit ${proc.status}): ${firstLine(proc.stderr)}`);
  }
  let results;
  try {
    results = JSON.parse(proc.stdout);
  } catch {
    throw new Error(`eslint não produziu JSON: ${firstLine(proc.stderr)}`);
  }
  if (!Array.isArray(results)) throw new Error('eslint produziu JSON inesperado (esperado array)');
  return results;
}

function toRepoPath(filePath, root) {
  const relative = path.isAbsolute(filePath) ? path.relative(root, filePath) : filePath;
  return relative.replace(/\\/g, '/');
}

// Lógica pura: sem git e sem eslint. addedLinesByFile é o retorno de parseAddedLines
// (Map<arquivo, Map<linha, conteúdo>>). Mensagens sem linha (ex.: "File ignored" do eslint)
// não são achados: vão para notAnalyzedFiles, para ficarem visíveis no relatório.
function filterFindingsToAddedLines(eslintResults, addedLinesByFile, { root = process.cwd() } = {}) {
  const findings = [];
  const notAnalyzedFiles = [];
  let ignoredOld = 0;

  for (const result of eslintResults) {
    const file = toRepoPath(result.filePath, root);
    const addedLines = addedLinesByFile.get(file);
    for (const msg of result.messages || []) {
      if (typeof msg.line !== 'number') {
        notAnalyzedFiles.push(file);
      } else if (addedLines && addedLines.has(msg.line)) {
        findings.push({
          file,
          line: msg.line,
          column: msg.column,
          ruleId: msg.ruleId ?? null,
          message: msg.message,
        });
      } else {
        ignoredOld++;
      }
    }
  }

  return { findings, ignoredOld, notAnalyzedFiles };
}

function collectNewCodeFindings({ root = process.cwd(), base = DEFAULT_BASE, spawn = spawnSync } = {}) {
  const changed = gitOutput(spawn, root, ['diff', '--name-only', '--diff-filter=ACMR', `${base}...HEAD`]);
  const jsFiles = selectJsFiles(changed.split(/\r?\n/).filter(Boolean));
  if (jsFiles.length === 0) {
    return { base, analyzedFiles: [], findings: [], ignoredOld: 0, notAnalyzedFiles: [] };
  }

  const addedLines = parseAddedLines(gitOutput(spawn, root, ['diff', '--unified=0', `${base}...HEAD`]));
  const results = runEslint(spawn, root, jsFiles);
  return { base, analyzedFiles: jsFiles, ...filterFindingsToAddedLines(results, addedLines, { root }) };
}

function formatText(report, { base, strict }) {
  const lines = [`Achados novos (linhas adicionadas contra ${base}): ${report.findings.length}`];
  for (const f of report.findings) {
    lines.push(`  ${f.file}:${f.line}:${f.column} [${f.ruleId ?? 'fatal'}] ${f.message}`);
  }
  lines.push(`Achados antigos ignorados (fora das linhas novas): ${report.ignoredOld}`);
  lines.push(`Arquivos JS analisados: ${report.analyzedFiles.length}`);
  if (report.analyzedFiles.length === 0) lines.push('Nenhum arquivo JS/CJS/MJS alterado: nada a analisar.');
  for (const file of report.notAnalyzedFiles) {
    lines.push(`Não analisado (fora da config do ESLint): ${file}`);
  }
  if (report.findings.length > 0 && !strict) {
    lines.push('Modo advisory: não bloqueia o PR (use --strict para sair com 1).');
  }
  return lines.join('\n');
}

function runCli(argv, io = {}) {
  const {
    spawn = spawnSync,
    root = process.cwd(),
    stdout = (text) => console.log(text),
    stderr = (text) => console.error(text),
  } = io;

  try {
    const args = parseArgs(argv);
    const report = collectNewCodeFindings({ root, base: args.base, spawn });
    const exitCode = args.strict && report.findings.length > 0 ? 1 : 0;
    stdout(
      args.json
        ? JSON.stringify({ ...report, strict: args.strict, exitCode }, null, 2)
        : formatText(report, args),
    );
    return exitCode;
  } catch (err) {
    if (err instanceof UsageError) {
      stderr(`${err.message}\nUso: node scripts/new-code-findings.cjs [--base <ref>] [--json] [--strict]`);
    } else {
      stderr(`new-code-findings: ERRO — ${err.message}`);
    }
    return 2;
  }
}

if (require.main === module) process.exitCode = runCli(process.argv.slice(2));

module.exports = {
  collectNewCodeFindings,
  filterFindingsToAddedLines,
  formatText,
  parseArgs,
  runCli,
  runEslint,
  selectJsFiles,
  UsageError,
};
