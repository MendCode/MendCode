# Changelog

What changed for MendCode users, newest first. Every user-visible change adds an item under `## Unreleased` in the same pull
request; a release reads its notes from here and fails without them ([release notes](docs/release.md#release-titles-and-notes)).

A section is a summary paragraph and items under `### New`, `### Changed`, `### Fixed`, `### Upgrade notes` and
`### Known limitations` (only the groups that apply). Cutting a stable or beta release renames `## Unreleased` to its tag
(`## v0.0.2 - 2026-11-03`) and starts a new empty one; nightlies take the items they add to `## Unreleased`.

## Unreleased

## v0.0.3 - 2026-11-02

`/memory` follows the same page standard as `/changes` with a graph drawn in braille links, `mendcode --version` names its channel,
and the code graph autopilot can be turned on in the full tier.

### Upgrade notes

- Same code as v0.0.3-beta.1. The code graph autopilot is off in beta and stable; `/tier graph_autopilot on` turns it on in the
  full tier.

## v0.0.3-beta.1 - 2026-11-02

`/memory` follows the same page standard as `/changes` with a graph drawn in braille links, the README screenshots are full-screen
renders of the real views, `mendcode --version` names its channel, and the full tier gains a code graph autopilot (on by default
only in nightly builds).

### New

- **Code graph autopilot (nightly only by default).** In the full tier, MendCode now builds the code graph of a real project by itself,
  in the background, when a session opens or a turn begins there, and refreshes it once ten files (or 3% of the project) are new,
  changed or deleted, looking at the disk at most every two minutes. The model no longer has to remember to build it: a graph lookup
  on a project with no graph starts the build and answers `building (42%) ... use grep meanwhile, then call again` instead of giving
  up, and the system prompt carries one ~70-token line telling it to locate code with `graph_find`/`graph_callers`/`graph_file_api`
  first and read only the spans they return. Claude Code, Codex and ACP agents get the same line with MendCode's graph tools. It
  never builds in the home folder, the filesystem root, operating system folders, `node_modules`, a folder with no git repository or
  project manifest, or a project over 10,000 files (`/graph on|off` still decides). The footer's graph segment shows `indexing… 40%`.
  On by default only in nightly, dev and local builds while it is tested; in beta and stable it is off until
  `/tier graph_autopilot on`. Minimalist and balanced are unchanged. See [code graph](docs/code-graph.md#autopilot).

### Changed

- `mendcode --version` says which channel the binary is from: `0.0.2 (stable)`, `0.0.2-beta.4 (beta)`,
  `0.0.2-nightly.20261101.19 (nightly)`, or `(local build)` for one built from a checkout.

- `/memory` follows the same page standard as `/changes`: every tab has the `Memory · dir …` header with the keys on the right and the counts under it, and the keys no longer repeat `esc back`. The Graph tab is a **Graph** box beside a **Memory** box for the selected memory (scope, category, project, origin and its links); links are braille lines (dotted for related, solid with an arrow for supports and supersedes, dashed for conflicts), dots take their category's color, and a legend names them. The History, Loops and Memory sub-pages say `History · Turn`, `Loops · New` and `Memory · Projects`, as the other pages do.
- The README screenshots (`docs/assets/readme`) are drawn from the real views at 200 × 56 cells, a full-screen terminal, by `scripts/readme-images.ts`; a test fails when a view changes and the images do not.

## v0.0.2 - 2026-11-01

The second stable release: everything in the v0.0.2 betas, from MendCode's own ChatGPT login and an advisor model to a visible
plan, plan mode as in v1, voice dictation, credentials pasted into `/env` and fewer prompt-cache misses.

### Upgrade notes

- Stable installs move from v0.0.1 with `mendcode upgrade`; beta and nightly installs already have this code from
  v0.0.2-beta.4 and the nightly of the same day.

## v0.0.2-beta.4 - 2026-11-01

MendCode signs in to ChatGPT for itself with OpenAI's Sign in with ChatGPT, keeps its own list of the models your account can use,
and Claude models on a new install run in the Claude Code you already have signed in; the setup no longer leaves you at a prompt with
no model, and the pull request reviewer keeps working when the daemon starts with a short `PATH`. A second model can advise the
first (`/advisor`), the agent's task list stays visible above the prompt, plan mode works as in v1, credentials can be pasted into
`/env` as a whole `.env`, and fewer requests miss the prompt cache.

### New

- Advisor: `/advisor <model>[#effort]` names a second model (balanced and full, off until you pick one; `/advisor off`, `/advisor` shows
  status) that the main model consults through an `advisor` tool and the engine consults at three checkpoints (before a plan is
  shown, after the same call fails twice, before a turn that edited files closes), at most once each per turn. The model sees a
  bounded 24k-token summary with secrets redacted; consultations are counted under the advisor's model. Claude Code sessions pass a
  Claude advisor to `--advisor`. `/model` has an advisor row and the AI config page shows the real status ([advisor](docs/advisor.md)).
  A Claude Code model (`/advisor claude-opus`) can also advise a native session on your Claude subscription, one headless `claude -p`
  per consultation with no tools; the AI status lists the advisor and the permission reviewer as off when unset, not as the main model.
- A visible plan (balanced and full, `/tier visible_plan off`): while the agent's task list has open items, one muted row above
  the prompt shows the item in progress and how far the list is (`▸ Fix the parser · 3/7`); it cuts the item first on a narrow
  terminal, uses `>` and `|` with ASCII chrome, reads `Plan: Fix the parser, 3 of 7 done` in screen-reader mode, steps aside while
  the dock is open (ctrl+t, which lists the whole plan) and goes when every item is done. `todo` is now listed in every request of
  balanced and full, and its description and one prompt line tell the model the user follows it there: use it for work of three or
  more steps, before the first edit, and do not repeat it in the answer. Claude Code's TodoWrite (the item in progress as its
  activeForm) and TaskCreate/TaskUpdate, Codex's update_plan and an ACP agent's plan show in the same row, dock and Todos card, and
  those engines are told in one line that their list is pinned. Minimalist has no `todo` tool at all and no row.
- Plan mode works as it did in v1: entering it (Shift+Tab, `/plan`) says `Plan mode: read-only · <plan model> plans · you review first`
  and the footer names the plan model instead of the build one; the model is told it is read-only and to finish with the plan review,
  and a plan it writes as plain text opens that review anyway, where Enter switches to the build agent and its model and continues
  (leaving plan mode says which model runs now). Claude Code's `ExitPlanMode` opens the same review page.
- Paste credentials into `/env`: paste one `NAME=value` or a whole `.env` and MendCode lists the variables it found (names only,
  with new / replaces / refused / empty status and counts); choose all or a subset with space, `a` and Enter, and they are saved
  encrypted for the project (Ctrl+S for session or global). Pasting `NAME=value` lines into the value field offers the same
  list. The pasted text stays in memory until you save or press Esc.
- The model is told what MendCode can do: a native session's prompt names, in one line, the tools it can load (image generation,
  computer use, memory, web, workflows and others behind `tool_search`), taken from the session's real catalogue, so the model uses
  them instead of saying it cannot. The rendering lines say what this terminal draws (colour swatches, callouts, clickable paths, diff
  cards; a Markdown image is not drawn). Codex, pi and ACP agents get those lines and the `mendcode docs` pointer too.
- Codex sessions get MendCode's own tools (code graph, image generation, computer use, memory and the rest) through the same
  loopback bridge as Claude Code, with one approval: MendCode's. Gated like Claude Code by `harness_tools` (balanced and full).
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
- Setup: sign in from the page. Up from the Model row reaches the ChatGPT login and API keys; Enter runs `/connect chatgpt` or
  opens `/connect`, and closing it (or `m` after signing in) comes back to setup, checked again, with the new models on the Model
  row. Ready now groups MendCode's own engine (ChatGPT login, API keys) apart from the external harnesses that keep their own login
  (Claude Code, Codex, pi). Nothing is saved but what `/connect` saves itself.
- Setup: Space on the Model row lists every model found, grouped by who runs it: MendCode's own engine (the ChatGPT subscription,
  then each provider you have a key for), then the Claude Code, Codex, pi and ACP harnesses. Enter picks one; the list also holds
  `Sign in to ChatGPT` and `Add an API-key provider`, which run `/connect` and come back to the list with the new models in it. A
  harness found without models says what lists them (`claude auth login`, `/tier thread_mcp on codex`). The Model row names who
  runs the model (`Opus · Claude Code`).
- The model can read another session's conversation in one call: `sessions read=<session id>` returns its messages, oldest first,
  with one line per tool call and no tool output or reasoning, in pages of up to 40,000 bytes (`more: cursor=…` asks for the next).
  An exact id may name a session of any project of this MendCode; the list stays this project's. Before, a model asked to read a
  chat by its id searched `~/.claude` and MendCode's database for minutes ([peers](docs/peers.md#read-one-sessions-conversation)).
- `/usage` shows the model calls MendCode makes outside your turns: session titles and summaries, `/recap`, memory extraction,
  the Memory assistant, Dream and its consolidation, the permission reviewer, `prompt` hooks, generated agents and the setup
  helper. The Models tab has an "Auxiliary calls" panel per role and model (`summary · gpt-6-luna · 12 calls · 74K in`), and
  `mendcode usage`, `mendcode stats` and `--json` (`auxiliary`) list them too. They stay out of the turn totals, so nothing is
  counted twice; before, they reached only the budget ledger ([usage](docs/usage.md#auxiliary-calls)).

### Changed

- The start screen's title is MendCode's infinity logo, drawn in half blocks (plain ASCII under `glyphs ascii`) with the name
  under it, in place of the pixel MENDCODE. A logo text or font of your own still draws those letters; a small terminal shows
  the name.
- Setup uses the whole terminal: the choices grow to 64 columns, the preview takes the rest of the width and the full height
  with its prompt at the foot, as in the chat, and the Enter line stands at the bottom. The Tier row says what its value gives
  (`tool cards, code graph, sub-agents`) even unfocused, and lists the tiers when focused. Mend in the preview is its compact
  three-row form instead of the chat's seven-row sprite, which covered the card.
- Computer use: `tools.batch({revision, steps})` in `computer_code` runs up to 16 actions on one observation in one call,
  without observing between them, the way agent-desktop batches commands. Every step is checked before the first is sent,
  each node is re-resolved right before its step, the first failing step stops the batch, and each step reports its outcome,
  delivery and whether a retry is safe ([batches](docs/computer.md#batches)).

### Changed

- Computer use takes agent-desktop's cursor (Apache-2.0, ported to Swift): a white dart with a dark rim and a pill naming the
  action, a click ripple, an outline around the element acted on and a trail for drags. It moves like a hand (overshoot and
  correction, a slight bow) and a move takes 90–320 ms instead of 280–750 ms; it rests after six idle seconds.
- Computer use observes faster: the helper reads each node in one accessibility call instead of one per attribute, measured
  6–7 times faster on the same windows (Ghostty 239 nodes, about 500 ms to about 65 ms).
- Computer use: a failed action says whether its input can have reached the app. A refusal before anything was sent ends with
  "not delivered" and is audited `failed`; a failure after an effect began ends with "delivery unknown" and stays `unknown`
  (before, every failure inside the helper was `unknown`).

- The row under the prompt reads left to right in groups instead of pushing everything to the right edge:
  `Build · GPT-6-Luna · high · fast · native │ ↻ 1 loop │ ~12 turns to compact`. Balanced names the reasoning effort and `/fast`
  (`fast n/a` when the model never gets it) beside the model; the full view adds a second row with the code graph, the session's
  cache share (from the second call) and the quota windows, shown only when they have something to say and never asking the daemon
  for anything new. Minimalist has no such row and gains nothing. Narrow terminals take the compact form of a segment first, then drop
  the least important parts; the agent and a permission that acts without asking always stay. Screen-reader mode uses one separator
  and plain words, ASCII chrome a plain `|`. Every footer segment declares where it shows by view
  ([layout](docs/layout.md#footer-by-tier)); `/footer reset` now returns to the view's own list.
- Reasoning effort is on by default in the footer (`showEffort`), and `/tier balanced|full` turns it on. A terminal profile saved
  before keeps its value: Customize > Prompt & footer > Reasoning effort, or `/tier balanced` again, shows it.
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

- Repeated `tool_search` calls on the ChatGPT backend keep each tool definition in its first successful search result. Later
  searches append an already-loaded notice instead of moving the definition and invalidating the earlier prompt prefix.
  Mixed searches still load new tools; the function-based formats of other providers are unchanged.
- Fewer full re-reads of the conversation in the middle of a turn: old tool results are pruned once per turn (decided by its first
  request) instead of again whenever the context crossed 80 % of the compaction point or a queued prompt or a background notice
  joined the turn, and the memory in the system prompt is chosen by the prompt the turn started with, not by a prompt that joins
  it. Each of those used to change something early in the request, so the provider read the whole context again, uncached.
  `MENDCODE_DEBUG_PROMPT_PREFIX=1` makes the daemon log, per provider request, hashes of its instructions, tools, cache route
  and input items and the first one that differs from the request before (no content; [prompt cache](docs/prompt-cache.md)).
- `mendcode attach <session id>` opens that session in the terminal again; it stopped at `attach needs an HTTP URL` because the
  remote attach took every `attach` first. An HTTP URL still attaches to a server, and a bare `attach` names both forms.
- On-device dictation with no language set no longer hears with the model of the Mac's region: English (Panama) picked Apple's
  Irish English model and turned Spanish into nonsense. It now listens in the first two languages of Language & Region at once
  (English and Spanish on a bilingual Mac) and keeps the transcript the models are surer of. `/voice language` now lists every
  language the on-device model hears by name, and takes one (`/voice language es`) or two to hear at once (`/voice language es en`).
- While dictating on this Mac the words show about a second after they are said, not only at a pause or when the recording ends,
  and the row shows the language actually spoken: with English and Spanish listening, Spanish speech no longer shows the English
  model's misspelled guess until the end. The transcript placed in the prompt is unchanged.
- Dictation says when to start talking: holding space shows `starting… wait to speak` at once, until the microphone listens, and
  the on-device helper is built as soon as the key repeats instead of after the recording was asked for. If the transcript does not come
  back, the words already heard stay in the prompt as a draft rather than being lost.
- Setup's default model offered only the first two models of each source (Fable and Haiku, or Opus and Fable, of Claude Code's
  four), one per API-key provider and none of the Codex harness's: the Model row now steps through every model found. ACP agents'
  models are no longer listed as the ChatGPT subscription's, and the Codex harness's models, which run on the Codex CLI's own
  login, are offered with `ownLogins` too.
- The pixel wordmark's N draws its whole diagonal; it stopped half way and read as a mirrored И.
- A Claude Code session asked for a sub-agent on another model (GPT-6.1 Terra, a Codex model) no longer answers that the model does
  not exist because its Agent tool lists only Claude models. With the thread bridge on (full tier, `/tier thread_mcp on claude`), the
  bridge tells the model that `delegate_task` runs MendCode's models and names them by engine (ten per engine, the harness's own left
  out); Codex gets the same in its developer instructions. Without the bridge, MendCode's tools say in one line how it is turned on.
- A sub-agent (`task`, `delegate_task`) takes a model by the name `mendcode models` prints for it (`chatgpt/gpt-6.1-terra`,
  `claude/claude-opus`, `codex/codex:gpt-6-sol`), and so do `session create --model` and `run --model` for Claude Code and Codex
  models; they answered `unknown model`.
- A sub-agent Claude Code starts on another model (`Agent` with `model: "haiku"` from an Opus session) shows that model on its
  Agents strip row and thread header from the start. Before, the row said the session's model (Opus) until the sub-agent's first
  message arrived; a call that names no model now shows none until then.
- A finished turn no longer spends a hidden model call on a session summary. Every turn of a top-level native session sent up to
  the last 24,000 characters of the conversation (about 6k tokens) to the `summary` role, which falls back to the session's own
  model when no `small` model is set, and nothing on screen showed the result. The summary is now written only when something asks
  to show it, `/fanout compare` for its branches and `mendcode session inspect ID --summary` (`session_meta` tier, local only), once
  per session until it moves on; minimalist never writes one. `agent.summary` keeps its prompt, model and `disable`.
- Session titles and summaries go through the budget like every other daemon helper: a reached `stopUsd` blocks them, an
  expensive model needing confirmation is not called unattended, and their spend counts in the ledger. They skipped it before.
- Changing the default model while a session runs no longer breaks that session. Setting Claude Code's Opus as the default from a
  ChatGPT session (through the assistant, `/settings` or `/model`) sent `claude/claude-opus` to ChatGPT on the session's next call,
  which answered `400 model_not_found`. Now the running turn finishes on its model; a session that already ran keeps its engine
  (it takes the default it followed as its own model) and only new sessions, or ones that have not run yet, start on Claude Code. A
  default on the same engine (another ChatGPT model, another effort) is still followed. `/model` to another engine mid-turn applies
  from the next turn, and no model another engine runs (Claude Code, an ACP agent) is ever sent to a provider: a turn that would
  fails at once, saying where the model runs.
- The references `mendcode models` prints (`claude/claude-opus`, `chatgpt/gpt-6.1-terra`) work wherever a model id is read: a role,
  `/model`, `--model`. The assistant's `mendcode_settings` refuses a model role no catalog lists (naming the ids it was likely meant
  to be) or one its role cannot use, as `/model` does, and says after a change that the new main model is for new sessions.
- A daemon started by a terminal in a tuios pane no longer carries that pane's identity and token (`TUIOS_PANE_ID`,
  `TUIOS_PANE_TOKEN` and the rest), so the commands of every session stop speaking to tuios as that one pane. A terminal that hosts
  the daemon in its own process keeps them: it is that pane.
- `mendcode daemon status` no longer says `stopped` when a daemon holds the data directory but does not answer: it says
  `not answering · process N holds the data directory`, and `daemon start`, `stop` and `restart` name that process at once
  instead of waiting 5 seconds for a new daemon that could only fail on the lock.
- A Claude Code, Codex or ACP session gets MendCode's notices (a PR review's summary and findings) with their line breaks, not as one
  paragraph; each line after the first is indented, so none can pass for a `User:` line of the handoff.
- `/reviews` says `updated just now`, not `updated now ago`.
- Zod is 4.6.6: 4.6.5 could exhaust memory validating an oversized constrained collection (GHSA-mrhx-c7xc-m3w5), and the daemon
  validates what reaches it over its socket, HTTP and ACP with it.
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
