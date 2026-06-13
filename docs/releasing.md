# Releasing MendCode

This page documents the release contract required by the public installer.

## Installer Contract

The installer at `src/mendcode/install` downloads from:

```text
https://github.com/MendCode/MendCode/releases/latest/download/<asset>
```

For a versioned install, it downloads from:

```text
https://github.com/MendCode/MendCode/releases/download/v<version>/<asset>
```

The release must include these assets:

```text
mendcode-linux-arm64.tar.gz
mendcode-linux-x64.tar.gz
mendcode-linux-x64-baseline.tar.gz
mendcode-linux-arm64-musl.tar.gz
mendcode-linux-x64-musl.tar.gz
mendcode-linux-x64-baseline-musl.tar.gz
mendcode-darwin-arm64.zip
mendcode-darwin-x64.zip
mendcode-darwin-x64-baseline.zip
mendcode-windows-arm64.zip
mendcode-windows-x64.zip
mendcode-windows-x64-baseline.zip
SHA256SUMS
```

Every archive must contain a `mendcode` binary, or `mendcode.exe` for Windows.

## Build Assets

```bash
cd src/mendcode
bun run release:assets
bun run release:check-assets
```

`release:check-assets` validates:

- no `opencode-*` release archives are present
- every expected `mendcode-*` archive exists
- every archive contains the expected binary name
- `SHA256SUMS` exists and verifies

## Troubleshooting Asset Builds

The release builder cross-compiles archives for Linux, macOS, Windows, glibc, musl, and baseline x64 targets. That requires platform-specific native packages such as `@opentui/core-linux-arm64`.

If a local build fails with a message like:

```text
Could not resolve: "@opentui/core-linux-arm64/index.ts"
```

the checkout does not have the cross-platform native dependencies needed for release packaging.

The build script currently tries to resolve this by running package-manager install steps before packaging. Maintainers should run release asset generation only in a controlled release environment with the approved dependency policy for the repo, then verify with `bun run release:check-assets` before publishing.

## Create a Draft Release

Use the package version as the tag unless intentionally cutting a different version.

```bash
cd src/mendcode
version=$(bun -e 'console.log(require("./packages/opencode/package.json").version)')
gh release create "v$version" \
  --repo MendCode/MendCode \
  --draft \
  --title "v$version" \
  --notes "Initial MendCode public release."
```

Upload assets:

```bash
gh release upload "v$version" \
  packages/opencode/dist/*.zip \
  packages/opencode/dist/*.tar.gz \
  packages/opencode/dist/SHA256SUMS \
  --repo MendCode/MendCode \
  --clobber
```

Publish only after `release:check-assets` passes.

```bash
gh release edit "v$version" --repo MendCode/MendCode --draft=false
```

## Smoke Test the Installer

After publishing:

```bash
tmp_home=$(mktemp -d)
HOME="$tmp_home" bash -c 'curl -fsSL https://raw.githubusercontent.com/MendCode/MendCode/main/src/mendcode/install | bash -s -- --no-modify-path'
"$tmp_home/.mendcode/bin/mendcode" --version
```

Versioned install:

```bash
HOME="$tmp_home" bash -c "curl -fsSL https://raw.githubusercontent.com/MendCode/MendCode/main/src/mendcode/install | bash -s -- --version $version --no-modify-path"
```

## Release Checklist

- `main` and `dev` point to the intended commit.
- GitHub Actions are green on `main`.
- Dependabot alerts are reviewed.
- Secret scan is clean on the publicable tree.
- Dependency Review and CodeQL are green.
- `docs/public-readiness-audit.md` is current.
- Release assets pass `bun run release:check-assets`.
- `SHA256SUMS`, `RELEASE-MANIFEST.txt`, `mendcode.spdx.json`, and artifact attestations are present.
- Installer smoke test passes on at least one macOS or Linux machine.
- Release notes mention breaking changes, package changes, and installer changes.

## GitHub Actions Release Flow

Use the manual `Release` workflow from the Actions tab.

Inputs:

- `version`: semver without leading `v`.
- `dry_run`: `true` builds artifacts and attestations without publishing or entering the protected release environment; `false` creates a draft GitHub Release through the protected release environment.
- `prerelease`: marks the release as prerelease.

The workflow:

- runs supply-chain preflight
- blocks release when OSV reports vulnerable checked-in lockfile entries
- installs from the checked-in lockfile with dependency scripts disabled
- runs required MendCode native repair steps explicitly
- builds `mendcode-*` release archives
- validates the installer asset contract
- writes `RELEASE-MANIFEST.txt`
- generates `mendcode.spdx.json`
- creates GitHub artifact attestations
- uploads workflow artifacts
- optionally creates a draft GitHub Release

Dry-run failures can still appear in the Actions run, but they should not create failed `release` deployments. A failed `release` deployment means the protected publish job started and failed; a failed dry-run build is only a build/security check failure.

## Registry Publishing

The public CLI release is separate from registry package publishing.

`src/mendcode/script/publish.ts` supports SDK/plugin registry publishing when:

```bash
MENDCODE_PUBLISH_REGISTRIES=true
```

Keep that disabled unless the npm/package registry credentials and package ownership are intentionally configured.
