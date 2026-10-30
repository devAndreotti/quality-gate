#!/usr/bin/env node
/**
 * secret-scan.cjs — verificador estatico nativo de credenciais e segredos.
 */
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SECRET_PATTERNS = [
  { id: 'openai_key', name: 'OpenAI API Key', regex: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_\-]{20,}\b/g },
  {
    id: 'github_pat',
    name: 'GitHub Personal Access Token',
    regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}\b/g,
  },
  { id: 'private_key', name: 'Private Key', regex: /-----BEGIN (?:[A-Z0-9_-]+ )?PRIVATE KEY-----/g },
  { id: 'aws_key', name: 'AWS Access Key ID', regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  {
    id: 'jwt_token',
    name: 'JSON Web Token',
    regex: /\beyJ[A-Za-z0-9\-_=]+\.eyJ[A-Za-z0-9\-_=]+\.[A-Za-z0-9\-_\.\+\/=]{10,}\b/g,
  },
  {
    id: 'slack_webhook',
    name: 'Slack/Discord Webhook',
    regex: /https:\/\/(?:hooks\.slack\.com|discord(?:app)?\.com\/api\/webhooks)\/[A-Za-z0-9\/_\.\-]+/g,
  },
  { id: 'stripe_key', name: 'Stripe API Key', regex: /\bsk_(?:live|test)_[A-Za-z0-9]{24,}\b/g },
  { id: 'google_api_key', name: 'Google API Key', regex: /\bAIza[0-9A-Za-z\-_]{35}\b/g },
  { id: 'slack_token', name: 'Slack Token', regex: /\bxox[baprs]-[A-Za-z0-9\-]{10,}/g },
  { id: 'npm_token', name: 'npm Access Token', regex: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { id: 'gitlab_pat', name: 'GitLab Personal Access Token', regex: /\bglpat-[A-Za-z0-9_\-]{20}\b/g },
  {
    id: 'pgp_private_key',
    name: 'PGP Private Key Block',
    regex: /-----BEGIN PGP (?:PRIVATE KEY BLOCK)-----/g,
  },
  {
    id: 'db_uri_password',
    name: 'URI Password',
    regex: /\b[a-zA-Z][a-zA-Z0-9+.\-]*:\/\/[^\s:\/@]+:([^\s@]{4,})@/g,
  },
];

const IGNORED_DIRS = new Set(['node_modules', '.git', 'coverage', 'dist', 'build', '.venv', '.pytest_cache']);
const PLACEHOLDER_PATTERN = /(?:YOUR_|DUMMY|EXAMPLE|TEST_|FAKE|XXXXX|<token>|\b0{10,}\b)/i;
// Prefixo de chave Stripe (sk_test_) contém "TEST_" e não deve tornar a chave um placeholder.
const PROVIDER_PREFIX = /^(?:sk|rk)_(?:live|test)_/;
// SS-5: marcador só vale como comentário no fim da linha (não dentro de string literal).
const SUPPRESS_PATTERN = /(?:\/\/|#|\/\*)\s*(?:nosecret|NOSONAR)\b\s*(?:\*\/)?\s*$/;
// SS-4: arquivos acima deste limite são pulados e registrados como skipped.
const MAX_FILE_BYTES = 2 * 1024 * 1024;
// --history: teto da lista de achados no resultado (o total continua exato) e de linhas impressas.
const HISTORY_MAX_FINDINGS = 500;
const TEXT_MAX_FINDINGS = 100;
const HISTORY_MAX_BUFFER = 256 * 1024 * 1024;
// Cabeçalho "commit <sha>" do git log; dentro de hunk toda linha começa com +, - , espaço ou \.
const COMMIT_HEADER = /^commit ([0-9a-f]{40}|[0-9a-f]{64})\b/;

// Exclusão só por padrão explícito (--ignore). Test/spec/fixtures NÃO são isentos:
// segredos reais costumam vazar justamente nesses arquivos.
function shouldIgnore(filePath, customPatterns = []) {
  if (!filePath) return false;
  const normalized = filePath.replace(/\\/g, '/');
  for (const pat of customPatterns) {
    if (typeof pat === 'string' && normalized.includes(pat)) return true;
    if (pat instanceof RegExp && pat.test(normalized)) return true;
  }
  return false;
}

function isPlaceholder(value) {
  return PLACEHOLDER_PATTERN.test(value);
}

function scanText(text, options = {}) {
  const findings = [];
  const lines = String(text || '').split(/\r?\n/);

  for (let lineNum = 1; lineNum <= lines.length; lineNum++) {
    const line = lines[lineNum - 1];
    if (SUPPRESS_PATTERN.test(line)) continue;

    for (const pattern of SECRET_PATTERNS) {
      pattern.regex.lastIndex = 0;
      let match;
      while ((match = pattern.regex.exec(line)) !== null) {
        const matchedValue = match[0];
        if (isPlaceholder(matchedValue.replace(PROVIDER_PREFIX, ''))) continue;
        findings.push({
          id: pattern.id,
          name: pattern.name,
          line: lineNum,
          column: match.index + 1,
          preview: '[valor oculto]', // SS-7: nunca expõe caracteres do segredo
        });
      }
    }
  }

  return findings;
}

function scanFile(filePath, skipped = null) {
  if (!fs.existsSync(filePath)) return [];
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_FILE_BYTES) {
    // SS-4: arquivo grande não é escaneado, mas precisa aparecer no resultado.
    if (skipped) skipped.push({ file: filePath, reason: 'tamanho > 2MB' });
    return [];
  }
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const findings = scanText(content);
    return findings.map((f) => ({ ...f, file: filePath }));
  } catch {
    return []; // ignora binarios
  }
}

function scanDirectory(dir = process.cwd(), results = [], options = {}) {
  const ignorePatterns = options.ignore || [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name)) continue; // .git já está em IGNORED_DIRS; dotfiles são escaneados
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scanDirectory(fullPath, results, options);
    } else {
      if (shouldIgnore(fullPath, ignorePatterns)) continue;
      const findings = scanFile(fullPath, options.skipped);
      results.push(...findings);
    }
  }
  return results;
}

// Ver SS-2: staged (git diff --cached) + untracked (git ls-files --others).
// Falha de git propaga erro: nunca vira lista vazia com status PASSED.
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

// SS-8: git cota caminhos com espaços/unicode/aspas: "b/caf\\303\\251 \\"x\\".txt".
// Remove aspas e desescapa sequências comuns; octais viram bytes UTF-8.
function unquoteGitPath(raw) {
  let value = raw.replace(/\t$/, '');
  if (!(value.length >= 2 && value.startsWith('"') && value.endsWith('"'))) return value;
  const body = value.slice(1, -1);
  const bytes = [];
  const simple = { '\\': 0x5c, '"': 0x22, t: 0x09, n: 0x0a, r: 0x0d };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf8'));
      continue;
    }
    const octal = body.slice(i + 1, i + 4);
    if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(parseInt(octal, 8));
      i += 3;
    } else if (body[i + 1] in simple) {
      bytes.push(simple[body[i + 1]]);
      i += 1;
    } else {
      bytes.push(0x5c);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function headerPath(raw) {
  const unquoted = unquoteGitPath(raw);
  if (unquoted === '/dev/null') return null;
  return unquoted.startsWith('b/') ? unquoted.slice(2) : unquoted;
}

function scanUnifiedDiff(diff, ignorePatterns = []) {
  const findings = [];
  let currentFile = null;
  let currentLine = 0;
  let inPreamble = false;
  let currentCommit = null;

  for (const line of diff.split(/\r?\n/)) {
    // Saída de "git log -p": cada commit começa com "commit <sha>" (só existe no --history).
    const commitMatch = line.match(COMMIT_HEADER);
    if (commitMatch) {
      currentCommit = commitMatch[1];
      currentFile = null;
      inPreamble = false;
      continue;
    }
    // Cabeçalhos só existem no preâmbulo de cada arquivo (entre "diff --git" e "@@").
    // Dentro de hunk, uma linha adicionada "++x" é conteúdo e deve ser escaneada.
    if (line.startsWith('diff --git ')) {
      inPreamble = true;
      continue;
    }
    if (line.startsWith('@@')) inPreamble = false;
    if (inPreamble && line.startsWith('+++ ')) {
      currentFile = headerPath(line.slice(4));
      continue;
    }
    if (currentFile && shouldIgnore(currentFile, ignorePatterns)) {
      continue;
    }
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunkMatch) {
      currentLine = parseInt(hunkMatch[1], 10);
      continue;
    }
    if (line.startsWith('+')) {
      const text = line.slice(1);
      const lineFindings = scanText(text);
      for (const f of lineFindings) {
        findings.push({
          ...f,
          file: currentFile,
          line: currentLine,
          ...(currentCommit && { commit: currentCommit }),
        });
      }
      currentLine++;
    } else if (!line.startsWith('-') && !line.startsWith('\\')) {
      currentLine++;
    }
  }
  return findings;
}

function scanGitDiff(cwd = process.cwd(), execFileSync = childProcess.execFileSync, options = {}) {
  const ignorePatterns = options.ignore || [];
  const runGit = (args) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: GIT_MAX_BUFFER,
    });

  const staged = runGit(['diff', '--cached', '--no-color', '--no-ext-diff']);
  const findings = scanUnifiedDiff(staged, ignorePatterns);

  const untracked = runGit(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  for (const relPath of untracked) {
    if (shouldIgnore(relPath, ignorePatterns)) continue;
    const fileFindings = scanFile(path.join(cwd, relPath), options.skipped);
    for (const f of fileFindings) findings.push({ ...f, file: relPath });
  }
  return findings;
}

// --history: varre as linhas adicionadas de todos os commits (git log -p --all).
// Argumentos vão como array (sem shell). Blobs binarios saem como "Binary files ... differ",
// sem linhas "+", entao nao sao escaneados. Falha de git propaga erro.
// --diff-merges=first-parent: sem isso, git log -p não mostra diff de merge e um segredo
// introduzido na resolução de conflito passaria em silêncio.
function scanGitHistory(cwd = process.cwd(), execFileSync = childProcess.execFileSync, options = {}) {
  // Clone raso veria só a ponta e passaria em silêncio: falha fechada.
  const shallow = String(
    execFileSync('git', ['rev-parse', '--is-shallow-repository'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  ).trim();
  if (shallow === 'true') {
    throw new Error('historico raso (shallow clone): use fetch-depth: 0 para varrer o historico completo');
  }
  const log = execFileSync(
    'git',
    [
      'log',
      '-p',
      '--all',
      '--diff-merges=first-parent',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--no-show-signature',
    ],
    {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: HISTORY_MAX_BUFFER,
    },
  );
  return scanUnifiedDiff(log, options.ignore || []);
}

// Allowlist do histórico: exceções EXATAS (commit + arquivo + linha + regra), porque o histórico é imutável.
// Um segredo novo, mesmo do mesmo tipo e arquivo, tem outro commit ou outra linha e continua falhando.
// Formato: [{ "commit": "<sha>", "file": "<caminho>", "line": <n>, "id": "<regra>", "motivo": "<texto>" }]
function loadHistoryAllowlist(allowPath) {
  if (!fs.existsSync(allowPath)) return [];
  let entries;
  try {
    entries = JSON.parse(fs.readFileSync(allowPath, 'utf8'));
  } catch (err) {
    throw new Error(`allowlist do historico invalida (${allowPath}): ${err.message}`);
  }
  if (!Array.isArray(entries)) throw new Error(`allowlist do historico deve ser um array (${allowPath})`);
  for (const e of entries) {
    if (
      !e ||
      !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(e.commit || '') ||
      typeof e.file !== 'string' ||
      !Number.isInteger(e.line) ||
      typeof e.id !== 'string'
    ) {
      throw new Error(`entrada invalida na allowlist do historico (${allowPath}): ${JSON.stringify(e)}`);
    }
  }
  return entries;
}

function applyHistoryAllowlist(findings, allowlist) {
  const key = (x) => `${x.commit}\u0000${x.file}\u0000${x.line}\u0000${x.id}`;
  const allowKeys = new Set(allowlist.map(key));
  const used = new Set();
  const allowed = [];
  const kept = [];
  for (const f of findings) {
    const k = key(f);
    if (allowKeys.has(k)) {
      used.add(k);
      allowed.push(f);
    } else kept.push(f);
  }
  const unusedAllowed = allowlist.filter((e) => !used.has(key(e)));
  return { findings: kept, allowed, unusedAllowed };
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = { mode: 'all', root: process.cwd(), json: false, ignore: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--diff') args.mode = 'diff';
    else if (arg === '--all') args.mode = 'all';
    else if (arg === '--history') args.mode = 'history';
    else if (arg === '--json') args.json = true;
    else if (arg === '--root' || arg === '--project') args.root = argv[++i];
    else if (arg.startsWith('--root=')) args.root = arg.slice('--root='.length);
    else if (arg.startsWith('--project=')) args.root = arg.slice('--project='.length);
    else if (arg === '--ignore') args.ignore.push(argv[++i]);
    else if (arg.startsWith('--ignore=')) args.ignore.push(arg.slice('--ignore='.length));
  }
  return args;
}

function runSecretScan(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const mode = options.mode || 'all';
  const skipped = [];
  const scanOptions = { ...options, skipped };
  let findings;
  let allowed = [];
  let unusedAllowed = [];
  try {
    const execFileSync = options.execFileSync || childProcess.execFileSync;
    if (mode === 'diff') findings = scanGitDiff(root, execFileSync, scanOptions);
    else if (mode === 'history') {
      const allowPath =
        options.historyAllowPath || path.join(root, '.quality-gate', 'secret-history-allow.json');
      const applied = applyHistoryAllowlist(
        scanGitHistory(root, execFileSync, scanOptions),
        loadHistoryAllowlist(allowPath),
      );
      findings = applied.findings;
      allowed = applied.allowed;
      unusedAllowed = applied.unusedAllowed;
    } else findings = scanDirectory(root, [], scanOptions);
  } catch (err) {
    const message = String((err && err.message) || err).split(/\r?\n/)[0];
    return {
      status: 'error',
      mode,
      root,
      findingsCount: 0,
      findings: [],
      skippedCount: 0,
      skipped: [],
      error: message,
    };
  }
  let status = 'passed';
  if (findings.length > 0) status = 'failed';
  else if (skipped.length > 0) status = 'passed-with-skips';
  // Limite de saída: o total é exato; a lista é cortada no histórico (JSON e texto).
  const findingsCount = findings.length;
  const findingsTruncated = mode === 'history' && findingsCount > HISTORY_MAX_FINDINGS;
  if (findingsTruncated) findings = findings.slice(0, HISTORY_MAX_FINDINGS);
  return {
    status,
    mode,
    root,
    findingsCount,
    findingsTruncated,
    findings,
    allowedCount: allowed.length,
    allowed,
    unusedAllowed,
    skippedCount: skipped.length,
    skipped,
  };
}

function main() {
  const args = parseArgs();
  const result = runSecretScan(args);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\nSecret Scan (${result.mode}): ${result.status.toUpperCase()}`);
    if (result.status === 'error') console.log(`  erro: ${result.error}`);
    for (const f of result.findings.slice(0, TEXT_MAX_FINDINGS)) {
      const where = f.commit ? ` commit ${f.commit.slice(0, 12)}` : '';
      console.log(`  ❌ ${f.name} em ${f.file}:${f.line}${where} (${f.preview})`);
    }
    if (result.findingsCount > TEXT_MAX_FINDINGS) {
      console.log(
        `  ... mais ${result.findingsCount - TEXT_MAX_FINDINGS} achado(s) omitido(s) na saída (use --json)`,
      );
    }
    for (const s of result.skipped) {
      console.log(`  ⚠️  nao escaneado: ${s.file} (${s.reason})`);
    }
    if (result.allowedCount)
      console.log(`  ℹ️  ${result.allowedCount} achado(s) do historico cobertos pela allowlist`);
    for (const u of result.unusedAllowed || []) {
      console.log(
        `  ⚠️  entrada da allowlist sem achado correspondente (remover): ${u.commit.slice(0, 12)} ${u.file}:${u.line} ${u.id}`,
      );
    }
  }
  if (result.status === 'error') process.exitCode = 2;
  else process.exitCode = result.status === 'failed' ? 1 : 0;
}

if (require.main === module) main();

module.exports = {
  HISTORY_MAX_FINDINGS,
  SECRET_PATTERNS,
  isPlaceholder,
  parseArgs,
  runSecretScan,
  scanDirectory,
  scanFile,
  scanGitDiff,
  scanGitHistory,
  scanText,
  shouldIgnore,
};
