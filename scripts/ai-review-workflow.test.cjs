// Invariantes de segurança do workflow ai-review.yml. Falham se alguém remover uma proteção.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKFLOW = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'ai-review.yml'), 'utf8');
const jobs = WORKFLOW.split(/^ {2}(?=[a-z-]+:\n)/m).slice(1);
const job = (name) => jobs.find((j) => j.startsWith(`${name}:`));

test('the workflow is manual only and never runs on pull_request', () => {
  const onBlock = WORKFLOW.slice(WORKFLOW.indexOf('\non:'), WORKFLOW.indexOf('\nconcurrency:'));
  assert.match(onBlock, /workflow_dispatch:/);
  assert.doesNotMatch(onBlock, /pull_request/);
});

test('both jobs use the ai-review environment so secrets are gated by its rules', () => {
  assert.ok(job('review'), 'job review existe');
  assert.ok(job('review-post'), 'job review-post existe');
  for (const name of ['review', 'review-post']) {
    assert.match(job(name), /environment: ai-review/, `${name} usa o environment`);
  }
});

test('checkout always uses main and never the PR head', () => {
  for (const name of ['review', 'review-post']) {
    const body = job(name);
    assert.match(body, /ref: main/, `${name} faz checkout de main`);
    assert.doesNotMatch(body, /ref: \$\{\{/, `${name} não faz checkout de ref dinâmica`);
    assert.match(body, /persist-credentials: false/, `${name} não deixa credencial no disco`);
  }
});

test('the PR is fetched as data and the diff is computed with git, not by running its code', () => {
  assert.match(WORKFLOW, /pull\/\$\{PR\}\/head:refs\/qg\/pr-\$\{PR\}/);
  assert.match(WORKFLOW, /--head "refs\/qg\/pr-\$\{PR\}"/);
});

test('the ai-review label is required before any provider call', () => {
  for (const name of ['review', 'review-post']) {
    const body = job(name);
    const label = body.indexOf('Exigir rótulo ai-review');
    const run = body.indexOf('scripts/pr-ai-review.cjs');
    assert.ok(label > 0 && run > label, `${name}: rótulo é checado antes de rodar o script`);
  }
});

test('the review job cannot write to the PR', () => {
  assert.match(job('review'), /pull-requests: read/);
  assert.doesNotMatch(job('review'), /pull-requests: write/);
});
