---
name: mendcode-release-flow
description: Use for MendCode project changes, release prep, PR promotion, version bump decisions, changelog updates, installer validation, and dev-to-main synchronization. Trigger whenever work may ship to users, touches package metadata/versioning, installer/update/health/changelog behavior, or the user mentions bumping a version, release, changelog, PR to dev/main, or letting the user test before shipping.
---

# MendCode Release Flow

Follow this workflow for MendCode changes that may ship.

## Non-negotiables

- For maintainer/agent work inside the main MendCode repository, use the local `dev` branch by default. Do not create a separate branch unless the user explicitly asks for one, the current worktree has unrelated changes in the same files, or a GitHub contribution flow requires it.
- Preserve unrelated local changes. If the active checkout is dirty, inspect the touched files first. Work in-place on `dev` only when the requested files are clean or the existing edits are clearly part of the same user-approved task.
- If unrelated dirty files conflict with the task, stop and explain the blocker before creating a worktree or branch.
- Before editing release/version/package files, ask or verify whether another agent already bumped the version locally or remotely.
- Do not publish a release, merge to `main`, or overwrite a user worktree without explicit user intent.
- Never leave open public PRs/issues as noise. Close, merge, or explain exactly why they must remain open.
- Never hide security/release failures. If a supply-chain, secret, CodeQL, release, or installer check fails, keep the issue open until fixed or document the exact reason it is accepted.

## Branch Policy

- Internal MendCode maintainers and local agents work on `dev` by default.
- External contributors should use a fork or feature branch and open a PR targeting `dev`, not `main`.
- `main` is the public release branch. Only promote `dev` to `main` after CI passes, the user-visible change has been tested, version/changelog state is correct, and the user intends to ship.
- Do not merge random branches directly into `main`. Bring useful branches back through PRs to `dev`, then delete stale branches after merge.
- Before starting, check whether another PR/agent already contains the same work. Prefer continuing the existing local `dev` work over creating a duplicate branch.

## Standard Flow

1. Inspect `git status`, `git worktree list`, open PRs/issues, latest GitHub release, `origin/dev`, and `origin/main`.
2. If a version bump may be needed, determine whether the bump already exists:
   - Check `CHANGELOG.md`.
   - Check `src/mendcode/packages/opencode/package.json`.
   - Check extension/package metadata such as `src/mendcode/packages/extensions/zed/extension.toml`.
   - Check recent merged PRs and tags.
3. Ask the user before choosing a new version unless the version is already clearly bumped by another agent.
4. Implement the change on local `dev` unless the Branch Policy says a separate branch/worktree is required.
5. Run focused tests/scripts for the touched area. Use existing repo scripts and generated-client/build checks when relevant.
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
- For supply chain: verify secret scan, dependency review/vulnerability checks, CodeQL/Semgrep, and release artifact checksums before publishing.
- For branch hygiene: verify open PRs/issues, latest release, branches, and `git diff origin/main..origin/dev`.
- For local safety: before committing, review `git diff --name-only` and stage only files intentionally changed for this task.

## Reporting

Report only facts that were verified: PR numbers, release URL, version, test commands, and installer result. If the user asked not to report process, keep the final short.
