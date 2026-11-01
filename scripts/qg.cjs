#!/usr/bin/env node
// qg — entrada única do Quality Gate. Só despacha para os scripts existentes, repassando os argumentos.
//
// Uso: qg <comando> [argumentos]
//   dashboard   painel no terminal (dashboard.cjs)
//   pr          validação local, perfil PR (local-validate.cjs --profile pr)
//   secrets     varredura de segredos (secret-scan.cjs; ex.: qg secrets --all | --diff | --history)
//   coverage    ratchet de cobertura (quality-gate.js check)
//   diff        cobertura das linhas novas (diff-coverage-gate.cjs --base origin/main)
//   commits     valida mensagens de commit (commit-lint.cjs)
//   fleet       estado de vários repos do GitHub (fleet-github.cjs)
//   doctor      auditoria do pacote (doctor.cjs)
//   version     versão do pacote
//   help        esta ajuda
// Exit: o do script chamado; 2 para comando desconhecido.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const COMMANDS = {
  dashboard: { script: 'dashboard.cjs', args: [] },
  pr: { script: 'local-validate.cjs', args: ['--profile', 'pr'] },
  secrets: { script: 'secret-scan.cjs', args: [] },
  coverage: { script: 'quality-gate.js', args: ['check'] },
  diff: { script: 'diff-coverage-gate.cjs', args: ['--base', 'origin/main'] },
  commits: { script: 'commit-lint.cjs', args: [] },
  fleet: { script: 'fleet-github.cjs', args: [] },
  doctor: { script: 'doctor.cjs', args: [] },
};

const HELP = [
  'qg — entrada única do Quality Gate',
  '',
  'Uso: qg <comando> [argumentos]',
  '',
  ...Object.entries({
    dashboard: 'painel no terminal',
    pr: 'validação local, perfil PR',
    secrets: 'segredos (--all, --diff, --history)',
    coverage: 'ratchet de cobertura',
    diff: 'cobertura das linhas novas (contra origin/main)',
    commits: 'mensagens de commit (Conventional Commits)',
    fleet: 'estado de vários repos do GitHub',
    doctor: 'auditoria do pacote',
    version: 'versão do pacote',
    help: 'esta ajuda',
  }).map(([name, desc]) => `  ${name.padEnd(10)} ${desc}`),
].join('\n');

function version(root) {
  try {
    return fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
  } catch {
    return 'desconhecida';
  }
}

// Decide o que fazer sem executar nada: { code, out } ou { run: {script, args} }.
function resolve(argv, root) {
  const [name, ...rest] = argv;
  if (!name || name === 'help' || name === '--help' || name === '-h') return { code: 0, out: HELP };
  if (name === 'version' || name === '--version') return { code: 0, out: version(root) };
  const cmd = COMMANDS[name];
  if (!cmd) return { code: 2, out: `comando desconhecido: ${name}\n\n${HELP}` };
  return { run: { script: path.join(root, 'scripts', cmd.script), args: [...cmd.args, ...rest] } };
}

function main(argv, deps = {}) {
  const root = deps.root || path.resolve(__dirname, '..');
  const plan = resolve(argv, root);
  if (plan.run) {
    const result = (deps.spawn || spawnSync)(process.execPath, [plan.run.script, ...plan.run.args], {
      stdio: 'inherit',
    });
    return { code: result.status ?? 1 };
  }
  return plan;
}

module.exports = { COMMANDS, HELP, main, resolve };

if (require.main === module) {
  const r = main(process.argv.slice(2));
  if (r.out !== undefined) console.log(r.out);
  process.exitCode = r.code;
}
