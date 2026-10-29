const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const {
  BASELINE_PATH,
  DATASET_PATH,
  POLICY_PATH,
  findAiAssetChanges,
  isAiAssetPath,
  loadDataset,
  main,
  parseArgs,
  runAiEvalsGate,
  scoreCase,
} = require('./ai-evals-gate.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const CHANGED = ['prompts/review.prompt.md'];

// Servidor falso em loopback: /v1/models e /v1/chat/completions. Sem rede externa.
function startFakeProvider({ models = [], answers = {} } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url });
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        const body = JSON.parse(raw);
        const input = body.messages[body.messages.length - 1].content;
        const content = Object.prototype.hasOwnProperty.call(answers, input) ? answers[input] : '';
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        calls,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

// Porta reservada e inalcancavel: o servidor fica aberto (ninguem mais pega a porta)
// e derruba cada socket que chega, entao a requisicao falha sem resposta HTTP.
const unreachableServers = [];
after(() => Promise.all(unreachableServers.map((s) => new Promise((done) => s.close(done)))));

function closedUrl() {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.on('connection', (socket) => socket.destroy());
    unreachableServers.push(server);
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

function httpStatusOf(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('timeout')));
  });
}

function listenOn(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('closedUrl cannot answer HTTP: the request fails with an error, never a status code', async () => {
  const url = await closedUrl();
  await assert.rejects(httpStatusOf(url));
});

test('closedUrl keeps its port reserved, so another listener cannot take it', async () => {
  const url = await closedUrl();
  const squatter = http.createServer((req, res) => res.end('taken'));
  try {
    await assert.rejects(listenOn(squatter, Number(new URL(url).port)), { code: 'EADDRINUSE' });
  } finally {
    if (squatter.listening) squatter.close();
  }
});

// Monta um repo temporario com policy, dataset e (opcionalmente) baseline.
function makeRoot({ aiEvals = { enabled: true, minScore: 0.85, blockOnFailure: true }, cases, baseline, rawDataset } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-ai-gate-'));
  const write = (rel, data) => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  };
  const policy = { schemaVersion: 1, profile: 'test', ci: { requiredChecks: ['x'], coverageRatchet: false, maxFileLines: 300 } };
  if (aiEvals !== undefined) policy.ci.aiEvals = aiEvals;
  write(POLICY_PATH, policy);
  if (rawDataset !== undefined) {
    write(DATASET_PATH, rawDataset);
  } else if (cases !== undefined) {
    write(DATASET_PATH, cases);
  }
  if (baseline !== undefined) write(BASELINE_PATH, baseline);
  return root;
}

function fourCases() {
  return ['case-a', 'case-b', 'case-c', 'case-d'].map((input) => ({
    id: input,
    input,
    expect: { contains: ['yes'] },
  }));
}

test('isAiAssetPath flags prompt, skill and agent files only', () => {
  assert.equal(isAiAssetPath('prompts/review.prompt.md'), true);
  assert.equal(isAiAssetPath('.claude/skills/foo/SKILL.md'), true);
  assert.equal(isAiAssetPath('agents/triage.agent.md'), true);
  assert.equal(isAiAssetPath('AGENTS.md'), true);
  assert.equal(isAiAssetPath('scripts/ai-evals-gate.cjs'), false);
  assert.equal(findAiAssetChanges(['README.md', 'skills/x/SKILL.md']).length, 1);
});

test('gate is skipped when ci.aiEvals is disabled, without touching the network', async () => {
  const root = makeRoot({ aiEvals: { enabled: false, minScore: 0.85, blockOnFailure: true }, cases: fourCases() });
  const outcome = await runAiEvalsGate({
    root,
    changedFiles: CHANGED,
    env: { QG_9ROUTER_URL: 'http://127.0.0.1:1', QG_OLLAMA_URL: 'http://127.0.0.1:1' },
  });
  assert.equal(outcome.status, 'skipped');
  assert.equal(outcome.exitCode, 0);
});

test('gate is skipped when no prompt, skill or agent file changed', async () => {
  const root = makeRoot({ cases: fourCases() });
  const none = await runAiEvalsGate({ root, changedFiles: [], env: {} });
  const unrelated = await runAiEvalsGate({ root, changedFiles: ['src/app.js'], env: {} });
  assert.equal(none.status, 'skipped');
  assert.equal(unrelated.status, 'skipped');
  assert.equal(unrelated.exitCode, 0);
});

test('both providers down gives skipped, never failed', async () => {
  const root = makeRoot({ cases: fourCases() });
  const outcome = await runAiEvalsGate({
    root,
    changedFiles: CHANGED,
    env: {
      QG_AI_MODEL: 'model-a',
      QG_9ROUTER_URL: await closedUrl(),
      QG_OLLAMA_URL: await closedUrl(),
    },
  });
  assert.equal(outcome.status, 'skipped');
  assert.equal(outcome.exitCode, 0);
  assert.match(outcome.message, /nenhum provedor local alcancavel/);
});

test('missing model id gives skipped without calling any provider', async () => {
  const fake = await startFakeProvider({ models: ['model-a'] });
  try {
    const root = makeRoot({ cases: fourCases() });
    const outcome = await runAiEvalsGate({
      root,
      changedFiles: CHANGED,
      env: { QG_9ROUTER_URL: fake.url, QG_OLLAMA_URL: await closedUrl() },
    });
    assert.equal(outcome.status, 'skipped');
    assert.match(outcome.message, /modelo nao configurado/);
    assert.equal(fake.calls.length, 0);
  } finally {
    await fake.close();
  }
});

test('model not listed gives skipped with the available ids in the message', async () => {
  const fake = await startFakeProvider({ models: ['model-a', 'model-b'] });
  try {
    const root = makeRoot({ cases: fourCases() });
    const outcome = await runAiEvalsGate({
      root,
      changedFiles: CHANGED,
      env: { QG_AI_MODEL: 'model-z', QG_9ROUTER_URL: fake.url, QG_OLLAMA_URL: await closedUrl() },
    });
    assert.equal(outcome.status, 'skipped');
    assert.equal(outcome.exitCode, 0);
    assert.match(outcome.message, /model-z/);
    assert.match(outcome.message, /model-a, model-b/);
  } finally {
    await fake.close();
  }
});

test('pass rate below minScore fails and exits 1', async () => {
  const fake = await startFakeProvider({
    models: ['model-a'],
    answers: { 'case-a': 'yes', 'case-b': 'no', 'case-c': 'no', 'case-d': 'yes' },
  });
  try {
    const root = makeRoot({ cases: fourCases() });
    const env = { QG_AI_MODEL: 'model-a', QG_9ROUTER_URL: fake.url, QG_OLLAMA_URL: await closedUrl() };
    const outcome = await runAiEvalsGate({ root, changedFiles: CHANGED, env });
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.exitCode, 1);
    assert.equal(outcome.passRate, 0.5);

    const soft = makeRoot({ aiEvals: { enabled: true, minScore: 0.85, blockOnFailure: false }, cases: fourCases() });
    const advisory = await runAiEvalsGate({ root: soft, changedFiles: CHANGED, env });
    assert.equal(advisory.status, 'failed');
    assert.equal(advisory.exitCode, 0);
  } finally {
    await fake.close();
  }
});

test('pass rate above minScore passes and exits 0', async () => {
  const fake = await startFakeProvider({
    models: ['model-a'],
    answers: { 'case-a': 'yes', 'case-b': 'yes', 'case-c': 'yes', 'case-d': 'yes' },
  });
  try {
    const root = makeRoot({ cases: fourCases() });
    const outcome = await runAiEvalsGate({
      root,
      changedFiles: CHANGED,
      env: { QG_AI_MODEL: 'model-a', QG_9ROUTER_URL: fake.url, QG_OLLAMA_URL: await closedUrl() },
    });
    assert.equal(outcome.status, 'passed');
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.passRate, 1);
  } finally {
    await fake.close();
  }
});

test('falls back to Ollama when 9Router is down and Ollama lists the model', async () => {
  const ollama = await startFakeProvider({
    models: ['model-a'],
    answers: { 'case-a': 'yes', 'case-b': 'yes', 'case-c': 'yes', 'case-d': 'yes' },
  });
  try {
    const root = makeRoot({ cases: fourCases() });
    const outcome = await runAiEvalsGate({
      root,
      changedFiles: CHANGED,
      env: { QG_AI_MODEL: 'model-a', QG_9ROUTER_URL: await closedUrl(), QG_OLLAMA_URL: ollama.url },
    });
    assert.equal(outcome.status, 'passed');
    assert.equal(outcome.provider, 'ollama');
  } finally {
    await ollama.close();
  }
});

test('ratchet: a baseline above minScore raises the threshold and fails a lower rate', async () => {
  const fake = await startFakeProvider({
    models: ['model-a'],
    answers: { 'case-a': 'yes', 'case-b': 'yes', 'case-c': 'yes', 'case-d': 'no' },
  });
  try {
    const root = makeRoot({
      aiEvals: { enabled: true, minScore: 0.5, blockOnFailure: true },
      cases: fourCases(),
      baseline: { passRate: 0.9 },
    });
    const outcome = await runAiEvalsGate({
      root,
      changedFiles: CHANGED,
      env: { QG_AI_MODEL: 'model-a', QG_9ROUTER_URL: fake.url, QG_OLLAMA_URL: await closedUrl() },
    });
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.threshold, 0.9);
  } finally {
    await fake.close();
  }
});

test('baseline is never written, neither when passing nor when failing', async () => {
  const fake = await startFakeProvider({
    models: ['model-a'],
    answers: { 'case-a': 'yes', 'case-b': 'yes', 'case-c': 'yes', 'case-d': 'yes' },
  });
  try {
    const env = { QG_AI_MODEL: 'model-a', QG_9ROUTER_URL: fake.url, QG_OLLAMA_URL: await closedUrl() };

    const absent = makeRoot({ cases: fourCases() });
    const passing = await runAiEvalsGate({ root: absent, changedFiles: CHANGED, env });
    assert.equal(passing.status, 'passed');
    assert.equal(fs.existsSync(path.join(absent, BASELINE_PATH)), false);

    const existing = JSON.stringify({ passRate: 0.25 });
    const present = makeRoot({ cases: fourCases(), baseline: existing });
    await runAiEvalsGate({ root: present, changedFiles: CHANGED, env });
    assert.equal(fs.readFileSync(path.join(present, BASELINE_PATH), 'utf8'), existing);
  } finally {
    await fake.close();
  }
});

test('output budget stops calling the model and counts remaining cases as failed', async () => {
  const fake = await startFakeProvider({
    models: ['model-a'],
    answers: { 'case-a': 'yes yes yes', 'case-b': 'yes', 'case-c': 'yes', 'case-d': 'yes' },
  });
  try {
    const root = makeRoot({
      aiEvals: { enabled: true, minScore: 0.5, blockOnFailure: true, budget: { maxCases: 10, maxOutputChars: 5 } },
      cases: fourCases(),
    });
    const outcome = await runAiEvalsGate({
      root,
      changedFiles: CHANGED,
      env: { QG_AI_MODEL: 'model-a', QG_9ROUTER_URL: fake.url, QG_OLLAMA_URL: await closedUrl() },
    });
    assert.equal(outcome.status, 'failed');
    assert.equal(fake.calls.filter((c) => c.url === '/v1/chat/completions').length, 1);
  } finally {
    await fake.close();
  }
});

test('invalid configuration exits 2', async () => {
  const badScore = makeRoot({ aiEvals: { enabled: true, minScore: 2, blockOnFailure: true }, cases: fourCases() });
  const outOfBudget = makeRoot({
    aiEvals: { enabled: true, minScore: 0.5, blockOnFailure: true, budget: { maxCases: 2, maxOutputChars: 100 } },
    cases: fourCases(),
  });
  const noDataset = makeRoot({});
  const badBaseline = makeRoot({ cases: fourCases(), baseline: { passRate: 7 } });
  const env = { QG_AI_MODEL: 'model-a' };
  for (const root of [badScore, outOfBudget, noDataset, badBaseline]) {
    const outcome = await runAiEvalsGate({ root, changedFiles: CHANGED, env });
    assert.equal(outcome.status, 'error');
    assert.equal(outcome.exitCode, 2);
  }
});

test('duplicate ids and malformed expect are rejected by the dataset loader', () => {
  const root = makeRoot({
    cases: [
      { id: 'dup', input: 'a', expect: {} },
      { id: 'dup', input: 'b', expect: {} },
    ],
  });
  assert.throws(() => loadDataset(root, 10), /duplicado/);

  const badExpect = makeRoot({ cases: [{ id: 'x', input: 'a', expect: { jsonKeys: 'title' } }] });
  assert.throws(() => loadDataset(badExpect, 10), /jsonKeys/);
});

test('scoreCase checks JSON schema, required keys and contains', () => {
  const testCase = { id: 'j', input: 'i', expect: { jsonKeys: ['title'], contains: ['ok'] } };
  assert.equal(scoreCase(testCase, '{"title":"t","note":"ok"}').passed, true);
  assert.equal(scoreCase(testCase, '{"note":"ok"}').passed, false);
  assert.equal(scoreCase(testCase, 'not json ok').passed, false);
  assert.equal(scoreCase({ id: 'c', input: 'i', expect: {} }, '').passed, false);
});

test('repository golden dataset has 3 synthetic cases and passes the loader', () => {
  const cases = loadDataset(REPO_ROOT, 10);
  assert.equal(cases.length, 3);
  for (const testCase of cases) {
    assert.match(testCase.id, /^[a-z0-9-]+$/);
  }
});

test('parseArgs reads --changed-files as a comma-separated list and rejects unknown flags', () => {
  const args = parseArgs(['--changed-files', 'a.prompt.md, b/SKILL.md', '--json']);
  assert.deepEqual(args.changedFiles, ['a.prompt.md', 'b/SKILL.md']);
  assert.equal(args.json, true);
  assert.equal(findAiAssetChanges(args.changedFiles).length, 2);
});

test('main returns exit code 2 for unknown arguments', async () => {
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  try {
    assert.equal(await main(['--bogus']), 2);
  } finally {
    process.stderr.write = original;
  }
});
