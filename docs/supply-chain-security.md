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
- Dry-run release builds do not use the protected `release` environment and do not create GitHub Releases.
- Workflow permissions are explicit and minimal.
- Release assets are checked for MendCode-owned names and expected binaries.
- Release dependency install uses `--ignore-scripts`; required native repair steps run explicitly.
- Dependency review blocks high-severity dependency changes in PRs.
- CodeQL runs on `main`, `dev`, PRs, and schedule.
- Security Guard blocks invisible Unicode controls, risky tracked files, secrets findings, GitHub Actions issues, Semgrep findings, and supply-chain preflight failures.
- OSV dependency scanning runs on PRs and pushes as advisory signal for the current migration baseline, blocks scheduled/manual security runs, and blocks release workflows before dependency install using the release lockfile plus explicit, expiring exceptions in `.github/osv-release.toml`.

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

For release asset generation, the controlled GitHub Actions release workflow scans the checked-in release lockfile with OSV before installing dependencies. A release workflow cannot continue while OSV reports vulnerable release lockfile entries, including dry runs, except for documented exceptions in `.github/osv-release.toml`. After that gate, the workflow installs from the checked-in lockfile with dependency scripts disabled, runs required MendCode repair steps explicitly, builds assets, verifies the release contract, generates an SBOM, and emits provenance attestations.

The recursive monorepo OSV scan remains in Security Guard so non-release surfaces such as the VS Code SDK remain visible and can be remediated without blocking the CLI installer release path.

An OSV finding is evidence that a lockfile resolves to package versions with known vulnerabilities. It is not evidence by itself that a maintainer workstation is compromised, that a malicious package executed, or that a supply-chain attack already happened. Treat those findings as release blockers until remediated or until a narrower release dependency surface is proven and documented.

## Current First Release Status

No public GitHub Release is published until the release workflow successfully creates all installer assets and the dependency release gate is clean. Dry runs do not publish a release and do not enter the protected `release` environment. Track the first release in:

```text
https://github.com/MendCode/MendCode/issues/52
```

Track the OSV lockfile remediation release blocker in:

```text
https://github.com/MendCode/MendCode/issues/55
```
