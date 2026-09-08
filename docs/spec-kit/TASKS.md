# Quality Gate — Tasks Breakdown & Verification Milestones

**Project:** Quality Gate (`D:\Dev\Tooling\quality-gate`)  
**Version:** `1.0.0`

---

## 1. Work Breakdown Structure (WBS)

- [x] **Phase 1: Ratchet & Policy Core**
  - [x] Implement upward-only ratchet algorithm in `scripts/quality-gate.js`
  - [x] Define JSON Schema and validation for `.quality-gate/policy.json`
  - [x] Support LCOV and Python coverage JSON report parsing
  - [x] Add baseline initialization and safe update commands

- [x] **Phase 2: Project Scaffolding & Stack Adapters**
  - [x] Implement multi-stack detection for Node.js and Python/uv
  - [x] Scaffold GitHub Actions workflow (`quality-gate.yml`) with 6 parallel jobs
  - [x] Automate GitHub branch protection, rulesets, and Dependabot consolidation
  - [x] Implement read-only `doctor.cjs` diagnostic tool

- [x] **Phase 3: Local Validation Battery & Docker Security**
  - [x] Create `scripts/local-validate.cjs` with parallel execution of lint, typecheck, tests
  - [x] Implement non-interactive Docker Image Doctor bridge in `scripts/docker-gate.cjs`
  - [x] Support static fallback analysis when Docker daemon is unavailable

- [x] **Phase 4: PR Snapshot, CI Classifier & Babysit Engine**
  - [x] Implement `scripts/pr-snapshot.cjs` with GraphQL review thread inspection
  - [x] Build `scripts/ci-diagnose.cjs` deterministic failure classification engine
  - [x] Implement `scripts/babysit-loop.cjs` loop for autonomous PR convergence
  - [x] Deliver idempotent PR sticky commenter (`scripts/pr-comment.js`)

- [x] **Phase 5: Dual-Mode TUI Presentation**
  - [x] Build rich Ink 7 + React 19 interactive menu (`scripts/menu-tui.mjs`)
  - [x] Build live 5-second polling dashboard (`scripts/dashboard-tui.mjs`)
  - [x] Implement zero-dependency fallback for legacy environments (`scripts/dashboard.cjs`)
  - [x] Bundle single-file ESM artifacts via `scripts/build-tui.mjs` and `esbuild`

- [x] **Phase 6: Quality Gate & Test Battery**
  - [x] 125/125 Node test runner suites passing (`node --test scripts/*.test.cjs`)
  - [x] Zero-dependency contract verified on consumer projects
  - [x] Spec-Kit and Archify diagram synchronization
