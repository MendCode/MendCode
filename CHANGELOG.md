# Changelog

What changed for MendCode users, newest first. Every user-visible change adds an item under `## Unreleased` in the same pull
request; a release reads its notes from here and fails without them ([release notes](docs/release.md#release-titles-and-notes)).

A section is a summary paragraph and items under `### New`, `### Changed`, `### Fixed`, `### Upgrade notes` and
`### Known limitations` (only the groups that apply). Cutting a stable or beta release renames `## Unreleased` to its tag
(`## v0.0.2 - 2026-11-03`) and starts a new empty one; nightlies take the items they add to `## Unreleased`.

## Unreleased

### New

- The assistant replies in the language of your latest message (English when unclear) and no longer switches language on its own.
- `mendcode usage recover` adds the token usage of a Claude Code, Codex or Pi session log to Usage, with a preview first and
  an undo. See [usage recovery](docs/usage-recovery.md).
- `/pr setup` checks prerequisites and configures repository reviews and publishing with one confirmation; a headless setup command is also available.
- `/voice setup` guides dictation readiness and explicitly confirms audio uploads before enabling an API provider.
- `/graph setup` enables and builds the project's code graph with one confirmation, without changing global defaults.
- The `defaultContextWindow` setting gives one context window to every model that has none of its own; a model's `modelContext` window and `/context-window` still win. The assistant now finds how to change a context window, a model, a theme or a title from `mendcode docs change` without reading MendCode's files.

### Changed

- MendCode keeps its data in `~/.mendcode`. The first start moves `~/.mendcode-v2` there and leaves a link with the old name,
  so sessions, settings and sign-ins carry over. `MENDCODE_DIR` names another folder; `MENDCODE_V2_DIR` still works.
- A terminal that hosts the daemon, and a separate daemon, hold less memory at the prompt.
- The current-task row above the prompt is gone; the dock's Jobs panel is opt-in and Todos wrap with more room.
- Long command replies open a readable page (F4 shows the full text of a cut notice), and `/pr repos` lists repository
  watches in a page where they can be stopped and restarted.
- Completed streaming output uses less session storage while preserving historical cuts and reconnect replay.
- Session history takes less disk: each event stores its session, number, time and type once, and existing history is
  converted in the background while the daemon is idle. Forked sessions also store less. Short sessions now take less disk
  than a Pi session file.
- A finished short session stores fewer rows: settled state snapshots, empty file snapshots and request profiles take less room.
- New session, turn and item ids are shorter, so every stored row takes less room; existing ids keep working.
- Opening a session and starting a turn read the transcript and model history faster.
- The terminal uses less CPU while a reply streams in.
- `--help` says which `--process` mode uses less memory.
- Compaction uses the session's own model by default, so it reuses the prompt cache; the built-in recipes no longer set a
  `compaction` role, and `/models` notes when a separate compaction model gives that up.
- The working row's token count shows new input and the context read from the provider's prompt cache separately.
- The code graph autopilot refreshes the graph when a lot of code has changed, not after a number of edited files. See
  [code graph](docs/code-graph.md#autopilot).
- The full view's footer shows the `rows` preset by default: directory, model and session figures, quota per provider and the code
  graph, each on its own row. `/footer preset classic` brings back the single-row footer. Balanced and minimalist are unchanged. See
  [layout](docs/layout.md#footer-by-tier).

### Fixed

- An automatic PR review checks that it may post, and that no other reviewer already has, before it spends any tokens.
- The advisor sees a short summary of the session (earlier edits apart from this turn's, this turn's checks) and the untracked files, and the executor can pass it files with a line range and images; the extra evidence is capped and says what was cut.
- `@MendCode review` gets no extra reply when this reviewer's own review of the head was posted after the comment.
- `@mendcode review` no longer counts the empty review GitHub records when someone replies in a review thread as a review of
  the head.
- Session titles name what you asked; a model no longer answers your message in the title (such as saying it cannot see an
  image).
- Asking to rename the title renames the session, not a part of the screen.
- Ask any model to change the default model, tier or permissions and it proposes the change for you to approve, instead of
  telling you to do it by hand.
- OpenCode Go answers again: every request carries the session it belongs to, as Go now requires. OpenCode Zen gets it too.
- Preserve terminal preferences and settings across versions, keep recovery history, and guard against accidental downgrades.

- Changes to a file saved twice in quick succession are no longer missed by model lists, config files, the file viewer or code graph
  excerpts.

### Upgrade notes

- A `~/.mendcode` left by MendCode v1 is renamed to `~/.mendcode-v1`, nothing deleted, and OpenCode's folders that pointed
  into it follow. A terminal of the earlier version still open keeps the move for the next start.
- Earlier versions cannot read session history written or converted by this one. Keep a copy of the data directory before
  upgrading if you may need to go back.

## v0.0.3 - 2026-11-02

`/memory` follows the same page standard as `/changes` with a graph drawn in braille links, `mendcode --version` names its channel,
and the code graph autopilot can be turned on in the full tier.

### Upgrade notes

- Same code as v0.0.3-beta.1. The code graph autopilot is off in beta and stable; `/tier graph_autopilot on` turns it on in the
  full tier.

## v0.0.3-beta.1 - 2026-11-02

`/memory` follows the same page standard as `/changes` with a graph drawn in braille links, `mendcode --version` names its channel,
and the full tier gains a code graph autopilot (on by default only in nightly builds).

### New

- **Code graph autopilot (nightly only by default).** In the full tier, MendCode builds and refreshes the code graph of a real
  project by itself, in the background, so the model finds code through the graph without having to remember to build it. It never
  builds in the home folder, system folders or very large projects, and `/graph on|off` still decides. The footer's graph segment
  shows the progress. It is on by default only in nightly, dev and local builds; in beta and stable turn it on with
  `/tier graph_autopilot on`. Minimalist and balanced are unchanged. See [code graph](docs/code-graph.md#autopilot).

### Changed

- `mendcode --version` says which channel the binary is from: stable, beta, nightly, or a local build.
- `/memory` follows the same page standard as `/changes`: every tab has the same header with the keys and counts, and the History,
  Loops and Memory sub-pages are titled like the other pages. The Graph tab shows a **Graph** box beside a **Memory** box for the
  selected memory, with links drawn between memories, colors by category and a legend.
- The README screenshots are full-screen renders of the real views.

## v0.0.2 - 2026-11-01

The second stable release: everything in the v0.0.2 betas, from MendCode's own ChatGPT login and an advisor model to a visible
plan, plan mode as in v1, voice dictation, credentials pasted into `/env` and fewer prompt-cache misses.

### Upgrade notes

- Stable installs move from v0.0.1 with `mendcode upgrade`; beta and nightly installs already have this code from
  v0.0.2-beta.4 and the nightly of the same day.

## v0.0.2-beta.4 - 2026-11-01

MendCode signs in to ChatGPT for itself with Sign in with ChatGPT and keeps its own list of the models your account can use, and
Claude models on a new install run in the Claude Code you already have signed in. A second model can advise the first (`/advisor`),
the agent's task list stays visible above the prompt, plan mode works as in v1, credentials can be pasted into `/env`, and fewer
requests miss the prompt cache.

### New

- Advisor: `/advisor <model>[#effort]` names a second model that the main model consults through an `advisor` tool and that is also
  consulted before a plan is shown, after the same call fails twice and before a turn that edited files closes. It is available in
  balanced and full and off until you pick a model; `/advisor off` turns it off and `/advisor` shows its status. A Claude Code model
  (`/advisor claude-opus`) can also advise a native session on your Claude subscription. `/model` has an advisor row and the AI
  config page shows the status ([advisor](docs/advisor.md)).
- A visible plan (balanced and full, `/tier visible_plan off` hides it): while the agent's task list has open items, one muted row
  above the prompt shows the item in progress and how far the list is (`▸ Fix the parser · 3/7`). Ctrl+t opens the whole plan. Claude
  Code, Codex and ACP agent plans show in the same row. Minimalist has no plan row.
- Plan mode works as it did in v1: Shift+Tab or `/plan` enters it read-only, the footer names the plan model, and the plan opens a
  review where Enter switches to the build agent and its model and continues. Claude Code's `ExitPlanMode` opens the same review.
- Paste credentials into `/env`: paste one `NAME=value` or a whole `.env` and MendCode lists the variables it found (names only,
  with their status); choose all or a subset with space, `a` and Enter, and they are saved encrypted for the project (Ctrl+S for
  session or global). The pasted text stays in memory until you save or press Esc.
- Sessions know what MendCode can do: the model is told which tools it can load (image generation, computer use, memory, web,
  workflows and others) and what this terminal can draw, so it uses them instead of saying it cannot. Codex, pi and ACP agents get
  the same information and the `mendcode docs` pointer.
- Codex sessions get MendCode's own tools (code graph, image generation, computer use, memory and the rest) through the same bridge
  as Claude Code, with one approval: MendCode's. Gated like Claude Code by `harness_tools` (balanced and full).
- Sign in with ChatGPT: `/connect chatgpt` (or `control-plane auth login --provider chatgpt --method browser --execute`) shows a
  link; you sign in in the browser, allow MendCode to use your ChatGPT plan, and MendCode keeps a login of its own, which you can
  limit or revoke in ChatGPT → Settings → Usage. The link stays open 15 minutes. Requests on that login go to `api.openai.com` and
  count against your plan.
- On new installs MendCode's engine signs in to ChatGPT only with `/connect chatgpt` and does not read the Codex CLI's login file
  (`ownLogins`). Installs set up before keep it as a fallback.
- PR review: `.mendcode/review.yaml` can start from a preset (`preset: balanced | quiet | strict | on-request | autofix`); the
  file's own keys go over it, and no preset turns posting on, adds checks, widens who may post or pushes.
- PR review: `budget.tokens_per_pr: null` means no internal cap, and `budget.context_tokens` bounds what one call carries,
  apart from the PR's total.
- PR review: `/reviews` (or `/pr dashboard`) opens a page of review jobs, reviewers and watches. From it you can pause, resume,
  cancel or retry a job, take a job over and release it, and show a job's config.
- PR review platform:
  - A review stopped by its token budget, a quota or a rate limit keeps what it found and resumes on retry, or after the quota
    reset with `on_quota: wait`.
  - `mode` and `filters` decide which PRs are reviewed; `/pr list` shows the reason for each PR not taken.
  - `.mendcode/reviewers.yaml` routes PRs to the global reviewer and to personal reviewers. A personal reviewer whose MendCode runs
    elsewhere waits, and its own daemon reviews the PR when it starts. Device claims on a PR are best-effort.
  - Personal profiles can only narrow the repository's config, and the config actions and the `review_config` tool always need a
    scope.
  - Review memory follows the reviewer's scope.
  - `fix.mode` `fix-once` and `fix-loop` push only with `fix.push` and `/pr publish on`; otherwise the fix is kept on a local ref.
  - A stacked PR is reviewed on its own commits, and token use is counted per PR head.
  - An audit of the whole checkout stays in the session; it is a `pr.review` action, with no slash command.
  - GitLab (through `glab`) and Gitea / Forgejo (`GITEA_TOKEN`) are supported: the daemon watches, posts reviews, answers
    `@mendcode` and pushes fixes. They have no check follow-ups and no hosted runner, and Gitea has no thread resolution
    ([providers](docs/pr-review.md#providers)).
  - `template.language` (default English, set by the repository only) is the language of every review, verify, fix and
    `@mendcode explain` reply. With `auto`, a PR is reviewed in its author's language; a short, mixed or unclear text is English.
  - When a watch starts, after a daemon restart and after a pause or outage, open PRs whose head has no review yet are reviewed,
    newest first: at most `backlog.max_prs` (10), updated within `backlog.window_days` (30). `/pr watch-repo` lists what it queued
    and what it skipped, and `max_prs: 0` turns this off.
  - Set up PR review with your session: `review_config` `setup` reports what exists, what is missing and the questions to ask. It is
    read-only.
  - The `pr_review` tool reviews a PR now from a session (`review` asks your approval outside full access, and `status` lists the
    jobs). It posts only as `/pr publish` allows.
  - `.mendcode/reviewers.yaml` capabilities `review`, `fix` and `publish` are enforced, and a reviewer without the list has all
    three. A `requested` watch also takes PRs that area or label routing gives its login's personal reviewer.
  - Logins in `reviewers.yaml` and in `review.yaml`'s `reviewers` and `publishers` follow the checkout's forge, so GitLab and Gitea
    usernames with `_` or `.` can be listed.
  - A diff too large for one call is reviewed in parts.
  - A team setup guide covers the hosted workflow, an always-on server with personal reviewers on laptops, and troubleshooting
    ([team setup](docs/pr-review-setup.md)).
- `grep` takes `context` (0 to 5) to return the lines around each match, so one search can replace the read that would follow it.
- `edit` takes `edits: [{oldString, newString}]` (up to 50) to make several replacements in one file in one write. If one does not
  match, nothing is written and the call says which.
- Mermaid flowcharts with `subgraph` are laid out in layers, each subgraph drawn as a titled frame and nested subgraphs as nested
  frames. A left-to-right diagram too wide for the chat is drawn top-down.
- PR review: `prReview.concurrency` (1 to 4, default 2) sets how many reviews this device runs at once, across every watched
  repository. It is a per-device setting, and `/pr watch-repo list`, the status and `/reviews` show it
  ([concurrency](docs/pr-review.md#concurrency)).
- PR review: an opt-in offline fallback (`routing.offline_fallback` in `.mendcode/reviewers.yaml`) lets a global reviewer take a
  PR a personal reviewer has not claimed or reviewed within the set minutes. Without the key nothing changes.
- Setup: sign in from the page. Up from the Model row reaches the ChatGPT login and API keys; Enter runs `/connect chatgpt` or
  opens `/connect`, and closing it comes back to setup with the new models on the Model row. Ready groups MendCode's own engine
  (ChatGPT login, API keys) apart from the external harnesses that keep their own login (Claude Code, Codex, pi).
- Setup: Space on the Model row lists every model found, grouped by who runs it: MendCode's own engine, then the Claude Code, Codex,
  pi and ACP harnesses. Enter picks one; the list also holds `Sign in to ChatGPT` and `Add an API-key provider`. The Model row names
  who runs the model (`Opus · Claude Code`).
- The model can read another session's conversation in one call: `sessions read=<session id>` returns its messages, oldest first,
  one line per tool call, in pages. An exact id may name a session of any project of this MendCode
  ([peers](docs/peers.md#read-one-sessions-conversation)).
- `/usage` shows the model calls MendCode makes outside your turns: session titles and summaries, `/recap`, memory extraction,
  the Memory assistant, Dream, the permission reviewer, `prompt` hooks, generated agents and the setup helper. The Models tab has an
  "Auxiliary calls" panel, and `mendcode usage`, `mendcode stats` and `--json` (`auxiliary`) list them too. They stay out of the
  turn totals ([usage](docs/usage.md#auxiliary-calls)).

### Changed

- The start screen's title is MendCode's infinity logo, drawn in half blocks (plain ASCII under `glyphs ascii`) with the name
  under it. A logo text or font of your own still draws those letters; a small terminal shows the name.
- Setup uses the whole terminal: the preview takes the rest of the width and the full height with its prompt at the foot, as in the
  chat. The Tier row says what its value gives even unfocused, and lists the tiers when focused.
- Computer use: `tools.batch({revision, steps})` in `computer_code` runs up to 16 actions on one observation in one call. Every step
  is checked before the first is sent, the first failing step stops the batch, and each step reports its outcome, delivery and
  whether a retry is safe ([batches](docs/computer.md#batches)).
- Computer use shows a new cursor: a white dart with a pill naming the action, a click ripple, an outline around the element acted
  on and a trail for drags. It moves like a hand, faster than before, and rests when idle.
- Computer use observes windows faster.
- Computer use: a failed action says whether its input can have reached the app, ending with "not delivered" or "delivery unknown".
- The row under the prompt reads left to right in groups: `Build · GPT-6-Luna · high · fast · native │ ↻ 1 loop │ ~12 turns to
  compact`. Balanced names the reasoning effort and `/fast` beside the model; the full view adds a second row with the code graph,
  the session's cache share and the quota windows. Minimalist has no such row. Narrow terminals shorten the row, keeping the agent
  and any permission that acts without asking. Screen-reader mode uses plain words and ASCII chrome a plain `|`. Every footer
  segment declares where it shows by view ([layout](docs/layout.md#footer-by-tier)); `/footer reset` returns to the view's own
  list.
- Reasoning effort is on by default in the footer (`showEffort`), and `/tier balanced|full` turns it on. A terminal profile saved
  before keeps its value: Customize > Prompt & footer > Reasoning effort, or `/tier balanced` again, shows it.
- Release titles name the channel and version ("MendCode v0.0.2 Beta 4", "MendCode Nightly — 2026-10-29 · Build 2"), and the notes
  list what changed since the previous release of the same channel, with install and verify steps and the full changelog folded
  away. Tags, assets and the updater are unchanged.
- PR review: reviews are durable jobs. A daemon restart finds the queued and running reviews and runs each once; a push during a
  review marks it stale and it is not posted; a failed review is retried with backoff.
- PR review: the default `budget.tokens_per_pr` is 1,000,000, and the review context is bounded by `budget.context_tokens`. A review
  stopped at the cap says it is incomplete.
- PR review: every posted review carries a reviewer marker, and a post that timed out is looked up on the PR before anything is
  sent again, so a slow GitHub answer no longer risks a second review.
- PR review: review children load no memory or instruction files of their own, and treat the checkout as untrusted, so a PR's own
  `.claude/` or `.codex/` settings, hooks and rules never load. Your user memories never reach a repository's reviewer. Only your
  own `~/.codex/AGENTS.md` still reaches a Codex review child.
- PR review: the reviewer's notices to the watching session are recorded without starting a model turn
  (`experimental.pr_review_prompts` brings the old behaviour back).
- PR review: a review, verify or fix turn has no fixed time limit. It is stopped as stalled after 10 minutes with no event from the
  model (a fix session waiting for your approval does not count), with a 2-hour cap. The job keeps its work and retries with
  backoff. Failure and stop notices name the repository, the PR, the head, the reason, the next retry time and the attempts left.
- PR review: a maintainer's `@mendcode review` on a head that was already reviewed is kept. The reply says the next push will be
  reviewed, and that head is reviewed even with `triggers.synchronize` off. A comment from the daemon's own login runs like
  `/pr review`, and what it is refused is said in the session only.
- PR watch: one watched PR ends only when it is gone or inaccessible for 15 awake minutes. A network outage or sleep never ends
  it.
- The daemon drops the Claude Code session variables it inherits when an agent starts it from a Claude Code shell, so a `claude`
  it starts no longer takes itself for that session's child. `ANTHROPIC_*` and your other Claude Code settings are kept
  ([Claude Code](docs/claude-code.md#started-from-claude-code)).
- `apply_patch` also places a hunk whose lines differ from the file only in spaces, and only `-` and `+` lines change the file. A
  hunk that does not match shows the file around its closest line, with `>` on the first line that differs.
- The tool definitions every request carries are as small as before these additions.

### Fixed

- Fewer requests miss the prompt cache: repeated `tool_search` calls on the ChatGPT backend, pruning of old tool results and the
  memory chosen for the system prompt no longer change the start of the request in the middle of a turn.
  `MENDCODE_DEBUG_PROMPT_PREFIX=1` makes the daemon log hashes of each provider request's parts, without content, to find what
  changed ([prompt cache](docs/prompt-cache.md)).
- `mendcode attach <session id>` opens that session in the terminal again; an HTTP URL still attaches to a server.
- On-device dictation with no language set listens in the first two languages of Language & Region at once (English and Spanish
  on a bilingual Mac). `/voice language` lists every language the on-device model hears by name, and takes one
  (`/voice language es`) or two to hear at once (`/voice language es en`).
- While dictating on this Mac the words appear as you speak, not only at a pause, and the row shows the language actually spoken.
- Dictation says when to start talking: holding space shows `starting… wait to speak` until the microphone listens. If the
  transcript does not come back, the words already heard stay in the prompt as a draft.
- Setup's Model row steps through every model found, including those of the Codex harness (also with `ownLogins`), and ACP agents'
  models are no longer listed as the ChatGPT subscription's.
- The pixel wordmark's N is drawn in full.
- A Claude Code session can run a sub-agent on another model (GPT-6.1 Terra, a Codex model). With the thread bridge on (full tier,
  `/tier thread_mcp on claude`), the model is told which models `delegate_task` runs, and Codex gets the same; without the bridge,
  MendCode's tools say how to turn it on.
- Model references as `mendcode models` prints them (`chatgpt/gpt-6.1-terra`, `claude/claude-opus`, `codex/codex:gpt-6-sol`)
  work wherever a model is named: a role, `/model`, `--model`, a sub-agent (`task`, `delegate_task`), `session create --model` and
  `run --model`. The assistant's `mendcode_settings` refuses a model role no catalog lists, as `/model` does, and says that a new
  main model is for new sessions.
- A sub-agent Claude Code starts on another model shows that model on its Agents strip row and thread header from the start.
- A finished turn no longer makes a hidden model call for a session summary. The summary is written only when something asks to
  show it: `/fanout compare` and `mendcode session inspect ID --summary` (`session_meta` tier, local only). Minimalist never writes
  one, and `agent.summary` keeps its prompt, model and `disable`.
- Session titles and summaries go through the budget like every other daemon helper: a reached `stopUsd` blocks them, an expensive
  model needing confirmation is not called unattended, and their spend counts in the ledger.
- Changing the default model while a session runs no longer breaks that session: the running turn finishes on its model, a session
  that already ran keeps its engine, and new sessions start on the new default. `/model` to another engine mid-turn applies from the
  next turn, and a model that another engine runs is never sent to a provider; the turn fails at once, saying where the model runs.
- A daemon started by a terminal in a tuios pane no longer carries that pane's identity, so sessions' commands do not speak to
  tuios as that pane. A terminal that hosts the daemon in its own process keeps it.
- `mendcode daemon status` says `not answering · process N holds the data directory` when a daemon holds the data directory but does
  not answer, and `daemon start`, `stop` and `restart` name that process at once.
- Claude Code, Codex and ACP sessions receive MendCode's notices (such as a PR review's summary) with their line breaks.
- `/reviews` words the age of an update correctly.
- Zod is updated to 4.6.6, which fixes a memory-exhaustion issue in 4.6.5 (GHSA-mrhx-c7xc-m3w5).
- PR review: `@mendcode review` on a head with nothing new names the head, says no new review was posted, and lists the earlier
  findings it resolved and the ones still open. Asking again after a fix closes the threads of the fixed findings; where GitHub
  does not let the account resolve a thread, one reply says `Fixed in <head>`.
- A notice a Claude Code or other external session did not see (a PR review's result) reaches its next turn whole.
- PR review: the `pr_review` tool no longer asks for approval in a full-access session, and its prompt reads "Review a pull
  request".
- A nightly run no longer fails when its run number is already taken by a nightly tag of the same day.
- Claude Code sessions: a background sub-agent stopped by esc stays in the Agents strip as `stopped by you · /relaunch`, and
  `/relaunch` asks Claude to start it again with the same prompt, told how far it got.
- Claude Code sessions: an agent Claude Code sends to the background on its own is shown and followed as a background agent.
- Claude Code sessions: the first message after esc stopped background agents is answered.
- The daemon finds `gh`, `git`, `claude` and `codex` installed with Homebrew however it was started, so a daemon restarted with a
  short `PATH` (launchd, systemd) no longer pauses PR review watches.
- PR review: a watch paused because `gh` is missing or logged out tries again every 5 minutes and resumes by itself with a notice,
  handling the PRs, pushes and `@mendcode` comments of the pause.
- PR review: `@mendcode` comments are read page by page, so none is dropped when many arrive between polls.
- PR review: a sleeping laptop or a network outage no longer ends a repo watch; only a permanent error (a repository gone, access
  revoked) does, and a job that fails on the network spends none of its attempts. A detached daemon with a repo watch no longer
  stops itself when idle.
- PR review: a fix pushed by `fix.mode` is reviewed once the forge reports the new head, and a fix round counts a finding resolved
  only when that re-check closed it.
- PR review: releasing a taken-over fix job pushes the kept fix and no longer ends the job as `failed`.
- PR review: a released claim wakes the other device's waiting job at its next poll.
- PR review: fix commits name their source (the automatic fix mode, or the commenter and the comment of `@mendcode fix`).
- Setup: a first launch with no usable model is not marked done. Esc or Enter leaves it open for the next launch, and the minimalist
  preset opens the page instead of a prompt no model answers. Upgrades and reinstalls keep their finished setup.
- Setup: Claude Code is shown as installed, signed in and with its plan only when `claude auth status` reports it. Each model says
  who runs it and whose login pays.
- Claude Code turns that fail on "Not logged in" give the official login command of the profile in use.
- ChatGPT models: MendCode asks the subscription backend which models your account can use, with its own login, and keeps the list
  refreshed in the background; if the answer fails, the last list is kept. Nothing of the Codex CLI is read or written.
- Claude models on a new install run in the Claude Code installed on the machine, with its own login, as on an install set up
  before. Only ChatGPT uses MendCode's own login.
- `/connect chatgpt` on new installs uses Sign in with ChatGPT, which needs no OAuth client id. A new install's daemon no longer
  lists ChatGPT models with the Codex CLI's login before its first setup.
- Claude Code sessions know that MendCode's slash commands and features are read with `mendcode docs --search`. Asked to keep
  reviewing pull requests, they are told that `pr_watch` only wakes them on one PR and that MendCode's own reviewer
  (`/pr review`, `/pr watch-repo`) reviews every new PR and push from the daemon.
- Claude Code sessions: a ToolSearch that loaded tools says which tools it loaded.
- `edit` shows its full diff up to the limits the daemon allows.
- The context report counts every file a `read` with `paths` named.
- The built-in search (no ripgrep installed) no longer reports an empty line after a file's final newline.
- PR review: the verification line of a "No findings" review says what happened: no candidates and no separate pass, or candidates
  checked again and none confirmed.
- PR review: a `requested` watch takes an `@mendcode` comment addressed to no one on a PR that area or label routing gives its
  login's personal reviewer.
- PR review: `/pr review` (and your own `@mendcode review`) on an `all` watch reviews as the repository's default global reviewer
  from `.mendcode/reviewers.yaml`, so a head the watch already reviewed is not posted twice.
- PR review: a review that posts nothing says so in its notice and that the pull request keeps the earlier review.
- PR review: a fix session waiting for your approval is no longer stopped as stalled; the wait lasts until the approval is answered.
- PR review: a review whose Claude Code child does not start is retried with backoff instead of failing until someone retries it
  from `/reviews`.
- PR review: the model spend of a call that failed, was stopped or was cut off by a killed daemon is accounted.

### Known limitations

- PR review: a Codex review child still reads your own `~/.codex/AGENTS.md`; MendCode never moves or copies `~/.codex`. A Claude
  Code turn killed with the daemon reports no usage, so its spend stays unknown.
- Sign in with ChatGPT has no device code: sign in on the machine that runs the daemon. On that login there is no native
  compaction (MendCode's own summary is used), no hosted image generation and no `/fast` priority. Device code remains for a
  Codex-style client id you set yourself (`MENDCODE_OPENAI_OAUTH_CLIENT_ID`).
- Mermaid subgraphs are told apart by title: two subgraphs with the same title are drawn as one frame. In a left-to-right
  flowchart, a connection back to an earlier box shares the last stretch of the arrow going into it.

## v0.0.2-nightly.20261029.2 - 2026-10-29

Goals stop when they stop making progress, and the pull request reviewer no longer loses or repeats requests.

### Fixed

- Goals: a goal stalls instead of looping when three turns make no progress or after 100 unattended goal turns; the steering says
  the objective beats an earlier stop rule.
- PR review: a notice that arrives while the session is busy is held and shown when it goes idle.
- PR review: an `@mendcode` command that cannot be answered yet (no `/pr publish on`, or `publishers` does not allow this login) is
  kept and answered once that changes, exactly once, also across restarts.
- PR review: `/pr publish on|off` holds for the repository.
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

- PR review: reviews of one repository run their checkouts one at a time.
- PR review: a review prompt longer than a message may be (a large pull request) goes whole into a text attachment.

## v0.0.2-beta.2 - 2026-10-29

The first beta of 0.0.2: pull request reviews explain the change and its merge risk, several reviewers can share one repository,
and headless JSON runs end cleanly.

### Fixed

- `mendcode run --format json` ends on the turn's result.

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
