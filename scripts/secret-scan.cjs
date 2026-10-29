#!/usr/bin/env node
/**
 * secret-scan.cjs — verificador estatico nativo de credenciais e segredos.
 */
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SECRET_PATTERNS = [
  { id: 'openai_key', name: 'OpenAI API Key', regex: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_\-]{20,}\b/g },
  { id: 'github_pat', name: 'GitHub Personal Access Token', regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}\b/g },
  { id: 'private_key', name: 'Private Key', regex: /-----BEGIN (?:[A-Z0-9_-]+ )?PRIVATE KEY-----/g },
  { id: 'aws_key', name: 'AWS Access Key ID', regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: 'jwt_token', name: 'JSON Web Token', regex: /\beyJ[A-Za-z0-9\-_=]+\.eyJ[A-Za-z0-9\-_=]+\.[A-Za-z0-9\-_\.\+\/=]{10,}\b/g },
  { id: 'slack_webhook', name: 'Slack/Discord Webhook', regex: /https:\/\/(?:hooks\.slack\.com|discord(?:app)?\.com\/api\/webhooks)\/[A-Za-z0-9\/_\.\-]+/g },
  { id: 'stripe_key', name: 'Stripe API Key', regex: /\bsk_(?:live|test)_[A-Za-z0-9]{24,}\b/g },
  { id: 'google_api_key', name: 'Google API Key', regex: /\bAIza[0-9A-Za-z\-_]{35}\b/g },
  { id: 'slack_token', name: 'Slack Token', regex: /\bxox[baprs]-[A-Za-z0-9\-]{10,}/g },
  { id: 'npm_token', name: 'npm Access Token', regex: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { id: 'gitlab_pat', name: 'GitLab Personal Access Token', regex: /\bglpat-[A-Za-z0-9_\-]{20}\b/g },
  { id: 'pgp_private_key', name: 'PGP Private Key Block', regex: /-----BEGIN PGP (?:PRIVATE KEY BLOCK)-----/g },
  { id: 'db_uri_password', name: 'URI Password', regex: /\b[a-zA-Z][a-zA-Z0-9+.\-]*:\/\/[^\s:\/@]+:([^\s@]{4,})@/g },
];

const IGNORED_DIRS = new Set(['node_modules', '.git', 'coverage', 'dist', 'build', '.venv', '.pytest_cache']);
const PLACEHOLDER_PATTERN = /(?:YOUR_|DUMMY|EXAMPLE|TEST_|FAKE|XXXXX|<token>|\b0{10,}\b)/i;
// Prefixo de chave Stripe (sk_test_) contém "TEST_" e não deve tornar a chave um placeholder.
const PROVIDER_PREFIX = /^(?:sk|rk)_(?:live|test)_/;

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
    if (line.includes('nosecret') || line.includes('NOSONAR')) continue;

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
          preview: matchedValue.slice(0, 8) + '...' + matchedValue.slice(-4),
        });
      }
    }
  }

  return findings;
}

function scanFile(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const stat = fs.statSync(filePath);
  if (stat.size > 2 * 1024 * 1024) return []; // ignora arquivos > 2MB
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
      const findings = scanFile(fullPath);
      results.push(...findings);
    }
  }
  return results;
}

// Ver SS-2: staged (git diff --cached) + untracked (git ls-files --others).
// Falha de git propaga erro: nunca vira lista vazia com status PASSED.
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

function scanUnifiedDiff(diff, ignorePatterns = []) {
  const findings = [];
  let currentFile = null;
  let currentLine = 0;

  for (const line of diff.split(/\r?\n/)) {
    const fileMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (fileMatch) {
      currentFile = fileMatch[1];
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
    if (line.startsWith('+') && !line.startsWith('+++')) {
      const text = line.slice(1);
      const lineFindings = scanText(text);
      for (const f of lineFindings) {
        findings.push({ ...f, file: currentFile, line: currentLine });
      }
      currentLine++;
    } else if (!line.startsWith('-')) {
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
    const fileFindings = scanFile(path.join(cwd, relPath));
    for (const f of fileFindings) findings.push({ ...f, file: relPath });
  }
  return findings;
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = { mode: 'all', root: process.cwd(), json: false, ignore: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--diff') args.mode = 'diff';
    else if (arg === '--all') args.mode = 'all';
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
  let findings;
  try {
    findings = mode === 'diff'
      ? scanGitDiff(root, options.execFileSync || childProcess.execFileSync, options)
      : scanDirectory(root, [], options);
  } catch (err) {
    const message = String((err && err.message) || err).split(/\r?\n/)[0];
    return { status: 'error', mode, root, findingsCount: 0, findings: [], error: message };
  }
  return {
    status: findings.length === 0 ? 'passed' : 'failed',
    mode,
    root,
    findingsCount: findings.length,
    findings,
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
    for (const f of result.findings) {
      console.log(`  ❌ ${f.name} em ${f.file}:${f.line} (${f.preview})`);
    }
  }
  if (result.status === 'error') process.exitCode = 2;
  else process.exitCode = result.status === 'passed' ? 0 : 1;
}

if (require.main === module) main();

module.exports = {
  SECRET_PATTERNS,
  isPlaceholder,
  parseArgs,
  runSecretScan,
  scanDirectory,
  scanFile,
  scanGitDiff,
  scanText,
  shouldIgnore,
};
