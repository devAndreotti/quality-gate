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
  { id: 'db_uri_password', name: 'Database URI Password', regex: /(?:postgres|mysql|mongodb|redis):\/\/[^\s:]+:([^\s@]{4,})@/g },
];

const IGNORED_DIRS = new Set(['node_modules', '.git', 'coverage', 'dist', 'build', '.venv', '.pytest_cache']);
const PLACEHOLDER_PATTERN = /(?:YOUR_|DUMMY|EXAMPLE|TEST_|FAKE|XXXXX|<token>|\b0{10,}\b)/i;

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
        if (isPlaceholder(matchedValue)) continue;
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

function scanDirectory(dir = process.cwd(), results = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scanDirectory(fullPath, results);
    } else {
      const findings = scanFile(fullPath);
      results.push(...findings);
    }
  }
  return results;
}

function scanGitDiff(cwd = process.cwd(), execFileSync = childProcess.execFileSync) {
  try {
    const diff = execFileSync('git', ['diff', 'HEAD'], { cwd, encoding: 'utf8' });
    const findings = [];
    let currentFile = null;
    let currentLine = 0;

    for (const line of diff.split(/\r?\n/)) {
      const fileMatch = line.match(/^\+\+\+ b\/(.+)$/);
      if (fileMatch) {
        currentFile = fileMatch[1];
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
  } catch {
    return [];
  }
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = { mode: 'all', root: process.cwd(), json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--diff') args.mode = 'diff';
    else if (arg === '--all') args.mode = 'all';
    else if (arg === '--json') args.json = true;
    else if (arg === '--root') args.root = argv[++i];
    else if (arg.startsWith('--root=')) args.root = arg.slice('--root='.length);
  }
  return args;
}

function runSecretScan(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const mode = options.mode || 'all';
  const findings = mode === 'diff' ? scanGitDiff(root) : scanDirectory(root);
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
    for (const f of result.findings) {
      console.log(`  ❌ ${f.name} em ${f.file}:${f.line} (${f.preview})`);
    }
  }
  process.exitCode = result.status === 'passed' ? 0 : 1;
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
};