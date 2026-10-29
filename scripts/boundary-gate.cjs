#!/usr/bin/env node
// boundary-gate.cjs — bloqueia imports proibidos entre camadas (ex.: domínio importando infra).
//
// Uso:    node scripts/boundary-gate.cjs [--root <dir>] [--json]
// Config: .quality-gate/policy.json -> ci.architectureBoundary
//         { enabled, blockOnFailure, rules: [{ from: "src/domain/**", disallow: ["src/infra/**"] }] }
//
// Escaneia só arquivos rastreados pelo git. Falha fechado: configuração inválida
// ou git indisponível retornam erro (exit 1).

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { SOURCE_EXTENSIONS, evaluateBoundaries } = require('./lib/boundary-rules.cjs');

const DEFAULT_CONFIG = { enabled: false, blockOnFailure: true, rules: [] };
const EXCLUDED = /(?:^|\/)(?:node_modules|coverage|dist|build)\//;

function readConfig(policyPath) {
  if (!fs.existsSync(policyPath)) return { ...DEFAULT_CONFIG };
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  return { ...DEFAULT_CONFIG, ...((policy.ci && policy.ci.architectureBoundary) || {}) };
}

function validateRules(rules) {
  if (!Array.isArray(rules)) return 'rules deve ser uma lista';
  for (const [i, rule] of rules.entries()) {
    if (!rule || typeof rule.from !== 'string' || !rule.from) return `rules[${i}].from ausente`;
    if (!Array.isArray(rule.disallow) || rule.disallow.length === 0)
      return `rules[${i}].disallow deve ser lista não vazia`;
  }
  return null;
}

function listTrackedSources(root, execFileSync) {
  const out = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
  return out
    .split(/\r?\n/)
    .filter((f) => f && !EXCLUDED.test(f) && SOURCE_EXTENSIONS.includes(path.extname(f)));
}

function runBoundaryGate(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const policyPath = options.policyPath || path.join(root, '.quality-gate', 'policy.json');
  const config = options.config || readConfig(policyPath);

  if (!config.enabled) return { status: 'skipped', reason: 'ci.architectureBoundary.enabled = false' };
  if (!config.rules || config.rules.length === 0)
    return { status: 'skipped', reason: 'nenhuma regra definida' };

  const invalid = validateRules(config.rules);
  if (invalid) return { status: 'error', reason: `regras invalidas: ${invalid}` };

  const exec = options.execFileSync || childProcess.execFileSync;
  let files;
  try {
    files = options.files || listTrackedSources(root, exec);
  } catch (err) {
    return { status: 'error', reason: `git ls-files falhou: ${err.message.split('\n')[0]}` };
  }

  const sources = files.map((file) => ({
    file,
    content: options.contents ? options.contents[file] : fs.readFileSync(path.join(root, file), 'utf8'),
  }));

  const violations = evaluateBoundaries({ files: sources, rules: config.rules });
  const blocking = config.blockOnFailure !== false;
  const status = violations.length === 0 ? 'passed' : blocking ? 'failed' : 'advisory';
  return { status, blocking, scannedFiles: sources.length, violations };
}

function formatReport(result) {
  if (result.status === 'skipped') return `Architecture boundary: SKIPPED (${result.reason})`;
  if (result.status === 'error') return `Architecture boundary: ERROR — ${result.reason}`;
  const lines = [
    `Architecture boundary: ${result.status.toUpperCase()} — ${result.scannedFiles} arquivos, ${result.violations.length} violacoes`,
  ];
  for (const v of result.violations.slice(0, 50)) {
    lines.push(`  - ${v.file}:${v.line} importa "${v.specifier}" (${v.rule})`);
  }
  if (result.violations.length > 50) lines.push(`  ... e mais ${result.violations.length - 50}`);
  if (result.status === 'advisory') lines.push('Modo advisory (blockOnFailure=false): não bloqueia o CI.');
  return lines.join('\n');
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = { root: process.cwd(), json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') args.root = argv[++i];
    else if (argv[i].startsWith('--root=')) args.root = argv[i].slice('--root='.length);
    else if (argv[i] === '--json') args.json = true;
  }
  return args;
}

function main() {
  const args = parseArgs();
  const result = runBoundaryGate(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(formatReport(result));
  process.exitCode = result.status === 'error' || result.status === 'failed' ? 1 : 0;
}

if (require.main === module) main();

module.exports = { DEFAULT_CONFIG, formatReport, parseArgs, readConfig, runBoundaryGate, validateRules };
