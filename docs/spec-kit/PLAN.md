# Quality Gate — Engineering Plan & Verification Architecture

**Project:** Quality Gate (`D:\Dev\Tooling\quality-gate`)  
**Methodology:** Spec-Driven Development (SDD) & Ratchet Evolution  
**Status:** In Production (Version `1.0.0`)

---

## 1. System Topology & Development Phases

Quality Gate is organized into 5 functional layers designed for continuous validation:

```
[Layer 1: CLI & TUI] ──> [Layer 2: Policy & Scaffolding] ──> [Layer 3: Local Ratchet Battery]
                                                                        │
                                                                        ▼
[Layer 5: GitHub Actions & Cloud Gates] <── [Layer 4: PR Snapshot & Babysit Engine]
```

### Phase 1: Core Foundation & Ratchet Subsystem
- **Ratchet Engine:** `scripts/quality-gate.js` with `scripts/baseline.json`.
- **Policy Contract:** `.quality-gate/policy.json` validated against JSON Schema.
- **Verification:** Fast local check `node scripts/quality-gate.js check` validating LCOV and Python coverage inputs.

### Phase 2: Autonomous Scaffolding & Multi-Stack Adapters
- **Stack Detection:** `scripts/configure-project.cjs` identifying Node.js vs Python uv repositories.
- **Scaffolder:** `scripts/bootstrap-repo.cjs` generating LICENSE, FUNDING, Dependabot, Copilot instructions.
- **Verification:** Unit tests verifying idempotent file placement and dry-run guarantees.

### Phase 3: Local Validation Battery & Docker Doctor
- **Validation Runner:** `scripts/local-validate.cjs` orchestrating parallel test, lint, and typecheck steps.
- **Docker Hardening:** `scripts/docker-gate.cjs` integrating Docker Image Doctor non-interactively with fallback static linting.

### Phase 4: PR Snapshot, CI Diagnosis & Babysit Loop
- **PR Inspector:** `scripts/pr-snapshot.cjs` fetching check suites, required contexts, and review threads via `gh` CLI and GraphQL.
- **Failure Classifier:** `scripts/ci-diagnose.cjs` producing deterministic action payloads.
- **Babysit Automation:** `scripts/babysit-loop.cjs` orchestrating PR lifecycle convergence until green merge state.
- **Sticky Reporter:** `scripts/pr-comment.js` posting idempotent updates to GitHub PRs.

### Phase 5: Terminal Presentation & Zero-Dependency Bundling
- **React/Ink TUI:** `dashboard-src/` compiled via `scripts/build-tui.mjs` using `esbuild` into standalone `dashboard-tui.mjs` and `menu-tui.mjs`.
- **Zero-Dep Fallback:** `scripts/dashboard.cjs` running on Node.js core modules.

---

## 2. Test Strategy & Quality Gates

The test battery runs natively using Node.js built-in test runner (`node --test`):
1. **Unit & Integration Suite:** 125 tests across `scripts/*.test.cjs` (0 failures, 0 flakiness).
2. **Coverage & Ratchet Verification:** Enforces coverage thresholds across lines, functions, and branches.
3. **Syntax & Portability Check:** Validates CommonJS compatibility on Node.js 18, 20, 22, and 24.
