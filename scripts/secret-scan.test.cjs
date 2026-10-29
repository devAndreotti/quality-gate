const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  HISTORY_MAX_FINDINGS,
  isPlaceholder,
  parseArgs,
  runSecretScan,
  scanDirectory,
  scanFile,
  scanGitDiff,
  scanText,
  shouldIgnore,
} = require('./secret-scan.cjs');

// Tokens falsos são montados em runtime para que este arquivo não contenha
// literais que o próprio scanner acusaria (sem exceção por *.test.* ou fixtures).
const GH = 'ghp_';
const PEM = '-----BEGIN ';
const AWS = 'AKIA';
// Corpo sintético de 24 caracteres alfanuméricos, sem palavras de placeholder.
const BODY24 = 'Qz7m'.repeat(6);
const OPENAI_LIKE = 'sk-' + BODY24;

test('isPlaceholder ignores dummy and sample tokens', () => {
  assert.equal(isPlaceholder('sk-EXAMPLE12345678901234567890'), true);
  assert.equal(isPlaceholder('ghp_YOUR_TOKEN_HERE12345678901234567890'), true);
  assert.equal(isPlaceholder(GH + '1'.repeat(36)), false);
});

test('scanText detects openai, github, aws, and private keys', () => {
  const dummyGh = GH + 'realtoken1234567890123456789012345678';
  const dummyAws = AWS + 'IOSFODNN7EXAMPLE';
  const sampleText = [
    `const key = "${dummyGh}";`,
    `const fake = "${GH}DUMMY1234567890123456789012345678";`,
    `const note = "${dummyGh}"; // nosecret`,
    PEM + 'RSA PRIVATE KEY-----',
    `const aws = "${dummyAws}";`,
  ].join('\n');

  const findings = scanText(sampleText);
  assert.equal(findings.length, 2); // dummyGh e RSA key (fake e nosecret ignorados, aws contem EXAMPLE)
  assert.equal(findings[0].id, 'github_pat');
  assert.equal(findings[1].id, 'private_key');
});

test('scanFile and scanDirectory return clean status on safe repos', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-sec-'));
  fs.writeFileSync(path.join(dir, 'index.js'), 'console.log("clean");\n');
  const res = runSecretScan({ root: dir, mode: 'all' });
  assert.equal(res.status, 'passed');
  assert.equal(res.findingsCount, 0);

  fs.writeFileSync(path.join(dir, 'leaked.js'), `const token = "${GH}abcde1234567890123456789012345678901";`);
  const resFail = runSecretScan({ root: dir, mode: 'all' });
  assert.equal(resFail.status, 'failed');
  assert.equal(resFail.findingsCount, 1);
});

test('shouldIgnore only skips paths matching explicit custom patterns', () => {
  assert.equal(shouldIgnore('scripts/secret-scan.test.cjs'), false);
  assert.equal(shouldIgnore('src/app.spec.ts'), false);
  assert.equal(shouldIgnore('fixtures/prod.env'), false);
  assert.equal(shouldIgnore('src/index.js'), false);
  assert.equal(shouldIgnore('custom/path.txt', ['custom']), true);
});

test('runSecretScan does not exempt test files or fixture dirs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-sec-strict-'));
  fs.mkdirSync(path.join(dir, 'fixtures'));
  fs.writeFileSync(
    path.join(dir, 'payment.test.js'),
    `const token = "${GH}111111111111111111111111111111111111";`,
  );
  fs.writeFileSync(path.join(dir, 'fixtures', 'prod.env'), `AWS_KEY=${AWS}REALKEYREALKEY12\n`);
  const res = runSecretScan({ root: dir, mode: 'all' });
  assert.equal(res.status, 'failed');
  assert.equal(res.findingsCount, 2);
});

test('runSecretScan honors only explicit --ignore patterns', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-sec-ignore-'));
  fs.writeFileSync(
    path.join(dir, 'app.test.js'),
    `const token = "${GH}111111111111111111111111111111111111";`,
  );
  fs.writeFileSync(
    path.join(dir, 'sample.txt'),
    `const token = "${GH}222222222222222222222222222222222222";`,
  );
  const res = runSecretScan({ root: dir, mode: 'all', ignore: ['sample.txt'] });
  assert.equal(res.status, 'failed');
  assert.equal(res.findingsCount, 1);
  assert.equal(res.findings[0].file, path.join(dir, 'app.test.js'));

  const parsed = parseArgs(['--ignore', '*.fixture.js', '--ignore=custom/**']);
  assert.deepEqual(parsed.ignore, ['*.fixture.js', 'custom/**']);
});

// SS-1: dotfiles precisam ser escaneados; só .git é ignorado.
test('SS-1 scans dotfiles such as .env and files in dot-directories, skipping only .git', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-sec-dot-'));
  fs.writeFileSync(path.join(dir, '.env'), `OPENAI_API_KEY=${OPENAI_LIKE}\n`);
  fs.mkdirSync(path.join(dir, '.aws'));
  fs.writeFileSync(path.join(dir, '.aws', 'credentials'), `aws_api_key=${OPENAI_LIKE}\n`);
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, '.git', 'config'), `key = ${OPENAI_LIKE}\n`);

  const res = runSecretScan({ root: dir, mode: 'all' });
  assert.equal(res.status, 'failed');
  const files = res.findings.map((f) => path.relative(dir, f.file).split(path.sep).join('/')).sort();
  assert.deepEqual(files, ['.aws/credentials', '.env']);
});

// SS-2: diff mode precisa cobrir arquivos staged, untracked e repo sem commit.
const GIT_OPTS = { stdio: ['ignore', 'pipe', 'pipe'] };
function makeRepoWithoutCommit() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-sec-diff-'));
  childProcess.execFileSync('git', ['init', '-q'], { cwd: dir, ...GIT_OPTS });
  return dir;
}

// Sem teto, git sobe a arvore e acha um .git que contenha o tmp. O teto e o pai de dir.
function withGitCeiling(dir, fn) {
  const previous = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = [previous, path.dirname(dir)].filter(Boolean).join(path.delimiter);
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = previous;
  }
}

test('SS-2 diff mode reports staged and untracked files in a repo without commits', () => {
  const dir = makeRepoWithoutCommit();
  fs.writeFileSync(path.join(dir, 'staged.txt'), `token=${OPENAI_LIKE}\n`);
  childProcess.execFileSync('git', ['add', 'staged.txt'], { cwd: dir, ...GIT_OPTS });
  fs.writeFileSync(path.join(dir, 'untracked.txt'), `token=${OPENAI_LIKE}\n`);

  const res = runSecretScan({ root: dir, mode: 'diff' });
  assert.equal(res.status, 'failed');
  const files = res.findings.map((f) => path.basename(f.file)).sort();
  assert.deepEqual(files, ['staged.txt', 'untracked.txt']);
});

test('SS-2 a failing git command is reported as error, never as passed', () => {
  const dir = makeRepoWithoutCommit();
  const failingGit = () => {
    throw new Error('git exploded');
  };
  assert.throws(() => scanGitDiff(dir, failingGit), /git exploded/);

  const res = runSecretScan({ root: dir, mode: 'diff', execFileSync: failingGit });
  assert.equal(res.status, 'error');
  assert.match(res.error, /git exploded/);
});

test('SS-2 diff mode outside a git repository is an error, not a pass', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-sec-nogit-'));
  const res = withGitCeiling(dir, () => runSecretScan({ root: dir, mode: 'diff' }));
  assert.notEqual(res.status, 'passed');
  assert.equal(res.status, 'error');
});

test('SS-2 not-a-repo stays an error when the temp dir is nested under a directory with .git', () => {
  const parent = makeRepoWithoutCommit();
  const nested = fs.mkdtempSync(path.join(parent, 'qg-sec-nested-'));
  const res = withGitCeiling(nested, () => runSecretScan({ root: nested, mode: 'diff' }));
  assert.equal(res.status, 'error');
});

// SS-3: padrões adicionais. Valores sintéticos montados em runtime.
test('SS-3 detects Stripe, Google, Slack, npm, GitLab and PGP key material', () => {
  const samples = {
    stripe_key: ['sk_' + 'live_' + BODY24, 'sk_' + 'test_' + BODY24],
    google_api_key: ['AI' + 'za' + 'Qz7m'.repeat(9).slice(0, 35)],
    slack_token: ['xo' + 'xb-' + '1234567890-Qz7mQz7m'],
    npm_token: ['np' + 'm_' + 'Qz7m'.repeat(9)],
    gitlab_pat: ['gl' + 'pat-' + 'Qz7m'.repeat(5)],
    pgp_private_key: ['-----BEGIN ' + 'PGP PRIVATE KEY BLOCK-----'],
  };
  for (const [id, values] of Object.entries(samples)) {
    for (const value of values) {
      const ids = scanText(`const v = "${value}";`).map((f) => f.id);
      assert.ok(ids.includes(id), `${id} should match ${value.slice(0, 12)}...`);
    }
  }
});

test('SS-3 stripe key with fewer than 24 body characters is not reported', () => {
  const short = 'sk_' + 'live_' + 'Qz7m'.repeat(5) + 'Qz7';
  assert.equal(scanText(short).filter((f) => f.id === 'stripe_key').length, 0);
});

test('SS-3 db_uri_password matches postgresql, mongodb+srv and generic URI credentials', () => {
  const uris = [
    'postgresql://' + 'app:Qz7mPass@db.corp.net/main',
    'mongodb+srv://' + 'svc:Qz7mPass@cluster.corp.net/x',
    'ftp://' + 'admin:Qz7mPass@files.corp.net',
  ];
  for (const uri of uris) {
    const ids = scanText(`url = "${uri}"`).map((f) => f.id);
    assert.ok(ids.includes('db_uri_password'), `should match ${uri.split('@')[0]}`);
  }
});

// SS-4: arquivos acima de 2 MB não podem sumir em silêncio.
test('SS-4 files larger than 2MB are reported as skipped and never as passed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-sec-big-'));
  const big = `${OPENAI_LIKE}\n` + 'a'.repeat(2 * 1024 * 1024 + 16);
  fs.writeFileSync(path.join(dir, 'huge.txt'), big);
  fs.writeFileSync(path.join(dir, 'small.js'), 'console.log("clean");\n');

  const res = runSecretScan({ root: dir, mode: 'all' });
  assert.equal(res.findingsCount, 0);
  assert.equal(res.skippedCount, 1);
  assert.equal(res.skipped.length, 1);
  assert.equal(path.basename(res.skipped[0].file), 'huge.txt');
  assert.match(res.skipped[0].reason, /2MB/);
  assert.equal(res.status, 'passed-with-skips');
});

test('SS-4 a clean scan without skipped files keeps status passed and skippedCount 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-sec-noskip-'));
  fs.writeFileSync(path.join(dir, 'index.js'), 'console.log("clean");\n');
  const res = runSecretScan({ root: dir, mode: 'all' });
  assert.equal(res.status, 'passed');
  assert.equal(res.skippedCount, 0);
  assert.deepEqual(res.skipped, []);
});

// SS-5: supressão só com marcador de comentário no fim da linha.
test('SS-5 nosecret inside a string literal does not suppress a real key', () => {
  const dummyGh = GH + 'realtoken1234567890123456789012345678';
  const findings = scanText(`const t = "${dummyGh} // nosecret";`);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, 'github_pat');
});

test('SS-5 a key on a line ending with a nosecret or NOSONAR comment is suppressed', () => {
  const dummyGh = GH + 'realtoken1234567890123456789012345678';
  assert.equal(scanText(`const t = "${dummyGh}"; // nosecret`).length, 0);
  assert.equal(scanText(`const t = "${dummyGh}"; # NOSONAR   `).length, 0);
  assert.equal(scanText(`const t = "${dummyGh}"; /* nosecret */`).length, 0);
});

// SS-7: o preview não pode expor caracteres do valor.
test('SS-7 finding preview never contains leading characters of the matched value', () => {
  const dummyGh = GH + 'realtoken1234567890123456789012345678';
  const [finding] = scanText(`const t = "${dummyGh}";`);
  assert.ok(finding);
  assert.equal(finding.preview.includes(dummyGh.slice(0, 8)), false);
  assert.equal(finding.preview.includes(dummyGh.slice(-4)), false);
  assert.equal(finding.preview.includes('realtoken'), false);
});

// SS-8: parser de diff.
function fakeGit(diff) {
  return (cmd, args) => (args[0] === 'diff' ? diff : '');
}

test('SS-8 an added line whose content starts with ++ is still scanned', () => {
  const diff = [
    'diff --git a/notes.txt b/notes.txt',
    'index 1111111..2222222 100644',
    '--- a/notes.txt',
    '+++ b/notes.txt',
    '@@ -1 +1,2 @@',
    ' context',
    `+++x ${OPENAI_LIKE}`,
    '',
  ].join('\n');
  const findings = scanGitDiff(process.cwd(), fakeGit(diff));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, 'notes.txt');
  assert.equal(findings[0].line, 2);
});

test('SS-8 quoted git headers resolve to the unescaped filename, including after index lines', () => {
  const diff = [
    'diff --git a/plain.txt b/plain.txt',
    'new file mode 100644',
    'index 0000000..3333333',
    '--- /dev/null',
    '+++ b/plain.txt',
    '@@ -0,0 +1 @@',
    `+token=${OPENAI_LIKE}`,
    'diff --git "a/dir with space/caf\\303\\251 \\"q\\".txt" "b/dir with space/caf\\303\\251 \\"q\\".txt"',
    'index 4444444..5555555 100644',
    '--- "a/dir with space/caf\\303\\251 \\"q\\".txt"',
    '+++ "b/dir with space/caf\\303\\251 \\"q\\".txt"',
    '@@ -1 +1 @@',
    `+token=${OPENAI_LIKE}`,
    '',
  ].join('\n');
  const findings = scanGitDiff(process.cwd(), fakeGit(diff));
  assert.deepEqual(
    findings.map((f) => f.file),
    ['plain.txt', 'dir with space/café "q".txt'],
  );
  assert.deepEqual(
    findings.map((f) => f.line),
    [1, 1],
  );
});

// --history: linhas adicionadas de todo o historico (git log -p --all).
// Repo temporario com commits sinteticos; a arvore de trabalho fica limpa.
function gitIn(dir, args) {
  return childProcess.execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
function commitAll(dir, message) {
  gitIn(dir, ['add', '-A']);
  gitIn(dir, [
    '-c',
    'user.name=qg-test',
    '-c',
    'user.email=qg-test@example.invalid',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    message,
  ]);
}
const TOKEN_ONES = GH + '1'.repeat(36);

test('--history reports a token removed in a later commit, with a clean working tree', () => {
  const dir = makeRepoWithoutCommit();
  fs.writeFileSync(path.join(dir, 'config.js'), `module.exports = { token: "${TOKEN_ONES}" };\n`);
  commitAll(dir, 'add config');
  fs.writeFileSync(path.join(dir, 'config.js'), 'module.exports = {};\n');
  commitAll(dir, 'remove token');
  assert.equal(gitIn(dir, ['status', '--porcelain']).trim(), '');

  assert.equal(runSecretScan({ root: dir, mode: 'all' }).findingsCount, 0);

  const res = runSecretScan({ root: dir, mode: 'history' });
  assert.equal(res.status, 'failed');
  assert.equal(res.findingsCount, 1);
  const [finding] = res.findings;
  assert.equal(finding.id, 'github_pat');
  assert.equal(finding.file, 'config.js');
  assert.equal(finding.commit, gitIn(dir, ['rev-parse', 'HEAD~1']).trim());
  assert.equal(finding.preview, '[valor oculto]');
});

test('--history reports nothing for a clean repo', () => {
  const dir = makeRepoWithoutCommit();
  fs.writeFileSync(path.join(dir, 'index.js'), 'console.log("clean");\n');
  commitAll(dir, 'clean');
  const res = runSecretScan({ root: dir, mode: 'history' });
  assert.equal(res.status, 'passed');
  assert.equal(res.findingsCount, 0);
});

test('--history skips binary blobs', () => {
  const dir = makeRepoWithoutCommit();
  fs.writeFileSync(
    path.join(dir, 'blob.bin'),
    Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(TOKEN_ONES)]),
  );
  commitAll(dir, 'binary');
  const res = runSecretScan({ root: dir, mode: 'history' });
  assert.equal(res.findingsCount, 0);
  assert.equal(res.status, 'passed');
});

test('--history caps the findings list but keeps the total count', () => {
  const dir = makeRepoWithoutCommit();
  const lines = Array.from({ length: HISTORY_MAX_FINDINGS + 10 }, () => `token = "${TOKEN_ONES}"`);
  fs.writeFileSync(path.join(dir, 'many.txt'), lines.join('\n') + '\n');
  commitAll(dir, 'many');
  const res = runSecretScan({ root: dir, mode: 'history' });
  assert.equal(res.findingsCount, HISTORY_MAX_FINDINGS + 10);
  assert.equal(res.findings.length, HISTORY_MAX_FINDINGS);
  assert.equal(res.findingsTruncated, true);
});

test('--history outside a git repository is an error, not a pass', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-sec-hist-nogit-'));
  const res = withGitCeiling(dir, () => runSecretScan({ root: dir, mode: 'history' }));
  assert.equal(res.status, 'error');
});

test('parseArgs maps --history to history mode', () => {
  assert.equal(parseArgs(['--history']).mode, 'history');
  assert.equal(parseArgs(['--all']).mode, 'all');
});

test('--history catches a token that exists only in a merge resolution', () => {
  const dir = makeRepoWithoutCommit();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'base\n');
  commitAll(dir, 'base');
  gitIn(dir, ['checkout', '-q', '-b', 'side']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'side\n');
  commitAll(dir, 'side');
  gitIn(dir, ['checkout', '-q', '-']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'main\n');
  commitAll(dir, 'main');
  assert.throws(() => gitIn(dir, ['merge', '-q', 'side']));
  fs.writeFileSync(path.join(dir, 'a.txt'), `token = "${TOKEN_ONES}"\n`);
  commitAll(dir, 'merge with secret in resolution');
  const mergeSha = gitIn(dir, ['rev-parse', 'HEAD']).trim();

  const res = runSecretScan({ root: dir, mode: 'history' });
  assert.equal(res.status, 'failed');
  assert.ok(res.findings.some((f) => f.commit === mergeSha && f.file === 'a.txt'));
});

function historyFindingOf(dir) {
  const res = runSecretScan({ root: dir, mode: 'history', historyAllowPath: path.join(dir, 'allow.json') });
  assert.equal(res.findings.length, 1);
  return res.findings[0];
}
function allowFile(dir, entries) {
  fs.writeFileSync(path.join(dir, 'allow.json'), JSON.stringify(entries));
}

test('--history allowlist covers only the exact commit, file, line and rule', () => {
  const dir = makeRepoWithoutCommit();
  fs.writeFileSync(path.join(dir, 'fx.js'), `const a = 1;\nconst t = "${TOKEN_ONES}";\n`);
  commitAll(dir, 'fixture');
  const f = historyFindingOf(dir);
  const base = { commit: f.commit, file: f.file, line: f.line, id: f.id, motivo: 'teste' };

  allowFile(dir, [base]);
  const ok = runSecretScan({ root: dir, mode: 'history', historyAllowPath: path.join(dir, 'allow.json') });
  assert.equal(ok.status, 'passed');
  assert.equal(ok.allowedCount, 1);
  assert.deepEqual(ok.unusedAllowed, []);

  for (const wrong of [
    { line: f.line + 1 },
    { id: 'openai_key' },
    { file: 'other.js' },
    { commit: '0'.repeat(40) },
  ]) {
    allowFile(dir, [{ ...base, ...wrong }]);
    const r = runSecretScan({ root: dir, mode: 'history', historyAllowPath: path.join(dir, 'allow.json') });
    assert.equal(r.status, 'failed', JSON.stringify(wrong));
    assert.equal(r.allowedCount, 0);
    assert.equal(r.unusedAllowed.length, 1);
  }
});

test('--history rejects a malformed allowlist instead of ignoring it', () => {
  const dir = makeRepoWithoutCommit();
  fs.writeFileSync(path.join(dir, 'fx.js'), `const t = "${TOKEN_ONES}";\n`);
  commitAll(dir, 'fixture');
  fs.writeFileSync(path.join(dir, 'allow.json'), '{ nao json');
  const r = runSecretScan({ root: dir, mode: 'history', historyAllowPath: path.join(dir, 'allow.json') });
  assert.equal(r.status, 'error');
  assert.match(r.error, /allowlist do historico invalida/);
});

test('--history fails closed on a shallow clone instead of scanning only the tip', () => {
  const origin = makeRepoWithoutCommit();
  fs.writeFileSync(path.join(origin, 'a.js'), `const t = "${TOKEN_ONES}";\n`);
  commitAll(origin, 'leak');
  fs.writeFileSync(path.join(origin, 'a.js'), 'const t = 1;\n');
  commitAll(origin, 'clean tip');
  const shallow = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-sec-shallow-'));
  fs.rmSync(shallow, { recursive: true, force: true });
  childProcess.execFileSync('git', ['clone', '-q', '--depth', '1', `file://${origin}`, shallow], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const res = withGitCeiling(shallow, () => runSecretScan({ root: shallow, mode: 'history' }));
  assert.equal(res.status, 'error');
  assert.match(res.error, /historico raso/);
});

test('--history rejects an allowlist entry missing a required field', () => {
  const dir = makeRepoWithoutCommit();
  fs.writeFileSync(path.join(dir, 'fx.js'), `const t = "${TOKEN_ONES}";\n`);
  commitAll(dir, 'fixture');
  allowFile(dir, [{ commit: 'a'.repeat(40), file: 'x.js', id: 'github_pat' }]);
  const r = runSecretScan({ root: dir, mode: 'history', historyAllowPath: path.join(dir, 'allow.json') });
  assert.equal(r.status, 'error');
  assert.match(r.error, /entrada invalida na allowlist/);
});

test('--history CLI text output shows allowed count, stale entries and the commit of each finding', () => {
  const dir = makeRepoWithoutCommit();
  fs.writeFileSync(path.join(dir, 'fx.js'), `const t = "${TOKEN_ONES}";\n`);
  commitAll(dir, 'fixture');
  const f = historyFindingOf(dir);
  // Caminho padrão que o CLI lê (sem historyAllowPath).
  fs.mkdirSync(path.join(dir, '.quality-gate'));
  fs.writeFileSync(
    path.join(dir, '.quality-gate', 'secret-history-allow.json'),
    JSON.stringify([
      { commit: f.commit, file: f.file, line: f.line, id: f.id, motivo: 'teste' },
      { commit: 'b'.repeat(40), file: 'gone.js', line: 9, id: 'github_pat', motivo: 'obsoleta' },
    ]),
  );
  const script = path.join(__dirname, 'secret-scan.cjs');
  const out = childProcess.execFileSync('node', [script, '--history', '--root', dir], { encoding: 'utf8' });
  assert.match(out, /Secret Scan \(history\): PASSED/);
  assert.match(out, /1 achado\(s\) do historico cobertos pela allowlist/);
  assert.match(
    out,
    /entrada da allowlist sem achado correspondente \(remover\): bbbbbbbbbbbb gone\.js:9 github_pat/,
  );
});

test('--history CLI text output caps the printed findings and says how many were omitted', () => {
  const dir = makeRepoWithoutCommit();
  const lines = Array.from({ length: 105 }, () => `token = "${TOKEN_ONES}"`);
  fs.writeFileSync(path.join(dir, 'many.txt'), lines.join('\n') + '\n');
  commitAll(dir, 'many');
  const script = path.join(__dirname, 'secret-scan.cjs');
  const r = childProcess.spawnSync('node', [script, '--history', '--root', dir], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.equal(r.stdout.split('\n').filter((l) => l.includes('❌')).length, 100);
  assert.match(r.stdout, /\.\.\. mais 5 achado\(s\) omitido\(s\)/);
});
