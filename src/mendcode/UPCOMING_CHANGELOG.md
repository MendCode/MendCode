Last release: v0.1.6
Target ref: v0.1.7

## Setup
### Bugfixes
- Keep the setup screen stable while refreshing step state so changing setup pages no longer flashes back to a loading placeholder.
- Widen the setup rail so longer step labels such as TUI Profile and Permissions do not collide with completion status.
- Shorten and row-budget the memory extractor auth warning while preserving the actionable OAuth/client-id blocker.
- Inject global memory at session start and after compaction, while keeping per-request project memory local to the model prompt instead of writing it into chat history.
- Run automatic memory extraction after normal assistant stops, show a dedicated memory activity state/mascot while proposals are generated, and give the extractor structured saved/pending memory context before it decides whether to propose.
- Prevent the primary assistant from directly saving implicit preferences to memory; approval-gated proposals now come from the memory extractor unless the user explicitly asks to save memory immediately.
- Avoid re-triggering assistant generation after clean auto-compaction while still resuming when compaction interrupted an active or incomplete assistant turn.
- Keep long pasted content visible until it exceeds the configured character threshold, and let truncated user-message headers expand from the hidden-content hint without stealing normal message action clicks.
- Refresh the docs for the `mendcode` command surface, customization, setup/configuration, mflow, package sharing, plan mode, usage insights, TSM/worktrees, and wiki navigation.
