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
│   ├── doctor.cjs                   ← Read-only package auditor
│   ├── docker-gate.cjs              ← Docker gate + static fallback advisory
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

Edit `sonar-project.properties` (replace `YOUR_ORG` and `YOUR_REPO`), then run:

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

# Skip optional local steps:
node scripts/setup.js --repo=OWNER/REPO --skip-readme --skip-funding
```

Equivalent Bash command:

```bash
GITHUB_TOKEN=ghp_xxx node scripts/setup.js --repo=OWNER/REPO --sonar-org=ORG --sonar-token=YOUR_SONAR_TOKEN
```

The script automatically performs the following tasks:
- Creates/updates the local deterministic bootstrap: `LICENSE`, `.github/FUNDING.yml`, `.github/dependabot.yml`, and a managed README block.
- Adds `SONAR_TOKEN` as a repository secret.
- Creates the repository ruleset that triggers automated Copilot Review on every PR.
- Configures branch protection on the `main` branch using `.quality-gate/policy.json`.
- Validates the overall setup at the end.

### Step 3 — Capture the Project's Baseline

```bash
# In the root of your project:
npm run test:coverage:ci
node scripts/quality-gate.js init

git add scripts/baseline.json
git commit -m "chore: set quality gate baseline"
git push
```

Now, the ratchet quality gate is active.

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
  ├─ npm audit (blocks on critical vulnerabilities)
  ├─ ESLint (blocks on errors)
  ├─ Jest + ratchet (blocks if coverage regressed)
  ├─ SonarCloud (blocks if quality gate fails)
  └─ Docker image gate (skips repos without Docker; runs advisory/fallback if Docker exists)
          ↓
Copilot Review posts comments (automatic via ruleset)
          ↓
You tell Codex:
  "babysit PR #42"
          ↓
babysit-pr enters a loop:
  ├─ CI failed? → reads logs → fixes code → push → waits for CI
  ├─ Copilot commented "Bloqueador:"? → implements → push
  ├─ Ratchet failed? → reads coverage-summary.json → adds tests → push
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

# Release v1 gate: fails if placeholders or zero baselines still exist
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
→ Ensure that `YOUR_ORG` and `YOUR_REPO` in `sonar-project.properties` have been replaced.

**Copilot Review does not appear automatically**
→ Run `node scripts/setup.js` to recreate the ruleset.
→ Confirm your Copilot Student or Enterprise plan is active in Settings → Copilot.

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
