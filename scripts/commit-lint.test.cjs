const assert = require('node:assert/strict');
const test = require('node:test');

const {
  validateCommitMessage,
  parseArgs,
} = require('./commit-lint.cjs');

test('validateCommitMessage accepts conventional commits with and without scope', () => {
  assert.equal(validateCommitMessage('feat(auth): add login endpoint').valid, true);
  assert.equal(validateCommitMessage('fix: correct null pointer in parser').valid, true);
  assert.equal(validateCommitMessage('docs: update README').valid, true);
  assert.equal(validateCommitMessage('feat(api)!: breaking change in auth payload').breaking, true);
  assert.equal(validateCommitMessage('Merge branch main into dev').valid, true);
});

test('validateCommitMessage rejects invalid formats, unknown types and overly long headers', () => {
  assert.equal(validateCommitMessage('arrumei um bug aqui').valid, false);
  assert.equal(validateCommitMessage('unknown(scope): test').valid, false);
  assert.equal(validateCommitMessage('').valid, false);
  assert.equal(validateCommitMessage('feat: a').valid, false); // subject curto
  const longMsg = 'feat: ' + 'a'.repeat(110);
  assert.equal(validateCommitMessage(longMsg).valid, false);
});

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const { readRangeCommits, runRange, validateRange } = require('./commit-lint.cjs');

test('readRangeCommits parses sha and multi-line body per commit and skips merges via git flags', () => {
  const calls = [];
  const fakeExec = (cmd, args) => {
    calls.push([cmd, args]);
    return '\naaa111\x1efeat(api): add route\n\nbody line\n\x1f\nbbb222\x1efix: patch parser\n\x1f';
  };
  const commits = readRangeCommits('base..HEAD', fakeExec);
  assert.deepEqual(commits.map((c) => c.sha), ['aaa111', 'bbb222']);
  assert.match(commits[0].message, /^feat\(api\): add route/);
  assert.deepEqual(calls[0][1].slice(0, 2), ['log', '--no-merges']);
  assert.equal(calls[0][1].at(-1), 'base..HEAD');
});

test('validateRange reports invalid commits and fails the whole range', () => {
  const ok = validateRange([{ sha: 'a', message: 'feat: add thing' }]);
  assert.equal(ok.valid, true);
  const bad = validateRange([
    { sha: 'a', message: 'feat: add thing' },
    { sha: 'b', message: 'arrumei um bug' },
  ]);
  assert.equal(bad.valid, false);
  assert.equal(bad.results[1].sha, 'b');
  assert.equal(bad.results[1].valid, false);
});

test('runRange validates a real git range end to end', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-lint-range-'));
  const git = (...args) => childProcess.execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'test');
  git('commit', '-q', '--allow-empty', '-m', 'chore: base');
  const base = git('rev-parse', 'HEAD').trim();
  git('commit', '-q', '--allow-empty', '-m', 'feat(core): add valid change');
  git('commit', '-q', '--allow-empty', '-m', 'arrumei um bug');
  const exec = (cmd, args) => childProcess.execFileSync(cmd, args, { cwd: dir, encoding: 'utf8' });
  const summary = runRange(`${base}..HEAD`, exec);
  assert.equal(summary.total, 2);
  assert.equal(summary.invalid, 1);
  assert.equal(summary.valid, false);
  fs.rmSync(dir, { recursive: true, force: true });
});
