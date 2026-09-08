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
