const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const { AiClientError, AiConfigError } = require('./lib/local-ai-client.cjs');
const {
  classifyFindings,
  isIgnoredFile,
  limitDiff,
  main,
  parseArgs,
  parseModelReply,
  postReview,
  schemaError,
  splitDiffByFile,
} = require('./pr-ai-review.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const PROVIDER = { id: 'ollama', baseUrl: 'http://fake.local' };
const MARKER = '<!-- qg-inline:ai-review:src/a.js:4 -->';

const DIFF = [
  'diff --git a/src/a.js b/src/a.js',
  'index 111..222 100644',
  '--- a/src/a.js',
  '+++ b/src/a.js',
  '@@ -3,0 +4,2 @@',
  '+const x = 1;',
  '+var y = 2;',
  '',
].join('\n');

const LOCK_DIFF = [
  'diff --git a/package-lock.json b/package-lock.json',
  '--- a/package-lock.json',
  '+++ b/package-lock.json',
  '@@ -1,0 +1,1 @@',
  '+{"lockfileVersion": 3}',
  '',
].join('\n');

function fakeAi({
  model = 'modelo-x',
  providers = [PROVIDER],
  provider = PROVIDER,
  attempts = [],
  reply = '[]',
  chatError = null,
  settingsError = null,
  calls = [],
} = {}) {
  return {
    resolveAiSettings: () => {
      if (settingsError) throw settingsError;
      return { model, apiKey: null, providers };
    },
    selectProvider: async () => ({ provider, models: [model], attempts }),
    chat: async (p, m, messages) => {
      calls.push({ provider: p, model: m, messages });
      if (chatError) throw chatError;
      return reply;
    },
  };
}

function fakeExec({ diff = DIFF, existing = '', ghCalls = [] } = {}) {
  return (cmd, args, opts) => {
    if (cmd === 'git') return diff;
    if (cmd === 'gh') {
      ghCalls.push({ args, input: opts && opts.input });
      return existing;
    }
    throw new Error(`comando inesperado: ${cmd}`);
  };
}

async function run(argv, deps = {}) {
  let out = '';
  let err = '';
  const code = await main(argv, {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
    cwd: REPO_ROOT,
    env: {},
    ...deps,
  });
  return { code, out, err, report: out ? JSON.parse(out) : null };
}

const BASE_ARGS = ['--base', 'origin/main'];

test('achado valido em linha adicionada vira comentario inline (dry-run)', async () => {
  const calls = [];
  const reply = JSON.stringify([
    { file: 'src/a.js', line: 4, severity: 'high', message: 'variável reatribuída indevidamente' },
  ]);
  const { code, report } = await run(BASE_ARGS, {
    ai: fakeAi({ reply, calls }),
    execFileSync: fakeExec(),
  });
  assert.equal(code, 0);
  assert.equal(report.status, 'ok');
  assert.equal(report.mode, 'dry-run');
  assert.equal(report.posted, false);
  assert.equal(report.findings.length, 1);
  assert.equal(report.comments.length, 1);
  assert.equal(report.comments[0].path, 'src/a.js');
  assert.equal(report.comments[0].line, 4);
  assert.match(report.comments[0].body, /\[high\] variável reatribuída/);
  assert.equal(report.discarded.length, 0);
  assert.equal(report.provider, 'ollama');
  assert.equal(report.model, 'modelo-x');
  // o prompt de sistema vem do arquivo versionado e o usuário recebe o diff
  assert.match(calls[0].messages[0].content, /Responda SOMENTE com um array JSON/);
  assert.equal(calls[0].messages[1].content, `${DIFF.replace(/\n+$/, '')}\n`);
});

test('achado em linha que nao e adicionada e descartado', async () => {
  const reply = JSON.stringify([
    { file: 'src/a.js', line: 3, severity: 'low', message: 'linha de contexto' },
    { file: 'src/a.js', line: 99, severity: 'low', message: 'linha inexistente' },
  ]);
  const { code, report } = await run(BASE_ARGS, { ai: fakeAi({ reply }), execFileSync: fakeExec() });
  assert.equal(code, 0);
  assert.equal(report.findings.length, 0);
  assert.equal(report.comments.length, 0);
  assert.deepEqual(
    report.discarded.map((item) => item.reason),
    ['linha não adicionada no diff', 'linha não adicionada no diff'],
  );
});

test('JSON invalido vira erro reportado, nunca zero achados', async () => {
  const { code, report, err } = await run(BASE_ARGS, {
    ai: fakeAi({ reply: 'aqui estão os achados: [' }),
    execFileSync: fakeExec(),
  });
  assert.equal(code, 1);
  assert.equal(report.status, 'error');
  assert.match(report.reason, /não é JSON válido/);
  assert.match(err, /pr-ai-review: /);
});

test('resposta JSON que nao e array vira erro', async () => {
  const { code, report } = await run(BASE_ARGS, {
    ai: fakeAi({ reply: '{"findings": []}' }),
    execFileSync: fakeExec(),
  });
  assert.equal(code, 1);
  assert.equal(report.status, 'error');
  assert.match(report.reason, /array JSON/);
});

test('itens com formato invalido sao descartados com motivo', async () => {
  const reply = JSON.stringify([
    { file: 'src/a.js', line: '4', severity: 'high', message: 'linha como texto' },
    { file: 'src/a.js', line: 4, severity: 'urgent', message: 'severidade inventada' },
    { file: 'src/a.js', line: 4, severity: 'low', message: '   ' },
    5,
    null,
    { file: '  ', line: 4, severity: 'low', message: 'arquivo vazio' },
    { file: 'src/a.js', line: 0, severity: 'low', message: 'linha zero' },
    { file: './src/a.js', line: 4, severity: 'low', message: 'caminho com ./ aceito' },
  ]);
  const { code, report } = await run(BASE_ARGS, { ai: fakeAi({ reply }), execFileSync: fakeExec() });
  assert.equal(code, 0);
  assert.equal(report.discarded.length, 7);
  assert.ok(report.discarded.every((item) => item.reason.startsWith('formato: ')));
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].file, 'src/a.js');
});

test('achado em arquivo que nao foi enviado ao modelo e descartado', async () => {
  const reply = JSON.stringify([{ file: 'outro.js', line: 1, severity: 'low', message: 'fora do diff' }]);
  const { report } = await run(BASE_ARGS, { ai: fakeAi({ reply }), execFileSync: fakeExec() });
  assert.equal(report.findings.length, 0);
  assert.equal(report.discarded[0].reason, 'arquivo não enviado ao modelo');
});

test('lockfile e arquivo gerado nao vao ao modelo', async () => {
  const calls = [];
  const exec = fakeExec({ diff: `${LOCK_DIFF}${DIFF}` });
  const reply = JSON.stringify([{ file: 'package-lock.json', line: 1, severity: 'low', message: 'x' }]);
  const { report } = await run(BASE_ARGS, { ai: fakeAi({ reply, calls }), execFileSync: exec });
  assert.deepEqual(report.diff.ignored, ['package-lock.json']);
  assert.deepEqual(report.diff.files, ['src/a.js']);
  assert.ok(!calls[0].messages[1].content.includes('lockfileVersion'));
  assert.equal(report.discarded[0].reason, 'arquivo não enviado ao modelo');
});

test('limite de tamanho do diff e respeitado e arquivos excedentes sao omitidos', async () => {
  const bigBody = Array.from({ length: 40 }, (_, i) => `+const v${i} = ${i};`).join('\n');
  const section = (name) =>
    [
      `diff --git a/${name} b/${name}`,
      `--- a/${name}`,
      `+++ b/${name}`,
      `@@ -0,0 +1,40 @@`,
      bigBody,
      '',
    ].join('\n');
  const diff = [section('one.js'), section('two.js'), section('three.js')].join('');
  const maxChars = 1200;
  const calls = [];
  const { code, report } = await run(['--base', 'origin/main', '--max-chars', String(maxChars)], {
    ai: fakeAi({ calls }),
    execFileSync: fakeExec({ diff }),
  });
  assert.equal(code, 0);
  const sent = calls[0].messages[1].content;
  assert.ok(sent.length <= maxChars, `enviado ${sent.length} > ${maxChars}`);
  assert.equal(report.diff.maxChars, maxChars);
  assert.equal(report.diff.chars, sent.length);
  assert.ok(report.diff.omitted.length >= 1);
  assert.deepEqual(report.diff.files, ['one.js']);
});

test('arquivo unico maior que o limite e omitido e sem nada a enviar vira skipped', async () => {
  const calls = [];
  const { code, report } = await run(['--base', 'origin/main', '--max-chars', '10'], {
    ai: fakeAi({ calls }),
    execFileSync: fakeExec(),
  });
  assert.equal(code, 0);
  assert.equal(report.status, 'skipped');
  assert.match(report.reason, /limite de 10 caracteres/);
  assert.equal(calls.length, 0);
});

test('sem provedor configurado retorna skipped com motivo e exit 0', async () => {
  const calls = [];
  const { code, report } = await run(BASE_ARGS, {
    ai: fakeAi({ provider: null, providers: [], calls }),
    execFileSync: fakeExec(),
  });
  assert.equal(code, 0);
  assert.equal(report.status, 'skipped');
  assert.match(report.reason, /sem provedor configurado/);
  assert.equal(calls.length, 0);
});

test('provedor alcancavel sem o modelo pedido retorna skipped listando os ids', async () => {
  const attempts = [{ id: 'ollama', reachable: true, reason: null, models: ['outro'] }];
  const { code, report } = await run(BASE_ARGS, {
    ai: fakeAi({ provider: null, attempts }),
    execFileSync: fakeExec(),
  });
  assert.equal(code, 0);
  assert.equal(report.status, 'skipped');
  assert.match(report.reason, /não listado/);
});

test('sem modelo configurado retorna skipped', async () => {
  const calls = [];
  const { code, report } = await run(BASE_ARGS, {
    ai: fakeAi({ model: null, calls }),
    execFileSync: fakeExec(),
  });
  assert.equal(code, 0);
  assert.equal(report.status, 'skipped');
  assert.match(report.reason, /modelo não configurado/);
  assert.equal(calls.length, 0);
});

test('diff sem linha adicionada retorna skipped sem consultar provedor', async () => {
  const { code, report } = await run(BASE_ARGS, {
    ai: fakeAi({ settingsError: new Error('nao deveria ser chamado') }),
    execFileSync: fakeExec({ diff: '' }),
  });
  assert.equal(code, 0);
  assert.equal(report.status, 'skipped');
  assert.match(report.reason, /nenhuma linha adicionada/);
});

test('configuracao de IA invalida sai com 2', async () => {
  const { code, report } = await run(BASE_ARGS, {
    ai: fakeAi({ settingsError: new AiConfigError('.quality-gate/ai.local.json nao e um JSON valido') }),
    execFileSync: fakeExec(),
  });
  assert.equal(code, 2);
  assert.equal(report.status, 'error');
});

test('falha do provedor durante o chat sai com 1 e e reportada', async () => {
  const { code, report } = await run(BASE_ARGS, {
    ai: fakeAi({ chatError: new AiClientError('timeout', 'timeout em /v1/chat/completions') }),
    execFileSync: fakeExec(),
  });
  assert.equal(code, 1);
  assert.equal(report.status, 'error');
  assert.match(report.reason, /timeout/);
});

test('falha do git (ref inexistente) sai com 1 usando o git real', async () => {
  const { code, report } = await run(['--base', 'refs/heads/nao-existe-xyz-123'], {
    ai: fakeAi(),
  });
  assert.equal(code, 1);
  assert.equal(report.status, 'error');
  assert.match(report.reason, /não foi possível calcular o diff/);
});

test('--base HEAD com git real nao tem linha adicionada e nao chama provedor', async () => {
  const { code, report } = await run(['--base', 'HEAD'], {
    ai: fakeAi({ settingsError: new Error('nao deveria ser chamado') }),
  });
  assert.equal(code, 0);
  assert.equal(report.status, 'skipped');
});

test('dry-run nao fala com o GitHub mesmo com achados', async () => {
  const ghCalls = [];
  const reply = JSON.stringify([{ file: 'src/a.js', line: 4, severity: 'low', message: 'x' }]);
  const { code, report } = await run(['--base', 'origin/main', '--dry-run'], {
    ai: fakeAi({ reply }),
    execFileSync: fakeExec({ ghCalls }),
  });
  assert.equal(code, 0);
  assert.equal(report.mode, 'dry-run');
  assert.equal(report.posted, false);
  assert.equal(ghCalls.length, 0);
});

test('--post sem GITHUB_TOKEN falha fechado antes de qualquer chamada', async () => {
  const calls = [];
  const ghCalls = [];
  const { code, report } = await run(['--base', 'origin/main', '--post', '--pr', '7', '--repo', 'a/b'], {
    ai: fakeAi({ calls }),
    execFileSync: fakeExec({ ghCalls }),
    env: {},
  });
  assert.equal(code, 2);
  assert.equal(report.status, 'error');
  assert.match(report.reason, /GITHUB_TOKEN/);
  assert.equal(calls.length, 0);
  assert.equal(ghCalls.length, 0);
});

test('--post com token posta uma review COMMENT com os achados', async () => {
  const ghCalls = [];
  const reply = JSON.stringify([{ file: 'src/a.js', line: 4, severity: 'medium', message: 'checar nulo' }]);
  const { code, report } = await run(['--base', 'origin/main', '--post', '--pr', '7', '--repo', 'a/b'], {
    ai: fakeAi({ reply }),
    execFileSync: fakeExec({ ghCalls }),
    env: { GITHUB_TOKEN: 'token-de-teste' },
  });
  assert.equal(code, 0);
  assert.equal(report.mode, 'post');
  assert.equal(report.posted, true);
  assert.equal(report.pr, 7);
  const post = ghCalls.find((call) => call.args.includes('POST'));
  assert.ok(post, 'deve chamar gh api POST');
  assert.ok(post.args.includes('repos/a/b/pulls/7/reviews'));
  const payload = JSON.parse(post.input);
  assert.equal(payload.event, 'COMMENT');
  assert.equal(payload.comments.length, 1);
  assert.equal(payload.comments[0].path, 'src/a.js');
});

test('--post nao reposta comentario que ja existe (dedupe por marcador)', async () => {
  const ghCalls = [];
  const reply = JSON.stringify([{ file: 'src/a.js', line: 4, severity: 'low', message: 'x' }]);
  const { code, report } = await run(['--base', 'origin/main', '--post', '--pr', '7', '--repo', 'a/b'], {
    ai: fakeAi({ reply }),
    execFileSync: fakeExec({ ghCalls, existing: `antigo ${MARKER}\n` }),
    env: { GITHUB_TOKEN: 'token-de-teste' },
  });
  assert.equal(code, 0);
  assert.equal(report.posted, false);
  assert.deepEqual(report.skipped_existing, [MARKER]);
  assert.equal(ghCalls.filter((call) => call.args.includes('POST')).length, 0);
});

test('--post sem achados validos nao cria review', async () => {
  const ghCalls = [];
  const { code, report } = await run(['--base', 'origin/main', '--post', '--pr', '7', '--repo', 'a/b'], {
    ai: fakeAi({ reply: '[]' }),
    execFileSync: fakeExec({ ghCalls }),
    env: { GITHUB_TOKEN: 'token-de-teste' },
  });
  assert.equal(code, 0);
  assert.equal(report.posted, false);
  assert.equal(ghCalls.filter((call) => call.args.includes('POST')).length, 0);
});

test('--post e --dry-run juntos sao rejeitados', async () => {
  const { code, report } = await run(['--post', '--dry-run', '--pr', '7'], { ai: fakeAi() });
  assert.equal(code, 2);
  assert.match(report.reason, /não os dois/);
});

test('--post sem --pr e rejeitado', async () => {
  const { code, report } = await run(['--post'], { ai: fakeAi(), env: { GITHUB_TOKEN: 'x' } });
  assert.equal(code, 2);
  assert.match(report.reason, /--post precisa de --pr/);
});

test('argumento desconhecido e valor ausente sao rejeitados', async () => {
  const unknown = await run(['--nope'], { ai: fakeAi() });
  assert.equal(unknown.code, 2);
  assert.match(unknown.report.reason, /argumento desconhecido/);
  const missing = await run(['--base', '--post'], { ai: fakeAi() });
  assert.equal(missing.code, 2);
  assert.match(missing.report.reason, /precisa de valor/);
});

test('parseArgs aceita todas as opcoes e valida entradas', () => {
  assert.deepEqual(parseArgs([]), {
    base: 'origin/main',
    head: 'HEAD',
    maxChars: 60000,
    repo: null,
    pr: null,
    post: false,
    dryRun: false,
  });
  assert.deepEqual(
    parseArgs([
      '--base',
      'main',
      '--head',
      'feat',
      '--max-chars',
      '5000',
      '--repo',
      'a/b',
      '--pr',
      '3',
      '--post',
    ]),
    { base: 'main', head: 'feat', maxChars: 5000, repo: 'a/b', pr: 3, post: true, dryRun: false },
  );
  assert.equal(parseArgs(['--dry-run']).dryRun, true);
  assert.throws(() => parseArgs(['--max-chars', '0']), /inteiro positivo/);
  assert.throws(() => parseArgs(['--pr', 'abc']), /número positivo/);
  assert.throws(() => parseArgs(['--head', '-x']), /ref inválida/);
});

test('isIgnoredFile cobre lockfiles, minificados, binarios e pastas geradas', () => {
  for (const file of [
    'package-lock.json',
    'sub/yarn.lock',
    'Cargo.lock',
    'app.min.js',
    'app.css.map',
    'dist/bundle.js',
    'vendor/x.go',
    'logo.png',
  ]) {
    assert.equal(isIgnoredFile(file), true, file);
  }
  assert.equal(isIgnoredFile('scripts/pr-ai-review.cjs'), false);
});

test('splitDiffByFile separa secoes por arquivo e tira quebras finais', () => {
  const sections = splitDiffByFile(`${DIFF}${LOCK_DIFF}`);
  assert.deepEqual(
    sections.map((s) => s.file),
    ['src/a.js', 'package-lock.json'],
  );
  assert.ok(!sections[0].text.endsWith('\n'));
  assert.deepEqual(splitDiffByFile(''), []);
});

test('limitDiff pula arquivo que nao cabe e segue com os seguintes', () => {
  const sections = [
    { file: 'grande.js', text: 'x'.repeat(100) },
    { file: 'pequeno.js', text: 'y'.repeat(10) },
  ];
  const result = limitDiff(sections, 50);
  assert.deepEqual(result.included, ['pequeno.js']);
  assert.deepEqual(result.omitted, ['grande.js']);
  assert.equal(result.text, `${'y'.repeat(10)}\n`);
});

test('parseModelReply e schemaError validam o formato', () => {
  assert.deepEqual(parseModelReply(' [] \n'), []);
  assert.throws(() => parseModelReply('```json\n[]\n```'), /não é JSON válido/);
  assert.equal(schemaError(null), 'precisa ser objeto');
  assert.equal(schemaError([]), 'precisa ser objeto');
  assert.equal(schemaError({ file: 'a', line: 1, severity: 'low', message: 'ok' }), null);
});

test('classifyFindings separa validos de descartados', () => {
  const addedLines = new Map([['src/a.js', new Set([4])]]);
  const sentFiles = new Set(['src/a.js']);
  const { valid, discarded } = classifyFindings(
    [
      { file: 'src/a.js', line: 4, severity: 'low', message: ' ok ' },
      { file: 'src/a.js', line: 5, severity: 'low', message: 'fora' },
      { file: 'x.js', line: 4, severity: 'low', message: 'x' },
    ],
    { addedLines, sentFiles },
  );
  assert.deepEqual(valid, [{ file: 'src/a.js', line: 4, severity: 'low', message: 'ok' }]);
  assert.equal(discarded.length, 2);
});

test('postReview nao cria review quando todos os comentarios ja existem', async () => {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push(args);
    return `${MARKER}`;
  };
  const items = [
    {
      marker: MARKER,
      comment: { path: 'src/a.js', line: 4, side: 'RIGHT', body: MARKER },
    },
  ];
  const result = postReview({ repo: 'a/b', pr: 1, items, exec });
  assert.equal(result.posted, false);
  assert.equal(calls.length, 1);
});
