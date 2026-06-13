---
name: mendcode-release-flow
description: Use for MendCode project changes, release prep, PR promotion, version bump decisions, changelog updates, installer validation, and dev-to-main synchronization. Trigger whenever work may ship to users, touches package metadata/versioning, installer/update/health/changelog behavior, or the user mentions bumping a version, release, changelog, PR to dev/main, or letting the user test before shipping.
---

# MendCode Release Flow

Follow this workflow for MendCode changes that may ship.

## Non-negotiables

- Preserve unrelated local changes. If the active checkout is dirty, use a clean worktree from `origin/dev` or `origin/main`.
- Before editing release/version/package files, ask or verify whether another agent already bumped the version locally or remotely.
- Do not publish a release, merge to `main`, or overwrite a user worktree without explicit user intent.
- Never leave open public PRs/issues as noise. Close, merge, or explain exactly why they must remain open.

## Standard Flow

1. Inspect `git status`, `git worktree list`, open PRs/issues, latest GitHub release, `origin/dev`, and `origin/main`.
2. If a version bump may be needed, determine whether the bump already exists:
   - Check `CHANGELOG.md`.
   - Check `src/mendcode/packages/opencode/package.json`.
   - Check extension/package metadata such as `src/mendcode/packages/extensions/zed/extension.toml`.
   - Check recent merged PRs and tags.
3. Ask the user before choosing a new version unless the version is already clearly bumped by another agent.
4. Implement the change in a branch based on `origin/dev`.
5. Run focused tests/scripts for the touched area. For release-affecting changes, also run the release/installer validation path when feasible.
6. Stop and let the user test locally when the change is user-visible. Do not bump/changelog/merge until the user says it works, unless they explicitly ask for fully autonomous shipping.
7. After the user confirms it works:
   - Bump version if needed.
   - Add or update `CHANGELOG.md`.
   - Open a PR to `dev`, wait for CI, and merge.
   - Promote `dev` to `main` with a PR, resolving conflicts deliberately.
   - Sync `main` back to `dev` if needed so both branches have the same tree.
8. If releasing:
   - Use the Release workflow from `main`.
   - Verify SHA256SUMS.
   - Publish with real release notes/changelog, not only a SHA.
   - Smoke-test the public installer in a temporary `HOME`.

## Required Checks

- For code: run the narrow test file or command covering the changed path.
- For release: verify `mendcode --version` prints the release version.
- For installer: test `curl -fsSL https://raw.githubusercontent.com/MendCode/MendCode/main/src/mendcode/install | bash -s -- --no-modify-path` in a temporary `HOME`.
- For branch hygiene: verify open PRs/issues, latest release, and `git diff origin/main..origin/dev`.

## Reporting

Report only facts that were verified: PR numbers, release URL, version, test commands, and installer result. If the user asked not to report process, keep the final short.
