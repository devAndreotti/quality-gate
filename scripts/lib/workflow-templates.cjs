// Workflow & Sonar templates for project auto-configuration

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



function pythonCoveragePath(projectDir, fileName) {
  return projectDir === "." ? `coverage/${fileName}` : `../coverage/${fileName}`;
}

function pythonWorkflow(projectDir, options = {}) {
  const workingDirectory = projectDir === '.' ? '.' : projectDir;
  const coverageJson = pythonCoveragePath(projectDir, 'coverage.json');
  const coverageXml = pythonCoveragePath(projectDir, 'coverage.xml');
  const ruffJson = pythonCoveragePath(projectDir, 'ruff.json');
  const coverageDir = projectDir === '.' ? 'coverage' : '../coverage';
  const includeSonar = !options.skipSonar;
  const sonarJob = includeSonar ? `

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
` : '';
  const reportNeeds = includeSonar
    ? '[security, lint, test, sonar, docker]'
    : '[security, lint, test, docker]';
  const sonarResultEnv = includeSonar
    ? '          SONAR_RESULT: ${{ needs.sonar.result }}\n'
    : '';

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


function nodeWorkflow(projectDir, options = {}) {
  const workingDirectory = projectDir === '.' ? '.' : projectDir;
  const includeSonar = !options.skipSonar;
  const sonarJob = includeSonar ? `

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
      - name: Detectar configuração do SonarCloud
        id: sonar-config
        shell: bash
        env:
          SONAR_TOKEN: \${{ secrets.SONAR_TOKEN }}
        run: |
          if [ -n "$SONAR_TOKEN" ] && ! grep -Eq 'YOUR_ORG|YOUR_REPO' sonar-project.properties; then
            echo "enabled=true" >> "$GITHUB_OUTPUT"
          else
            echo "enabled=false" >> "$GITHUB_OUTPUT"
            echo "SonarCloud não configurado; job tratado como advisory skip"
          fi
      - name: SonarCloud scan
        if: steps.sonar-config.outputs.enabled == 'true'
        uses: SonarSource/sonarqube-scan-action@v5
        env:
          SONAR_TOKEN: \${{ secrets.SONAR_TOKEN }}
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
      - name: SonarCloud quality gate check
        if: steps.sonar-config.outputs.enabled == 'true'
        uses: sonarsource/sonarqube-quality-gate-action@master
        timeout-minutes: 5
        env:
          SONAR_TOKEN: \${{ secrets.SONAR_TOKEN }}
` : '';
  const reportNeeds = includeSonar
    ? '[security, lint, test, sonar, docker]'
    : '[security, lint, test, docker]';
  const sonarResultEnv = includeSonar
    ? '          SONAR_RESULT: ${{ needs.sonar.result }}\n'
    : '';

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
      - uses: actions/setup-node@v6
        with:
          node-version: 20
          cache: npm
          cache-dependency-path: ${workingDirectory === '.' ? 'package-lock.json' : `${workingDirectory}/package-lock.json`}
      - run: npm ci
      - name: Vulnerabilidade crítica
        run: npm audit --audit-level=critical
      - name: Vulnerabilidade alta advisory
        run: npm audit --audit-level=high || true

  lint:
    name: Lint
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: ${workingDirectory}
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: 20
          cache: npm
          cache-dependency-path: ${workingDirectory === '.' ? 'package-lock.json' : `${workingDirectory}/package-lock.json`}
      - run: npm ci
      - run: npm run lint --if-present

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
      - uses: actions/setup-node@v6
        with:
          node-version: 20
          cache: npm
          cache-dependency-path: ${workingDirectory === '.' ? 'package-lock.json' : `${workingDirectory}/package-lock.json`}
      - run: npm ci
      - name: Node tests
        run: npm run test --if-present
      - name: Node build
        run: npm run build --if-present
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


function nodeSonarProperties(current, projectDir) {
  const prefix = projectDir === '.' ? '' : `${projectDir}/`;
  const lines = current
    .split(/\r?\n/)
    .filter((line) => !/^sonar\.(sources|tests|test\.inclusions|exclusions|javascript\.lcov\.reportPaths|typescript\.tsconfigPath|python\.coverage\.reportPaths)=/.test(line));
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
    .filter((line) => !/^sonar\.(sources|tests|test\.inclusions|exclusions|javascript\.lcov\.reportPaths|typescript\.tsconfigPath|python\.coverage\.reportPaths)=/.test(line));
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
  REQUIRED_CHECKS,
  requiredChecks,
  nodeSonarProperties,
  nodeWorkflow,
  pythonCoveragePath,
  pythonSonarProperties,
  pythonWorkflow,
};
