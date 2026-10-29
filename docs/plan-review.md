# Plan review

The native tools `plan_review { title?, markdown, phase? }`, `plan_exit {}` and the compatible
`plan_submit { plan }` request review; the separate review/exit tools enter read-only plan mode first when needed. `plan_exit` reuses the latest reviewed Markdown,
including edits saved before a daemon restart. Review requests and replies live in the session event log.
`plan.review.list { sessionId }` returns the newest 20 reviews within a bounded response. Clients use
`planReviews(sessionId)` and `reviewPlan(sessionId, requestId, reply)`.

The terminal opens a dedicated Markdown preview with a bordered panel grid. Enter explicitly applies;
`a` accepts without implementation, `e` edits, `c` adds comments, `r` rejects with a reason, `t` cycles
trusted primary destinations, and Esc closes without authorization. In an editor Enter inserts a newline,
Ctrl+O applies the edited plan/comments, Ctrl+S sends an edit for further planning, and Esc keeps the draft
and returns to preview. A failed reply keeps the draft. Arrows/PageUp/PageDown scroll the plan.
`/plan-review` reopens saved decisions; Left/Right selects an older/newer review. Saved decisions are read-only.
Below 70 columns the panels stack; hints remain in the page header.

`settings.set { patch: { planExitAgent: "executor" } }` chooses the default destination (`build` when unset).
An unknown, hidden, subagent-only or untrusted configured destination falls back to `build`, as in v1.
An explicit invalid destination is refused without consuming the request. Applying revalidates the destination,
persists the selected agent and switches its prompt, model and tool restrictions for the next model call.
The original read-only agent's permission cap remains binding.

`phase: "plan"` means acceptance only. Packet markers such as `mode: planner`, `phase: plan`,
`implementation: false` and `planning-only`, plus an explicit planning-only user instruction, enforce this
boundary. Enter/Ctrl+O accepts in this phase; an apply request is refused by the actor, including an edited
packet that introduces a planning-only marker. Acceptance, editing, rejection and closing keep plan mode.
The packet author must set its phase explicitly when the boundary is expressed in another form.
Restart/cancellation closes unfinished reviews; it never silently applies a plan.

Replies add `decision: { kind: "plan_review", action: "accept" | "apply" | "edit" | "reject" | "close",
markdown?, comments?, reason?, destination? }` to `request.resolve`. Existing approval replies remain valid
for implementation reviews. Markdown is limited to 30,000 characters, comments to 4,000 and reasons to 2,000.
Secret capture applies before user review text is stored or sent to the model; the read-only report redacts text.

Frames: `bun scripts/render-frames.ts .agents-frames/B53 --b53 100x30 180x50`.
