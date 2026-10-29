#!/usr/bin/env node
'use strict';

/**
 * install-scripts-audit.cjs — aviso sobre pacotes novos ou alterados no
 * package-lock.json que declaram script de instalação (preinstall, install,
 * postinstall, prepare).
 *
 * Compara o mapa `packages` do lockfile em HEAD com o do ref base
 * (`git show <ref>:package-lock.json`). Um pacote entra na lista quando é
 * novo ou mudou de versão E (hasInstallScript === true no lockfile OU o
 * package.json instalado em node_modules declara um dos quatro scripts).
 *
 * Uso: node scripts/install-scripts-audit.cjs --base <ref> [--strict]
 * Exit: 0 ok ou aviso (base/HEAD sem lockfile); 1 só com --strict e lista
 *       não vazia; 2 erro (JSON malformado ou uso incorreto).
 */

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const LOCKFILE = 'package-lock.json';
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'];
const NODE_MODULES = 'node_modules/';

class UsageError extends Error {}
class LockfileError extends Error {}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Lê o lockfile no ref dado. Retorna null quando o ref ou o arquivo não existe. */
function readLockAtRef(ref, cwd) {
  let raw;
  try {
    raw = childProcess.execFileSync('git', ['show', `${ref}:${LOCKFILE}`], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new LockfileError(`${ref}:${LOCKFILE} não é JSON válido (${err.message})`);
  }
}

function packageNameFromKey(key) {
  return key.slice(key.lastIndexOf(NODE_MODULES) + NODE_MODULES.length);
}

/**
 * Scripts de instalação declarados no package.json instalado em node_modules.
 * Só é consultado quando a entrada tem `resolved` e a versão instalada bate
 * com a do lockfile; caso contrário retorna [] e vale o hasInstallScript.
 */
function installedInstallScripts(key, entry, cwd) {
  if (typeof entry.resolved !== 'string') return [];
  if (!key.startsWith(NODE_MODULES) || key.split('/').includes('..')) return [];
  const pkgPath = path.join(cwd, key, 'package.json');
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch {
    return [];
  }
  if (!isPlainObject(pkg) || pkg.version !== entry.version || !isPlainObject(pkg.scripts)) return [];
  return INSTALL_SCRIPTS.filter((name) => typeof pkg.scripts[name] === 'string');
}

/**
 * Pacotes novos ou com versão alterada, no head, que declaram script de instalação.
 * @returns {{name: string, version: string, change: string, reasons: string[]}[]}
 */
function auditInstallScripts(basePackages, headPackages, cwd) {
  const findings = [];
  for (const [key, entry] of Object.entries(headPackages)) {
    if (key === '' || !isPlainObject(entry)) continue;
    const base = basePackages[key];
    const isNew = !isPlainObject(base);
    if (!isNew && base.version === entry.version) continue;

    const reasons = [];
    if (entry.hasInstallScript === true) reasons.push('hasInstallScript=true');
    const scripts = installedInstallScripts(key, entry, cwd);
    if (scripts.length > 0) reasons.push(`scripts: ${scripts.join(', ')}`);
    if (reasons.length === 0) continue;

    findings.push({
      name: packageNameFromKey(key),
      version: String(entry.version),
      change: isNew ? 'novo' : `versão ${base.version} -> ${entry.version}`,
      reasons,
    });
  }
  return findings;
}

function parseArgs(argv) {
  const args = { base: null, strict: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--base') args.base = argv[++i];
    else if (arg.startsWith('--base=')) args.base = arg.slice('--base='.length);
    else if (arg === '--strict') args.strict = true;
    else throw new UsageError(`argumento desconhecido: ${arg}`);
  }
  if (!args.base) throw new UsageError('uso: node scripts/install-scripts-audit.cjs --base <ref> [--strict]');
  return args;
}

function main(argv = process.argv.slice(2), cwd = process.cwd()) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`install-scripts-audit: ${err.message}`);
    return 2;
  }

  try {
    const base = readLockAtRef(args.base, cwd);
    if (!base) {
      console.log(`install-scripts-audit: ${LOCKFILE} ausente em ${args.base}; auditoria pulada (aviso, não é erro).`);
      return 0;
    }
    const head = readLockAtRef('HEAD', cwd);
    if (!head) {
      console.log(`install-scripts-audit: ${LOCKFILE} ausente em HEAD; nada a auditar (aviso, não é erro).`);
      return 0;
    }
    if (!isPlainObject(head.packages)) {
      console.log('install-scripts-audit: lockfile em HEAD sem mapa "packages" (lockfileVersion < 2); nada a auditar.');
      return 0;
    }

    const basePackages = isPlainObject(base.packages) ? base.packages : {};
    const findings = auditInstallScripts(basePackages, head.packages, cwd);
    if (findings.length === 0) {
      console.log(`install-scripts-audit: nenhum pacote novo ou alterado com script de instalação (base ${args.base}).`);
      return 0;
    }

    console.log(`install-scripts-audit: ${findings.length} pacote(s) novo(s) ou alterado(s) com script de instalação:`);
    for (const f of findings) {
      console.log(`  - ${f.name}@${f.version} (${f.change}; ${f.reasons.join('; ')})`);
    }
    if (args.strict) {
      console.error('install-scripts-audit: --strict ativo, encerrando com 1.');
      return 1;
    }
    return 0;
  } catch (err) {
    if (err instanceof LockfileError) {
      console.error(`install-scripts-audit: ${err.message}`);
      return 2;
    }
    throw err;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { auditInstallScripts, parseArgs, main, INSTALL_SCRIPTS };
