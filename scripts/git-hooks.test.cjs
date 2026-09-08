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
