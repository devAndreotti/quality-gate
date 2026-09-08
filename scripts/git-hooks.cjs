#!/usr/bin/env node
/**
 * git-hooks.cjs — gerencia hooks git do Quality Gate (.git/hooks/pre-push).
 */
const fs = require('node:fs');
const path = require('node:path');

const HOOK_MARKER = '# quality-gate:managed-hook';

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
    ''
  ].join('\n');
}

function installHook(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const hooksDir = getGitHooksDir(root);
  if (!hooksDir) {
    return { status: 'skipped', reason: 'pasta .git nao encontrada', path: null };
  }
  const hookPath = path.join(hooksDir, 'pre-push');
  if (fs.existsSync(hookPath)) {
    const existing = fs.readFileSync(hookPath, 'utf8');
    if (!existing.includes(HOOK_MARKER) && !options.force) {
      return { status: 'conflict', reason: 'pre-push hook customizado existente sem marker gerenciado. Use --force para sobrescrever.', path: hookPath };
    }
  }
  const hookContent = renderPrePushHook();
  if (!options.dryRun) {
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(hookPath, hookContent, { mode: 0o755 });
  }
  return { status: 'installed', path: hookPath, dryRun: Boolean(options.dryRun) };
}

function uninstallHook(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const hooksDir = getGitHooksDir(root);
  if (!hooksDir) {
    return { status: 'skipped', reason: 'pasta .git nao encontrada', path: null };
  }
  const hookPath = path.join(hooksDir, 'pre-push');
  if (!fs.existsSync(hookPath)) {
    return { status: 'not_found', path: hookPath };
  }
  const existing = fs.readFileSync(hookPath, 'utf8');
  if (!existing.includes(HOOK_MARKER) && !options.force) {
    return { status: 'conflict', reason: 'pre-push hook customizado nao pertence ao Quality Gate', path: hookPath };
  }
  if (!options.dryRun) {
    fs.unlinkSync(hookPath);
  }
  return { status: 'uninstalled', path: hookPath, dryRun: Boolean(options.dryRun) };
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = { action: 'install', dryRun: false, force: false, json: false, root: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === 'install' || arg === 'uninstall') args.action = arg;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--force') args.force = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--root') args.root = argv[++i];
    else if (arg.startsWith('--root=')) args.root = arg.slice('--root='.length);
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
  process.exitCode = result.status === 'conflict' ? 1 : 0;
}

if (require.main === module) main();

module.exports = {
  HOOK_MARKER,
  getGitHooksDir,
  installHook,
  parseArgs,
  renderPrePushHook,
  uninstallHook,
};