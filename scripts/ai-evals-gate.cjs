#!/usr/bin/env node
/**
 * ai-evals-gate.cjs — gate deterministico para prompts, skills e agentes.
 *
 * Roda o golden dataset local contra um provedor de IA local (9Router ou Ollama).
 * Sem provedor ou modelo disponivel o gate fica "skipped", nunca "failed".
 * Exit: 0 normal/skipped, 1 falha bloqueante, 2 erro de configuracao.
 *
 * Uso: node scripts/ai-evals-gate.cjs --changed-files a.md,b.md [--root DIR] [--json]
 */
const fs = require('node:fs');
const path = require('node:path');

const { AiConfigError, chat, resolveAiSettings, selectProvider } = require('./lib/local-ai-client.cjs');

const POLICY_PATH = '.quality-gate/policy.json';
const DATASET_PATH = '.quality-gate/evals/golden-dataset.json';
const BASELINE_PATH = '.quality-gate/evals/baseline.json';

const DEFAULTS = Object.freeze({
  minScore: 0.85,
  blockOnFailure: true,
  budget: Object.freeze({ maxCases: 10, maxOutputChars: 20000 }),
});

const AI_ASSET_PATTERNS = [
  /(^|\/)(prompts?|skills?|agents?)\//i,
  /\.prompt\.md$/i,
  /(^|\/)SKILL\.md$/i,
  /\.agent\.md$/i,
  /(^|\/)AGENTS\.md$/,
  /(^|\/)CLAUDE\.md$/,
  /(^|\/)\.(claude|codex)\//,
];

const SYSTEM_PROMPT_NOTE = 'Responda de forma objetiva. Quando pedido, responda somente com JSON valido.';

function isAiAssetPath(file) {
  const normalized = String(file || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
  return AI_ASSET_PATTERNS.some((pattern) => pattern.test(normalized));
}

function findAiAssetChanges(changedFiles) {
  return (changedFiles || []).filter(isAiAssetPath);
}

function readJsonFile(root, relativePath) {
  const filePath = path.join(root, relativePath);
  if (!fs.existsSync(filePath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    throw new AiConfigError(`${relativePath} nao e um JSON valido`);
  }
}

function isNonNegativeScore(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value >= 1;
}

/**
 * Le ci.aiEvals do policy.json. Retorna configuracao efetiva com defaults.
 */
function loadAiEvalsConfig(root) {
  const policy = readJsonFile(root, POLICY_PATH);
  if (!policy || typeof policy !== 'object') {
    throw new AiConfigError(`${POLICY_PATH} ausente ou invalido`);
  }
  const raw = policy.ci?.aiEvals;
  if (raw === undefined) {
    return {
      enabled: false,
      minScore: DEFAULTS.minScore,
      blockOnFailure: DEFAULTS.blockOnFailure,
      budget: { ...DEFAULTS.budget },
    };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AiConfigError('ci.aiEvals precisa ser objeto');
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    throw new AiConfigError('ci.aiEvals.enabled precisa ser boolean');
  }
  const minScore = raw.minScore ?? DEFAULTS.minScore;
  if (!isNonNegativeScore(minScore)) {
    throw new AiConfigError('ci.aiEvals.minScore precisa ser numero entre 0 e 1');
  }
  const blockOnFailure = raw.blockOnFailure ?? DEFAULTS.blockOnFailure;
  if (typeof blockOnFailure !== 'boolean') {
    throw new AiConfigError('ci.aiEvals.blockOnFailure precisa ser boolean');
  }
  const budgetRaw = raw.budget ?? {};
  if (budgetRaw === null || typeof budgetRaw !== 'object' || Array.isArray(budgetRaw)) {
    throw new AiConfigError('ci.aiEvals.budget precisa ser objeto');
  }
  const maxCases = budgetRaw.maxCases ?? DEFAULTS.budget.maxCases;
  const maxOutputChars = budgetRaw.maxOutputChars ?? DEFAULTS.budget.maxOutputChars;
  if (!isPositiveInteger(maxCases))
    throw new AiConfigError('ci.aiEvals.budget.maxCases precisa ser inteiro positivo');
  if (!isPositiveInteger(maxOutputChars))
    throw new AiConfigError('ci.aiEvals.budget.maxOutputChars precisa ser inteiro positivo');
  return {
    enabled: raw.enabled === true,
    minScore,
    blockOnFailure,
    budget: { maxCases, maxOutputChars },
  };
}

function normalizeExpect(expect, caseId) {
  if (expect === undefined) return {};
  if (expect === null || typeof expect !== 'object' || Array.isArray(expect)) {
    throw new AiConfigError(`caso ${caseId}: expect precisa ser objeto`);
  }
  const isStringArray = (value) =>
    Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0);
  const jsonKeys = expect.jsonKeys;
  if (jsonKeys !== undefined && !isStringArray(jsonKeys)) {
    throw new AiConfigError(`caso ${caseId}: expect.jsonKeys precisa ser array de strings`);
  }
  let contains;
  if (expect.contains !== undefined) {
    if (typeof expect.contains === 'string' && expect.contains.length > 0) {
      contains = [expect.contains];
    } else if (isStringArray(expect.contains)) {
      contains = expect.contains;
    } else {
      throw new AiConfigError(`caso ${caseId}: expect.contains precisa ser string ou array de strings`);
    }
  }
  return { jsonKeys, contains };
}

/**
 * Carrega e valida o golden dataset. Limite de casos vem do budget.
 */
function loadDataset(root, maxCases) {
  const dataset = readJsonFile(root, DATASET_PATH);
  if (dataset === undefined) throw new AiConfigError(`${DATASET_PATH} ausente`);
  if (!Array.isArray(dataset) || dataset.length === 0) {
    throw new AiConfigError(`${DATASET_PATH} precisa ser array nao vazio`);
  }
  const seen = new Set();
  const cases = dataset.map((item, index) => {
    if (!item || typeof item !== 'object') throw new AiConfigError(`caso ${index}: precisa ser objeto`);
    if (typeof item.id !== 'string' || !item.id) throw new AiConfigError(`caso ${index}: id obrigatorio`);
    if (seen.has(item.id)) throw new AiConfigError(`caso ${item.id}: id duplicado`);
    seen.add(item.id);
    if (typeof item.input !== 'string' || !item.input)
      throw new AiConfigError(`caso ${item.id}: input obrigatorio`);
    return { id: item.id, input: item.input, expect: normalizeExpect(item.expect, item.id) };
  });
  if (cases.length > maxCases) {
    throw new AiConfigError(
      `dataset tem ${cases.length} casos, acima de ci.aiEvals.budget.maxCases (${maxCases})`,
    );
  }
  return cases;
}

/**
 * Le baseline.json (somente leitura). Nunca e escrito por este script.
 */
function loadBaseline(root) {
  const baseline = readJsonFile(root, BASELINE_PATH);
  if (baseline === undefined) return null;
  if (!baseline || !isNonNegativeScore(baseline.passRate)) {
    throw new AiConfigError(`${BASELINE_PATH}: passRate precisa ser numero entre 0 e 1`);
  }
  return baseline.passRate;
}

function parseJsonObject(text) {
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Pontua uma resposta. Caso passa somente se todos os checks passarem.
 */
function scoreCase(testCase, content) {
  const checks = [];
  const text = typeof content === 'string' ? content : '';
  checks.push({ name: 'non_empty', ok: text.trim().length > 0 });

  if (testCase.expect.jsonKeys !== undefined) {
    const parsed = parseJsonObject(text);
    checks.push({ name: 'json_schema', ok: parsed !== null });
    for (const key of testCase.expect.jsonKeys) {
      checks.push({
        name: `json_key:${key}`,
        ok: parsed !== null && Object.prototype.hasOwnProperty.call(parsed, key),
      });
    }
  }
  for (const needle of testCase.expect.contains || []) {
    checks.push({ name: `contains:${needle}`, ok: text.includes(needle) });
  }
  return {
    id: testCase.id,
    passed: checks.every((check) => check.ok),
    checks,
  };
}

function formatModelList(models) {
  return models.length > 0 ? models.join(', ') : '(nenhum)';
}

function result(status, message, exitCode, extra = {}) {
  return { status, message, exitCode, ...extra };
}

/**
 * Executa o gate. Retorna { status, message, exitCode, ... } e nunca escreve arquivos.
 */
async function runAiEvalsGate({ root = process.cwd(), changedFiles = [], env = process.env } = {}) {
  let config;
  let settings;
  let cases;
  let baselineRate;
  try {
    config = loadAiEvalsConfig(root);
    if (!config.enabled) {
      return result('skipped', 'ci.aiEvals.enabled e false', 0);
    }
    const aiChanges = findAiAssetChanges(changedFiles);
    if (aiChanges.length === 0) {
      return result('skipped', 'nenhum prompt, skill ou agente alterado', 0);
    }
    cases = loadDataset(root, config.budget.maxCases);
    baselineRate = loadBaseline(root);
    settings = resolveAiSettings({ root, env });
  } catch (err) {
    if (err instanceof AiConfigError) return result('error', err.message, 2);
    throw err;
  }

  if (!settings.model) {
    return result(
      'skipped',
      'modelo nao configurado: defina QG_AI_MODEL ou "model" em .quality-gate/ai.local.json',
      0,
    );
  }

  const selection = await selectProvider(settings.providers, settings.model, { apiKey: settings.apiKey });
  if (!selection.provider) {
    const reachable = selection.attempts.filter((attempt) => attempt.reachable);
    if (reachable.length === 0) {
      return result('skipped', 'nenhum provedor local alcancavel (9Router, Ollama)', 0);
    }
    const listing = reachable
      .map((attempt) => `${attempt.id}: ${formatModelList(attempt.models)}`)
      .join('; ');
    return result('skipped', `modelo "${settings.model}" nao listado. Ids disponiveis: ${listing}`, 0);
  }

  const { provider } = selection;
  const outcomes = [];
  let outputChars = 0;
  for (const testCase of cases) {
    if (outputChars >= config.budget.maxOutputChars) {
      outcomes.push({ id: testCase.id, passed: false, checks: [{ name: 'budget_output_chars', ok: false }] });
      continue;
    }
    let content = '';
    try {
      content = await chat(
        provider,
        settings.model,
        [
          { role: 'system', content: SYSTEM_PROMPT_NOTE },
          { role: 'user', content: testCase.input },
        ],
        { apiKey: settings.apiKey },
      );
    } catch {
      content = '';
    }
    outputChars += content.length;
    outcomes.push(scoreCase(testCase, content));
  }

  const passedCount = outcomes.filter((outcome) => outcome.passed).length;
  const passRate = Number((passedCount / outcomes.length).toFixed(4));
  const threshold = Math.max(config.minScore, baselineRate ?? 0);
  const summary = `pass-rate ${passRate} (${passedCount}/${outcomes.length}) via ${provider.id}, limite ${threshold}`;
  const details = {
    provider: provider.id,
    model: settings.model,
    passRate,
    threshold,
    baseline: baselineRate,
    cases: outcomes,
  };

  if (passRate < threshold) {
    const exitCode = config.blockOnFailure ? 1 : 0;
    return result('failed', `${summary}; abaixo do limite`, exitCode, details);
  }
  const ratchetHint =
    baselineRate !== null && passRate > baselineRate
      ? ` (acima do baseline ${baselineRate}; suba ${BASELINE_PATH} manualmente via update)`
      : '';
  return result('passed', `${summary}${ratchetHint}`, 0, details);
}

function parseArgs(argv) {
  const args = { root: process.cwd(), changedFiles: [], json: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--json') {
      args.json = true;
    } else if (arg === '--root') {
      args.root = argv[++index];
    } else if (arg === '--changed-files') {
      const value = argv[++index];
      if (value === undefined) throw new AiConfigError('--changed-files exige uma lista');
      args.changedFiles = value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    } else {
      throw new AiConfigError(`argumento desconhecido: ${arg}`);
    }
  }
  return args;
}

async function main(argv = process.argv.slice(2), env = process.env) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`[ai-evals] ${err.message}\n`);
    return 2;
  }
  const outcome = await runAiEvalsGate({ root: args.root, changedFiles: args.changedFiles, env });
  if (args.json) {
    process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
  } else {
    process.stdout.write(`[ai-evals] ${outcome.status}: ${outcome.message}\n`);
  }
  return outcome.exitCode;
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  });
}

module.exports = {
  DATASET_PATH,
  BASELINE_PATH,
  POLICY_PATH,
  findAiAssetChanges,
  isAiAssetPath,
  loadAiEvalsConfig,
  loadBaseline,
  loadDataset,
  main,
  parseArgs,
  runAiEvalsGate,
  scoreCase,
};
