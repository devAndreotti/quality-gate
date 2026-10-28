const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  evaluateBoundaries,
  extractImports,
  globToRegExp,
  matchesGlob,
  resolveRelativeImport,
} = require('./lib/boundary-rules.cjs');
const { readConfig, runBoundaryGate, validateRules } = require('./boundary-gate.cjs');

const RULE = { from: 'src/domain/**', disallow: ['src/infra/**', 'src/controllers/**'] };

test('globToRegExp: ** atravessa diretórios e * não atravessa', () => {
  assert.equal(matchesGlob('src/domain/user/entity.js', 'src/domain/**'), true);
  assert.equal(matchesGlob('src/domain.js', 'src/domain/**'), false);
  assert.equal(matchesGlob('src/a/b.js', 'src/*.js'), false);
  assert.equal(matchesGlob('src/a.js', 'src/*.js'), true);
  assert.equal(globToRegExp('a.b').test('aXb'), false);
});

test('extractImports finds import, export-from, require and dynamic import with line numbers', () => {
  const src = [
    "import x from './a';",
    "import type { T } from '../b';",
    "export { y } from './c';",
    "const z = require('./d');",
    "const w = await import('./e');",
  ].join('\n');
  const found = extractImports(src);
  assert.deepEqual(found.map((f) => f.specifier), ['./a', '../b', './c', './d', './e']);
  assert.deepEqual(found.map((f) => f.line), [1, 2, 3, 4, 5]);
});

test('extractImports detects multiline imports', () => {
  const src = "import {\n  a,\n  b,\n} from '../infra/db';";
  const found = extractImports(src);
  assert.equal(found.length, 1);
  assert.equal(found[0].specifier, '../infra/db');
  assert.equal(found[0].line, 1);
});

test('resolveRelativeImport resolves relative paths and ignores packages', () => {
  assert.equal(resolveRelativeImport('src/domain/user.js', '../infra/db'), 'src/infra/db');
  assert.equal(resolveRelativeImport('src/domain/user.js', './entity'), 'src/domain/entity');
  assert.equal(resolveRelativeImport('src/domain/user.js', 'lodash'), null);
});

test('evaluateBoundaries flags domain importing infra', () => {
  const files = [
    { file: 'src/domain/user.js', content: "import { db } from '../infra/db';" },
    { file: 'src/infra/db.js', content: "import { user } from '../domain/user';" },
  ];
  const v = evaluateBoundaries({ files, rules: [RULE] });
  assert.equal(v.length, 1);
  assert.equal(v[0].file, 'src/domain/user.js');
  assert.equal(v[0].line, 1);
  assert.equal(v[0].resolved, 'src/infra/db');
});

test('evaluateBoundaries allows domain importing domain and resolves index files', () => {
  const files = [
    { file: 'src/domain/user.js', content: "import { e } from './entity';\nimport { u } from './util/index';" },
  ];
  assert.deepEqual(evaluateBoundaries({ files, rules: [RULE] }), []);

  const indexed = [{ file: 'src/domain/order.js', content: "import { r } from '../controllers';" }];
  const v = evaluateBoundaries({ files: indexed, rules: [RULE] });
  assert.equal(v.length, 1);
  assert.equal(v[0].resolved, 'src/controllers/index.js');
});

test('evaluateBoundaries catches a multiline violation at the import line', () => {
  const files = [{ file: 'src/domain/user.js', content: "const a = 1;\nimport {\n  db,\n} from '../infra/db';" }];
  const v = evaluateBoundaries({ files, rules: [RULE] });
  assert.equal(v.length, 1);
  assert.equal(v[0].line, 2);
});

test('validateRules rejects malformed rules', () => {
  assert.equal(validateRules('x'), 'rules deve ser uma lista');
  assert.match(validateRules([{ disallow: ['a'] }]), /from ausente/);
  assert.match(validateRules([{ from: 'a', disallow: [] }]), /disallow/);
  assert.equal(validateRules([RULE]), null);
});

test('runBoundaryGate is skipped when disabled or without rules', () => {
  assert.equal(runBoundaryGate({ config: { enabled: false, rules: [RULE] } }).status, 'skipped');
  assert.equal(runBoundaryGate({ config: { enabled: true, rules: [] } }).status, 'skipped');
});

test('runBoundaryGate reports error on invalid rules', () => {
  const r = runBoundaryGate({ config: { enabled: true, rules: [{ from: '' }] }, files: [], contents: {} });
  assert.equal(r.status, 'error');
});

test('runBoundaryGate fails blocking and is advisory when blockOnFailure is false', () => {
  const files = ['src/domain/user.js'];
  const contents = { 'src/domain/user.js': "import { db } from '../infra/db';" };
  const blocking = runBoundaryGate({ config: { enabled: true, rules: [RULE] }, files, contents });
  assert.equal(blocking.status, 'failed');
  assert.equal(blocking.violations.length, 1);
  const advisory = runBoundaryGate({ config: { enabled: true, blockOnFailure: false, rules: [RULE] }, files, contents });
  assert.equal(advisory.status, 'advisory');
});

test('runBoundaryGate passes when there are no violations', () => {
  const r = runBoundaryGate({
    config: { enabled: true, rules: [RULE] },
    files: ['src/domain/user.js'],
    contents: { 'src/domain/user.js': "import { e } from './entity';" },
  });
  assert.equal(r.status, 'passed');
});

test('runBoundaryGate fails closed when git ls-files cannot run', () => {
  const r = runBoundaryGate({
    config: { enabled: true, rules: [RULE] },
    execFileSync: () => { throw new Error('fatal: not a git repository'); },
  });
  assert.equal(r.status, 'error');
  assert.match(r.reason, /git ls-files falhou/);
});

test('readConfig reads ci.architectureBoundary from policy.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-boundary-'));
  const policyPath = path.join(dir, 'policy.json');
  fs.writeFileSync(policyPath, JSON.stringify({ ci: { architectureBoundary: { enabled: true, rules: [RULE] } } }));
  const c = readConfig(policyPath);
  assert.equal(c.enabled, true);
  assert.equal(c.blockOnFailure, true);
  assert.deepEqual(c.rules, [RULE]);
  assert.equal(readConfig(path.join(dir, 'missing.json')).enabled, false);
});
