'use strict';
/**
 * local-ai-client.cjs — cliente HTTP minimo para provedores de IA locais.
 *
 * Fala o protocolo compativel com OpenAI (GET /v1/models, POST /v1/chat/completions)
 * usando apenas node:http / node:https, sem dependencias de runtime.
 *
 * Configuracao vem somente de variaveis de ambiente (QG_9ROUTER_URL, QG_OLLAMA_URL,
 * QG_AI_API_KEY, QG_AI_MODEL) e de .quality-gate/ai.local.json (gitignored).
 * Nenhum id de modelo e definido aqui.
 */
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');

const PROVIDERS = Object.freeze([
  Object.freeze({ id: '9router', envVar: 'QG_9ROUTER_URL', defaultUrl: 'http://127.0.0.1:20128' }),
  Object.freeze({ id: 'ollama', envVar: 'QG_OLLAMA_URL', defaultUrl: 'http://localhost:11434' }),
]);

const AI_LOCAL_CONFIG_PATH = '.quality-gate/ai.local.json';
const LIST_TIMEOUT_MS = 5000;
const CHAT_TIMEOUT_MS = 60000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

class AiClientError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'AiClientError';
    this.code = code;
  }
}

class AiConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AiConfigError';
    this.code = 'QG_CONFIG';
  }
}

function normalizeBaseUrl(raw, providerId) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new AiConfigError(`URL do provedor ${providerId} invalida`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AiConfigError(`URL do provedor ${providerId} precisa ser http ou https`);
  }
  return raw.replace(/\/+$/, '');
}

/**
 * Resolve a lista ordenada de provedores (9Router primeiro, depois Ollama).
 * Variavel ausente ou vazia usa o padrao generico.
 */
function resolveProviders(env = process.env) {
  return PROVIDERS.map((provider) => {
    const raw = typeof env[provider.envVar] === 'string' ? env[provider.envVar].trim() : '';
    const value = raw || provider.defaultUrl;
    return { id: provider.id, baseUrl: normalizeBaseUrl(value, provider.id) };
  });
}

/**
 * Le .quality-gate/ai.local.json da raiz. Arquivo ausente retorna {}.
 */
function readAiLocalConfig(root) {
  const filePath = path.join(root, AI_LOCAL_CONFIG_PATH);
  if (!fs.existsSync(filePath)) return {};
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    throw new AiConfigError(`${AI_LOCAL_CONFIG_PATH} nao e um JSON valido`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AiConfigError(`${AI_LOCAL_CONFIG_PATH} precisa ser um objeto JSON`);
  }
  return parsed;
}

/**
 * Resolve modelo (QG_AI_MODEL tem prioridade sobre o arquivo local), chave e provedores.
 */
function resolveAiSettings({ root, env = process.env }) {
  const local = readAiLocalConfig(root);
  const envModel = typeof env.QG_AI_MODEL === 'string' ? env.QG_AI_MODEL.trim() : '';
  const localModel = typeof local.model === 'string' ? local.model.trim() : '';
  const apiKey = typeof env.QG_AI_API_KEY === 'string' && env.QG_AI_API_KEY.trim()
    ? env.QG_AI_API_KEY.trim()
    : null;
  return {
    model: envModel || localModel || null,
    apiKey,
    providers: resolveProviders(env),
  };
}

function requestJson(baseUrl, method, pathname, { body, apiKey, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${baseUrl}${pathname}`);
    const transport = url.protocol === 'https:' ? https : http;
    const headers = { accept: 'application/json' };
    const payload = body === undefined ? null : JSON.stringify(body);
    if (payload !== null) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;

    const req = transport.request(url, { method, headers, timeout: timeoutMs }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          req.destroy(new AiClientError('too_large', 'resposta do provedor excede o limite'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new AiClientError('http_status', `HTTP ${res.statusCode} em ${method} ${pathname}`));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (err) {
          reject(new AiClientError('invalid_json', `resposta invalida em ${pathname}`, { cause: err }));
        }
      });
      res.on('error', (err) => reject(new AiClientError('unreachable', 'falha ao ler resposta', { cause: err })));
    });

    req.on('timeout', () => req.destroy(new AiClientError('timeout', `timeout em ${pathname}`)));
    req.on('error', (err) => {
      if (err instanceof AiClientError) {
        reject(err);
      } else {
        reject(new AiClientError('unreachable', `provedor indisponivel em ${pathname}`, { cause: err }));
      }
    });
    if (payload !== null) req.write(payload);
    req.end();
  });
}

/**
 * GET /v1/models. Retorna array de ids de modelo listados pelo provedor.
 */
async function listModels(provider, { apiKey = null, timeoutMs = LIST_TIMEOUT_MS } = {}) {
  const data = await requestJson(provider.baseUrl, 'GET', '/v1/models', { apiKey, timeoutMs });
  if (!data || !Array.isArray(data.data)) {
    throw new AiClientError('invalid_response', 'resposta de /v1/models sem campo data');
  }
  return data.data
    .map((entry) => entry?.id)
    .filter((id) => typeof id === 'string' && id.length > 0);
}

/**
 * POST /v1/chat/completions. Retorna o texto da primeira escolha.
 */
async function chat(provider, model, messages, { apiKey = null, timeoutMs = CHAT_TIMEOUT_MS } = {}) {
  const data = await requestJson(provider.baseUrl, 'POST', '/v1/chat/completions', {
    body: { model, messages, stream: false, temperature: 0 },
    apiKey,
    timeoutMs,
  });
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new AiClientError('invalid_response', 'resposta de chat sem choices[0].message.content');
  }
  return content;
}

/**
 * Procura, na ordem dada, o primeiro provedor alcancavel que liste o modelo.
 * Nunca lanca por indisponibilidade: retorna { provider, models, attempts }.
 * provider e null quando nenhum provedor serve o modelo.
 */
async function selectProvider(providers, model, { apiKey = null, timeoutMs = LIST_TIMEOUT_MS } = {}) {
  const attempts = [];
  let firstReachable = null;
  for (const provider of providers) {
    let models;
    try {
      models = await listModels(provider, { apiKey, timeoutMs });
    } catch (err) {
      attempts.push({ id: provider.id, reachable: false, reason: err.code || 'error' });
      continue;
    }
    attempts.push({ id: provider.id, reachable: true, reason: null, models });
    if (!firstReachable) firstReachable = { provider, models };
    if (model && models.includes(model)) {
      return { provider, models, attempts };
    }
  }
  return {
    provider: null,
    models: firstReachable ? firstReachable.models : [],
    attempts,
  };
}

module.exports = {
  AI_LOCAL_CONFIG_PATH,
  AiClientError,
  AiConfigError,
  PROVIDERS,
  chat,
  listModels,
  readAiLocalConfig,
  resolveAiSettings,
  resolveProviders,
  selectProvider,
};
