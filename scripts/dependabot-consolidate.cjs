#!/usr/bin/env node
const childProcess = require('node:child_process');

function parseArgs(argv) {
  const args = {
    repo: process.env.GITHUB_REPOSITORY || null,
    dryRun: false,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--repo') args.repo = argv[++index];
    else if (arg.startsWith('--repo=')) args.repo = arg.slice('--repo='.length);
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--json') args.json = true;
  }
  return args;
}

function runGhJson(args) {
  const raw = childProcess.execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  return raw.trim() ? JSON.parse(raw) : null;
}

function analyzeDependabotPulls(pullRequests) {
  const fileOwners = new Map();
  for (const pr of pullRequests) {
    for (const file of pr.files || []) {
      if (!fileOwners.has(file)) fileOwners.set(file, []);
      fileOwners.get(file).push(pr.number);
    }
  }
  const conflictingFiles = [...fileOwners.entries()]
    .filter(([, prs]) => prs.length > 1)
    .map(([file]) => file)
    .sort((left, right) => left.localeCompare(right));

  if (pullRequests.length <= 1) {
    return {
      recommendation: 'none',
      conflictingFiles,
      order: pullRequests.map((pr) => pr.number),
    };
  }
  if (conflictingFiles.length > 0) {
    return {
      recommendation: 'consolidate',
      conflictingFiles,
      pullRequests: pullRequests.map((pr) => pr.number),
    };
  }
  return {
    recommendation: 'merge_independently',
    conflictingFiles,
    order: pullRequests.map((pr) => pr.number).sort((a, b) => a - b),
  };
}

function normalizeFiles(result) {
  return (result?.files || []).map((file) => file.path || file.filename || file).filter(Boolean);
}

function loadDependabotPulls({ repo, ghJson }) {
  const pulls = ghJson([
    'pr',
    'list',
    '--repo',
    repo,
    '--state',
    'open',
    '--author',
    'app/dependabot',
    '--json',
    'number,title,headRefName,url',
  ]) || [];
  return pulls.map((pull) => {
    const files = normalizeFiles(ghJson([
      'pr',
      'view',
      String(pull.number),
      '--repo',
      repo,
      '--json',
      'files',
    ]));
    return { ...pull, files };
  });
}

function runDependabotConsolidate(options = {}) {
  const repo = options.repo;
  if (!repo) throw new Error('--repo ou GITHUB_REPOSITORY requerido');
  const ghJson = options.ghJson || runGhJson;
  const pullRequests = options.pullRequests || loadDependabotPulls({ repo, ghJson });
  const analysis = analyzeDependabotPulls(pullRequests);
  return {
    schemaVersion: 1,
    generatedAt: options.now || new Date().toISOString(),
    repo,
    dryRun: options.dryRun !== false,
    status: 'planned',
    pullRequests,
    analysis,
  };
}

function printHuman(result) {
  console.log('\nDependabot Consolidate');
  console.log('======================\n');
  console.log(`Repo: ${result.repo}`);
  console.log(`Recommendation: ${result.analysis.recommendation}`);
  if (result.analysis.conflictingFiles?.length) {
    console.log(`Conflicting files: ${result.analysis.conflictingFiles.join(', ')}`);
  }
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const result = runDependabotConsolidate({
    repo: args.repo,
    dryRun: args.dryRun,
  });
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else printHuman(result);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`dependabot-consolidate: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  analyzeDependabotPulls,
  parseArgs,
  runDependabotConsolidate,
};
