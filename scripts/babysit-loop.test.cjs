const assert = require("node:assert/strict");
const test = require("node:test");

const {
  decideLoopState,
  parseArgs,
  runBabysitCycle,
} = require("./babysit-loop.cjs");

test("parseArgs supports pr, max-cycles, json, and once", () => {
  const args = parseArgs(["--pr", "42", "--max-cycles", "3", "--json", "--once"]);
  assert.equal(args.pr, 42);
  assert.equal(args.maxCycles, 3);
  assert.equal(args.json, true);
  assert.equal(args.once, true);

  const argsEqual = parseArgs(["--pr=99", "--max-cycles=5", "--repo=owner/repo"]);
  assert.equal(argsEqual.pr, 99);
  assert.equal(argsEqual.maxCycles, 5);
  assert.equal(argsEqual.repo, "owner/repo");
});

test("decideLoopState returns terminal for closed or merged PRs", () => {
  assert.deepEqual(decideLoopState({ pr: { state: "MERGED" } }), { terminal: true, reason: "merged", next: "stop" });
  assert.deepEqual(decideLoopState({ pr: { state: "CLOSED" } }), { terminal: true, reason: "closed", next: "stop" });
});

test("decideLoopState returns terminal when PR is ready", () => {
  const state = decideLoopState({
    pr: { state: "OPEN" },
    merge: { ready: true, status: "ready", blockers: [], advisories: [] },
    ci: { overall: "success" },
    actions: ["ready"],
  });
  assert.equal(state.terminal, true);
  assert.equal(state.reason, "ready");
});

test("decideLoopState does not return ready when merge contract is blocked", () => {
  const state = decideLoopState({
    pr: { state: "OPEN" },
    merge: {
      ready: false,
      status: "blocked",
      blockers: [{ type: "blocked_by_policy", action: "blocked_by_policy", message: "GitHub mergeStateStatus=BLOCKED" }],
      advisories: [],
    },
    ci: { overall: "success" },
    actions: ["ready"],
  });

  assert.equal(state.terminal, false);
  assert.equal(state.reason, "blocked_by_policy");
  assert.equal(state.next, "fix");
});

test("decideLoopState handles escalation blockers", () => {
  const state = decideLoopState({
    pr: { state: "OPEN" },
    merge: {
      ready: false,
      status: "blocked",
      blockers: [{ type: "review_threads_unknown", action: "escalate_manual", message: "GraphQL error" }],
      advisories: [],
    },
  });
  assert.equal(state.terminal, false);
  assert.equal(state.reason, "review_threads_unknown");
  assert.equal(state.next, "escalate");
});

test("decideLoopState blocks on unresolved review threads", () => {
  const state = decideLoopState({
    pr: { state: "OPEN" },
    merge: {
      ready: false,
      status: "blocked",
      blockers: [{ type: "unresolved_review_threads", action: "resolve_review_threads", message: "1 thread unresolved" }],
      advisories: [],
    },
    ci: { overall: "success" },
    actions: ["resolve_review_threads"],
  });

  assert.equal(state.terminal, false);
  assert.equal(state.reason, "unresolved_review_threads");
});

test("decideLoopState waits on required checks pending", () => {
  const state = decideLoopState({
    pr: { state: "OPEN" },
    merge: {
      ready: false,
      status: "blocked",
      blockers: [{ type: "required_check_pending", action: "wait_ci", message: "Lint pending" }],
      advisories: [],
    },
    ci: { overall: "pending" },
    actions: ["wait_ci"],
  });

  assert.equal(state.terminal, false);
  assert.equal(state.reason, "required_checks_pending");
  assert.equal(state.next, "wait");
});

test("decideLoopState reports advisory-ready as terminal advisory", () => {
  const state = decideLoopState({
    pr: { state: "OPEN" },
    merge: {
      ready: true,
      status: "ready_with_advisory",
      blockers: [],
      advisories: [{ type: "advisory_check_failed", action: "diagnose_optional_check" }],
    },
    ci: { overall: "failure" },
    actions: ["ready_with_advisory"],
  });

  assert.equal(state.terminal, true);
  assert.equal(state.reason, "ready_with_advisory");
  assert.equal(state.next, "stop");
});

test("decideLoopState asks wait when CI is pending", () => {
  const state = decideLoopState({ pr: { state: "OPEN" }, ci: { overall: "pending" }, actions: ["wait_ci"] });
  assert.equal(state.terminal, false);
  assert.equal(state.next, "wait");
});

test("decideLoopState handles fallback without merge contract", () => {
  assert.deepEqual(decideLoopState({ pr: { state: "OPEN" }, actions: ["ready"] }), { terminal: true, reason: "ready", next: "stop" });
  assert.deepEqual(decideLoopState({ pr: { state: "OPEN" }, actions: ["escalate"] }), { terminal: true, reason: "escalate", next: "escalate" });
  assert.deepEqual(decideLoopState({ pr: { state: "OPEN" }, actions: ["fix_something"] }), { terminal: false, reason: "actions required", next: "fix" });
});

test("runBabysitCycle combines snapshot and diagnosis without fixing code", () => {
  const result = runBabysitCycle({
    pr: 42,
    snapshotProvider: () => ({
      pr: { number: 42, state: "OPEN" },
      latestRun: { id: 123 },
      ci: { overall: "failure", jobs: { lint: { name: "Lint", conclusion: "failure" } } },
      actions: ["fix_lint"],
      copilotBlockers: [],
      humanBlockers: [],
    }),
    diagnoseProvider: () => ({ actions: ["fix_lint"], findings: [{ action: "fix_lint" }] }),
  });

  assert.equal(result.pr, 42);
  assert.deepEqual(result.actions, ["fix_lint"]);
  assert.equal(result.loop.next, "fix");
});
