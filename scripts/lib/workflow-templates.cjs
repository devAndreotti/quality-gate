// Workflow & Sonar templates for project auto-configuration

const REQUIRED_CHECKS = ['Security audit', 'Lint', 'Tests & ratchet', 'SonarCloud', 'Docker image gate'];

function requiredChecks(options = {}) {
  return options.skipSonar ? REQUIRED_CHECKS.filter((check) => check !== 'SonarCloud') : REQUIRED_CHECKS;
}

function pythonCoveragePath(projectDir, fileName) {
  return projectDir === '.' ? `coverage/${fileName}` : `../coverage/${fileName}`;
}

function pythonWorkflow(projectDir, options = {}) {
  const workingDirectory = projectDir === '.' ? '.' : projectDir;
  const coverageJson = pythonCoveragePath(projectDir, 'coverage.json');
  const coverageXml = pythonCoveragePath(projectDir, 'coverage.xml');
  const ruffJson = pythonCoveragePath(projectDir, 'ruff.json');
  const coverageDir = projectDir === '.' ? 'coverage' : '../coverage';
  const includeSonar = !options.skipSonar;
  const sonarJob = includeSonar
    ? `

  sonar:
    name: SonarCloud
    runs-on: ubuntu-latest
    needs: test
    if: github.event_name == 'pull_request' || github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
      - uses: actions/download-artifact@v8
        with:
          name: coverage-report
          path: coverage/
      - name: SonarCloud scan
        uses: SonarSource/sonarqube-scan-action@v5
        env:
          SONAR_TOKEN: \${{ secrets.SONAR_TOKEN }}
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
      - name: SonarCloud quality gate check
        uses: sonarsource/sonarqube-quality-gate-action@v1.2.0
        timeout-minutes: 5
        env:
          SONAR_TOKEN: \${{ secrets.SONAR_TOKEN }}
`
    : '';
  const reportNeeds = includeSonar
    ? '[security, lint, test, sonar, docker]'
    : '[security, lint, test, docker]';
  const sonarResultEnv = includeSonar ? '          SONAR_RESULT: ${{ needs.sonar.result }}\n' : '';

  return `# quality-gate:managed-workflow version 1
name: Quality Gate

on:
  pull_request:
    types: [opened, synchronize, reopened]
  push:
    branches: [main]

concurrency:
  group: quality-gate-\${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  security:
    name: Security audit
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: ${workingDirectory}
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - uses: astral-sh/setup-uv@v5
      - run: uv sync --dev
      - name: Dependency audit
        run: uvx pip-audit --path .venv

  lint:
    name: Lint
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: ${workingDirectory}
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - uses: astral-sh/setup-uv@v5
      - run: uv sync --dev
      - name: Ruff
        run: |
          mkdir -p ${coverageDir}
          uvx ruff check src tests --output-format=json > ${ruffJson}
      - name: Upload Ruff report
        uses: actions/upload-artifact@v7
        if: always()
        with:
          name: ruff-report
          path: coverage/ruff.json
          retention-days: 7

  test:
    name: Tests & ratchet
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: ${workingDirectory}
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - uses: astral-sh/setup-uv@v5
      - uses: actions/setup-node@v6
        with:
          node-version: 20
      - run: uv sync --dev
      - name: Pytest coverage
        run: |
          mkdir -p ${coverageDir}
          uv run pytest --basetemp .pytest-tmp-qg --cov=src --cov-report=json:${coverageJson} --cov-report=xml:${coverageXml} --cov-report=term-missing
      - name: Ratchet
        working-directory: .
        run: node scripts/quality-gate.js check
      - name: Upload coverage
        uses: actions/upload-artifact@v7
        if: always()
        with:
          name: coverage-report
          path: coverage/
          retention-days: 7

${sonarJob}
  docker:
    name: Docker image gate
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: 20
      - name: Docker Image Doctor gate
        run: node scripts/docker-gate.cjs --project . --json
      - name: Upload Docker gate report
        uses: actions/upload-artifact@v7
        if: always()
        with:
          name: docker-gate-report
          path: .quality-gate/reports/docker-image-doctor.json
          if-no-files-found: ignore
          retention-days: 7

  report:
    name: PR report
    runs-on: ubuntu-latest
    needs: ${reportNeeds}
    if: always() && github.event_name == 'pull_request'
    permissions:
      contents: read
      issues: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: 20
      - uses: actions/download-artifact@v8
        with:
          name: coverage-report
          path: coverage/
        continue-on-error: true
      - name: Generate PR snapshot
        run: node scripts/pr-snapshot.cjs --pr "$PR_NUMBER" --json --output .quality-gate/reports/pr-snapshot.json
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          GITHUB_REPOSITORY: \${{ github.repository }}
          PR_NUMBER: \${{ github.event.pull_request.number }}
        continue-on-error: true
      - name: Postar sticky comment no PR
        run: node scripts/pr-comment.js
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          PR_NUMBER: \${{ github.event.pull_request.number }}
          RUN_ID: \${{ github.run_id }}
          SECURITY_RESULT: \${{ needs.security.result }}
          LINT_RESULT: \${{ needs.lint.result }}
          TEST_RESULT: \${{ needs.test.result }}
${sonarResultEnv}          REQUIRED_CHECKS: '${requiredChecks(options).join(',')}'
          SNAPSHOT_PATH: .quality-gate/reports/pr-snapshot.json
          DOCKER_RESULT: \${{ needs.docker.result }}
`;
}

// Actions fixadas por SHA (as mesmas dos workflows deste repo). Tag móvel deixa quem
// controla a action trocar o código que roda no CI.
const ACTIONS = {
  checkout: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
  setupNode: 'actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0',
  uploadArtifact: 'actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7',
  downloadArtifact: 'actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8',
  sonarScan: 'SonarSource/sonarqube-scan-action@e805d875275f728fac1885b413934be6d7c63f65 # v8',
  sonarGate: 'sonarsource/sonarqube-quality-gate-action@3cfda8eca512232cb42bd40fd01567cba471db39 # master',
};

const LOCKFILES = { npm: 'package-lock.json', pnpm: 'pnpm-lock.yaml', yarn: 'yarn.lock', yarn1: 'yarn.lock' };

// Runner self-hosted: PR de fork nunca roda nele (o código do fork executaria na máquina).
const FORK_GUARD =
  "github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository";

function runsOnLine(labels) {
  if (!labels || labels.length === 0) {
    return 'ubuntu-latest';
  }
  return labels.length === 1 ? labels[0] : `[${labels.join(', ')}]`;
}

function isSelfHosted(labels) {
  return Boolean(labels && labels.includes('self-hosted'));
}

function rootPath(workingDirectory, file) {
  return workingDirectory === '.' ? file : `${workingDirectory}/${file}`;
}

// Passos comuns: checkout, Node (versão do .nvmrc quando existe), corepack e install.
function nodeSetupSteps(workingDirectory, options, extra = {}) {
  const pm = options.packageManager || 'npm';
  const lines = [
    `      - uses: ${ACTIONS.checkout}`,
    '        with:',
    '          persist-credentials: false',
  ];
  if (extra.fetchDepth) {
    lines.push('          fetch-depth: 0');
  }
  lines.push(`      - uses: ${ACTIONS.setupNode}`, '        with:');
  if (options.nodeVersionFile) {
    lines.push(`          node-version-file: ${rootPath(workingDirectory, options.nodeVersionFile)}`);
  } else {
    lines.push(`          node-version: ${options.nodeVersion || 24}`);
  }
  if (pm === 'npm' && extra.install !== false) {
    lines.push(
      '          cache: npm',
      `          cache-dependency-path: ${rootPath(workingDirectory, LOCKFILES.npm)}`,
    );
  } else if (pm !== 'npm') {
    // O cache automático do setup-node chama yarn/pnpm antes de o corepack existir.
    lines.push('          package-manager-cache: false');
  }
  if (extra.install === false) {
    return lines;
  }
  if (pm !== 'npm') {
    lines.push('      - run: corepack enable');
  }
  lines.push(`      - run: ${options.commands.install}`);
  return lines;
}

function jobHeader(id, name, options, extra = {}) {
  const lines = [`  ${id}:`, `    name: ${name}`, `    runs-on: ${runsOnLine(options.runsOn)}`];
  if (extra.needs) {
    lines.push(`    needs: ${extra.needs}`);
  }
  const conditions = [extra.if, isSelfHosted(options.runsOn) ? FORK_GUARD : null].filter(Boolean);
  if (conditions.length === 1) {
    lines.push(`    if: ${conditions[0]}`);
  } else if (conditions.length > 1) {
    lines.push(`    if: ${conditions.map((condition) => `(${condition})`).join(' && ')}`);
  }
  if (extra.timeout) {
    lines.push(`    timeout-minutes: ${extra.timeout}`);
  }
  if (extra.workingDirectory) {
    lines.push('    defaults:', '      run:', `        working-directory: ${extra.workingDirectory}`);
  }
  return lines;
}

function runStep(name, command, extra = {}) {
  if (!command) {
    return [];
  }
  const lines = [`      - name: ${name}`];
  if (extra.workingDirectory) {
    lines.push(`        working-directory: ${extra.workingDirectory}`);
  }
  lines.push(`        run: ${command}`);
  return lines;
}

function sonarJob(job) {
  return [
    ...job('sonar', 'SonarCloud', {
      needs: 'test',
      if: "github.event_name == 'pull_request' || github.ref == 'refs/heads/main'",
    }),
    '    steps:',
    `      - uses: ${ACTIONS.checkout}`,
    '        with:',
    '          fetch-depth: 0',
    `      - uses: ${ACTIONS.downloadArtifact}`,
    '        with:',
    '          name: coverage-report',
    '          path: coverage/',
    '      - name: Detectar configuração do SonarCloud',
    '        id: sonar-config',
    '        shell: bash',
    '        env:',
    '          SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}',
    '        run: |',
    '          if [ -n "$SONAR_TOKEN" ] && ! grep -Eq \'YOUR_ORG|YOUR_REPO\' sonar-project.properties; then',
    '            echo "enabled=true" >> "$GITHUB_OUTPUT"',
    '          else',
    '            echo "enabled=false" >> "$GITHUB_OUTPUT"',
    '            echo "SonarCloud não configurado; job tratado como advisory skip"',
    '          fi',
    '      - name: SonarCloud scan',
    "        if: steps.sonar-config.outputs.enabled == 'true'",
    `        uses: ${ACTIONS.sonarScan}`,
    '        env:',
    '          SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}',
    '          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}',
    '      - name: SonarCloud quality gate check',
    "        if: steps.sonar-config.outputs.enabled == 'true'",
    `        uses: ${ACTIONS.sonarGate}`,
    '        timeout-minutes: 5',
    '        env:',
    '          SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}',
  ];
}

function reportJob(job, opts, includeSonar) {
  return [
    ...job('report', 'PR report', {
      needs: includeSonar ? '[security, lint, test, sonar, docker]' : '[security, lint, test, docker]',
      if: "always() && github.event_name == 'pull_request'",
    }),
    '    permissions:',
    '      contents: read',
    '      issues: write',
    '      pull-requests: write',
    '    steps:',
    ...nodeSetupSteps('.', opts, { install: false }),
    `      - uses: ${ACTIONS.downloadArtifact}`,
    '        with:',
    '          name: coverage-report',
    '          path: coverage/',
    '        continue-on-error: true',
    '      - name: Generate PR snapshot',
    '        run: node scripts/pr-snapshot.cjs --pr "$PR_NUMBER" --json --output .quality-gate/reports/pr-snapshot.json',
    '        env:',
    '          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}',
    '          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}',
    '          GITHUB_REPOSITORY: ${{ github.repository }}',
    '          PR_NUMBER: ${{ github.event.pull_request.number }}',
    '        continue-on-error: true',
    '      - name: Postar sticky comment no PR',
    '        run: node scripts/pr-comment.js',
    '        env:',
    '          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}',
    '          PR_NUMBER: ${{ github.event.pull_request.number }}',
    '          RUN_ID: ${{ github.run_id }}',
    '          SECURITY_RESULT: ${{ needs.security.result }}',
    '          LINT_RESULT: ${{ needs.lint.result }}',
    '          TEST_RESULT: ${{ needs.test.result }}',
    ...(includeSonar ? ['          SONAR_RESULT: ${{ needs.sonar.result }}'] : []),
    `          REQUIRED_CHECKS: '${requiredChecks(opts).join(',')}'`,
    '          SNAPSHOT_PATH: .quality-gate/reports/pr-snapshot.json',
    '          DOCKER_RESULT: ${{ needs.docker.result }}',
  ];
}

// options: packageManager, commands (de lib/package-manager shellCommands), runsOn (labels),
// branches (push), nodeVersionFile, skipSonar, secretScan, secretScanIgnore.
/** @param {string} projectDir @param {any} [options] */
function nodeWorkflow(projectDir, options = {}) {
  const workingDirectory = projectDir === '.' ? '.' : projectDir;
  const opts = {
    ...options,
    commands: options.commands || {
      install: 'npm ci',
      test: 'npm run test --if-present',
      lint: 'npm run lint --if-present',
      build: 'npm run build --if-present',
      auditLevel: (level) => `npm audit --audit-level=${level}`,
    },
  };
  const cmd = opts.commands;
  const includeSonar = !opts.skipSonar;
  const branches = opts.branches && opts.branches.length > 0 ? opts.branches : ['main'];
  const timeout = isSelfHosted(opts.runsOn) ? 20 : null;
  const job = (id, name, extra = {}) => jobHeader(id, name, opts, { timeout, ...extra });

  const security = [
    ...job('security', 'Security audit', { workingDirectory }),
    '    steps:',
    ...nodeSetupSteps(workingDirectory, opts),
    ...runStep('Vulnerabilidade crítica', cmd.auditLevel('critical')),
    ...runStep('Vulnerabilidade alta advisory', `${cmd.auditLevel('high')} || true`),
    ...(opts.secretScan
      ? runStep(
          'Secret scan',
          [
            'node scripts/secret-scan.cjs --all',
            ...(opts.secretScanIgnore || []).map((p) => `--ignore ${p}`),
          ].join(' '),
          { workingDirectory: '.' },
        )
      : []),
  ];

  const lint = [
    ...job('lint', 'Lint', { workingDirectory }),
    '    steps:',
    ...nodeSetupSteps(workingDirectory, opts),
    ...runStep('Lint', cmd.lint),
  ];

  const testJob = [
    ...job('test', 'Tests & ratchet', { workingDirectory }),
    '    steps:',
    ...nodeSetupSteps(workingDirectory, opts, { fetchDepth: true }),
    ...runStep('Node tests', cmd.test),
    ...runStep('Node build', cmd.build),
    ...runStep('Ratchet', 'node scripts/quality-gate.js check', { workingDirectory: '.' }),
    '      - name: Upload coverage',
    `        uses: ${ACTIONS.uploadArtifact}`,
    '        if: always()',
    '        with:',
    '          name: coverage-report',
    '          path: coverage/',
    '          if-no-files-found: ignore',
    '          retention-days: 7',
  ];

  const docker = [
    ...job('docker', 'Docker image gate'),
    '    steps:',
    ...nodeSetupSteps('.', opts, { install: false }),
    '      - name: Docker Image Doctor gate',
    '        run: node scripts/docker-gate.cjs --project . --json',
    '      - name: Upload Docker gate report',
    `        uses: ${ACTIONS.uploadArtifact}`,
    '        if: always()',
    '        with:',
    '          name: docker-gate-report',
    '          path: .quality-gate/reports/docker-image-doctor.json',
    '          if-no-files-found: ignore',
    '          retention-days: 7',
  ];

  const header = [
    '# quality-gate:managed-workflow version 2',
    '# Gerado por scripts/configure-project.cjs. Para mudar, rode `qg init` de novo.',
    ...(isSelfHosted(opts.runsOn)
      ? ['# Runner self-hosted: nunca trocar pull_request por pull_request_target.']
      : []),
    'name: Quality Gate',
    '',
    'on:',
    '  pull_request:',
    '    types: [opened, synchronize, reopened]',
    '  push:',
    `    branches: [${branches.join(', ')}]`,
    '  workflow_dispatch:',
    '',
    'concurrency:',
    '  group: quality-gate-${{ github.ref }}',
    '  cancel-in-progress: true',
    '',
    'permissions:',
    '  contents: read',
    '',
    ...(cmd.usesCorepack ? ['env:', "  COREPACK_ENABLE_DOWNLOAD_PROMPT: '0'", ''] : []),
    'jobs:',
  ];

  const jobs = [
    security,
    lint,
    testJob,
    includeSonar ? sonarJob(job) : [],
    docker,
    reportJob(job, opts, includeSonar),
  ];
  const body = jobs
    .filter((lines) => lines.length > 0)
    .map((lines) => lines.join('\n'))
    .join('\n\n');
  return `${header.join('\n')}\n${body}\n`;
}

function nodeSonarProperties(current, projectDir) {
  const prefix = projectDir === '.' ? '' : `${projectDir}/`;
  const lines = current
    .split(/\r?\n/)
    .filter(
      (line) =>
        !/^sonar\.(sources|tests|test\.inclusions|exclusions|javascript\.lcov\.reportPaths|typescript\.tsconfigPath|python\.coverage\.reportPaths)=/.test(
          line,
        ),
    );
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  lines.push(
    `sonar.sources=${prefix}src`,
    `sonar.tests=${prefix}test,${prefix}tests`,
    'sonar.test.inclusions=**/*.test.js,**/*.spec.js,**/*.test.cjs,**/*.spec.cjs',
    'sonar.exclusions=**/node_modules/**,**/dist/**,**/build/**,**/coverage/**,scripts/**,.github/**,.quality-gate/**,docs/**',
    'sonar.javascript.lcov.reportPaths=coverage/lcov.info',
  );
  return `${lines.join('\n').replace(/\n+$/g, '')}\n`;
}

function pythonSonarProperties(current, projectDir) {
  const prefix = projectDir === '.' ? '' : `${projectDir}/`;
  const lines = current
    .split(/\r?\n/)
    .filter(
      (line) =>
        !/^sonar\.(sources|tests|test\.inclusions|exclusions|javascript\.lcov\.reportPaths|typescript\.tsconfigPath|python\.coverage\.reportPaths)=/.test(
          line,
        ),
    );
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  lines.push(
    `sonar.sources=${prefix}src`,
    `sonar.tests=${prefix}tests`,
    'sonar.test.inclusions=**/tests/**/*.py,**/test_*.py,**/*_test.py',
    'sonar.exclusions=**/.venv/**,**/.pytest_cache/**,**/coverage/**,**/__pycache__/**,scripts/**,.github/**,.quality-gate/**,docs/**',
    'sonar.python.coverage.reportPaths=coverage/coverage.xml',
  );
  return `${lines.join('\n').replace(/\n+$/g, '')}\n`;
}

module.exports = {
  ACTIONS,
  dotnetWorkflow,
  goWorkflow,
  rustWorkflow,
  REQUIRED_CHECKS,
  requiredChecks,
  nodeSonarProperties,
  nodeWorkflow,
  pythonCoveragePath,
  pythonSonarProperties,
  pythonWorkflow,
};

function rustWorkflow(projectDir = '.') {
  const wd = projectDir === '.' ? '.' : projectDir;
  return [
    '# quality-gate:managed-workflow version 1',
    'name: Quality Gate (Rust)',
    '',
    'on:',
    '  pull_request:',
    '    types: [opened, synchronize, reopened]',
    '  push:',
    '    branches: [main]',
    '',
    'permissions:',
    '  contents: read',
    '',
    'jobs:',
    '  test:',
    '    name: Tests & ratchet',
    '    runs-on: ubuntu-latest',
    '    defaults:',
    '      run:',
    `        working-directory: ${wd}`,
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - uses: dtolnay/rust-toolchain@stable',
    '        with:',
    '          components: clippy, llvm-tools-preview',
    '      - name: Rust tests',
    '        run: cargo test --all',
    '      - name: Clippy linter',
    '        run: cargo clippy --all-targets -- -D warnings',
    '',
  ].join('\n');
}

function goWorkflow(projectDir = '.') {
  const wd = projectDir === '.' ? '.' : projectDir;
  return [
    '# quality-gate:managed-workflow version 1',
    'name: Quality Gate (Go)',
    '',
    'on:',
    '  pull_request:',
    '    types: [opened, synchronize, reopened]',
    '  push:',
    '    branches: [main]',
    '',
    'permissions:',
    '  contents: read',
    '',
    'jobs:',
    '  test:',
    '    name: Tests & ratchet',
    '    runs-on: ubuntu-latest',
    '    defaults:',
    '      run:',
    `        working-directory: ${wd}`,
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - uses: actions/setup-go@v5',
    '        with:',
    '          go-version: "1.22"',
    '      - name: Go tests & coverage',
    '        run: go test -v -coverprofile=coverage.out ./...',
    '',
  ].join('\n');
}

function dotnetWorkflow(projectDir = '.') {
  const wd = projectDir === '.' ? '.' : projectDir;
  return [
    '# quality-gate:managed-workflow version 1',
    'name: Quality Gate (.NET)',
    '',
    'on:',
    '  pull_request:',
    '    types: [opened, synchronize, reopened]',
    '  push:',
    '    branches: [main]',
    '',
    'permissions:',
    '  contents: read',
    '',
    'jobs:',
    '  test:',
    '    name: Tests & ratchet',
    '    runs-on: ubuntu-latest',
    '    defaults:',
    '      run:',
    `        working-directory: ${wd}`,
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - uses: actions/setup-dotnet@v4',
    '        with:',
    '          dotnet-version: "8.0.x"',
    '      - name: .NET test',
    '        run: dotnet test',
    '      - name: .NET format check',
    '        run: dotnet format --verify-no-changes',
    '',
  ].join('\n');
}
