# Tiers and safe mode

The balanced/full `package_tools` feature offers the local `packages` tool only after `tool_search` discovery, even when general tool discovery is off. Its mutations always require approval; full permission mode does not bypass package review.

Balanced/full also includes pre-limit compaction checkpoints, native graph orientation/impact, focused handoff, instruction includes and static package capability previews. Caveman style and PDF/GitHub fetch modes require explicit selection. Full defaults MCP discovery on unless explicitly disabled. The event-stream model-spending watcher (I28) is excluded by lead decision.

One `tier` setting (`minimalist`, `balanced`, `full`) selects a bundle of switches that already exist. It adds no new meaning to the setup presets, the chat view, density or prompt modes: a tier only chooses which of their existing values to set and which feature modules are on. Every feature stays individually switchable. With no `tier` set, nothing changes: every feature keeps the default it had before tiers.

Names, reconciled. `minimal`/`balanced`/`full` already mean three different things, and they keep those meanings:

| Where | Values | What a tier does with it |
|---|---|---|
| Setup preset (`/setup`, [setup](setup.md)) | `default`, `minimal`, `full`, `custom` | Nothing. A tier never writes the preset or its memory and approval choices |
| Chat view (`view`, [layout](layout.md)) | `minimal`, `balanced`, `full` | `/tier` sets it to the tier's view |
| Prompt mode (`/prompt-mode`, [prompt modes](prompt-modes.md)) | `minimal`, `focus`, `guide`, `full`, `custom` | `/tier` sets the project's mode: minimalist `minimal`, balanced `focus`, full `full`; `guide` is never set by a tier |
| Density (terminal profile) | `compact`, `comfortable`, `spacious` | `/tier` sets `compact` for minimalist, `comfortable` otherwise; minimalist also hides the right bar |
| Feature modules | the manifest below | follow the tier live |

The bundle is written once by `/tier <name>` (or the Tier row of `/setup`), like a preset: a later change to one switch stays. Feature modules are different: they follow `tier` every time they are read, so a tier change needs no restart.

## Commands

- `/tier` lists the bundles, what each tier includes (`[x - -]` is minimalist, balanced, full) and what is on now and why.
- `/tier minimalist|balanced|full` applies a tier and says which features it added or removed.
- `/tier <feature> on|off|default` overrides one feature (`features.<id>` in settings). `default` removes the override.
- `/tier off` clears the tier. `/experimental` shows the experimental flags with the tier applied, plus the active overrides.
- `/setup` has a Tier row: left/right cycles none, minimalist, balanced, full and shows what the next one adds or removes.
- Local only: the daemon refuses `tier` and `features` from remote terminals and peers.

## Starting tier

The installers take `--tier minimalist|balanced|full` ([releases](release.md#starting-tier)); the choice travels in the install receipt and is
read once, by the first launch. It is a starting configuration, not a lock: it is used only while setup was never completed and no `tier`
is saved, so it never overwrites a tier or settings that already exist, `mendcode upgrade` and a reinstall do not apply it again, and `/tier`
changes the tier whenever you like. `minimalist` applies the bundle and configures itself ([setup](setup.md#first-run)); `balanced` and `full`
open the setup page with that tier selected. With no receipt (a source run, an older install) nothing changes.

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

The [README](../README.md#tiers) contains every manifest entry, generated by
`bun scripts/readme-tiers.ts` (stdout only). Replace its marked block with that output after
manifest changes. `bun scripts/readme-tiers.ts --check` and `bun test scripts/readme-tiers.test.ts`
reject drift in labels, tier inclusion, modes, switches or guide links.

The unverified OpenCode serve and Cursor SDK adapters and their tier switches have been withdrawn; see [optional engines](optional-engines.md). Saved switches are ignored while other feature overrides are preserved.

`packages/protocol/src/tier-data.ts` declares every feature once: its tier, where it costs (`tools` and `prompt` on every request, `chrome`, or `calls` of its own), the existing switch that controls it, and the tools it owns. Adding a feature means adding its entry; the budget test below checks which tools each tier offers.

| Feature | Tier | Mode | Own switch |
|---|---|---|---|
| `extensions`, `packages`, `hooks` | minimalist | kernel | only `--safe-mode`, `MENDCODE_EXTENSIONS=0`, `MENDCODE_HOOKS=0`, `disabledPackages` |
| `usage_resume` (auto-resume at a usage limit, [usage-limit](usage-limit.md)) | minimalist | tier | `/tier usage_resume off`; armed by default in every tier |
| `codegraph` (graph_*, code_search) | balanced | tier | `MENDCODE_CODEGRAPH=0` |
| `subagents` (`task`) | balanced | tier | `tools.task` |
| `script_workflows` (`workflow_script` tool, `/workflows run`; [script workflows](workflows.md#script-workflows)) | balanced | tier | `tools.workflow_script`; the tool is deferred (found through `tool_search`), so it costs no context until used |
| `threads` (`threads` tool; [sessions](sessions.md)) | balanced | tier | `experimental.thread_tools` (off without a tier) |
| `pr_watch` (`pr_watch` tool, `/pr`; [pr-watch](pr-watch.md)) | balanced | permit | `experimental.pr_watch` (network through `gh`; never on by itself) |
| `pr_review` (`/pr review`, `/pr watch-repo`; [pr-review](pr-review.md)) | balanced | permit | `experimental.pr_review` (network through `gh`, model calls; off with no tier; posting also needs the repo's `enabled: true`) |
| `output_filters` (command output filters, "tokens saved"; [advanced-config](advanced-config.md#command-output-filters)) | balanced | tier | `tool_output.filters` (off without a tier) |
| `forecast` (footer `~N turns to compact`; [layout](layout.md)) | balanced | tier | `/footer +forecast` (off without a tier) |
| `lean_tools` (only the coding core in every request, the rest through `tool_search`; [tool discovery](tool-discovery.md#lean-catalogue-and-plan-tools-tier-defaults)) | minimalist | tier | `/tier lean_tools off` (off without a tier) |
| `aux_tools` (the situational tools of the core in every request: background command output, sub-agent status, web fetch, questions, plan mode; [tool discovery](tool-discovery.md#lean-catalogue-and-plan-tools-tier-defaults)) | balanced, opt-in | tier | `/tier aux_tools on` (on without a tier; off in every tier, where each one is listed when its situation arises) |
| `harness_tools` (MendCode's tools inside [Claude Code](claude-code.md) and HTTP-MCP [ACP agents](acp-engine.md): code graph, computer use, memory, settings, image generation) | balanced | tier | `/tier harness_tools on` (off without a tier and in minimalist) |
| `plan_tools` (`todo` and the goal tools in every request) | full, opt-in | tier | `/tier plan_tools on` (on without a tier; deferred in every tier) |
| `find_tools` (`glob` and `grep` in every request; they keep minimalist's first request above the provider's cacheable minimum, [tool discovery](tool-discovery.md#lean-catalogue-and-plan-tools-tier-defaults)) | minimalist | tier | `/tier find_tools off` (on without a tier; off, `shell` searches with `rg` and `tool_search` finds them) |
| `ui_tool` (`customize_ui`, the user's screen settings, in every request) | balanced | tier | `/tier ui_tool on` (on without a tier; deferred in minimalist) |
| `orientation` (cwd, branch, test command, loaded instruction files and a top-level tree in the first user message; [tool discovery](tool-discovery.md#fewer-round-trips-reads-patches-and-the-orientation-block)) | balanced | tier | `/tier orientation off` (off without a tier) |
| `file_viewer` (a click on a path opens the file in the right slot, `/open`; [file viewer](file-viewer.md)) | balanced | tier | `pathClick` in `/customize` (`editor` turns the click off, `panel` turns it on in any tier); `/tier file_viewer off` |
| `git_hub` (`/git`: Changes, Commit, Worktrees and PR tabs, a local commit of the files you tick, and `git init` in a folder that is not a repository; [git](git.md)) | balanced | tier | `git.defaultTab`, `git.newSessionWorktree`; `/tier git_hub off` (off without a tier; no model tool, no prompt text) |
| `git_actions` (the Git page's push, publish to GitHub as a private repository and create pull request, and the PR tab's read; [git](git.md)) | balanced | permit | `experimental.git_actions` (network through your own `git` and `gh`; never on by itself; no model tool, no prompt text) |
| `mcp` (servers, `mcp__*`, `mcp_resource_*`) | full | tier | `mcp.json` |
| `thread_mcp` ([thread bridge](thread-mcp.md), cross-engine delegation) | full | permit | `threadMcp.claude` / `threadMcp.codex`, off by default |
| `jev` (adaptive reasoning) | full | tier | `experimental.reasoning_auto` |
| `idle_compact` (one compaction of a large idle session just before its prompt cache expires; [compaction](compaction.md#compaction-while-idle)) | full | tier | `/tier idle_compact on\|off`; `idleCompactAtTokens` (off without a tier) |
| `cache_countdown` (the `warm` footer segment: the minutes the prompt cache of the last call has left, `cold` after; [layout](layout.md#cache-countdown)) | full | permit | `/footer +warm` places it; no tier places it, and outside full it draws nothing unless `/tier cache_countdown on` (no call of its own beyond one `context.recent` per turn, no tool, no prompt text) |
| `wait_cache` (a native session on Anthropic whose calls were twice 5 to 60 minutes apart writes its cache at the 1-hour lifetime from then on; [prompt cache](prompt-cache.md#a-longer-lifetime-after-long-waits-wait_cache)) | full | tier | `/tier wait_cache on\|off`; ignored while `promptCacheTtl` is `1h` (off without a tier; no call of its own, no tool, no prompt text) |
| `compact_notice` (one muted transcript line when the context reaches 80% of the compaction point: tokens left, turns left, `/compact`; [compaction](compaction.md#notice-before-a-compaction)) | balanced | tier | `/tier compact_notice on\|off`; `compactNoticePercent` (off without a tier; no call, no prompt text) |
| `backlog` (your own list of pending things for a project, kept across sessions: `/backlog`, a panel card, `mendcode backlog`; [panel](sidebar.md#project-backlog)) | full | tier | `/tier backlog on\|off` (off without a tier; no model tool, no prompt text; the model reads it and never writes it) |
| `task_worktree` (`task` takes `isolation: "worktree"`: the child works in a git worktree of HEAD and its changes end on a branch of their own, never merged; [agents](agents.md#sub-agents)) | full | tier | `/tier task_worktree on\|off` (off without a tier; the argument is in the `task` schema only while it is on) |
| `task_fork` (experimental; `task` takes `fork: true`: a new child starts from the parent's latest request on the same model, so its first call reads the parent's cached prefix; every call then reads the parent's context; [agents](agents.md#forked-sub-agents)) | full | opt-in | `/tier task_fork on\|off` (no tier turns it on; the argument is in the `task` schema only while it is on) |
| `pets` | full | tier | `pet` |
| `pet_generator` (experimental; [customize](customize.md#experimental-custom-pet-generator)) | full | permit | explicit `/pet new` and confirmation; requires enabled `image_generation`, `features.pet_generator: false` blocks it |
| `voice`, `browser`, `code_mode`, `snip`, `worktree_tool` | full | permit | `voice.enabled`, `MENDCODE_BROWSER=1`, `experimental.*` |
| `one_tree` (sessions sharing one checkout: one line on a tool result that names a file another session is changing; [one tree](one-tree.md)) | balanced | tier | `/tier one_tree on\|off` (off without a tier; no tool, no prompt text, nothing while a session works alone) |
| `computer` ([computer](computer.md)), `graph_context` ([code graph](code-graph.md)) | balanced | opt-in | `/tier computer on`, `/tier graph_context on`; no tier turns them on |
| `pi` (your own pi as an engine; [pi-engine](pi-engine.md)) | full | permit | `pi.json` or `/tier pi on` |
| `storage_compact` ([storage](storage.md)) | minimalist | permit | explicit offline compaction; `features.storage_compact: false` refuses it |
| `official_packages` ([local catalog](packages.md#small-official-kit-and-trust-preview)) | balanced | permit | explicit installation; gates all three official packages |
| `autoresearch` / `web_routing` | full / balanced | permit | explicit installation; also require `official_packages` |

Modes: `tier` features are on when the tier includes them. `permit` features are opt-in or risky: the tier only allows them and their own switch must still be on, so no tier ever turns on computer control, the browser or dictation by itself. `kernel` features are not tier-gated.

Precedence, highest first: safe mode, `features.<id>`, the feature's own flag (for `jev`, an explicit `experimental.reasoning_auto`), the tier, today's default. A `tools` entry of your own beats the tier's denial of a tool.

Decisions taken: MCP belongs to `full` (the stated tier definition lists it there; `/tier mcp on` brings it to another tier). `jev` is on in `full` by default but still needs its provider configuration to do anything. Sub-agents and the code graph are in `balanced` as the savings tools. Tools are denied through the existing `tools` permission rules (see [permissions](permissions.md)), so a denied tool is out of the model's tool list and refused if called.

A tool declares a tier too: `Tool.tier` for built-in and project tools, and `tier` on an extension's `registerTool` (see [extensions](extensions.md)). A tool without a tier is in every tier; with a tier set, one that names a higher tier is not offered.

## Safe mode

Peers cannot change execution switches through `experimental`, `tools`, disabled extension/package lists or package/MCP
installation endpoints. Safe mode remains a host startup choice, checked before stored feature overrides. Local overrides
outside safe mode keep their documented meaning.

`mendcode --safe-mode` (or `MENDCODE_SAFE_MODE=1`) starts with no extensions (daemon or terminal), no installed packages, no shell hooks, no MCP and no project custom tools, whatever the settings say. It builds on `--pure`: the daemon must have been started in safe mode, so use a separate `--dir` or `--isolated` when another daemon is running. Skills and commands in your own folders still load (they are prompt data, not code). `/doctor` shows a Mode section, and `daemon.info` reports `safeMode`. Settings are untouched, so restarting without the flag restores everything.

## Baseline budget

`packages/daemon/test/tier.test.ts` builds the first request of a fresh session for each tier through the real engine, a fake provider and the real prompt modes, and counts the system prompt plus every tool definition (characters over four, a growth guard rather than an exact cost). Stored budgets: minimalist 3,500, balanced 5,000, full 6,400 estimated tokens for the test's tool pool (built-in, code graph, computer, browser and two fake MCP tools, with sub-agents on); measured 3,354, 4,808 and 6,111. The test also requires minimalist < balanced < full and checks which tools each tier offers. The budgets came down from 3,700 / 5,250 / 9,100 when the core tools' descriptions were cut to what a model needs (a limit, an output shape, a failure), stated once: an entry of `read`'s `paths` no longer repeats the descriptions of the top-level keys. A change that makes a tier bigger fails it: raise the number on purpose in review, or move the cost to a higher tier.

Project context is measured separately because it depends on the project, not on the tier: `packages/daemon/test/tier-instructions.test.ts` composes the system prompt of each tier's prompt mode for a fixture project (a 1.6 KB `AGENTS.md` and five skills) and stores what that project adds. Every mode now carries the user's instructions and `focus`/`full` carry the compact skill catalog ([prompt modes](prompt-modes.md)), so the fixture adds 204 (minimalist), 346 (balanced) and 346 (full) estimated tokens; before, it added 0, 0 and 346, because minimal and focus dropped `AGENTS.md` and focus dropped the catalog. The per-tier baseline numbers above are for a project without instruction files or skills and did not change. An `AGENTS.md` is capped at 16,000 characters (about 4,000 tokens) per file and 64,000 in total, so the worst case per mode is bounded.
