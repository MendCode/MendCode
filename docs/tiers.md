# Tiers and safe mode

Choose a tier to set a bundle of existing switches for the chat view, prompt mode and feature modules. Every feature stays individually switchable; with no `tier` set, every feature keeps the default it had before tiers.

## Choose a tier

1. Run `/tier` to see the bundles and what is on now and why.
2. Apply `/tier minimalist|balanced|full`, or use the Tier row of `/setup`.
3. Change individual switches as needed. A later change stays; feature modules follow `tier` live whenever they are read, with no restart.

One `tier` setting (`minimalist`, `balanced`, `full`) selects the bundle. It adds no new meaning to setup presets, the chat view, density or prompt modes: it only chooses existing values and which feature modules are on.

### What the names mean

`minimal`/`balanced`/`full` already mean three different things, and they keep those meanings:

| Where | Values | What a tier does with it |
|---|---|---|
| Setup preset (`/setup`, [setup](setup.md)) | `default`, `minimal`, `full`, `custom` | Nothing. A tier never writes the preset or its memory and approval choices |
| Chat view (`view`, [layout](layout.md)) | `minimal`, `balanced`, `full` | `/tier` sets it to the tier's view |
| Prompt mode (`/prompt-mode`, [prompt modes](prompt-modes.md)) | `minimal`, `focus`, `guide`, `full`, `custom` | `/tier` sets the project's mode: minimalist `minimal`, balanced `focus`, full `full`; `guide` is never set by a tier |
| Jobs dock panel (terminal settings) | `dockJobs: false` by default in every tier; opt-in through `/customize` > Top & side > Dock jobs | Only the balanced/full dock renders it; minimalist stays chrome-free and `/jobs` remains independent |
| Density (terminal settings) | `compact`, `comfortable`, `spacious` | `/tier` sets `compact` for minimalist, `comfortable` otherwise; minimalist also hides the right bar; balanced and full turn `showEffort` on |
| Footer (the row under the prompt) | follows the view | minimal has none; balanced and full draw the `clean` footer pack until you choose a footer (`footerPack`, [customize](customize.md#footer-packs)); with `footerPack: off` balanced places its segments and full draws the `line` preset ([layout](layout.md#footer-by-tier)) |
| Feature modules | the manifest below | follow the tier live |

The bundle is written once by `/tier <name>` (or the Tier row of `/setup`), like a preset: a later change to one switch stays. Feature modules are different: they follow `tier` every time they are read, so a tier change needs no restart.

## Commands

| Command | Does |
|---|---|
| `/tier` | Lists bundles, what each includes (`[x - -]` is minimalist, balanced, full), and what is on now and why |
| `/tier minimalist|balanced|full` | Applies a tier and says which features it added or removed |
| `/tier <feature> on|off|default` | Overrides one feature (`features.<id>` in settings); `default` removes the override |
| `/tier off` | Clears the tier |
| `/experimental` | Shows experimental flags with the tier applied, plus active overrides |
| `/setup` | Tier row: left/right cycles none, minimalist, balanced, full and shows what the next one adds or removes |

**Note:** Tier changes are local only. The daemon refuses `tier` and `features` from remote terminals and peers.

## Starting tier

The installers take `--tier minimalist|balanced|full` ([releases](release.md#starting-tier)). The choice travels in the install receipt and is read once, by the first launch.

It is a starting configuration, not a lock:

- It is used only while setup was never completed and no `tier` is saved, so it never overwrites a tier or settings that already exist.
- `mendcode upgrade` and a reinstall do not apply it again.
- `/tier` changes the tier whenever you like.

| Starting tier | First launch |
|---|---|
| `minimalist` | Applies the bundle and configures itself ([setup](setup.md#first-run)) |
| `balanced` and `full` | Open the setup page with that tier selected |
| No receipt: a source run or older install | Nothing changes |

## Slash commands

Minimalist lists twenty-one built-in slash commands, three fewer than pi's twenty-four (`settings model tree thinking scoped-models export import
share bug copy name session changelog hotkeys fork clone trust login logout new compact resume reload quit`). The set is `MINIMALIST_SLASH` in
`packages/protocol/src/tier-data.ts`: `new sessions model connect compact settings fork export copy rename usage tree undo redo plan permissions tier
trust help shortcuts quit`. `tree` is there because it is how a message is found, jumped to and forked at in every tier. `tier` and `settings` are in it so everything else is one step away; `connect` is how a provider is added.

- The slash menu (browse and search), `/help` and the command palette list that set only. Balanced and full list every built-in command whose
  feature is on, as before, and with no tier nothing is hidden. Your own commands, skills, extension commands and MCP prompts are never hidden by a tier.
- A hidden command typed by hand runs nothing and answers in one line, the tier that has it and how to get there: `/review · balanced · /tier balanced`
  The line is not kept in the prompt history. Commands of a feature (`/panel`, `/mcps`, `/fanout`, `/voice`, `/pet`...) are absent from
  browsing while their feature is off; typed exactly they show one row naming the switch (`/pr  off · /tier balanced`), and Enter on it runs
  nothing ([commands](commands.md#aliases)). `/panel` ("presets need the balanced or full view") and `/sidebar` still answer for themselves.
  `/tutorial` is not in the set; add it back (below) to keep the tour.
- Customizing stays free. The per-command `hidden` preference of the slash menu decides regardless of tier: `hidden: false` lists a command
  minimalist would not (and it runs), `hidden: true` removes one from browsing as it always did (still searchable and runnable). In
  `/settings slashCommands` (the **Slash menu → Edit commands** row, also under `/customize`) `h` flips the selected command and the row says
  `shown`, `hidden` or `hidden by tier`; the preference is written only where it differs from the tier, so a command flipped back follows the tier
  again. A feature you switch on yourself (`/tier <feature> on`, `features.<id>: true`) also brings its command into minimalist. A command whose
  feature is off stays out of the menu even with `hidden: false`.

## Feature manifest

### Included features and explicit choices

The balanced/full `profile_tools` feature offers the local `profiles` tool only after `tool_search` discovery, even when general tool discovery is off. Its mutations always require approval; full permission mode does not bypass profile review.

Balanced/full also includes:

- Pre-limit compaction checkpoints.
- Native graph orientation/impact and focused handoff.
- Instruction includes and static profile capability previews.

Caveman style and PDF/GitHub fetch modes require explicit selection. Full defaults MCP discovery on unless explicitly disabled. The event-stream model-spending watcher (I28) is excluded by lead decision.

### Maintain the manifest

The [README](../README.md#tiers) contains every manifest entry, generated by
`bun scripts/readme-tiers.ts` (stdout only). Replace its marked block with that output after
manifest changes. `bun scripts/readme-tiers.ts --check` and `bun test scripts/readme-tiers.test.ts`
reject drift in labels, tier inclusion, modes, switches or guide links.

The unverified OpenCode serve and Cursor SDK adapters and their tier switches have been withdrawn; see [optional engines](optional-engines.md). Saved switches are ignored while other feature overrides are preserved.

`packages/protocol/src/tier-data.ts` declares every feature once: its tier, where it costs (`tools` and `prompt` on every request, `chrome`, or `calls` of its own), the existing switch that controls it, and the tools it owns. Adding a feature means adding its entry; the budget test below checks which tools each tier offers.

| Feature | Tier | Mode | Own switch |
|---|---|---|---|
| `extensions`, `profiles`, `hooks` | minimalist | kernel | only `--safe-mode`, `MENDCODE_EXTENSIONS=0`, `MENDCODE_HOOKS=0`, `disabledProfiles` |
| `usage_resume` (auto-resume at a usage limit, [usage-limit](usage-limit.md)) | minimalist | tier | `/tier usage_resume off`; armed by default in every tier |
| `codegraph` (graph_*, code_search) | balanced | tier | `MENDCODE_CODEGRAPH=0` |
| `subagents` (`task`) | balanced | tier | `tools.task` |
| `script_workflows` (`workflow_script` tool, `/workflows run`; [script workflows](workflows.md#script-workflows)) | balanced | tier | `tools.workflow_script`; the tool is deferred (found through `tool_search`), so it costs no context until used |
| `threads` (`threads` tool; [sessions](sessions.md)) | balanced | tier | `experimental.thread_tools` (off without a tier) |
| `pr_watch` (`pr_watch` tool, `/pr`; [pr-watch](pr-watch.md)) | balanced | permit | `experimental.pr_watch` (network through `gh`; never on by itself) |
| `pr_review` (`/pr review`, `/pr watch-repo`; [pr-review](pr-review.md)) | balanced | permit | `experimental.pr_review` (network through `gh`, model calls; off with no tier; `/pr setup` can allow it in a lower tier with `features.pr_review: true`; posting also needs the repo's `enabled: true`) |
| `output_filters` (command output filters, "tokens saved"; [advanced-config](advanced-config.md#command-output-filters)) | balanced | tier | `tool_output.filters` (off without a tier) |
| `forecast` (footer `~N turns to compact`; [layout](layout.md)) | balanced | tier | `/footer +forecast` (off without a tier) |
| `lean_tools` (only the coding core in every request, the rest through `tool_search`; [tool discovery](tool-discovery.md#lean-catalogue-and-plan-tools-tier-defaults)) | minimalist | tier | `/tier lean_tools off` (off without a tier) |
| `aux_tools` (the situational tools of the core in every request: background command output, sub-agent status, web fetch, questions, plan mode; [tool discovery](tool-discovery.md#lean-catalogue-and-plan-tools-tier-defaults)) | balanced, opt-in | tier | `/tier aux_tools on` (on without a tier; off in every tier, where each one is listed when its situation arises) |
| `harness_tools` (MendCode's tools inside [Claude Code](claude-code.md), [Codex](claude-code.md) and HTTP-MCP [ACP agents](acp-engine.md): code graph, computer use, memory, settings, image generation; without `thread_mcp`, one line on how sub-agents on MendCode's other models are turned on) | balanced | tier | `/tier harness_tools on` (off without a tier and in minimalist) |
| `plan_tools` (`todo` and the goal tools in every request) | full, opt-in | tier | `/tier plan_tools on` (on without a tier; deferred in every tier; `todo` itself follows `visible_plan`; the goal tools are listed in every tier while a goal is unfinished) |
| `visible_plan` (`todo` listed in every request and one guidance line; lists remain in the transcript, Todos dock and sidebar, with no current-task row; [layout](layout.md#the-visible-plan)) | balanced | tier | `/tier visible_plan off` (on without a tier; minimalist has no `todo` tool at all, not even through `tool_search`) |
| `find_tools` (`glob` and `grep` in every request; they keep minimalist's first request above the provider's cacheable minimum, [tool discovery](tool-discovery.md#lean-catalogue-and-plan-tools-tier-defaults)) | minimalist | tier | `/tier find_tools off` (on without a tier; off, `shell` searches with `rg` and `tool_search` finds them) |
| `ui_tool` (`customize_ui`, the user's screen settings, in every request) | balanced | tier | `/tier ui_tool on` (on without a tier; deferred in minimalist) |
| `orientation` (cwd, branch, test command, loaded instruction files and a top-level tree in the first user message; [tool discovery](tool-discovery.md#fewer-round-trips-reads-patches-and-the-orientation-block)) | balanced | tier | `/tier orientation off` (off without a tier) |
| `file_viewer` (a click on a path opens the file in the right slot, `/open`; [file viewer](file-viewer.md)) | balanced | tier | `pathClick` in `/customize` (`editor` turns the click off, `panel` turns it on in any tier); `/tier file_viewer off` |
| `git_hub` (`/git`: Changes, Commit, Worktrees and PR tabs, a local commit of the files you tick, and `git init` in a folder that is not a repository; [git](git.md)) | balanced | tier | `git.defaultTab`, `git.newSessionWorktree`; `/tier git_hub off` (off without a tier; no model tool, no prompt text) |
| `git_actions` (the Git page's push, publish to GitHub as a private repository and create pull request, and the PR tab's read; [git](git.md)) | balanced (switched on by default in full) | permit | `experimental.git_actions` (network through your own `git` and `gh`; balanced needs the switch, full has it on until you set it off; every push, publish and pull request still waits for Enter on a card with its exact command; no model tool, no prompt text, no tokens) |
| `memory_auto` (memory works by itself: saved facts reach prompts, a post-turn extractor proposes them, Dream consolidates Pending every night; any memory switch you set keeps your value, see [memory](memory.md#memory-by-tier)) | full | tier | `/tier memory_auto off`; balanced and minimalist keep their memory switches as set |
| `resume_context` (the system prompt of a new chat carries at most 1 800 characters (nothing stored in the session) on what the latest sessions of this project, and of others, were doing) | full | tier | `/tier resume_context off` |
| `graph_autopilot` (MendCode builds the [code graph](code-graph.md#autopilot) of a real project by itself, refreshes it after ten changed files or 3%, and one ~70-token prompt line tells the model to locate code with it first; also reaches Claude Code, Codex and ACP agents) | full | tier | `/tier graph_autopilot on\|off`; **on by default only in nightly, dev and local builds** (the binary's channel), off in beta and stable until switched on; minimalist and balanced have nothing new |
| `mcp` (servers, `mcp__*`, `mcp_resource_*`) | full | tier | `mcp.json` |
| `codex_engine` (Codex as its own harness: its `codex:` models run in Codex on the Codex CLI's login; nothing runs at rest; [setup](setup.md)) | minimalist, opt-in | tier | `/tier codex_engine on` or setup's `Use Codex` (off by default, in every tier and without one) |
| `thread_mcp` ([thread bridge](thread-mcp.md), cross-engine delegation: a Claude Code, Codex or ACP session's sub-agents on MendCode's other models, which its instructions name by engine) | full | permit | `threadMcp.claude` / `threadMcp.codex`, off by default |
| `jev` (adaptive reasoning) | full | tier | `experimental.reasoning_auto` |
| `idle_compact` (one compaction of a large idle session just before its prompt cache expires; [compaction](compaction.md#compaction-while-idle)) | full | tier | `/tier idle_compact on\|off`; `idleCompactAtTokens` (off without a tier) |
| `cache_countdown` (the `warm` footer segment: the minutes the prompt cache of the last call has left, `cold` after; [layout](layout.md#cache-countdown)) | full | permit | `/footer +warm` places it; no tier places it, and outside full it draws nothing unless `/tier cache_countdown on` (no call of its own beyond one `context.recent` per turn, no tool, no prompt text) |
| `wait_cache` (a native session on Anthropic whose calls were twice 5 to 60 minutes apart writes its cache at the 1-hour lifetime from then on; [prompt cache](prompt-cache.md#a-longer-lifetime-after-long-waits-wait_cache)) | full | tier | `/tier wait_cache on\|off`; ignored while `promptCacheTtl` is `1h` (off without a tier; no call of its own, no tool, no prompt text) |
| `message_threads` (a native session on Anthropic's own API with an API key sends only its new messages in a message thread, beta: the same price, a shorter wait for the first token; [message threads](message-threads.md)) | minimalist | tier | `/tier message_threads on\|off`; `zeroDataRetention: true` keeps it off (not ZDR eligible); safe mode turns it off (no call, tool or prompt text of its own) |
| `whats_new` (`/whatsnew`: what changed since your last look and one model call that picks what fits you, each pick with an action you preview and confirm; `/whatsnew all` lists the whole changelog with no call; [what's new](whats-new.md)) | balanced | tier | `/tier whats_new on\|off` (on without a tier; one call only when you type `/whatsnew`, no tool, no prompt text; minimalist keeps the copyable prompt of the release notes) |
| `compact_notice` (one muted transcript line when the context reaches 80% of the compaction point: tokens left, turns left, `/compact`; [compaction](compaction.md#notice-before-a-compaction)) | balanced | tier | `/tier compact_notice on\|off`; `compactNoticePercent` (off without a tier; no call, no prompt text) |
| `backlog` (your own list of pending things for a project, kept across sessions: `/backlog`, a panel card, `mendcode backlog`; [panel](sidebar.md#project-backlog)) | full | tier | `/tier backlog on\|off` (off without a tier; no model tool, no prompt text; the model reads it and never writes it) |
| `task_worktree` (`task` takes `isolation: "worktree"`: the child works in a git worktree of HEAD and its changes end on a branch of their own, never merged; [agents](agents.md#sub-agents)) | full | tier | `/tier task_worktree on\|off` (off without a tier; the argument is in the `task` schema only while it is on) |
| `task_fork` (experimental; `task` takes `fork: true`: a new child starts from the parent's latest request on the same model, so its first call reads the parent's cached prefix; every call then reads the parent's context; [agents](agents.md#forked-sub-agents)) | full | opt-in | `/tier task_fork on\|off` (no tier turns it on; the argument is in the `task` schema only while it is on) |
| `pets` | full | tier | `pet` |
| `pet_generator` (experimental; [customize](customize.md#experimental-custom-pet-generator)) | full | permit | explicit `/pet new` and confirmation; requires enabled `image_generation`, `features.pet_generator: false` blocks it |
| `voice`, `browser`, `code_mode`, `snip`, `worktree_tool` | full | permit | `voice.enabled`, `MENDCODE_BROWSER=1`, `experimental.*` |
| `one_tree` (sessions sharing one checkout: one line on a tool result that names a file another session is changing; [one tree](one-tree.md)) | balanced | tier | `/tier one_tree on\|off` (off without a tier; no tool, no prompt text, nothing while a session works alone) |
| `plan_files` (accepted and applied plans saved as Markdown, a pointer line after compaction, `sessions plans=true`; [plan review](plan-review.md#plan-files)) | balanced | tier | `/tier plan_files on\|off` (off without a tier; `plan_files_location`; nothing is written or sent in a session without a plan) |
| `computer` ([computer](computer.md)), `graph_context` ([code graph](code-graph.md)) | balanced | opt-in | `/tier computer on`, `/tier graph_context on`; no tier turns them on |
| `pi` (your own pi as an engine; [pi-engine](pi-engine.md)) | full | permit | `pi.json` or `/tier pi on` |
| `storage_compact` ([storage](storage.md)) | minimalist | permit | explicit offline compaction; `features.storage_compact: false` refuses it |
| `official_profiles` ([local catalog](packages.md#small-official-kit-and-trust-preview)) | balanced | permit | explicit installation; gates all three official profiles |
| `autoresearch` / `web_routing` | full / balanced | permit | explicit installation; also require `official_profiles` |

Modes: `tier` features are on when the tier includes them. `permit` features are opt-in or risky: the tier only allows them and their own switch must still be on, so no tier ever turns on computer control, the browser or dictation by itself. `kernel` features are not tier-gated.

Precedence, highest first: safe mode, `features.<id>`, the feature's own flag (for `jev`, an explicit `experimental.reasoning_auto`), the tier, today's default. A `tools` entry of your own beats the tier's denial of a tool.

Decisions taken: MCP belongs to `full` (the stated tier definition lists it there; `/tier mcp on` brings it to another tier). `jev` is on in `full` by default but still needs its provider configuration to do anything. Sub-agents and the code graph are in `balanced` as the savings tools. Tools are denied through the existing `tools` permission rules (see [permissions](permissions.md)), so a denied tool is out of the model's tool list and refused if called.

A tool declares a tier too: `Tool.tier` for built-in and project tools, and `tier` on an extension's `registerTool` (see [extensions](extensions.md)). A tool without a tier is in every tier; with a tier set, one that names a higher tier is not offered.

## Safe mode

Peers cannot change execution switches through `experimental`, `tools`, disabled extension/package lists or package/MCP
installation endpoints. Safe mode remains a host startup choice, checked before stored feature overrides. Local overrides
outside safe mode keep their documented meaning.

Start with `mendcode --safe-mode` (or `MENDCODE_SAFE_MODE=1`). Whatever the settings say, this disables:

- Extensions, daemon or terminal, and installed profiles.
- Shell hooks and MCP.
- Project custom tools.

Safe mode builds on `--pure`: the daemon must have been started in safe mode. Use a separate `--dir` or `--isolated` when another daemon is running.

Skills and commands in your own folders still load because they are prompt data, not code. `/doctor` shows a Mode section, and `daemon.info` reports `safeMode`.

Settings are untouched. Restarting without the flag restores everything.

## Baseline budget

`packages/daemon/test/tier.test.ts` builds the first request of a fresh session for each tier through the real engine, a fake provider and the real prompt modes, and counts the system prompt plus every tool definition (characters over four, a growth guard rather than an exact cost).

Stored budgets: minimalist 3,500, balanced 4,800, full 6,400 estimated tokens for the test's tool pool (built-in, code graph, computer, browser and two fake MCP tools, with sub-agents on); measured 3,402, 4,780 and 6,291 (balanced was 5,023 before its prompt told the terminal's drawing in one sentence instead of the full block: [prompt modes](prompt-modes.md)) (grep's `context` and edit's `edits` cost nothing: see [tool discovery](tool-discovery.md)).

The test also requires minimalist < balanced < full and checks which tools each tier offers.

The budgets came down from 3,700 / 5,250 / 9,100 when the core tools' descriptions were cut to what a model needs (a limit, an output shape, a failure), stated once: an entry of `read`'s `paths` no longer repeats the descriptions of the top-level keys.

A change that makes a tier bigger fails it: raise the number on purpose in review, or move the cost to a higher tier.

Project context is measured separately because it depends on the project, not on the tier: `packages/daemon/test/tier-instructions.test.ts` composes the system prompt of each tier's prompt mode for a fixture project (a 1.6 KB `AGENTS.md` and five skills) and stores what that project adds.

Every mode now carries the user's instructions and `focus`/`full` carry the compact skill catalog ([prompt modes](prompt-modes.md)), so the fixture adds 204 (minimalist), 346 (balanced) and 346 (full) estimated tokens; before, it added 0, 0 and 346, because minimal and focus dropped `AGENTS.md` and focus dropped the catalog.

The per-tier baseline numbers above are for a project without instruction files or skills and did not change. An `AGENTS.md` is capped at 16,000 characters (about 4,000 tokens) per file and 64,000 in total, so the worst case per mode is bounded.
