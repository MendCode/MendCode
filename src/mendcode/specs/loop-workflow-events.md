# Loop Workflow Events Spec

## Context

Loop Workflows now support durable scheduler state, a TUI dashboard, a static chat receipt, and token-by-token loop chat streaming when the loop session is opened. The remaining gap is that loop state and run details are still mostly timer/poll driven, and the chat receipt is intentionally static. The next phase should make loop observability feel event-native without pretending that a static chat block is live SSE.

## Goals

- Show active loop state in one dedicated `/loops` dashboard with real refresh/event updates.
- Keep the chat receipt static: it confirms what was created and opens the loop chat or dashboard.
- Add a timeline-style event view that explains what happened per run.
- Expose useful run output summaries without dumping giant loop sessions into the parent chat.
- Add a real signal/event trigger path instead of only labels such as `external-signal`.
- Treat Loop Workflows as goal-driven workflows with iteration budgets, not as blind "repeat this prompt N times" scripts.
- Preserve safe defaults: report-only unless the user clearly asks to code/edit/build/test.

## Non-Goals

- The chat receipt does not stream live status.
- The parent chat does not mirror token-by-token output from loop child sessions.
- Loop event triggers do not push, merge, release, or perform destructive shell actions without explicit approval.

## Requirements

### Receipt

- The Loop Workflow receipt MUST show workflow id, loop chat id, trigger/event mode, permission mode, model, agent, and goal.
- The receipt MUST NOT show a fake `live` label or runtime seconds.
- The receipt SHOULD open the loop chat when a root loop session exists.
- The receipt MAY open `/loops` when no root loop session exists yet.

### Dashboard

- `/loops` MUST prioritize active loops first: `active`, `sleeping`, `working`, `needs_input`, `blocked`, and `paused`.
- Historical loops MUST live behind a history view.
- The active sidebar SHOULD show name, project/directory, updated time, status/phase, and iteration progress.
- The detail pane SHOULD show run summaries first, then an event timeline.

### Event Timeline

- Each event row SHOULD include time, type, title, summary, and optional run id.
- Consecutive `started/completed` pairs SHOULD visually group into a run.
- Important events SHOULD use distinct levels: info, warning, error, decision.
- Timeline copy MUST explain why the loop did or did not progress.

### Run Output Summary

- Each completed run SHOULD store a bounded summary in `loop_run.data`.
- The summary SHOULD include status, files touched/read, tests run, blockers, and next action.
- `/loops` SHOULD show latest run summaries without loading the full session transcript.
- Opening the loop chat remains the source of truth for raw token-by-token details.

### Goal Semantics

- A Loop Workflow MUST distinguish `fixed`, `max-goal`, and `unbounded-monitor` budget modes.
- `fixed` means the workflow is expected to run exactly up to its iteration cap unless blocked or stopped.
- `max-goal` means `maxTurns` is a budget cap, not a schedule. The loop MUST try to complete the goal in the minimum responsible number of iterations and stop early when the goal is verified.
- `unbounded-monitor` means the loop continues until stopped, blocked, or a stop condition is met.
- Goal loops SHOULD store completion criteria, success checks, target turns, and reserved verification/recovery turns.
- Every executed iteration SHOULD end with a machine-readable checkpoint containing status, summary, evidence, next action, and confidence.
- A `max-goal` loop that exhausts its iteration budget before a `complete` checkpoint MUST become blocked/needs-input instead of reporting completed success.
- When configured, a completed goal loop SHOULD wake the owner session with a bounded completion summary so the parent conversation can decide the next step.

### Signal Triggers

- Add a durable `loop_signal` queue or equivalent table.
- A signal MUST include workflow id, source, payload, idempotency key, created time, and consumed time.
- `external-signal` MUST wake from queued signals, not from `nextWakeup` labels alone.
- Initial signal sources SHOULD be local CLI/API calls and internal TUI actions.
- Webhooks or plugin signals require auth/idempotency before shipping.

### Permissions

- `report-only` loops MUST deny edit/write/apply_patch/shell/subagent tools.
- `normal/custom` implementation loops MUST be allowed to edit when the user clearly asked to code, implement, fix, test, or build.
- Background service mode MUST NOT silently downgrade an explicitly editable workflow to report-only.
- Risky actions remain gated: push, merge, release, version bump, external send, destructive shell, broad refactor.

## Suggested Implementation Order

1. Persist `loop_run.data.summary` after each iteration.
2. Redesign dashboard event timeline around runs and event groups.
3. Add signal queue schema and local `mendcode loops signal <id>` command.
4. Add `/loops` actions for waking a loop with a signal.
5. Add API route for signal enqueue with local auth first.
6. Promote checkpoint/evaluator data from run JSON into first-class dashboard summaries.

## Acceptance Checks

- A report-only loop never mutates files even if the service is in execute mode.
- A coding loop created from text like `codea/fixea/implementa y prueba` can edit/test in its loop session.
- A max-goal loop completes before its iteration cap when its checkpoint proves the goal is done.
- A max-goal loop blocks instead of claiming success when it reaches its cap without a complete checkpoint.
- `/loops` shows active loops first and history separately.
- A completed run appears as a readable timeline group with a bounded summary.
- A queued signal wakes an `external-signal` loop without waiting for its normal interval.
