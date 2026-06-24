# Changelog

## 0.1.18 - 2026-06-24

### Added

- Add goal-driven Loop Workflow budget modes: `fixed`, `max-goal`, and `unbounded-monitor`.
- Add Loop Workflow completion criteria, success checks, target turns, reserved verification turns, machine-readable checkpoints, and optional owner-session completion notifications.
- Add provider disconnect support from the Connect Provider dialog for locally saved provider auth.
- Add TSM shortcut support for creating an explicit missing branch before opening it in a split MendCode pane.

### Fixed

- Fix Loop Workflow execution so implementation loops that explicitly allow edits are not downgraded to report-only by a conservative background service.
- Refresh Loop Workflow receipts with clearer spacing plus model, mode, trigger/event, agent, chat, workflow, and goal details.
- Keep loop session headers, run checkpoints, and the `/loops` dashboard aligned with the currently running iteration instead of lagging one completed run behind.
- Keep Herdr loop-session panes in a working loop state between iterations and only report completion after the workflow reaches a terminal state.
- Resume active provider compaction automatically and add trigger context so compaction summaries do not falsely close unfinished work.
- Preserve a bounded snapshot of the retained recent tail during compaction so summaries keep the latest unfinished request, tool output, and resume context.
- Keep the active loop count only in the prompt footer, expose `/loop` from the new-chat screen, make `/loop` Tab completion non-submitting, and remove duplicate `/loops` slash entries.
- Accept loop model variants through the `variant` field or provider/model#variant syntax for any provider.
- Keep the `/loops` dashboard cursor out of read-only detail rows so the `updated` field no longer looks editable.
- Keep Herdr agent state from staying `working` after a session finishes and no longer appears in status output.
- Report clearer `--worktree` and `--tsm` errors outside git repositories or before the first commit.
- Strip command frontmatter metadata from opencode provider schemas/options so strict providers do not reject structured output or noop tool schemas.

### Changed

- Treat `maxTurns` as an iteration budget for goal work instead of a requirement to spend every available loop turn.
- Improve `/loops` timeline loading and scrolling so recent workflow events remain inspectable without overwhelming compact terminals.
- Scope model variant selection to the newly selected model before deciding whether to open the variant picker.
- Refresh opencode Go/OpenRouter reasoning variant mapping for GLM-5.2, MiniMax M3, and widely supported effort levels.
- Clean up slash-command fallbacks and aliases so command names do not collide.

### CI

- Skip CodeQL for docs-only, changelog-only, and public asset-only PRs while keeping CodeQL on source changes, main pushes, scheduled runs, and manual dispatch.
- Consolidate Security Guard scanners into one deep-scanner job while preserving gitleaks, OSV, zizmor, and Semgrep policy enforcement.
- Reduce release workflow artifact retention from 30 days to 7 days to cut Actions storage pressure.

### Docs

- Update the Loop Workflow events spec with goal semantics, checkpoint behavior, budget exhaustion rules, and acceptance checks.

### Tests

- Add coverage for goal-budget loop completion/blocking, owner notifications, compaction tail snapshots, provider schema cleanup, reasoning variants, TSM/worktree shortcut edge cases, Herdr idle reporting, and structured-output schema transformation.

## 0.1.17 - 2026-06-23

### Added

- Loop Workflows: durable workflow records, draft/activate/tick lifecycle, run journals, loop root sessions, Agent View grouping, terminal monitor, HTTP routes, SDK types, and a built-in `loop` assistant tool.
- Safe loop execution modes: dry-run ticks, `--execute --report-only` wakeups that deny mutation/shell/subagent tools, full execution for trusted contexts, and per-project OS service support for macOS LaunchAgent, Linux user systemd, and Windows Task Scheduler.
- Built-in loop templates for PR watching, CI repair, research digests, and repo maintenance, plus CLI/status/monitor docs for loop lifecycle, daemon, service, logs, and troubleshooting.
- Changes Review: a MendCode-native `/changes` TUI route for working-tree diffs with file navigation, diff-block navigation, line selection, reload, responsive layouts, inline comments, and stale-comment reconciliation.
- Assistant-visible review context through bounded `<mendcode_review_context>` summaries and a `review` tool for current selection, file summaries, navigation, reload, comment creation, listing, and clearing.
- Local review-state persistence keyed by workspace root so comments and selection can be recovered across route/process boundaries without writing raw patches into the repository.
- Richer Usage Insights: selected-day keyboard/mouse navigation, a GitHub-style daily token grid, month markers, selected-day token/session/prompt/word/file/time details, improved clock layout, and expanded aggregation for tool/runtime activity.
- Project Usage Insights shortcuts and docs for global, project, and directory scopes.
- Streaming Markdown rendering for assistant output so headings, inline formatting, tables, code fences, Mermaid text, and hex color swatches can appear progressively without waiting for a completed message.
- Claude Code CLI provider discovery and validation: provider list entry, local CLI auth validation, version-aware model listing, optional binary/home/launch-arg settings, and API-provider wiring once the local CLI is authenticated.
- Frontmatter argument-hint parsing and prompt metadata improvements for command/prompt surfaces.

### Changed

- Render compaction summaries through the styled Markdown path so tables and formatted summaries stay readable in the session timeline.
- Rename provider setup surfaces from generic `Provider` to `Connect Provider` where the UI is specifically about connecting/authenticating a provider.
- Refresh README screenshots, feature mapping, setup/configuration docs, and usage-insights docs for the 0.1.17 surfaces.
- Update package, lockfile, and Zed extension metadata to `0.1.17`.

### Fixed

- Prevent incomplete streaming Markdown tables and code fences from rendering early before they can display coherently.
- Deduplicate live shell-output deltas so repeated command output does not replay the same latest line while a tool is still streaming.
- Report missing Claude Code CLI binaries as validation errors instead of letting provider discovery throw raw `ENOENT` exceptions.
- Preserve the `0.1.16` reasoning-history behavior after the local OpenAI reasoning replay experiment was reverted.

### Tests

- Add coverage for loop services/routes/session/tool behavior, Changes Review state/actions/comments/context, Usage Insights selection and aggregation, streaming Plan Markdown, shell-output replay prevention, Claude Code provider settings/validation, prompt metadata, and TUI route behavior.

## 0.1.16 - 2026-06-20

- Fix Memory Center Dream scheduling proposals so accepting a side-chat `dream-dry-run` proposal writes the Dream scheduler state instead of only saving an ordinary memory proposal.
- Recover Dream scheduler state from already-applied Dream proposals, so users who accepted a Dream schedule proposal in `0.1.15` see the Dream page become scheduled after upgrading.
- Add Dream schedule parsing for human time windows such as `6pm to 11pm local time`, `18:00-23:00`, and fixed times such as `21:00 Europe/London`.
- Add regression coverage for side-chat Dream proposal application, Dream schedule recovery, and human-readable Dream time parsing.

## 0.1.15 - 2026-06-19

- Add a route-level Memory Center in the TUI with Overview, Project memories, Global memories, Policy & categories, and Dream tabs.
- Add saved/pending memory review surfaces with keyboard actions for applying, rejecting, editing, deleting, moving, and inspecting memories without leaving the terminal.
- Add category-aware memory metadata, policy normalization, scope reasoning, evidence references, and reviewable proposal operations for verify, expire, recategorize, relink, demote-scope, and promote-scope flows.
- Add a memory graph sidecar with legacy-entry bridging so memories can be grouped, indexed, and queried by category while preserving the existing flat memory files.
- Add workspace-aware memory grouping so the Memory Center can show the current project plus other known project memory scopes.
- Add Dream memory maintenance primitives: proposal-only Dream runs, bounded/redacted evidence collection, run logs, scheduler state, source manifests, missed-window handling, and safety reporting.
- Add a constrained memory side chat backed by the `memoryAssistant` role so users can ask about memory state, draft memory actions, and inspect category policy without turning the Memory page into a general coding agent.
- Add `memoryDream` and `memoryAssistant` model roles to local memory/model configuration while keeping generated memory writes approval-gated by default.
- Label retrieved prompt memory by scope and category while preserving the existing `<mendcode_memory>` compatibility block.
- Feed recent conversation context into post-turn memory extraction so proposals can distinguish durable facts from isolated one-line messages.
- Add Memory HTTP/API routes for side-chat calls and wire the route into both the experimental HttpApi surface and instance routes.
- Add a `Memory Center` command palette route and keep the existing lightweight `Memory Manager` proposal dialog as a separate command.
- Add `/memory-center`, `/memories`, `/memory-manager`, `/memory`, and `/mem` routing so slash commands can open the right memory surface.
- Add scrollable previews to the Memory Manager dialog so long proposal bodies do not overflow compact terminals.
- Add screenshot-backed public docs for the README hero, home layouts, Agent View, Plan Mode, and Memory Center.
- Add `docs/features.md` as the product-facing feature map for README, website, screenshot, and demo work.
- Add `docs/memory-center.md` and a Memory Graph/Dream spec to document the new memory workspace and safety model.
- Refresh the README into a public product page with install paths, product surfaces, documentation map, development notes, security/community pointers, star history, and an expanded agent-context block.
- Refresh the docs index, setup/configuration docs, customization docs, Plan Mode docs, Usage Insights docs, and package-sharing docs to point at implemented screenshots and provider-neutral examples.
- Document `memoryDream` and `memoryAssistant` roles alongside existing model roles, and keep public model examples provider-neutral.
- Add a dedicated Shift+Tab Mode picker for primary agents, moving reverse agent cycling off Shift+Tab so the key opens the expected mode selector.
- Make the prompt model, provider, and variant labels resolve from the selected prompt model metadata instead of stale local/session labels.
- Track whether local model and variant state came from the user or session hydration, so explicit local changes win over older hydrated session state.
- Persist submitted prompt agent/model selections onto the session before generation so resumed sessions and Agent View reflect the real active selection.
- Preserve assistant provider/model/variant metadata when sync events arrive with partial message updates.
- Keep prompt status script output tied to the current prompt-status identity so stale script output from an older model/session/root is not reused.
- Show the currently selected model in the working indicator instead of the broader local parsed model when the prompt is using a session/subagent selection.
- Add Markdown-rendering capability notes to non-minimal prompt policy so agents know the TUI supports headings, lists, tables, code fences, links, checklists, blockquotes, and Mermaid text diagrams.
- Replace the Plan Review renderer path with a stable styled Markdown component instead of relying on the experimental Markdown flag.
- Improve Plan Review table rendering with grid mode, wrapped cells, and better handling for file/action/detail tables.
- Improve terminal Mermaid rendering for state diagrams, class diagrams, pie charts, Gantt charts, git graphs, requirement diagrams, journeys, timelines, and other common diagram shapes.
- Add static Plan Markdown rendering helpers and Mermaid fence detection for tests and non-interactive surfaces.
- Add hex color parsing/swatches so Markdown tables that list colors can render clean terminal previews.
- Improve chat/timeline presentation for todo writes, questions, plan-review prompts, permission prompts, and grouped tool activity.
- Remove the separate subagent footer file and fold subagent/session footer behavior into the main session layout.
- Improve session layout sizing and compact terminal behavior around message rendering, plan review, usage/status surfaces, and bottom prompt chrome.
- Add the built-in Herdr agent-state plugin so MendCode panes can report idle, working, blocked, needs-input, approval, plan-pending, retry, and error state to Herdr without requiring a separate user plugin.
- Read project-local `.mendcode/mcp` server config into the MCP runtime, status, tools, prompts, and resources paths so project MCP servers participate alongside global config.
- Sync generated project config when `mendcode` starts if the generated opencode config is stale.
- Make `mendcode --worktree .` and current-worktree shortcuts resolve more naturally, including current-branch fallback when no non-base worktree exists.
- Make control-plane output for mflow, TSM, and worktrees human-readable by default while keeping `--json` available for scripts.
- Make `mendcode mcp add-local` sync generated runtime config after writing project MCP config.
- Use provider-neutral defaults for memory preview commands instead of hard-coded public provider/model examples.
- Add setup smoke coverage for memory/model-role fields and package/runtime configuration.
- Add tests for Memory Center layout helpers, memory categories, graph/proposals/retrieval, Dream events/scheduler/sources, HTTP memory routes, prompt compose, prompt model/variant resolution, prompt status identity, plan Markdown rendering, Herdr plugin reporting, MCP project config, worktree shortcuts, setup, TSM, runtime pack, and session prompt metadata.
- Refresh release-gated dependencies and lockfile overrides for DOMPurify, Undici, form-data, esbuild, Slack Bolt, and OpenTelemetry so the OSV release scanner can pass without disabling supply-chain checks.

## 0.1.14 - 2026-06-16

- Make `mendcode packages install <pack-id>` install a selected package from the official or chosen registry catalog instead of applying a whole source by accident.
- Keep source-level package application available as `mendcode packages install-source <source-id>` for existing local/team registry workflows.
- Let the setup Package step skip packages, browse official packages, install a local package path, create/update a local package snapshot, or manage installed overlays.
- Add registry coverage for multi-package catalogs, selected pack installation, source-level install compatibility, and runtime compatibility rejection.
- Update `protobufjs` to `7.6.3` so the release dependency gate can pass with the fixed version.

## 0.1.13 - 2026-06-16

- Refresh the Bash and PowerShell installers with a clearer MendCode banner, numbered install phases, ASCII progress output, and more direct next-step guidance.
- Make installer guidance honest after `curl | bash`: run the installed binary by absolute path immediately, or open/source a terminal before using `mendcode` from `PATH`.
- Keep MendCode-owned setup config keys such as `memory` and `package` from crashing the runtime config loader after first-run setup creates `.mendcode/mendcode.json`.
- Honor dynamic `OPENCODE_CONFIG_CONTENT` values at config-load time so SDK/runtime callers can inject per-instance config after process startup.
- Preserve explicit model changes made while a session is busy so the next prompt uses the newly selected model instead of falling back to the previous session model.
- Point npm registry publishing at the public `mendcode` package name instead of the temporary `mendcode-ai` wrapper name.
- Update Hono to `4.12.25` so release dependency scanning passes without carrying known fixed advisories.

## 0.1.12 - 2026-06-16

- Show the upstream `opencode` provider in the TUI provider/model/setup flows while keeping it labeled as `opencode Zen`, and keep `opencode-go` labeled separately as `opencode Go`.
- Add a Windows PowerShell installer and document macOS, Linux, Windows PowerShell, and Git Bash/WSL install paths in the README.
- Add configurable assistant message rendering modes: Plain, Markdown, and Rich.
- Render plan/chat Markdown more cleanly in Rich mode, including local Mermaid flowcharts, wide tables, checklists, callouts, connectors, and compact terminal-friendly diagrams.
- Keep plan review content anchored while scrolling so review modals stay readable during long plans.

## 0.1.11 - 2026-06-15

- Preserve `task` tool metadata while a subagent is running, after tool-call transitions, and when a subagent fails before model resolution completes.
- Queue a newly submitted prompt behind an active run so the second prompt is saved and answered in the next LLM call instead of being coalesced into the first run's result.
- Keep existing concurrent `loop()` callers coalesced to the same active run while only explicit prompt submissions enqueue a follow-up turn.
- Stop showing the empty memory-check toast when the extractor finds no durable candidates, and keep Home title changes silent while refreshing the visible Home surface.
- Hide the prompt-bottom context meter unless `promptStatus.context.visible` is explicitly enabled, including old profiles that still list the context builtin.
- Let mflow lock/read external absolute paths by default instead of refusing paths outside the current project.

## 0.1.10 - 2026-06-14

- Let automatic memory learning create approval-gated `add`, `update`, and `remove` proposals, with targeted updates/deletes applied to existing memory entries instead of only appending new entries.
- Recover durable repo-scoped memory rules when the extractor returns empty or wrapped JSON, without relying on hard-coded prompt examples.
- Show a memory toast when extraction finishes with no pending proposal, including skipped or no-candidate reasons instead of silently disappearing after "Preparing memory proposal...".
- Treat slash commands as commands only when they start the prompt, so normal messages that mention `/setup`, `/stats`, or other commands are sent as chat text instead of navigating away.
- Keep `/setup` and `/stats` as temporary pages from an active chat: pressing escape or finishing setup now returns to the originating session instead of dropping to New Chat.
- Keep Agent View hover visual-only; click or arrow keys select the reply target, and `esc` clears that selected session before returning to normal prompt input.
- Keep split home welcome branding neutral and prevent long ASCII title text from clipping into partial letters.
- Remove the default right-side prompt context meter so the footer no longer shows the extra context bar and separator dot by default.
- Preserve pasted chat images through message copy/paste by copying image attachments as portable data-image Markdown and rehydrating those images back into prompt attachments when pasted into MendCode.

## 0.1.9 - 2026-06-14

- Make `mendcode --help` workflow-first: open the terminal harness, run with an initial intent, use packages, mflow, worktrees, TSM, setup, and status.
- Move low-level/debug commands out of normal help, including TUI profile internals, runtime adapter/upstream/export/config plumbing, and prompt/runtime internals.
- Keep legacy aliases such as `init`, `sync`, `package`, and `prompts` callable with deprecation warnings instead of presenting them as product workflows.
- Suggest close matches for typo-prone commands, including `mendcode tui prewview` -> `mendcode tui preview`.
- Stop replaying the latest real user message as a new visible user turn after overflow compaction; resume from the summary and a synthetic internal continue prompt instead.
- Avoid the double-compaction path where auto resume immediately re-adds the same user request before continuing.
- Release mouse tracking, bracketed paste, and raw input mode before suspending or exiting the TUI so the parent shell does not receive scroll/click escape sequences.

## 0.1.8 - 2026-06-14

- Show a real Usage Insights loading state instead of zeroed metrics while cached stats are still loading.
- Reuse the global TUI stats cache on the Usage Insights page without warming session messages during normal chat startup.
- Keep the weather location in the global TUI config and simplify the stats shortcuts by removing the manual refresh action.
- Fix the installer version check so a same-version global `mendcode` on `PATH` cannot falsely satisfy a clean `$HOME/.mendcode/bin` install.

## 0.1.7 - 2026-06-14

- Keep the setup screen stable while refreshing step state so changing setup pages no longer flashes back to a loading placeholder.
- Widen the setup rail so longer step labels such as TUI Profile and Permissions do not collide with completion status.
- Shorten and row-budget the memory extractor auth warning while preserving the actionable OAuth/client-id blocker.
- Inject global memory at session start and after compaction, while keeping per-request project memory local to the model prompt instead of writing it into chat history.
- Run automatic memory extraction after normal assistant stops, show a dedicated memory activity state/mascot while proposals are generated, and give the extractor structured saved/pending memory context before it decides whether to propose.
- Prevent the primary assistant from directly saving implicit preferences to memory; approval-gated proposals now come from the memory extractor unless the user explicitly asks to save memory immediately.
- Avoid re-triggering assistant generation after clean auto-compaction while still resuming when compaction interrupted an active or incomplete assistant turn.
- Keep long pasted content visible until it exceeds the configured character threshold, and let truncated user-message headers expand from the hidden-content hint without stealing normal message action clicks.
- Refresh the docs for the `mendcode` command surface, customization, setup/configuration, mflow, package sharing, plan mode, usage insights, TSM/worktrees, and wiki navigation.

## 0.1.6 - 2026-06-14

- Add a TUI Usage Insights dashboard with daily token activity, global/project stats, response-time metrics, top tools/agents/models, cached stats loading, and optional Open-Meteo weather.
- Inject saved global memories into normal runtime requests as transient system context instead of only after compaction.
- Keep project memories in the runtime prompt with their own request cap so repo-local context is available without persisting injected memory into chat history.
- Make `mendcode memory search` and `mendcode memory preview` show request-mode retrieval by default, with an explicit `--mode` selector for compaction/manual checks.

## 0.1.5 - 2026-06-13

- Backport MCP runtime updates: catalog pagination, capability-aware prompt/resource listing, tolerant tool schema discovery, abort signal forwarding, OAuth `callbackPort`/`scope`, and manual OAuth header preservation.
- Isolate provider model plugin hooks from internal provider state so plugin mutations cannot rename providers or zero model pricing globally.
- Preserve delegated subagent identity on task child sessions.
- Avoid a shell-cancel race by cancelling an existing session runner during short busy-state transitions instead of marking the session idle too early.

## 0.1.4 - 2026-06-13

- Stop normal automatic and manual compaction from re-triggering the assistant after a completed turn.
- Keep overflow compaction recovery for requests that really hit provider context limits.
- Make `Tab` mode cycling update the active prompt mode instead of leaving the mode label stuck while model state changes.

## 0.1.3 - 2026-06-13

- Show richer Agent View welcome timestamps, including `Today` plus contextual day, month, and year information.
- Show the local package version in the welcome screen instead of `local` when running from source.
- Clarify prompt-context commands in the TUI by renaming the persistent selector and hiding the low-value cycle command from Ctrl+P.
- Backport OpenCode terminal and SDK fixes for structured SDK errors, Basic Auth defaults, local MCP `cwd`, and MCP prompt/resource timeouts.
- Stamp release binaries with the requested `MENDCODE_VERSION`/`OPENCODE_VERSION` and include release workflow changes in generated notes.

## 0.1.2 - 2026-06-13

- Publish MendCode under the `mendcode` command name and remove the public `mend` package alias.
- Normalize source and package metadata to `0.1.2` after the public `v0.1.1` release.
- Show the MendCode runtime version in welcome, CLI, debug info, health responses, and Zed extension metadata.
- Keep update checks on `MendCode/MendCode` GitHub releases and skip autoupdate for local/source builds.
- Preserve offline startup by treating update lookup failures as non-blocking.
- Replace user-facing `mend` and `mend-runtime` command hints with `mendcode`.
