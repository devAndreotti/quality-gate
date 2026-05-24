#!/usr/bin/env node
/**
 * pr-comment.js — Sticky comment no PR
 *
 * Posta (ou atualiza) um único comentário no PR com o resumo completo:
 *   - Status de cada job (security, lint, test, sonar, docker)
 *   - Métricas de coverage vs baseline
 *   - Link direto para o run do Actions
 *
 * O marcador invisível MARKER garante que sempre editamos o mesmo comentário,
 * mesmo depois de múltiplos pushes — o agente babysit sempre vê o estado atual.
 */

const fs = require('node:fs');

const MARKER = '<!-- quality-gate-sticky-v2 -->';
const REPO   = process.env.GITHUB_REPOSITORY;        // owner/repo
const TOKEN  = process.env.GITHUB_TOKEN;
const PR     = process.env.PR_NUMBER;
const RUN_ID = process.env.RUN_ID;

if (!TOKEN || !PR || !REPO) {
  console.log('Variáveis ausentes — pulando sticky comment.');
  process.exit(0);
}

const BASE = `https://api.github.com/repos/${REPO}`;
const RUN_URL = RUN_ID
  ? `https://github.com/${REPO}/actions/runs/${RUN_ID}`
  : `https://github.com/${REPO}/actions`;

// ─── Status dos jobs ─────────────────────────────────────────────────────────

const jobs = {
  security: process.env.SECURITY_RESULT ?? 'skipped',
  lint:     process.env.LINT_RESULT     ?? 'skipped',
  test:     process.env.TEST_RESULT     ?? 'skipped',
  sonar:    process.env.SONAR_RESULT    ?? 'skipped',
  docker:   process.env.DOCKER_RESULT   ?? 'skipped',
};

const ICONS  = { success: '✅', failure: '❌', cancelled: '⏭️', skipped: '⏭️' };
const LABELS = { success: 'passou', failure: 'FALHOU', cancelled: 'cancelado', skipped: 'pulado' };
const icon   = r => ICONS[r]  ?? '⏳';
const label  = r => LABELS[r] ?? r;

const allGreen = Object.values(jobs).every(r => r === 'success');
const anyFail  = Object.values(jobs).some(r => r === 'failure');

// ─── Métricas de coverage ────────────────────────────────────────────────────

function readCoverageSection() {
  try {
    const summary  = JSON.parse(fs.readFileSync('coverage/coverage-summary.json', 'utf8'));
    const baseline = JSON.parse(fs.readFileSync('scripts/baseline.json', 'utf8'));
    const t = summary.total;
    const b = baseline.coverage ?? {};

    const fmt  = (v) => v != null ? `${v.toFixed(1)}%` : 'n/a';
    const diff = (cur, base) => {
      if (base == null || cur == null) return '';
      const d = cur - base;
      if (Math.abs(d) < 0.01) return '→';
      return d > 0 ? `▲ +${d.toFixed(1)}` : `▼ ${d.toFixed(1)}`;
    };

    const rows = [
      ['lines',      t.lines.pct,      b.lines],
      ['statements', t.statements.pct, b.statements],
      ['functions',  t.functions.pct,  b.functions],
      ['branches',   t.branches.pct,   b.branches],
    ];

    const table = [
      '',
      '<details>',
      '<summary><b>📊 Coverage</b></summary>',
      '',
      '| Métrica | Baseline | Atual | Delta |',
      '|---------|----------|-------|-------|',
      ...rows.map(([m, cur, base]) =>
        `| \`${m}\` | ${fmt(base)} | ${fmt(cur)} | ${diff(cur, base)} |`
      ),
      '',
      '</details>',
    ];

    // Top 3 arquivos com menor coverage (útil para o agente saber onde focar)
    const worst = Object.entries(summary)
      .filter(([k]) => k !== 'total')
      .map(([file, m]) => ({ file: file.replace(process.cwd() + '/', ''), pct: m.lines.pct }))
      .sort((a, b) => a.pct - b.pct)
      .slice(0, 3);

    if (worst.length > 0) {
      table.push('');
      table.push('<details>');
      table.push('<summary><b>📉 Menor coverage (top 3)</b></summary>');
      table.push('');
      table.push('| Arquivo | Lines % |');
      table.push('|---------|---------|');
      worst.forEach(w => table.push(`| \`${w.file}\` | ${fmt(w.pct)} |`));
      table.push('');
      table.push('</details>');
    }

    return table.join('\n');
  } catch {
    return ''; // coverage não disponível neste ciclo
  }
}

// ─── Montar comentário ───────────────────────────────────────────────────────

const coverageSection = readCoverageSection();
const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

const body = `${MARKER}
## ${allGreen ? '✅' : anyFail ? '❌' : '⏳'} Quality Gate

| Job | Status |
|-----|--------|
| ${icon(jobs.security)} Segurança (npm audit) | ${label(jobs.security)} |
| ${icon(jobs.lint)} Lint (ESLint) | ${label(jobs.lint)} |
| ${icon(jobs.test)} Testes + Ratchet | ${label(jobs.test)} |
| ${icon(jobs.sonar)} SonarCloud | ${label(jobs.sonar)} |
| ${icon(jobs.docker)} Docker image gate | ${label(jobs.docker)} |
${coverageSection}
${allGreen
  ? '> ✅ Todos os checks passaram. Aguardando Copilot Review.'
  : anyFail
    ? `> ❌ **Ação necessária:** corrija os jobs com falha antes do merge.\n> O agente babysit-pr está monitorando e irá iterar automaticamente.`
    : '> ⏳ Alguns jobs ainda estão em andamento...'}

<sub>[Ver run completo](${RUN_URL}) · Atualizado em ${timestamp}</sub>
`;

// ─── Postar ou atualizar via GitHub API ──────────────────────────────────────

async function ghFetch(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(opts.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json().catch(() => null);
}

async function run() {
  // Busca comentários existentes para encontrar o sticky
  const comments = await ghFetch(`/issues/${PR}/comments?per_page=100`);
  const existing = comments?.find(c => c.body?.includes(MARKER));

  if (existing) {
    await ghFetch(`/issues/comments/${existing.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ body }),
    });
    console.log(`✅ Sticky comment atualizado (id ${existing.id})`);
  } else {
    await ghFetch(`/issues/${PR}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
    console.log('✅ Sticky comment criado');
  }
}

run().catch(e => {
  console.error('Erro no sticky comment:', e.message);
  process.exit(0); // Não bloqueia o CI
});
