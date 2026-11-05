#!/usr/bin/env node
// Monta a amostra de PRs reais para comparar ferramentas de qualidade.
// Só lê o histórico do GitHub (gh). Não grava nada no repo: a saída vai para .quality-gate/ (gitignored).
// Uso: node scripts/eval-sample.cjs --repo o/r [--size 10] [--seed 1] [--out arquivo.json]

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CODE_PATTERN = /\.(?:c|m)?js$|\.(?:ts|tsx|jsx)$/;
const EXCLUDED_PATTERN = /(?:^|\/)(?:node_modules|coverage|dist|build)\/|\.(?:test|spec)\.[a-zA-Z0-9]+$/;

// Gerador determinístico (mulberry32): a mesma semente dá a mesma amostra.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isCodeChange(file) {
  return CODE_PATTERN.test(file) && !EXCLUDED_PATTERN.test(file);
}

// Um PR é elegível se toca código de produção e não é só docs/deps.
function isEligible(pr) {
  const files = pr.files || [];
  return files.length > 0 && files.some((f) => isCodeChange(f.path || f.filename || ''));
}

// Amostra estratificada: metade com CI vermelho no merge original, metade verde.
// Assim a amostra mede detecção de problemas reais, não só ruído em PRs limpos.
function selectSample(prs, { size, seed }) {
  const eligible = prs.filter(isEligible);
  const red = eligible.filter((p) => p.hadFailure);
  const green = eligible.filter((p) => !p.hadFailure);
  const random = rng(seed);
  const shuffle = (arr) => {
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  };
  const half = Math.floor(size / 2);
  const picked = [...shuffle(red).slice(0, half), ...shuffle(green).slice(0, size - half)];
  return picked.map((p) => ({
    number: p.number,
    title: p.title,
    hadFailure: p.hadFailure,
    mergedAt: p.mergedAt,
  }));
}

function parseArgs(argv) {
  const args = { repo: null, size: 10, seed: 1, out: null };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--repo') args.repo = value;
    else if (key === '--size') args.size = Number(value);
    else if (key === '--seed') args.seed = Number(value);
    else if (key === '--out') args.out = value;
    else continue;
    i++;
  }
  if (!args.repo || !/^[^/]+\/[^/]+$/.test(args.repo)) throw new Error('--repo precisa ser dono/repo');
  if (!Number.isInteger(args.size) || args.size < 2) throw new Error('--size precisa ser inteiro >= 2');
  return args;
}

function defaultExec(file, args) {
  return childProcess.execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

// Coleta PRs mergeados recentes, com arquivos e se algum check falhou no head.
function fetchMergedPrs(repo, exec, limit = 100) {
  const list = JSON.parse(
    exec('gh', [
      'pr',
      'list',
      '--repo',
      repo,
      '--state',
      'merged',
      '--limit',
      String(limit),
      '--json',
      'number,title,mergedAt,headRefOid',
    ]),
  );
  return list.map((pr) => {
    const files = JSON.parse(
      exec('gh', [
        'api',
        `repos/${repo}/pulls/${pr.number}/files`,
        '--paginate',
        '--jq',
        '[.[]|{path: .filename}]',
      ]).replace(/\]\s*\[/g, ','),
    );
    const runs = JSON.parse(
      exec('gh', [
        'api',
        `repos/${repo}/commits/${pr.headRefOid}/check-runs`,
        '--jq',
        '[.check_runs[]|{conclusion}]',
      ]),
    );
    const hadFailure = runs.some((r) => r.conclusion === 'failure' || r.conclusion === 'timed_out');
    return { number: pr.number, title: pr.title, mergedAt: pr.mergedAt, files, hadFailure };
  });
}

function main(argv, deps = {}) {
  const args = parseArgs(argv);
  const exec = deps.exec || defaultExec;
  const prs = deps.prs || fetchMergedPrs(args.repo, exec);
  const sample = selectSample(prs, { size: args.size, seed: args.seed });
  const result = {
    repo: args.repo,
    seed: args.seed,
    size: args.size,
    eligibleCount: prs.filter(isEligible).length,
    sample,
  };
  const out =
    args.out || path.join(process.cwd(), '.quality-gate', `eval-sample-${args.repo.replace('/', '-')}.json`);
  if (!deps.dryRun) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n', 'utf8');
  }
  return {
    code: 0,
    out: `amostra de ${sample.length} PRs (${result.eligibleCount} elegíveis) -> ${out}`,
    result,
  };
}

module.exports = { isCodeChange, isEligible, parseArgs, rng, selectSample, main };

if (require.main === module) {
  try {
    const r = main(process.argv.slice(2));
    console.log(r.out);
    process.exitCode = r.code;
  } catch (err) {
    console.error(`erro: ${err.message}`);
    process.exitCode = 2;
  }
}
