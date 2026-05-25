#!/usr/bin/env node
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function parseArgs(argv) {
  const args = { pr: null, repo: process.env.GITHUB_REPOSITORY || null, json: false, output: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--pr') args.pr = Number(argv[++index]);
    else if (arg.startsWith('--pr=')) args.pr = Number(arg.slice('--pr='.length));
    else if (arg === '--repo') args.repo = argv[++index];
    else if (arg.startsWith('--repo=')) args.repo = arg.slice('--repo='.length);
    else if (arg === '--json') args.json = true;
    else if (arg === '--output') args.output = argv[++index];
    else if (arg.startsWith('--output=')) args.output = arg.slice('--output='.length);
  }
  return args;
}

function runGhText(args) {
  return childProcess.execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
}

function runGhJson(args) {
  const raw = runGhText(args);
  return raw.trim() ? JSON.parse(raw) : null;
}

function runGitHubApi(apiPath) {
  const script = `
const https = require('node:https');
const token = process.env.GITHUB_TOKEN;
const req = https.request({
  hostname: 'api.github.com',
  path: ${JSON.stringify(apiPath)},
  method: 'GET',
  headers: {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'quality-gate-pr-snapshot/1.0',
    ...(token ? { Authorization: \`Bearer \${token}\` } : {}),
  },
}, (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    if (res.statusCode >= 400) {
      console.error(\`GitHub API \${res.statusCode}: \${data}\`);
      process.exit(1);
    }
    process.stdout.write(data || 'null');
  });
});
req.on('error', (error) => {
  console.error(error.message);
  process.exit(1);
});
req.end();
`;
  const raw = childProcess.execFileSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  return raw.trim() ? JSON.parse(raw) : null;
}

function normalizeValue(value) {
  return String(value || '').toLowerCase();
}

function checkKey(name) {
  const normalized = normalizeValue(name);
  if (normalized.includes('security') || normalized.includes('audit')) return 'security';
  if (normalized.includes('lint')) return 'lint';
  if (normalized.includes('ratchet') || normalized.includes('test')) return 'test';
  if (normalized.includes('sonar')) return 'sonar';
  if (normalized.includes('docker')) return 'docker';
  if (normalized.includes('report')) return 'report';
  return normalized.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
}

function normalizeChecks(checks = []) {
  const jobs = {};
  let hasFailure = false;
  let hasPending = false;

  for (const check of checks) {
    const status = normalizeValue(check.status);
    const conclusion = normalizeValue(check.conclusion);
    const key = checkKey(check.name);
    const normalized = {
      name: check.name,
      status,
      conclusion: conclusion || null,
      detailsUrl: check.detailsUrl || null,
      startedAt: check.startedAt || null,
      completedAt: check.completedAt || null,
    };
    jobs[key] = normalized;
    if (['failure', 'cancelled', 'timed_out', 'action_required'].includes(conclusion)) hasFailure = true;
    if (!conclusion || ['pending', 'queued', 'in_progress', 'requested'].includes(status)) hasPending = true;
  }

  const overall = hasFailure ? 'failure' : hasPending ? 'pending' : checks.length ? 'success' : 'unknown';
  return { overall, jobs };
}

function isFailed(job) {
  return ['failure', 'cancelled', 'timed_out', 'action_required'].includes(job?.conclusion);
}

function deriveActions(snapshot) {
  const actions = [];
  const jobs = snapshot.ci?.jobs || {};
  const add = (action) => {
    if (!actions.includes(action)) actions.push(action);
  };

  if (snapshot.pr?.mergeable === 'CONFLICTING') add('escalate');
  if (isFailed(jobs.security)) add('fix_security');
  if (isFailed(jobs.lint)) add('fix_lint');
  if (isFailed(jobs.test)) add('fix_ratchet');
  if (isFailed(jobs.sonar)) add('diagnose_sonar');
  if (isFailed(jobs.docker)) add('diagnose_docker');
  if (Object.values(jobs).some((job) => !job.conclusion || ['queued', 'in_progress', 'pending'].includes(job.status))) {
    add('wait_ci');
  }
  if (!Object.keys(jobs).length && ['queued', 'in_progress', 'pending'].includes(snapshot.latestRun?.status)) {
    add('wait_ci');
  }
  if ((snapshot.copilotBlockers || []).length > 0) add('process_copilot');
  if ((snapshot.humanBlockers || []).length > 0) add('process_human');
  if (actions.length === 0 && snapshot.ci?.overall === 'success') add('ready');
  if (actions.length === 0) add('diagnose_ci');
  return actions;
}

function formatInlineComment(comment) {
  const location = [comment.path, comment.line || comment.original_line].filter(Boolean).join(':');
  return `${location}${location ? ' - ' : ''}${String(comment.body || '').split(/\r?\n/)[0]}`;
}

function isCopilotReviewer(login) {
  return /^(copilot|copilot\[bot\]|copilot-pull-request-reviewer\[bot\])$/i.test(String(login || ''));
}

function isBlockingComment(body) {
  return /bloqueador|blocker|changes?\s+required|required\s+changes?/i.test(String(body || ''));
}

function collectCopilotBlockers(inlineComments) {
  return (inlineComments || [])
    .filter((comment) => isCopilotReviewer(comment?.user?.login))
    .filter((comment) => isBlockingComment(comment.body))
    .map(formatInlineComment);
}

function collectHumanBlockers(reviews) {
  return (reviews || [])
    .filter((review) => review?.state === 'CHANGES_REQUESTED')
    .map((review) => `${review.user?.login || 'reviewer'} - ${String(review.body || 'requested changes').split(/\r?\n/)[0]}`);
}

function mapPullApi(pr) {
  return {
    number: pr.number,
    title: pr.title,
    state: String(pr.state || '').toUpperCase(),
    mergeable: pr.mergeable === true ? 'MERGEABLE' : pr.mergeable === false ? 'CONFLICTING' : 'UNKNOWN',
    mergeStateStatus: String(pr.mergeable_state || 'UNKNOWN').toUpperCase(),
    headRefName: pr.head?.ref,
    headSha: pr.head?.sha,
    baseRefName: pr.base?.ref,
    url: pr.html_url,
    isDraft: Boolean(pr.draft),
  };
}

function mapCheckRunsApi(result) {
  return (result?.check_runs || []).map((check) => ({
    name: check.name,
    status: check.status,
    conclusion: check.conclusion,
    detailsUrl: check.html_url,
    startedAt: check.started_at,
    completedAt: check.completed_at,
  }));
}

function mapRunsApi(result, branch) {
  return (result?.workflow_runs || []).map((run) => ({
    databaseId: run.id,
    status: run.status,
    conclusion: run.conclusion,
    workflowName: run.name,
    displayTitle: run.display_title,
    headBranch: run.head_branch || branch,
  }));
}

function queryGhOrApi({ ghJson, githubApi, args, fallback }) {
  try {
    return ghJson(args);
  } catch (error) {
    if (!fallback) throw error;
    return fallback(githubApi);
  }
}

function buildSnapshot(options) {
  const prNumber = Number(options.pr);
  if (!Number.isInteger(prNumber) || prNumber < 1) throw new Error('--pr precisa ser numero positivo');
  const ghJson = options.ghJson || runGhJson;
  const repo = options.repo || process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error('--repo ou GITHUB_REPOSITORY requerido');
  const githubApi = options.githubApi || runGitHubApi;

  const pr = queryGhOrApi({
    ghJson,
    githubApi,
    args: ['pr', 'view', String(prNumber), '--json', 'number,title,state,mergeable,mergeStateStatus,headRefName,headRefOid,baseRefName,url,isDraft'],
    fallback: (api) => mapPullApi(api(`/repos/${repo}/pulls/${prNumber}`)),
  });
  const headSha = pr.headRefOid || pr.headSha || null;
  const checks = queryGhOrApi({
    ghJson,
    githubApi,
    args: ['pr', 'checks', String(prNumber), '--json', 'name,status,conclusion,detailsUrl,startedAt,completedAt'],
    fallback: (api) => (headSha ? mapCheckRunsApi(api(`/repos/${repo}/commits/${headSha}/check-runs`)) : []),
  });
  const inlineComments = queryGhOrApi({
    ghJson,
    githubApi,
    args: ['api', `repos/${repo}/pulls/${prNumber}/comments`],
    fallback: (api) => api(`/repos/${repo}/pulls/${prNumber}/comments`),
  }) || [];
  const reviews = queryGhOrApi({
    ghJson,
    githubApi,
    args: ['api', `repos/${repo}/pulls/${prNumber}/reviews`],
    fallback: (api) => api(`/repos/${repo}/pulls/${prNumber}/reviews`),
  }) || [];
  const runList = queryGhOrApi({
    ghJson,
    githubApi,
    args: ['run', 'list', '--branch', pr.headRefName, '--limit', '1', '--json', 'databaseId,status,conclusion,workflowName,displayTitle,headBranch'],
    fallback: (api) => mapRunsApi(api(`/repos/${repo}/actions/runs?branch=${encodeURIComponent(pr.headRefName)}&per_page=1`), pr.headRefName),
  }) || [];
  const latestRun = runList[0]
    ? {
      id: runList[0].databaseId,
      status: normalizeValue(runList[0].status),
      conclusion: normalizeValue(runList[0].conclusion),
      workflowName: runList[0].workflowName || null,
      displayTitle: runList[0].displayTitle || null,
      headBranch: runList[0].headBranch || pr.headRefName,
    }
    : null;
  let artifacts = [];
  if (latestRun?.id) {
    const artifactsResult = queryGhOrApi({
      ghJson,
      githubApi,
      args: ['run', 'view', String(latestRun.id), '--json', 'artifacts'],
      fallback: (api) => api(`/repos/${repo}/actions/runs/${latestRun.id}/artifacts`),
    });
    artifacts = artifactsResult?.artifacts || [];
  }

  const snapshot = {
    schemaVersion: 1,
    generatedAt: options.now || new Date().toISOString(),
    repo,
    pr: {
      number: pr.number,
      title: pr.title,
      state: pr.state,
      mergeable: pr.mergeable,
      mergeStateStatus: pr.mergeStateStatus,
      headRefName: pr.headRefName,
      headSha,
      baseRefName: pr.baseRefName,
      url: pr.url,
      isDraft: Boolean(pr.isDraft),
    },
    ci: normalizeChecks(checks || []),
    copilotBlockers: collectCopilotBlockers(inlineComments),
    humanBlockers: collectHumanBlockers(reviews),
    latestRun,
    artifacts,
  };
  snapshot.actions = deriveActions(snapshot);
  return snapshot;
}

function writeOutput(outputPath, data) {
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(data, null, 2)}\n`);
}

function printHuman(snapshot) {
  console.log('\n🔎 PR Snapshot');
  console.log('══════════════\n');
  console.log(` PR: #${snapshot.pr.number} ${snapshot.pr.title}`);
  console.log(` CI: ${snapshot.ci.overall}`);
  console.log(` Actions: ${snapshot.actions.join(', ')}`);
  if (snapshot.latestRun) console.log(` Run: ${snapshot.latestRun.id} (${snapshot.latestRun.conclusion || snapshot.latestRun.status})`);
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const snapshot = buildSnapshot({ pr: args.pr, repo: args.repo });
  if (args.output) writeOutput(args.output, snapshot);
  if (args.json) console.log(JSON.stringify(snapshot, null, 2));
  else printHuman(snapshot);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`❌ pr-snapshot: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  buildSnapshot,
  deriveActions,
  normalizeChecks,
  parseArgs,
};
