const assert = require('node:assert/strict');
const test = require('node:test');

const {
  auditLicenses,
  extractNodeLicenses,
} = require('./license-audit.cjs');

test('extractNodeLicenses parses lockfile packages', () => {
  const lock = {
    packages: {
      '': { name: 'root' },
      'node_modules/pkg-a': { name: 'pkg-a', version: '1.0.0', license: 'MIT' },
      'node_modules/pkg-b': { name: 'pkg-b', version: '2.0.0', license: 'GPL-3.0' },
    }
  };
  const deps = extractNodeLicenses(lock);
  assert.equal(deps.length, 2);
  assert.equal(deps[0].name, 'pkg-a');
});

test('auditLicenses approves permissive licenses and blocks copyleft/unknown', () => {
  const deps = [
    { name: 'a', version: '1.0.0', license: 'MIT' },
    { name: 'b', version: '1.0.0', license: 'Apache-2.0' },
    { name: 'c', version: '1.0.0', license: 'GPL-3.0' },
  ];
  const res = auditLicenses(deps);
  assert.equal(res.status, 'failed');
  assert.equal(res.approvedCount, 2);
  assert.equal(res.violationsCount, 1);
  assert.match(res.violations[0].reason, /proibida/);
});
