# Releases

`.github/workflows/release.yml` is prepared for `MendCode/MendCode`, currently private.
It has not been run. Writing or testing it locally does not publish a release.

## Cut a release

After reviewing and committing the release source, run the local checks:

```sh
bun run typecheck
sh scripts/test-shards.sh
bun run test:compiled
```

While developing, `bun run test:fast` runs only the test files whose inputs changed since they last passed, as small groups on every
core (`scripts/test-fast.ts`; the shards take 10 to 12 minutes). What it does:

- A test file's inputs are the files it imports, directly or through others, the non-code files and helpers of its package, the
  source of a package it names by path, and docs, scripts and root files when it reads those. An imported source file counts by its
  code (comments, formatting and types removed), so a comment or a type edited in a central file reruns only the tests that may read
  sources as text: a comment in `packages/protocol/src/commands.ts` reruns 340 of 1,089 files where it reran 960, one in
  `packages/daemon/src/daemon.ts` 125 where it reran 303. A change to what the code does reruns every file that imports it, as before.
  `--list` prints what would run and runs nothing.
- Code that does not typecheck stops the run before any test starts. `tsconfig.base.json` does not include `apps/*/test`, so a type
  error in a terminal test file is not caught there.
- A file that took 5 seconds or more the last time runs in a process of its own and the slowest start first; the rest run in groups of
  up to six. A hung group is killed after 150 seconds (300 for the one with the disk measurement).
- A group that fails is run again alone at the end and that result counts; the line that says so names the tests that had failed.
  `scripts/perf.test.ts` (frame and start-up budgets of the compiled binary) runs after everything else, alone, for the same reason.
  `MENDCODE_TEST_LOG_DIR=<dir>` keeps the output of every group that failed its first run.
- The full-size disk measurement (`packages/store/test/disk-budget.test.ts`, about a minute) is left out unless `--all`.
  `bun run test:fast daemon` runs the files whose path contains a word.
- bun prints only failures when `CLAUDECODE`, `AGENT` or `REPL_ID` says an AI agent started it. Both scripts run bun without those
  variables, so the output and the logs name every test file whoever starts the run.

The release check stays the shard script.

`sh scripts/test-shards.sh` runs the suite as four separate bun processes (a single `bun test` over every file grows past 6 GB). For every
part it prints the duration and counts and, for a failure, the file, the test name and what bun printed for it. `sh scripts/test-shards.sh cli`
runs one part. When a run ends without a failing test (cancelled, killed), the log says why as far as the machine can: with
`MENDCODE_TEST_HEARTBEAT_SECONDS=20` it prints a line every 20 s (part, test file, load, free memory, biggest process), a SIGTERM/SIGINT/SIGHUP
that reaches the script is reported with the part, the test file and the process table, and `MENDCODE_TEST_NEW_SESSION=1` runs every part
in a session of its own (`setsid`) so a signal sent to a group from inside the tests cannot reach the script or the CI step. A part
that prints nothing for 300 seconds (times `MENDCODE_TEST_TIME_SCALE`; `MENDCODE_TEST_SILENCE_SECONDS` sets another limit, 0 turns it
off) is reported as `HUNG` with the test file it is in, the part's processes and, on macOS, a `sample` of the bun process, then killed,
and the run fails: a run once sat in `packages` for 26 minutes with nothing to say which file it was in, and three later runs of that
part under a watcher did not hang. `bunfig.toml`
preloads `scripts/test-kill-guard.ts`: a test cannot signal pid 0, -1, 1, its own process or its parent, or a process group it did not spawn.
The same script is the release gate: every tag, betas included, runs it once before anything is built. `.github/workflows/ci.yml`
runs it for pull requests and on demand (`gh workflow run ci.yml --ref main`), not for a push to `main`. `apps/cli` runs as one
process per 40 test files (`cli-1`, `cli-2`, … in name order): a bun process keeps what each file left, and 193 files in one
reached 7.3 GB, which the 8 GB runner's OOM killer ended; 40 stay near 2 GB.

When publication is authorized, tag the reviewed commit and push the tag:

```sh
tag=v0.0.1-beta.2
git tag "$tag"
git push origin "$tag"
```

## Channels

| Channel | Tag | GitHub release | Who gets it |
|---|---|---|---|
| `stable` | `vX.Y.Z` | release (the "latest" one) | the default for installers and `upgrade` |
| `beta` | `vX.Y.Z-beta.N` | prerelease | `--channel beta` (also takes a newer stable) |
| `nightly` | `vX.Y.Z-nightly.YYYYMMDD.RUN` | prerelease | `--channel nightly` (also takes a newer beta or stable); tagged from `main` by [nightly.yml](../.github/workflows/nightly.yml) |
| `dev` | `dev-<7–40 hex sha>` | prerelease | exact tags only for installers; `upgrade --channel dev` follows the newest |

`RUN` is a positive integer without leading zeros (the nightly workflow's run number), `YYYYMMDD` is the UTC date.

[nightly.yml](../.github/workflows/nightly.yml) runs every day at 06:17 UTC (and on demand). When `main` has commits that no nightly
tag points at, it tags `main` as `vX.Y.Z-nightly.YYYYMMDD.RUN`, where `X.Y.Z` is the patch after the newest stable release (the
version in `apps/cli/package.json` before the first one), and dispatches `release.yml` on that tag, which runs the whole gate before
it builds or signs anything. A tag pushed with the workflow token starts no workflow by itself, which is why the release is
dispatched, on the tag ref so the signing identity is the tag's. The 14 newest nightlies are kept; older ones and their tags are deleted. Installers, the workflow and the
updater accept exactly the same tag shapes; anything else is refused. The newest nightly is the one with the highest `X.Y.Z`, then date, then
run number. A tag whose shape and prerelease flag disagree is not part of any channel. The upgrade side of the channels is in [upgrade.md](upgrade.md).

For a manual run, the tag must already exist and contain this workflow:

```sh
gh workflow run release.yml --repo MendCode/MendCode --ref "$tag" -f tag="$tag"
```

Dispatch from a branch is refused: the workflow ref must equal the release tag so the keyless
certificate identity matches what installers verify. Manual dispatch never creates tags.
An existing release causes creation to fail; there is no automatic overwrite or retagging.

The pipeline typechecks and tests once (`.github/actions/checks`, shared with `ci.yml`: typecheck, then `scripts/test-shards.sh` on ubuntu-24.04
with ripgrep, zsh and bubblewrap installed; a failing, timed-out or crashed part fails the release), then builds on native runners.
The runner gets `MENDCODE_TEST_TIME_SCALE=3` (time budgets in tests are developer-machine numbers, see [performance.md](performance.md#budgets)) and
`MENDCODE_REQUIRE_TOOLS=rg,zsh` (a test that needs one of them fails instead of skipping); neither is set anywhere else.
The release binary itself needs neither ripgrep nor zsh: the grep tool and `debug rg` fall back to a built-in search, the file REST `find`
endpoints answer 501 without ripgrep, and the completion scripts are printed, never run. Tests run the CLI with an empty PATH to prove it.

| Target | Runner |
|---|---|
| darwin-arm64 | macos-15 |
| darwin-x64 | macos-15-intel |
| linux-x64 | ubuntu-24.04 |
| linux-arm64 | ubuntu-24.04-arm |
| windows-x64 | windows-2022 |

Dependencies install with pnpm 11.17.0, a frozen lockfile and a seven-day minimum release age.
Each build stamps the CLI version and smokes the exact binary it uploads. Darwin/Linux smoke
tests CLI automation, daemon startup/shutdown and embedded resources with a faux engine, in temp
directories, without Bun on PATH or a checkout in the working directory. Windows currently smokes
CLI and upgrade help only: the Windows daemon uses a loopback TCP endpoint (see `automation.md`), not yet smoked in CI;
named pipes are not used. CI refuses unavailable compilation rather than silently skipping it.

## Assets and verification

Executables are direct files, not archives:
`mendcode-<version>-<os>-<arch>[.exe]`, where version is the tag without the initial `v`.
Example: `mendcode-0.0.1-linux-x64`, `mendcode-0.0.1-beta.2-windows-x64.exe`.
The release includes `release-index.json` (repository/tag/channel, binary hashes/sizes and conservative storage fingerprint), `install.sh`, `install.ps1`, `SBOM.cdx.json`, `SHA256SUMS` and cosign
`<filename>.sigstore.json` bundles for binaries, installers, SBOM and the manifest. These are always produced.
Releases of a public repository also include `provenance.sigstore.json` and GitHub attests the binaries and the index. A private repository has no
attestations (GitHub needs a plan the repository does not have), so the cosign bundles are what vouches for it: they are bound to the workflow path and
the exact tag, and `SHA256SUMS` (signed) carries the digest of every other file, `release-index.json` included. Both the installers and `upgrade` require
one of the two proofs and fail closed when it is missing.

`SHA256SUMS` hashes every payload and signature bundle, including provenance when present.
The manifest itself and `SHA256SUMS.sigstore.json` are excluded to avoid a circular hash.
Download the assets into an empty directory, verify the manifest signature, then verify checksums:

```sh
tag=v0.0.1
identity="https://github.com/MendCode/MendCode/.github/workflows/release.yml@refs/tags/$tag"
issuer=https://token.actions.githubusercontent.com
cosign verify-blob --bundle SHA256SUMS.sigstore.json \
  --certificate-identity "$identity" --certificate-oidc-issuer "$issuer" SHA256SUMS
sha256sum --check SHA256SUMS
# macOS alternative: shasum -a 256 --check SHA256SUMS
binary=mendcode-0.0.1-linux-x64
cosign verify-blob --bundle "$binary.sigstore.json" \
  --certificate-identity "$identity" --certificate-oidc-issuer "$issuer" "$binary"
# only when the release carries provenance.sigstore.json (public repository):
gh attestation verify "$binary" --repo MendCode/MendCode \
  --signer-workflow MendCode/MendCode/.github/workflows/release.yml
```

For a private repository download the assets with an authenticated `gh` (`gh release download "$tag" --repo MendCode/MendCode --dir .`) and run the cosign commands
above; there is no attestation to verify and none is needed.

Use cosign 2.6.1 or newer for the bundle format (CI pins 2.6.1). Verification checks the exact
tag identity and GitHub OIDC issuer; it does not disable transparency-log or certificate checks.
For a Windows checksum, compare `(Get-FileHash .\mendcode-0.0.1-windows-x64.exe -Algorithm SHA256).Hash`
to its unique `SHA256SUMS` entry. The cosign commands work in PowerShell with variables adapted.
See [Sigstore blob signing](https://docs.sigstore.dev/cosign/signing/signing_with_blobs/) and
[GitHub provenance](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations).

`SBOM.cdx.json` is deterministic CycloneDX 1.6 JSON generated offline from `pnpm-lock.yaml` and
the workspace manifests by `bun scripts/sbom.ts VERSION OUTFILE`, with no added dependencies.
It inventories all locked packages (including development, optional and other-platform entries)
and workspace importers; the root is the metadata component. It is not an exact bundle composition,
license audit, vulnerability scan or inventory of Bun's embedded native dependencies.

## Install

The short form, for a public repository:

```sh
curl -fsSL https://github.com/MendCode/MendCode/releases/latest/download/install.sh | sh                          # newest stable
curl -fsSL https://github.com/MendCode/MendCode/releases/latest/download/install.sh | sh -s -- --channel nightly   # or beta
```

```powershell
irm https://github.com/MendCode/MendCode/releases/latest/download/install.ps1 | iex
```

Or download and inspect the release's installer before running it, then pick a channel or an exact release:

```sh
sh ./install.sh                         # newest stable release
sh ./install.sh --channel beta          # newest vX.Y.Z-beta.N, or a newer stable
sh ./install.sh --channel nightly       # newest vX.Y.Z-nightly.YYYYMMDD.RUN, or a newer beta or stable
MENDCODE_VERSION=v0.0.1-beta.2 sh ./install.sh   # one exact release (a channel cannot be combined with it)
sh ./install.sh --tier minimalist       # start in the minimalist tier (see below); --tier balanced|full too
```

On Windows, run `./install.ps1` in PowerShell 5.1 or newer, with `$env:MENDCODE_CHANNEL = 'beta'` (or `nightly`) or
`$env:MENDCODE_VERSION = 'v0.0.1-beta.2'`, and `$env:MENDCODE_TIER = 'minimalist'` for a starting tier. Both scripts resolve the latest stable release when neither is
set, accept only `vX.Y.Z`, `vX.Y.Z-beta.N`, `vX.Y.Z-nightly.YYYYMMDD.RUN` and `dev-<sha>`, require a unique SHA256 entry and
refuse mismatches before replacing the binary. With `cosign` installed, the release's cosign bundles for `SHA256SUMS` and for
the binary are verified against the exact tag identity; a missing bundle or an invalid signature fails the install.

Without `cosign` the installers install after the SHA256 check and say that the signature was not checked, like most
`curl | sh` installers. A checksum from the same release protects against corruption, not against a compromised release:
install cosign 2.6.1 or newer to check the signature, and set `MENDCODE_REQUIRE_SIGNATURE=1` to refuse any install without it.
`MENDCODE_ALLOW_UNSIGNED=1`, which used to opt into the SHA256 check alone, is now the default and has no effect.

### Starting tier

`--tier minimalist|balanced|full` (or `MENDCODE_TIER`; PowerShell reads only the variable) chooses which [tier](tiers.md) the first
launch starts in. It is the same binary for all three, and the choice is only a starting point: no argument means `balanced`, a
value that is none of the three stops the installer before anything is written, and `--tier` composes with `--channel`.

The installer records it as a fourth line of its receipt, `.mendcode-v2-install`, beside the binary (`schema`, `binary`, `sha256`, `tier`;
a receipt from before `--tier` has no such line, and [uninstall](uninstall.md) accepts both). Nothing else is written, and the installer still
never runs the binary or touches the data directory. The first launch reads the line (beside the running binary, then in
`MENDCODE_INSTALL_DIR`, then the installer's default directory; a source run reads only `MENDCODE_INSTALL_DIR`) and applies it only when
setup was never completed (`onboarded`) and no `tier` is saved: `minimalist` configures itself with no setup page, `balanced` and `full`
open the setup page with that tier on its Tier row ([setup](setup.md#first-run)). After that first launch the receipt is not read again, so
`mendcode upgrade` (which replaces `<data dir>/bin/mendcode-next` and never touches the receipt), a reinstall with another `--tier` and
`/tier off` all leave the user's choice alone. Change the tier later with `/tier <name>` or the Tier row of `/setup`, globally or per
project profile.

### Installing from a private fork or repository

GitHub refuses anonymous downloads from a private repository, so the installers read one through the GitHub CLI:

1. Install `gh` and `cosign`, then sign in with an account that can read the repository: `gh auth login` (or export `GH_TOKEN`; read access to
   the repository contents is enough).
2. Fetch the installer through `gh` and run it: `gh release download <tag> --repo MendCode/MendCode --pattern install.sh` for a tag
   you know, or `gh api -H 'Accept: application/vnd.github.raw' repos/MendCode/MendCode/contents/scripts/install.sh > install.sh` for the one on the default branch. Read it.
3. `sh ./install.sh --channel beta`. With `gh` signed in and no `MENDCODE_DOWNLOAD_BASE`, the script lists releases with `gh release list`, picks the newest
   beta and downloads its assets with `gh release download`; the token is never written anywhere and never leaves `gh`.
4. Updates afterwards: `mendcode upgrade --channel beta` ([upgrade.md](upgrade.md)); it finds the same token in `GH_TOKEN`, `GITHUB_TOKEN` or `gh auth token`.

For a private repository (GitHub attests only public ones) what is verified is the SHA256 of the binary against `SHA256SUMS` and the keyless cosign signature of both,
bound to `https://github.com/MendCode/MendCode/.github/workflows/release.yml@refs/tags/<tag>`. Without `gh` the installer falls back to anonymous
`curl` and works only for a public repository or a mirror (`MENDCODE_DOWNLOAD_BASE`, plus `MENDCODE_API_BASE` to list a channel from the mirror's API).

POSIX installs atomically to `${MENDCODE_INSTALL_DIR:-$HOME/.local/bin}/mendcode` (mode 755),
with staging inside that directory, and prints a PATH hint. It never uses sudo or changes PATH.
Windows stages in `${MENDCODE_INSTALL_DIR}` or `%LOCALAPPDATA%\Programs\mendcode`, atomically moves
or replaces `mendcode.exe`, and adds the directory to the user PATH only when absent. Open a new
terminal afterward. Cosign trust caches stay inside the staging directory and are cleaned up.
Neither script runs the binary or writes daemon data.

`REPO` / `$Repo` at the top of each installer selects the download repository and expected signer (`MendCode/MendCode`).
`MENDCODE_DOWNLOAD_BASE` overrides the releases base for mirrors/tests, without changing signer trust;
the layout is `<base>/download/<tag>/<asset>` and `<base>/latest` must redirect to a tag URL. Setting it turns the `gh` path off.
`MENDCODE_API_BASE` (default `https://api.github.com/repos/MendCode/MendCode`) is where the anonymous path lists releases for `--channel beta|nightly`.
HTTPS, `file://` and loopback HTTP bases are accepted. Offline fixtures set an explicit version.
Upgrade shares the direct asset naming and SHA256 contract, but keeps its existing data-dir installation
and rollback behavior; see [upgrade.md](upgrade.md).

## Limits

- Anonymous `curl` cannot download private GitHub releases. The installers do not read tokens themselves: a private repository
  is read through an authenticated `gh` (see "Installing from a private fork or repository"), or through a mirror with `MENDCODE_DOWNLOAD_BASE`.
- `UPGRADE_REPO` is `MendCode/MendCode` in `packages/upgrade/src/settings.ts`; `MENDCODE_UPGRADE_REPO` overrides it. The updater needs
  a token only for a private repository (`GH_TOKEN`, `GITHUB_TOKEN` or `gh auth token`).
- GitHub provenance runs only for public repositories. Private repositories log a skip, even if an
  Enterprise plan might support attestations. Cosign and SBOM remain enabled and carry the verification. GitHub documents the
  [private-repository plan requirement](https://docs.github.com/en/actions/concepts/security/artifact-attestations).
- Keyless signing uses public Sigstore services and publishes certificate/signature metadata in the
  transparency log, including repository/workflow identity. It needs OIDC and network access in CI.
- All action pins were checked against upstream tags during implementation. YAML, shell and offline
  tests cannot prove GitHub runner availability, signing, attestation or publishing; those await an
  authorized workflow run. This task does not create tags, push, dispatch or create releases.
- There is no Apple notarization or Windows Authenticode signing. macOS builds keep their existing
  ad-hoc signature; cosign is an independent supply-chain signature, not OS trust. Gatekeeper or
  SmartScreen may prompt. After verifying a trusted download, macOS quarantine can be removed with
  `xattr -d com.apple.quarantine /path/to/mendcode`; this does not notarize the binary.

The in-app updater verifies the cosign signature of `SHA256SUMS` and of the binary, which every release carries and which needs no GitHub account; GitHub provenance (which needs a signed-in `gh`) is the path only of a release without cosign bundles. Darwin signature validation runs on macOS. Like the installers it falls back to SHA256 alone when cosign is not installed, says so, and refuses instead with `--require-signature`; a signature that fails is always refused. The storage fingerprint includes schema and store source, so any differing fingerprint blocks automatic rollback. Public-release canary verification remains outstanding.
