# Rename inventory: "MendCode v2" becomes MendCode

This codebase was developed as "MendCode v2" in `Obed0101/mendcodev2`. It is now MendCode, repository `MendCode/MendCode` (private for now), first
releases `v0.0.1-nightly.YYYYMMDD.RUN` then `v0.0.1-beta.N`. The old public product is "legacy MendCode" (`MendCode/MendCode-legacy`). This page lists
every place a name appeared, what changed and what was kept on purpose. It is the only file allowed to keep the old strings.

## (a) Repository identity: changed

| Where | Was | Now |
|---|---|---|
| `scripts/install.sh`, `scripts/install.ps1` (`REPO`, `$Repo`: download repository and cosign certificate identity) | `Obed0101/mendcodev2` | `MendCode/MendCode` |
| `docs/release.md`, installer tests (`scripts/install.test.ts`) | `Obed0101/mendcodev2` | `MendCode/MendCode` |
| `packages/upgrade/src/settings.ts` `UPGRADE_REPO` (and so the updater's `gh attestation verify --repo`, the cosign identity and the release-index check) | empty (off), `MENDCODE_UPGRADE_REPO` required | `MendCode/MendCode`; the variable still overrides it |
| `.github/workflows/release.yml` | no repository name inside (uses `github.repository`) | unchanged; the signing identity is `https://github.com/MendCode/MendCode/.github/workflows/release.yml@refs/tags/<tag>`, exactly what the installers and the updater verify |

`Obed0101/MendCode-Web` in `specs/master-plan.md` is another repository and stays. `LICENSE` keeps its copyright holder.

## (b) Product strings: changed

"MendCode v2", "MendCode 2", "MendCode 1" (now "legacy MendCode"), "MendCode v1" in prose: help text of `migrate-v1`, the uninstall page and plan, daemon `debug info`,
the HTTP API title, docs, `THIRD_PARTY.md`, comments. Root `package.json` name `mendcode-v2` is `mendcode`; the CLI package `bin` is `mendcode`; SBOM component name follows it.
User agents (`mendcode-v2 GitLab`, Copilot, Cloudflare AI Gateway) are `mendcode ...`; the OTLP `service.name` is `mendcode`; the ACP/daemon client name is `mendcode`.
Bare "v2" in help text that meant the product ("v2 wire protocol", "v2 database verified", "Remove v2 ChatGPT login?") now says MendCode.

Kept, not product names: `v2` as a technical identifier (provider-auth `source: "v2"`, REST operation ids `v2.session.*`, the extension ABI `v2`, API paths such as `/v2`);
`MendCodeV2` in sample paths of fixtures (`/Users/dev/Code/MendCodeV2`, the checkout directory, which is not renamed here) and as the Windows trash folder `%LOCALAPPDATA%\MendCodeV2\Trash` (on disk, see d);
`specs/master-plan.md` (a historical conversation; it gets a note, its text is not rewritten); `.agents/` and `task-evidence/`; the legacy import (`migrate-v1`, "v1" in its code and docs, which names the old product on purpose).

## (c) Command names

| Item | Result |
|---|---|
| Program name in help, usage lines, hints, completions, docs | `mendcode`. A single module, `packages/program/src/index.ts`, resolves it: `MENDCODE_PROGRAM` if set, else a compiled binary's own file name when it is `mendcode` or `mendcode-<lowercase suffix>` (never a versioned asset name), else `mendcode`. Usage constants interpolate `PROGRAM_NAME`. |
| Developer wrapper `mendcode-next` (`scripts/install-dev.sh`) | keeps its name and keeps working; it now runs `env MENDCODE_PROGRAM=mendcode-next bun ...`, so its help says `mendcode-next`. `uninstall` recognises both the old and the new wrapper text. Completions are registered for `mendcode` and for the name in use. |
| Released binary and installers | `mendcode` / `mendcode.exe`; `scripts/build.ts` and `scripts/perf.ts` write `mendcode`; compiled tests use it |
| Automation schema id `mendcode-next.cli.v1` (`--json` lines, `upgrade`, `uninstall`, `loop`, `github`, `daemon`) | **kept.** `mendcode.cli.v1` already means the legacy-compatible envelope (`--compat`, `apps/cli/src/compat.ts`), so renaming would merge two different contracts. Stored scripts that pin the id keep working. |
| Migration report schema `mendcode-next.migrate-v1@1`, protocol ids `mendcode-app-server@1`, `mendcode-v2-mflow`, memory-sharing format `mendcode-v2` | kept (wire and stored identifiers) |
| Env prefix `MENDCODE_` | stays. `MENDCODE_V2_DIR`, `MENDCODE_V2_ENGINE`, `MENDCODE_V2_JIT`, `MENDCODE_V2_CONPTY`, `MENDCODE_V2_LOCAL_TRANSPORT` keep their names (renaming them breaks running setups; recommendation below). `MENDCODE_NEXT_BIN_DIR` (dev wrapper directory) kept. New: `MENDCODE_PROGRAM`, `MENDCODE_CHANNEL`, `MENDCODE_ALLOW_UNSIGNED`, `MENDCODE_API_BASE` (installers). |
| Service names | launchd label / systemd unit `com.mendcode.v2.daemon` kept (system identity, see d) |
| Daemon socket, lock, endpoint inside the data directory | `mendd.sock`, `mendd.lock`, `mendd.endpoint`, `mendd.db`: kept |

## (d) On-disk identity: nothing changed

| Item | Today |
|---|---|
| Default data directory (`DEFAULT_DIR` in `apps/cli/src/launcher.ts` and `packages/daemon/src/main.ts`, VS Code extension default) | `~/.mendcode-v2`, overridden by `--dir` or `MENDCODE_V2_DIR` |
| Config, cache, state | all inside the data directory (`mendd.db`, `settings`, `tui/`, `upgrade.json`, ...); user extension folder is the data directory itself; project files are `<project>/.mendcode/` |
| Managed binary and its backups | `<data dir>/bin/mendcode-next`, `.prev`, `.new` |
| Installer receipt | `<install dir>/.mendcode-v2-install` with `schema=mendcode-v2.install.v1` |
| Dev wrapper | `~/.local/bin/mendcode-next` |
| Service definitions | `~/Library/LaunchAgents/com.mendcode.v2.daemon.plist`, `~/.config/systemd/user/com.mendcode.v2.daemon.service` |
| Windows trash folder for uninstall | `%LOCALAPPDATA%\MendCodeV2\Trash` |
| Keychain | none: credentials live in the data directory; there is no keychain entry |
| `.gitignore` | `.mendcode-v2/` |

The legacy product owns `~/.mendcode` and `~/.local/share/mendcode` on existing machines; the data directory, its guard (`v1Dirs` in `packages/upgrade/src/install.ts`) and
`migrate-v1` refuse to write there. Moving to those names would shadow real user data.

Recommended migration (not implemented): (1) new installs choose `~/.mendcode` only when no legacy data exists there, otherwise keep `~/.mendcode-v2`; (2) an explicit
`mendcode migrate` moves a `~/.mendcode-v2` directory to the new name, renames `bin/mendcode-next*` to `bin/mendcode*`, the receipt, the service label and the Windows trash folder together,
leaves a pointer file for one release, and refuses while a daemon holds `mendd.lock`; (3) add `MENDCODE_DIR` as the documented spelling of `MENDCODE_V2_DIR` and the other `MENDCODE_V2_*` variables,
reading both for two releases, so scripts do not break; (4) only then drop the schema id question (`mendcode-next.cli.v1`) with a `schema` selector, since `mendcode.cli.v1` is taken.

## (e) Versions: changed

| Item | Was | Now |
|---|---|---|
| `apps/cli/package.json` version (the only workspace package with a product version; the others are `0.0.0`) | `2.0.0-dev` | `0.0.1-dev` |
| Fallbacks `server.health`, REST session `version`, OpenAPI `info.version`, `mendcode-web` hello, release-control current version | literal `2.0.0` / `2.0.0-dev` | `DEV_VERSION` (`0.0.1-dev`) from `@mendcode/program` |
| Changelog entries, test harness versions, render scripts | `2.0.0-dev`, `2.0.0`, `v2.0.1` | `0.0.1-dev`, `0.0.1`, `v0.0.2` |
| Docs and examples (`mendcode-2.0.0-linux-x64`, `MENDCODE_VERSION=2.0.0`) | major 2 | `mendcode-0.0.1-linux-x64`, `v0.0.1`, nightly examples |
| Upgrade tests with `2.0.0-beta.N` | assumed a next major | generic newer-minor versions; `parseVersion` and `compareSemver` never compared against a fixed major |

Checked and independent of the product version: storage format versions and the schema fingerprint of `release-index.json` (`SCHEMA_VERSION`), the protocol version, rollback
compatibility (compares fingerprints, not versions). The version-skew check compares build ids, not versions.

## Nightly channel end to end

Installers accept `vX.Y.Z-nightly.YYYYMMDD.RUN` with the validation `release.yml` and the updater use, take `--channel` / `MENDCODE_CHANNEL`, and pick the newest nightly. Cosign verification
is mandatory (`MENDCODE_ALLOW_UNSIGNED=1` is the explicit opt-out, only for a missing `cosign`). The updater defaults to `MendCode/MendCode`, reads `GH_TOKEN` / `GITHUB_TOKEN` / `gh auth token` for a
private repository, and verifies releases without GitHub provenance through the cosign bundles (`--allow-unsigned` is the explicit opt-out, only for a missing `cosign`). See [release.md](../release.md) and [upgrade.md](../upgrade.md).
