# Plan review

Plan review lets you read, edit or comment on a plan before authorizing implementation. The terminal opens a dedicated Markdown preview with a bordered panel grid.

1. Read the plan in the preview.
2. Edit it or add comments if needed.
3. Press Enter to explicitly apply it, or `a` to accept without implementation.

## Review a plan

| Key | In the preview |
|---|---|
| Enter | explicitly apply |
| `a` | accept without implementation |
| `e` | edit |
| `c` | add comments |
| `r` | reject with a reason |
| `t` | cycle trusted primary destinations |
| `m` | cycle the access the session takes: `full access`, `auto edits`, `ask before edits` |
| Esc | close without authorization |
| Arrows/PageUp/PageDown, mouse wheel or trackpad | scroll the plan; scroll the Review panel when the pointer is over it and it is taller than its room |

### Edit or comment

| Key | In an editor |
|---|---|
| Enter | insert a newline |
| Ctrl+O | apply the edited plan/comments |
| Ctrl+S | send an edit for further planning |
| Esc | keep the draft and return to preview |

A failed reply keeps the draft. Editing shows the raw text.

The preview draws the plan the way the chat draws an answer, by `messageRenderer` and tier:

| Rendering | Preview |
|---|---|
| `full` | diagrams, callouts and tables |
| `markdown` | plain Markdown |
| `plain` | raw text |

Below 70 columns the panels stack; hints remain in the page header.

### Reopen a decision

`/plan-review` reopens saved decisions. Left/Right selects an older/newer review. Saved decisions are read-only.

**Note:** A daemon older than the access choice rejects the reply. The terminal retries once without it; the plan is applied with that daemon's access, and the page says the choice waits for `/daemon restart`.

## Access after applying

Applying a plan (Enter, or Ctrl+O after comments or edits) takes **full access** by default, like leaving plan mode with acceptance in Claude Code. The approved plan runs without a question for every edit and command.

1. Check `Access  full access` in the Review panel before pressing the key.
2. Press `m` to cycle to `auto edits` or `ask before edits` (the old behavior).
3. Apply the plan. Leaving plan mode says where the session landed: `Plan mode off: build runs on <model> · full access`.

The reply carries the choice as `permission: "full" | "edits" | "ask"`.

| Client | Access default |
|---|---|
| Remote terminal | The page defaults to `ask before edits`; a remote apply that names no access runs in `ask`, with `full` only when that reply asks for it |
| REST bridge (`POST /plan-review/:id/reply`) | Keeps `ask` unless the body sets `permission` |

Accepting without implementation, editing, rejecting, closing and planning-only packets change no access and stay in plan mode.

**Warning:** Deny rules and the engine's own safety checks still apply in full access ([permissions](permissions.md)).

## Entering plan mode

| Action | Result |
|---|---|
| `/plan` alone | toggle plan mode |
| `/plan <text>` | enter plan mode, or stay in it when already there, and send `<text>` as the message |
| Shift+Tab, the `plan` agent, a `plan_review` call | enter plan mode |

Every way of entering announces `Plan mode: read-only · <plan model> plans · you review first` in a toast. The footer shows `Plan · <plan model>`: the mode is named once.

### Which model plans

Only MendCode's own engine switches to the `plan` role. The notice and footer name that role's model, or the session's model when no role is set, not the one that builds.

Claude Code, Codex, pi and ACP agents plan on the session's model; the notice and footer name that one.

Those engines get one short line after your message on every plan-mode turn: the session is read-only and the plan goes to you for review. On the first turn after it, they are told plan mode ended; turns outside plan mode add nothing.

Leaving plan mode, whichever way, says `Plan mode off: build runs on <model>`, with the model asked again from the daemon. Nothing is added to the screen outside plan mode.

### When a plain reply becomes a review

If a plan-mode turn still ends with a plain-text plan of at least 120 characters and three list items or headings, the host sends it to the same review as a `plan_review` call.

The page opens and Enter applies it. The build agent and its model take over, and the turn continues with the approved text.

- A short answer or a question is never reviewed.
- A review you accepted or closed is not opened again for the next plain reply.
- A rejected review is opened again: feedback, then a revised plan.
- At most two plain-text plans are offered per turn.

Claude Code's `ExitPlanMode` opens the same page. Codex sessions have no plan tool and stay read-only by declining every change.

### Choose the implementation agent

`settings.set { patch: { planExitAgent: "executor" } }` chooses the default destination: `build` when unset.

- An unknown, hidden, subagent-only or untrusted configured destination falls back to `build`, as in v1.
- An explicit invalid destination is refused without consuming the request.

Applying revalidates the destination, persists the selected agent and switches its prompt, model and tool restrictions for the next model call. The original read-only agent's permission cap remains binding.

### Accept a planning-only packet

`phase: "plan"` means acceptance only. The following enforce this boundary:

- packet markers such as `mode: planner`, `phase: plan`, `implementation: false` and `planning-only`;
- an explicit planning-only user instruction.

Enter/Ctrl+O accepts in this phase. The actor refuses an apply request, including an edited packet that introduces a planning-only marker. Acceptance, editing, rejection and closing keep plan mode.

The packet author must set its phase explicitly when the boundary is expressed in another form. Restart/cancellation closes unfinished reviews; it never silently applies a plan.

## Plan files

Feature `plan_files` is on in balanced and full, off in minimalist. `/tier plan_files off` turns it off elsewhere.

When you accept or apply a plan, it is saved as Markdown with a title, status (`accepted`, `applied`, `done`), date, session and project.

- An edited plan saves the edited text; comments are appended under `## Review comments`.
- A rejected, closed or still-open review writes nothing.
- A session without a plan writes nothing at all.

### Choose where plans are saved

| Location | Setting and path |
|---|---|
| Data directory (default) | `"data"`: `<data dir>/plans/<project>-<hash>/plan-<title>-<session>.md`, for example `~/.mendcode/plans/api-1a2b3c4d/` |
| Project repository | `"plan_files_location": "repo"` in the settings file: `.mendcode/plans/` of the project |

The default location is outside your repository, so git stays clean. The name is stable: accepting a revised plan with the same title in the same session replaces the file.

### Track progress

The session's `todo` list is mirrored into a `## Progress` block of its open plan on every `todo` call. The plan becomes `done` when every step is.

Nothing else is written while you work; the agent edits no file to track steps.

After any engine's compaction, the first message starts with one line: the plan's path, status and steps done. The native engine also keeps that line in the summary's engine anchor.

The plan text is never copied into the context: the agent reads the file. The project's plan folder is read and edited without the external-directory question.

### Read plans from other sessions

| Command | Result |
|---|---|
| `sessions plans=true` | list the project's plans; `scope=all` and `directory=` work as for sessions |
| `sessions read=<plan-… id>` | return one plan |

Both are local only, like reading a session.

### Claude Code plan files

Claude Code already writes its plan to `~/.claude/plans/<name>.md`. MendCode finds the file whose text is the plan ExitPlanMode submitted, and registers its path in a small record holding status and progress.

There is no second copy of the text. The path in the pointer line, in the list and in `sessions read` is Claude Code's file. Codex has no plan tool, so there is nothing to register.

## How it works

The native tools `plan_review { title?, markdown, phase? }`, `plan_exit {}` and the compatible `plan_submit { plan }` request review. The separate review/exit tools enter read-only plan mode first when needed.

`plan_exit` reuses the latest reviewed Markdown, including edits saved before a daemon restart. Review requests and replies live in the session event log.

`plan.review.list { sessionId }` returns the newest 20 reviews within a bounded response. Clients use `planReviews(sessionId)` and `reviewPlan(sessionId, requestId, reply)`.

### Native plan-mode prompt

While a native call runs in plan mode, and only then, the system prompt ends with one paragraph:

- the session is read-only;
- investigate with read tools;
- finish by calling `plan_review` with the complete plan;
- do not write the final plan as a plain reply.

`plan_submit`, `plan_review` and `plan_exit` are listed in the request whatever the tier. `aux_tools` off only defers them outside plan mode.

### Replies and limits

Replies add `decision: { kind: "plan_review", action: "accept" | "apply" | "edit" | "reject" | "close",
markdown?, comments?, reason?, destination? }` to `request.resolve`. Existing approval replies remain valid for implementation reviews.

| Text | Character limit |
|---|---|
| Markdown | 30,000 |
| Comments | 4,000 |
| Reasons | 2,000 |

Secret capture applies before user review text is stored or sent to the model; the read-only report redacts text.

Frames: `bun scripts/render-frames.ts .agents-frames/B53 --b53 100x30 180x50`.
