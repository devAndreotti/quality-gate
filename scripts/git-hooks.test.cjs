const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  HOOK_MARKER,
  getGitHooksDir,
  installHook,
  parseArgs,
  renderPreCommitHook,
  renderPrePushHook,
  uninstallHook,
} = require('./git-hooks.cjs');

function tempGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-hooks-'));
  fs.mkdirSync(path.join(dir, '.git/hooks'), { recursive: true });
  return dir;
}

test('parseArgs supports install, uninstall, dry-run, force, json', () => {
  assert.equal(parseArgs(['install', '--dry-run']).dryRun, true);
  assert.equal(parseArgs(['uninstall', '--force']).action, 'uninstall');
  assert.equal(parseArgs(['--root=/custom/path']).root, '/custom/path');
});

test('installHook creates pre-push hook idempotently', () => {
  const root = tempGitRepo();
  const res = installHook({ root });
  assert.equal(res.status, 'installed');
  assert.ok(fs.existsSync(res.path));
  const content = fs.readFileSync(res.path, 'utf8');
  assert.match(content, new RegExp(HOOK_MARKER));

  // Reinstala sem conflito pois contem o marker
  const res2 = installHook({ root });
  assert.equal(res2.status, 'installed');
});

test('installHook detects custom unmanaged hook conflict unless forced', () => {
  const root = tempGitRepo();
  const hookPath = path.join(root, '.git/hooks/pre-push');
  fs.writeFileSync(hookPath, '#!/bin/sh\necho custom\n');

  const conflict = installHook({ root, force: false });
  assert.equal(conflict.status, 'conflict');

  const forced = installHook({ root, force: true });
  assert.equal(forced.status, 'installed');
});

test('uninstallHook removes managed hook and protects custom hook', () => {
  const root = tempGitRepo();
  installHook({ root });
  const un = uninstallHook({ root });
  assert.equal(un.status, 'uninstalled');
  assert.equal(fs.existsSync(un.path), false);

  // Custom hook
  fs.writeFileSync(un.path, '#!/bin/sh\necho custom\n');
  const conflict = uninstallHook({ root, force: false });
  assert.equal(conflict.status, 'conflict');
  assert.equal(fs.existsSync(un.path), true);
});

test('installHook skips gracefully when no .git folder exists', () => {
  const noGit = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-nogit-'));
  const res = installHook({ root: noGit });
  assert.equal(res.status, 'skipped');
});

test('renderPreCommitHook carries the managed marker and runs secret-scan and prettier', () => {
  const content = renderPreCommitHook();
  assert.ok(content.startsWith('#!/bin/sh\n'));
  assert.match(content, new RegExp(HOOK_MARKER));
  assert.match(content, /node scripts\/secret-scan\.cjs --diff/);
  assert.match(content, /node_modules\/\.bin\/prettier --check/);
  assert.match(content, /git diff --cached --name-only --diff-filter=ACM/);
  assert.doesNotMatch(content, /local-validate/);
});

test('renderPrePushHook keeps the pre-push checks and does not run the pre-commit checks', () => {
  const content = renderPrePushHook();
  assert.match(content, /node scripts\/local-validate\.cjs --profile=pr/);
  assert.doesNotMatch(content, /secret-scan/);
  assert.doesNotMatch(content, /prettier/);
});

test('installHook with hook pre-commit writes pre-commit and leaves pre-push alone', () => {
  const root = tempGitRepo();
  const res = installHook({ root, hook: 'pre-commit' });
  assert.equal(res.status, 'installed');
  assert.equal(path.basename(res.path), 'pre-commit');
  assert.equal(fs.existsSync(path.join(root, '.git/hooks/pre-push')), false);
  const content = fs.readFileSync(res.path, 'utf8');
  assert.equal(content, renderPreCommitHook());
  assert.ok((fs.statSync(res.path).mode & 0o111) !== 0, 'hook deve ser executavel');
});

test('installHook detects custom pre-commit conflict unless forced', () => {
  const root = tempGitRepo();
  const hookPath = path.join(root, '.git/hooks/pre-commit');
  fs.writeFileSync(hookPath, '#!/bin/sh\necho custom\n');

  const conflict = installHook({ root, hook: 'pre-commit' });
  assert.equal(conflict.status, 'conflict');
  assert.match(fs.readFileSync(hookPath, 'utf8'), /echo custom/);

  const forced = installHook({ root, hook: 'pre-commit', force: true });
  assert.equal(forced.status, 'installed');
});

test('uninstallHook with hook pre-commit removes only the managed pre-commit hook', () => {
  const root = tempGitRepo();
  installHook({ root });
  installHook({ root, hook: 'pre-commit' });
  const un = uninstallHook({ root, hook: 'pre-commit' });
  assert.equal(un.status, 'uninstalled');
  assert.equal(path.basename(un.path), 'pre-commit');
  assert.equal(fs.existsSync(un.path), false);
  assert.equal(fs.existsSync(path.join(root, '.git/hooks/pre-push')), true);
});

test('installHook and uninstallHook reject unknown hook names', () => {
  const root = tempGitRepo();
  assert.equal(installHook({ root, hook: 'post-merge' }).status, 'invalid');
  assert.equal(uninstallHook({ root, hook: 'post-merge' }).status, 'invalid');
  assert.equal(fs.existsSync(path.join(root, '.git/hooks/post-merge')), false);
});

test('parseArgs reads --hook in both forms and defaults to pre-push', () => {
  assert.equal(parseArgs(['install']).hook, 'pre-push');
  assert.equal(parseArgs(['install', '--hook=pre-commit']).hook, 'pre-commit');
  assert.equal(parseArgs(['install', '--hook', 'pre-commit']).hook, 'pre-commit');
});
