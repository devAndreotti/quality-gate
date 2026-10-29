#!/usr/bin/env node
/**
 * pr-inline-suggest.cjs — achados como review comments inline no diff do PR (Fase 5).
 *
 * Entrada: JSON com array de achados {file, line, message, rule, fix?}.
 *   - `fix` (opcional) é o texto que substitui EXATAMENTE a linha `line`.
 *     Só deve vir para correções mecânicas, locais e seguras.
 * Regras:
 *   - só vira comentário inline achado cuja linha é ADICIONADA no diff base...HEAD;
 *   - o resto vai para o resumo (não é postado como comentário);
 *   - bloco ```suggestion só existe quando há `fix`;
 *   - cada corpo tem marcador oculto <!-- qg-inline:<rule>:<file>:<line> --> para dedupe;
 *   - default é --dry-run (só imprime); --post cria UMA review com event COMMENT.
 * Saída: exit 0 normal; 2 para entrada inválida; 1 para falha de runtime (git/gh).
 */
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { parseDiffLineNumbers } = require('./lib/diff-coverage.cjs');
const { resolveRepo } = require('./lib/github.cjs');

const EXIT_OK = 0;
const EXIT_RUNTIME = 1;
const EXIT_BAD_INPUT = 2;
const REVIEW_EVENT = 'COMMENT';

class InputError extends Error {}

function markerFor(finding) {
  return `<!-- qg-inline:${finding.rule}:${finding.file}:${finding.line} -->`;
}

function normalizeFile(file) {
  return String(file).replace(/\\/g, '/').replace(/^\.\//, '');
}

function validateFinding(item, index) {
  const where = `achado #${index}`;
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new InputError(`${where}: precisa ser objeto`);
  const { file, line, message, rule, fix } = item;
  if (typeof file !== 'string' || !file.trim()) throw new InputError(`${where}: campo "file" obrigatório`);
  const normalized = normalizeFile(file.trim());
  if (path.posix.isAbsolute(normalized) || normalized.split('/').includes('..') || /[\r\n]|-->/.test(normalized)) {
    throw new InputError(`${where}: "file" precisa ser caminho relativo sem ".." nem quebra de linha`);
  }
  if (!Number.isInteger(line) || line < 1) throw new InputError(`${where}: "line" precisa ser inteiro >= 1`);
  if (typeof message !== 'string' || !message.trim()) throw new InputError(`${where}: campo "message" obrigatório`);
  if (typeof rule !== 'string' || !/^[A-Za-z0-9_./-]+$/.test(rule)) {
    throw new InputError(`${where}: "rule" obrigatório (letras, números, _ . / -)`);
  }
  if (fix !== undefined && fix !== null) {
    if (typeof fix !== 'string') throw new InputError(`${where}: "fix" precisa ser string`);
    if (/[\r\n]/.test(fix)) throw new InputError(`${where}: "fix" precisa caber em uma linha`);
    if (fix.includes('```')) throw new InputError(`${where}: "fix" não pode conter cerca de código`);
  }
  return {
    file: normalized,
    line,
    message: message.trim(),
    rule,
    fix: typeof fix === 'string' ? fix : null,
  };
}

function parseFindings(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new InputError(`achados não são JSON válido: ${error.message}`);
  }
  if (!Array.isArray(data)) throw new InputError('achados precisam ser um array JSON');
  return data.map((item, index) => validateFinding(item, index));
}

function buildBody(finding, marker) {
  const lines = [marker, `**${finding.rule}**: ${finding.message}`];
  if (typeof finding.fix === 'string') lines.push('', '```suggestion', finding.fix, '```');
  return lines.join('\n');
}

// git diff com `\ No newline at end of file` quebra a contagem de parseDiffLineNumbers
// (a linha de marcação é contada como linha de contexto). Removemos antes de parsear.
function stripNoNewlineMarkers(diffText) {
  return String(diffText || '').split(/\r?\n/).filter((line) => !line.startsWith('\\')).join('\n');
}

function buildReviewItems({ findings, diffText }) {
  const addedLines = parseDiffLineNumbers(stripNoNewlineMarkers(diffText));
  const items = [];
  const summary = [];
  const seen = new Set();

  for (const finding of findings) {
    const marker = markerFor(finding);
    if (seen.has(marker)) continue;
    seen.add(marker);

    const added = addedLines.get(finding.file);
    if (added && added.has(finding.line)) {
      items.push({
        marker,
        comment: { path: finding.file, line: finding.line, side: 'RIGHT', body: buildBody(finding, marker) },
      });
    } else {
      summary.push({
        file: finding.file,
        line: finding.line,
        rule: finding.rule,
        message: finding.message,
        reason: 'linha fora do diff adicionado',
      });
    }
  }
  return { items, summary };
}

function filterExisting(items, existingText) {
  const existing = String(existingText || '');
  const skipped = [];
  const fresh = [];
  for (const item of items) {
    if (existing.includes(item.marker)) skipped.push(item.marker);
    else fresh.push(item);
  }
  return { fresh, skipped };
}

function buildReviewPayload(comments, summary) {
  const lines = [`Quality gate: ${comments.length} sugestão(ões) inline.`];
  if (summary.length > 0) {
    lines.push('', 'Achados fora do diff deste PR (sem comentário inline):');
    for (const item of summary) lines.push(`- \`${item.file}:${item.line}\` [${item.rule}] ${item.message}`);
  }
  return { event: REVIEW_EVENT, body: lines.join('\n'), comments };
}

function parseArgs(argv) {
  const args = { findings: null, base: 'origin/main', head: 'HEAD', repo: null, pr: null, post: false, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new InputError(`${arg} precisa de valor`);
      index += 1;
      return value;
    };
    if (arg === '--findings') args.findings = next();
    else if (arg === '--base') args.base = next();
    else if (arg === '--head') args.head = next();
    else if (arg === '--repo') args.repo = next();
    else if (arg === '--pr') {
      const value = next();
      if (!/^[1-9]\d*$/.test(value)) throw new InputError('--pr precisa ser número positivo');
      args.pr = Number(value);
    } else if (arg === '--post') args.post = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else throw new InputError(`argumento desconhecido: ${arg}`);
  }
  if (!args.findings) throw new InputError('--findings <arquivo.json> obrigatório');
  if (args.post && args.dryRun) throw new InputError('use --post ou --dry-run, não os dois');
  if (args.post && args.pr === null) throw new InputError('--post precisa de --pr');
  for (const ref of [args.base, args.head]) {
    if (!ref || ref.startsWith('-')) throw new InputError(`ref inválida: ${ref}`);
  }
  return args;
}

function readDiff({ base, head, cwd, execFileSync }) {
  try {
    return execFileSync('git', ['diff', '--unified=0', '--no-color', '--no-ext-diff', `${base}...${head}`], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(`não foi possível calcular o diff ${base}...${head}: ${error.message.split('\n')[0]}`);
  }
}

function defaultGh(args, input) {
  return childProcess.execFileSync('gh', args, {
    encoding: 'utf8',
    input,
    maxBuffer: 30 * 1024 * 1024,
  });
}

function main(argv = process.argv.slice(2), deps = {}) {
  const out = deps.out || ((text) => process.stdout.write(text));
  const err = deps.err || ((text) => process.stderr.write(text));
  const readFile = deps.readFile || ((file) => fs.readFileSync(file, 'utf8'));
  const execFileSync = deps.execFileSync || childProcess.execFileSync;
  const gh = deps.gh || defaultGh;
  const cwd = deps.cwd || process.cwd();

  try {
    const args = parseArgs(argv);

    let findingsText;
    try {
      findingsText = readFile(args.findings);
    } catch (error) {
      throw new InputError(`não foi possível ler achados: ${error.message}`);
    }
    const findings = parseFindings(findingsText);

    let repo = null;
    if (args.pr !== null) {
      try {
        repo = resolveRepo({ repo: args.repo, cwd, execFileSync });
      } catch (error) {
        throw new InputError(error.message);
      }
    }

    const diffText = readDiff({ base: args.base, head: args.head, cwd, execFileSync });
    const { items, summary } = buildReviewItems({ findings, diffText });

    let existingText = '';
    if (repo) {
      existingText = gh(['api', '--paginate', '--jq', '.[].body', `repos/${repo}/pulls/${args.pr}/comments`]);
    } else {
      err('pr-inline-suggest: sem --pr, dedupe contra comentários existentes não foi feito\n');
    }
    const { fresh, skipped } = filterExisting(items, existingText);
    const comments = fresh.map((item) => item.comment);

    const report = {
      mode: args.post ? 'post' : 'dry-run',
      repo,
      pr: args.pr,
      comments,
      skipped_existing: skipped,
      summary,
      posted: false,
    };

    if (args.post && comments.length > 0) {
      const payload = buildReviewPayload(comments, summary);
      gh(['api', '--method', 'POST', `repos/${repo}/pulls/${args.pr}/reviews`, '--input', '-'], JSON.stringify(payload));
      report.posted = true;
    }

    out(`${JSON.stringify(report, null, 2)}\n`);
    return EXIT_OK;
  } catch (error) {
    if (error instanceof InputError) {
      err(`pr-inline-suggest: entrada inválida: ${error.message}\n`);
      return EXIT_BAD_INPUT;
    }
    err(`pr-inline-suggest: ${error.message}\n`);
    return EXIT_RUNTIME;
  }
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  buildBody,
  buildReviewItems,
  buildReviewPayload,
  filterExisting,
  main,
  markerFor,
  parseArgs,
  parseFindings,
  stripNoNewlineMarkers,
};
