const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { displayWidth, padEnd, renderTable, renderHeaderBox, renderSection } = require('./lib/console-ui.cjs');
const { repoFromRemoteUrl, splitRepo, resolveRepo, detectRepoFromGit } = require('./lib/github.cjs');
const {
  validatePolicy,
  policyHash,
  loadPolicy,
  buildState,
  writeState,
  hasPolicyFiles,
} = require('./lib/policy.cjs');

test('console-ui measures display width and pads strings correctly', () => {
  assert.equal(displayWidth('hello'), 5);
  assert.equal(displayWidth('🚀'), 2);
  assert.equal(displayWidth(''), 0);

  assert.equal(padEnd('abc', 5), 'abc  ');
  assert.equal(padEnd('abcdef', 4), 'abcdef');

  const table = renderTable(['A', 'B'], [['1', '2']]);
  assert.match(table, /┌───┬───┐/);
  assert.match(table, /│ A │ B │/);
  assert.match(table, /│ 1 │ 2 │/);

  const header = renderHeaderBox('Quality Gate', { width: 40 });
  assert.match(header, /Quality Gate/);

  const section = renderSection('Checks');
  assert.match(section, /CHECKS/);
});

test('console-ui displayWidth: caracteres logo antes e depois de cada faixa de emoji', () => {
  const width = (codePoint) => displayWidth(String.fromCodePoint(codePoint));

  // Pictogramas U+1F300..U+1FAFF (largura 2).
  assert.equal(width(0x1f2ff), 1);
  assert.equal(width(0x1f300), 2);
  assert.equal(width(0x1faff), 2);
  assert.equal(width(0x1fb00), 1);

  // Dingbats U+2600..U+27BF (largura 2).
  assert.equal(width(0x25ff), 1);
  assert.equal(width(0x2600), 2);
  assert.equal(width(0x27bf), 2);
  assert.equal(width(0x27c0), 1);

  // Setas e simbolos diversos U+2B00..U+2BFF (largura 2).
  assert.equal(width(0x2aff), 1);
  assert.equal(width(0x2b00), 2);
  assert.equal(width(0x2bff), 2);
  assert.equal(width(0x2c00), 1);
});

test('console-ui displayWidth: variation selector U+FE0F tem largura zero', () => {
  assert.equal(displayWidth('️'), 0);
  assert.equal(displayWidth('a️b'), 2);
  assert.equal(displayWidth('⚠️'), 2);
  assert.equal(padEnd('⚠️', 4), '⚠️  ');
});

test('console-ui renderTable, renderHeaderBox e renderSection geram saida exata', () => {
  assert.equal(
    renderTable(['A', 'B'], [['1', '2']]),
    ['┌───┬───┐', '│ A │ B │', '├───┼───┤', '│ 1 │ 2 │', '└───┴───┘'].join('\n'),
  );

  assert.equal(
    renderHeaderBox('Titulo', { width: 20 }),
    ['  ╭' + '─'.repeat(20) + '╮', '  │ ◆ Titulo' + ' '.repeat(11) + '│', '  ╰' + '─'.repeat(20) + '╯'].join(
      '\n',
    ),
  );
  assert.equal(
    renderHeaderBox('Titulo', { width: 20, right: 'OK' }),
    ['  ╭' + '─'.repeat(20) + '╮', '  │ ◆ Titulo' + ' '.repeat(9) + 'OK│', '  ╰' + '─'.repeat(20) + '╯'].join(
      '\n',
    ),
  );
  assert.equal(renderHeaderBox('X').split('\n')[0], '  ╭' + '─'.repeat(60) + '╮');

  // Titulo maior que a caixa nao pode quebrar o preenchimento (sem espacos negativos).
  const longBox = renderHeaderBox('um titulo bem longo', { width: 10 });
  assert.ok(longBox.includes('um titulo bem longo'));
  assert.equal(longBox.split('\n').length, 3);

  assert.equal(renderSection('resumo'), '  ◆ RESUMO\n  ' + '─'.repeat(60));
  assert.equal(renderSection('resumo', '!'), '  ! RESUMO\n  ' + '─'.repeat(60));
});

test('console-ui renderTable usa a largura real de emoji no cabecalho e nas linhas', () => {
  const table = renderTable(['A'], [['🚀']]);
  const [top, header, , row] = table.split('\n');
  assert.equal(top, '┌────┐');
  assert.equal(header, '│ A  │');
  assert.equal(row, '│ 🚀 │');

  const empty = renderTable(['AB'], []);
  assert.equal(empty.split('\n')[0], '┌────┐');
});

test('github lib parses remote URLs and splits repo correctly', () => {
  assert.equal(repoFromRemoteUrl('git@github.com:owner/repo.git'), 'owner/repo');
  assert.equal(repoFromRemoteUrl('https://github.com/owner/my-app'), 'owner/my-app');
  assert.equal(repoFromRemoteUrl('https://gitlab.com/owner/repo'), null);
  assert.equal(repoFromRemoteUrl(''), null);

  assert.deepEqual(splitRepo('org/repo-name'), { owner: 'org', name: 'repo-name' });
  assert.throws(() => splitRepo('invalid-format'), new RegExp('--repo precisa estar no formato owner/repo'));

  const mockExec = () => 'git@github.com:test-org/test-repo.git\n';
  assert.equal(detectRepoFromGit(process.cwd(), mockExec), 'test-org/test-repo');

  const failExec = () => {
    throw new Error('git error');
  };
  assert.equal(detectRepoFromGit(process.cwd(), failExec), null);

  assert.equal(resolveRepo({ repo: 'my-owner/my-repo' }), 'my-owner/my-repo');

  // GITHUB_REPOSITORY pode estar definida no ambiente (ex: GitHub Actions);
  // remove para validar o caminho de erro quando não há repo nem git.
  const savedGithubRepository = process.env.GITHUB_REPOSITORY;
  delete process.env.GITHUB_REPOSITORY;
  try {
    assert.throws(
      () => resolveRepo({ repo: null, cwd: '/non-existent', execFileSync: failExec }),
      /--repo ou GITHUB_REPOSITORY requerido/,
    );
  } finally {
    if (savedGithubRepository !== undefined) process.env.GITHUB_REPOSITORY = savedGithubRepository;
  }
});

test('policy lib validates policies, catches schema errors and handles state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-policy-'));
  const validPolicy = {
    schemaVersion: 1,
    profile: 'strict-node',
    project: { surfaces: [{ type: 'node', root: '.', required: true }] },
    ci: {
      requiredChecks: ['Lint', 'Tests'],
      advisoryChecks: ['SonarCloud'],
      coverageRatchet: true,
      maxFileLines: 300,
    },
    bootstrap: {
      license: { enabled: true, type: 'MIT' },
      funding: { enabled: true, buyMeACoffee: 'user' },
      dependabot: { enabled: true },
      readme: { enabled: true, style: 'devandreotti' },
    },
    github: { copilotReview: true, branchProtection: true, requireConversationResolution: true },
    dockerImageDoctor: {
      enabled: 'auto',
      runWhen: 'docker-files-present',
      scriptPath: 'C:\\dummy.ps1',
      agentArgs: ['-Json'],
      interactiveAllowed: false,
      blockOn: ['Critical'],
      warnOn: ['High'],
      fallbackWhenUnavailable: 'static-advisory',
    },
    localValidation: {
      untrackedAllowlist: ['samples/**'],
      pytestBasetempPattern: '.pytest-tmp-qg',
    },
  };

  assert.deepEqual(validatePolicy(validPolicy), []);
  assert.equal(hasPolicyFiles(root), false);

  // Validação de erros
  const badPolicy = {
    schemaVersion: 2,
    profile: 123,
    project: { surfaces: 'not-an-array' },
    ci: { requiredChecks: [], coverageRatchet: 'yes', maxFileLines: -1 },
    bootstrap: {
      license: { enabled: 'yes', type: 'GPL' },
      funding: { enabled: 'yes', buyMeACoffee: 123 },
      dependabot: { enabled: 'yes' },
      readme: { enabled: 'yes', style: 'other' },
    },
    github: { copilotReview: 'yes', branchProtection: 1, requireConversationResolution: null },
    dockerImageDoctor: {
      enabled: 'invalid',
      runWhen: 'never',
      scriptPath: null,
      agentArgs: [],
      interactiveAllowed: true,
      blockOn: null,
      warnOn: null,
      fallbackWhenUnavailable: 'unknown',
    },
    localValidation: {
      untrackedAllowlist: ['', 123],
      pytestBasetempPattern: 123,
    },
  };

  const errs = validatePolicy(badPolicy);
  assert.ok(errs.length > 10);

  fs.mkdirSync(path.join(root, '.quality-gate'), { recursive: true });
  fs.writeFileSync(path.join(root, '.quality-gate/policy.json'), JSON.stringify(badPolicy));
  assert.throws(() => loadPolicy(root), /Policy invalida/);

  fs.writeFileSync(path.join(root, '.quality-gate/policy.json'), JSON.stringify(validPolicy));
  fs.writeFileSync(path.join(root, '.quality-gate/policy.schema.json'), '{}');
  assert.equal(hasPolicyFiles(root), true);
  assert.deepEqual(loadPolicy(root), validPolicy);

  const hash1 = policyHash(validPolicy);
  const state = buildState({
    root,
    policy: validPolicy,
    checks: [{ name: 'check1', level: 'ok' }],
    summary: { ok: 1, warnings: 0, failures: 0 },
  });
  const statePath = writeState(root, state);
  assert.ok(fs.existsSync(statePath));
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).policyHash, hash1);
});

test('stryker pilot config fica restrito aos dois arquivos e nunca quebra o build', async () => {
  const { pathToFileURL } = require('node:url');
  const configPath = path.join(__dirname, '..', 'stryker.pilot.config.mjs');
  const { default: config } = await import(pathToFileURL(configPath).href);

  assert.deepEqual(config.mutate, ['scripts/lib/diff-coverage.cjs', 'scripts/lib/console-ui.cjs']);
  assert.equal(config.thresholds.break, null);
  assert.equal(config.testRunner, 'command');
  assert.equal(config.coverageAnalysis, 'off');
});
