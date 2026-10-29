'use strict';
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { run, parseArgs } = require('./ast-graph.cjs');
const { analyzeSource, loadOxcParser } = require('./lib/ast-parser.cjs');

const tempDirs = [];
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function git(dir, args) {
  return childProcess.execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// Sem teto, git sobe a arvore e acha um .git que contenha o tmp. O teto e o pai de dir.
function withGitCeiling(dir, fn) {
  const previous = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = [previous, path.dirname(dir)].filter(Boolean).join(path.delimiter);
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = previous;
  }
}

function makeRepo(files, { commit = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-graph-'));
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  git(dir, ['init', '-q']);
  git(dir, ['add', '-A']);
  if (commit) {
    git(dir, ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'base']);
  }
  return dir;
}

function writeFile(dir, rel, content) {
  fs.writeFileSync(path.join(dir, rel), content);
}

/**
 * Parser falso com o mesmo formato do oxc-parser (program.body, errors).
 * Entende só o subconjunto usado nos testes, linha a linha.
 */
function parseParams(text) {
  return text.split(',').map((p) => p.trim()).filter(Boolean).map((p) => {
    if (p.startsWith('...')) return { type: 'RestElement' };
    if (p.includes('=')) return { type: 'AssignmentPattern' };
    if (p.endsWith('?')) return { type: 'Identifier', name: p.slice(0, -1), optional: true };
    return { type: 'Identifier', name: p };
  });
}

function parseArgsList(text) {
  return text.split(',').map((a) => a.trim()).filter(Boolean).map((a) => (
    a.startsWith('...') ? { type: 'SpreadElement' } : { type: 'Literal', value: a }
  ));
}

function fakeParseSync(filename, source) {
  if (source.includes('SYNTAX_ERROR')) {
    return { program: { body: [] }, errors: [{ message: 'Unexpected token' }] };
  }
  const body = [];
  let offset = 0;
  for (const line of source.split('\n')) {
    const start = offset;
    offset += line.length + 1;
    let m;
    if ((m = /^export\s+function\s+([\w$]+)\s*\(([^)]*)\)/.exec(line))) {
      body.push({ type: 'ExportNamedDeclaration', start, source: null, specifiers: [], declaration: {
        type: 'FunctionDeclaration', id: { type: 'Identifier', name: m[1] }, params: parseParams(m[2]),
      } });
    } else if ((m = /^export\s+const\s+([\w$]+)\s*=\s*\(([^)]*)\)\s*=>/.exec(line))) {
      body.push({ type: 'ExportNamedDeclaration', start, source: null, specifiers: [], declaration: {
        type: 'VariableDeclaration', declarations: [{ id: { type: 'Identifier', name: m[1] },
          init: { type: 'ArrowFunctionExpression', params: parseParams(m[2]) } }],
      } });
    } else if ((m = /^export\s+const\s+([\w$]+)\s*=/.exec(line))) {
      body.push({ type: 'ExportNamedDeclaration', start, source: null, specifiers: [], declaration: {
        type: 'VariableDeclaration', declarations: [{ id: { type: 'Identifier', name: m[1] }, init: { type: 'Literal' } }],
      } });
    } else if ((m = /^export\s*\{([^}]*)\}(?:\s*from\s*['"]([^'"]+)['"])?/.exec(line))) {
      const specifiers = m[1].split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
        const [local, exported = local] = s.split(/\s+as\s+/).map((x) => x.trim());
        return { type: 'ExportSpecifier', local: { name: local }, exported: { name: exported } };
      });
      body.push({ type: 'ExportNamedDeclaration', start, declaration: null, specifiers,
        source: m[2] ? { value: m[2] } : null });
    } else if ((m = /^export\s*\*\s*from\s*['"]([^'"]+)['"]/.exec(line))) {
      body.push({ type: 'ExportAllDeclaration', start, source: { value: m[1] }, exported: null });
    } else if ((m = /^import\s*\*\s*as\s+([\w$]+)\s+from\s*['"]([^'"]+)['"]/.exec(line))) {
      body.push({ type: 'ImportDeclaration', start, source: { value: m[2] }, importKind: 'value',
        specifiers: [{ type: 'ImportNamespaceSpecifier', local: { name: m[1] } }] });
    } else if ((m = /^import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/.exec(line))) {
      const specifiers = m[1].split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
        const [imported, local = imported] = s.split(/\s+as\s+/).map((x) => x.trim());
        return { type: 'ImportSpecifier', imported: { name: imported }, local: { name: local } };
      });
      body.push({ type: 'ImportDeclaration', start, source: { value: m[2] }, importKind: 'value', specifiers });
    }
    if ((m = /^module\.exports\s*=\s*\{([^}]*)\}/.exec(line))) {
      const properties = m[1].split(",").map((x) => x.trim()).filter(Boolean).map((name) => ({ key: { type: "Identifier", name } }));
      body.push({ type: "ExpressionStatement", start, expression: { type: "AssignmentExpression", operator: "=",
        left: { type: "MemberExpression", computed: false, object: { type: "Identifier", name: "module" }, property: { type: "Identifier", name: "exports" } },
        right: { type: "ObjectExpression", properties } } });
    } else if ((m = /^module\.exports\s*=\s*([\w$.]+)/.exec(line))) {
      body.push({ type: "ExpressionStatement", start, expression: { type: "AssignmentExpression", operator: "=",
        left: { type: "MemberExpression", computed: false, object: { type: "Identifier", name: "module" }, property: { type: "Identifier", name: "exports" } },
        right: { type: "Identifier", name: m[1] } } });
    }
    // chamadas: identificador(...) fora de declaração "function NAME(", e obj.metodo(...)
    const callRe = /(?<![\w$.])(?<!function\s)([A-Za-z_$][\w$]*)\(([^()]*)\)/g;
    let c;
    while ((c = callRe.exec(line)) !== null) {
      body.push({ type: 'ExpressionStatement', start: start + c.index, expression: {
        type: 'CallExpression', start: start + c.index, callee: { type: 'Identifier', name: c[1] },
        arguments: parseArgsList(c[2]),
      } });
    }
    const memberRe = /(?<![\w$.])([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\(([^()]*)\)/g;
    while ((c = memberRe.exec(line)) !== null) {
      body.push({ type: 'ExpressionStatement', start: start + c.index, expression: {
        type: 'CallExpression', start: start + c.index,
        callee: { type: 'MemberExpression', computed: false, object: { type: 'Identifier', name: c[1] }, property: { type: 'Identifier', name: c[2] } },
        arguments: parseArgsList(c[3]),
      } });
    }
  }
  return { program: { body }, errors: [] };
}

const fakeParser = { parseSync: fakeParseSync };
const injected = () => ({ parser: fakeParser, version: 'fake', error: null });
const skippedLoader = () => ({ parser: null, version: null, error: 'módulo não encontrado' });

function runOn(dir, extra = [], deps = {}) {
  return run(['--root', dir, ...extra], { loadParser: injected, ...deps });
}

describe('lib/ast-parser analyzeSource (parser injetado)', () => {
  test('extrai exports, imports com especificadores e linhas, e chamadas', () => {
    const source = [
      "import { foo as bar, baz } from './dep';",
      'export function run(a, b = 1) {',
      '  return bar(a);',
      '}',
      'export const add = (x, y) => x;',
      "export { run as runAlias } from './other';",
      'lib.call(1, 2);',
    ].join('\n');
    const r = analyzeSource(source, { filename: 'src/x.js', parser: fakeParser });
    assert.equal(r.ok, true);
    const names = r.exports.map((e) => `${e.name}:${e.kind}`);
    assert.deepEqual(names, ['run:function', 'add:variable', 'runAlias:reexport']);
    assert.deepEqual(r.exports[0].arity, { min: 1, max: 2 });
    assert.deepEqual(r.imports[0].specifiers.map((s) => [s.imported, s.local]), [['foo', 'bar'], ['baz', 'baz']]);
    assert.equal(r.imports[0].line, 1);
    const bar = r.calls.find((c) => c.callee === 'bar');
    assert.equal(bar.line, 3);
    assert.equal(bar.argc, 1);
    const member = r.calls.find((c) => c.kind === 'member');
    assert.deepEqual([member.object, member.callee, member.line], ['lib', 'call', 7]);
  });

  test('erro de sintaxe vira resultado com ok=false, sem lançar', () => {
    const r = analyzeSource('SYNTAX_ERROR', { filename: 'bad.js', parser: fakeParser });
    assert.equal(r.ok, false);
    assert.match(r.error, /Unexpected token/);
  });

  test('parser que lança vira ok=false', () => {
    const throwing = { parseSync() { throw new Error('boom'); } };
    const r = analyzeSource('export const a = 1;', { filename: 'a.js', parser: throwing });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'boom');
  });
});

describe('ast-graph run', () => {
  test('renomear export sem atualizar o importador gera exatamente uma violação em b.js', () => {
    const dir = makeRepo({
      'a.js': 'export function foo(x) {\n  return x;\n}\n',
      'b.js': "import { foo } from './a.js';\nfoo(1);\n",
    });
    writeFile(dir, 'a.js', 'export function renamed(x) {\n  return x;\n}\n');
    const result = runOn(dir, ['--json']);
    assert.equal(result.exitCode, 0);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, 'violations');
    assert.equal(report.violations.length, 1);
    const [v] = report.violations;
    assert.equal(v.file, 'b.js');
    assert.equal(v.type, 'missing-export');
    assert.equal(v.symbol, 'foo');
    assert.equal(v.line, 1);
  });

  test('com --strict, violação devolve exit 1', () => {
    const dir = makeRepo({
      'a.js': 'export function foo() {}\n',
      'b.js': "import { foo } from './a.js';\n",
    });
    writeFile(dir, 'a.js', 'export function bar() {}\n');
    assert.equal(runOn(dir, ['--strict']).exitCode, 1);
    assert.equal(runOn(dir, []).exitCode, 0);
  });

  test('sem quebra, status ok e nenhuma violação', () => {
    const dir = makeRepo({
      'a.js': 'export function foo(x) {\n  return x;\n}\n',
      'b.js': "import { foo as f } from './a.js';\nf(1);\n",
    });
    const report = JSON.parse(runOn(dir, ['--json']).stdout);
    assert.equal(report.status, 'ok');
    assert.deepEqual(report.violations, []);
  });

  test('re-export com alias: quebra no barrel e no importador do barrel', () => {
    const dir = makeRepo({
      'a.js': 'export function foo() {}\n',
      'barrel.js': "export { foo as bar } from './a.js';\n",
      'c.js': "import { bar } from './barrel.js';\nbar();\n",
    });
    writeFile(dir, 'a.js', 'export function baz() {}\n');
    const report = JSON.parse(runOn(dir, ['--json']).stdout);
    const pairs = report.violations.map((v) => `${v.file}:${v.type}`);
    assert.deepEqual(pairs, ['barrel.js:missing-export', 'c.js:missing-export']);
  });

  test('import com alias e namespace (ns.foo()) também são checados', () => {
    const dir = makeRepo({
      'a.js': 'export function foo() {}\n',
      'b.js': "import { foo as f } from './a.js';\nf();\n",
      'c.js': "import * as lib from './a.js';\nlib.foo();\n",
    });
    writeFile(dir, 'a.js', 'export function other() {}\n');
    const report = JSON.parse(runOn(dir, ['--json']).stdout);
    assert.deepEqual(report.violations.map((v) => `${v.file}:${v.symbol}`), ['b.js:foo', 'c.js:foo']);
  });

  test('arquivo que não parseia vira aviso, não crash, e não gera violação contra ele', () => {
    const dir = makeRepo({
      'a.js': 'export function foo() {}\n',
      'broken.js': 'SYNTAX_ERROR\n',
      'b.js': "import { nada } from './broken.js';\nimport { foo } from './a.js';\n",
    });
    writeFile(dir, 'a.js', 'export function foo() {}\n');
    const result = runOn(dir, ['--json']);
    assert.equal(result.exitCode, 0);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, 'ok');
    assert.deepEqual(report.warnings.map((w) => w.file), ['broken.js']);
    assert.deepEqual(report.violations, []);
  });

  test('arquivos de teste e node_modules ficam fora do grafo', () => {
    const dir = makeRepo({
      'a.js': 'export function foo() {}\n',
      'a.test.js': "import { foo } from './a.js';\n",
      'node_modules/pkg/index.js': "import { foo } from '../../a.js';\n",
      'dist/x.js': "import { foo } from '../a.js';\n",
    });
    writeFile(dir, 'a.js', 'export function gone() {}\n');
    const report = JSON.parse(runOn(dir, ['--json']).stdout);
    assert.equal(report.filesListed, 1);
    assert.deepEqual(report.violations, []);
  });

  test('parser ausente: status skipped, exit 0, com instrução', () => {
    const dir = makeRepo({ 'a.js': 'export const x = 1;\n' });
    const result = run(['--root', dir, '--json'], { loadParser: skippedLoader });
    assert.equal(result.exitCode, 0);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, 'skipped');
    assert.match(report.message, /oxc-parser não instalado/);
    assert.match(report.message, /npm install/);
  });

  test('--base: mudança de aridade quebra chamadas incompatíveis', () => {
    const dir = makeRepo({
      'a.js': 'export function f(a, b) {\n  return a + b;\n}\n',
      'b.js': "import { f } from './a.js';\nf(1, 2);\nf(1);\n",
    }, { commit: true });
    writeFile(dir, 'a.js', 'export function f(a) {\n  return a;\n}\n');
    const report = JSON.parse(runOn(dir, ['--base', 'HEAD', '--json']).stdout);
    assert.equal(report.status, 'violations');
    assert.equal(report.violations.length, 1);
    const [v] = report.violations;
    assert.equal(v.type, 'arity-mismatch');
    assert.equal(v.file, 'b.js');
    assert.equal(v.line, 2);
  });

  test('saída JSON é determinística entre execuções (exceto tempo)', () => {
    const dir = makeRepo({
      'a.js': 'export function foo() {}\n',
      'b.js': "import { foo } from './a.js';\n",
      'c.js': "import { foo } from './a.js';\n",
    });
    writeFile(dir, 'a.js', 'export function bar() {}\n');
    const strip = (s) => {
      const r = JSON.parse(s);
      delete r.durationMs;
      return r;
    };
    assert.deepEqual(strip(runOn(dir, ['--json']).stdout), strip(runOn(dir, ['--json']).stdout));
  });

  test('erros de configuração devolvem exit 2', () => {
    const dir = makeRepo({ 'a.js': 'export const x = 1;\n' });
    assert.equal(runOn(dir, ['--nao-existe']).exitCode, 2);
    assert.equal(runOn(dir, ['--root']).exitCode, 2);
    assert.equal(runOn(dir, ['--base', 'ref-que-nao-existe']).exitCode, 2);
    const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-graph-norepo-'));
    tempDirs.push(notRepo);
    assert.equal(withGitCeiling(notRepo, () => run(['--root', notRepo], { loadParser: injected }).exitCode), 2);
  });

  test('--root sem repo continua exit 2 mesmo com tmp aninhado sob diretorio com .git', () => {
    const parent = makeRepo({ 'a.js': 'export const x = 1;\n' });
    const nested = fs.mkdtempSync(path.join(parent, 'ast-graph-nested-'));
    assert.equal(withGitCeiling(nested, () => run(['--root', nested], { loadParser: injected }).exitCode), 2);
  });

  test('CommonJS: export nomeado de .cjs é checado; module.exports não literal fica opaco', () => {
    const dir = makeRepo({
      'lib.cjs': 'function foo() {}\nmodule.exports = { foo };\n',
      'opaque.cjs': 'module.exports = loadSomething();\n',
      'b.js': "import { foo } from './lib.cjs';\nimport { anything } from './opaque.cjs';\nimport def from './lib.cjs';\n",
    });
    writeFile(dir, 'lib.cjs', 'function bar() {}\nmodule.exports = { bar };\n');
    const report = JSON.parse(runOn(dir, ['--json']).stdout);
    assert.deepEqual(report.violations.map((v) => `${v.file}:${v.symbol}`), ['b.js:foo']);
  });

  test('parseArgs aceita --root=valor e rejeita valor em flag booleana', () => {
    assert.equal(parseArgs(['--root=/tmp/x']).root, '/tmp/x');
    assert.throws(() => parseArgs(['--json=1']), /não aceita valor/);
  });
});

describe('ast-graph com oxc-parser real', () => {
  const real = loadOxcParser();
  const realAvailable = Boolean(real.parser);

  test('renomeação detectada com o parser real (pulado se oxc-parser não instalado)', { skip: !realAvailable }, () => {
    const dir = makeRepo({
      'a.ts': 'export function foo(x: number): number {\n  return x;\n}\n',
      'b.ts': "import { foo } from './a.js';\nexport const v = foo(1);\n",
    });
    writeFile(dir, 'a.ts', 'export function renamed(x: number): number {\n  return x;\n}\n');
    const result = run(['--root', dir, '--json'], { loadParser: () => real });
    const report = JSON.parse(result.stdout);
    assert.equal(report.parser.name, 'oxc-parser');
    assert.deepEqual(report.violations.map((v) => `${v.file}:${v.symbol}`), ['b.ts:foo']);
  });
});
