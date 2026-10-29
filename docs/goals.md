# Goals

A goal is a session's standing objective. Once set, the agent keeps working on it turn after turn (the daemon starts each next turn itself) until the goal is complete, blocked, over its token budget, stopped by a provider usage limit, or paused by you. It is one objective in one session. A [loop](loops.md) is a different thing: recurring work that wakes on a trigger in fresh sessions.

The daemon drives it, so a goal works in every client and every engine. The terminal only sends commands and draws the state.

## Statuses

| status | meaning | continues on its own |
|---|---|---|
| `active` | being worked on | yes |
| `paused` | the user paused it | no |
| `blocked` | the agent could not go on (the same blocker for at least 3 goal turns) | no |
| `usage_limited` | the provider's quota ran out | no |
| `budget_limited` | `tokensUsed >= tokenBudget` (terminal) | no (one wrap-up turn, then stop) |
| `complete` | the agent verified every requirement (terminal) | no |

A session has one goal at a time. A `complete` or `budget_limited` goal is replaced by a new one without asking; an unfinished one needs `replace: true`. Replaced and cleared goals stay in the history (the newest 20 per session). A goal has `goalId`, `objective`, `status`, `tokenBudget?`, `tokensUsed`, `timeUsedSeconds`, `createdAt`, `updatedAt`, and for clients `activeSince?` (the running turn's start), `stalled?` (why an active goal is not continuing), `note?` and `objectiveFile?`.

## `/goal` in the terminal

| input | does |
|---|---|
| `/goal` | summary card: objective, status, tokens, time, what to type next |
| `/goal <objective>` | sets the goal; an unfinished one in the way turns into a question (`y` replaces it, esc keeps it) |
| `/goal --budget 50k <objective>` | same, with a token budget (`50000`, `50k`, `1.5m`) |
| `/goal edit` | puts the objective in the prompt (a long one is read from its file): enter saves, esc drops the edit, ctrl+j adds a line |
| `/goal pause` | pauses |
| `/goal resume` | asks ("Resume paused goal?", also for blocked, usage-limited and stalled goals), `y` resumes |
| `/goal clear` | removes the goal (it stays in the history) |
| `/goal budget <tokens\|off>` | sets or removes the budget; raising it on a `budget_limited` goal reactivates it |

Only a bare `pause`, `resume`, `clear`, `edit` or `budget <n>` is a subcommand: "pause the deploy after the tests" is an objective. `resume` refuses a `budget_limited` goal (raise the budget) and a `complete` one (start another).

An objective over 4,000 characters is saved to `<data dir>/goals/<goalId>.md` and the goal's objective becomes `Read the goal objective file at <path> before continuing.` The limit is 60,000 characters. Pasted secrets in an objective become `‹secret:N›` markers first, like any prompt.

What you see:

- **Indicator** in the status row (balanced), the footer (full) or a line above the prompt (minimal): `◎ goal 12k/50k · 4m` while it works (tokens, budget, time including the running turn), `◎ goal · paused`, `· blocked`, `· usage limit`, `· budget reached`, `· complete`, or `· stalled`. The footer also shows it when the `/footer` segments leave `goal` out.
- **Steering marker**: each automatic turn starts with a thin `◆ goal · continuing` line. The real steering text goes to the model only.
- **Cards** in the transcript when a goal is set, completes, is blocked, reaches its budget or usage limit, or stops continuing (with the reason). Pause, resume and usage changes only move the indicator.

## Model tools

Registered on the native engine's main agent (not sub-agents) when the daemon gives it a goal port. No approval is asked.

| tool | arguments | notes |
|---|---|---|
| `get_goal` | none | JSON `{ goal: { status, objective, tokenBudget, tokensUsed, remainingTokens, timeUsedSeconds, note? } }` |
| `create_goal` | `objective`, `token_budget?` | only when the user explicitly asked for a goal; fails while an unfinished goal exists |
| `update_goal` | `status: complete \| blocked \| paused`, `note?` | `complete` only when achieved and verified; `blocked` only after the same blocker held for 3 goal turns in a row; `paused` only on the user's explicit request. It cannot resume, budget-limit or usage-limit a goal. On a budgeted goal the reply tells the agent to report the final usage ("X of Y tokens used") |

Engines without these tools (Claude Code, Codex, ACP) still work: the steering text asks the agent to end its last message with `GOAL_STATUS: complete` or `GOAL_STATUS: blocked - <why>` on its own last line, and the daemon reads it when the turn completes (`goals-signals.ts`). Continuation itself is plain text steering, so it needs no tools.

## How continuation is triggered

1. Every session event passes the goals service. `observe` (`packages/daemon/src/goals.ts:447`) defers to a microtask, because observers run inside `sink.append` and appending from one would make client cursors skip events. Registered in `packages/daemon/src/daemon.ts:844`.
2. `process` (`goals.ts:283`) follows the turn: `turn.started` and the first user item mark the turn as a goal turn (and set `activeSince`), `usage.recorded` adds `input + output` tokens (cache is not counted) and may flip the goal to `budget_limited`, the last agent text is kept for the marker fallback.
3. On `turn.completed | cancelled | interrupted | failed`, `onTurnEnded` (`goals.ts:249`) adds the turn's wall time, then decides: a `GOAL_STATUS` marker ends the goal; a failed turn with a quota message becomes `usage_limited`; any other failure, a cancel, an interrupt, or two goal turns in a row with no output (no text, no tool call) **stalls** the goal (still `active`, `stalled` says why, no more automatic turns); otherwise `next` (`goals.ts:132`) renders the template.
4. `next` calls `options.steer` (`goals.ts:158`, wired at `daemon.ts:840`) which posts to the session actor. `onSteer` (`packages/kernel/src/session-actor.ts:472`) starts the turn only when no turn runs, **nothing is queued** (queued user messages always go first), and the session is not held by a user cancel or an interrupt. Otherwise it returns false and the next turn end tries again.
5. A steering turn is never queued or stored in the queue; it is emitted as a `user_message` item with `meta { notice: true, goal: <kind> }` whose text is the label, so undo treats it as a system notice.

Stalled goals restart when the user sends a message, or with `/goal resume` (which forces past a cancel's hold). A turn the user starts while the goal is active counts toward it too.

### Budget

When `tokensUsed >= tokenBudget` the goal becomes `budget_limited` right away (the running turn finishes). The daemon then sends one `budget_limit` steering turn that tells the agent not to start new substantive work and to summarize progress and what remains; its tokens count too. After that nothing continues. Raise the budget with `/goal budget` to continue.

### Usage limit

A turn that fails with a provider quota message (HTTP 429 quota, `usage_limit_reached`, "usage limit" wording) sets `usage_limited`. `/goal resume` reactivates it once the quota resets. The paused turn also gets a bar with Resume at reset, which reactivates the goal by itself at the reset ([usage-limit.md](usage-limit.md)).

### Daemon restart

Nothing starts at boot. A goal that was `active` when the daemon stopped continues once when a client next opens the session (`goals.opened`, `daemon.ts:982`); several clients opening at once start one turn. The interrupted turn's time up to the stop is kept.

## Templates

`packages/daemon/prompts/goals/continuation.md`, `budget_limit.md` and `objective_updated.md` are the steering messages. Any extension layer overrides one with `<layer dir>/goals/<kind>.md` (the last layer that has the file wins: the project's `.mendcode/` folder beats its packages, which beat the user's folder). An empty file or one over 64 KB is ignored. Placeholders: `{{objective}}` (with `<`, `>` and `&` escaped, so an objective cannot close its own `<objective>` tag), `{{tokens_used}}`, `{{token_budget}}` (`none` without one), `{{remaining_tokens}}` (`unlimited` without a budget), `{{time_used_seconds}}`. Unknown names stay as written.

`objective_updated` is sent once, as the next steering turn, after the objective was edited.

## Commands

| command | result |
|---|---|
| `goal.get { sessionId, history? }` | `{ goal?, history? }` |
| `goal.set { sessionId, objective, tokenBudget?, replace? }` | `{ goal, replaced? }`; `busy` when an unfinished goal exists and `replace` is not set |
| `goal.update { sessionId, status?: active \| paused, objective?, tokenBudget?: n \| null }` | `{ goal }`; needs at least one field; `target_mismatch` with no goal; `active` is refused on `budget_limited` and `complete` goals |
| `goal.clear { sessionId }` | `{ cleared: true }` |

Changes arrive as `goal.changed { change, goal, by?, reason? }` session events (`created`, `edited`, `budget`, `status`, `progress`, `stalled`, `cleared`; `by` is `user`, `agent` or `system`). The terminal rebuilds its goal state and cards from them, so a reopened session shows the same thing.

## Choices worth knowing

- The daemon, not the UI, continues the goal: closing the terminal does not stop it while the daemon runs, and every client sees the same state.
- `usage_limited` and `budget_limited` are separate statuses with separate ways back (`/goal resume`, `/goal budget`).
- Continuation never loops on failure: a failed, cancelled or interrupted turn, or two empty turns, stop it and say why.
- `blocked` and `complete` are the agent's calls (the user cannot set them by command); the templates ask for a per-requirement audit before `complete` and three turns of the same blocker before `blocked`.
- Goal turns are counted by tokens and wall time. Cache reads and writes are not tokens used.

## Storage cleanup

`storage.clean` collects orphan `<data dir>/goals/<goalId>.md` objective files, including those of sessions removed in the same pass. Live sessions keep their current and historical objective files (including history pruned from the goals table but still owned by session events). Only regular goal files in that folder are eligible; symlinks and unrelated files are left alone.

`storage.report` includes optional `goalFiles`, `goalBytes`, `orphanGoalFiles` and `orphanGoalBytes`; the clean result includes `goalFilesRemoved` and counts their bytes in `bytesReclaimed`. Dry runs report the same candidates without deleting them. `/storage` shows the category and can confirm an orphan-only clean.

## Not done

- The native engine's goal tools need `main.ts` to pass the daemon's `goals` input on to `createNativeEngine`. Without it the tools are absent and only the text marker works.
