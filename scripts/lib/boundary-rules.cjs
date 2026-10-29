// boundary-rules.cjs — regras de fronteira entre camadas, sem dependências externas.
// Extração de imports por regex: cobre import/export-from, require e import() dinâmico com
// string literal. Não cobre imports calculados em tempo de execução.
const path = require('node:path');

const SOURCE_EXTENSIONS = ['.js', '.cjs', '.mjs', '.jsx', '.ts', '.tsx'];

const IMPORT_PATTERNS = [
  /\bimport\s+(?:type\s+)?(?:[^'"`;]*?\s+from\s+)?['"]([^'"]+)['"]/g,
  /\bexport\s+(?:type\s+)?[^'"`;]*?\s+from\s+['"]([^'"]+)['"]/g,
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
];

// Converte glob simples em RegExp: ** atravessa diretórios, * não atravessa.
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
      if (glob[i + 1] === '/') i++;
    } else if (ch === '*') {
      re += '[^/]*';
    } else if (ch === '?') {
      re += '[^/]';
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp('^' + re + '$');
}

function matchesGlob(file, glob) {
  return globToRegExp(glob).test(normalize(file));
}

function normalize(file) {
  return String(file).replace(/\\/g, '/').replace(/^\.\//, '');
}

// Retorna [{ specifier, line }] varrendo o texto inteiro, para pegar imports
// multilinha (ex.: "import {\n a,\n} from './x'").
function extractImports(sourceText) {
  const text = String(sourceText || '');
  const found = [];
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const line = text.slice(0, match.index).split('\n').length;
      found.push({ specifier: match[1], line });
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

// Resolve import relativo para caminho relativo à raiz do projeto.
// Imports de pacote (sem ./ ou ../) retornam null: não são fronteira interna.
function resolveRelativeImport(fromFile, specifier) {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null;
  const base = path.posix.join(path.posix.dirname(normalize(fromFile)), specifier);
  return normalize(path.posix.normalize(base));
}

// Lista de candidatos de arquivo real para um caminho resolvido (com e sem extensão, index).
function candidatePaths(resolved) {
  const candidates = [resolved];
  for (const ext of SOURCE_EXTENSIONS) candidates.push(resolved + ext);
  for (const ext of SOURCE_EXTENSIONS) candidates.push(path.posix.join(resolved, 'index' + ext));
  return candidates;
}

// Avalia uma lista de arquivos-fonte contra as regras.
// files: [{ file, content }]. Retorna violações com arquivo, linha e import.
function evaluateBoundaries({ files, rules }) {
  const violations = [];
  for (const rule of rules || []) {
    const disallow = rule.disallow || [];
    for (const { file, content } of files) {
      if (!matchesGlob(file, rule.from)) continue;
      for (const { specifier, line } of extractImports(content)) {
        const resolved = resolveRelativeImport(file, specifier);
        if (!resolved) continue;
        const target = candidatePaths(resolved).find((c) => disallow.some((g) => matchesGlob(c, g))) || null;
        if (!target) continue;
        const blockedBy = disallow.find((g) => matchesGlob(target, g));
        violations.push({
          file: normalize(file),
          line,
          specifier,
          resolved: target,
          rule: `${rule.from} -> ${blockedBy}`,
        });
      }
    }
  }
  return violations;
}

module.exports = {
  SOURCE_EXTENSIONS,
  candidatePaths,
  evaluateBoundaries,
  extractImports,
  globToRegExp,
  matchesGlob,
  resolveRelativeImport,
};
