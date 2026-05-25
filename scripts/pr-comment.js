#!/usr/bin/env node
/**
 * pr-comment.js — Sticky comment no PR.
 *
 * Posta (ou atualiza) um único comentário no PR com:
 *   - Status de cada check requerido
 *   - Métricas de coverage vs baseline
 *   - Link direto para o run do Actions
 */

const fs = require('node:fs');
const path = require('node:path');

const MARKER = '<!-- quality-gate-sticky-v2 -->';

const JOB_ORDER = ['security', 'lint', 'test', 'sonar', 'docker'];
const CHECK_TO_JOB = new Map([
  ['Security audit', 'security'],
  ['Lint', 'lint'],
  ['Tests & ratchet', 'test'],
  ['SonarCloud', 'sonar'],
  ['Docker image gate', 'docker'],
]);
const JOB_LABELS = {
  security: 'Segurança',
  lint: 'Lint',
  test: 'Testes + Ratchet',
  sonar: 'SonarCloud',
  docker: 'Docker image gate',
};
const ICONS = { success: '✅', failure: '❌', cancelled: '⏭️', skipped: '⏭️' };
const LABELS = { success: 'passou', failure: 'FALHOU', cancelled: 'cancelado', skipped: 'pulado' };

function parseRequiredChecks(value) {
  if (!value) return JOB_ORDER;
  const keys = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((check) => CHECK_TO_JOB.get(check))
    .filter(Boolean);
  return keys.length > 0 ? [...new Set(keys)] : JOB_ORDER;
}

function collectJobs(env = process.env) {
  return {
    security: env.SECURITY_RESULT ?? 'skipped',
    lint: env.LINT_RESULT ?? 'skipped',
    test: env.TEST_RESULT ?? 'skipped',
    sonar: env.SONAR_RESULT ?? 'skipped',
    docker: env.DOCKER_RESULT ?? 'skipped',
  };
}

function readJson(filePath) {
  return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : null;
}

function fmt(value) {
  return value != null ? `${Number(value).toFixed(1)}%` : 'n/a';
}

function diff(current, baseline) {
  if (baseline == null || current == null) return '';
  const delta = current - baseline;
  if (Math.abs(delta) < 0.01) return '→';
  return delta > 0 ? `▲ +${delta.toFixed(1)}` : `▼ ${delta.toFixed(1)}`;
}

function displayPath(root, filePath) {
  const relative = path.isAbsolute(filePath) ? path.relative(root, filePath) : filePath;
  return relative.replaceAll('\\', '/');
}

function readIstanbulCoverage(root) {
  const summary = readJson(path.join(root, 'coverage', 'coverage-summary.json'));
  if (!summary?.total) return null;
  const total = summary.total;
  return {
    totals: {
      lines: total.lines?.pct,
      statements: total.statements?.pct,
      functions: total.functions?.pct,
      branches: total.branches?.pct,
    },
    worst: Object.entries(summary)
      .filter(([key]) => key !== 'total')
      .map(([file, metrics]) => ({
        file: displayPath(root, file),
        pct: metrics.lines?.pct,
      }))
      .filter((item) => typeof item.pct === 'number')
      .sort((a, b) => a.pct - b.pct)
      .slice(0, 3),
  };
}

function readPythonCoverage(root) {
  const coverage = readJson(path.join(root, 'coverage', 'coverage.json'));
  const totals = coverage?.totals;
  if (!totals || typeof totals.percent_covered !== 'number') return null;

  const linePct = totals.percent_covered;
  const branchPct = Number(totals.num_branches) > 0
    ? (Number(totals.covered_branches || 0) / Number(totals.num_branches)) * 100
    : linePct;

  return {
    totals: {
      lines: linePct,
      statements: linePct,
      functions: linePct,
      branches: branchPct,
    },
    worst: Object.entries(coverage.files ?? {})
      .map(([file, metrics]) => ({
        file: displayPath(root, file),
        pct: metrics.summary?.percent_covered,
      }))
      .filter((item) => typeof item.pct === 'number')
      .sort((a, b) => a.pct - b.pct)
      .slice(0, 3),
  };
}

function readCoverageMetrics(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  return readIstanbulCoverage(root) || readPythonCoverage(root);
}

function readCoverageSection(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const coverage = readCoverageMetrics({ root });
  if (!coverage) return '';

  const baseline = readJson(path.join(root, 'scripts', 'baseline.json')) || {};
  const b = baseline.coverage ?? {};
  const rows = [
    ['lines', coverage.totals.lines, b.lines],
    ['statements', coverage.totals.statements, b.statements],
    ['functions', coverage.totals.functions, b.functions],
    ['branches', coverage.totals.branches, b.branches],
  ];

  const table = [
    '',
    '<details>',
    '<summary><b>📊 Coverage</b></summary>',
    '',
    '| Métrica | Baseline | Atual | Delta |',
    '|---------|----------|-------|-------|',
    ...rows.map(([metric, current, base]) => (
      `| \`${metric}\` | ${fmt(base)} | ${fmt(current)} | ${diff(current, base)} |`
    )),
    '',
    '</details>',
  ];

  if (coverage.worst.length > 0) {
    table.push(
      '',
      '<details>',
      '<summary><b>📉 Menor coverage (top 3)</b></summary>',
      '',
      '| Arquivo | Lines % |',
      '|---------|---------|',
      ...coverage.worst.map((item) => `| \`${item.file}\` | ${fmt(item.pct)} |`),
      '',
      '</details>',
    );
  }

  return table.join('\n');
}

function buildBody(options = {}) {
  const env = options.env || process.env;
  const root = path.resolve(options.root || process.cwd());
  const repo = env.GITHUB_REPOSITORY;
  const runId = env.RUN_ID;
  const runUrl = runId && repo
    ? `https://github.com/${repo}/actions/runs/${runId}`
    : repo
      ? `https://github.com/${repo}/actions`
      : 'https://github.com/actions';
  const jobs = collectJobs(env);
  const requiredJobKeys = parseRequiredChecks(env.REQUIRED_CHECKS);
  const requiredResults = requiredJobKeys.map((key) => jobs[key] ?? 'skipped');
  const allGreen = requiredResults.length > 0 && requiredResults.every((result) => result === 'success');
  const anyFail = requiredResults.some((result) => result === 'failure');
  const icon = (result) => ICONS[result] ?? '⏳';
  const label = (result) => LABELS[result] ?? result;
  const coverageSection = readCoverageSection({ root });
  const timestamp = new Date(options.now || Date.now()).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const jobRows = requiredJobKeys
    .map((key) => `| ${icon(jobs[key])} ${JOB_LABELS[key]} | ${label(jobs[key])} |`)
    .join('\n');

  return `${MARKER}
## ${allGreen ? '✅' : anyFail ? '❌' : '⏳'} Quality Gate

| Job | Status |
|-----|--------|
${jobRows}
${coverageSection}
${allGreen
    ? '> ✅ Todos os checks passaram. Aguardando Copilot Review.'
    : anyFail
      ? '> ❌ **Ação necessária:** corrija os jobs com falha antes do merge.\n> O agente babysit-pr está monitorando e irá iterar automaticamente.'
      : '> ⏳ Alguns jobs ainda estão em andamento...'}

<sub>[Ver run completo](${runUrl}) · Atualizado em ${timestamp}</sub>
`;
}

async function postStickyComment(options = {}) {
  const env = options.env || process.env;
  const repo = env.GITHUB_REPOSITORY;
  const token = env.GITHUB_TOKEN;
  const pr = env.PR_NUMBER;
  const fetchImpl = options.fetchImpl || fetch;
  const body = options.body || buildBody({ env });

  if (!token || !pr || !repo) {
    console.log('Variáveis ausentes — pulando sticky comment.');
    return { status: 'skipped' };
  }

  const baseUrl = `https://api.github.com/repos/${repo}`;
  async function ghFetch(apiPath, request = {}) {
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    };
    if (request.headers) Object.assign(headers, request.headers);

    const response = await fetchImpl(`${baseUrl}${apiPath}`, {
      ...request,
      headers,
    });
    if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
    return response.json().catch(() => null);
  }

  const comments = await ghFetch(`/issues/${pr}/comments?per_page=100`);
  const existing = comments?.find((comment) => comment.body?.includes(MARKER));

  if (existing) {
    await ghFetch(`/issues/comments/${existing.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ body }),
    });
    console.log(`✅ Sticky comment atualizado (id ${existing.id})`);
    return { status: 'updated', id: existing.id };
  }

  await ghFetch(`/issues/${pr}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
  console.log('✅ Sticky comment criado');
  return { status: 'created' };
}

async function main() {
  try {
    await postStickyComment();
  } catch (error) {
    console.error('Erro no sticky comment:', error.message);
    process.exit(0);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  buildBody,
  parseRequiredChecks,
  postStickyComment,
  readCoverageMetrics,
  readCoverageSection,
};
