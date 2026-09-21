const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { displayWidth, padEnd, renderTable, renderHeaderBox, renderSection } = require("./lib/console-ui.cjs");
const { repoFromRemoteUrl, splitRepo, resolveRepo, detectRepoFromGit } = require("./lib/github.cjs");
const { validatePolicy, policyHash, loadPolicy, buildState, writeState, hasPolicyFiles } = require("./lib/policy.cjs");

test("console-ui measures display width and pads strings correctly", () => {
  assert.equal(displayWidth("hello"), 5);
  assert.equal(displayWidth("🚀"), 2);
  assert.equal(displayWidth(""), 0);

  assert.equal(padEnd("abc", 5), "abc  ");
  assert.equal(padEnd("abcdef", 4), "abcdef");

  const table = renderTable(["A", "B"], [["1", "2"]]);
  assert.match(table, /┌───┬───┐/);
  assert.match(table, /│ A │ B │/);
  assert.match(table, /│ 1 │ 2 │/);

  const header = renderHeaderBox("Quality Gate", { width: 40 });
  assert.match(header, /Quality Gate/);

  const section = renderSection("Checks");
  assert.match(section, /CHECKS/);
});

test("github lib parses remote URLs and splits repo correctly", () => {
  assert.equal(repoFromRemoteUrl("git@github.com:owner/repo.git"), "owner/repo");
  assert.equal(repoFromRemoteUrl("https://github.com/owner/my-app"), "owner/my-app");
  assert.equal(repoFromRemoteUrl("https://gitlab.com/owner/repo"), null);
  assert.equal(repoFromRemoteUrl(""), null);

  assert.deepEqual(splitRepo("org/repo-name"), { owner: "org", name: "repo-name" });
  assert.throws(() => splitRepo("invalid-format"), new RegExp("--repo precisa estar no formato owner/repo"));

  const mockExec = () => "git@github.com:test-org/test-repo.git\n";
  assert.equal(detectRepoFromGit(process.cwd(), mockExec), "test-org/test-repo");

  const failExec = () => { throw new Error("git error"); };
  assert.equal(detectRepoFromGit(process.cwd(), failExec), null);

  assert.equal(resolveRepo({ repo: "my-owner/my-repo" }), "my-owner/my-repo");

  // GITHUB_REPOSITORY pode estar definida no ambiente (ex: GitHub Actions);
  // remove para validar o caminho de erro quando não há repo nem git.
  const savedGithubRepository = process.env.GITHUB_REPOSITORY;
  delete process.env.GITHUB_REPOSITORY;
  try {
    assert.throws(() => resolveRepo({ repo: null, cwd: "/non-existent", execFileSync: failExec }), /--repo ou GITHUB_REPOSITORY requerido/);
  } finally {
    if (savedGithubRepository !== undefined) process.env.GITHUB_REPOSITORY = savedGithubRepository;
  }
});

test("policy lib validates policies, catches schema errors and handles state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qg-policy-"));
  const validPolicy = {
    schemaVersion: 1,
    profile: "strict-node",
    project: { surfaces: [{ type: "node", root: ".", required: true }] },
    ci: { requiredChecks: ["Lint", "Tests"], advisoryChecks: ["SonarCloud"], coverageRatchet: true, maxFileLines: 300 },
    bootstrap: {
      license: { enabled: true, type: "MIT" },
      funding: { enabled: true, buyMeACoffee: "user" },
      dependabot: { enabled: true },
      readme: { enabled: true, style: "devandreotti" },
    },
    github: { copilotReview: true, branchProtection: true, requireConversationResolution: true },
    dockerImageDoctor: {
      enabled: "auto",
      runWhen: "docker-files-present",
      scriptPath: "C:\\dummy.ps1",
      agentArgs: ["-Json"],
      interactiveAllowed: false,
      blockOn: ["Critical"],
      warnOn: ["High"],
      fallbackWhenUnavailable: "static-advisory",
    },
    localValidation: {
      untrackedAllowlist: ["samples/**"],
      pytestBasetempPattern: ".pytest-tmp-qg",
    },
  };

  assert.deepEqual(validatePolicy(validPolicy), []);
  assert.equal(hasPolicyFiles(root), false);

  // Validação de erros
  const badPolicy = {
    schemaVersion: 2,
    profile: 123,
    project: { surfaces: "not-an-array" },
    ci: { requiredChecks: [], coverageRatchet: "yes", maxFileLines: -1 },
    bootstrap: {
      license: { enabled: "yes", type: "GPL" },
      funding: { enabled: "yes", buyMeACoffee: 123 },
      dependabot: { enabled: "yes" },
      readme: { enabled: "yes", style: "other" },
    },
    github: { copilotReview: "yes", branchProtection: 1, requireConversationResolution: null },
    dockerImageDoctor: {
      enabled: "invalid",
      runWhen: "never",
      scriptPath: null,
      agentArgs: [],
      interactiveAllowed: true,
      blockOn: null,
      warnOn: null,
      fallbackWhenUnavailable: "unknown",
    },
    localValidation: {
      untrackedAllowlist: ["", 123],
      pytestBasetempPattern: 123,
    },
  };

  const errs = validatePolicy(badPolicy);
  assert.ok(errs.length > 10);

  fs.mkdirSync(path.join(root, ".quality-gate"), { recursive: true });
  fs.writeFileSync(path.join(root, ".quality-gate/policy.json"), JSON.stringify(badPolicy));
  assert.throws(() => loadPolicy(root), /Policy invalida/);

  fs.writeFileSync(path.join(root, ".quality-gate/policy.json"), JSON.stringify(validPolicy));
  fs.writeFileSync(path.join(root, ".quality-gate/policy.schema.json"), "{}");
  assert.equal(hasPolicyFiles(root), true);
  assert.deepEqual(loadPolicy(root), validPolicy);

  const hash1 = policyHash(validPolicy);
  const state = buildState({
    root,
    policy: validPolicy,
    checks: [{ name: "check1", level: "ok" }],
    summary: { ok: 1, warnings: 0, failures: 0 },
  });
  const statePath = writeState(root, state);
  assert.ok(fs.existsSync(statePath));
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).policyHash, hash1);
});
