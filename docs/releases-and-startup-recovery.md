# Stable, beta and startup recovery

The stable hotfix and the beta runtime are separate releases:

| Release | Scope |
| --- | --- |
| 0.1.44 stable | Bounded, phase-aware backend startup; recorded-schema downgrade rejection; PowerShell installer parsing |
| 0.1.44-beta.2 | The startup fix plus release channels and opt-in continuity from beta.1 |

The version sections describe the release candidates; availability is determined
by the published [GitHub releases](https://github.com/MendCode/MendCode/releases).
Prereleases never replace GitHub's latest stable release. Published tags and
artifacts are immutable. New experimental capabilities require explicit opt-in.

## Large session histories

Beta.1 could stop a newly spawned backend after eight seconds while it was still
creating a consistent pre-migration snapshot. A startup connection failure alone
does not mean that session records have been deleted.

The fix identifies the child process and startup token, permits up to 15 minutes
for backup or migration, and displays the preparation phase. Connection after
database preparation has a separate 30-second deadline. Failed/exited processes
stop the wait. No additional database writer is used to bypass the failure.

Close active clients normally before an upgrade. Do not delete session files or
locks, restore an incomplete snapshot, or start independent writers as a workaround.
Retain recovery artifacts until a successful launch and session-preservation check.

## Choosing a release

Stable installations continue receiving stable updates. Channel selection is
available in the beta runtime:

```sh
mendcode upgrade channel set beta
mendcode upgrade --check
mendcode upgrade
```

Selecting a channel saves a preference; it does not install a version. Installing
an explicit version does not change the preference. Beta users should stay on beta
until a stable release supports their database schema. This stable hotfix refuses
incompatible recorded schemas before writing; it does not restore older data.

For installations predating channels, use the installer pinned to the desired
published release tag and specify its version, following that release's notes.
Do not use a mutable main-branch installer for historical versions.

The detailed beta configuration is documented on
[dev](https://github.com/MendCode/MendCode/blob/dev/docs/release-channels-and-continuity.md).
Beta keeps native OpenAI async transport and other unverified integrations disabled.
Manual prereleases run from dev. The nightly schedule becomes active only when its
workflow is promoted to the default branch. Stable promotion requires explicit
approval and verified candidate artifacts; passing time is not a promotion gate.
