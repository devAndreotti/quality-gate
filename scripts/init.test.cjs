const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  detectPackageManager,
  readPackageScripts,
  shellCommands,
  surfaceCommands,
} = require('./lib/package-manager.cjs');
const { nodeWorkflow } = require('./lib/workflow-templates.cjs');
const configure = require('./configure-project.cjs');
const { configureProject } = configure;
const { analyzeQualityGate, requiredFiles } = require('./doctor.cjs');
const init = require('./init.cjs');
const { parseArgs, runInit } = init;

// Silencia o console.log dos main() durante o teste.
function quiet(fn) {
  const original = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(' '));
  try {
    return { value: fn(), out: lines.join('\n') };
  } finally {
    console.log = original;
  }
}

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
  const all = parseArgs([
    '--project',
    'x',
    '--mode',
    'company',
    '--secret-ignore',
    'a/,b/',
    '--skip-baseline',
    '--force',
    '--dry-run',
    '--json',
  ]);
  assert.deepEqual(
    [all.project, all.mode, all.secretScanIgnore, all.skipBaseline, all.force, all.dryRun, all.json],
    ['x', 'company', ['a/', 'b/'], true, true, true, true],
  );
});

test('runInit recusa modo full, pasta sem git e stack sem suporte', () => {
  const root = yarnProject();
  assert.throws(() => runInit({ project: root, templateRoot: TEMPLATE_ROOT, mode: 'full' }), /qg-init/);
  const noGit = tempDir();
  write(noGit, 'package.json', '{}');
  assert.throws(() => runInit({ project: noGit, templateRoot: TEMPLATE_ROOT }), /repositório git/);
  const rust = tempDir();
  childProcess.execFileSync('git', ['init', '-q'], { cwd: rust });
  write(rust, 'Cargo.toml', '[package]\n');
  assert.throws(() => runInit({ project: rust, templateRoot: TEMPLATE_ROOT }), /rust não suportada/);
});

test('templateFiles cai para a varredura de pastas sem git, e VERSION sai sem commit', () => {
  const files = init.templateFiles(TEMPLATE_ROOT, () => {
    throw new Error('sem git');
  });
  assert.ok(files.includes('scripts/quality-gate.js'));
  assert.ok(!files.some((file) => file.endsWith('.test.cjs')));

  const template = tempDir();
  write(template, 'VERSION', '9.9.9\n');
  write(
    template,
    '.quality-gate/policy.json',
    fs.readFileSync(path.join(TEMPLATE_ROOT, '.quality-gate/policy.json')),
  );
  write(template, 'scripts/quality-gate.js', '// gate\n');
  const root = yarnProject();
  const result = runInit({ project: root, templateRoot: template, dryRun: false });
  assert.match(fs.readFileSync(path.join(root, '.quality-gate/VERSION'), 'utf8'), /^9\.9\.9\n$/);
  assert.match(result.steps.at(-1).detail, /sem coverage|gerado/);
});

test('baseline: dry-run avisa, e com coverage o init grava baseline.json', () => {
  const root = yarnProject();
  assert.equal(
    runInit({ project: root, templateRoot: TEMPLATE_ROOT, dryRun: true }).steps.at(-1).detail,
    'seria gerado',
  );
  // Template mínimo: o quality-gate.js real rodando no projeto temporário entraria no lcov
  // como arquivo do repo e derrubaria a cobertura do ratchet.
  const template = tempDir();
  write(template, 'VERSION', '1.0.0\n');
  write(
    template,
    '.quality-gate/policy.json',
    fs.readFileSync(path.join(TEMPLATE_ROOT, '.quality-gate/policy.json')),
  );
  write(template, 'scripts/quality-gate.js', "require('fs').writeFileSync('scripts/baseline.json', '{}');\n");
  const result = runInit({ project: root, templateRoot: template });
  assert.equal(result.steps.at(-1).detail, 'gerado');
  assert.ok(fs.existsSync(path.join(root, 'scripts/baseline.json')));

  const failing = tempDir();
  fs.cpSync(template, failing, { recursive: true });
  write(failing, 'scripts/quality-gate.js', 'process.exit(1);\n');
  const other = yarnProject();
  assert.match(runInit({ project: other, templateRoot: failing }).steps.at(-1).detail, /sem coverage/);
});

test('main do init e do configure-project imprimem resumo ou JSON', () => {
  const root = yarnProject();
  const text = quiet(() => init.main(['--project', root, '--skip-baseline', '--runs-on', 'self-hosted,x']));
  assert.match(text.out, /Quality Gate init \(company\)/);
  const json = quiet(() => init.main(['--project', root, '--skip-baseline', '--json']));
  assert.equal(JSON.parse(json.out).install.mode, 'company');

  const parsed = configure.parseArgs([
    '--template-root',
    TEMPLATE_ROOT,
    '--runs-on',
    'self-hosted,y',
    '--branches',
    'dev',
    '--secret-scan',
    '--secret-ignore',
    '.agents/',
  ]);
  assert.deepEqual(parsed.runsOn, ['self-hosted', 'y']);
  assert.equal(parsed.secretScan, true);
  assert.deepEqual(parsed.secretScanIgnore, ['.agents/']);
  const out = quiet(() =>
    configure.main(['--project', root, '--profile', 'node', '--skip-sonar', '--runs-on', 'z']),
  );
  assert.match(out.out, /node workflow \(yarn\)/);
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/quality-gate.yml'), 'utf8');
  assert.match(workflow, /runs-on: z$/m);
});

test('doctor trata policy ilegível como instalação completa; readPackageScripts tolera JSON inválido', () => {
  const root = tempDir();
  write(root, '.quality-gate/policy.json', '{ quebrado');
  assert.equal(analyzeQualityGate({ root }).mode, 'full');
  assert.ok(requiredFiles('company').includes('.quality-gate/VERSION'));
  assert.ok(!requiredFiles('company').includes('.github/FUNDING.yml'));
  write(root, 'package.json', '{ quebrado');
  assert.deepEqual(readPackageScripts(root), {});
});
