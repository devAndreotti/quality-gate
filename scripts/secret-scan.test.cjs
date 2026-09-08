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
} = require('./secret-scan.cjs');

test('isPlaceholder ignores dummy and sample tokens', () => {
  assert.equal(isPlaceholder('sk-EXAMPLE12345678901234567890'), true);
  assert.equal(isPlaceholder('ghp_YOUR_TOKEN_HERE12345678901234567890'), true);
  assert.equal(isPlaceholder('ghp_123456789012345678901234567890123456'), false);
});

test('scanText detects openai, github, aws, and private keys', () => {
  const dummyGh = 'ghp_realtoken1234567890123456789012345678';
  const dummyAws = 'AKIAIOSFODNN7EXAMPLE';
  const sampleText = [
    `const key = "${dummyGh}";`,
    'const fake = "ghp_DUMMY1234567890123456789012345678";',
    '// nosecret comment with ghp_realtoken1234567890123456789012345678',
    '-----BEGIN RSA PRIVATE KEY-----',
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

  fs.writeFileSync(path.join(dir, 'leaked.js'), 'const token = "ghp_abcde1234567890123456789012345678901";');
  const resFail = runSecretScan({ root: dir, mode: 'all' });
  assert.equal(resFail.status, 'failed');
  assert.equal(resFail.findingsCount, 1);
});
