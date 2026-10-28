'use strict';
/**
 * ast-parser.cjs — extrai exports, imports e chamadas de um arquivo JS/TS.
 *
 * O parser (oxc-parser, versão fixada em package.json > optionalDependencies)
 * é carregado sob demanda. Se não estiver instalado, loadOxcParser() devolve
 * { parser: null, error } em vez de lançar: o chamador reporta "skipped".
 * O parser pode ser injetado (testes) desde que exponha parseSync(filename, source, options)
 * no mesmo formato do oxc-parser: { program: { body }, errors }.
 */
const { createRequire } = require('node:module');
const path = require('node:path');

const PARSER_PACKAGE = 'oxc-parser';

const LANG_BY_EXT = {
  '.ts': 'ts',
  '.mts': 'ts',
  '.cts': 'ts',
  '.tsx': 'tsx',
  '.jsx': 'jsx',
  '.js': 'jsx',
  '.mjs': 'jsx',
  '.cjs': 'jsx',
};

/**
 * Carrega oxc-parser. Tenta primeiro a partir de basedir (repo alvo), depois a partir
 * deste pacote. Nunca lança.
 * @returns {{ parser: object|null, version: string|null, error: string|null }}
 */
function loadOxcParser({ basedir } = {}) {
  const loaders = [];
  if (basedir) {
    loaders.push(() => createRequire(path.join(basedir, 'noop.cjs'))(PARSER_PACKAGE));
  }
  loaders.push(() => require(PARSER_PACKAGE));

  let lastError = null;
  for (const load of loaders) {
    try {
      const mod = load();
      if (mod && typeof mod.parseSync === 'function') {
        return { parser: mod, version: readParserVersion(basedir), error: null };
      }
      lastError = 'módulo carregado não expõe parseSync';
    } catch (err) {
      lastError = err && err.code === 'MODULE_NOT_FOUND' ? 'módulo não encontrado' : (err && err.message) || String(err);
    }
  }
  return { parser: null, version: null, error: lastError };
}

function readParserVersion(basedir) {
  for (const load of [basedir && (() => createRequire(path.join(basedir, 'noop.cjs'))(`${PARSER_PACKAGE}/package.json`)), () => require(`${PARSER_PACKAGE}/package.json`)]) {
    if (!load) continue;
    try {
      return load().version || null;
    } catch {
      // tenta o próximo caminho
    }
  }
  return null;
}

function makeLineResolver(source) {
  const newlines = [];
  for (let i = 0; i < source.length; i += 1) {
    if (source.charCodeAt(i) === 10) newlines.push(i);
  }
  return (offset) => {
    let lo = 0;
    let hi = newlines.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (newlines[mid] < offset) lo = mid + 1;
      else hi = mid;
    }
    return lo + 1;
  };
}

function nameOf(node) {
  if (!node) return null;
  if (typeof node.name === 'string') return node.name;
  if (typeof node.value === 'string') return node.value;
  return null;
}

/** Aridade de uma função: mínimo de argumentos obrigatórios e máximo (Infinity com rest). */
function arityOf(fn) {
  if (!fn || !Array.isArray(fn.params)) return null;
  let min = 0;
  let max = fn.params.length;
  let optionalStarted = false;
  for (const p of fn.params) {
    if (p.type === 'RestElement') {
      max = Infinity;
      optionalStarted = true;
      continue;
    }
    if (p.type === 'AssignmentPattern' || p.optional === true) optionalStarted = true;
    if (!optionalStarted) min += 1;
  }
  return { min, max };
}

function isFunctionNode(node) {
  return Boolean(node) && ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type);
}

function declarationEntries(decl, line) {
  if (!decl) return [];
  switch (decl.type) {
    case 'FunctionDeclaration':
      return [{ name: nameOf(decl.id), line, kind: 'function', arity: arityOf(decl) }];
    case 'ClassDeclaration':
      return [{ name: nameOf(decl.id), line, kind: 'class', arity: null }];
    case 'VariableDeclaration':
      return (decl.declarations || [])
        .filter((d) => d.id && d.id.type === 'Identifier')
        .map((d) => ({
          name: d.id.name,
          line,
          kind: 'variable',
          arity: isFunctionNode(d.init) ? arityOf(d.init) : null,
        }));
    case 'TSInterfaceDeclaration':
    case 'TSTypeAliasDeclaration':
      return [{ name: nameOf(decl.id), line, kind: 'type', arity: null }];
    case 'TSEnumDeclaration':
      return [{ name: nameOf(decl.id), line, kind: 'enum', arity: null }];
    default:
      return [];
  }
}

/**
 * Percorre a árvore uma vez, coletando chamadas e exports CommonJS.
 * CJS: `module.exports = { a, b }`, `exports.x = ...`, `module.exports.x = ...`.
 * Qualquer `module.exports = <não-literal>` ou `export =` (TS) marca o arquivo como opaco.
 */
function isModuleExports(node) {
  return Boolean(node) && node.type === 'MemberExpression' && !node.computed
    && node.object && node.object.type === 'Identifier' && node.object.name === 'module'
    && node.property && node.property.type === 'Identifier' && node.property.name === 'exports';
}

function walkTree(program, lineOf) {
  const calls = [];
  const cjsNames = [];
  let cjsOpaque = false;
  const stack = [program];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (const child of node) stack.push(child);
      continue;
    }
    if (node.type === 'TSExportAssignment') cjsOpaque = true;
    if (node.type === 'AssignmentExpression' && node.operator === '=' && node.left && node.left.type === 'MemberExpression') {
      const target = node.left;
      const line = lineOf(node.start || 0);
      const plainProp = target.property && target.property.type === 'Identifier' && !target.computed;
      if (isModuleExports(target)) {
        // module.exports = ...
        if (node.right && node.right.type === 'ObjectExpression') {
          for (const prop of node.right.properties || []) {
            const key = prop.key && (prop.key.type === 'Identifier' ? prop.key.name : prop.key.value);
            if (typeof key === 'string') cjsNames.push({ name: key, line });
            else cjsOpaque = true;
          }
        } else {
          cjsOpaque = true;
        }
      } else if (plainProp && target.object && target.object.type === 'Identifier' && target.object.name === 'exports') {
        // exports.x = ...
        cjsNames.push({ name: target.property.name, line });
      } else if (plainProp && isModuleExports(target.object)) {
        // module.exports.x = ...
        cjsNames.push({ name: target.property.name, line });
      }
    }
    if (node.type === 'CallExpression') {
      const args = node.arguments || [];
      const base = {
        line: lineOf(node.start || 0),
        argc: args.length,
        spread: args.some((a) => a.type === 'SpreadElement'),
      };
      const callee = node.callee;
      if (callee && callee.type === 'Identifier') {
        calls.push({ ...base, kind: 'identifier', callee: callee.name, object: null });
      } else if (callee && callee.type === 'MemberExpression' && !callee.computed
        && callee.object && callee.object.type === 'Identifier' && callee.property && callee.property.type === 'Identifier') {
        calls.push({ ...base, kind: 'member', callee: callee.property.name, object: callee.object.name });
      }
    }
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (value && typeof value === 'object') stack.push(value);
    }
  }
  return { calls, cjsNames, cjsOpaque };
}

/**
 * Analisa um arquivo. Nunca lança: erro de parse vira { ok: false, error }.
 * @param {string} source
 * @param {{ filename?: string, parser: { parseSync: Function } }} options
 * @returns {{ ok: boolean, error: string|null, exports: object[], imports: object[], calls: object[] }}
 */
function analyzeSource(source, { filename = 'input.js', parser } = {}) {
  if (!parser || typeof parser.parseSync !== 'function') {
    throw new TypeError('analyzeSource: parser precisa expor parseSync');
  }
  const empty = { ok: false, error: null, exports: [], imports: [], calls: [] };
  let result;
  try {
    const ext = path.extname(filename).toLowerCase();
    result = parser.parseSync(filename, source, { sourceType: 'module', lang: LANG_BY_EXT[ext] || 'jsx' });
  } catch (err) {
    return { ...empty, error: (err && err.message) || String(err) };
  }
  if (!result || !result.program || !Array.isArray(result.program.body)) {
    return { ...empty, error: 'resultado do parser sem program.body' };
  }
  if (Array.isArray(result.errors) && result.errors.length > 0) {
    const first = result.errors[0];
    return { ...empty, error: (first && (first.message || first.msg)) || 'erro de sintaxe' };
  }

  const lineOf = makeLineResolver(source);
  const body = result.program.body;
  const walked = walkTree(body, lineOf);
  const exportsOut = [];
  const imports = [];

  // Arídade de funções declaradas no topo, para `export { f }` sem source.
  const localArity = new Map();
  for (const stmt of body) {
    if (stmt.type === 'FunctionDeclaration' && nameOf(stmt.id)) {
      localArity.set(nameOf(stmt.id), arityOf(stmt));
    } else if (stmt.type === 'VariableDeclaration') {
      for (const d of stmt.declarations || []) {
        if (d.id && d.id.type === 'Identifier' && isFunctionNode(d.init)) localArity.set(d.id.name, arityOf(d.init));
      }
    }
  }

  for (const stmt of body) {
    const line = lineOf(stmt.start || 0);
    if (stmt.type === 'ImportDeclaration') {
      const specifiers = (stmt.specifiers || []).map((s) => {
        if (s.type === 'ImportDefaultSpecifier') return { kind: 'default', imported: 'default', local: nameOf(s.local) };
        if (s.type === 'ImportNamespaceSpecifier') return { kind: 'namespace', imported: '*', local: nameOf(s.local) };
        return { kind: 'named', imported: nameOf(s.imported), local: nameOf(s.local) };
      });
      imports.push({
        source: stmt.source && stmt.source.value,
        line,
        typeOnly: stmt.importKind === 'type',
        specifiers,
      });
    } else if (stmt.type === 'ExportNamedDeclaration') {
      const from = stmt.source ? stmt.source.value : null;
      if (stmt.declaration) {
        for (const entry of declarationEntries(stmt.declaration, line)) {
          exportsOut.push({ ...entry, from: null });
        }
      }
      for (const spec of stmt.specifiers || []) {
        const exported = nameOf(spec.exported);
        if (!exported) continue;
        if (from) {
          exportsOut.push({ name: exported, line, kind: 'reexport', from, imported: nameOf(spec.local), arity: null });
        } else {
          const local = nameOf(spec.local);
          exportsOut.push({ name: exported, line, kind: 'local', from: null, imported: local, arity: localArity.get(local) || null });
        }
      }
    } else if (stmt.type === 'ExportDefaultDeclaration') {
      const decl = stmt.declaration;
      const arity = isFunctionNode(decl) ? arityOf(decl) : null;
      exportsOut.push({ name: 'default', line, kind: 'default', from: null, arity });
    } else if (stmt.type === 'ExportAllDeclaration') {
      const exported = nameOf(stmt.exported);
      if (exported) {
        exportsOut.push({ name: exported, line, kind: 'reexport', from: stmt.source.value, imported: '*', arity: null });
      } else {
        exportsOut.push({ name: null, line, kind: 'star', from: stmt.source.value, arity: null });
      }
    }
  }

  return {
    ok: true,
    error: null,
    exports: exportsOut,
    imports,
    cjs: { names: walked.cjsNames, opaque: walked.cjsOpaque },
    calls: walked.calls,
  };
}

module.exports = { loadOxcParser, analyzeSource, arityOf, PARSER_PACKAGE, LANG_BY_EXT };
