# Upgrading MendCode

`mendcode upgrade` replaces the installed binary with a release from GitHub Releases (`MendCode/MendCode` unless `MENDCODE_UPGRADE_REPO` says otherwise). It never starts, stops or signals a process, and it never touches the legacy MendCode data (`~/.mendcode`, `~/.local/share/mendcode`). The program name in help is the one you typed (`mendcode`, or the name of a wrapper such as `mendcode-next`).

```
mendcode upgrade [target] [--channel stable|beta|dev|nightly] [--method direct|curl] [--inspect|--set] [--check] [--force] [--require-signature] [--rollback] [--json] [--dir D]
```

| Flag | Effect |
|---|---|
| (none) | install the newest release of the remembered channel (`stable` until you pick another) |
| `--channel C` | choose the channel; it is remembered in `<data dir>/upgrade.json` |
| `target` | an exact version/tag, or `latest`; exact targets resolve by tag, including older releases outside the latest 100 |
| `--require-signature` | refuse to install without a verified cosign signature; without it, a missing `cosign` means the SHA256 check alone, and the result says so (a signature that fails is always refused; an install only) |
| `--allow-unsigned` | accepted for older scripts; the SHA256 check alone without `cosign` is now the default |
| `--method M`, `-m M` | `direct` or `curl` uses the verified binary installer; npm/pnpm/bun/brew/choco/scoop upgrades fail before networking because no packages are published |
| `--inspect` | read local channel/version/recovery metadata and verify rollback availability, without network or writes |
| `--set --channel C` | persist the channel without checking or installing |
| `--check` | only report; nothing is downloaded or written (the channel is not remembered either) |
| `--force` | install even when already up to date, or when the release is older than the running version |
| `--rollback` | go back to the previous binary; running it again returns to the newer one |
| `--json` | one line `{"schema":"mendcode-next.cli.v1","kind":"result"\|"error","command":"upgrade",...}` |
| `--dir D` | data directory, like the rest of the CLI (`--dir`, else `MENDCODE_V2_DIR`, else `~/.mendcode-v2`) |

Exit codes: 0 ok, 1 failure, 64 usage error.

## Channels

| Channel | Tags | GitHub flag | Newest is decided by |
|---|---|---|---|
| `stable` | `vX.Y.Z` | release | semver |
| `beta` | `vX.Y.Z-beta.N` | prerelease | semver (`beta.10` is newer than `beta.9`) |
| `dev` | `dev-<shortsha>` | prerelease | publication time |
| `nightly` | `vX.Y.Z-nightly.YYYYMMDD.RUN` | prerelease | version, date, then numeric run |

The first releases are `v0.0.1-beta.N`, then `v0.0.1`; nightly tags (`vX.Y.Z-nightly.YYYYMMDD.RUN`) are published by `nightly.yml` each day `main` changed ([releases](release.md#channels)). `mendcode upgrade --channel beta` installs the newest beta, and `--channel nightly` the newest nightly, of `MendCode/MendCode` with no environment variable and remembers the channel; `--check` only reports. The same tag shapes are accepted by `install.sh` / `install.ps1` ([release.md](release.md#channels)).

A tag whose shape and prerelease flag disagree (for example `v1.2.3` marked prerelease), drafts and other tags are ignored. Channels are separate: a `beta` user does not receive `stable` releases, run `upgrade --channel stable` to change. At the same `X.Y.Z` a nightly is older than the stable release of that version.

The running version is compared with the newest release of the channel. A newer release is an update, the same one is "up to date", an older one is "ahead" and is not installed unless `--force` or an exact older target is given. A dev build is identified by its `dev-<sha>` tag (no ordering). A version that cannot be compared, such as the checkout's `0.0.1-dev`, is offered the update.

## Where the binary goes

Assets of a release: direct binaries `mendcode-<version>-<os>-<arch>` for `darwin|linux` and `arm64|x64` (from `process.platform` / `process.arch`), plus `SHA256SUMS`. Version is the release tag without its leading `v` (a dev tag stays unchanged). No archives are required. The initial install scripts use the same asset names and checksum contract; their installed command is `mendcode`, while upgrade retains the paths below (the managed binary keeps the file name it has always had inside the data directory; renaming on-disk names is a separate, planned migration).

```
<data dir>/bin/mendcode-next        the installed binary (mode 755)
<data dir>/bin/mendcode-next.prev   the binary it replaced (for --rollback)
<data dir>/bin/mendcode-next.new    staging only, removed on failure
<data dir>/upgrade.json             {"channel","lastCheckAt","lastVersion"}
```

The new binary is staged as `.new`, the current one is copied to `.prev`, then `.new` is renamed over `mendcode-next`. The rename is atomic, so the command always exists with complete content. Nothing outside the data directory is written, and a data directory inside a legacy MendCode location is refused.

`<data dir>/bin` is not added to `PATH`. Run the binary by its path or link it yourself; `scripts/install-dev.sh` (a wrapper around a checkout) is unrelated and untouched.

After installing, an open terminal moves to the new build by itself (macOS and Linux): it checks its own binary every 20 seconds and, when the file was replaced, says so right away with `✓ Update installed · /restart to update` on the right of the prompt's top rule (it takes no row, so nothing above the prompt moves; a prompt without that rule shows it right-aligned on a row of its own), and restarts in place on the same chat (then `✓ Updated to the new build` takes that same place until the first key, so a restart nobody watched is still seen) once that interrupts nothing of its own: no turn running in its chat, nothing typed in the prompt, the chat showing, and no key for 10 seconds. Turns of other chats run in the daemon and do not hold it back; a terminal that hosts the daemon itself still waits for all of its work. Until then it keeps running as it is. It is the same process (same pid, same terminal tab), not a second one. A chat with no messages comes back as a new empty chat. On Windows, or started with `--isolated`, `--ephemeral` or attached to a remote daemon, restart `mendcode` yourself. The background daemon is replaced on the next launch once it is idle (the existing version-skew check); `mendcode --restart-daemon` does it immediately.

## Version skew

A daemon keeps running after the client is updated (or its source edited). Client and daemon compare build ids in the handshake, on launch and after every reconnect. A release build carries its own id. A development run hashes the sources the daemon runs (`packages/*/src`, prompts, built-ins, `apps/cli/package.json`), so a terminal-only edit does not make a daemon look old; `scripts/build.ts` also hashes `apps/cli/src` for release binaries.

- Older and idle (no turns, background jobs, running loops or other attached client): it is restarted without a notice (there is nothing to do about it; `/daemon` shows the build that runs). This happens once per run; a second mismatch means the terminal is the older side.
- Older and in use: nothing is stopped and nothing is said; it keeps working and is replaced the next time a terminal finds it idle. `/daemon` says `(older than this terminal)`.
- `/daemon restart` (or `mendcode daemon restart [--force]`) restarts it on request, refusing while work runs unless `--force`; `/daemon` shows its build and work.
- `/restart` restarts this terminal from the installed build, on the same chat (drafts kept, extensions stopped first). The daemon and the other terminals keep running; a daemon older than the new build is then replaced by the check above once it is idle. While this session's response runs, `/restart` waits for it: `/restart waits for the current response · esc cancels` stands over the prompt and the restart happens when the turn ends (Esc drops the wait and leaves the response running). A terminal that hosts the daemon itself restarts only when no other work runs, and says so otherwise. Where a process cannot replace itself (Windows) it says to reopen.
- `/reload` reads this session's resources again with no restart: the daemon reloads the project's extensions and their MCP servers, and this terminal its keybindings, extensions, enabled packages' activation and theme files. Skills, custom commands and context files are read again at each turn already. It waits for a running response the same way and interrupts nothing; since one daemon serves every terminal, the others pick up the reloaded extensions too, without restarting.
- `/daemon restart` on a busy daemon restarts it once its running work ends (`daemon.shutdown` with `whenIdle`, `restartPending` in its status); every terminal's reconnect starts the installed build, and until then the terminal shows `daemon restarts on the new build when its running work ends`.
- A command the daemon cannot parse, which the client built itself, shows `daemon rejected <command> · it may be an older build · /daemon restart`; the schema detail goes to the debug log (`--log-level DEBUG`).

## Verification

The downloaded binary's sha256 must equal its unique line in the release's `SHA256SUMS` before anything is written. A missing `SHA256SUMS`, a missing entry for the version/platform, duplicate entries or a mismatch refuses the install with an error and leaves the installed binary alone. Downloads must be https and are size-limited.

Installation also requires a `release-index.json` that binds repository, release tag, channel, binary digest/size and storage compatibility, and one of two proofs, chosen by what the release carries:

- **cosign signature** (every release `release.yml` makes carries the bundles; they verify offline and need no GitHub account): the updater verifies `SHA256SUMS` against `SHA256SUMS.sigstore.json` and the binary against `<asset>.sigstore.json` with `cosign verify-blob`, pinned to `https://github.com/<repo>/.github/workflows/release.yml@refs/tags/<tag>` and the GitHub Actions OIDC issuer. The release index must then match its digest in the signed `SHA256SUMS`. A missing bundle blocks the install.
- **GitHub provenance** (only a release with `provenance.sigstore.json` and no cosign bundles): the updater verifies both index and binary with `gh attestation verify`, pinned to the repository, release workflow and source tag, refusing self-hosted runners. It needs a signed-in `gh`, which is why the cosign bundles come first.

On Darwin it also requires `codesign --verify --strict`. A missing index or bundle and an invalid signature block activation. Verification uses isolated temporary files (a temporary `GH_CONFIG_DIR`, `TUF_ROOT` and cache); no verifier output or token is returned to the CLI. When `cosign` is not installed, `mendcode upgrade` installs after the SHA256 check alone, prints `WARNING: verified by SHA256 only` with how to get the signature checked, and records `"verification":"checksum-only"` in the `--json` result; `--require-signature` refuses instead. Nothing else relaxes verification: a signature that fails, a missing bundle and a digest mismatch are always refused, and the automatic updater (`autoupdate`) always requires the signature, so it installs nothing on a machine without `cosign`.

## Private repository

A private repository (a fork, or a mirror of one) answers anonymous requests with 404. The updater reads a token from `GH_TOKEN`, then `GITHUB_TOKEN`, then `gh auth token` (the GitHub CLI after `gh auth login`); a token that can read the repository's contents is enough. The token is sent only to `api.github.com`: assets are downloaded through their API endpoint, whose redirect to signed storage is followed without the token. Without a token, an API 404/401/403 says to sign in with `gh auth login` or set `GH_TOKEN`. Public repositories and mirrors need no token. The installers use `gh` for the same purpose ([release.md](release.md#installing-from-a-private-fork-or-repository)).

`upgrade-recovery.json` records the attested identity of the current and retained binary. Rollback is offline and checks both executable hashes and equal storage source fingerprints before swapping them. Legacy/unrecorded binaries, modified retained bytes or different schema fingerprints require external recovery; no database or user data is restored. The updater serializes activation, rollback and channel changes with `<data dir>/upgrade.lock`. After a crash, inspect its recorded PID before recovering the lock.

## Configuration

| Setting | Where |
|---|---|
| `MENDCODE_UPGRADE_REPO=owner/name` | environment; wins over the constant |
| `UPGRADE_REPO` | `packages/upgrade/src/settings.ts`; `MendCode/MendCode` |
| `GH_TOKEN`, `GITHUB_TOKEN`, `gh auth token` | credentials for a private repository, read in that order |

The environment variable is for a mirror, a fork or a test repository. Legacy `OWNER/mendcode` values are refused, and a malformed `owner/name` cannot steer the request to another URL.

## Release pipeline

`.github/workflows/release.yml` handles pushed `v*` / `dev-*` tags and manual dispatch from an existing tag. It checks once, builds five versioned binaries on native runners, smokes each artifact, generates a CycloneDX SBOM, signs payloads and `SHA256SUMS` with cosign keyless, and creates the release (prerelease for beta, nightly and dev). GitHub provenance is enabled for public repositories and explicitly skipped for private ones, whose releases are verified through the cosign bundles. See [release.md](release.md) for the release procedure, permissions, verification and OS trust limits.

Each binary includes the CLI, daemon and packaged resources; no checkout or separate Bun install is required to start
the daemon. See [automation.md](automation.md#standalone-binary) for build flags and the opt-in compiled smoke.

## Not done yet

- The first public release is the real canary of the public path: anonymous downloads, GitHub provenance and the installers' `curl | sh` form. The private betas ran the workflow end to end, but the updater and the installers were tested against fakes for every public case.
- No `PATH` setup for the managed binary. The PowerShell installer supports Windows (it could not be parsed or run where this was written, `pwsh` being unavailable), but upgrade and the complete daemon smoke still support Darwin/Linux only.
- GitHub/Darwin verification awaits published assets.
- Only the newest 100 releases of the repository are read.

`mendcode update` aliases `upgrade`. v1-style `upgrade channel` and `upgrade channel set C` inspect/set the preference locally. An exact target and `--channel` are mutually exclusive; a target does not change the saved channel.

## Terminal and automatic checks

`/release-channel` inspects the saved channel locally. Arrow keys select; Enter saves without installing; `c` checks for updates; `a` cycles automatic policy; Escape returns to chat. `PgUp/PgDn` scroll the compact layout. Direct forms: `/release-channel nightly`, `/release-channel check`, `/release-channel autoupdate off|notify|on`. Key hints stay in the header. Read-only remote peers can inspect only; checks, channel changes and policy changes require a full-access token. No listener or authentication policy is added.

`settings.autoupdate` accepts `false`, `"notify"` or `true`; unset means **off**. Opting in performs one daemon-start check, and changing the setting wakes a check. `notify` pushes an update notification without installation. `true` may silently install a newer stable patch in the same major/minor only while the daemon is idle. Beta/nightly/dev, major/minor changes and prerelease running versions only notify. Verification failures preserve the installed binary; policy and activity are rechecked before activation. Restart is explicit, never forced. Checks share an in-flight request; there is no polling timer. New terminals receive the daemon's last update notice during their handshake.

Protocol: `release.inspect`, `release.set`, `release.check`; pushed `release.available` reports availability or a completed installation. The zod-free client entry provides the channel constants and report types; views load lazily.
