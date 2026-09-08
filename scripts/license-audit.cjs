#!/usr/bin/env node
/**
 * license-audit.cjs — auditoria estatica de licencas de dependencias.
 */
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_ALLOWED_LICENSES = new Set([
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  '0BSD',
  'CC0-1.0',
  'Unlicense',
  'Python-2.0',
  'PSF-2.0',
]);

const DEFAULT_BLOCKED_LICENSES = new Set([
  'GPL-2.0',
  'GPL-3.0',
  'AGPL-3.0',
  'SSPL-1.0',
  'CPAL-1.0',
]);

function extractNodeLicenses(packageLockJson) {
  const packages = packageLockJson.packages || {};
  const result = [];

  for (const [pkgPath, meta] of Object.entries(packages)) {
    if (!pkgPath || pkgPath === '') continue; // ignora raiz
    const name = meta.name || pkgPath.replace(/.*node_modules\//, '');
    const license = meta.license || 'UNKNOWN';
    result.push({ name, version: meta.version || '*', license });
  }
  return result;
}

function auditLicenses(dependencies, options = {}) {
  const allowed = options.allowedLicenses ? new Set(options.allowedLicenses) : DEFAULT_ALLOWED_LICENSES;
  const blocked = options.blockedLicenses ? new Set(options.blockedLicenses) : DEFAULT_BLOCKED_LICENSES;

  const violations = [];
  const approved = [];

  for (const dep of dependencies) {
    const lic = String(dep.license || 'UNKNOWN').trim();
    if (blocked.has(lic)) {
      violations.push({ ...dep, reason: `Licenca expressamente proibida: ${lic}` });
    } else if (allowed.has(lic)) {
      approved.push(dep);
    } else {
      // Licenca nao permitida na allowlist
      violations.push({ ...dep, reason: `Licenca fora da allowlist: ${lic}` });
    }
  }

  return {
    status: violations.length === 0 ? 'passed' : 'failed',
    total: dependencies.length,
    approvedCount: approved.length,
    violationsCount: violations.length,
    violations,
  };
}

function runLicenseAudit(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const lockPath = path.join(root, 'package-lock.json');

  if (!fs.existsSync(lockPath)) {
    return { status: 'skipped', reason: 'package-lock.json nao encontrado', violations: [] };
  }

  const lockJson = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const deps = extractNodeLicenses(lockJson);
  return runAuditOnDeps(deps, options);
}

function runAuditOnDeps(deps, options) {
  return auditLicenses(deps, options);
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = { root: process.cwd(), json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--root') args.root = argv[++i];
    else if (arg.startsWith('--root=')) args.root = arg.slice('--root='.length);
  }
  return args;
}

function main() {
  const args = parseArgs();
  const result = runLicenseAudit(args);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\nLicense Audit: ${result.status.toUpperCase()}`);
    for (const v of result.violations || []) {
      console.error(`  ❌ ${v.name}@${v.version}: ${v.reason}`);
    }
  }
  process.exitCode = result.status === 'passed' || result.status === 'skipped' ? 0 : 1;
}

if (require.main === module) main();

module.exports = {
  DEFAULT_ALLOWED_LICENSES,
  DEFAULT_BLOCKED_LICENSES,
  auditLicenses,
  extractNodeLicenses,
  parseArgs,
  runLicenseAudit,
};