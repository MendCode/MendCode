# Changelog

What changed for MendCode users, newest first. Every user-visible change adds an item under `## Unreleased` in the same pull
request; a release reads its notes from here and fails without them ([release notes](docs/release.md#release-titles-and-notes)).

A section is a summary paragraph and items under `### New`, `### Changed`, `### Fixed`, `### Upgrade notes` and
`### Known limitations` (only the groups that apply). Cutting a stable or beta release renames `## Unreleased` to its tag
(`## v0.0.2 - 2026-11-03`) and starts a new empty one; nightlies take the items they add to `## Unreleased`.

## Unreleased

A new install's setup signs MendCode in for itself and no longer leaves you at a prompt with no model; the pull request reviewer
keeps working when the daemon starts with a short `PATH`, and a paused watch resumes by itself without losing requests.

### New

- Own logins for new installs (`ownLogins`): the first setup of a new install signs MendCode in for itself. ChatGPT runs in
  MendCode's engine with `/connect chatgpt`, and the Codex CLI's login file is not read. Claude models run in Claude Code with a
  profile of MendCode's own (`CLAUDE_CONFIG_DIR=<data dir>/claude-code`), signed in with `mendcode claude login` (Claude Code's
  own `claude auth login` for that profile), apart from `~/.claude`.
  Nothing of another tool is copied or adopted. Installs set up before keep the logins they used.

### Changed

- Release titles name the channel and version ("MendCode v0.0.2 Beta 4", "MendCode Nightly — 2026-10-29 · Build 2") instead of
  the bare tag, and the notes list what changed since the previous release of the same channel, with install and verify steps
  and the full changelog folded away. Tags, assets and the updater are unchanged.

### Fixed

- A nightly run no longer fails when its run number is already taken by a nightly tag of the same day.
- Claude Code sessions: a background sub-agent stopped by esc no longer vanishes from the Agents strip. Its row says
  `stopped by you · /relaunch`, and `/relaunch` asks Claude to start it again with the same prompt, told how far it got
  (Claude Code itself refuses to resume an agent an interrupt stopped).
- Claude Code sessions: an agent Claude Code sends to the background on its own is shown and followed as a background agent,
  instead of reading as done the moment it was launched.
- Claude Code sessions: the first message after esc stopped background agents is answered. Claude Code first answers its own
  notice that those agents did not finish, with an empty result, and that result used to end the message's turn with no reply.
- The daemon finds `gh`, `git`, `claude` and `codex` installed with Homebrew however it was started. A daemon restarted with a
  short `PATH` (`env -i`, launchd, systemd) paused every PR review watch on "gh is not installed or not on PATH" while `gh` was in
  `/opt/homebrew/bin`. At start it now adds the usual install folders that exist and your login shell's `PATH`; only `PATH` is read
  from that shell.
- PR review: a watch paused because `gh` is missing or logged out tries again every 5 minutes and at the daemon's first tick, and
  resumes by itself with a notice. The PRs opened, the pushes and the `@mendcode` comments of the pause are handled then; before, it
  waited for `/pr watch-repo`, which took the PRs open at that moment as the baseline.
- PR review: `@mendcode` comments are read page by page, so more than 100 new comments since the last poll no longer drops the rest.
- Setup: a first launch with no usable model is not marked done. Esc or Enter leaves it open for the next launch, and the minimalist
  preset opens the page instead of a prompt no model answers. Upgrades and reinstalls keep their finished setup.
- Setup: Claude Code is shown as installed, signed in, and with its plan only when `claude auth status` reports one; before, a
  `claude --version` that answered read as "installed, signed in". Each model says who runs it and whose login pays.
- Claude Code turns that fail on "Not logged in" give the official login command of the profile in use instead of Claude Code's
  own `/login`.

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
