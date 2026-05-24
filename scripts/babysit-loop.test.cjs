const assert = require('node:assert/strict');
const test = require('node:test');

const {
  decideLoopState,
  parseArgs,
  runBabysitCycle,
} = require('./babysit-loop.cjs');

test('parseArgs supports pr, max-cycles, json, and once', () => {
  const args = parseArgs(['--pr', '42', '--max-cycles', '3', '--json', '--once']);
  assert.equal(args.pr, 42);
  assert.equal(args.maxCycles, 3);
  assert.equal(args.json, true);
  assert.equal(args.once, true);
});

test('decideLoopState returns terminal when PR is ready', () => {
  const state = decideLoopState({ pr: { state: 'OPEN' }, ci: { overall: 'success' }, actions: ['ready'] });
  assert.equal(state.terminal, true);
  assert.equal(state.reason, 'ready');
});

test('decideLoopState asks wait when CI is pending', () => {
  const state = decideLoopState({ pr: { state: 'OPEN' }, ci: { overall: 'pending' }, actions: ['wait_ci'] });
  assert.equal(state.terminal, false);
  assert.equal(state.next, 'wait');
});

test('runBabysitCycle combines snapshot and diagnosis without fixing code', () => {
  const result = runBabysitCycle({
    pr: 42,
    snapshotProvider: () => ({
      pr: { number: 42, state: 'OPEN' },
      latestRun: { id: 123 },
      ci: { overall: 'failure', jobs: { lint: { name: 'Lint', conclusion: 'failure' } } },
      actions: ['fix_lint'],
      copilotBlockers: [],
      humanBlockers: [],
    }),
    diagnoseProvider: () => ({ actions: ['fix_lint'], findings: [{ action: 'fix_lint' }] }),
  });

  assert.equal(result.pr, 42);
  assert.deepEqual(result.actions, ['fix_lint']);
  assert.equal(result.loop.next, 'fix');
});
