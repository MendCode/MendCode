# Supply Chain Security

MendCode release and contribution security is built around small permissions, pinned automation, public provenance, and fail-closed scanners.

## Release Guarantees

The release workflow in `.github/workflows/release.yml` produces:

- platform archives named `mendcode-*`
- `SHA256SUMS`
- `RELEASE-MANIFEST.txt`
- `mendcode.spdx.json` SBOM
- GitHub artifact attestations for release artifacts

Users can verify release downloads with:

```bash
gh release download v<version> --repo MendCode/MendCode
shasum -a 256 -c SHA256SUMS
gh attestation verify --repo MendCode/MendCode mendcode-*.zip mendcode-*.tar.gz SHA256SUMS RELEASE-MANIFEST.txt mendcode.spdx.json
```

GitHub artifact attestations provide signed provenance claims for public repository artifacts. GitHub documents artifact attestations as a way to establish provenance and integrity guarantees for builds.

## Automation Rules

Repository automation follows these rules:

- Actions are pinned to full commit SHAs.
- Release publishing is manual and protected by the `release` environment.
- Release publishing from non-`main` refs is blocked.
- Workflow permissions are explicit and minimal.
- Release assets are checked for MendCode-owned names and expected binaries.
- Dependency review blocks high-severity dependency changes in PRs.
- CodeQL runs on `main`, `dev`, PRs, and schedule.
- Security Guard blocks invisible Unicode controls, risky tracked files, secrets findings, GitHub Actions issues, Semgrep findings, and supply-chain preflight failures.
- OSV dependency scanning runs on PRs and pushes as advisory signal for the current migration baseline, and blocks scheduled/manual security runs plus every release workflow.

## Preflight Guard

`.github/scripts/supply-chain-preflight.sh` checks:

- invisible Unicode and bidi controls
- secret-like tracked file names
- unpinned GitHub Actions references
- pipe-to-shell commands in automation paths
- accidental `opencode-*` release archives outside ignored dist output

Run locally:

```bash
bash .github/scripts/supply-chain-preflight.sh
```

## Dependency Policy

Dependency changes should go through PR review and CI. Direct package publishing is intentionally separate from CLI release publishing.

For release asset generation, the controlled GitHub Actions release workflow scans checked-in lockfiles with OSV before installing dependencies. A release cannot publish while OSV reports vulnerable lockfile entries. After that gate, the workflow installs from the checked-in lockfile, builds assets, verifies the release contract, generates an SBOM, and emits provenance attestations.

## Current First Release Status

No public GitHub Release is published until the release workflow successfully creates all installer assets and the dependency release gate is clean. Track the first release in:

```text
https://github.com/MendCode/MendCode/issues/52
```

Track the OSV lockfile remediation release blocker in:

```text
https://github.com/MendCode/MendCode/issues/55
```
