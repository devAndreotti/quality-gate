const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildBody,
  readCoverageSection,
} = require('./pr-comment.js');

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qg-pr-comment-'));
}

function writeBaseline(project) {
  fs.mkdirSync(path.join(project, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(project, 'scripts/baseline.json'), JSON.stringify({
    coverage: {
      lines: 80,
      statements: 80,
      functions: 80,
      branches: 70,
    },
  }, null, 2));
}

test('buildBody uses REQUIRED_CHECKS so skipped Sonar does not block all-green state', () => {
  const project = tempProject();
  writeBaseline(project);

  const body = buildBody({
    root: project,
    now: new Date('2026-05-24T12:30:00.000Z'),
    env: {
      GITHUB_REPOSITORY: 'owner/repo',
      RUN_ID: '123',
      SECURITY_RESULT: 'success',
      LINT_RESULT: 'success',
      TEST_RESULT: 'success',
      DOCKER_RESULT: 'success',
      REQUIRED_CHECKS: 'Security audit,Lint,Tests & ratchet,Docker image gate',
    },
  });

  assert.match(body, /## ✅ Quality Gate/);
  assert.match(body, /Todos os checks passaram/);
  assert.doesNotMatch(body, /SonarCloud/);
  assert.match(body, /https:\/\/github\.com\/owner\/repo\/actions\/runs\/123/);
});

test('buildBody supports generated Python and UI validation jobs', () => {
  const project = tempProject();
  writeBaseline(project);

  const body = buildBody({
    root: project,
    now: new Date('2026-05-24T12:30:00.000Z'),
    env: {
      GITHUB_REPOSITORY: 'owner/repo',
      RUN_ID: '456',
      SECURITY_RESULT: 'success',
      PYTHON_RESULT: 'success',
      UI_RESULT: 'success',
      DOCKER_RESULT: 'success',
      REQUIRED_CHECKS: 'Python validation,UI validation,Security audit,Docker image gate',
    },
  });

  assert.match(body, /## ✅ Quality Gate/);
  assert.match(body, /Python validation/);
  assert.match(body, /UI validation/);
  assert.doesNotMatch(body, /Lint/);
});

test('readCoverageSection supports coverage.py JSON reports', () => {
  const project = tempProject();
  writeBaseline(project);
  fs.mkdirSync(path.join(project, 'coverage'), { recursive: true });
  fs.writeFileSync(path.join(project, 'coverage/coverage.json'), JSON.stringify({
    meta: { format: 3 },
    files: {
      'src/free_plaud/good.py': { summary: { percent_covered: 92.25 } },
      'src/free_plaud/low.py': { summary: { percent_covered: 41.5 } },
    },
    totals: {
      percent_covered: 88.5,
      num_branches: 40,
      covered_branches: 34,
    },
  }, null, 2));

  const section = readCoverageSection({ root: project });

  assert.match(section, /`lines` \| 80\.0% \| 88\.5%/);
  assert.match(section, /`branches` \| 70\.0% \| 85\.0%/);
  assert.match(section, /src\/free_plaud\/low\.py/);
});
