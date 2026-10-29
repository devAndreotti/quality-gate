#!/usr/bin/env node
/**
 * ast-graph.cjs — detecta quebras cross-file em JS/TS: imports de exports que sumiram
 * e chamadas que não batem com a assinatura (com --base).
 *
 * Somente leitura. Usa `git ls-files` para listar os arquivos rastreados e
 * `git show <base>:<arquivo>` (apenas com --base). Parser: oxc-parser via scripts/lib/ast-parser.cjs.
 *
 * Saída: 0 normal (inclui status skipped), 1 só com --strict e violações, 2 erro de configuração.
 */
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { loadOxcParser, analyzeSource } = require('./lib/ast-parser.cjs');

const EXIT_OK = 0;
const EXIT_VIOLATIONS = 1;
const EXIT_CONFIG = 2;

const CODE_EXT = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);
const RESOLVE_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];
const EXCLUDED_DIRS = new Set(['node_modules', 'coverage', 'dist', 'build']);
const TEST_BASENAME = /\.(?:test|spec)\./;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

const USAGE = 'uso: node scripts/ast-graph.cjs [--root DIR] [--base REF] [--json] [--strict]\n';

class ConfigError extends Error {}

function parseArgs(argv) {
  const opts = { root: process.cwd(), base: null, json: false, strict: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    const inlineValue = eq > 0 ? arg.slice(eq + 1) : undefined;
    switch (name) {
      case '--root':
      case '--base': {
        const value = inlineValue !== undefined ? inlineValue : argv[(i += 1)];
        if (!value || value.startsWith('--')) throw new ConfigError(`${name} exige um valor`);
        opts[name.slice(2)] = value;
        break;
      }
      case '--json':
      case '--strict':
        if (inlineValue !== undefined) throw new ConfigError(`${name} não aceita valor`);
        opts[name.slice(2)] = true;
        break;
      case '-h':
      case '--help':
        opts.help = true;
        break;
      default:
        throw new ConfigError(`opção desconhecida: ${arg}`);
    }
  }
  return opts;
}

function git(root, args) {
  return childProcess.execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    maxBuffer: GIT_MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function isCodeFile(rel) {
  const segments = rel.split('/');
  if (segments.some((s) => EXCLUDED_DIRS.has(s))) return false;
  const base = segments[segments.length - 1];
  if (TEST_BASENAME.test(base)) return false;
  return CODE_EXT.has(path.posix.extname(base).toLowerCase());
}

function listSourceFiles(root) {
  let raw;
  try {
    raw = git(root, ['ls-files', '-z']);
  } catch {
    throw new ConfigError(`não foi possível listar arquivos com git em ${root} (é um repositório git?)`);
  }
  return raw
    .split('\0')
    .filter((rel) => rel && isCodeFile(rel))
    .sort();
}

function resolveImport(fromRel, spec, fileSet) {
  if (!spec || !spec.startsWith('.')) return null;
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  if (joined.startsWith('../') || joined === '..') return null;
  if (fileSet.has(joined)) return joined;
  const bases = [joined];
  const stripped = joined.replace(/\.(?:m|c)?jsx?$/, '');
  if (stripped !== joined) bases.push(stripped);
  for (const b of bases) {
    for (const ext of RESOLVE_EXT) {
      if (fileSet.has(b + ext)) return b + ext;
    }
    for (const ext of RESOLVE_EXT) {
      if (fileSet.has(`${b}/index${ext}`)) return `${b}/index${ext}`;
    }
  }
  return null;
}

function isUnresolvedCodeSpec(spec) {
  return spec.startsWith('.') && (path.posix.extname(spec) === '' || CODE_EXT.has(path.posix.extname(spec)));
}

function readPinnedVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    return (pkg.optionalDependencies || {})['oxc-parser'] || 'versão fixada em package.json';
  } catch {
    return 'versão fixada em package.json';
  }
}

function sortViolations(list) {
  return list.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.type.localeCompare(b.type) ||
      String(a.symbol).localeCompare(String(b.symbol)),
  );
}

/**
 * Constrói o grafo de exports (com re-exports resolvidos) e acumula violações.
 * Arquivos não parseáveis são tratados como "opacos": nunca geram violação contra eles.
 */
function analyzeGraph({ files, fileSet, analyses, baseArity }) {
  const cache = new Map();
  const violations = [];

  function exportsOf(rel, seen = new Set()) {
    if (cache.has(rel)) return cache.get(rel);
    if (!analyses.has(rel)) return { names: new Map(), opaque: true };
    if (seen.has(rel)) return { names: new Map(), opaque: false };
    seen.add(rel);
    const names = new Map();
    let opaque = false;
    for (const e of analyses.get(rel).exports) {
      if (e.kind === 'star') {
        const target = resolveImport(rel, e.from, fileSet);
        if (!target) {
          opaque = true;
          continue;
        }
        const sub = exportsOf(target, seen);
        if (sub.opaque) opaque = true;
        for (const [n, info] of sub.names) {
          if (n !== 'default' && !names.has(n)) names.set(n, info);
        }
        continue;
      }
      if (e.kind === 'reexport') {
        const target = resolveImport(rel, e.from, fileSet);
        if (!target) {
          opaque = true;
          continue;
        }
        if (e.imported === '*') {
          names.set(e.name, { file: target, name: '*', line: e.line, arity: null, kind: 'namespace' });
          continue;
        }
        const sub = exportsOf(target, seen);
        const info = sub.names.get(e.imported);
        if (info) names.set(e.name, info);
        continue;
      }
      if (e.name) {
        names.set(e.name, { file: rel, name: e.name, line: e.line, arity: e.arity, kind: e.kind });
      }
    }
    // CommonJS: module.exports/exports.x viram nomes; "default" existe quando há CJS (import default de CJS).
    const cjs = analyses.get(rel).cjs;
    if (cjs.names.length > 0 || cjs.opaque) {
      for (const c of cjs.names) {
        if (!names.has(c.name))
          names.set(c.name, { file: rel, name: c.name, line: c.line, arity: null, kind: 'cjs' });
      }
      if (!names.has('default'))
        names.set('default', { file: rel, name: 'default', line: 1, arity: null, kind: 'cjs' });
      if (cjs.opaque) opaque = true;
    }
    const result = { names, opaque };
    seen.delete(rel);
    cache.set(rel, result);
    return result;
  }

  function push(violation) {
    violations.push(violation);
  }

  for (const rel of files) {
    if (!analyses.has(rel)) continue;
    const analysis = analyses.get(rel);

    // Imports e re-exports apontando para símbolos que não existem mais.
    const bindings = new Map();
    const namespaces = new Map();
    for (const imp of analysis.imports) {
      if (!imp.source || !imp.source.startsWith('.')) continue;
      const target = resolveImport(rel, imp.source, fileSet);
      if (!target) {
        if (isUnresolvedCodeSpec(imp.source)) {
          push({
            type: 'unresolved-module',
            file: rel,
            line: imp.line,
            symbol: imp.source,
            module: imp.source,
            message: `import de "${imp.source}" não resolve para nenhum arquivo rastreado`,
          });
        }
        continue;
      }
      const exp = exportsOf(target);
      for (const spec of imp.specifiers) {
        if (spec.kind === 'namespace') {
          namespaces.set(spec.local, target);
          continue;
        }
        const info = exp.names.get(spec.imported);
        if (info) {
          bindings.set(spec.local, info);
        } else if (!exp.opaque) {
          push({
            type: 'missing-export',
            file: rel,
            line: imp.line,
            symbol: spec.imported,
            module: imp.source,
            message: `"${spec.imported}" não é exportado por ${target}`,
          });
        }
      }
    }

    for (const e of analysis.exports) {
      if (e.kind !== 'reexport' || e.imported === '*') continue;
      const target = resolveImport(rel, e.from, fileSet);
      if (!target) continue;
      const exp = exportsOf(target);
      if (!exp.opaque && !exp.names.has(e.imported)) {
        push({
          type: 'missing-export',
          file: rel,
          line: e.line,
          symbol: e.imported,
          module: e.from,
          message: `re-export de "${e.imported}" não existe em ${target}`,
        });
      }
    }

    // Chamadas: namespace.membro() ausente, e aridade incompatível com a assinatura antiga.
    for (const call of analysis.calls) {
      let info = null;
      if (call.kind === 'identifier') {
        info = bindings.get(call.callee) || null;
      } else if (namespaces.has(call.object)) {
        const exp = exportsOf(namespaces.get(call.object));
        info = exp.names.get(call.callee) || null;
        if (!info && !exp.opaque) {
          push({
            type: 'missing-export',
            file: rel,
            line: call.line,
            symbol: call.callee,
            module: call.object,
            message: `${call.object}.${call.callee}() chamado, mas o símbolo não é exportado`,
          });
        }
      }
      if (!info || !info.arity || call.spread || !baseArity) continue;
      const old = baseArity.get(`${info.file}#${info.name}`);
      if (!old) continue;
      const changed = old.min !== info.arity.min || old.max !== info.arity.max;
      if (changed && (call.argc < info.arity.min || call.argc > info.arity.max)) {
        push({
          type: 'arity-mismatch',
          file: rel,
          line: call.line,
          symbol: info.name,
          module: info.file,
          message: `chamada com ${call.argc} argumento(s); assinatura de ${info.name} em ${info.file} era ${formatArity(old)} e agora é ${formatArity(info.arity)}`,
        });
      }
    }
  }

  return sortViolations(violations);
}

function formatArity(a) {
  return a.max === Infinity ? `${a.min}+` : a.min === a.max ? `${a.min}` : `${a.min}..${a.max}`;
}

/**
 * Lê as versões de base de todos os arquivos em uma única chamada `git cat-file --batch`.
 * Arquivos ausentes na base (novos) ficam de fora.
 * @returns {Map<string, string>} rel -> conteúdo
 */
function readBaseContents({ files, root, base }) {
  const out = new Map();
  if (files.length === 0) return out;
  const input = files.map((rel) => `${base}:./${rel}\n`).join('');
  const buf = childProcess.execFileSync('git', ['-C', root, 'cat-file', '--batch'], {
    input,
    maxBuffer: GIT_MAX_BUFFER,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let pos = 0;
  for (const rel of files) {
    const nl = buf.indexOf(10, pos);
    if (nl < 0) break;
    const header = buf.subarray(pos, nl).toString('utf8');
    pos = nl + 1;
    const parts = header.split(' ');
    if (parts.length !== 3 || parts[1] !== 'blob') continue; // missing / ambiguous / outro tipo
    const size = Number(parts[2]);
    out.set(rel, buf.subarray(pos, pos + size).toString('utf8'));
    pos += size + 1;
  }
  return out;
}

function buildBaseArity({ files, root, base, parser }) {
  const map = new Map();
  const contents = readBaseContents({ files, root, base });
  for (const [rel, source] of contents) {
    const analysis = analyzeSource(source, { filename: rel, parser });
    if (!analysis.ok) continue;
    for (const e of analysis.exports) {
      if (e.name && e.arity && e.kind !== 'reexport' && e.kind !== 'star') {
        map.set(`${rel}#${e.name}`, e.arity);
      }
    }
  }
  return map;
}

function formatText(report) {
  const lines = [];
  if (report.status === 'skipped') {
    lines.push(`ast-graph: SKIPPED. ${report.message}`);
    return `${lines.join('\n')}\n`;
  }
  lines.push(
    `ast-graph: status=${report.status} arquivos=${report.filesParsed}/${report.filesListed} violacoes=${report.violations.length} avisos=${report.warnings.length} tempo=${report.durationMs}ms`,
  );
  if (report.violations.length > 0) {
    const rows = report.violations.map((v) => [v.type, v.file, String(v.line), String(v.symbol), v.message]);
    const header = ['TIPO', 'ARQUIVO', 'LINHA', 'SIMBOLO', 'DETALHE'];
    const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
    const fmt = (cells) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]))).join('  ');
    lines.push(fmt(header));
    for (const r of rows) lines.push(fmt(r));
  } else {
    lines.push('nenhuma quebra cross-file detectada');
  }
  for (const w of report.warnings) lines.push(`aviso: ${w.file}: ${w.message}`);
  return `${lines.join('\n')}\n`;
}

/**
 * Executa a análise. deps.loadParser({ basedir }) => { parser, version, error } (injetável em testes).
 * @returns {{ exitCode: number, stdout: string, stderr: string, report: object|null }}
 */
function run(argv = [], deps = {}) {
  const started = Date.now();
  const loadParser = deps.loadParser || ((o) => loadOxcParser(o));
  const configFail = (message) => ({
    exitCode: EXIT_CONFIG,
    stdout: '',
    stderr: `ast-graph: erro de configuração: ${message}\n${USAGE}`,
    report: { status: 'error', message },
  });

  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    return configFail(err.message);
  }
  if (opts.help) return { exitCode: EXIT_OK, stdout: USAGE, stderr: '', report: null };

  const root = path.resolve(opts.root);
  let listed;
  try {
    if (!fs.statSync(root).isDirectory()) throw new ConfigError('--root não é um diretório');
    listed = listSourceFiles(root);
  } catch (err) {
    return configFail(
      err instanceof ConfigError ? err.message : `--root inválido (${err.code || err.message})`,
    );
  }

  if (opts.base) {
    try {
      git(root, ['rev-parse', '--verify', '--quiet', `${opts.base}^{commit}`]);
    } catch {
      return configFail(`--base "${opts.base}" não é um commit válido`);
    }
  }

  const files = listed.filter((rel) => fs.existsSync(path.join(root, rel)));
  const fileSet = new Set(files);

  const loaded = loadParser({ basedir: root }) || { parser: null, error: 'loader não retornou resultado' };
  if (!loaded.parser) {
    const report = {
      status: 'skipped',
      parser: null,
      base: opts.base,
      filesListed: files.length,
      filesParsed: 0,
      violations: [],
      warnings: [],
      durationMs: Date.now() - started,
      message:
        `oxc-parser não instalado (${loaded.error || 'motivo desconhecido'}). ` +
        `Instale as dependências do quality-gate (npm install) ou rode: npm install --no-save oxc-parser@${readPinnedVersion()}`,
    };
    return {
      exitCode: EXIT_OK,
      stdout: opts.json ? `${JSON.stringify(report, null, 2)}\n` : formatText(report),
      stderr: '',
      report,
    };
  }

  const { parser } = loaded;
  const analyses = new Map();
  const warnings = [];
  for (const rel of files) {
    let source;
    try {
      source = fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      warnings.push({ file: rel, message: 'leitura falhou; arquivo ignorado' });
      continue;
    }
    const analysis = analyzeSource(source, { filename: rel, parser });
    if (!analysis.ok) {
      warnings.push({ file: rel, message: `não parseia (${analysis.error}); tratado como opaco` });
      continue;
    }
    analyses.set(rel, analysis);
  }

  const baseArity = opts.base ? buildBaseArity({ files, root, base: opts.base, parser }) : null;
  const violations = analyzeGraph({ files, fileSet, analyses, baseArity });

  const report = {
    status: violations.length > 0 ? 'violations' : 'ok',
    parser: { name: 'oxc-parser', version: loaded.version || null },
    base: opts.base,
    filesListed: files.length,
    filesParsed: analyses.size,
    violations,
    warnings,
    durationMs: Date.now() - started,
  };
  const exitCode = opts.strict && violations.length > 0 ? EXIT_VIOLATIONS : EXIT_OK;
  return {
    exitCode,
    stdout: opts.json ? `${JSON.stringify(report, null, 2)}\n` : formatText(report),
    stderr: '',
    report,
  };
}

if (require.main === module) {
  const result = run(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

module.exports = { run, parseArgs, resolveImport, isCodeFile, formatArity };
