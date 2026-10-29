// fleet-audit.cjs — auditoria somente leitura de um repositório da frota.
// Não escreve nada: só verifica se o repo está gerenciado e saudável.
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const HOOK_MARKER = '# quality-gate:managed-hook';
const CI_WORKFLOW = '.github/workflows/quality-gate.yml';
const POLICY = '.quality-gate/policy.json';
const BASELINE = 'scripts/baseline.json';

function defaultIo(repoPath) {
  return {
    isDir: (p) => fs.existsSync(p) && fs.statSync(p).isDirectory(),
    exists: (p) => fs.existsSync(path.join(repoPath, p)),
    readJson: (p) => JSON.parse(fs.readFileSync(path.join(repoPath, p), 'utf8')),
    readText: (p) => fs.readFileSync(path.join(repoPath, p), 'utf8'),
    prePushHookPath: () => {
      const out = childProcess.execFileSync(
        'git',
        ['-C', repoPath, 'rev-parse', '--git-path', 'hooks/pre-push'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
      return path.resolve(repoPath, out.trim());
    },
  };
}

// Baseline com todas as métricas zeradas é um bloqueador de release (ver gotcha do projeto).
function isZeroBaseline(baseline) {
  const coverage = baseline && baseline.coverage;
  if (!coverage) return false;
  const values = Object.values(coverage).filter((v) => typeof v === 'number');
  return values.length > 0 && values.every((v) => v === 0);
}

function auditRepo(repoPath, io = defaultIo(repoPath)) {
  const issues = [];
  const report = {
    path: repoPath,
    status: 'ok',
    policy: 'ausente',
    baseline: 'ausente',
    hooks: 'falta',
    ci: 'falta',
    issues,
  };

  if (!io.isDir(repoPath)) {
    report.status = 'caminho ausente';
    issues.push('caminho nao existe ou nao e diretorio');
    return report;
  }

  if (!io.exists(POLICY)) {
    report.status = 'nao gerenciado';
    issues.push('sem .quality-gate/policy.json');
    return report;
  }

  try {
    const policy = io.readJson(POLICY);
    if (policy.schemaVersion === 1) {
      report.policy = 'ok';
    } else {
      report.policy = 'versao invalida';
      issues.push(`policy.json schemaVersion=${policy.schemaVersion} (esperado 1)`);
    }
  } catch (err) {
    report.policy = 'invalida';
    issues.push(`policy.json nao parseia: ${err.message.split('\n')[0]}`);
  }

  if (!io.exists(BASELINE)) {
    report.baseline = 'ausente';
    issues.push(`sem ${BASELINE} (ratchet nao inicializado)`);
  } else {
    try {
      const baseline = io.readJson(BASELINE);
      if (isZeroBaseline(baseline)) {
        report.baseline = 'zerado';
        issues.push(`${BASELINE} com cobertura zerada (bloqueador de release)`);
      } else {
        report.baseline = 'ok';
      }
    } catch (err) {
      report.baseline = 'invalido';
      issues.push(`${BASELINE} nao parseia: ${err.message.split('\n')[0]}`);
    }
  }

  try {
    const hookFile = io.prePushHookPath();
    if (fs.existsSync(hookFile) && fs.readFileSync(hookFile, 'utf8').includes(HOOK_MARKER)) {
      report.hooks = 'ok';
    } else {
      report.hooks = 'falta';
      issues.push('pre-push gerenciado nao instalado (rode git-hooks install)');
    }
  } catch {
    report.hooks = 'sem git';
    issues.push('nao e repositorio git (hooks nao verificados)');
  }

  if (io.exists(CI_WORKFLOW)) {
    report.ci = 'ok';
  } else {
    report.ci = 'falta';
    issues.push(`sem ${CI_WORKFLOW}`);
  }

  report.status = issues.length === 0 ? 'ok' : 'atencao';
  return report;
}

module.exports = { HOOK_MARKER, auditRepo, defaultIo, isZeroBaseline };
