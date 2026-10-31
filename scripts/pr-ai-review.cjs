#!/usr/bin/env node
/**
 * pr-ai-review.cjs — revisão de PR com modelo local (opcional, advisory).
 *
 * Lê o diff base...HEAD, pede achados ao modelo local (Ollama ou 9Router) e descarta
 * tudo que não aponta para uma linha ADICIONADA de um arquivo enviado ao modelo.
 * Os achados válidos viram review comments inline pelo mesmo mecanismo do
 * pr-inline-suggest.cjs (buildReviewItems / filterExisting).
 *
 * Privacidade: só provedores locais (QG_9ROUTER_URL, QG_OLLAMA_URL). Nada sai para
 * serviço externo.
 * Padrão: dry-run (imprime o que postaria, não fala com o GitHub).
 * --post exige --pr, a variável GITHUB_TOKEN e o flag explícito.
 * Sem modelo ou provedor configurado: status "skipped" com motivo, exit 0.
 * Exit: 0 ok/skipped; 1 erro de runtime (git, provedor, JSON invalido); 2 uso ou config invalidos.
 */
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const localAi = require('./lib/local-ai-client.cjs');
const { AiConfigError } = localAi;
const { parseDiffLineNumbers } = require('./lib/diff-coverage.cjs');
const { resolveRepo } = require('./lib/github.cjs');
const { buildReviewItems, filterExisting, stripNoNewlineMarkers } = require('./pr-inline-suggest.cjs');

const EXIT_OK = 0;
const EXIT_RUNTIME = 1;
const EXIT_BAD_INPUT = 2;
const DEFAULT_BASE = 'origin/main';
const DEFAULT_MAX_CHARS = 60000;
const PROMPT_PATH = path.join(__dirname, 'prompts', 'pr-review.md');
const RULE = 'ai-review';
const SEVERITIES = ['low', 'medium', 'high'];
const REVIEW_BODY =
  'Revisão com IA (advisory, modelo local). Pode conter falso positivo; não bloqueia merge.';
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const GH_MAX_BUFFER = 30 * 1024 * 1024;

// Lockfiles, artefatos gerados e binários não entram na revisão.
const IGNORED_FILE_PATTERNS = [
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|Gemfile\.lock|composer\.lock)$/,
  /\.lock$/,
  /\.min\.(js|css)$/,
  /\.map$/,
  /(^|\/)(dist|build|coverage|node_modules|vendor|generated|__generated__)\//,
  /\.(png|jpe?g|gif|webp|ico|pdf|woff2?|ttf)$/i,
];

class InputError extends Error {}

function isIgnoredFile(file) {
  return IGNORED_FILE_PATTERNS.some((pattern) => pattern.test(file));
}

function normalizeFile(file) {
  return String(file).trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function parseArgs(argv) {
  const args = {
    base: DEFAULT_BASE,
    head: 'HEAD',
    maxChars: DEFAULT_MAX_CHARS,
    repo: null,
    pr: null,
    post: false,
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new InputError(`${arg} precisa de valor`);
      index += 1;
      return value;
    };
    if (arg === '--base') args.base = next();
    else if (arg === '--head') args.head = next();
    else if (arg === '--max-chars') {
      const value = next();
      if (!/^[1-9]\d*$/.test(value)) throw new InputError('--max-chars precisa ser inteiro positivo');
      args.maxChars = Number(value);
    } else if (arg === '--repo') args.repo = next();
    else if (arg === '--pr') {
      const value = next();
      if (!/^[1-9]\d*$/.test(value)) throw new InputError('--pr precisa ser número positivo');
      args.pr = Number(value);
    } else if (arg === '--post') args.post = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else throw new InputError(`argumento desconhecido: ${arg}`);
  }
  if (args.post && args.dryRun) throw new InputError('use --post ou --dry-run, não os dois');
  if (args.post && args.pr === null) throw new InputError('--post precisa de --pr');
  for (const ref of [args.base, args.head]) {
    if (!ref || ref.startsWith('-')) throw new InputError(`ref inválida: ${ref}`);
  }
  return args;
}

function readDiff({ base, head, cwd, exec }) {
  try {
    return exec('git', ['diff', '--unified=0', '--no-color', '--no-ext-diff', `${base}...${head}`], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: GIT_MAX_BUFFER,
    });
  } catch (error) {
    throw new Error(`não foi possível calcular o diff ${base}...${head}: ${error.message.split('\n')[0]}`, {
      cause: error,
    });
  }
}

// Separa o diff em seções por arquivo. O nome vem do cabeçalho "diff --git" (lado novo).
function splitDiffByFile(diffText) {
  const sections = [];
  for (const line of String(diffText || '').split('\n')) {
    const header = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (header) sections.push({ file: header[2], lines: [line] });
    else if (sections.length > 0) sections[sections.length - 1].lines.push(line);
  }
  return sections.map((section) => ({
    file: section.file,
    text: section.lines.join('\n').replace(/\n+$/, ''),
  }));
}

// Inclui seções inteiras na ordem do diff enquanto couberem em maxChars.
// Arquivo que não cabe é omitido (nunca cortado no meio de uma linha).
function limitDiff(sections, maxChars) {
  let text = '';
  const included = [];
  const omitted = [];
  for (const section of sections) {
    const piece = `${section.text}\n`;
    if (text.length + piece.length > maxChars) {
      omitted.push(section.file);
      continue;
    }
    text += piece;
    included.push(section.file);
  }
  return { text, included, omitted };
}

function schemaError(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return 'precisa ser objeto';
  if (typeof item.file !== 'string' || !item.file.trim()) return 'campo "file" obrigatório';
  if (!Number.isInteger(item.line) || item.line < 1) return '"line" precisa ser inteiro >= 1';
  if (!SEVERITIES.includes(item.severity)) return `"severity" precisa ser ${SEVERITIES.join(', ')}`;
  if (typeof item.message !== 'string' || !item.message.trim()) return 'campo "message" obrigatório';
  return null;
}

/**
 * Converte a resposta do modelo em achados válidos e descartados.
 * JSON inválido ou fora do formato de array lança erro: nunca vira "zero achados".
 */
function parseModelReply(text) {
  let data;
  try {
    data = JSON.parse(String(text).trim());
  } catch (error) {
    throw new Error(`resposta do modelo não é JSON válido: ${error.message}`, { cause: error });
  }
  if (!Array.isArray(data)) throw new Error('resposta do modelo precisa ser um array JSON');
  return data;
}

function classifyFindings(rawItems, { addedLines, sentFiles }) {
  const valid = [];
  const discarded = [];
  rawItems.forEach((item, index) => {
    const problem = schemaError(item);
    if (problem) {
      discarded.push({ index, reason: `formato: ${problem}` });
      return;
    }
    const file = normalizeFile(item.file);
    const base = { index, file, line: item.line };
    if (!sentFiles.has(file)) {
      discarded.push({ ...base, reason: 'arquivo não enviado ao modelo' });
      return;
    }
    const added = addedLines.get(file);
    if (!added || !added.has(item.line)) {
      discarded.push({ ...base, reason: 'linha não adicionada no diff' });
      return;
    }
    valid.push({ file, line: item.line, severity: item.severity, message: item.message.trim() });
  });
  return { valid, discarded };
}

function postReview({ repo, pr, items, exec }) {
  const existing = exec(
    'gh',
    ['api', '--paginate', '--jq', '.[].body', `repos/${repo}/pulls/${pr}/comments`],
    {
      encoding: 'utf8',
      maxBuffer: GH_MAX_BUFFER,
    },
  );
  const { fresh, skipped } = filterExisting(items, existing);
  if (fresh.length === 0) return { posted: false, skipped };
  const payload = { event: 'COMMENT', body: REVIEW_BODY, comments: fresh.map((item) => item.comment) };
  exec('gh', ['api', '--method', 'POST', `repos/${repo}/pulls/${pr}/reviews`, '--input', '-'], {
    encoding: 'utf8',
    input: JSON.stringify(payload),
    maxBuffer: GH_MAX_BUFFER,
  });
  return { posted: true, skipped };
}

function fail(message, exitCode) {
  return { status: 'error', reason: message, exitCode };
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const out = deps.out || ((text) => process.stdout.write(text));
  const err = deps.err || ((text) => process.stderr.write(text));
  const env = deps.env || process.env;
  const cwd = deps.cwd || process.cwd();
  const exec = deps.execFileSync || childProcess.execFileSync;
  const ai = deps.ai || localAi;
  const readFile = deps.readFile || ((file) => fs.readFileSync(file, 'utf8'));

  let args = null;
  const finish = (result) => {
    const report = { ...result, base: args ? args.base : null, mode: args && args.post ? 'post' : 'dry-run' };
    out(`${JSON.stringify(report, null, 2)}\n`);
    if (result.status === 'error') err(`pr-ai-review: ${result.reason}\n`);
    return result.exitCode;
  };

  try {
    args = parseArgs(argv);
    if (args.post && !env.GITHUB_TOKEN) {
      return finish(fail('--post exige a variável GITHUB_TOKEN', EXIT_BAD_INPUT));
    }

    const diffText = readDiff({ base: args.base, head: args.head, cwd, exec });
    const sections = splitDiffByFile(diffText);
    const reviewable = sections.filter((section) => !isIgnoredFile(section.file));
    const ignored = sections.filter((section) => isIgnoredFile(section.file)).map((s) => s.file);
    const reviewableText = reviewable.map((section) => section.text).join('\n');
    const addedLines = parseDiffLineNumbers(stripNoNewlineMarkers(reviewableText));
    if (addedLines.size === 0) {
      return finish({
        status: 'skipped',
        reason: 'nenhuma linha adicionada revisável no diff',
        exitCode: EXIT_OK,
      });
    }

    const settings = ai.resolveAiSettings({ root: cwd, env });
    if (!settings.model) {
      const reason = 'modelo não configurado: defina QG_AI_MODEL ou "model" em .quality-gate/ai.local.json';
      return finish({ status: 'skipped', reason, exitCode: EXIT_OK });
    }
    const selection = await ai.selectProvider(settings.providers, settings.model, {
      apiKey: settings.apiKey,
    });
    if (!selection.provider) {
      const reachable = selection.attempts.filter((attempt) => attempt.reachable);
      const reason =
        reachable.length === 0
          ? 'nenhum provedor local alcançável (9Router, Ollama): sem provedor configurado'
          : `modelo "${settings.model}" não listado pelos provedores alcançáveis`;
      return finish({ status: 'skipped', reason, exitCode: EXIT_OK });
    }

    const limited = limitDiff(reviewable, args.maxChars);
    if (limited.included.length === 0) {
      const reason = `nenhum arquivo cabe no limite de ${args.maxChars} caracteres`;
      return finish({ status: 'skipped', reason, exitCode: EXIT_OK });
    }
    const systemPrompt = readFile(PROMPT_PATH);
    const reply = await ai.chat(
      selection.provider,
      settings.model,
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: limited.text },
      ],
      { apiKey: settings.apiKey },
    );

    const rawItems = parseModelReply(reply);
    const { valid, discarded } = classifyFindings(rawItems, {
      addedLines,
      sentFiles: new Set(limited.included),
    });
    const { items, summary } = buildReviewItems({
      findings: valid.map((f) => ({
        file: f.file,
        line: f.line,
        message: `[${f.severity}] ${f.message}`,
        rule: RULE,
      })),
      diffText: reviewableText,
    });

    let posted = false;
    let skippedExisting = [];
    if (args.post) {
      const repo = resolveRepo({ repo: args.repo, cwd, execFileSync: exec });
      ({ posted, skipped: skippedExisting } = postReview({ repo, pr: args.pr, items, exec }));
    }

    return finish({
      status: 'ok',
      exitCode: EXIT_OK,
      provider: selection.provider.id,
      model: settings.model,
      pr: args.pr,
      diff: {
        files: limited.included,
        omitted: limited.omitted,
        ignored,
        chars: limited.text.length,
        maxChars: args.maxChars,
      },
      findings: valid,
      discarded,
      comments: items.map((item) => item.comment),
      summary,
      skipped_existing: skippedExisting,
      posted,
    });
  } catch (error) {
    if (error instanceof InputError || error instanceof AiConfigError) {
      return finish(fail(error.message, EXIT_BAD_INPUT));
    }
    return finish(fail(error.message, EXIT_RUNTIME));
  }
}

if (require.main === module) main().then((code) => (process.exitCode = code));

module.exports = {
  IGNORED_FILE_PATTERNS,
  classifyFindings,
  isIgnoredFile,
  limitDiff,
  main,
  parseArgs,
  parseModelReply,
  postReview,
  schemaError,
  splitDiffByFile,
};
