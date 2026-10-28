const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  AiClientError,
  AiConfigError,
  chat,
  listModels,
  readAiLocalConfig,
  resolveAiSettings,
  resolveProviders,
  selectProvider,
} = require('./lib/local-ai-client.cjs');

// Servidor falso em loopback (porta 0). Nenhuma chamada sai da maquina.
function startFakeProvider({ models = [], content = 'ok', delayMs = 0, status = 200 } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      calls.push({
        method: req.method,
        url: req.url,
        auth: req.headers.authorization || null,
        body: raw ? JSON.parse(raw) : null,
      });
      const reply = (code, payload) => {
        setTimeout(() => {
          res.writeHead(code, { 'content-type': 'application/json' });
          res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
        }, delayMs);
      };
      if (status !== 200) {
        reply(status, { error: 'forced' });
        return;
      }
      if (req.method === 'GET' && req.url === '/v1/models') {
        if (models === null) {
          reply(200, { unexpected: true });
          return;
        }
        reply(200, { object: 'list', data: models.map((id) => ({ id, object: 'model' })) });
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        reply(200, { choices: [{ message: { role: 'assistant', content } }] });
        return;
      }
      reply(404, { error: 'not found' });
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

// Porta que acabou de ser liberada: conexao recusada, sem rede externa.
function closedUrl() {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(`http://127.0.0.1:${port}`));
    });
  });
}

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qg-ai-client-'));
}

test('resolveProviders uses generic defaults when env is missing', () => {
  const providers = resolveProviders({});
  assert.deepEqual(providers.map((p) => p.id), ['9router', 'ollama']);
  assert.equal(providers[0].baseUrl, 'http://127.0.0.1:20128');
  assert.equal(providers[1].baseUrl, 'http://localhost:11434');
});

test('resolveProviders reads env overrides and strips trailing slashes', () => {
  const providers = resolveProviders({
    QG_9ROUTER_URL: 'http://127.0.0.1:9999/',
    QG_OLLAMA_URL: '  http://127.0.0.1:8888  ',
  });
  assert.equal(providers[0].baseUrl, 'http://127.0.0.1:9999');
  assert.equal(providers[1].baseUrl, 'http://127.0.0.1:8888');
});

test('resolveProviders rejects non-http URLs and invalid URLs', () => {
  assert.throws(() => resolveProviders({ QG_9ROUTER_URL: 'file:///etc/passwd' }), AiConfigError);
  assert.throws(() => resolveProviders({ QG_OLLAMA_URL: 'not a url' }), AiConfigError);
});

test('resolveAiSettings prefers QG_AI_MODEL over ai.local.json and reads API key from env', () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, '.quality-gate'), { recursive: true });
  fs.writeFileSync(path.join(root, '.quality-gate/ai.local.json'), JSON.stringify({ model: 'from-file' }));

  const fromEnv = resolveAiSettings({ root, env: { QG_AI_MODEL: 'from-env', QG_AI_API_KEY: 'k-test' } });
  assert.equal(fromEnv.model, 'from-env');
  assert.equal(fromEnv.apiKey, 'k-test');

  const fromFile = resolveAiSettings({ root, env: {} });
  assert.equal(fromFile.model, 'from-file');
  assert.equal(fromFile.apiKey, null);
});

test('resolveAiSettings returns null model when nothing is configured and no local file exists', () => {
  const settings = resolveAiSettings({ root: tmpRoot(), env: {} });
  assert.equal(settings.model, null);
  assert.deepEqual(readAiLocalConfig(tmpRoot()), {});
});

test('readAiLocalConfig rejects malformed local config', () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, '.quality-gate'), { recursive: true });
  fs.writeFileSync(path.join(root, '.quality-gate/ai.local.json'), '{ nope');
  assert.throws(() => readAiLocalConfig(root), AiConfigError);
});

test('listModels calls GET /v1/models and sends bearer token when configured', async () => {
  const fake = await startFakeProvider({ models: ['model-a', 'model-b'] });
  try {
    const ids = await listModels({ id: 'fake', baseUrl: fake.url }, { apiKey: 'k-test' });
    assert.deepEqual(ids, ['model-a', 'model-b']);
    assert.equal(fake.calls[0].method, 'GET');
    assert.equal(fake.calls[0].url, '/v1/models');
    assert.equal(fake.calls[0].auth, 'Bearer k-test');
  } finally {
    await fake.close();
  }
});

test('chat posts to /v1/chat/completions and returns the message content', async () => {
  const fake = await startFakeProvider({ content: 'hello there' });
  try {
    const text = await chat({ id: 'fake', baseUrl: fake.url }, 'model-a', [{ role: 'user', content: 'hi' }]);
    assert.equal(text, 'hello there');
    const [call] = fake.calls;
    assert.equal(call.method, 'POST');
    assert.equal(call.url, '/v1/chat/completions');
    assert.equal(call.body.model, 'model-a');
    assert.equal(call.body.stream, false);
    assert.equal(call.auth, null);
  } finally {
    await fake.close();
  }
});

test('unreachable provider raises AiClientError with code unreachable', async () => {
  const url = await closedUrl();
  await assert.rejects(
    listModels({ id: 'down', baseUrl: url }),
    (err) => err instanceof AiClientError && err.code === 'unreachable',
  );
});

test('non-2xx responses and invalid JSON map to specific error codes', async () => {
  const failing = await startFakeProvider({ status: 500 });
  try {
    await assert.rejects(listModels({ id: 'f', baseUrl: failing.url }), (err) => err.code === 'http_status');
  } finally {
    await failing.close();
  }
  const fake = await startFakeProvider({ models: null });
  try {
    // /v1/models responde JSON sem campo data: invalid_response
    await assert.rejects(listModels({ id: 'f', baseUrl: fake.url }), (err) => err.code === 'invalid_response');
  } finally {
    await fake.close();
  }
});

test('requests time out with code timeout', async () => {
  const slow = await startFakeProvider({ models: ['m'], delayMs: 500 });
  try {
    await assert.rejects(
      listModels({ id: 'slow', baseUrl: slow.url }, { timeoutMs: 50 }),
      (err) => err.code === 'timeout',
    );
  } finally {
    await slow.close();
  }
});

test('selectProvider falls back from 9Router to Ollama when 9Router is down', async () => {
  const down = await closedUrl();
  const ollama = await startFakeProvider({ models: ['model-a'] });
  try {
    const selection = await selectProvider([
      { id: '9router', baseUrl: down },
      { id: 'ollama', baseUrl: ollama.url },
    ], 'model-a');
    assert.equal(selection.provider.id, 'ollama');
    assert.equal(selection.attempts[0].reachable, false);
  } finally {
    await ollama.close();
  }
});

test('selectProvider prefers 9Router when both list the model', async () => {
  const router = await startFakeProvider({ models: ['model-a'] });
  const ollama = await startFakeProvider({ models: ['model-a'] });
  try {
    const selection = await selectProvider([
      { id: '9router', baseUrl: router.url },
      { id: 'ollama', baseUrl: ollama.url },
    ], 'model-a');
    assert.equal(selection.provider.id, '9router');
  } finally {
    await router.close();
    await ollama.close();
  }
});

test('selectProvider returns no provider when every endpoint is unreachable', async () => {
  const first = await closedUrl();
  const second = await closedUrl();
  const selection = await selectProvider([
    { id: '9router', baseUrl: first },
    { id: 'ollama', baseUrl: second },
  ], 'model-a');
  assert.equal(selection.provider, null);
  assert.deepEqual(selection.attempts.map((a) => a.reachable), [false, false]);
});
