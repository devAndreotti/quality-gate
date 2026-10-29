#!/usr/bin/env node
/**
 * git-hooks.cjs — gerencia hooks git do Quality Gate (.git/hooks/pre-push e pre-commit).
 */
const fs = require('node:fs');
const path = require('node:path');

const HOOK_MARKER = '# quality-gate:managed-hook';
const HOOK_NAMES = ['pre-push', 'pre-commit'];
const DEFAULT_HOOK = 'pre-push';

function getGitHooksDir(root = process.cwd()) {
  const gitDir = path.join(root, '.git');
  if (!fs.existsSync(gitDir)) return null;
  const stat = fs.statSync(gitDir);
  if (stat.isDirectory()) return path.join(gitDir, 'hooks');
  const gitContent = fs.readFileSync(gitDir, 'utf8');
  const match = gitContent.match(/gitdir:\s*(.+)/);
  if (match) return path.join(path.resolve(root, match[1].trim()), 'hooks');
  return null;
}

function renderPrePushHook() {
  return [
    '#!/bin/sh',
    HOOK_MARKER + ' version 1',
    '# Quality Gate pre-push hook: impede push que quebre os checks locais.',
    '',
    'echo "🔍 Quality Gate pre-push: validando projeto..."',
    '',
    'if [ -f "scripts/local-validate.cjs" ]; then',
    '  node scripts/local-validate.cjs --profile=pr',
    '  EXIT_CODE=$?',
    '  if [ $EXIT_CODE -ne 0 ]; then',
    '    echo "❌ Quality Gate falhou! Corrija os erros antes do push ou use git push --no-verify se necessario."',
    '    exit 1',
    '  fi',
    'elif [ -f "scripts/quality-gate.js" ]; then',
    '  node scripts/quality-gate.js check',
    '  EXIT_CODE=$?',
    '  if [ $EXIT_CODE -ne 0 ]; then',
    '    echo "❌ Quality Gate ratchet falhou! Corrija os erros antes do push."',
    '    exit 1',
    '  fi',
    'fi',
    '',
    'exit 0',
    '',
  ].join('\n');
}

function renderPreCommitHook() {
  return [
    '#!/bin/sh',
    HOOK_MARKER + ' version 1',
    '# Quality Gate pre-commit hook: bloqueia segredos no diff staged e arquivos fora do Prettier.',
    '',
    'echo "🔍 Quality Gate pre-commit: validando arquivos staged..."',
    '',
    'if [ -f "scripts/secret-scan.cjs" ]; then',
    '  node scripts/secret-scan.cjs --diff',
    '  EXIT_CODE=$?',
    '  if [ $EXIT_CODE -ne 0 ]; then',
    '    echo "❌ Quality Gate: possivel segredo no diff staged. Remova-o ou use git commit --no-verify se for falso positivo."',
    '    exit 1',
    '  fi',
    'fi',
    '',
    'STAGED=$(git diff --cached --name-only --diff-filter=ACM)',
    'if [ -n "$STAGED" ] && [ -x "node_modules/.bin/prettier" ]; then',
    '  printf "%s\\n" "$STAGED" | tr "\\n" "\\0" | xargs -0 node_modules/.bin/prettier --check --ignore-unknown --no-error-on-unmatched-pattern',
    '  EXIT_CODE=$?',
    '  if [ $EXIT_CODE -ne 0 ]; then',
    '    echo "❌ Quality Gate: arquivos staged fora do Prettier. Rode npm run format e adicione de novo."',
    '    exit 1',
    '  fi',
    'fi',
    '',
    'exit 0',
    '',
  ].join('\n');
}

function renderHook(hookName) {
  return hookName === 'pre-commit' ? renderPreCommitHook() : renderPrePushHook();
}

function invalidHookResult(hookName) {
  return {
    status: 'invalid',
    reason: `hook desconhecido: ${hookName} (use ${HOOK_NAMES.join(' ou ')})`,
    path: null,
  };
}

function installHook(options = {}) {
  const hookName = options.hook || DEFAULT_HOOK;
  if (!HOOK_NAMES.includes(hookName)) return invalidHookResult(hookName);
  const root = path.resolve(options.root || process.cwd());
  const hooksDir = getGitHooksDir(root);
  if (!hooksDir) {
    return { status: 'skipped', reason: 'pasta .git nao encontrada', path: null };
  }
  const hookPath = path.join(hooksDir, hookName);
  if (fs.existsSync(hookPath)) {
    const existing = fs.readFileSync(hookPath, 'utf8');
    if (!existing.includes(HOOK_MARKER) && !options.force) {
      return {
        status: 'conflict',
        reason: `${hookName} hook customizado existente sem marker gerenciado. Use --force para sobrescrever.`,
        path: hookPath,
      };
    }
  }
  const hookContent = renderHook(hookName);
  if (!options.dryRun) {
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(hookPath, hookContent, { mode: 0o755 });
  }
  return { status: 'installed', path: hookPath, dryRun: Boolean(options.dryRun) };
}

function uninstallHook(options = {}) {
  const hookName = options.hook || DEFAULT_HOOK;
  if (!HOOK_NAMES.includes(hookName)) return invalidHookResult(hookName);
  const root = path.resolve(options.root || process.cwd());
  const hooksDir = getGitHooksDir(root);
  if (!hooksDir) {
    return { status: 'skipped', reason: 'pasta .git nao encontrada', path: null };
  }
  const hookPath = path.join(hooksDir, hookName);
  if (!fs.existsSync(hookPath)) {
    return { status: 'not_found', path: hookPath };
  }
  const existing = fs.readFileSync(hookPath, 'utf8');
  if (!existing.includes(HOOK_MARKER) && !options.force) {
    return {
      status: 'conflict',
      reason: `${hookName} hook customizado nao pertence ao Quality Gate`,
      path: hookPath,
    };
  }
  if (!options.dryRun) {
    fs.unlinkSync(hookPath);
  }
  return { status: 'uninstalled', path: hookPath, dryRun: Boolean(options.dryRun) };
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    action: 'install',
    hook: DEFAULT_HOOK,
    dryRun: false,
    force: false,
    json: false,
    root: process.cwd(),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === 'install' || arg === 'uninstall') args.action = arg;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--force') args.force = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--root') args.root = argv[++i];
    else if (arg.startsWith('--root=')) args.root = arg.slice('--root='.length);
    else if (arg === '--hook') args.hook = argv[++i];
    else if (arg.startsWith('--hook=')) args.hook = arg.slice('--hook='.length);
  }
  return args;
}

function main() {
  const args = parseArgs();
  const result = args.action === 'uninstall' ? uninstallHook(args) : installHook(args);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`git hook: ${result.status} (${result.path || result.reason})`);
  }
  process.exitCode = result.status === 'conflict' || result.status === 'invalid' ? 1 : 0;
}

if (require.main === module) main();

module.exports = {
  HOOK_MARKER,
  HOOK_NAMES,
  getGitHooksDir,
  installHook,
  parseArgs,
  renderPreCommitHook,
  renderPrePushHook,
  uninstallHook,
};
