# Changelog

What changed for MendCode users, newest first. Every user-visible change adds an item under `## Unreleased` in the same pull
request; a release reads its notes from here and fails without them ([release notes](docs/release.md#release-titles-and-notes)).

A section is a summary paragraph and items under `### New`, `### Changed`, `### Fixed`, `### Upgrade notes` and
`### Known limitations` (only the groups that apply). Cutting a stable or beta release renames `## Unreleased` to its tag
(`## v0.0.2 - 2026-11-03`) and starts a new empty one; nightlies take the items they add to `## Unreleased`.

## Unreleased

Releases are easier to read: a plain title and notes that say what changed.

### Changed

- Release titles name the channel and version ("MendCode v0.0.2 Beta 4", "MendCode Nightly — 2026-10-29 · Build 2") instead of
  the bare tag, and the notes list what changed since the previous release of the same channel, with install and verify steps
  and the full changelog folded away. Tags, assets and the updater are unchanged.

### Fixed

- A nightly run no longer fails when its run number is already taken by a nightly tag of the same day.

## v0.0.2-nightly.20261029.2 - 2026-10-29

Goals stop when they stop making progress, and the pull request reviewer no longer loses or repeats requests.

### Fixed

- Goals: a turn counts as progress only when a tool call succeeds with a call and result the goal has not seen yet. Three
  turns without progress, or 100 unattended goal turns, stall the goal instead of letting it loop; the steering says the
  objective beats an earlier stop rule.
- PR review: a notice that arrives while the session is busy is held and shown when it goes idle, instead of being dropped.
- PR review: an `@mendcode` command that cannot be answered yet (no `/pr publish on`, or `publishers` does not allow this
  login) is kept and answered once that changes, exactly once, also across restarts.
- PR review: `/pr publish on|off` holds for the repository; before, it could land on a stopped watch and the running one kept
  waiting.
- PR review: a kept `@mendcode review` whose head already has a review by your login or a publisher is answered by that review
  instead of reviewing again.
- PR review: `enabled`, `publishers` and `reviewers` are read from the base branch's current tip, so a pull request opened before
  `.mendcode/review.yaml` was added follows it.
- PR review: review sessions get no shell, skills or instruction files, and a refused read says which files may be read.

### New

- PR review: `reviewers` in `.mendcode/review.yaml` takes a list of logins, the team whose `@mendcode` comments are answered.
  It grants no write access and no publishing; `all` and `requested` keep their meaning.

## v0.0.2-beta.3 - 2026-10-29

Pull request reviews no longer fail on large pull requests or on several reviews of one repository at once.

### Fixed

- PR review: reviews of one repository check out one at a time; parallel fetches and worktree adds on one `.git` failed on its
  locks.
- PR review: a review prompt longer than a message may be (a large pull request) goes whole into a text attachment instead of
  failing with "the message could not be stored".

## v0.0.2-beta.2 - 2026-10-29

The first beta of 0.0.2: pull request reviews explain the change and its merge risk, several reviewers can share one repository,
and headless JSON runs end cleanly.

### Fixed

- `mendcode run --format json` ends on the turn's result; an idle state that arrived before the run settled is no longer printed
  after it.

## v0.0.2-beta.1 - 2026-10-29

Not released: its release smoke test failed on the headless JSON run that v0.0.2-beta.2 fixes, so its changes first shipped in
v0.0.2-beta.2.

### New

- PR review: a walkthrough of the changes by layer with a sequence diagram, the change type, the merge risk with its reason, and
  pre-merge checks of the title, description and linked issues.
- Many reviewers on one repository: `publishers` in `.mendcode/review.yaml` decides who may post; a reviewer stands down when
  another already reviewed the head or answered the comment; `@mendcode <command> @login` addresses one developer's reviewer.

### Changed

- PR review: the token budget no longer counts the provider's cache reads.
- Channels: `beta` also takes a newer stable release, and `nightly` a newer beta or stable one.

## v0.0.1 - 2026-10-29

The first public release of MendCode, a coding agent for the terminal.

### New

- One daemon keeps your sessions, and any number of terminals attach to them.
- A native engine with the models you connect, or Claude Code, Codex, ACP agents and pi behind the same screen.
- A code graph so the model reads less, and long conversations packed instead of forgotten.
- Pull request reviews.
- Installers for macOS, Linux and Windows that check the SHA256 and, with cosign installed, the release signature; stable, beta
  and nightly channels; `mendcode upgrade` to update, switch channel or roll back.
- Docs: what each prompt mode sends for the model's provider family, how auto picks it and how to force one.
