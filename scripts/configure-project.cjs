#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const {
  nodeSonarProperties,
  nodeWorkflow,
  pythonCoveragePath,
  pythonSonarProperties,
  pythonWorkflow,
} = require('./lib/workflow-templates.cjs');
const {
  detectPackageManager,
  readPackageScripts,
  shellCommands,
  surfaceCommands,
} = require('./lib/package-manager.cjs');

const REQUIRED_CHECKS = ['Security audit', 'Lint', 'Tests & ratchet', 'SonarCloud', 'Docker image gate'];

function requiredChecks(options = {}) {
  return options.skipSonar ? REQUIRED_CHECKS.filter((check) => check !== 'SonarCloud') : REQUIRED_CHECKS;
}

function parseArgs(argv) {
  const args = {
    project: process.cwd(),
    profile: null,
    dryRun: false,
    skipSonar: false,
    json: false,
    templateRoot: null,
    runsOn: null,
    branches: null,
    secretScan: false,
    secretScanIgnore: [],
  };
  const list = (value) =>
    String(value || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--template-root') {
      args.templateRoot = argv[++index];
      continue;
    }
    if (arg === '--runs-on') {
      args.runsOn = list(argv[++index]);
      continue;
    }
    if (arg === '--branches') {
      args.branches = list(argv[++index]);
      continue;
    }
    if (arg === '--secret-scan') {
      args.secretScan = true;
      continue;
    }
    if (arg === '--secret-ignore') {
      args.secretScan = true;
      args.secretScanIgnore.push(...list(argv[++index]));
      continue;
    }
    if (arg === '--project') args.project = argv[++index];
    else if (arg.startsWith('--project=')) args.project = arg.slice('--project='.length);
    else if (arg === '--profile') args.profile = argv[++index];
    else if (arg.startsWith('--profile=')) args.profile = arg.slice('--profile='.length);
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--skip-sonar') args.skipSonar = true;
    else if (arg === '--json') args.json = true;
  }
  return args;
}

function exists(root, relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

function detectProjectProfile(projectRoot) {
  if (exists(projectRoot, 'package.json')) {
    return { name: 'node', projectDir: '.', detail: 'package.json' };
  }
  if (exists(projectRoot, 'pyproject.toml')) {
    return { name: 'python-uv', projectDir: '.', detail: 'pyproject.toml' };
  }
  if (exists(projectRoot, 'pipeline/pyproject.toml')) {
    return { name: 'python-uv', projectDir: 'pipeline', detail: 'pipeline/pyproject.toml' };
  }
  if (exists(projectRoot, 'Cargo.toml')) {
    return { name: 'rust', projectDir: '.', detail: 'Cargo.toml' };
  }
  if (exists(projectRoot, 'go.mod')) {
    return { name: 'go', projectDir: '.', detail: 'go.mod' };
  }
  return { name: 'unknown', projectDir: '.', detail: 'stack nao detectada' };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value, dryRun) {
  if (!dryRun) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
  }
}

function nodeSurface(projectRoot, projectDir) {
  return {
    type: 'node',
    root: projectDir,
    required: true,
    commands: surfaceCommands(path.join(projectRoot, projectDir)),
  };
}

// Repo novo não tem policy.json (o init não copia a deste repo, que é do próprio gate):
// parte da policy do template, já sem os dados locais dele (buildProjectPolicy).
function readPolicy(projectRoot, options) {
  const policyPath = path.join(projectRoot, '.quality-gate', 'policy.json');
  if (fs.existsSync(policyPath)) {
    return readJson(policyPath);
  }
  if (!options.templateRoot) {
    throw new Error(`${policyPath} ausente; passe --template-root <checkout do quality-gate>`);
  }
  const { buildProjectPolicy } = require('./bootstrap-repo.cjs');
  const template = readJson(path.join(options.templateRoot, '.quality-gate', 'policy.json'));
  return buildProjectPolicy(template, projectRoot);
}

function nodeVersionFile(dir) {
  return ['.nvmrc', '.node-version'].find((file) => fs.existsSync(path.join(dir, file))) || null;
}

function nodeWorkflowOptions(projectRoot, profile, options) {
  const dir = path.join(projectRoot, profile.projectDir);
  const packageManager = detectPackageManager(dir);
  return {
    ...options,
    packageManager,
    commands: shellCommands(packageManager, readPackageScripts(dir)),
    nodeVersionFile: nodeVersionFile(dir),
  };
}

function configureNode(projectRoot, profile, dryRun, options = {}) {
  const workflowPath = path.join(projectRoot, '.github', 'workflows', 'quality-gate.yml');
  const policyPath = path.join(projectRoot, '.quality-gate', 'policy.json');
  const sonarPath = path.join(projectRoot, 'sonar-project.properties');
  const policy = readPolicy(projectRoot, options);
  const workflowOptions = nodeWorkflowOptions(projectRoot, profile, options);
  policy.profile = 'strict-node';
  policy.project = {
    ...(policy.project || {}),
    surfaces: [nodeSurface(projectRoot, profile.projectDir)],
  };
  policy.ci.requiredChecks = requiredChecks(options);
  if (options.installMode) {
    policy.install = { mode: options.installMode };
  }
  if (!dryRun) {
    fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
    fs.writeFileSync(workflowPath, nodeWorkflow(profile.projectDir, workflowOptions));
  }
  writeJson(policyPath, policy, dryRun);
  if (fs.existsSync(sonarPath)) {
    const current = fs.readFileSync(sonarPath, 'utf8');
    if (!dryRun) fs.writeFileSync(sonarPath, nodeSonarProperties(current, profile.projectDir));
  }
  return [
    {
      status: dryRun ? 'planned' : 'updated',
      file: '.github/workflows/quality-gate.yml',
      detail: `node workflow (${workflowOptions.packageManager})`,
    },
    {
      status: dryRun ? 'planned' : 'updated',
      file: '.quality-gate/policy.json',
      detail: 'profile strict-node',
    },
    ...(fs.existsSync(sonarPath)
      ? [{ status: dryRun ? 'planned' : 'updated', file: 'sonar-project.properties', detail: 'node paths' }]
      : []),
  ];
}

function configurePythonUv(projectRoot, profile, dryRun, options = {}) {
  const workflowPath = path.join(projectRoot, '.github', 'workflows', 'quality-gate.yml');
  const policyPath = path.join(projectRoot, '.quality-gate', 'policy.json');
  const sonarPath = path.join(projectRoot, 'sonar-project.properties');
  const policy = readPolicy(projectRoot, options);
  policy.profile = 'python-uv';
  policy.ci.requiredChecks = requiredChecks(options);
  if (!dryRun) {
    fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
    fs.writeFileSync(workflowPath, pythonWorkflow(profile.projectDir, options));
  }
  writeJson(policyPath, policy, dryRun);
  if (fs.existsSync(sonarPath)) {
    const current = fs.readFileSync(sonarPath, 'utf8');
    if (!dryRun) fs.writeFileSync(sonarPath, pythonSonarProperties(current, profile.projectDir));
  }
  return [
    {
      status: dryRun ? 'planned' : 'updated',
      file: '.github/workflows/quality-gate.yml',
      detail: 'python-uv workflow',
    },
    {
      status: dryRun ? 'planned' : 'updated',
      file: '.quality-gate/policy.json',
      detail: 'profile python-uv',
    },
    ...(fs.existsSync(sonarPath)
      ? [{ status: dryRun ? 'planned' : 'updated', file: 'sonar-project.properties', detail: 'python paths' }]
      : []),
  ];
}

function configureProject(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const detected = detectProjectProfile(projectRoot);
  const profile = options.profile ? { ...detected, name: options.profile } : detected;
  const dryRun = Boolean(options.dryRun);
  const steps = [];
  const templateOptions = {
    skipSonar: Boolean(options.skipSonar),
    templateRoot: options.templateRoot || null,
    runsOn: options.runsOn || null,
    branches: options.branches || null,
    secretScan: Boolean(options.secretScan),
    secretScanIgnore: options.secretScanIgnore || [],
    installMode: options.installMode || null,
  };

  if (profile.name === 'python-uv') {
    steps.push(...configurePythonUv(projectRoot, profile, dryRun, templateOptions));
  } else if (profile.name === 'node') {
    steps.push(...configureNode(projectRoot, profile, dryRun, templateOptions));
  } else {
    steps.push({ status: 'ok', file: null, detail: `profile ${profile.name}; packaged defaults kept` });
  }

  return { schemaVersion: 1, projectRoot, profile, dryRun, steps };
}

function printResult(result) {
  console.log('\n🔧 Quality Gate — Project profile');
  console.log('══════════════════════════════════\n');
  console.log(`Profile: ${result.profile.name} (${result.profile.detail})`);
  for (const step of result.steps) {
    const icon = step.status === 'skipped' ? '⚠️ ' : '✅';
    const file = step.file ? ` (${step.file})` : '';
    console.log(` ${icon} ${step.status}: ${step.detail}${file}`);
  }
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const result = configureProject({
    projectRoot: args.project,
    profile: args.profile,
    dryRun: args.dryRun,
    skipSonar: args.skipSonar,
    templateRoot: args.templateRoot,
    runsOn: args.runsOn,
    branches: args.branches,
    secretScan: args.secretScan,
    secretScanIgnore: args.secretScanIgnore,
  });
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else printResult(result);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`❌ configure-project: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  configureProject,
  detectProjectProfile,
  main,
  nodeSonarProperties,
  nodeWorkflow,
  parseArgs,
  pythonSonarProperties,
  pythonWorkflow,
};
