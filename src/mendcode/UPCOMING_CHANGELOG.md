Last release: v0.1.15
Target ref: v0.1.16

## Memory Center
### Fixed
- Fix accepting Memory side-chat Dream schedule proposals so they configure Dream scheduler state instead of only applying an ordinary memory proposal.
- Recover schedule state from already-applied Dream proposals created before this fix.
- Parse common human Dream windows such as `6pm a 11pm en Panama`, `18:00-23:00`, and fixed `21:00 America/Panama` requests.

## Memory
### Added
- Add the route-level Memory Center with Overview, Project memories, Global memories, Policy & categories, and Dream tabs.
- Add category-aware memory contracts, policy normalization, graph sidecar storage, workspace registry/group views, proposal-only Dream run logs, bounded Dream evidence collection, constrained memory side chat, and Memory HTTP/API routes.
- Add `memoryDream` and `memoryAssistant` roles to local memory/model config while keeping generated memories pending by default.
- Add workspace-aware memory grouping, Dream scheduler/source/event state, and constrained memory side-chat actions.

### Changed
- Memory retrieval now labels prompt entries by scope and category, while preserving the existing `<mendcode_memory>` compatibility block.
- Memory proposals now carry category ids, scope reasons, evidence refs, policy decisions, and expanded operations such as verify, expire, recategorize, relink, demote-scope, and promote-scope.
- Memory extraction now receives a bounded recent-conversation window so proposals can use nearby context without persisting whole chats.

## TUI, Prompt, And Plan Review
### Added
- Add the Memory Center route and command palette entries, while keeping the proposal-focused Memory Manager as a separate dialog.
- Add a dedicated Shift+Tab Mode picker for primary agents.
- Add hex-color swatches and static Plan Markdown helpers for terminal previews and tests.
- Add built-in Herdr agent-state reporting for idle, working, blocked, needs-input, approval, plan-pending, retry, and error states.

### Changed
- Make prompt model/provider/variant labels resolve from the selected prompt model metadata instead of stale local/session labels.
- Track user-selected model/variant overrides separately from hydrated session state so explicit local changes win.
- Persist submitted prompt agent/model selections onto the session before generation and preserve partial assistant model metadata during sync.
- Keep prompt status script output tied to the current identity so stale script output is not reused after model/session/root changes.
- Replace the Plan Review renderer with the styled Markdown path, add grid table rendering, and improve Mermaid text diagrams including state, class, pie, Gantt, git graph, and requirement diagrams.
- Improve chat/timeline presentation for todo writes, questions, plan review, permission prompts, and grouped tool activity.

## CLI, MCP, Worktrees, And Setup
### Changed
- Read project-local `.mendcode/mcp` server config into MCP runtime, status, tools, prompts, and resources.
- Sync generated runtime config on `mendcode` startup when the projected opencode config is stale.
- Make `mendcode --worktree .` and current-worktree shortcuts resolve more naturally, including current-branch fallback when no non-base worktree exists.
- Make mflow, TSM, and worktree control-plane output human-readable by default while preserving `--json` for scripts.
- Make `mendcode mcp add-local` sync generated runtime config after writing project MCP config.
- Use provider-neutral defaults for memory preview commands.

## Documentation
### Added
- Add screenshot-backed README assets, the product-facing Feature Map, Memory Center docs, and a Memory Graph/Dream spec.

### Changed
- Refresh README, docs index, setup/configuration, customization, Plan Mode, Usage Insights, and package-sharing docs around implemented behavior and provider-neutral examples.

## Tests
### Added
- Add coverage for Memory Center layout helpers, memory categories, graph/proposals/retrieval, Dream events/scheduler/sources, HTTP memory routes, prompt compose, prompt model/variant resolution, prompt status identity, plan Markdown rendering, Herdr plugin reporting, MCP project config, worktree shortcuts, setup, TSM, runtime pack, and session prompt metadata.
