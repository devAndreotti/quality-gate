const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { loadPolicy } = require('./lib/policy.cjs');
const { detectDockerProject } = require('./lib/docker-detect.cjs');
const {
  buildDockerDoctorCommand,
  runDockerGate,
} = require('./docker-gate.cjs');

const root = path.resolve(__dirname, '..');

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qg-docker-'));
}

test('detectDockerProject skips project without Docker files', () => {
  const project = tempProject();
  const detected = detectDockerProject(project);

  assert.equal(detected.hasDocker, false);
  assert.deepEqual(detected.dockerfiles, []);
  assert.deepEqual(detected.composeFiles, []);
  assert.deepEqual(detected.dockerignoreFiles, []);
});

test('detectDockerProject finds Dockerfile, compose, and dockerignore', () => {
  const project = tempProject();
  fs.mkdirSync(path.join(project, 'services/api'), { recursive: true });
  fs.writeFileSync(path.join(project, 'services/api/Dockerfile'), 'FROM node:20\n');
  fs.writeFileSync(path.join(project, 'compose.yaml'), 'services: {}\n');
  fs.writeFileSync(path.join(project, '.dockerignore'), 'node_modules\n');

  const detected = detectDockerProject(project);

  assert.equal(detected.hasDocker, true);
  assert.equal(detected.dockerfiles.length, 1);
  assert.equal(detected.composeFiles.length, 1);
  assert.equal(detected.dockerignoreFiles.length, 1);
});

test('buildDockerDoctorCommand is non-interactive and uses policy args', () => {
  const policy = loadPolicy(root);
  const project = 'C:\\repo\\sample';
  const command = buildDockerDoctorCommand({ policy, projectRoot: project });

  assert.match(command.args.join(' '), /-Project/);
  assert.ok(command.args.includes(project));
  assert.ok(command.args.includes('-ForAI'));
  assert.ok(command.args.includes('-NoPrompt'));
  assert.equal(command.args.includes('-Interactive'), false);
});

test('runDockerGate skips without invoking Docker Doctor when no Docker files exist', () => {
  const project = tempProject();
  const policy = loadPolicy(root);
  let invoked = false;

  const result = runDockerGate({
    projectRoot: project,
    policy,
    invokeDoctor: () => {
      invoked = true;
      throw new Error('should not invoke');
    },
  });

  assert.equal(result.status, 'skipped');
  assert.equal(invoked, false);
});

test('runDockerGate dry-run plans command for Docker project without executing it', () => {
  const project = tempProject();
  fs.writeFileSync(path.join(project, 'Dockerfile'), 'FROM alpine:3.20\n');
  // doctorScript fica fora de `project` de proposito: dockerImageDoctor.scriptPath
  // resolvendo pra dentro do projeto escaneado agora e recusado por seguranca (uma PR
  // nao pode apontar scriptPath pro proprio arquivo que ela adiciona ao repo).
  const doctorScript = path.join(tempProject(), 'doctor.ps1');
  fs.writeFileSync(doctorScript, 'Write-Output "{}"\n');
  const policy = {
    ...loadPolicy(root),
    dockerImageDoctor: {
      ...loadPolicy(root).dockerImageDoctor,
      scriptPath: doctorScript,
    },
  };
  let invoked = false;

  const result = runDockerGate({
    projectRoot: project,
    policy,
    dryRun: true,
    invokeDoctor: () => {
      invoked = true;
    },
  });

  assert.equal(result.status, 'planned');
  assert.equal(invoked, false);
  assert.ok(result.command.args.includes('-Project'));
});

test('runDockerGate uses static advisory when Docker Doctor is unavailable', () => {
  const project = tempProject();
  const gateRoot = tempProject();
  fs.writeFileSync(path.join(project, 'Dockerfile'), 'FROM node:latest\nRUN echo TOKEN=value\n');
  const policy = {
    ...loadPolicy(root),
    dockerImageDoctor: {
      ...loadPolicy(root).dockerImageDoctor,
      scriptPath: 'Z:\\missing\\18-Docker-Image-Doctor.ps1',
    },
  };

  const result = runDockerGate({ root: gateRoot, projectRoot: project, policy });

  assert.equal(result.status, 'warning');
  assert.equal(result.fallback, 'static-advisory');
  assert.ok(result.staticResult.findings.length >= 2);
  assert.match(result.reportPath, /docker-image-doctor\.json$/);
});

test('runDockerGate refuses scriptPath that resolves inside the scanned project', () => {
  const project = tempProject();
  fs.writeFileSync(path.join(project, 'Dockerfile'), 'FROM alpine:3.20\n');
  // Simula uma PR maliciosa: adiciona o proprio "doctor" ao repo e aponta scriptPath
  // pra ele. dockerImageDoctor.scriptPath vem de .quality-gate/policy.json, um arquivo
  // git-tracked que uma PR pode editar livremente.
  const plantedScript = path.join(project, 'evil.ps1');
  fs.writeFileSync(plantedScript, 'Write-Output "{}"\n');
  const policy = {
    ...loadPolicy(root),
    dockerImageDoctor: {
      ...loadPolicy(root).dockerImageDoctor,
      scriptPath: plantedScript,
    },
  };
  let invoked = false;

  const result = runDockerGate({
    projectRoot: project,
    policy,
    invokeDoctor: () => {
      invoked = true;
      throw new Error('should not invoke');
    },
  });

  assert.equal(result.status, 'failed');
  assert.match(result.reason, /recusado por seguranca/);
  assert.equal(invoked, false);
});
