# Changelog

What changed for MendCode users, newest first. Every user-visible change adds an item under `## Unreleased` in the same pull
request; a release reads its notes from here and fails without them ([release notes](docs/release.md#release-titles-and-notes)).

A section is a summary paragraph and items under `### New`, `### Changed`, `### Fixed`, `### Upgrade notes` and
`### Known limitations` (only the groups that apply). Cutting a stable or beta release renames `## Unreleased` to its tag
(`## v0.0.2 - 2026-11-03`) and starts a new empty one; nightlies take the items they add to `## Unreleased`.

## Unreleased

MendCode signs in to ChatGPT for itself with OpenAI's Sign in with ChatGPT, keeps its own list of the models your account can use,
and Claude models on a new install run in the Claude Code you already have signed in; the setup no longer leaves you at a prompt with
no model, and the pull request reviewer keeps working when the daemon starts with a short `PATH`.

### New

- Sign in with ChatGPT: `/connect chatgpt` (or `control-plane auth login --provider chatgpt --method browser --execute`) shows a
  link; you sign in in the browser, allow MendCode to use your ChatGPT plan, and MendCode keeps a login of its own. No client id is
  shipped or needed: OpenAI registers MendCode for your account on the first sign-in, and you can limit or revoke it in ChatGPT →
  Settings → Usage. Requests on that login go to `api.openai.com` and count against your plan. The link stays open 15 minutes.
- Own ChatGPT login for new installs (`ownLogins`): the first setup of a new install makes MendCode's engine sign in to ChatGPT
  only with `/connect chatgpt`; the Codex CLI's login file is not read, not even on the daemon's first start before the setup.
  Installs set up before keep it as a fallback.
- PR review: `.mendcode/review.yaml` can start from a preset (`preset: balanced | quiet | strict | on-request | autofix`); the
  file's own keys go over it, and no preset turns posting on, adds checks, widens who may post or pushes.
- PR review: `budget.tokens_per_pr: null` means no internal cap, and `budget.context_tokens` bounds what one call carries (200,000
  when unset), apart from the PR's total.
- PR review: `/reviews` (or `/pr dashboard`) opens a page of review jobs, reviewers and watches. From it you can pause, resume,
  cancel or retry a job (a retry needs a reason), take a job over and release it, and show a job's config.
- PR review platform:
  - A review stopped by its token budget, a quota or a rate limit keeps what it found and is resumed without a second review
    pass: on retry, or after the quota reset with `on_quota: wait`.
  - `mode` and `filters` decide which PRs are reviewed; `/pr list` shows the reason for each PR not taken.
  - `.mendcode/reviewers.yaml` routes PRs to the global reviewer and to personal reviewers. A personal reviewer whose MendCode runs
    elsewhere waits with its reason, and its own daemon reviews the PR when it starts. Device claims on the PR are best-effort,
    not compare-and-swap.
  - Personal profiles can only narrow the repository's config. The config actions and the `review_config` tool always need a
    scope.
  - Review memory follows the reviewer's scope.
  - `fix.mode` `fix-once` and `fix-loop` push only with `fix.push` and `/pr publish on`; otherwise the fix is kept on a local ref.
  - Stages are planned for each run, and a stacked PR is reviewed on its own commits.
  - Token accounting is kept per PR head.
  - An audit of the whole checkout stays in the session; it is a `pr.review` action, with no slash command.
  - GitLab (through `glab`) and Gitea / Forgejo (`GITEA_TOKEN`) are supported: the daemon watches, posts reviews, answers
    `@mendcode` and pushes fixes through their adapters. This ran live against local GitLab CE 19.5.3 and Gitea 28.2.0. They have
    no check follow-ups and no hosted runner, and Gitea has no thread resolution
    ([providers](docs/pr-review.md#providers)).
  - `template.language` (default English, set by the repository only) is the language of every review, verify, fix and
    `@mendcode explain` reply, on every engine. Your own harness language setting no longer reaches a public review. With `auto`,
    a PR is reviewed in its author's language, judged once from the PR's title and description and kept for the PR. A short,
    empty, mixed or unclear text is English.
  - Open PRs when a watch starts: when a watch starts, after a daemon restart and after a pause or outage, open PRs whose head has
    no review yet are reviewed, newest first. That is at most `backlog.max_prs` (10), updated within `backlog.window_days` (30),
    and `/pr watch-repo` lists what it queued and what it skipped. `max_prs: 0` keeps the old baseline.
  - Set up PR review with your session: `review_config` `setup` reports what exists, the signals of your role, what is missing
    and the questions to ask. It is read-only.
  - The `pr_review` tool reviews a PR now from a session (`review` asks your approval outside full access, and `status` lists the jobs). It posts only
    as `/pr publish` allows, and a session never posts `@mendcode` from your account to start a review.
  - `.mendcode/reviewers.yaml` capabilities `review`, `fix` and `publish` are enforced, and a reviewer without the list has all
    three. A `requested` watch also takes PRs that area or label routing gives its login's personal reviewer.
  - Logins in `reviewers.yaml` and in `review.yaml`'s `reviewers` and `publishers` follow the checkout's forge, so GitLab and Gitea
    usernames with `_` or `.` can be listed.
  - A diff too large for one call is reviewed in parts of whole files (at most 12), and their candidates go to one verify pass.
  - A team setup guide covers the hosted workflow, an always-on server with personal reviewers on laptops, what happens while a
    laptop is off or asleep, and troubleshooting ([team setup](docs/pr-review-setup.md)).
- `grep` takes `context` (0 to 5): the lines around each match come back as `path-line-text`, with `--` between groups, with
  ripgrep and with the built-in search alike, so one search can replace the read that would follow it. The 500-match cap and the
  count still read matching lines only.
- `edit` takes `edits: [{oldString, newString}]` (up to 50): several replacements in one file, in order, in one write. The first
  one that does not match stops the call before anything is written and says which (`edit 2 of 3: …`); `replaceAll` covers every
  replacement of the call. A pasted secret's marker works inside `edits` as it does in `oldString`/`newString`.
- Mermaid flowcharts with `subgraph` are laid out like the rest: boxes in layers with straight arrows, each subgraph a frame with
  its title in the border, nested subgraphs nested frames. Before, every box of such a diagram was stacked in one column with a
  side channel per connection. A left-to-right one too wide for the chat is drawn top-down instead.
- PR review: `prReview.concurrency` (1 to 4, default 2) sets how many reviews this device runs at once, across every watched
  repository. It is a per-device setting that a config bundle or a remote client never changes, and `/pr watch-repo list`, the
  status and `/reviews` show it ([concurrency](docs/pr-review.md#concurrency)).
- PR review: an opt-in offline fallback (`routing.offline_fallback` in `.mendcode/reviewers.yaml`) lets a global reviewer take a
  PR a personal reviewer has not claimed or reviewed within the set minutes. The waiting job names the reviewer and the time, and
  a personal reviewer that comes back after the fallback posted posts nothing. Without the key nothing changes.

### Changed

- Release titles name the channel and version ("MendCode v0.0.2 Beta 4", "MendCode Nightly — 2026-10-29 · Build 2") instead of
  the bare tag, and the notes list what changed since the previous release of the same channel, with install and verify steps
  and the full changelog folded away. Tags, assets and the updater are unchanged.
- PR review: reviews are durable jobs in `pr-review/jobs.json` instead of an in-memory queue. A daemon restart finds the queued and
  running reviews and runs each once; a push during a review marks it stale and it is not posted; a failed review is retried with
  backoff, at most 5 times. Before, a restart lost every queued review.
- PR review: the default `budget.tokens_per_pr` is 1,000,000 (was 200,000), and the review context is bounded by
  `budget.context_tokens` instead of half of `tokens_per_pr`. A review stopped at the cap says it is incomplete.
- PR review: every posted review carries a reviewer marker, and a post that timed out or got a 5xx is looked up on the PR before
  anything is sent again, so a slow GitHub answer no longer risks a second review.
- PR review: native and Claude Code review children load no memory or instruction files of their own; the review prompt carries only the memory the
  reviewer's scope allows, so your user memories never reach a repository's reviewer. Claude Code review and fix sessions run with
  `--setting-sources user`, so a PR's own `.claude/` settings and hooks never load. Codex review children get none of the
  worktree's `AGENTS.md`, no Codex memories and no skill instructions. Codex review and fix sessions treat the checkout as
  untrusted, so its `.codex/config.toml`, hooks and rules never load; a fix session's checkout skills are disabled. Only your own
  `~/.codex/AGENTS.md` still reaches a review child.
- PR review: the reviewer's notices to the watching session are recorded without starting a model turn
  (`experimental.pr_review_prompts` brings the old behaviour back).
- PR review: a review, verify or fix turn has no fixed time limit. It is stopped as stalled after 10 minutes with no event from
  the model (a fix session waiting for your approval does not count), with a 2-hour cap. The job keeps its work and retries with
  backoff. Failure and stop notices name the repository, the PR, the head's first 12 characters, the reason, the next retry time
  and the attempts left.
- PR review: a maintainer's `@mendcode review` on a head that was already reviewed is kept. The reply says the next push will be
  reviewed, and that head is reviewed even with `triggers.synchronize` off, also after a restart. Commands are checked in one
  order: permission, filters, reviewed head. A comment from the daemon's own login runs like `/pr review`, and what it is refused
  is said in the session only.
- PR watch: one watched PR ends only when it is gone or inaccessible for 15 awake minutes. A network outage or sleep never ends
  it.
- The daemon drops the Claude Code session variables it inherits when an agent starts it from a Claude Code shell (`CLAUDECODE`,
  `CLAUDE_CODE_SESSION_ID`, …), so a `claude` it starts no longer takes itself for that session's child. `ANTHROPIC_*` and your
  other Claude Code settings are kept ([Claude Code](docs/claude-code.md#started-from-claude-code)).
- `apply_patch` also places a hunk whose lines differ from the file only in spaces inside a line, and a context line matched
  loosely (indentation, trailing or inner spaces) keeps the file's own text: only `-` and `+` lines change the file. A hunk of
  several lines that does not match shows the file around its closest line, numbered, with `>` on the first line that differs.
- The tool definitions every request carries are as small as before these additions: the descriptions that only repeated their
  tool's (`read`'s `paths`, `glob`'s `patterns`, `apply_patch`'s `patch`) were cut (minimalist's first request 5,378 characters,
  was 5,381).

### Fixed

- PR review: `@mendcode review` on a head with nothing new no longer answers just "published". The reply names the head, says
  no new review was posted, and lists the earlier findings it resolved and the ones still open. An explicit review re-checks the
  open findings, so asking again after a fix closes the threads of the fixed ones, also on a head reviewed before. Where GitHub
  does not let the account resolve a thread (read access), one reply in it says `Fixed in <head>` instead of nothing.
- A notice a Claude Code or other external session did not see (a PR review's result, recorded without a model turn) reaches
  its next turn whole, up to 3,000 characters, instead of cut after 400.
- PR review: the `pr_review` tool no longer asks for approval in a full-access session, and its prompt reads "Review a pull
  request" instead of "Edit files".
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
- PR review: a sleeping laptop or a network outage no longer ends a repo watch. Failing time is counted awake, only a permanent
  error (a repository gone, access revoked) ends one, and a job that fails on the network spends none of its attempts. Before,
  15 minutes asleep ended every watch.
- PR review: a detached daemon with a repo watch no longer stops itself after 10 idle minutes.
- PR review: a fix pushed by `fix.mode` is reviewed by its job once the forge reports the new head. A fix round counts a finding
  resolved only when that re-check closed it, including a fix that inserts a line next to the flagged one. Before, the fix's head
  could go unreviewed and its thread stay open.
- PR review: releasing a taken-over fix job pushes the kept fix and does not count the interrupted round. Before, the job ended
  `failed`.
- PR review: a released claim wakes the other device's waiting job at its next poll, instead of after the claim's two hours.
- PR review: fix commits name their source (the automatic fix mode, or the commenter and the comment of `@mendcode fix`), and
  their subject is cut at a word.
- Setup: a first launch with no usable model is not marked done. Esc or Enter leaves it open for the next launch, and the minimalist
  preset opens the page instead of a prompt no model answers. Upgrades and reinstalls keep their finished setup.
- Setup: Claude Code is shown as installed, signed in, and with its plan only when `claude auth status` reports one; before, a
  `claude --version` that answered read as "installed, signed in". Each model says who runs it and whose login pays.
- Claude Code turns that fail on "Not logged in" give the official login command of the profile in use instead of Claude Code's
  own `/login`.
- ChatGPT models: MendCode asks the subscription backend which models your account can use, with its own login, and keeps the list
  in `chatgpt-models.json` in its data directory, refreshed in the background every 5 minutes. Before, it read the Codex CLI's
  `~/.codex/models_cache.json`, so without that file only `gpt-6-luna` was listed and `models set-default chatgpt gpt-6-astra` failed
  with "unavailable model". A model the list lacks is asked for again once before it is refused; no network, an error or an empty
  answer keep the last list. Nothing of the Codex CLI is read or written.
- Claude models on a new install run in the Claude Code installed on the machine, with its own login, as on an install set up
  before. Nightly 20261030.6 gave them a separate Claude Code profile that had to be signed in again; that profile and
  `mendcode claude login` are gone, and only ChatGPT uses MendCode's own login.
- Setup: Esc while the page still says "checking this machine…" no longer marks the first launch done with no usable model.
- ChatGPT login on new installs: `/connect chatgpt` said "Set MENDCODE_OPENAI_OAUTH_CLIENT_ID" and the ChatGPT models were
  unusable, because released builds carry no OAuth client id; it now uses Sign in with ChatGPT, which needs none. A new install's
  daemon also no longer lists ChatGPT models with the Codex CLI's login in the seconds before its first setup.
- Claude Code sessions know MendCode: they get the same line a native session has, that MendCode's slash commands and features
  are read with `mendcode docs --search`. Asked to keep reviewing a repository's pull requests, a Claude Code session offered a
  session cron job, a cloud routine or a GitHub Action and posted reviews with `gh` itself; with `pr_watch` it is now told that
  `pr_watch` only wakes it on one PR, and that MendCode's own reviewer (`/pr review`, `/pr watch-repo`) reviews every new PR and
  push from the daemon.
- Claude Code sessions: a ToolSearch that loaded tools showed "empty"; it says which tools it loaded.
- `edit` cut its diff at 2,000 lines even where the daemon allows more: the output limits were passed to the diff, not to the cut.
- The context report counts every file a `read` with `paths` named, each with its share of the result; such a read was left out.
- The built-in search (no ripgrep installed) no longer reports the empty "line" after a file's final newline.
- PR review: the verification line of a "No findings" review says what happened: no candidates and no separate pass, or N
  candidates checked again and none confirmed. It no longer says every finding was checked when there were none.
- PR review: a `requested` watch takes an `@mendcode` comment addressed to no one on a PR that area or label routing gives its
  login's personal reviewer.
- PR review: `/pr review` (and your own `@mendcode review`) on an `all` watch reviews as the repository's default global reviewer
  from `.mendcode/reviewers.yaml` (such as `team`), not as `global`, so a head the watch already reviewed is not posted twice.
- PR review: a review that posts nothing (this head's review was already posted, or nothing is new on it) says so in its notice
  instead of a bare "published", and that the pull request keeps the earlier review.
- PR review: a fix session waiting for your approval was stopped as stalled after 10 minutes: the session's own "waiting for
  approval" state ended the wait. The wait now lasts until the approval is answered.
- PR review: a review whose Claude Code child never answered `initialize` (a load spike) is retried with backoff, spending an
  attempt like a stalled turn, instead of failing until someone retries it from `/reviews`.
- PR review: the model spend of a call that failed, was stopped or was cut off by a killed daemon is accounted: what the engine
  reported before it ended, and the call as one without a report. A call killed with the daemon is accounted at the next start.

### Known limitations

- PR review: a Codex review child still reads your own `~/.codex/AGENTS.md`; codex-cli 0.162.1 has no switch for it, and MendCode
  never moves or copies `~/.codex`. A Claude Code turn killed with the daemon reports no usage, so its spend stays unknown.

- Sign in with ChatGPT has no device code: sign in on the machine that runs the daemon. On that login there is no native
  compaction (MendCode's own summary is used), no hosted image generation and no `/fast` priority. Device code remains for a
  Codex-style client id you set yourself (`MENDCODE_OPENAI_OAUTH_CLIENT_ID`).
- Mermaid subgraphs are told apart by title: two subgraphs with the same title are drawn as one frame. In a left-to-right
  flowchart, a connection back to an earlier box shares the last stretch of the arrow going into it.

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
