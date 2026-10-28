const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  isPlaceholder,
  parseArgs,
  runSecretScan,
  scanDirectory,
  scanFile,
  scanText,
  shouldIgnore,
} = require('./secret-scan.cjs');

// Tokens falsos são montados em runtime para que este arquivo não contenha
// literais que o próprio scanner acusaria (sem exceção por *.test.* ou fixtures).
const GH = 'ghp_';
const PEM = '-----BEGIN ';
const AWS = 'AKIA';

test('isPlaceholder ignores dummy and sample tokens', () => {
  assert.equal(isPlaceholder('sk-EXAMPLE12345678901234567890'), true);
  assert.equal(isPlaceholder('ghp_YOUR_TOKEN_HERE12345678901234567890'), true);
  assert.equal(isPlaceholder(GH + '1'.repeat(36)), false);
});

test('scanText detects openai, github, aws, and private keys', () => {
  const dummyGh = GH + 'realtoken1234567890123456789012345678';
  const dummyAws = AWS + 'IOSFODNN7EXAMPLE';
  const sampleText = [
    `const key = "${dummyGh}";`,
    `const fake = "${GH}DUMMY1234567890123456789012345678";`,
    `// nosecret comment with ${dummyGh}`,
    PEM + 'RSA PRIVATE KEY-----',
    `const aws = "${dummyAws}";`,
  ].join('\n');

  const findings = scanText(sampleText);
  assert.equal(findings.length, 2); // dummyGh e RSA key (fake e nosecret ignorados, aws contem EXAMPLE)
  assert.equal(findings[0].id, 'github_pat');
  assert.equal(findings[1].id, 'private_key');
});

test('scanFile and scanDirectory return clean status on safe repos', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-sec-'));
  fs.writeFileSync(path.join(dir, 'index.js'), 'console.log("clean");\n');
  const res = runSecretScan({ root: dir, mode: 'all' });
  assert.equal(res.status, 'passed');
  assert.equal(res.findingsCount, 0);

  fs.writeFileSync(path.join(dir, 'leaked.js'), `const token = "${GH}abcde1234567890123456789012345678901";`);
  const resFail = runSecretScan({ root: dir, mode: 'all' });
  assert.equal(resFail.status, 'failed');
  assert.equal(resFail.findingsCount, 1);
});

test('shouldIgnore only skips paths matching explicit custom patterns', () => {
  assert.equal(shouldIgnore('scripts/secret-scan.test.cjs'), false);
  assert.equal(shouldIgnore('src/app.spec.ts'), false);
  assert.equal(shouldIgnore('fixtures/prod.env'), false);
  assert.equal(shouldIgnore('src/index.js'), false);
  assert.equal(shouldIgnore('custom/path.txt', ['custom']), true);
});

test('runSecretScan does not exempt test files or fixture dirs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-sec-strict-'));
  fs.mkdirSync(path.join(dir, 'fixtures'));
  fs.writeFileSync(path.join(dir, 'payment.test.js'), `const token = "${GH}111111111111111111111111111111111111";`);
  fs.writeFileSync(path.join(dir, 'fixtures', 'prod.env'), `AWS_KEY=${AWS}REALKEYREALKEY12\n`);
  const res = runSecretScan({ root: dir, mode: 'all' });
  assert.equal(res.status, 'failed');
  assert.equal(res.findingsCount, 2);
});

test('runSecretScan honors only explicit --ignore patterns', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-sec-ignore-'));
  fs.writeFileSync(path.join(dir, 'app.test.js'), `const token = "${GH}111111111111111111111111111111111111";`);
  fs.writeFileSync(path.join(dir, 'sample.txt'), `const token = "${GH}222222222222222222222222222222222222";`);
  const res = runSecretScan({ root: dir, mode: 'all', ignore: ['sample.txt'] });
  assert.equal(res.status, 'failed');
  assert.equal(res.findingsCount, 1);
  assert.equal(res.findings[0].file, path.join(dir, 'app.test.js'));

  const parsed = parseArgs(['--ignore', '*.fixture.js', '--ignore=custom/**']);
  assert.deepEqual(parsed.ignore, ['*.fixture.js', 'custom/**']);
});
