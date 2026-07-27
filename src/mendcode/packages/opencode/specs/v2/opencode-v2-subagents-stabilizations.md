# OpenCode V2 Subagents Stabilizations

## Context

MendCode already has parent/child subagent sessions, `Ctrl+T` navigation, and a Subagents dock/widget. We should not duplicate that with a separate subagent shell. The V2 work should stabilize the existing surface and then extend execution semantics.

## Goals

- Reuse the existing subagent session navigation and UI instead of adding a new shell.
- Make subagent rendering readable in child sessions, including long prompts/tool outputs.
- Show only active/relevant subagents for the current root session.
- Do not resurrect historical subagent entries from compacted or stale transcript state.
- Keep responsive behavior clean at narrow and wide terminal sizes.
- Add configurable subagent launch behavior:
  - `wait`: parent blocks until the subagent returns output.
  - `background`: parent launches the subagent, keeps working, and can monitor/summarize child progress later.
  - `auto`: model chooses per task whether to wait or run in background.

## Non-goals

- Do not build a separate “subagents shell”. Existing navigation/dock should be improved.
- Do not change compaction semantics just to hide UI artifacts.
- Do not break existing `task` tool behavior or parent/child session navigation.

## UI Stabilization Requirements

1. Child/subagent sessions must render messages top-to-bottom without oversized prompt/tool blocks making the view feel broken.
2. Long subagent prompt bodies should be visually bounded or summarized when they are orchestration boilerplate.
3. The Subagents widget should prefer active/current-session child sessions:
   - include children belonging to the current root session,
   - include child sessions referenced by current, non-compacted task tool calls,
   - exclude stale child sessions that only appear in compacted/old historical task parts.
4. Responsive layout should degrade gracefully:
   - narrow terminals: concise labels and status,
   - wider terminals: agent type, description, status, and model/progress where available.
5. Clicking or selecting a subagent keeps existing navigation behavior.

## Execution Behavior Proposal

Add a subagent launch mode to task execution. Proposed authoring layers, highest priority first:

1. Tool call argument, e.g. `mode: "wait" | "background" | "auto"`.
2. Agent config default, e.g. `agent.<name>.subagent_mode` or future V2 `agents.<name>.subagent.mode`.
3. Global config default, e.g. `subagent_mode` or future V2 `subagents.default_mode`.
4. Runtime fallback: `wait` to preserve current behavior.

### `wait`

Matches current behavior: parent creates a child session, waits for the final child output, and inserts the result back into the parent task tool output.

### `background`

Parent creates a child session and returns immediately with a durable child session reference. The parent can keep working. UI shows the child as running/needs-input/responded. A later monitor/summarize path can inspect child output and synthesize results.

### `auto`

The model decides whether to wait or background based on task size, independence, expected runtime, and whether user flow benefits from parallel work. The tool schema must make the tradeoff explicit so the model can choose safely.

## Safety / Compatibility

- Default remains `wait` until background semantics are durable and observable.
- Background children must preserve permission boundaries and inherited deny/external-directory rules.
- Parent session must not lose child evidence on disconnect; retained child references should remain resumable.
- UI must handle missing child messages, disconnected sync, and compacted parent transcript safely.

## Implementation Checklist

- [x] Filter Subagents widget entries to current root session and current non-compacted task references.
- [x] Improve child/subagent message rendering for long orchestration prompts and code/tool blocks.
- [x] Add focused layout tests for subagent widget filtering/responsive behavior.
- [x] Add schema/config design for `wait | background | auto` launch mode.
- [ ] Implement background launch only after durable observation/summarization behavior is specified.
