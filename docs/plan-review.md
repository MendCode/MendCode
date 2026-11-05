# Plan review

The native tools `plan_review { title?, markdown, phase? }`, `plan_exit {}` and the compatible
`plan_submit { plan }` request review; the separate review/exit tools enter read-only plan mode first when needed. `plan_exit` reuses the latest reviewed Markdown,
including edits saved before a daemon restart. Review requests and replies live in the session event log.
`plan.review.list { sessionId }` returns the newest 20 reviews within a bounded response. Clients use
`planReviews(sessionId)` and `reviewPlan(sessionId, requestId, reply)`.

The terminal opens a dedicated Markdown preview with a bordered panel grid. Enter explicitly applies;
`a` accepts without implementation, `e` edits, `c` adds comments, `r` rejects with a reason, `t` cycles
trusted primary destinations, `m` cycles the access the session takes (`full access`, `auto edits`,
`ask before edits`), and Esc closes without authorization. In an editor Enter inserts a newline,
Ctrl+O applies the edited plan/comments, Ctrl+S sends an edit for further planning, and Esc keeps the draft
and returns to preview. A failed reply keeps the draft. Arrows/PageUp/PageDown scroll the plan.
`/plan-review` reopens saved decisions; Left/Right selects an older/newer review. Saved decisions are read-only.
Below 70 columns the panels stack; hints remain in the page header.

## Access after applying

Applying a plan (Enter, or Ctrl+O after comments or edits) takes **full access** by default, like leaving plan mode with
acceptance in Claude Code: the approved plan runs without a question for every edit and command. The Review panel shows
`Access  full access` before the key is pressed, `m` cycles it to `auto edits` or `ask before edits` (the old behavior), and
leaving plan mode says where the session landed: `Plan mode off: build runs on <model> · full access`. The reply carries it as
`permission: "full" | "edits" | "ask"`; a remote terminal defaults the page to `ask before edits` and the daemon runs a remote apply that names no access in `ask` (`full` only when that reply asks for it); the REST bridge (`POST /plan-review/:id/reply`) keeps `ask` unless the body sets
`permission`. Accepting without implementation, editing, rejecting, closing and planning-only packets change no access and stay
in plan mode. Deny rules and the engine's own safety checks still apply in full access ([permissions](permissions.md)).

## Entering plan mode

`/plan` alone toggles plan mode. `/plan <text>` enters plan mode (it stays in it when already there) and sends `<text>` as the message.

Any way of entering plan mode (Shift+Tab, `/plan`, the `plan` agent, a `plan_review` call) is announced by a toast,
`Plan mode: read-only · <plan model> plans · you review first`, and the footer shows `Plan · <plan model>` (the mode is named once): the model of the
`plan` role (the session's model when no role is set), not the one that builds. Leaving it, whichever way, says
`Plan mode off: build runs on <model>`, with the model asked again from the daemon. Nothing is added to the screen outside plan mode.

While a native call runs in plan mode (and only then) the system prompt ends with one paragraph: the session is read-only, investigate
with read tools, finish by calling `plan_review` with the complete plan, and do not write the final plan as a plain reply. `plan_submit`,
`plan_review` and `plan_exit` are listed in the request whatever the tier (`aux_tools` off only defers them outside plan mode).

If a plan-mode turn still ends with a plain-text plan (at least 120 characters and three list items or headings), the host sends it to
the same review as a `plan_review` call, so the page opens and Enter applies it: the build agent and its model take over and the turn
continues with the approved text. A short answer or a question is never reviewed. A review the user accepted or closed is not opened
again for the next plain reply, a rejected one is (feedback, then a revised plan), and at most two plain-text plans are offered per turn.
Claude Code's `ExitPlanMode` opens the same page; Codex sessions have no plan tool and stay read-only by declining every change.

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
