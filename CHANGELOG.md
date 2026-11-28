# Changelog

## Unreleased

- Added `qg init` (Node, `scripts/init.cjs`): company-mode install and update without PowerShell. It installs only scripts, policy and the gate workflow, keeps a manifest, and refuses to overwrite project files it did not install.
- The Node workflow detects the package manager from the lockfile (npm, pnpm, Yarn 1, Yarn 2+ via corepack) and reads `.nvmrc`. It also gains runner labels, push branches, a fork guard on self-hosted runners and an optional secret scan.
- The Node workflow pins actions by SHA, including the SonarCloud quality gate action that was on `@master`. The default Node version is now 24 (it was 20, which is EOL).
- Fixed: `qg-init` on a repo without `.quality-gate/policy.json` failed with ENOENT in `configure-project`.
- Fixed: `qg-init` overwrote the project's `CHANGELOG.md`.
- `doctor` in company mode no longer requires FUNDING, Sonar, `.codex` or a root `VERSION`.

## 1.0.0 - 2026-05-24

- Added machine-readable policy/state contract.
- Added deterministic repo bootstrap for LICENSE, FUNDING, Dependabot, and README scaffold.
- Added Docker image gate with Docker Image Doctor integration and static fallback.
- Added PR snapshot and CI diagnosis scripts for `babysit-pr`.
- Added CommonJS-compatible scripts with no `type=module` requirement.
- Added v1 smoke tests and release readiness checks.
