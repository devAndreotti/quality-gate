const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildSnapshot,
  deriveActions,
  normalizeChecks,
  parseArgs,
} = require('./pr-snapshot.cjs');

test('parseArgs supports pr, repo, json, and output', () => {
  const args = parseArgs(['--pr', '42', '--repo', 'owner/repo', '--json', '--output', 'snapshot.json']);

  assert.equal(args.pr, 42);
  assert.equal(args.repo, 'owner/repo');
  assert.equal(args.json, true);
  assert.equal(args.output, 'snapshot.json');
});

test('normalizeChecks summarizes check state and keeps job details', () => {
  const normalized = normalizeChecks([
    { name: 'Lint', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://ci/lint' },
    { name: 'Tests & ratchet', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { name: 'SonarCloud', status: 'IN_PROGRESS', conclusion: null },
  ]);

  assert.equal(normalized.overall, 'failure');
  assert.equal(normalized.jobs.lint.conclusion, 'failure');
  assert.equal(normalized.jobs.test.conclusion, 'success');
  assert.equal(normalized.jobs.sonar.status, 'in_progress');
});

test('deriveActions maps failed checks and blockers to deterministic actions', () => {
  const actions = deriveActions({
    pr: { mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED' },
    ci: {
      overall: 'failure',
      jobs: {
        security: { conclusion: 'success' },
        lint: { conclusion: 'failure' },
        test: { conclusion: 'failure' },
        sonar: { conclusion: 'failure' },
        docker: { conclusion: 'failure' },
      },
    },
    copilotBlockers: ['src/auth.ts:42 - Bloqueador: tratar erro'],
    humanBlockers: ['reviewer pediu mudança'],
  });

  assert.deepEqual(actions, [
    'fix_lint',
    'fix_ratchet',
    'diagnose_sonar',
    'diagnose_docker',
    'process_copilot',
    'process_human',
  ]);
});

test('deriveActions waits when latest workflow run is still pending without check details', () => {
  const actions = deriveActions({
    pr: { mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED' },
    ci: {
      overall: 'unknown',
      jobs: {},
    },
    latestRun: {
      status: 'pending',
      conclusion: '',
    },
    copilotBlockers: [],
    humanBlockers: [],
  });

  assert.deepEqual(actions, ['wait_ci']);
});

test('buildSnapshot collects PR metadata, checks, comments, blockers, and latest run', () => {
  const calls = [];
  const ghJson = (args) => {
    calls.push(args.join(' '));
    const key = args.join(' ');
    if (key.startsWith('pr view 42 --json number,title,state,mergeable,mergeStateStatus')) {
      return {
        number: 42,
        title: 'Add auth',
        state: 'OPEN',
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'BLOCKED',
        headRefName: 'feature/auth',
        baseRefName: 'main',
        url: 'https://github.com/owner/repo/pull/42',
        isDraft: false,
      };
    }
    if (key === 'pr checks 42 --json name,status,conclusion,detailsUrl,startedAt,completedAt') {
      return [
        { name: 'Lint', status: 'COMPLETED', conclusion: 'FAILURE' },
        { name: 'Tests & ratchet', status: 'COMPLETED', conclusion: 'SUCCESS' },
      ];
    }
    if (key === 'api repos/owner/repo/pulls/42/comments') {
      return [
        {
          user: { login: 'Copilot' },
          path: 'src/auth.ts',
          line: 42,
          body: 'Bloqueador: falta tratar erro',
        },
      ];
    }
    if (key === 'api repos/owner/repo/pulls/42/reviews') {
      return [
        {
          user: { login: 'human' },
          state: 'CHANGES_REQUESTED',
          body: 'Ajuste contrato público',
        },
      ];
    }
    if (key.startsWith('api graphql ')) {
      return { repository: { pullRequest: { reviewThreads: { nodes: [] } } } };
    }
    if (key === 'run list --branch feature/auth --limit 1 --json databaseId,status,conclusion,workflowName,displayTitle,headBranch') {
      return [{ databaseId: 123, status: 'completed', conclusion: 'failure', workflowName: 'Quality Gate' }];
    }
    if (key === 'run view 123 --json artifacts') {
      return { artifacts: [{ name: 'coverage-report', sizeInBytes: 1000 }] };
    }
    throw new Error(`unexpected gh call: ${key}`);
  };

  const snapshot = buildSnapshot({
    pr: 42,
    repo: 'owner/repo',
    ghJson,
    now: '2026-05-24T00:00:00.000Z',
  });

  assert.equal(snapshot.pr.number, 42);
  assert.equal(snapshot.ci.overall, 'failure');
  assert.equal(snapshot.copilotBlockers.length, 1);
  assert.equal(snapshot.humanBlockers.length, 1);
  assert.deepEqual(snapshot.actions, ['fix_required_check', 'process_copilot', 'process_human', 'blocked_by_policy']);
  assert.equal(snapshot.latestRun.id, 123);
  assert.equal(snapshot.artifacts[0].name, 'coverage-report');
  assert.ok(calls.length >= 5);
});

test('buildSnapshot does not treat Copilot advisory comments as blockers', () => {
  const ghJson = (args) => {
    const key = args.join(' ');
    if (key.startsWith('pr view 42 --json number,title,state,mergeable,mergeStateStatus')) {
      return {
        number: 42,
        title: 'Setup gate',
        state: 'OPEN',
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        headRefName: 'codex/qg-setup',
        baseRefName: 'main',
        url: 'https://github.com/owner/repo/pull/42',
        isDraft: false,
      };
    }
    if (key === 'pr checks 42 --json name,status,conclusion,detailsUrl,startedAt,completedAt') {
      return [{ name: 'Lint', status: 'completed', conclusion: 'success' }];
    }
    if (key === 'api repos/owner/repo/pulls/42/comments') {
      return [
        {
          user: { login: 'Copilot' },
          path: 'scripts/doctor.test.cjs',
          line: 30,
          body: 'Sugestão: validar policy.ci.requiredChecks contra os job names.',
        },
      ];
    }
    if (key === 'api repos/owner/repo/pulls/42/reviews') return [];
    if (key.startsWith('api graphql ')) {
      return {
        repository: {
          pullRequest: {
            reviewThreads: { nodes: [] },
          },
        },
      };
    }
    if (key === 'run list --branch codex/qg-setup --limit 1 --json databaseId,status,conclusion,workflowName,displayTitle,headBranch') {
      return [{ databaseId: 456, status: 'completed', conclusion: 'success', workflowName: 'Quality Gate' }];
    }
    if (key === 'run view 456 --json artifacts') return { artifacts: [] };
    throw new Error(`unexpected gh call: ${key}`);
  };

  const snapshot = buildSnapshot({
    pr: 42,
    repo: 'owner/repo',
    ghJson,
  });

  assert.deepEqual(snapshot.copilotBlockers, []);
  assert.deepEqual(snapshot.actions, ['ready']);
});

test('buildSnapshot does not mark blocked merge state as ready without failed checks', () => {
  const ghJson = (args) => {
    const key = args.join(' ');
    if (key.startsWith('pr view 42 --json number,title,state,mergeable,mergeStateStatus')) {
      return {
        number: 42,
        title: 'Queue front',
        state: 'OPEN',
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'BLOCKED',
        headRefName: 'codex/slice-9',
        headRefOid: 'abc123',
        baseRefName: 'main',
        url: 'https://github.com/owner/repo/pull/42',
        isDraft: false,
      };
    }
    if (key === 'pr checks 42 --json name,status,conclusion,detailsUrl,startedAt,completedAt') {
      return [{ name: 'SonarCloud Code Analysis', status: 'COMPLETED', conclusion: 'SUCCESS' }];
    }
    if (key === 'api repos/owner/repo/pulls/42/comments') return [];
    if (key === 'api repos/owner/repo/pulls/42/reviews') return [];
    if (key.startsWith('api graphql ')) {
      return { repository: { pullRequest: { reviewThreads: { nodes: [] } } } };
    }
    if (key === 'run list --branch codex/slice-9 --limit 1 --json databaseId,status,conclusion,workflowName,displayTitle,headBranch') return [];
    throw new Error(`unexpected gh call: ${key}`);
  };

  const snapshot = buildSnapshot({ pr: 42, repo: 'owner/repo', ghJson });

  assert.equal(snapshot.merge.ready, false);
  assert.deepEqual(snapshot.actions, ['blocked_by_policy']);
  assert.match(snapshot.merge.blockers[0].message, /BLOCKED/);
});

test('buildSnapshot treats optional Sonar failure as advisory when required checks pass', () => {
  const ghJson = (args) => {
    const key = args.join(' ');
    if (key.startsWith('pr view 42 --json number,title,state,mergeable,mergeStateStatus')) {
      return {
        number: 42,
        title: 'Setup gate',
        state: 'OPEN',
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        headRefName: 'codex/qg',
        headRefOid: 'abc123',
        baseRefName: 'main',
        url: 'https://github.com/owner/repo/pull/42',
        isDraft: false,
      };
    }
    if (key === 'pr checks 42 --json name,status,conclusion,detailsUrl,startedAt,completedAt') {
      return [
        { name: 'Lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { name: 'Tests & ratchet', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { name: 'SonarCloud Code Analysis', status: 'COMPLETED', conclusion: 'FAILURE' },
      ];
    }
    if (key === 'api repos/owner/repo/pulls/42/comments') return [];
    if (key === 'api repos/owner/repo/pulls/42/reviews') return [];
    if (key.startsWith('api graphql ')) return { repository: { pullRequest: { reviewThreads: { nodes: [] } } } };
    if (key === 'run list --branch codex/qg --limit 1 --json databaseId,status,conclusion,workflowName,displayTitle,headBranch') return [];
    throw new Error(`unexpected gh call: ${key}`);
  };
  const githubApi = (apiPath) => {
    if (apiPath === '/repos/owner/repo/branches/main/protection/required_status_checks') {
      return { contexts: ['Lint', 'Tests & ratchet'], checks: [] };
    }
    throw new Error(`unexpected api path: ${apiPath}`);
  };

  const snapshot = buildSnapshot({ pr: 42, repo: 'owner/repo', ghJson, githubApi });

  assert.equal(snapshot.merge.ready, true);
  assert.equal(snapshot.merge.status, 'ready_with_advisory');
  assert.deepEqual(snapshot.actions, ['ready_with_advisory']);
  assert.equal(snapshot.checks.advisory[0].name, 'SonarCloud Code Analysis');
});

test('buildSnapshot blocks on unresolved review threads', () => {
  const ghJson = (args) => {
    const key = args.join(' ');
    if (key.startsWith('pr view 42 --json number,title,state,mergeable,mergeStateStatus')) {
      return {
        number: 42,
        title: 'Review thread',
        state: 'OPEN',
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        headRefName: 'feature/review',
        headRefOid: 'abc123',
        baseRefName: 'main',
        url: 'https://github.com/owner/repo/pull/42',
        isDraft: false,
      };
    }
    if (key === 'pr checks 42 --json name,status,conclusion,detailsUrl,startedAt,completedAt') {
      return [{ name: 'Lint', status: 'COMPLETED', conclusion: 'SUCCESS' }];
    }
    if (key === 'api repos/owner/repo/pulls/42/comments') return [];
    if (key === 'api repos/owner/repo/pulls/42/reviews') return [];
    if (key.startsWith('api graphql ')) {
      return {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [{
                isResolved: false,
                isOutdated: false,
                path: 'src/auth.ts',
                line: 42,
                comments: {
                  nodes: [{
                    bodyText: 'Tratar erro antes de seguir',
                    author: { login: 'reviewer' },
                  }],
                },
              }],
            },
          },
        },
      };
    }
    if (key === 'run list --branch feature/review --limit 1 --json databaseId,status,conclusion,workflowName,displayTitle,headBranch') return [];
    throw new Error(`unexpected gh call: ${key}`);
  };

  const snapshot = buildSnapshot({ pr: 42, repo: 'owner/repo', ghJson });

  assert.equal(snapshot.merge.ready, false);
  assert.deepEqual(snapshot.actions, ['resolve_review_threads']);
  assert.equal(snapshot.reviewThreads.unresolved.length, 1);
});

test('buildSnapshot asks manual verification when review thread GraphQL is unavailable', () => {
  const ghJson = (args) => {
    const key = args.join(' ');
    if (key.startsWith('pr view 42 --json number,title,state,mergeable,mergeStateStatus')) {
      return {
        number: 42,
        title: 'Unknown threads',
        state: 'OPEN',
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        headRefName: 'feature/unknown',
        headRefOid: 'abc123',
        baseRefName: 'main',
        url: 'https://github.com/owner/repo/pull/42',
        isDraft: false,
      };
    }
    if (key === 'pr checks 42 --json name,status,conclusion,detailsUrl,startedAt,completedAt') {
      return [{ name: 'Lint', status: 'COMPLETED', conclusion: 'SUCCESS' }];
    }
    if (key === 'api repos/owner/repo/pulls/42/comments') return [];
    if (key === 'api repos/owner/repo/pulls/42/reviews') return [];
    if (key.startsWith('api graphql ')) throw new Error('Resource not accessible by personal access token');
    if (key === 'run list --branch feature/unknown --limit 1 --json databaseId,status,conclusion,workflowName,displayTitle,headBranch') return [];
    throw new Error(`unexpected gh call: ${key}`);
  };

  const snapshot = buildSnapshot({ pr: 42, repo: 'owner/repo', ghJson });

  assert.equal(snapshot.merge.ready, false);
  assert.deepEqual(snapshot.actions, ['verify_review_threads_manual']);
  assert.equal(snapshot.reviewThreads.status, 'unknown');
});

test('buildSnapshot falls back to GitHub API when gh is unavailable', () => {
  const githubApi = (apiPath) => {
    if (apiPath === '/repos/owner/repo/pulls/42') {
      return {
        number: 42,
        title: 'Fallback PR',
        state: 'open',
        mergeable: true,
        mergeable_state: 'blocked',
        draft: false,
        html_url: 'https://github.com/owner/repo/pull/42',
        head: { ref: 'feature/fallback', sha: 'abc123' },
        base: { ref: 'main' },
      };
    }
    if (apiPath === '/repos/owner/repo/commits/abc123/check-runs') {
      return {
        check_runs: [
          { name: 'Lint', status: 'completed', conclusion: 'success', html_url: 'https://ci/lint' },
        ],
      };
    }
    if (apiPath === '/repos/owner/repo/pulls/42/comments') return [];
    if (apiPath === '/repos/owner/repo/pulls/42/reviews') return [];
    if (apiPath === '/repos/owner/repo/actions/runs?branch=feature%2Ffallback&per_page=1') {
      return {
        workflow_runs: [
          { id: 321, status: 'completed', conclusion: 'success', name: 'Quality Gate', display_title: 'Fallback' },
        ],
      };
    }
    if (apiPath === '/repos/owner/repo/actions/runs/321/artifacts') {
      return { artifacts: [] };
    }
    throw new Error(`unexpected api path: ${apiPath}`);
  };

  const snapshot = buildSnapshot({
    pr: 42,
    repo: 'owner/repo',
    ghJson: () => { throw new Error('gh unavailable'); },
    githubApi,
  });

  assert.equal(snapshot.pr.title, 'Fallback PR');
  assert.equal(snapshot.pr.mergeable, 'MERGEABLE');
  assert.equal(snapshot.ci.overall, 'success');
  assert.deepEqual(snapshot.actions, ['verify_review_threads_manual', 'blocked_by_policy']);
  assert.equal(snapshot.latestRun.id, 321);
});
