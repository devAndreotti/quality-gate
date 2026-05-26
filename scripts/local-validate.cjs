#!/usr/bin/env node
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function parseArgs(argv) {
  const args = {
    project: process.cwd(),
    profile: 'pr',
    dryRun: false,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project') args.project = argv[++index];
    else if (arg.startsWith('--project=')) args.project = arg.slice('--project='.length);
    else if (arg === '--profile') args.profile = argv[++index];
    else if (arg.startsWith('--profile=')) args.profile = arg.slice('--profile='.length);
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--json') args.json = true;
  }
  return args;
}

function timestampSlug(iso) {
  return String(iso).replace(/[-:.TZ]/g, '');
}

function exists(filePath) {
  return fs.existsSync(filePath);
}

function detectNodeSurfaces(projectRoot) {
  const surfaces = [];
  const rootPackage = path.join(projectRoot, 'package.json');
  if (exists(rootPackage)) surfaces.push({ type: 'node', root: projectRoot });
  for (const entry of fs.readdirSync(projectRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const packagePath = path.join(projectRoot, entry.name, 'package.json');
    if (exists(packagePath)) surfaces.push({ type: 'node', root: path.join(projectRoot, entry.name) });
  }
  return surfaces;
}

function command(name, cwd, commandLine, extra = {}) {
  return {
    name,
    cwd,
    commandLine,
    required: extra.required !== false,
    artifact: extra.artifact || null,
    ...extra,
  };
}

function buildValidationPlan(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const profile = options.profile || 'pr';
  const startedAt = options.now || new Date().toISOString();
  const pid = options.pid || process.pid;
  const reportsRoot = path.join(projectRoot, '.quality-gate', 'reports', 'local');
  const commands = [];
  const basetemp = `.pytest-tmp-qg-${timestampSlug(startedAt)}-${pid}`;
  const pipelineRoot = path.join(projectRoot, 'pipeline');

  if (exists(path.join(pipelineRoot, 'pyproject.toml'))) {
    commands.push(
      command('ruff', pipelineRoot, 'uvx ruff check src tests --output-format=json > ..\\coverage\\ruff.json', {
        artifact: path.join(reportsRoot, 'ruff.log'),
        surface: 'python-uv',
      }),
      command(
        'pytest',
        pipelineRoot,
        `uv run pytest --basetemp ${basetemp} -q --cov=src --cov-report=json:../coverage/coverage.json --cov-report=xml:../coverage/coverage.xml --cov-report=term-missing`,
        {
          artifact: path.join(reportsRoot, 'pytest.log'),
          surface: 'python-uv',
          coverageJson: path.join(projectRoot, 'coverage', 'coverage.json'),
          basetemp,
        },
      ),
      command('pip-audit', pipelineRoot, 'uvx pip-audit --path .venv', {
        artifact: path.join(reportsRoot, 'pip-audit.log'),
        surface: 'python-uv',
      }),
    );
  }

  for (const surface of detectNodeSurfaces(projectRoot)) {
    commands.push(
      command('node:install', surface.root, 'npm ci', {
        artifact: path.join(reportsRoot, `${path.basename(surface.root)}-npm-ci.log`),
        surface: 'node',
      }),
      command('node:test', surface.root, 'npm run test --if-present', {
        artifact: path.join(reportsRoot, `${path.basename(surface.root)}-npm-test.log`),
        surface: 'node',
      }),
      command('node:lint', surface.root, 'npm run lint --if-present', {
        artifact: path.join(reportsRoot, `${path.basename(surface.root)}-npm-lint.log`),
        surface: 'node',
      }),
      command('node:build', surface.root, 'npm run build --if-present', {
        artifact: path.join(reportsRoot, `${path.basename(surface.root)}-npm-build.log`),
        surface: 'node',
      }),
      command('node:audit', surface.root, 'npm audit --audit-level=moderate', {
        artifact: path.join(reportsRoot, `${path.basename(surface.root)}-npm-audit.log`),
        surface: 'node',
      }),
    );
  }

  commands.push(
    command('qg-chk', projectRoot, 'qg-chk', {
      artifact: path.join(reportsRoot, 'qg-chk.log'),
      requiresFreshCoverage: exists(path.join(pipelineRoot, 'pyproject.toml')),
    }),
    command('qg-doc', projectRoot, 'qg-doc', {
      artifact: path.join(reportsRoot, 'qg-doc.log'),
    }),
    command('git-diff-check', projectRoot, 'git diff --check', {
      artifact: path.join(reportsRoot, 'git-diff-check.log'),
    }),
    command('git-status', projectRoot, 'git status --short --branch', {
      artifact: path.join(reportsRoot, 'git-status.log'),
    }),
  );

  return {
    profile,
    project: projectRoot,
    startedAt,
    reportsRoot,
    commands,
  };
}

function defaultExecutor(step) {
  const result = childProcess.spawnSync(step.commandLine, {
    cwd: step.cwd,
    shell: true,
    encoding: 'utf8',
    maxBuffer: 30 * 1024 * 1024,
  });
  return {
    exitCode: result.status ?? (result.error ? 1 : 0),
    stdout: result.stdout || '',
    stderr: result.stderr || result.error?.message || '',
  };
}

function writeLog(step, result) {
  if (!step.artifact) return;
  fs.mkdirSync(path.dirname(step.artifact), { recursive: true });
  fs.writeFileSync(step.artifact, `${result.stdout || ''}${result.stderr || ''}`);
}

function isCoverageFresh(coveragePath, startedAt) {
  if (!exists(coveragePath)) return false;
  const stat = fs.statSync(coveragePath);
  return stat.mtimeMs >= Date.parse(startedAt);
}

function runLocalValidation(options = {}) {
  const plan = buildValidationPlan(options);
  const executor = options.executor || defaultExecutor;
  const result = {
    profile: plan.profile,
    project: plan.project,
    startedAt: plan.startedAt,
    finishedAt: null,
    status: options.dryRun ? 'planned' : 'success',
    commands: plan.commands.map((step) => ({
      name: step.name,
      cwd: step.cwd,
      commandLine: step.commandLine,
      artifact: step.artifact,
      exitCode: null,
      durationMs: null,
    })),
  };

  if (options.dryRun) {
    result.finishedAt = options.now || new Date().toISOString();
    return result;
  }

  let pytestSucceeded = !plan.commands.some((step) => step.name === 'pytest');
  let validationError = null;

  for (let index = 0; index < plan.commands.length; index += 1) {
    const step = plan.commands[index];
    const output = result.commands[index];
    if (step.requiresFreshCoverage && !pytestSucceeded) {
      output.skipped = true;
      output.skipReason = 'pytest_failed_or_missing';
      continue;
    }
    if (step.requiresFreshCoverage) {
      const pytestStep = plan.commands.find((candidate) => candidate.name === 'pytest');
      if (pytestStep && !isCoverageFresh(pytestStep.coverageJson, plan.startedAt)) {
        output.skipped = true;
        output.skipReason = 'coverage_stale';
        validationError = `coverage stale: ${pytestStep.coverageJson}`;
        result.status = 'failure';
        continue;
      }
    }

    const started = Date.now();
    const commandResult = executor(step);
    output.durationMs = Date.now() - started;
    output.exitCode = commandResult.exitCode;
    writeLog(step, commandResult);

    if (step.name === 'pytest') pytestSucceeded = commandResult.exitCode === 0;
    if (commandResult.exitCode !== 0 && step.required) result.status = 'failure';
  }

  if (validationError) result.error = validationError;
  result.finishedAt = new Date().toISOString();
  const reportPath = path.join(plan.project, '.quality-gate', 'reports', 'local-validation.json');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(result, null, 2)}\n`);
  result.reportPath = reportPath;
  return result;
}

function printHuman(result) {
  console.log('\nQuality Gate Local Validate');
  console.log('===========================\n');
  console.log(`Project: ${result.project}`);
  console.log(`Status: ${result.status}`);
  for (const step of result.commands) {
    const marker = step.skipped ? 'SKIP' : step.exitCode == null ? 'PLAN' : step.exitCode === 0 ? 'OK' : 'FAIL';
    console.log(`${marker} ${step.name}: ${step.commandLine}`);
  }
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const result = runLocalValidation({
    projectRoot: args.project,
    profile: args.profile,
    dryRun: args.dryRun,
  });
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else printHuman(result);
  process.exitCode = result.status === 'failure' ? 1 : 0;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`local-validate: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  buildValidationPlan,
  isCoverageFresh,
  parseArgs,
  runLocalValidation,
};
