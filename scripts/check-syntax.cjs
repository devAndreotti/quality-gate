#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const DEFAULT_ROOT = path.resolve(__dirname, '..');

function collectScriptFiles(root = DEFAULT_ROOT) {
  const scriptsRoot = path.join(root, 'scripts');
  const files = [];

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.(?:cjs|js)$/.test(entry.name)) files.push(full);
    }
  }

  walk(scriptsRoot);
  return files.sort((left, right) => left.localeCompare(right));
}

function resolveEslintBin(root = DEFAULT_ROOT) {
  try {
    const pkgPath = require.resolve('eslint/package.json', { paths: [root, __dirname] });
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin && pkg.bin.eslint;
    return bin ? path.join(path.dirname(pkgPath), bin) : null;
  } catch {
    return null;
  }
}

function writeJsonReport(coverageDir, report) {
  fs.mkdirSync(coverageDir, { recursive: true });
  fs.writeFileSync(path.join(coverageDir, 'eslint-report.json'), `${JSON.stringify(report, null, 2)}\n`);
}

// Writes coverage/eslint-report.json with the real ESLint result. When ESLint
// or eslint.config.js is missing, writes a skipped object instead (never []).
// options.eslintBin: explicit ESLint bin path, or null to simulate "not installed".
function writeEslintReport(root = DEFAULT_ROOT, options = {}) {
  const coverageDir = path.join(root, 'coverage');
  const reportPath = path.join(coverageDir, 'eslint-report.json');
  const files = options.files || collectScriptFiles(root);
  const eslintBin = 'eslintBin' in options ? options.eslintBin : resolveEslintBin(root);

  if (!eslintBin) {
    writeJsonReport(coverageDir, { status: 'skipped', reason: 'eslint não instalado' });
    return;
  }
  if (!fs.existsSync(path.join(root, 'eslint.config.js'))) {
    writeJsonReport(coverageDir, { status: 'skipped', reason: 'eslint.config.js ausente' });
    return;
  }
  if (files.length === 0) {
    writeJsonReport(coverageDir, { status: 'skipped', reason: 'nenhum arquivo de script para lintar' });
    return;
  }

  fs.mkdirSync(coverageDir, { recursive: true });
  const run = childProcess.spawnSync(
    process.execPath,
    [eslintBin, ...files, '-f', 'json', '-o', reportPath],
    { cwd: root, encoding: 'utf8', windowsHide: true },
  );
  // ESLint exits 1 when it finds lint errors; the JSON report is still valid then.
  if (run.error || (run.status !== 0 && run.status !== 1) || !fs.existsSync(reportPath)) {
    writeJsonReport(coverageDir, {
      status: 'error',
      reason: `eslint terminou com código ${run.status}`,
      stderr: String(run.stderr || run.error?.message || '').slice(0, 2000),
    });
  }
}

function checkSyntax(root = DEFAULT_ROOT) {
  const files = collectScriptFiles(root);
  const failures = [];

  for (const file of files) {
    try {
      childProcess.execFileSync(process.execPath, ['--check', file], {
        encoding: 'utf8',
        maxBuffer: 5 * 1024 * 1024,
      });
    } catch (error) {
      failures.push({ file, stderr: error.stderr || error.message, stdout: error.stdout || '' });
    }
  }

  writeEslintReport(root, { files });
  return { status: failures.length ? 'failed' : 'passed', files, failures };
}

function main() {
  const result = checkSyntax();
  for (const file of result.files) {
    console.log(`checked ${path.relative(DEFAULT_ROOT, file).replaceAll('\\', '/')}`);
  }
  for (const failure of result.failures) {
    console.error(failure.stderr || failure.stdout || failure.file);
  }
  process.exitCode = result.status === 'passed' ? 0 : 1;
}

if (require.main === module) main();

module.exports = {
  checkSyntax,
  collectScriptFiles,
  resolveEslintBin,
  writeEslintReport,
};
