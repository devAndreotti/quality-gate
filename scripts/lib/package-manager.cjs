// Gerenciador de pacotes do projeto Node, detectado pelo lockfile.
// `npm ci`/`npm audit` exigem package-lock e falham num repo yarn/pnpm. Yarn 2+ (Berry) tem .yarnrc.yml.
const fs = require('node:fs');
const path = require('node:path');

function detectPackageManager(root) {
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  }
  if (fs.existsSync(path.join(root, 'yarn.lock'))) {
    return fs.existsSync(path.join(root, '.yarnrc.yml')) ? 'yarn' : 'yarn1';
  }
  return 'npm';
}

// Argumentos por comando, para spawn sem shell (local-validate).
const NODE_COMMANDS = {
  npm: {
    bin: 'npm',
    install: ['ci'],
    run: (script) => ['run', script, '--if-present'],
    audit: ['audit', '--audit-level=moderate'],
    auditLevel: (level) => ['audit', `--audit-level=${level}`],
  },
  pnpm: {
    bin: 'pnpm',
    install: ['install', '--frozen-lockfile'],
    run: (script) => ['run', '--if-present', script],
    audit: ['audit', '--audit-level', 'moderate'],
    auditLevel: (level) => ['audit', '--audit-level', level],
  },
  yarn: {
    bin: 'yarn',
    install: ['install', '--immutable'],
    run: (script) => ['run', script],
    audit: ['npm', 'audit', '--all', '--recursive', '--severity', 'moderate'],
    auditLevel: (level) => ['npm', 'audit', '--all', '--recursive', '--severity', level],
  },
  yarn1: {
    bin: 'yarn',
    install: ['install', '--frozen-lockfile'],
    run: (script) => ['run', script],
    audit: ['audit', '--level', 'moderate'],
    auditLevel: (level) => ['audit', '--level', level],
  },
};

// Linhas de shell para workflow e policy. Yarn não tem --if-present: só roda script que existe.
function shellCommands(pm, scripts = null) {
  const tool = NODE_COMMANDS[pm] || NODE_COMMANDS.npm;
  const line = (args) => [tool.bin, ...args].join(' ');
  const run = (script) => {
    if (pm.startsWith('yarn') && scripts && !scripts[script]) {
      return null;
    }
    return line(tool.run(script));
  };
  return {
    install: line(tool.install),
    test: run('test'),
    lint: run('lint'),
    build: run('build'),
    audit: line(tool.audit),
    auditLevel: (level) => line(tool.auditLevel(level)),
    usesCorepack: pm !== 'npm',
  };
}

function readPackageScripts(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts || {};
  } catch {
    return {};
  }
}

// Comandos de uma surface node na policy (só strings; script ausente no yarn fica de fora).
function surfaceCommands(root) {
  const cmd = shellCommands(detectPackageManager(root), readPackageScripts(root));
  const commands = {
    install: cmd.install,
    test: cmd.test,
    lint: cmd.lint,
    build: cmd.build,
    audit: cmd.audit,
  };
  return Object.fromEntries(Object.entries(commands).filter(([, value]) => value));
}

module.exports = { NODE_COMMANDS, detectPackageManager, readPackageScripts, shellCommands, surfaceCommands };
