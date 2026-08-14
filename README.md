# Quality Gate — Setup & Usage

Stack: GitHub Actions + SonarCloud + Docker Image Doctor + Copilot Review + Codex babysit-pr

Current Version: `1.0.0`

---

## File Structure & Descriptions

```
your-project/                        ← Root of YOUR repository
├── VERSION                          ← Quality Gate package version
├── CHANGELOG.md                     ← Release history
├── .quality-gate/
│   ├── policy.json                  ← Quality gate contract configuration
│   └── policy.schema.json           ← Documented schema of the policy
├── .github/
│   ├── copilot-instructions.md      ← Rules followed by Copilot Review
│   ├── dependabot.yml               ← Weekly updates for Actions/dependencies
│   ├── FUNDING.yml                  ← Buy Me a Coffee / GitHub Sponsors
│   └── workflows/quality-gate.yml   ← CI: 6 parallel jobs
├── scripts/
│   ├── baseline.json                ← Ratchet baseline (committed)
│   ├── babysit-loop.cjs             ← Snapshot + diagnose deterministic cycle
│   ├── bootstrap-repo.cjs           ← LICENSE/FUNDING/Dependabot/README scaffold
│   ├── ci-diagnose.cjs              ← Deterministic CI failure classifier
│   ├── configure-project.cjs        ← Stack adapter: node or python-uv
│   ├── dependabot-consolidate.cjs    ← Dependabot PR consolidation planner
│   ├── doctor.cjs                   ← Read-only package auditor
│   ├── docker-gate.cjs              ← Docker gate + static fallback advisory
│   ├── local-validate.cjs            ← One-command local PR validation
│   ├── lib/                         ← Shared validation libraries
│   ├── pr-snapshot.cjs              ← PR snapshot JSON generator for babysit-pr
│   ├── quality-gate.js              ← Ratchet: check | update | report
│   ├── pr-comment.js                ← Automatic sticky comment on PR
│   └── setup.js                     ← Setup automation via GitHub API
├── LICENSE                          ← Standard MIT license
├── sonar-project.properties         ← SonarCloud configuration
└── .codex/skills/babysit-pr/        ← Codex agent skill
    ├── SKILL.md
    └── references/
        ├── pr-watcher.md            ← gh commands for the loop
        └── fix-playbook.md          ← Fix playbooks and recipes
```

The evolution plan to reduce AI usage is documented in [`IMPLEMENTATION.md`](./IMPLEMENTATION.md).

---

## Setup in 3 Steps

### PowerShell Alias Flow

When the Scriply profile is installed, use the aliases from any repository:

```powershell
qg
qg-init -DryRun -Repo OWNER/REPO
qg-init -Yes -Repo OWNER/REPO -SkipBaseline -SkipCommit
qg-doc
qg-chk
qg-upd
qg-rpt
qg-dash
```

`qg` with no flags is the primary local entry point: it opens an interactive menu (state summary + install/repair, doctor, local PR validation, update baseline, GitHub setup, PR snapshot, babysit PR once, show report, live dashboard). All the `qg-*` aliases and explicit flags keep working exactly as before — the menu never intercepts them, it only appears when `qg` is called with nothing else to do.

`qg-dash` (`qg -Dashboard`) opens a live-refreshing status panel — repo/branch/remote, ratchet metrics, last saved PR snapshot — polling local `git`/filesystem state every 5s (`r` to refresh now, `q` to quit). Zero new dependency: `scripts/dashboard.cjs` is plain Node + the package's own scripts, no `package.json`/`node_modules` required. It never calls the GitHub API itself — the PR section only reads whatever `.quality-gate/reports/pr-snapshot.json` was last saved by the "PR snapshot" menu action, to avoid hammering the API on every refresh.

`qg-init` detects the project stack before writing. Version `1.0.0` supports:

- `node`: `package.json` at the repository root.
- `python-uv`: `pyproject.toml` at the root or `pipeline/pyproject.toml`.

Python/uv projects get a workflow based on `uv`, `pytest`, `pytest-cov`, `ruff`, `pip-audit`, and the same Node-based Quality Gate helper scripts. Unknown stacks are blocked unless `-Force` is explicit.

Useful flags:

```powershell
qg-init -DryRun      # preview only
qg-init -Yes         # accept safe default prompts
qg-init -SkipGitHub  # copy local files without remote branch protection/ruleset
qg-init -Sonar       # configure SonarCloud and require the SonarCloud check
qg-init -Force       # allow non-Node stack override
```

For a Python/uv repo like `tcc-free-plaud`:

```powershell
cd D:\Dev\Repos\Own\tcc-free-plaud
qg-init -DryRun -Repo devAndreotti/tcc-free-plaud
qg-init -Yes -Repo devAndreotti/tcc-free-plaud -SkipBaseline -SkipCommit

cd pipeline
uv run pytest --basetemp .pytest-tmp-qg -q --cov=src --cov-report=json:../coverage/coverage.json --cov-report=xml:../coverage/coverage.xml --cov-report=term-missing

cd ..
node scripts\quality-gate.js update
node scripts\quality-gate.js check
node scripts\doctor.cjs --dry-run
```

Equivalent one-command validation for PR work:

```powershell
node scripts\local-validate.cjs --project D:\Dev\Repos\Own\tcc-free-plaud --profile pr --dry-run --json
node scripts\local-validate.cjs --project D:\Dev\Repos\Own\tcc-free-plaud --profile pr --json
```

`local-validate` runs Python/uv checks, Node UI checks when `package.json` is detected, `node scripts/quality-gate.js check`, `node scripts/doctor.cjs --dry-run`, `git diff --check`, and `git status`. The quality-gate check only runs after successful pytest with fresh coverage. `qg-chk` and `qg-doc` are Scriply conveniences, not local validation dependencies.

### Step 1 — Copy Files to Your Repository

Extract the zip and copy all files (except the `.codex/` directory) to the root of your project:

```bash
cp -r quality-gate/.github          your-project/
cp -r quality-gate/scripts          your-project/
cp    quality-gate/sonar-project.properties  your-project/
```

The `.codex/skills/babysit-pr/` folder should be placed in:
- **Global Codex CLI** (works across any repo): `~/.codex/skills/babysit-pr/`
- **Per Repository** (only active for this project): `your-project/.codex/skills/babysit-pr/`

### Step 2 — Automatic Configuration via Script

Create a GitHub Personal Access Token (PAT) with admin permissions on the repository:
→ https://github.com/settings/tokens (Scopes: `repo`, `admin:repo_hook`)

Run `setup.js` to rewrite `sonar-project.properties` for the target repository, then configure SonarCloud when desired:

```bash
# PowerShell — validate the package before configuring GitHub:
node scripts/doctor.cjs --dry-run

# With SonarCloud token (retrieve from sonarcloud.io after connecting the repo):
$env:GITHUB_TOKEN="ghp_xxx"
node scripts/setup.js --repo=OWNER/REPO --sonar-org=ORG --sonar-token=YOUR_SONAR_TOKEN

# Without SonarCloud for now:
node scripts/setup.js --repo=OWNER/REPO --skip-sonar

# Preview what the script would do without executing it:
node scripts/setup.js --repo=OWNER/REPO --dry-run

# Preview managed workflow upgrades without overwriting custom workflows:
node scripts/bootstrap-repo.cjs --project . --upgrade --dry-run

# Skip optional local steps:
node scripts/setup.js --repo=OWNER/REPO --skip-readme --skip-funding
```

Equivalent Bash command:

```bash
GITHUB_TOKEN=ghp_xxx node scripts/setup.js --repo=OWNER/REPO --sonar-org=ORG --sonar-token=YOUR_SONAR_TOKEN
```

The script automatically performs the following tasks:
- Creates/updates the local deterministic bootstrap: `LICENSE`, `.github/FUNDING.yml`, `.github/dependabot.yml`, and a managed README block.
- Upgrades `.github/workflows/quality-gate.yml` only when the workflow contains the `# quality-gate:managed-workflow` marker; unmarked workflows require manual review.
- Adds `SONAR_TOKEN` as a repository secret.
- Creates the repository PR ruleset used by Quality Gate. Copilot Review can still be requested by the babysit-pr workflow or enabled separately in GitHub when available for the account.
- Configures branch protection on the `main` branch using `.quality-gate/policy.json`.
- Validates the overall setup at the end.

### Step 3 — Capture the Project's Baseline

Node/Jest project:

```bash
# In the root of your project:
npm run test:coverage:ci
node scripts/quality-gate.js init
```

Python/uv project with `pipeline/pyproject.toml`:

```powershell
cd pipeline
uvx ruff check src tests --output-format=json > ..\coverage\ruff.json
uv run pytest --basetemp .pytest-tmp-qg -q --cov=src --cov-report=json:../coverage/coverage.json --cov-report=xml:../coverage/coverage.xml --cov-report=term-missing
cd ..
node scripts/quality-gate.js init
```

Commit the captured ratchet:

```bash
git add scripts/baseline.json
git commit -m "chore: set quality gate baseline"
git push
```

Now, the ratchet quality gate is active.

---

## PR Readiness Contract

`pr-snapshot.cjs` separates required checks, advisory checks, GitHub merge state, and review-thread state. `babysit-loop.cjs` only returns terminal `ready` when `snapshot.merge.ready === true`.
The PR report job also writes `.quality-gate/reports/pr-snapshot.json` and passes it to `pr-comment.js` through `SNAPSHOT_PATH`. If GitHub API or GraphQL access fails, the sticky comment stays conservative and reports manual verification instead of claiming the PR is ready.
Because the sticky comment is posted through issue comments, the report job needs `issues: write` plus `pull-requests: write`.
The report also writes `GITHUB_STEP_SUMMARY` when available and emits up to five GitHub Actions annotations for blockers or lowest-coverage files.

Important states:

- `ready`: required checks green, merge policy allows merge, review threads known and resolved.
- `ready_with_advisory`: merge is allowed, required checks green, optional check failed.
- `wait_ci`: required check pending or missing.
- `fix_required_check`: required check failed.
- `resolve_review_threads`: GraphQL found unresolved review thread.
- `verify_review_threads_manual`: GraphQL could not confirm review threads.
- `blocked_by_policy`: GitHub reports merge blocked by branch policy.

Sonar is advisory unless policy/branch protection makes it required.

The GitHub-generated PR notification email itself is not customizable — GitHub controls its subject/body. What Quality Gate controls is the sticky PR comment, the job summary, and Actions annotations described above; that's the "email-friendly" surface, not the email itself.

---

## Mixed Projects

`.quality-gate/policy.json` can declare surfaces:

```json
{
  "project": {
    "surfaces": [
      { "type": "python-uv", "root": "pipeline", "required": true, "coverageJson": "../coverage/coverage.json" },
      { "type": "node", "root": "UI", "required": true }
    ]
  },
  "ci": {
    "requiredChecks": ["Python validation", "UI validation", "Docker image gate"],
    "advisoryChecks": ["SonarCloud Code Analysis"]
  },
  "localValidation": {
    "untrackedAllowlist": ["samples/**"],
    "pytestBasetempPattern": ".pytest-tmp-qg-${timestamp}-${pid}"
  }
}
```

Bootstrap detects `pipeline/pyproject.toml` and `package.json`, then generates matching workflow jobs. `doctor.cjs` warns about undeclared surfaces and fails when a required surface lacks a workflow job.

---

## Dependabot Consolidation

```powershell
node scripts\dependabot-consolidate.cjs --repo OWNER/REPO --dry-run --json
```

The helper lists open Dependabot PRs, touched files, probable conflicts, and whether to consolidate or merge independently.

---

## Add to package.json

```json
{
  "scripts": {
    "test:coverage:ci": "jest --coverage --coverageReporters=lcov --coverageReporters=json-summary --ci",
    "lint": "eslint src --ext .ts,.tsx --max-warnings 0"
  },
  "jest": {
    "coverageDirectory": "coverage"
  }
}
```

---

## Complete Daily Workflow

```
You tell Codex:
  "implement OAuth authentication in auth/ module and open PR"
          ↓
Codex writes code → runs tests locally → opens PR
          ↓
GitHub Actions triggers automatically:
  ├─ npm audit or pip-audit (blocks on critical vulnerabilities)
  ├─ ESLint or Ruff (blocks on lint errors)
  ├─ Jest or pytest + ratchet (blocks if coverage regressed)
  ├─ SonarCloud when enabled (blocks if quality gate fails)
  └─ Docker image gate (skips repos without Docker; runs advisory/fallback if Docker exists)
          ↓
Codex/Copilot review can be requested on the PR
          ↓
You tell Codex:
  "babysit PR #42"
          ↓
babysit-pr enters a loop:
  ├─ CI failed? → reads logs → fixes code → push → waits for CI
  ├─ Copilot commented "Bloqueador:"? → implements → push
  ├─ Ratchet failed? → reads coverage-summary.json or coverage.json → adds tests → push
  ├─ Sonar failed? → reads sonarcloud[bot] comment → fixes → push
  └─ All green? → notifies you: "PR #42 is ready to merge"
          ↓
You merge (or tell Codex: "merge the PR")
```

---

## Useful Ratchet Commands

```bash
# Audit if workflow/setup/baseline/Sonar are consistent
node scripts/doctor.cjs --dry-run

# Release v1 gate: fails while release blockers such as zero baselines remain
node scripts/doctor.cjs --release

# Write detected state for the agent/CI to consume
node scripts/doctor.cjs --write-state

# Inspect Dockerfiles/Compose with Docker Image Doctor or static fallback
node scripts/docker-gate.cjs --project . --json
node scripts/docker-gate.cjs --project . --dry-run

# Apply local bootstrap without consuming agent context
node scripts/bootstrap-repo.cjs --project . --dry-run
node scripts/bootstrap-repo.cjs --project .
node scripts/bootstrap-repo.cjs --project . --skip-readme --skip-funding

# Generate PR snapshot and CI diagnostics for babysit-pr
node scripts/pr-snapshot.cjs --pr 42 --json --output .quality-gate/reports/pr-snapshot.json
node scripts/ci-diagnose.cjs --snapshot .quality-gate/reports/pr-snapshot.json --json --output .quality-gate/reports/ci-diagnose.json
node scripts/babysit-loop.cjs --pr 42 --once --json

# Verify if metrics regressed (what the CI does)
node scripts/quality-gate.js check

# Update baseline with current metrics (only goes up, never down)
node scripts/quality-gate.js update
node scripts/quality-gate.js update --dry-run

# View report without blocking (useful locally)
node scripts/quality-gate.js report
```

---

## Troubleshooting

**SonarCloud does not appear in the PR**
→ Verify that `SONAR_TOKEN` is present in Settings → Secrets → Actions.
→ Confirm that `fetch-depth: 0` is set in the checkout step of the `sonar` job.
→ Run `node scripts/setup.js --repo=OWNER/REPO --sonar-org=ORG` to rewrite the Sonar project key/name for the target repo.

**Copilot Review does not appear automatically**
→ The REST ruleset API currently rejects the automatic Copilot fields for some accounts/plans.
→ Use babysit-pr to request or process review feedback, or enable automatic review in GitHub UI when the account supports it.

**Ratchet fails on the first run**
→ The initial `baseline.json` starts with zeros. Run `node scripts/quality-gate.js init`.

**Docker image gate shows warnings without Docker Doctor**
→ On Linux CI, the local helper `D:\Dev\Scripts\seguranca\18-Docker-Image-Doctor.ps1`
  does not exist; the script falls back to `static-advisory`. Run it locally on Windows
  to use Syft/Grype/Dive/Hadolint via Docker Doctor.

**Existing README was not modified**
→ The bootstrap script only replaces blocks bounded by `<!-- quality-gate:readme:start -->`
  and `<!-- quality-gate:readme:end -->`. Without these markers, it preserves your README.

**Setup fails with permission errors**
→ The `GITHUB_TOKEN` must have admin access to the repository. Use a classic PAT with `repo` and `admin:repo_hook` scopes, or a fine-grained PAT with "Administration: Read and Write".

**Codex cannot find the babysit-pr skill**
→ Confirm that `SKILL.md` is located at `~/.codex/skills/babysit-pr/SKILL.md`.
→ Alternatively, place it in `.codex/skills/babysit-pr/` at the root of the repository.
