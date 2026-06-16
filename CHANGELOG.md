# Changelog

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
