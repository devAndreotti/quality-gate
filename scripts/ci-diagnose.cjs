#!/usr/bin/env node
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function parseArgs(argv) {
  const args = {
    run: null,
    repo: process.env.GITHUB_REPOSITORY || null,
    json: false,
    snapshot: null,
    output: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--run') args.run = Number(argv[++index]);
    else if (arg.startsWith('--run=')) args.run = Number(arg.slice('--run='.length));
    else if (arg === '--repo') args.repo = argv[++index];
    else if (arg.startsWith('--repo=')) args.repo = arg.slice('--repo='.length);
    else if (arg === '--json') args.json = true;
    else if (arg === '--snapshot') args.snapshot = argv[++index];
    else if (arg.startsWith('--snapshot=')) args.snapshot = arg.slice('--snapshot='.length);
    else if (arg === '--output') args.output = argv[++index];
    else if (arg.startsWith('--output=')) args.output = arg.slice('--output='.length);
  }
  return args;
}

function runGhText(args) {
  return childProcess.execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 30 * 1024 * 1024 });
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
    'User-Agent': 'quality-gate-ci-diagnose/1.0',
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

function queryGhOrApi({ ghJson, githubApi, args, apiPath }) {
  try {
    return ghJson(args);
  } catch (error) {
    const fallback = githubApi(apiPath);
    if (fallback == null) {
      throw new Error(`gh query failed and API fallback returned no data: ${error.message}`);
    }
    return fallback;
  }
}

function textIncludes(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function classifyFailure({ name = '', log = '' }) {
  const source = `${name}\n${log}`;

  if (textIncludes(source, [/ECONNRESET/i, /ETIMEDOUT/i, /timed out/i, /runner.*lost/i, /network/i, /502 Bad Gateway/i])) {
    return {
      category: 'infra',
      action: 'rerun_flaky',
      confidence: 'medium',
      reason: 'log indicates transient infra, network, or runner failure',
    };
  }
  if (textIncludes(source, [/eslint/i, /no-unused-vars/i, /no-explicit-any/i, /exhaustive-deps/i])) {
    return {
      category: 'lint',
      action: 'fix_lint',
      confidence: 'high',
      reason: 'lint job or ESLint output failed',
    };
  }
  if (textIncludes(source, [/security audit/i, /npm audit/i, /critical severity/i, /vulnerabilit/i])) {
    return {
      category: 'security',
      action: 'fix_security',
      confidence: 'high',
      reason: 'npm audit or critical vulnerability detected',
    };
  }
  if (textIncludes(source, [/ratchet/i, /coverage.*regress/i, /Quality Gate.*Ratchet/i, /coverage-summary/i])) {
    return {
      category: 'ratchet',
      action: 'fix_ratchet',
      confidence: 'high',
      reason: 'coverage ratchet failed',
    };
  }
  if (textIncludes(source, [/sonar/i, /quality gate status:\s*failed/i, /QUALITY GATE/i])) {
    return {
      category: 'sonar',
      action: 'diagnose_sonar',
      confidence: 'high',
      reason: 'SonarCloud quality gate failed',
    };
  }
  if (textIncludes(source, [/docker image gate/i, /Docker Image Doctor/i, /hadolint/i, /grype/i, /syft/i])) {
    return {
      category: 'docker',
      action: 'diagnose_docker',
      confidence: 'high',
      reason: 'Docker image hardening gate failed',
    };
  }

  return {
    category: 'generic',
    action: 'diagnose_ci',
    confidence: 'low',
    reason: 'failed job did not match known signatures',
  };
}

function unique(values) {
  return [...new Set(values)];
}

function failedJobsFromSnapshot(snapshot) {
  return Object.values(snapshot?.ci?.jobs || {})
    .filter((job) => ['failure', 'cancelled', 'timed_out', 'action_required'].includes(job?.conclusion))
    .map((job) => ({
      id: job.id || null,
      name: job.name,
      conclusion: job.conclusion,
      status: job.status,
      html_url: job.detailsUrl || null,
      steps: [],
    }));
}

function diagnoseSnapshot({ snapshot, logs = {}, now }) {
  const failedJobs = failedJobsFromSnapshot(snapshot);
  const findings = failedJobs.map((job) => {
    const classified = classifyFailure({ name: job.name, log: logs[job.name] || '' });
    return {
      job: job.name,
      conclusion: job.conclusion,
      ...classified,
      url: job.html_url || null,
    };
  });

  for (const blocker of snapshot?.copilotBlockers || []) {
    findings.push({
      job: null,
      category: 'copilot',
      action: 'process_copilot',
      confidence: 'high',
      reason: blocker,
      url: null,
    });
  }
  for (const blocker of snapshot?.humanBlockers || []) {
    findings.push({
      job: null,
      category: 'human_review',
      action: 'process_human',
      confidence: 'high',
      reason: blocker,
      url: null,
    });
  }

  const actions = unique([...(snapshot.actions || []), ...findings.map((finding) => finding.action)])
    .filter((action) => action !== 'ready' && action !== 'wait_ci');

  return {
    schemaVersion: 1,
    generatedAt: now || new Date().toISOString(),
    run: { id: snapshot?.latestRun?.id || null },
    pr: snapshot?.pr || null,
    source: 'snapshot',
    summary: {
      failedJobs: failedJobs.length,
      findings: findings.length,
      actions: actions.length,
    },
    findings,
    actions,
  };
}

function diagnoseRun(options) {
  if (options.snapshot) {
    return diagnoseSnapshot({
      snapshot: typeof options.snapshot === 'string'
        ? JSON.parse(fs.readFileSync(options.snapshot, 'utf8'))
        : options.snapshot,
      logs: options.logs || {},
      now: options.now,
    });
  }

  const runId = Number(options.run);
  if (!Number.isInteger(runId) || runId < 1) throw new Error('--run precisa ser numero positivo');
  const repo = options.repo || process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error('--repo ou GITHUB_REPOSITORY requerido');
  const ghJson = options.ghJson || runGhJson;
  const ghText = options.ghText || runGhText;
  const githubApi = options.githubApi || runGitHubApi;

  const jobsResult = queryGhOrApi({
    ghJson,
    githubApi,
    args: ['api', `repos/${repo}/actions/runs/${runId}/jobs`],
    apiPath: `/repos/${repo}/actions/runs/${runId}/jobs`,
  }) || {};
  const jobs = jobsResult.jobs || [];
  const failedJobs = jobs.filter((job) => ['failure', 'cancelled', 'timed_out', 'action_required'].includes(job.conclusion));
  const findings = failedJobs.map((job) => {
    let log = '';
    try {
      log = ghText(['run', 'view', String(runId), '--job', String(job.id), '--log']);
    } catch (error) {
      log = `log unavailable: ${error.message}`;
    }
    const classified = classifyFailure({ name: job.name, log });
    return {
      job: job.name,
      jobId: job.id,
      conclusion: job.conclusion,
      failedSteps: (job.steps || []).filter((step) => step.conclusion === 'failure').map((step) => step.name),
      ...classified,
      url: job.html_url || null,
    };
  });
  const actions = unique(findings.map((finding) => finding.action));

  return {
    schemaVersion: 1,
    generatedAt: options.now || new Date().toISOString(),
    repo,
    run: { id: runId },
    source: 'github',
    summary: {
      totalJobs: jobs.length,
      failedJobs: failedJobs.length,
      findings: findings.length,
      actions: actions.length,
    },
    findings,
    actions,
  };
}

function writeOutput(outputPath, data) {
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(data, null, 2)}\n`);
}

function printHuman(result) {
  console.log('\n🧪 CI Diagnose');
  console.log('══════════════\n');
  console.log(` Run: ${result.run.id || 'snapshot'}`);
  console.log(` Failed jobs: ${result.summary.failedJobs}`);
  console.log(` Actions: ${result.actions.join(', ') || 'none'}`);
  for (const finding of result.findings) {
    console.log(` ${finding.action}: ${finding.job || finding.category} - ${finding.reason}`);
  }
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const result = diagnoseRun({
    run: args.run,
    repo: args.repo,
    snapshot: args.snapshot || null,
  });
  if (args.output) writeOutput(args.output, result);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else printHuman(result);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`❌ ci-diagnose: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  classifyFailure,
  diagnoseRun,
  parseArgs,
};
