# Quality Gate — Software Design Contract & Technical Specification

**Project:** Quality Gate (`D:\Dev\Tooling\quality-gate`)  
**Package Version:** `1.0.0`  
**Stack:** Node.js (v22+ recommended, stdlib-first runtime), PowerShell 7+, Ink 7 + React 19 (bundled TUIs via esbuild), GitHub Actions, SonarCloud, Docker Image Doctor, Copilot Review, Codex `babysit-pr`.

---

## 1. Executive Summary & Purpose

Quality Gate is a deterministic, local-first repository quality-orchestration engine and CI gatekeeper. It bridges local developer workflows, automated CI pull request checks, and AI agent babysitting loops through a single declarative contract (`.quality-gate/policy.json`).

Key Design Axioms:
1. **Zero Runtime Dependency in Consumer Repos:** Consumer projects receive only standalone scripts (`.cjs`/`.js`) and pre-bundled standalone `.mjs` files (~1.7 MB self-contained Ink/React runtime). Consumer projects never execute `npm install` for Quality Gate.
2. **Deterministic Readiness Data Contract:** PR readiness is computed from structured data (`.quality-gate/reports/pr-snapshot.json`), not parsed terminal output.
3. **Strict Ratchet Upward:** Code coverage and quality metrics can only ratify improvements (`scripts/baseline.json`), preventing regressions across commits.
4. **Multi-Stack Auto-Adapter:** Native support for Node.js (`package.json`) and Python/uv (`pyproject.toml`) with automated workflow synthesis.

---

## 2. System Architecture & Components

```
                          ┌────────────────────────────────────────────────────────┐
                          │                Operator Entrypoints                    │
                          │   PowerShell 7+ (QualityGate.ps1 / qg / qg-dash)       │
                          └──────────┬───────────────────────────────┬─────────────┘
                                     │                               │
                                     ▼                               ▼
                 ┌────────────────────────────────┐    ┌─────────────────────────────────┐
                 │       Terminal TUI Layer       │    │     Local Validation Battery    │
                 │  - Rich (Ink 7 + React 19)     │    │  - local-validate.cjs           │
                 │  - Plain-text Zero-Dep Fallback│    │  - quality-gate.js (Ratchet)    │
                 │  (menu-tui.mjs, dashboard-tui) │    │  - docker-gate.cjs (Doctor)     │
                 └────────────────────────────────┘    └────────────────┬────────────────┘
                                                                        │
                                                                        ▼
                 ┌───────────────────────────────────────────────────────────────────────┐
                 │                       PR Babysit & CI Engine                          │
                 │  - pr-snapshot.cjs: Inspects branch, CI checks, reviews, GraphQL      │
                 │  - ci-diagnose.cjs: Deterministic failure classifier (lint/test/dock) │
                 │  - babysit-loop.cjs: Autonomous babysit-pr loop convergence           │
                 │  - pr-comment.js: Idempotent sticky comment on GitHub PRs             │
                 │  - setup.js: GitHub API branch rulesets, Sonar, Dependabot            │
                 └──────────────────────────────────┬────────────────────────────────────┘
                                                    │
                                                    ▼
                 ┌───────────────────────────────────────────────────────────────────────┐
                 │                     External Cloud & CI Ecosystem                     │
                 │  - GitHub Actions: 6 parallel jobs (lint, tests, coverage, docker...) │
                 │  - SonarCloud / GitHub Copilot Review / Dependabot Consolidation      │
                 └───────────────────────────────────────────────────────────────────────┘
```

---

## 3. Core Modules & Script Specifications

### 3.1 PowerShell CLI Operator (`scripts/QualityGate.ps1`)
- **Aliases:** `qg` (interactive menu), `qg-init` (scaffold), `qg-chk` (check ratchet), `qg-upd` (update baseline), `qg-rpt` (generate report), `qg-dash` (live dashboard), `qg-doc` (doctor).
- **Execution Strategy:** Detects TTY and Node version (`>=22`); invokes `scripts/menu-tui.mjs` for rich interactive menu or falls back to PowerShell `Read-Host`.

### 3.2 Dual-Mode Terminal Presentation Layer
- **Rich Mode (`dashboard-tui.mjs` / `menu-tui.mjs`):** Bundled via `scripts/build-tui.mjs` using `esbuild` to inline `ink` 7.1 and `react` 19.2 into standalone ESM modules with zero external imports.
- **Fallback Mode (`dashboard.cjs`):** Plain-text ANSI output using 100% Node.js standard library (`readline`, `fs`, `child_process`).

### 3.3 Ratchet & Metric Engine (`scripts/quality-gate.js`)
- **Commands:** `check`, `update`, `report`, `init`.
- **Metrics Enforced:** `lines`, `statements`, `functions`, `branches` percentages, `maxFileLines` ceiling.
- **Rules:** Updates only allow metrics $\ge$ baseline values. Legacy statement baselines safely map to Python coverage counters.

### 3.4 PR Snapshot & Diagnosis Pipeline (`scripts/pr-snapshot.cjs` & `ci-diagnose.cjs`)
- **Snapshot Contract:** Synthesizes `pr-snapshot.json` including Git head, branch protection status, required checks matrix, GraphQL review thread resolution, and blocker derivation.
- **CI Classifier:** Categorizes failures into `LINT_FAILURE`, `TEST_FAILURE`, `TYPECHECK_FAILURE`, `DOCKER_FAILURE`, `SONAR_FAILURE`, or `TRANSIENT_FAILURE` with targeted recovery actions.

### 3.5 Project Scaffolder & Doctor (`scripts/bootstrap-repo.cjs`, `configure-project.cjs`, `doctor.cjs`)
- **Multi-Stack Detection:** Automatically recognizes Node.js roots and Python/uv packages (`pipeline/pyproject.toml` or root `pyproject.toml`).
- **Scaffolding:** Configures `.github/workflows/quality-gate.yml`, `.quality-gate/policy.json`, `sonar-project.properties`, `.github/copilot-instructions.md`, `LICENSE`, and `FUNDING.yml`.

---

## 4. Policy Schema & Security Contracts

The configuration contract lives in `.quality-gate/policy.json` and adheres to `.quality-gate/policy.schema.json`:
- `requiredChecks`: Array of mandatory GitHub Actions job names.
- `localValidation`: Command definitions for `typecheck`, `lint`, `test`, `coverage`, `docker`.
- `thresholds`: Minimum coverage requirements and max lines per file.
- `docker`: Non-interactive Docker Image Doctor execution parameters.
- **Zero Secrets In Policy:** Sonar tokens and GitHub tokens are read exclusively from environment variables (`QG_SONAR_TOKEN`, `GITHUB_TOKEN`), never serialized to disk.
