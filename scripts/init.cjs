#!/usr/bin/env node
// qg init — instala ou atualiza o Quality Gate num projeto, sem PowerShell.
//
// Uso (a partir do checkout do quality-gate):
//   node scripts/init.cjs --project <dir> [--runs-on self-hosted,label] [--branches dev,main]
//                         [--secret-ignore .agents/] [--skip-baseline] [--dry-run] [--json]
//
// Modo company (o único deste comando; a instalação completa continua no qg-init do PowerShell):
// copia scripts/ e .quality-gate/ e gera só o workflow do gate. Sem Sonar, sem outros workflows,
// sem FUNDING/dependabot/.codex, sem commit e sem chamada ao GitHub. Rodar de novo atualiza
// os scripts e reaproveita as opções gravadas em policy.install.
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { configureProject, detectProjectProfile } = require('./configure-project.cjs');

const TEMPLATE_ROOT = path.resolve(__dirname, '..');
const COPY_ROOTS = ['scripts', '.quality-gate'];
// Fora da cópia: testes e admin deste repo, dados locais e o que o projeto já tem de seu.
const SKIP = [
  /\.test\.(c?js|ps1)$/,
  /^scripts\/QualityGate\.ps1$/,
  /^scripts\/build-tui\.mjs$/,
  /^scripts\/baseline\.json$/,
  /^scripts\/.*\.example\.json$/,
  /^\.quality-gate\/(policy\.json|state\.json)$/,
  /^\.quality-gate\/reports\//,
];
const GITIGNORE_ENTRIES = ['.quality-gate/state.json', '.quality-gate/reports/'];
const MANIFEST = '.quality-gate/manifest.json';

function parseArgs(argv) {
  const args = {
    project: process.cwd(),
    mode: 'company',
    runsOn: null,
    branches: null,
    secretScanIgnore: null,
    skipBaseline: false,
    force: false,
    dryRun: false,
    json: false,
  };
  const list = (value) =>
    String(value || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project') {
      args.project = argv[++index];
    } else if (arg === '--mode') {
      args.mode = argv[++index];
    } else if (arg === '--runs-on') {
      args.runsOn = list(argv[++index]);
    } else if (arg === '--branches') {
      args.branches = list(argv[++index]);
    } else if (arg === '--secret-ignore') {
      args.secretScanIgnore = list(argv[++index]);
    } else if (arg === '--skip-baseline') {
      args.skipBaseline = true;
    } else if (arg === '--force') {
      args.force = true;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--json') {
      args.json = true;
    } else {
      throw new Error(`argumento desconhecido: ${arg}`);
    }
  }
  return args;
}

function walk(root, relative) {
  const full = path.join(root, relative);
  if (!fs.existsSync(full)) {
    return [];
  }
  return fs.readdirSync(full, { withFileTypes: true }).flatMap((entry) => {
    const child = `${relative}/${entry.name}`;
    return entry.isDirectory() ? walk(root, child) : [child];
  });
}

// Só arquivos versionados do template: nada de relatório, node_modules ou rascunho local.
function templateFiles(templateRoot, exec = childProcess.execFileSync) {
  let files;
  try {
    files = String(exec('git', ['-C', templateRoot, 'ls-files', '--', ...COPY_ROOTS], { encoding: 'utf8' }))
      .split('\n')
      .filter(Boolean);
  } catch {
    files = COPY_ROOTS.flatMap((dir) => walk(templateRoot, dir));
  }
  return files.filter((file) => !SKIP.some((pattern) => pattern.test(file)));
}

function readPolicy(projectRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(projectRoot, '.quality-gate', 'policy.json'), 'utf8'));
  } catch {
    return null;
  }
}

function readManifest(projectRoot) {
  try {
    return new Set(JSON.parse(fs.readFileSync(path.join(projectRoot, MANIFEST), 'utf8')).files);
  } catch {
    return new Set();
  }
}

// Arquivo do projeto com o mesmo nome de um do gate, que não veio de instalação anterior.
function findConflicts(templateRoot, projectRoot, files) {
  const installed = readManifest(projectRoot);
  return files.filter((file) => {
    const target = path.join(projectRoot, file);
    if (installed.has(file) || !fs.existsSync(target)) {
      return false;
    }
    return !fs.readFileSync(target).equals(fs.readFileSync(path.join(templateRoot, file)));
  });
}

function copyFiles(templateRoot, projectRoot, files, dryRun) {
  let changed = 0;
  if (!dryRun) {
    fs.mkdirSync(path.join(projectRoot, '.quality-gate'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, MANIFEST), `${JSON.stringify({ files }, null, 2)}\n`);
  }
  for (const file of files) {
    const source = path.join(templateRoot, file);
    const target = path.join(projectRoot, file);
    const content = fs.readFileSync(source);
    if (fs.existsSync(target) && fs.readFileSync(target).equals(content)) {
      continue;
    }
    changed += 1;
    if (!dryRun) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
  }
  return changed;
}

function writeVersion(templateRoot, projectRoot, dryRun) {
  const version = fs.readFileSync(path.join(templateRoot, 'VERSION'), 'utf8').trim();
  let commit = null;
  try {
    // git do PATH, como no resto do gate (lib/github.cjs): ferramenta de dev, binário fixo.
    const args = ['-C', templateRoot, 'rev-parse', '--short', 'HEAD'];
    const options = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
    commit = String(childProcess.execFileSync('git', args, options)).trim(); // NOSONAR
  } catch {
    // Template fora de um checkout git: grava só a versão.
  }
  if (!dryRun) {
    const text = commit ? `${version}\ncommit ${commit}\n` : `${version}\n`;
    fs.writeFileSync(path.join(projectRoot, '.quality-gate', 'VERSION'), text);
  }
  return commit ? `${version} (${commit})` : version;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// O que o projeto já definiu ganha; o template só preenche o que falta.
function mergeDefaults(current, defaults) {
  const merged = { ...defaults };
  for (const [key, value] of Object.entries(current)) {
    merged[key] =
      isPlainObject(value) && isPlainObject(defaults[key]) ? mergeDefaults(value, defaults[key]) : value;
  }
  return merged;
}

// Policy existente e incompleta (escrita à mão, ou de versão antiga) não passa no validador.
function completePolicy(templateRoot, projectRoot, dryRun) {
  const current = readPolicy(projectRoot);
  if (!current || dryRun) {
    return;
  }
  const { buildProjectPolicy } = require('./bootstrap-repo.cjs');
  const template = JSON.parse(
    fs.readFileSync(path.join(templateRoot, '.quality-gate', 'policy.json'), 'utf8'),
  );
  const merged = mergeDefaults(current, buildProjectPolicy(template, projectRoot));
  fs.writeFileSync(
    path.join(projectRoot, '.quality-gate', 'policy.json'),
    `${JSON.stringify(merged, null, 2)}\n`,
  );
}

// Modo company: nada de README, LICENSE, FUNDING ou dependabot do bootstrap pessoal.
function applyCompanyPolicy(projectRoot, install, dryRun) {
  const policyPath = path.join(projectRoot, '.quality-gate', 'policy.json');
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  for (const key of ['license', 'funding', 'dependabot', 'readme']) {
    policy.bootstrap[key].enabled = false;
  }
  // O validador exige o campo; o valor do template é a conta pessoal do mantenedor.
  policy.bootstrap.funding.buyMeACoffee = 'disabled';
  policy.github.copilotReview = false;
  policy.install = install;
  if (!dryRun) {
    fs.writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
  }
}

function updateGitignore(projectRoot, dryRun) {
  const gitignore = path.join(projectRoot, '.gitignore');
  const current = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, 'utf8') : '';
  const lines = current.split(/\r?\n/).map((line) => line.trim());
  const missing = GITIGNORE_ENTRIES.filter((entry) => !lines.includes(entry));
  if (missing.length > 0 && !dryRun) {
    const eol = current.includes('\r\n') ? '\r\n' : '\n';
    const prefix = current && !current.endsWith('\n') ? eol : '';
    fs.writeFileSync(gitignore, `${current}${prefix}${eol}# Quality Gate${eol}${missing.join(eol)}${eol}`);
  }
  return missing;
}

function captureBaseline(projectRoot, dryRun) {
  if (fs.existsSync(path.join(projectRoot, 'scripts', 'baseline.json'))) {
    return 'mantido';
  }
  if (dryRun) {
    return 'seria gerado';
  }
  const result = childProcess.spawnSync(process.execPath, ['scripts/quality-gate.js', 'init'], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  return result.status === 0
    ? 'gerado'
    : 'sem coverage: rode os testes com coverage e depois `qg coverage update`';
}

function runInit(options = {}) {
  const templateRoot = path.resolve(options.templateRoot || TEMPLATE_ROOT);
  const projectRoot = path.resolve(options.project || process.cwd());
  const dryRun = Boolean(options.dryRun);
  if (options.mode && options.mode !== 'company') {
    throw new Error(`modo ${options.mode} não existe aqui; a instalação completa é o qg-init (PowerShell)`);
  }
  if (projectRoot === templateRoot) {
    throw new Error(
      'o projeto é o próprio checkout do quality-gate: rode o init do checkout do gate, de dentro do projeto',
    );
  }
  if (!fs.existsSync(path.join(projectRoot, '.git'))) {
    throw new Error(`${projectRoot} não é a raiz de um repositório git`);
  }
  const profile = detectProjectProfile(projectRoot);
  if (!['node', 'python-uv'].includes(profile.name)) {
    throw new Error(`stack ${profile.name} não suportada (node ou python-uv)`);
  }

  const previous = readPolicy(projectRoot)?.install || {};
  const install = {
    mode: 'company',
    runsOn: options.runsOn || previous.runsOn || [],
    branches: options.branches || previous.branches || ['main'],
    secretScanIgnore: options.secretScanIgnore || previous.secretScanIgnore || [],
  };

  const files = templateFiles(templateRoot, options.exec);
  const conflicts = findConflicts(templateRoot, projectRoot, files);
  if (conflicts.length > 0 && !options.force) {
    throw new Error(
      `o projeto já tem arquivos com esses nomes (use --force para sobrescrever): ${conflicts.join(', ')}`,
    );
  }
  const steps = [];
  steps.push({
    step: 'Arquivos',
    detail: `${copyFiles(templateRoot, projectRoot, files, dryRun)} de ${files.length} alterados`,
  });
  steps.push({ step: 'Versão', detail: writeVersion(templateRoot, projectRoot, dryRun) });

  completePolicy(templateRoot, projectRoot, dryRun);
  const configured = configureProject({
    projectRoot,
    templateRoot,
    dryRun,
    skipSonar: true,
    runsOn: install.runsOn,
    branches: install.branches,
    secretScan: true,
    secretScanIgnore: install.secretScanIgnore,
    installMode: 'company',
  });
  steps.push({ step: 'Workflow e policy', detail: configured.steps.map((s) => s.detail).join('; ') });
  if (!dryRun) {
    applyCompanyPolicy(projectRoot, install, dryRun);
  }

  const ignored = updateGitignore(projectRoot, dryRun);
  steps.push({
    step: '.gitignore',
    detail: ignored.length ? `adiciona ${ignored.join(', ')}` : 'já configurado',
  });
  steps.push({
    step: 'Baseline',
    detail: options.skipBaseline ? 'pulado' : captureBaseline(projectRoot, dryRun),
  });

  return { projectRoot, templateRoot, dryRun, profile: profile.name, install, steps };
}

// Caminho e mensagem vêm do argv: CR/LF escapado impede linha de log forjada.
function oneLine(text) {
  return String(text).replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

function printResult(result) {
  console.log(`\nQuality Gate init (company)${result.dryRun ? ' — dry-run, nada gravado' : ''}`);
  console.log(`Projeto: ${oneLine(result.projectRoot)} (${result.profile})`);
  for (const step of result.steps) {
    console.log(`  ${step.step.padEnd(18)} ${oneLine(step.detail)}`);
  }
  console.log('\nPróximo: revise o diff (git status), rode `node scripts/qg.cjs doctor` e commite.');
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const result = runInit(args);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printResult(result);
  }
  return result;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`qg init: ${oneLine(error.message)}`);
    process.exitCode = 1;
  }
}

module.exports = { main, oneLine, parseArgs, runInit, templateFiles };
