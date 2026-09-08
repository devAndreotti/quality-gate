const assert = require('node:assert/strict');
const test = require('node:test');

const {
  calculateDiffCoverage,
  parseDiffLineNumbers,
  parseLcovCoverageMap,
} = require('./lib/diff-coverage.cjs');

test('parseDiffLineNumbers extracts added line numbers per file', () => {
  const sampleDiff = [
    'diff --git a/src/index.js b/src/index.js',
    '--- a/src/index.js',
    '+++ b/src/index.js',
    '@@ -10,3 +10,4 @@ function test() {',
    '   const a = 1;',
    '+  const b = 2;',
    '+  return a + b;',
    ' }',
  ].join('\n');

  const map = parseDiffLineNumbers(sampleDiff);
  assert.ok(map.has('src/index.js'));
  assert.deepEqual(Array.from(map.get('src/index.js')), [11, 12]);
});

test('calculateDiffCoverage calculates percentage and passes/fails against threshold', () => {
  const diff = [
    '+++ b/src/util.js',
    '@@ -1,2 +1,3 @@',
    '+function add(x) {',
    '+  return x + 1;',
    '+}',
  ].join('\n');

  const lcovCovered = [
    'SF:src/util.js',
    'DA:1,1',
    'DA:2,1',
    'DA:3,1',
    'end_of_record',
  ].join('\n');

  const resCovered = calculateDiffCoverage({ diffText: diff, lcovText: lcovCovered, minDiffCoverage: 80 });
  assert.equal(resCovered.pct, 100);
  assert.equal(resCovered.passed, true);
  assert.equal(resCovered.uncovered.length, 0);

  const lcovUncovered = [
    'SF:src/util.js',
    'DA:1,1',
    'DA:2,0',
    'DA:3,1',
    'end_of_record',
  ].join('\n');

  const resUncovered = calculateDiffCoverage({ diffText: diff, lcovText: lcovUncovered, minDiffCoverage: 80 });
  assert.equal(resUncovered.pct, 66.67);
  assert.equal(resUncovered.passed, false);
  assert.equal(resUncovered.uncovered.length, 1);
  assert.deepEqual(resUncovered.uncovered[0], { file: 'src/util.js', line: 2, status: 'uncovered' });
});

test('calculateDiffCoverage returns 100% when no executable lines changed', () => {
  const res = calculateDiffCoverage({ diffText: '', lcovText: '' });
  assert.equal(res.pct, 100);
  assert.equal(res.passed, true);
});
