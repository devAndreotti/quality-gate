const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildSetupPlan,
  configureSonarProperties,
  detectRepoFromRemote,
  parseArgs,
  runSetup,
} = require('./setup.js');

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qg-setup-'));
}

test('parseArgs supports v1 setup flags', () => {
  const args = parseArgs([
    '--dry-run',
    '--skip-sonar',
    '--skip-bootstrap',
    '--sonar-token=abc',
    '--sonar-org=my-org',
    '--repo=owner/repo',
    '--default-branch=trunk',
  ]);

  assert.equal(args.dryRun, true);
  assert.equal(args.skipSonar, true);
  assert.equal(args.skipBootstrap, true);
  assert.equal(args.sonarToken, 'abc');
  assert.equal(args.sonarOrg, 'my-org');
  assert.equal(args.repo, 'owner/repo');
  assert.equal(args.defaultBranch, 'trunk');
});

test('detectRepoFromRemote supports https and ssh remotes', () => {
  assert.deepEqual(
    detectRepoFromRemote('https://github.com/devAndreotti/quality-gate.git'),
    { owner: 'devAndreotti', repo: 'quality-gate' },
  );
  assert.deepEqual(
    detectRepoFromRemote('git@github.com:devAndreotti/quality-gate.git'),
    { owner: 'devAndreotti', repo: 'quality-gate' },
  );
});

test('configureSonarProperties replaces placeholders idempotently', () => {
  const project = tempProject();
  const sonarPath = path.join(project, 'sonar-project.properties');
  fs.writeFileSync(sonarPath, [
    'sonar.projectKey=YOUR_ORG_YOUR_REPO',
    'sonar.organization=YOUR_ORG',
    'sonar.projectName=YOUR_REPO',
    '',
  ].join('\n'));

  const first = configureSonarProperties({
    projectRoot: project,
    owner: 'devAndreotti',
    repo: 'quality-gate',
    sonarOrg: 'devAndreotti',
    dryRun: false,
  });
  const second = configureSonarProperties({
    projectRoot: project,
    owner: 'devAndreotti',
    repo: 'quality-gate',
    sonarOrg: 'devAndreotti',
    dryRun: false,
  });

  const text = fs.readFileSync(sonarPath, 'utf8');
  assert.equal(first.status, 'updated');
  assert.equal(second.status, 'ok');
  assert.match(text, /sonar.projectKey=devAndreotti_quality-gate/);
  assert.match(text, /sonar.organization=devAndreotti/);
  assert.match(text, /sonar.projectName=quality-gate/);
});

test('buildSetupPlan dry-run is offline and does not require GITHUB_TOKEN', () => {
  const plan = buildSetupPlan({
    args: { dryRun: true, skipBootstrap: true, skipSonar: true, repo: 'owner/repo', defaultBranch: 'trunk' },
    projectRoot: tempProject(),
    env: {},
  });

  assert.equal(plan.repo.owner, 'owner');
  assert.equal(plan.defaultBranch, 'trunk');
  assert.equal(plan.requiresGitHubToken, false);
  assert.ok(plan.steps.some((step) => step.name === 'branch-protection'));
});

test('runSetup uses default branch from GitHub metadata and never shell-quotes secrets', async () => {
  const project = tempProject();
  fs.mkdirSync(path.join(project, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(project, '.github', 'workflows'), { recursive: true });
  fs.copyFileSync(path.resolve(__dirname, 'baseline.json'), path.join(project, 'scripts', 'baseline.json'));
  fs.writeFileSync(path.join(project, 'sonar-project.properties'), 'sonar.projectKey=YOUR_ORG_YOUR_REPO\nsonar.organization=YOUR_ORG\nsonar.projectName=YOUR_REPO\n');
  fs.writeFileSync(path.join(project, '.github', 'workflows', 'quality-gate.yml'), 'name: Quality Gate\n');

  const apiCalls = [];
  const ghApi = async (method, apiPath, body) => {
    apiCalls.push({ method, apiPath, body });
    if (method === 'GET' && apiPath === '/user') return { body: { login: 'me' } };
    if (method === 'GET' && apiPath === '/repos/owner/repo') return { body: { default_branch: 'trunk' } };
    if (method === 'GET' && apiPath === '/repos/owner/repo/rulesets') return { body: [] };
    if (method === 'POST' && apiPath === '/repos/owner/repo/rulesets') return { body: { id: 1 }, status: 201 };
    if (method === 'PUT' && apiPath === '/repos/owner/repo/branches/trunk/protection') return { body: {}, status: 200 };
    throw new Error(`unexpected API ${method} ${apiPath}`);
  };
  const secretCalls = [];

  const result = await runSetup({
    args: {
      repo: 'owner/repo',
      sonarOrg: 'owner',
      sonarToken: 'tok" with spaces',
      skipBootstrap: true,
      dryRun: false,
    },
    projectRoot: project,
    env: { GITHUB_TOKEN: 'token' },
    ghApi,
    setSecret: async (name, value) => secretCalls.push({ name, value }),
  });

  assert.equal(result.defaultBranch, 'trunk');
  assert.equal(secretCalls[0].value, 'tok" with spaces');
  assert.ok(apiCalls.some((call) => call.apiPath === '/repos/owner/repo/branches/trunk/protection'));
});
