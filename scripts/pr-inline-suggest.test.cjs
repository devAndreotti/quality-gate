const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const {
  buildBody,
  buildReviewItems,
  filterExisting,
  main,
  markerFor,
  parseFindings,
} = require('./pr-inline-suggest.cjs');

const SCRIPT = path.join(__dirname, 'pr-inline-suggest.cjs');

const DIFF = [
  'diff --git a/src/a.js b/src/a.js',
  '--- a/src/a.js',
  '+++ b/src/a.js',
  '@@ -3,0 +4,2 @@',
  '+const x = 1;',
  '+var y = 2;',
  '',
].join('\n');

function finding(overrides = {}) {
  return { file: 'src/a.js', line: 4, message: 'use const', rule: 'lint/prefer-const', ...overrides };
}

function captureIo() {
  const io = { out: '', err: '' };
  io.deps = {
    out: (text) => {
      io.out += text;
    },
    err: (text) => {
      io.err += text;
    },
  };
  return io;
}

function fakeGh(existingText = '') {
  const calls = [];
  const gh = (args, input) => {
    calls.push({ args, input });
    if (args.includes('--paginate')) return existingText;
    return '{"id":1}';
  };
  return { gh, calls };
}

function writeFindings(dir, content) {
  const file = path.join(dir, 'findings.json');
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(cwd, args) {
  return childProcess
    .execFileSync(
      'git',
      [
        '-c',
        'user.name=qg-test',
        '-c',
        'user.email=qg-test@example.invalid',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
    .trim();
}

test('finding on an added line becomes a review comment on RIGHT side', () => {
  const { items, summary } = buildReviewItems({ findings: [finding()], diffText: DIFF });
  assert.equal(summary.length, 0);
  assert.equal(items.length, 1);
  assert.deepEqual(
    { path: items[0].comment.path, line: items[0].comment.line, side: items[0].comment.side },
    { path: 'src/a.js', line: 4, side: 'RIGHT' },
  );
  assert.match(items[0].comment.body, /\*\*lint\/prefer-const\*\*: use const/);
});

test('finding on an unchanged line goes to the summary, not to comments', () => {
  const { items, summary } = buildReviewItems({ findings: [finding({ line: 1 })], diffText: DIFF });
  assert.equal(items.length, 0);
  assert.equal(summary.length, 1);
  assert.equal(summary[0].line, 1);
});

test('finding on a file that is not in the diff goes to the summary', () => {
  const { items, summary } = buildReviewItems({ findings: [finding({ file: 'other.js' })], diffText: DIFF });
  assert.equal(items.length, 0);
  assert.equal(summary.length, 1);
});

test('suggestion block appears only with fix and replaces exactly one line', () => {
  const withFix = buildReviewItems({ findings: [finding({ fix: 'const y = 2;' })], diffText: DIFF });
  const body = withFix.items[0].comment.body;
  const match = body.match(/```suggestion\n([\s\S]*?)\n```/);
  assert.ok(match, 'suggestion block expected');
  assert.equal(match[1], 'const y = 2;');
  assert.equal(match[1].split('\n').length, 1);

  const withoutFix = buildReviewItems({ findings: [finding()], diffText: DIFF });
  assert.equal(withoutFix.items[0].comment.body.includes('```suggestion'), false);
});

test('fix spanning several lines or containing a code fence is rejected as bad input', () => {
  const dir = tmp('qg-inline-fix-');
  for (const fix of ['a\nb', 'a\r\nb', 'x ``` y']) {
    const file = writeFindings(dir, [finding({ fix })]);
    assert.throws(() => parseFindings(fs.readFileSync(file, 'utf8')), /entrada inválida|fix/);
  }
});

test('marker is embedded in body and dedupes against existing review comments', () => {
  const f = finding();
  const marker = markerFor(f);
  assert.equal(marker, '<!-- qg-inline:lint/prefer-const:src/a.js:4 -->');
  assert.ok(buildBody(f, marker).startsWith(marker));

  const { items } = buildReviewItems({ findings: [f], diffText: DIFF });
  const existing = `previous review\n${marker}\n**lint/prefer-const**: use const`;
  const { fresh, skipped } = filterExisting(items, existing);
  assert.equal(fresh.length, 0);
  assert.deepEqual(skipped, [marker]);
});

test('duplicate findings with the same marker are emitted once', () => {
  const { items } = buildReviewItems({ findings: [finding(), finding()], diffText: DIFF });
  assert.equal(items.length, 1);
});

test('dry-run prints comments and never calls a POST', () => {
  const dir = tmp('qg-inline-dry-');
  const file = writeFindings(dir, [finding({ fix: 'const x = 1;' }), finding({ line: 1 })]);
  const io = captureIo();
  const { gh, calls } = fakeGh();
  const code = main(
    ['--findings', file, '--base', 'base', '--head', 'head', '--repo', 'owner/repo', '--pr', '7'],
    {
      ...io.deps,
      gh,
      readFile: (f) => fs.readFileSync(f, 'utf8'),
      execFileSync: () => DIFF,
    },
  );
  assert.equal(code, 0);
  assert.equal(
    calls.some((c) => c.args.includes('POST') || c.args.includes('--method')),
    false,
  );
  const report = JSON.parse(io.out);
  assert.equal(report.mode, 'dry-run');
  assert.equal(report.posted, false);
  assert.equal(report.comments.length, 1);
  assert.equal(report.summary.length, 1);
});

test('post mode creates one review with COMMENT event only', () => {
  const dir = tmp('qg-inline-post-');
  const file = writeFindings(dir, [finding()]);
  const io = captureIo();
  const { gh, calls } = fakeGh();
  const code = main(
    ['--findings', file, '--repo', 'owner/repo', '--pr', '7', '--post', '--base', 'b', '--head', 'h'],
    {
      ...io.deps,
      gh,
      readFile: (f) => fs.readFileSync(f, 'utf8'),
      execFileSync: () => DIFF,
    },
  );
  assert.equal(code, 0);
  const posts = calls.filter((c) => c.args.includes('--method'));
  assert.equal(posts.length, 1);
  assert.ok(posts[0].args.includes('repos/owner/repo/pulls/7/reviews'));
  const payload = JSON.parse(posts[0].input);
  assert.equal(payload.event, 'COMMENT');
  assert.equal(payload.comments.length, 1);
  assert.equal(payload.comments[0].side, 'RIGHT');
  assert.equal(JSON.stringify(payload).includes('APPROVE'), false);
  assert.equal(JSON.stringify(payload).includes('REQUEST_CHANGES'), false);
});

test('post mode with only already-posted findings does not create a review', () => {
  const dir = tmp('qg-inline-noop-');
  const file = writeFindings(dir, [finding()]);
  const io = captureIo();
  const { gh, calls } = fakeGh(markerFor(finding()));
  const code = main(
    ['--findings', file, '--repo', 'owner/repo', '--pr', '7', '--post', '--base', 'b', '--head', 'h'],
    {
      ...io.deps,
      gh,
      readFile: (f) => fs.readFileSync(f, 'utf8'),
      execFileSync: () => DIFF,
    },
  );
  assert.equal(code, 0);
  assert.equal(
    calls.some((c) => c.args.includes('--method')),
    false,
  );
});

test('malformed findings file exits 2', () => {
  const bad = [
    '{not json',
    '{"file":"a.js"}',
    JSON.stringify([{ file: 'a.js', line: 0, message: 'x', rule: 'r' }]),
    JSON.stringify([{ file: '../escape.js', line: 1, message: 'x', rule: 'r' }]),
    JSON.stringify([{ file: 'a.js', line: 1, message: 'x' }]),
    JSON.stringify([{ file: 'a.js', line: 1, message: 'x', rule: 'r', fix: 5 }]),
  ];
  for (const content of bad) {
    const dir = tmp('qg-inline-bad-');
    const file = writeFindings(dir, content);
    const io = captureIo();
    const code = main(['--findings', file, '--base', 'b', '--head', 'h'], {
      ...io.deps,
      execFileSync: () => DIFF,
    });
    assert.equal(code, 2, `expected exit 2 for ${content}`);
    assert.match(io.err, /entrada inválida/);
  }
});

test('missing findings, conflicting flags and --post without --pr exit 2', () => {
  const io = captureIo();
  assert.equal(main([], io.deps), 2);
  assert.equal(main(['--findings', 'x.json', '--post', '--dry-run'], io.deps), 2);
  assert.equal(main(['--findings', 'x.json', '--post'], io.deps), 2);
});

test('CLI exits 2 on malformed findings through a real process', () => {
  const dir = tmp('qg-inline-cli-');
  const file = writeFindings(dir, '[{"file": ');
  const result = childProcess.spawnSync(process.execPath, [SCRIPT, '--findings', file], {
    encoding: 'utf8',
    cwd: dir,
  });
  assert.equal(result.status, 2);
});

test('real git repo: added line becomes comment, unchanged line goes to summary', () => {
  const dir = tmp('qg-inline-git-');
  git(dir, ['init', '-q']);
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'let keep = 0;\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'base']);
  const base = git(dir, ['rev-parse', 'HEAD']);

  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'let keep = 0;\nlet added = 1;\n');
  git(dir, ['commit', '-q', '-am', 'change']);

  const file = writeFindings(dir, [
    { file: 'src/a.js', line: 2, message: 'use const', rule: 'lint/prefer-const', fix: 'const added = 1;' },
    { file: 'src/a.js', line: 1, message: 'unused var', rule: 'lint/no-unused' },
  ]);
  const result = childProcess.spawnSync(
    process.execPath,
    [SCRIPT, '--findings', file, '--base', base, '--head', 'HEAD'],
    {
      encoding: 'utf8',
      cwd: dir,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.comments.length, 1);
  assert.equal(report.comments[0].line, 2);
  assert.match(report.comments[0].body, /```suggestion\nconst added = 1;\n```/);
  assert.equal(report.summary.length, 1);
  assert.equal(report.summary[0].line, 1);
});

test('"\\ No newline" markers do not shift added line numbers', () => {
  const diff = [
    'diff --git a/n.txt b/n.txt',
    '--- a/n.txt',
    '+++ b/n.txt',
    '@@ -2 +2 @@',
    '-old',
    '\\ No newline at end of file',
    '+new',
    '\\ No newline at end of file',
    '',
  ].join('\n');
  const { items } = buildReviewItems({
    findings: [{ file: 'n.txt', line: 2, message: 'm', rule: 'r' }],
    diffText: diff,
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].comment.line, 2);
});

const scratchDirs = [];
after(() => {
  for (const dir of scratchDirs) fs.rmSync(dir, { recursive: true, force: true });
});

test('git failure outside InputError exits 1 with a runtime message and no report', () => {
  const dir = tmp('qg-inline-rt-');
  scratchDirs.push(dir);
  git(dir, ['init', '-q']);
  const file = writeFindings(dir, [{ file: 'src/a.js', line: 1, message: 'm', rule: 'r' }]);
  const io = captureIo();
  // Base inexistente: git diff falha de verdade, sem mock.
  const code = main(['--findings', file, '--base', 'refs/qg-missing-base', '--head', 'HEAD'], {
    ...io.deps,
    cwd: dir,
  });
  assert.equal(code, 1);
  assert.match(io.err, /não foi possível calcular o diff refs\/qg-missing-base\.\.\.HEAD/);
  assert.doesNotMatch(io.err, /entrada inválida/);
  assert.equal(io.out, '');
});
