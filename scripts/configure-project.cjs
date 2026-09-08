#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const {
  nodeSonarProperties,
  nodeWorkflow,
  pythonCoveragePath,
  pythonSonarProperties,
  pythonWorkflow,
} = require("./lib/workflow-templates.cjs");

const REQUIRED_CHECKS = [
  'Security audit',
  'Lint',
  'Tests & ratchet',
  'SonarCloud',
  'Docker image gate',
];

function requiredChecks(options = {}) {
  return options.skipSonar
    ? REQUIRED_CHECKS.filter((check) => check !== 'SonarCloud')
    : REQUIRED_CHECKS;
}

function parseArgs(argv) {
  const args = { project: process.cwd(), profile: null, dryRun: false, skipSonar: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
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
  if (!dryRun) fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function nodeSurface(projectDir) {
  return {
    type: 'node',
    root: projectDir,
    required: true,
    commands: {
      install: 'npm ci',
      test: 'npm run test --if-present',
      lint: 'npm run lint --if-present',
      build: 'npm run build --if-present',
      audit: 'npm audit --audit-level=moderate',
    },
  };
}

function configureNode(projectRoot, profile, dryRun, options = {}) {
  const workflowPath = path.join(projectRoot, '.github', 'workflows', 'quality-gate.yml');
  const policyPath = path.join(projectRoot, '.quality-gate', 'policy.json');
  const sonarPath = path.join(projectRoot, 'sonar-project.properties');
  const policy = readJson(policyPath);
  policy.profile = 'strict-node';
  policy.project = {
    ...(policy.project || {}),
    surfaces: [nodeSurface(profile.projectDir)],
  };
  policy.ci.requiredChecks = requiredChecks(options);
  if (!dryRun) fs.writeFileSync(workflowPath, nodeWorkflow(profile.projectDir, options));
  writeJson(policyPath, policy, dryRun);
  if (fs.existsSync(sonarPath)) {
    const current = fs.readFileSync(sonarPath, 'utf8');
    if (!dryRun) fs.writeFileSync(sonarPath, nodeSonarProperties(current, profile.projectDir));
  }
  return [
    { status: dryRun ? 'planned' : 'updated', file: '.github/workflows/quality-gate.yml', detail: 'node workflow' },
    { status: dryRun ? 'planned' : 'updated', file: '.quality-gate/policy.json', detail: 'profile strict-node' },
    { status: dryRun ? 'planned' : 'updated', file: 'sonar-project.properties', detail: 'node paths' },
  ];
}

function configurePythonUv(projectRoot, profile, dryRun, options = {}) {
  const workflowPath = path.join(projectRoot, '.github', 'workflows', 'quality-gate.yml');
  const policyPath = path.join(projectRoot, '.quality-gate', 'policy.json');
  const sonarPath = path.join(projectRoot, 'sonar-project.properties');
  const policy = readJson(policyPath);
  policy.profile = 'python-uv';
  policy.ci.requiredChecks = requiredChecks(options);
  if (!dryRun) fs.writeFileSync(workflowPath, pythonWorkflow(profile.projectDir, options));
  writeJson(policyPath, policy, dryRun);
  if (fs.existsSync(sonarPath)) {
    const current = fs.readFileSync(sonarPath, 'utf8');
    if (!dryRun) fs.writeFileSync(sonarPath, pythonSonarProperties(current, profile.projectDir));
  }
  return [
    { status: dryRun ? 'planned' : 'updated', file: '.github/workflows/quality-gate.yml', detail: 'python-uv workflow' },
    { status: dryRun ? 'planned' : 'updated', file: '.quality-gate/policy.json', detail: 'profile python-uv' },
    { status: dryRun ? 'planned' : 'updated', file: 'sonar-project.properties', detail: 'python paths' },
  ];
}

function configureProject(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const detected = detectProjectProfile(projectRoot);
  const profile = options.profile ? { ...detected, name: options.profile } : detected;
  const dryRun = Boolean(options.dryRun);
  const steps = [];

  if (profile.name === 'python-uv') {
    steps.push(...configurePythonUv(projectRoot, profile, dryRun, { skipSonar: Boolean(options.skipSonar) }));
  } else if (profile.name === 'node') {
    steps.push(...configureNode(projectRoot, profile, dryRun, { skipSonar: Boolean(options.skipSonar) }));
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
  nodeSonarProperties,
  nodeWorkflow,
  parseArgs,
  pythonSonarProperties,
  pythonWorkflow,
};
