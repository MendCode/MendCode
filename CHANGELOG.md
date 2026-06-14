# Changelog

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
