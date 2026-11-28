const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { detectPackageManager, shellCommands, surfaceCommands } = require('./lib/package-manager.cjs');
const { nodeWorkflow } = require('./lib/workflow-templates.cjs');
const { configureProject } = require('./configure-project.cjs');
const { analyzeQualityGate } = require('./doctor.cjs');
const { parseArgs, runInit } = require('./init.cjs');

const TEMPLATE_ROOT = path.resolve(__dirname, '..');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qg-init-'));
}

function write(root, file, content) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
}

// Projeto Yarn 4 como o csms-core: yarn.lock, .yarnrc.yml, .nvmrc e repo git.
function yarnProject() {
  const root = tempDir();
  childProcess.execFileSync('git', ['init', '-q'], { cwd: root });
  write(root, 'package.json', JSON.stringify({ scripts: { test: 'jest', lint: 'eslint .', build: 'tsc' } }));
  write(root, 'yarn.lock', '');
  write(root, '.yarnrc.yml', 'nodeLinker: node-modules\n');
  write(root, '.nvmrc', '24\n');
  write(root, 'CHANGELOG.md', '# do projeto\n');
  return root;
}

test('detectPackageManager distingue npm, pnpm, yarn 1 e yarn berry', () => {
  const root = tempDir();
  assert.equal(detectPackageManager(root), 'npm');
  write(root, 'yarn.lock', '');
  assert.equal(detectPackageManager(root), 'yarn1');
  write(root, '.yarnrc.yml', '');
  assert.equal(detectPackageManager(root), 'yarn');
  write(root, 'pnpm-lock.yaml', '');
  assert.equal(detectPackageManager(root), 'pnpm');
});

test('shellCommands do yarn omite script ausente (yarn não tem --if-present)', () => {
  const cmd = shellCommands('yarn', { test: 'jest' });
  assert.equal(cmd.install, 'yarn install --immutable');
  assert.equal(cmd.test, 'yarn run test');
  assert.equal(cmd.lint, null);
  assert.equal(cmd.auditLevel('critical'), 'yarn npm audit --all --recursive --severity critical');
  assert.equal(shellCommands('npm').lint, 'npm run lint --if-present');
});

test('surfaceCommands não grava comando nulo na policy', () => {
  const root = tempDir();
  write(root, 'yarn.lock', '');
  write(root, 'package.json', JSON.stringify({ scripts: { test: 'jest' } }));
  assert.deepEqual(Object.keys(surfaceCommands(root)), ['install', 'test', 'audit']);
});

test('nodeWorkflow com yarn em runner self-hosted', () => {
  const workflow = nodeWorkflow('.', {
    skipSonar: true,
    packageManager: 'yarn',
    commands: shellCommands('yarn', { test: 'jest', lint: 'eslint .', build: 'tsc' }),
    runsOn: ['self-hosted', 'csms-core'],
    branches: ['dev', 'main'],
    nodeVersionFile: '.nvmrc',
    secretScan: true,
    secretScanIgnore: ['.agents/'],
  });
  assert.match(workflow, /runs-on: \[self-hosted, csms-core\]/);
  assert.match(workflow, /head\.repo\.full_name == github\.repository/);
  assert.match(workflow, /branches: \[dev, main\]/);
  assert.match(workflow, /node-version-file: \.nvmrc/);
  assert.match(workflow, /run: corepack enable/);
  assert.match(workflow, /run: yarn install --immutable/);
  assert.match(workflow, /node scripts\/secret-scan\.cjs --all --ignore \.agents\//);
  assert.doesNotMatch(workflow, /npm ci|cache: npm|^\s+pull_request_target:|SonarCloud/m);
  for (const line of workflow.split('\n').filter((l) => l.includes('uses:'))) {
    assert.match(line, /@[0-9a-f]{40} #/, `action sem SHA: ${line}`);
  }
});

test('nodeWorkflow padrão continua npm em ubuntu-latest, sem guarda de fork', () => {
  const workflow = nodeWorkflow('.', {});
  assert.match(workflow, /runs-on: ubuntu-latest/);
  assert.match(workflow, /run: npm ci/);
  assert.match(workflow, /node-version: 24/);
  assert.doesNotMatch(workflow, /head\.repo\.full_name/);
});

test('configureProject em repo sem policy usa a do template (antes dava ENOENT)', () => {
  const root = yarnProject();
  assert.throws(() => configureProject({ projectRoot: root, profile: 'node' }), /--template-root/);
  configureProject({ projectRoot: root, profile: 'node', skipSonar: true, templateRoot: TEMPLATE_ROOT });
  const policy = JSON.parse(fs.readFileSync(path.join(root, '.quality-gate/policy.json'), 'utf8'));
  assert.equal(policy.project.surfaces[0].commands.install, 'yarn install --immutable');
  assert.equal(policy.dockerImageDoctor.enabled, 'never');
});

test('runInit instala no modo company e o doctor não acusa arquivo faltando', () => {
  const root = yarnProject();
  const result = runInit({
    project: root,
    templateRoot: TEMPLATE_ROOT,
    runsOn: ['self-hosted', 'csms-core'],
    branches: ['dev', 'main'],
    secretScanIgnore: ['.agents/'],
    skipBaseline: true,
  });
  assert.equal(result.profile, 'node');
  assert.ok(fs.existsSync(path.join(root, 'scripts/quality-gate.js')));
  assert.ok(fs.existsSync(path.join(root, 'scripts/qg.cjs')));
  assert.ok(fs.existsSync(path.join(root, '.quality-gate/VERSION')));
  for (const absent of [
    'scripts/QualityGate.ps1',
    'scripts/init.test.cjs',
    '.github/FUNDING.yml',
    '.github/workflows/ai-review.yml',
    'sonar-project.properties',
    '.codex',
    'VERSION',
  ]) {
    assert.ok(!fs.existsSync(path.join(root, absent)), `não devia instalar ${absent}`);
  }
  assert.equal(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), '# do projeto\n');
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/quality-gate.yml'), 'utf8');
  assert.match(workflow, /yarn install --immutable/);
  const policy = JSON.parse(fs.readFileSync(path.join(root, '.quality-gate/policy.json'), 'utf8'));
  assert.equal(policy.install.mode, 'company');
  assert.equal(policy.bootstrap.funding.enabled, false);
  assert.ok(!policy.ci.requiredChecks.includes('SonarCloud'));
  assert.match(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), /\.quality-gate\/reports\//);

  write(root, 'scripts/baseline.json', JSON.stringify({ coverage: { lines: 50 } }));
  const doctor = analyzeQualityGate({ root });
  assert.equal(doctor.mode, 'company');
  const files = doctor.checks.find((check) => check.name === 'Arquivos obrigatorios');
  assert.equal(files.level, 'ok', files.detail);
});

test('runInit de novo reaproveita as opções gravadas na policy', () => {
  const root = yarnProject();
  runInit({
    project: root,
    templateRoot: TEMPLATE_ROOT,
    runsOn: ['self-hosted', 'x'],
    branches: ['dev'],
    skipBaseline: true,
  });
  const again = runInit({ project: root, templateRoot: TEMPLATE_ROOT, skipBaseline: true });
  assert.deepEqual(again.install.runsOn, ['self-hosted', 'x']);
  assert.deepEqual(again.install.branches, ['dev']);
  assert.match(again.steps[0].detail, /^0 de /);
});

test('runInit não sobrescreve arquivo do projeto com o mesmo nome sem --force', () => {
  const root = yarnProject();
  write(root, 'scripts/setup.js', '// script do projeto\n');
  assert.throws(
    () => runInit({ project: root, templateRoot: TEMPLATE_ROOT, skipBaseline: true }),
    /scripts\/setup\.js/,
  );
  assert.equal(fs.readFileSync(path.join(root, 'scripts/setup.js'), 'utf8'), '// script do projeto\n');
  runInit({ project: root, templateRoot: TEMPLATE_ROOT, skipBaseline: true, force: true });
  assert.notEqual(fs.readFileSync(path.join(root, 'scripts/setup.js'), 'utf8'), '// script do projeto\n');
});

test('runInit recusa o próprio checkout e dry-run não grava nada', () => {
  assert.throws(() => runInit({ project: TEMPLATE_ROOT, templateRoot: TEMPLATE_ROOT }), /próprio checkout/);
  const root = yarnProject();
  runInit({ project: root, templateRoot: TEMPLATE_ROOT, dryRun: true });
  assert.ok(!fs.existsSync(path.join(root, 'scripts')));
  assert.ok(!fs.existsSync(path.join(root, '.quality-gate')));
});

test('parseArgs aceita listas separadas por vírgula e recusa argumento desconhecido', () => {
  const args = parseArgs(['--runs-on', 'self-hosted, csms-core', '--branches', 'dev,main']);
  assert.deepEqual(args.runsOn, ['self-hosted', 'csms-core']);
  assert.deepEqual(args.branches, ['dev', 'main']);
  assert.throws(() => parseArgs(['--sonar']), /desconhecido/);
});
