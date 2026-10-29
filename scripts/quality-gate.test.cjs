const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildUpdatedBaseline,
  filterGitStatusEntries,
  isPathAllowedByPattern,
  parseArgs,
  renderWorkflowAnnotations,
  runQualityGate,
} = require('./quality-gate.js');

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qg-ratchet-'));
}

// Restaura uma variavel exatamente como estava: string, ou ausente quando previous e undefined.
function restoreEnv(name, previous) {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}

// Define vars (undefined remove a variavel), roda fn e restaura cada uma no finally.
function withEnv(vars, fn) {
  const previous = Object.keys(vars).map((name) => [name, process.env[name]]);
  for (const [name, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return fn();
  } finally {
    for (const [name, value] of previous) restoreEnv(name, value);
  }
}

function writeCoverage(project, pct = 82) {
  fs.mkdirSync(path.join(project, 'coverage'), { recursive: true });
  fs.writeFileSync(
    path.join(project, 'coverage/coverage-summary.json'),
    JSON.stringify(
      {
        total: {
          lines: { pct },
          statements: { pct },
          functions: { pct },
          branches: { pct },
        },
      },
      null,
      2,
    ),
  );
}

function writePythonCoverage(project, pct = 83.7) {
  fs.mkdirSync(path.join(project, 'coverage'), { recursive: true });
  fs.writeFileSync(
    path.join(project, 'coverage/coverage.json'),
    JSON.stringify(
      {
        meta: { format: 3, version: '7.6.0' },
        totals: {
          covered_lines: 837,
          num_statements: 1000,
          percent_covered: pct,
          num_branches: 200,
          covered_branches: 150,
        },
      },
      null,
      2,
    ),
  );
}

test('parseArgs supports command and dry-run', () => {
  const args = parseArgs(['update', '--dry-run']);
  assert.equal(args.command, 'update');
  assert.equal(args.dryRun, true);
});

test('buildUpdatedBaseline ratchets upward only', () => {
  const updated = buildUpdatedBaseline({
    current: {
      coverage: { lines: 80, statements: 90, functions: 70, branches: 60 },
      lintErrors: 1,
      oversizedFiles: 0,
    },
    existing: {
      coverage: { lines: 85, statements: 80, functions: 70, branches: 65 },
      lintErrors: 0,
      oversizedFiles: 2,
    },
    now: '2026-05-24T00:00:00.000Z',
  });

  assert.deepEqual(updated.coverage, { lines: 85, statements: 90, functions: 70, branches: 65 });
  // lintErrors and oversizedFiles only go down: 1 vs baseline 0 keeps 0, 0 vs baseline 2 becomes 0.
  assert.equal(updated.lintErrors, 0);
  assert.equal(updated.oversizedFiles, 0);
});

test('buildUpdatedBaseline does not accept lint or oversized-file regressions', () => {
  const updated = buildUpdatedBaseline({
    current: {
      coverage: { lines: 80, statements: 80, functions: 80, branches: 80 },
      lintErrors: 7,
      oversizedFiles: 4,
    },
    existing: {
      coverage: { lines: 80, statements: 80, functions: 80, branches: 80 },
      lintErrors: 0,
      oversizedFiles: 1,
    },
    now: '2026-05-24T00:00:00.000Z',
  });

  assert.equal(updated.lintErrors, 0);
  assert.equal(updated.oversizedFiles, 1);
});

test('buildUpdatedBaseline lowers lint and oversized-file counts when they improve', () => {
  const updated = buildUpdatedBaseline({
    current: { coverage: {}, lintErrors: 2, oversizedFiles: 0 },
    existing: { coverage: {}, lintErrors: 5, oversizedFiles: 3 },
    now: '2026-05-24T00:00:00.000Z',
  });

  assert.equal(updated.lintErrors, 2);
  assert.equal(updated.oversizedFiles, 0);
});

test('check without baseline.json returns failure with init hint', () => {
  const project = tempProject();
  fs.mkdirSync(path.join(project, 'scripts'), { recursive: true });
  writeCoverage(project, 90);

  const result = runQualityGate({ root: project, command: 'check' });

  assert.equal(result.status, 'failed');
  assert.match(result.failures[0].message, /quality-gate\.js init/);
});

test('update --dry-run does not write baseline', () => {
  const project = tempProject();
  fs.mkdirSync(path.join(project, 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(project, 'scripts/baseline.json'),
    JSON.stringify({ coverage: { lines: 1 } }, null, 2),
  );
  writeCoverage(project, 90);

  const result = runQualityGate({
    root: project,
    command: 'update',
    dryRun: true,
    now: '2026-05-24T00:00:00.000Z',
  });

  assert.equal(result.status, 'planned');
  assert.match(fs.readFileSync(path.join(project, 'scripts/baseline.json'), 'utf8'), /"lines": 1/);
});

test('init creates baseline when coverage exists', () => {
  const project = tempProject();
  fs.mkdirSync(path.join(project, 'scripts'), { recursive: true });
  writeCoverage(project, 77);

  const result = runQualityGate({ root: project, command: 'init', now: '2026-05-24T00:00:00.000Z' });
  const baseline = JSON.parse(fs.readFileSync(path.join(project, 'scripts/baseline.json'), 'utf8'));

  assert.equal(result.status, 'updated');
  assert.equal(baseline.coverage.lines, 77);
  assert.equal(baseline.updatedAt, '2026-05-24T00:00:00.000Z');
});

test('init creates baseline from Python coverage JSON', () => {
  const project = tempProject();
  fs.mkdirSync(path.join(project, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(project, 'pipeline/src/free_plaud'), { recursive: true });
  fs.writeFileSync(path.join(project, 'pipeline/src/free_plaud/app.py'), 'print("ok")\n');
  writePythonCoverage(project, 83.7);

  const result = runQualityGate({ root: project, command: 'init', now: '2026-05-24T00:00:00.000Z' });
  const baseline = JSON.parse(fs.readFileSync(path.join(project, 'scripts/baseline.json'), 'utf8'));

  assert.equal(result.status, 'updated');
  assert.equal(result.current.coverage.lines, 83.7);
  assert.equal(result.current.coverage.statements, null);
  assert.equal(result.current.coverage.functions, null);
  assert.equal(result.current.coverage.branches, 75);
  assert.equal(Object.hasOwn(baseline.coverage, 'statements'), false);
  assert.equal(Object.hasOwn(baseline.coverage, 'functions'), false);
  assert.equal(baseline.coverage.branches, 75);
});

test('Python coverage does not fail on legacy statements/functions baseline', () => {
  const project = tempProject();
  fs.mkdirSync(path.join(project, 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(project, 'scripts/baseline.json'),
    JSON.stringify(
      {
        coverage: {
          lines: 80,
          statements: 95,
          functions: 95,
          branches: 70,
        },
      },
      null,
      2,
    ),
  );
  writePythonCoverage(project, 83.7);

  const result = runQualityGate({ root: project, command: 'check' });
  const functionsRow = result.rows.find((row) => row.metric === 'functions');

  assert.equal(result.status, 'passed');
  assert.equal(functionsRow.current, 'n/a');
  assert.equal(functionsRow.passed, true);
});

test('file size gate uses maxFileLines from policy', () => {
  const project = tempProject();
  fs.mkdirSync(path.join(project, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(project, '.quality-gate'), { recursive: true });
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(project, 'scripts/baseline.json'),
    JSON.stringify(
      {
        coverage: { lines: 80, statements: 80, functions: 80, branches: 80 },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(project, '.quality-gate/policy.json'),
    JSON.stringify(
      {
        ci: { maxFileLines: 2 },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(path.join(project, 'src/large.js'), 'one\ntwo\nthree\n');
  writeCoverage(project, 90);

  const result = runQualityGate({ root: project, command: 'check' });

  assert.equal(result.current.oversizedFiles, 1);
});

test('untracked allowlist ignores samples without hiding tracked modifications', () => {
  assert.equal(isPathAllowedByPattern('samples/demo.json', 'samples/**'), true);
  assert.equal(isPathAllowedByPattern('src/app.js', 'samples/**'), false);

  const filtered = filterGitStatusEntries(
    ['?? samples/demo.json', ' M samples/tracked.json', '?? scratch.txt'],
    ['samples/**'],
  );

  assert.deepEqual(filtered, [' M samples/tracked.json', '?? scratch.txt']);
});

test('withEnv restores a pre-existing variable and keeps absent ones absent', () => {
  const previousActions = process.env.GITHUB_ACTIONS;
  const previousAbsent = process.env.QG_TEST_ABSENT;
  process.env.GITHUB_ACTIONS = 'sentinel';
  delete process.env.QG_TEST_ABSENT;
  try {
    withEnv({ GITHUB_ACTIONS: 'true', QG_TEST_ABSENT: 'temp' }, () => {
      assert.equal(process.env.GITHUB_ACTIONS, 'true');
      assert.equal(process.env.QG_TEST_ABSENT, 'temp');
    });
    assert.equal(process.env.GITHUB_ACTIONS, 'sentinel');
    assert.equal(Object.prototype.hasOwnProperty.call(process.env, 'QG_TEST_ABSENT'), false);
  } finally {
    restoreEnv('GITHUB_ACTIONS', previousActions);
    restoreEnv('QG_TEST_ABSENT', previousAbsent);
  }
});

test('withEnv restores the environment even when fn throws', () => {
  const previous = process.env.GITHUB_ACTIONS;
  process.env.GITHUB_ACTIONS = 'sentinel';
  try {
    assert.throws(() => withEnv({ GITHUB_ACTIONS: undefined }, () => {
      throw new Error('boom');
    }), /boom/);
    assert.equal(process.env.GITHUB_ACTIONS, 'sentinel');
  } finally {
    restoreEnv('GITHUB_ACTIONS', previous);
  }
});

test('renderWorkflowAnnotations outputs GitHub Actions ::error commands when in CI', () => {
  const logs = [];
  const originalLog = console.log;
  console.log = (msg) => logs.push(msg);
  try {
    withEnv({ GITHUB_ACTIONS: 'true' }, () => {
      renderWorkflowAnnotations([{ group: 'Coverage', metric: 'lines', baseline: 80, current: 75 }]);
    });
    assert.equal(logs.length, 1);
    assert.match(logs[0], /^::error title=Quality Gate: Coverage - lines::/);
  } finally {
    console.log = originalLog;
  }
});

test('QG-2: coverage metric null with positive baseline fails and names the metric', () => {
  const project = tempProject();
  fs.mkdirSync(path.join(project, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(project, 'coverage'), { recursive: true });
  fs.writeFileSync(
    path.join(project, 'coverage/coverage-summary.json'),
    JSON.stringify({
      total: {
        lines: { pct: 90 },
        statements: { pct: 90 },
        functions: { pct: 90 },
        branches: { pct: null },
      },
    }),
  );
  fs.writeFileSync(
    path.join(project, 'scripts/baseline.json'),
    JSON.stringify({
      coverage: { lines: 80, statements: 80, functions: 80, branches: 80 },
    }),
  );

  const result = runQualityGate({ root: project, command: 'check' });
  const failure = result.failures.find((item) => item.metric === 'branches');

  assert.equal(result.status, 'failed');
  assert.ok(failure, 'branches must fail when it was baselined and is not measured');
  assert.match(failure.message, /branches/);
  assert.match(failure.message, /não medid/);
});

test('QG-2: coverage metric null with zero or absent baseline stays not applicable', () => {
  const project = tempProject();
  fs.mkdirSync(path.join(project, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(project, 'coverage'), { recursive: true });
  fs.writeFileSync(
    path.join(project, 'coverage/coverage-summary.json'),
    JSON.stringify({
      total: {
        lines: { pct: 90 },
        statements: { pct: 90 },
        functions: { pct: 90 },
        branches: { pct: null },
      },
    }),
  );
  fs.writeFileSync(
    path.join(project, 'scripts/baseline.json'),
    JSON.stringify({
      coverage: { lines: 80, statements: 80, functions: 80, branches: 0 },
    }),
  );

  const result = runQualityGate({ root: project, command: 'check' });
  const branchesRow = result.rows.find((row) => row.metric === 'branches');

  assert.equal(result.status, 'passed');
  assert.equal(branchesRow.passed, true);
  assert.equal(branchesRow.current, 'n/a');
});

test('QG-4: lint row without baseline value appears with warn status', () => {
  const project = tempProject();
  fs.mkdirSync(path.join(project, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(project, 'coverage'), { recursive: true });
  fs.writeFileSync(path.join(project, 'coverage/eslint-report.json'), JSON.stringify([{ errorCount: 2 }]));
  fs.writeFileSync(
    path.join(project, 'scripts/baseline.json'),
    JSON.stringify({
      coverage: { lines: 80, statements: 80, functions: 80, branches: 80 },
    }),
  );
  writeCoverage(project, 90);

  const result = runQualityGate({ root: project, command: 'check' });
  const lintRow = result.rows.find((row) => row.group === 'Lint');

  assert.equal(result.status, 'passed');
  assert.ok(lintRow, 'lint row must stay visible without a baseline');
  assert.equal(lintRow.status, 'warn');
  assert.equal(lintRow.baseline, 'sem baseline');
  assert.equal(lintRow.current, '2');
});

test('QG-5: report without coverage returns a warning and does not throw', () => {
  const project = tempProject();
  fs.mkdirSync(path.join(project, 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(project, 'scripts/baseline.json'),
    JSON.stringify({
      coverage: { lines: 80, statements: 80, functions: 80, branches: 80 },
    }),
  );

  let result;
  assert.doesNotThrow(() => {
    result = runQualityGate({ root: project, command: 'report' });
  });
  assert.equal(result.status, 'warning');
  assert.match(result.warning, /coverage/);
  assert.throws(() => runQualityGate({ root: project, command: 'check' }), /coverage nao encontrado/);
});
