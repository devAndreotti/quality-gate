const childProcess = require('node:child_process');

function runGhText(args, options = {}) {
  const maxBuffer = options.maxBuffer || 30 * 1024 * 1024;
  return childProcess.execFileSync('gh', args, { encoding: 'utf8', maxBuffer }); // NOSONAR
}

function runGhJson(args, options = {}) {
  const raw = runGhText(args, options);
  return raw.trim() ? JSON.parse(raw) : null;
}

function runGitHubApi(apiPath, options = {}) {
  const tokenEnv = options.tokenEnv || 'GITHUB_TOKEN';
  const userAgent = options.userAgent || 'quality-gate/1.0';
  const script = `
const https = require('node:https');
const token = process.env[${JSON.stringify(tokenEnv)}];
const req = https.request({
  hostname: 'api.github.com',
  path: ${JSON.stringify(apiPath)},
  method: 'GET',
  headers: {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': ${JSON.stringify(userAgent)},
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
  const raw = childProcess.execFileSync(process.execPath, ['-e', script], { // NOSONAR
    encoding: 'utf8',
    maxBuffer: options.maxBuffer || 20 * 1024 * 1024,
  });
  return raw.trim() ? JSON.parse(raw) : null;
}

function splitRepo(repo) {
  const [owner, name] = String(repo || '').split('/');
  if (!owner || !name) throw new Error('--repo precisa estar no formato owner/repo');
  return { owner, name };
}

module.exports = {
  runGhJson,
  runGhText,
  runGitHubApi,
  splitRepo,
};
