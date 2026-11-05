const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isCodeChange, isEligible, parseArgs, rng, selectSample, main } = require('./eval-sample.cjs');

const pr = (number, files, hadFailure) => ({
  number,
  title: `pr ${number}`,
  mergedAt: '2026-01-01',
  files: files.map((p) => ({ path: p })),
  hadFailure,
});

test('isCodeChange accepts production JS/TS and rejects tests, build output and docs', () => {
  assert.equal(isCodeChange('scripts/a.cjs'), true);
  assert.equal(isCodeChange('src/app.tsx'), true);
  assert.equal(isCodeChange('scripts/a.test.cjs'), false);
  assert.equal(isCodeChange('dist/x.js'), false);
  assert.equal(isCodeChange('README.md'), false);
});

test('isEligible requires at least one production code file', () => {
  assert.equal(isEligible(pr(1, ['README.md'], false)), false);
  assert.equal(isEligible(pr(2, [], false)), false);
  assert.equal(isEligible(pr(3, ['docs/a.md', 'scripts/x.cjs'], false)), true);
});

test('rng is deterministic for the same seed and differs across seeds', () => {
  const a = rng(7);
  const b = rng(7);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
  assert.notEqual(rng(7)(), rng(8)());
  const v = rng(3)();
  assert.ok(v >= 0 && v < 1);
});

test('selectSample is stratified: half with failures, half without, when both exist', () => {
  const prs = [
    ...Array.from({ length: 10 }, (_, i) => pr(i + 1, ['a.cjs'], true)),
    ...Array.from({ length: 10 }, (_, i) => pr(i + 101, ['a.cjs'], false)),
  ];
  const sample = selectSample(prs, { size: 10, seed: 42 });
  assert.equal(sample.length, 10);
  assert.equal(sample.filter((s) => s.hadFailure).length, 5);
  assert.equal(new Set(sample.map((s) => s.number)).size, 10);
});

test('selectSample is reproducible with the same seed', () => {
  const prs = Array.from({ length: 20 }, (_, i) => pr(i + 1, ['a.cjs'], i % 3 === 0));
  assert.deepEqual(selectSample(prs, { size: 6, seed: 9 }), selectSample(prs, { size: 6, seed: 9 }));
});

test('selectSample ignores ineligible PRs and returns fewer when there are not enough', () => {
  const prs = [pr(1, ['README.md'], true), pr(2, ['a.cjs'], false), pr(3, ['a.cjs'], true)];
  const sample = selectSample(prs, { size: 10, seed: 1 });
  assert.deepEqual(sample.map((s) => s.number).sort(), [2, 3]);
});

test('parseArgs validates repo and size', () => {
  assert.equal(parseArgs(['--repo', 'a/b', '--size', '6']).size, 6);
  assert.throws(() => parseArgs(['--repo', 'semdono']), /dono\/repo/);
  assert.throws(() => parseArgs(['--repo', 'a/b', '--size', '1']), /inteiro/);
});

test('main with injected PRs writes the sample to the requested file, and dry-run writes nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-eval-'));
  const out = path.join(dir, 'nested', 's.json');
  const prs = Array.from({ length: 6 }, (_, i) => pr(i + 1, ['a.cjs'], i < 3));
  const r = main(['--repo', 'a/b', '--size', '4', '--out', out], { prs });
  assert.equal(r.code, 0);
  const saved = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(saved.sample.length, 4);
  assert.equal(saved.eligibleCount, 6);
  const dry = path.join(dir, 'dry.json');
  main(['--repo', 'a/b', '--size', '4', '--out', dry], { prs, dryRun: true });
  assert.equal(fs.existsSync(dry), false);
});

test('main fetches from gh through the injected exec and parses its JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-eval-gh-'));
  const calls = [];
  const exec = (file, args) => {
    calls.push(args.join(' '));
    if (args[0] === 'pr')
      return JSON.stringify([{ number: 5, title: 't', mergedAt: 'x', headRefOid: 'abc' }]);
    if (args.some((a) => a.includes('/files'))) return '[{"path":"scripts/a.cjs"}]';
    return '[{"conclusion":"failure"}]';
  };
  const out = path.join(dir, 's.json');
  main(['--repo', 'a/b', '--size', '2', '--out', out], { exec });
  const saved = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(saved.sample[0].hadFailure, true);
  assert.ok(calls.some((c) => c.includes('check-runs')));
});
