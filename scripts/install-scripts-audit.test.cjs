const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const SCRIPT = path.join(__dirname, 'install-scripts-audit.cjs');
const { auditInstallScripts, parseArgs } = require('./install-scripts-audit.cjs');

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

function git(cwd, args) {
  return childProcess.execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    env: GIT_ENV,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function commitFile(cwd, name, content, message) {
  fs.writeFileSync(path.join(cwd, name), content);
  git(cwd, ['add', name]);
  git(cwd, ['commit', '-q', '--allow-empty', '-m', message]);
}

function lockfile(packages) {
  return `${JSON.stringify(
    {
      name: 'fixture-root',
      version: '1.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: { '': { name: 'fixture-root', version: '1.0.0' }, ...packages },
    },
    null,
    2,
  )}\n`;
}

function fixturePkg(version, extra = {}) {
  return {
    version,
    resolved: `https://registry.npmjs.org/left-pad-fixture/-/left-pad-fixture-${version}.tgz`,
    ...extra,
  };
}

/**
 * Cria um repo temporário com dois commits: base (com lockfile base, ou sem
 * lockfile quando base === null) e HEAD (com lockfile head).
 */
function makeRepo(base, head) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'install-scripts-audit-'));
  git(dir, ['init', '-q']);
  if (base === null) {
    commitFile(dir, 'README.md', '# fixture\n', 'chore: base sem lockfile');
  } else {
    commitFile(dir, 'package-lock.json', base, 'chore: base lockfile');
  }
  commitFile(dir, 'package-lock.json', head, 'feat: head lockfile');
  return dir;
}

function runAudit(dir, args) {
  const result = childProcess.spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: dir,
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test('pacote novo com hasInstallScript true é reportado', () => {
  const dir = makeRepo(
    lockfile({}),
    lockfile({
      'node_modules/left-pad-fixture': fixturePkg('1.0.0', { hasInstallScript: true }),
    }),
  );
  try {
    const out = runAudit(dir, ['--base', 'HEAD~1']);
    assert.equal(out.status, 0);
    assert.match(out.stdout, /left-pad-fixture@1\.0\.0/);
    assert.match(out.stdout, /novo/);
  } finally {
    cleanup(dir);
  }
});

test('pacote novo sem hasInstallScript não é reportado', () => {
  const dir = makeRepo(
    lockfile({}),
    lockfile({
      'node_modules/left-pad-fixture': fixturePkg('1.0.0'),
    }),
  );
  try {
    const out = runAudit(dir, ['--base', 'HEAD~1', '--strict']);
    assert.equal(out.status, 0);
    assert.doesNotMatch(out.stdout, /left-pad-fixture/);
    assert.match(out.stdout, /nenhum pacote/);
  } finally {
    cleanup(dir);
  }
});

test('pacote inalterado com script de instalação não é reportado', () => {
  const pkg = { 'node_modules/left-pad-fixture': fixturePkg('1.0.0', { hasInstallScript: true }) };
  const dir = makeRepo(lockfile(pkg), lockfile(pkg));
  try {
    const out = runAudit(dir, ['--base', 'HEAD~1', '--strict']);
    assert.equal(out.status, 0);
    assert.doesNotMatch(out.stdout, /left-pad-fixture/);
  } finally {
    cleanup(dir);
  }
});

test('versão alterada com script de instalação é reportada', () => {
  const dir = makeRepo(
    lockfile({ 'node_modules/left-pad-fixture': fixturePkg('1.0.0', { hasInstallScript: true }) }),
    lockfile({ 'node_modules/left-pad-fixture': fixturePkg('1.1.0', { hasInstallScript: true }) }),
  );
  try {
    const out = runAudit(dir, ['--base', 'HEAD~1']);
    assert.equal(out.status, 0);
    assert.match(out.stdout, /left-pad-fixture@1\.1\.0/);
    assert.match(out.stdout, /1\.0\.0 -> 1\.1\.0/);
  } finally {
    cleanup(dir);
  }
});

test('base sem lockfile imprime aviso e sai com 0', () => {
  const dir = makeRepo(
    null,
    lockfile({ 'node_modules/left-pad-fixture': fixturePkg('1.0.0', { hasInstallScript: true }) }),
  );
  try {
    const out = runAudit(dir, ['--base', 'HEAD~1', '--strict']);
    assert.equal(out.status, 0);
    assert.match(out.stdout, /ausente/);
    assert.match(out.stdout, /aviso/);
  } finally {
    cleanup(dir);
  }
});

test('lockfile malformado sai com 2', () => {
  const dir = makeRepo(lockfile({}), '{ "packages": { broken');
  try {
    const out = runAudit(dir, ['--base', 'HEAD~1']);
    assert.equal(out.status, 2);
    assert.match(out.stderr, /JSON válido/);
  } finally {
    cleanup(dir);
  }
});

test('--strict sai com 1 quando a lista não está vazia', () => {
  const dir = makeRepo(
    lockfile({}),
    lockfile({ 'node_modules/left-pad-fixture': fixturePkg('1.0.0', { hasInstallScript: true }) }),
  );
  try {
    const out = runAudit(dir, ['--base', 'HEAD~1', '--strict']);
    assert.equal(out.status, 1);
    assert.match(out.stdout, /left-pad-fixture@1\.0\.0/);
  } finally {
    cleanup(dir);
  }
});

test('sem --base sai com 2 e mensagem de uso', () => {
  const dir = makeRepo(lockfile({}), lockfile({}));
  try {
    const out = runAudit(dir, []);
    assert.equal(out.status, 2);
    assert.match(out.stderr, /--base/);
  } finally {
    cleanup(dir);
  }
});

test('auditInstallScripts ignora entradas sem version alterada e a raiz', () => {
  const findings = auditInstallScripts(
    { 'node_modules/left-pad-fixture': { version: '1.0.0' } },
    {
      '': { name: 'fixture-root' },
      'node_modules/left-pad-fixture': { version: '1.0.0', hasInstallScript: true },
      'node_modules/other-fixture': { version: '2.0.0', hasInstallScript: true },
    },
    os.tmpdir(),
  );
  assert.deepEqual(
    findings.map((f) => `${f.name}@${f.version}`),
    ['other-fixture@2.0.0'],
  );
});

test('parseArgs aceita --base=<ref> e rejeita argumento desconhecido', () => {
  assert.deepEqual(parseArgs(['--base=origin/main', '--strict']), { base: 'origin/main', strict: true });
  assert.throws(() => parseArgs(['--base', 'x', '--nope']), /desconhecido/);
});
