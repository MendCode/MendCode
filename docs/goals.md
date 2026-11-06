# Goals

A goal is a session's standing objective: the agent keeps working on it turn after turn. Set one with `/goal <objective>`; the daemon starts each next turn itself.

Work continues until the goal is complete, blocked, over its token budget, stopped by a provider usage limit, or paused by you.

A goal is one objective in one session. A [loop](loops.md) is different: recurring work that wakes on a trigger in fresh sessions.

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

A session has one goal at a time. A `complete` or `budget_limited` goal is replaced by a new one without asking; an unfinished one needs `replace: true`.

Replaced and cleared goals stay in the history: the newest 20 per session.

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

### Long objectives and secrets

An objective over 4,000 characters is saved to `<data dir>/goals/<goalId>.md`. The goal's objective becomes `Read the goal objective file at <path> before continuing.` The limit is 60,000 characters.

Pasted secrets in an objective become `‹secret:N›` markers first, like any prompt.

### What you see

- **Indicator** in the status row (balanced), the footer (full) or a line above the prompt (minimal). While it works, `◎ goal 12k/50k · 4m` shows tokens, budget and time including the running turn.
- **Steering marker**: each automatic turn starts with a thin `◆ goal · continuing` line. The real steering text goes to the model only.
- **Cards** in the transcript when a goal is set, completes, is blocked, reaches its budget or usage limit, or stops continuing (with the reason). Pause, resume and usage changes only move the indicator.

The indicator can also show `◎ goal · paused`, `· blocked`, `· usage limit`, `· budget reached`, `· complete`, or `· stalled`. The footer shows it even when the `/footer` segments leave `goal` out.

## Model tools

These tools are registered on the native engine's main agent, not sub-agents, when the daemon gives it a goal port. No approval is asked.

With an unfinished goal (`/goal`), they are in the request in every tier. The agent can end the goal with `update_goal` without searching for the tool.

With no goal they stay behind `tool_search`, unless `/tier plan_tools on` lists them always ([tool discovery](tool-discovery.md#lean-catalogue-and-plan-tools-tier-defaults)).

| tool | arguments | notes |
|---|---|---|
| `get_goal` | none | JSON `{ goal: { status, objective, tokenBudget, tokensUsed, remainingTokens, timeUsedSeconds, note? } }` |
| `create_goal` | `objective`, `token_budget?` | only when the user explicitly asked for a goal; fails while an unfinished goal exists |
| `update_goal` | `status: complete \| blocked \| paused`, `note?` | `complete` only when achieved and verified; `blocked` only after the same blocker held for 3 goal turns in a row; `paused` only on the user's explicit request. It cannot resume, budget-limit or usage-limit a goal. On a budgeted goal the reply tells the agent to report the final usage ("X of Y tokens used") |

Engines without these tools (Claude Code, Codex, ACP) still work. The steering text asks the agent to end its last message with `GOAL_STATUS: complete` or `GOAL_STATUS: blocked - <why>` on its own last line.

The daemon reads that marker when the turn completes (`goals-signals.ts`). Continuation itself is plain text steering, so it needs no tools.

## How continuation is triggered

1. Every session event passes the goals service. `observe` (`packages/daemon/src/goals.ts:447`), registered in `packages/daemon/src/daemon.ts:844`, defers to a microtask. Observers run inside `sink.append`; appending from one would make client cursors skip events.
2. `process` (`goals.ts:283`) follows the turn. `turn.started` and the first user item mark it as a goal turn and set `activeSince`. `usage.recorded` adds `input + output` tokens, excluding cache, and may flip the goal to `budget_limited`; the last agent text is kept for the marker fallback.
3. On `turn.completed | cancelled | interrupted | failed`, `onTurnEnded` (`goals.ts:249`) adds the turn's wall time and makes the decision below. If work can continue, `next` (`goals.ts:132`) renders the template.
4. `next` calls `options.steer` (`goals.ts:158`, wired at `daemon.ts:840`), which posts to the session actor. `onSteer` (`packages/kernel/src/session-actor.ts:472`) checks whether the turn can start.
5. A steering turn is emitted as a `user_message` item with `meta { notice: true, goal: <kind> }` whose text is the label. It is never queued or stored in the queue, so undo treats it as a system notice.

| Turn-end condition | Decision |
|---|---|
| `GOAL_STATUS` marker | Ends the goal |
| Failed turn with a quota message | `usage_limited` |
| Any other failure, a cancel or an interrupt | Stalls the goal |
| Two goal turns in a row with no output (no text, no tool call) | Stalls the goal |
| Three goal turns in a row with no progress | Stalls the goal |
| 100 goal turns in a row without the user | Stalls the goal |

A stalled goal is still `active`; `stalled` says why, and no more automatic turns start.

`onSteer` starts the turn only when no turn runs, **nothing is queued** (queued user messages always go first), and the session is not held by a user cancel or an interrupt. Otherwise it returns false and the next turn end tries again.

Stalled goals restart when the user sends a message, or with `/goal resume`, which forces past a cancel's hold. A turn the user starts while the goal is active counts toward it too.

Both counts start over after a turn that acted, a user message, `/goal resume`, an edited objective or budget, and a new goal.

### Progress

A goal turn makes progress when one of its tool calls succeeds with a call and a result this goal has not seen before.

The fingerprint is the call's label, its input and its result (text or blob), kept for the goal's lifetime: the newest 4,000. These turns are no progress:

- a turn that only writes text ("no progress, the gate still says STOP");
- a turn whose tool calls all fail;
- a turn that repeats a check it already ran and gets the same answer.

Work that reads new files, runs commands with new output, edits, or polls a job whose state moves counts as progress.

So does a successful call that reports neither input nor result. The Codex engine sends its file edits and MCP calls with only a title, so a repeat cannot be told from new work there.

Three goal turns in a row with no progress stall the goal, and the reason quotes the agent's last message.

A loop that changes its calls a little every time, so that each looks new, is stopped by the second bound: 100 automatic goal turns in a row with no message from the user, no resume and no edit.

`/goal resume` or a message starts both counts again. The fingerprints stay, so repeating an old check after a resume is still no progress.

These rules exist because a goal once ran 2,029 turns ten seconds apart. The agent kept answering "no progress, the quota gate says STOP" to every continuation.

Every 257 turns it re-ran the gate and rewrote its state file. Each turn had text, so the no-output rule never fired.

Replayed on that session's events, the progress rule stalls it at the third turn after the first STOP, with no stall during the ten productive turns before it.

How others stop a goal (checked in their sources, 2026-10-29):

#### Codex

**Codex** (`codex-rs/ext/goal`) marks the goal blocked after 3 automatic turns with no activity at all, or after 3 turns where command execution failed and no tool succeeded.

Text or any tool call counts as activity. Everything else is left to the continuation prompt ("classify the previous turn as progress, a verified wait or no progress"). Codex has no turn cap.

#### OpenCode 2

**OpenCode 2** (`packages/core/src/plugin/goal.ts`) calls a reviewer on the same session after every round. It returns `done`, `continue`, `blocked`, `paused` or `wait`; only `done` completes the goal.

A round with no tool call, or one whose reviewer reason repeats the previous one word for word, is a stall. After 3 stalls, the goal pauses.

Every goal also pauses after 50 rounds and after 30 minutes idle waiting on background work.

#### Pi

**Pi** has no goal feature. Its durable harness only limits turns and restarts per run.

### Usage is not a stop reason

The steering texts say the objective is newer than what the user asked earlier in the session. An earlier stop rule, usage or quota floor or narrower scope gives way to it.

They also say the provider's usage is not a reason to stop or work less unless the objective sets a limit. The agent does not check the quota to decide whether to go on.

MendCode stops the goal only when a turn actually fails on the account's limit (below).

Project instructions, extensions and the system prompt still outrank the objective. A rule there that stops work below some quota, such as an extension's `prompt.system` text or a gate tool, keeps applying until it is removed.

### Budget

When `tokensUsed >= tokenBudget` the goal becomes `budget_limited` right away. The running turn finishes.

The daemon then sends one `budget_limit` steering turn: do not start new substantive work; summarize progress and what remains. Its tokens count too.

After that nothing continues. Raise the budget with `/goal budget` to continue.

### Usage limit

A turn that fails with a provider quota message (HTTP 429 quota, `usage_limit_reached`, "usage limit" wording) sets `usage_limited`. `/goal resume` reactivates it once the quota resets.

The paused turn also gets a bar with Resume at reset, which reactivates the goal by itself at the reset ([usage-limit.md](usage-limit.md)).

### Daemon restart

Nothing starts at boot. A goal that was `active` when the daemon stopped continues once when a client next opens the session (`goals.opened`, `daemon.ts:982`).

Several clients opening at once start one turn. The interrupted turn's time up to the stop is kept.

## Templates

The steering messages are `packages/daemon/prompts/goals/continuation.md`, `budget_limit.md` and `objective_updated.md`.

Any extension layer overrides one with `<layer dir>/goals/<kind>.md`. The last layer with the file wins: the project's `.mendcode/` folder beats its packages, which beat the user's folder.

An empty file or one over 64 KB is ignored.

| Placeholder | Value |
|---|---|
| `{{objective}}` | Objective with `<`, `>` and `&` escaped, so it cannot close its own `<objective>` tag |
| `{{tokens_used}}` | Tokens used |
| `{{token_budget}}` | Budget, or `none` without one |
| `{{remaining_tokens}}` | Remaining tokens, or `unlimited` without a budget |
| `{{time_used_seconds}}` | Time used in seconds |

Unknown names stay as written.

`objective_updated` is sent once, as the next steering turn, after the objective was edited.

## Commands

### Goal fields

| Fields | Meaning |
|---|---|
| `goalId`, `objective`, `status` | Goal identity, objective and state |
| `tokenBudget?`, `tokensUsed`, `timeUsedSeconds` | Budget and usage |
| `createdAt`, `updatedAt` | Creation and update times |
| `activeSince?` | Running turn's start, for clients |
| `stalled?` | Why an active goal is not continuing, for clients |
| `note?`, `objectiveFile?` | Additional client fields |

### Command reference

| command | result |
|---|---|
| `goal.get { sessionId, history? }` | `{ goal?, history? }` |
| `goal.set { sessionId, objective, tokenBudget?, replace? }` | `{ goal, replaced? }`; `busy` when an unfinished goal exists and `replace` is not set |
| `goal.update { sessionId, status?: active \| paused, objective?, tokenBudget?: n \| null }` | `{ goal }`; needs at least one field; `target_mismatch` with no goal; `active` is refused on `budget_limited` and `complete` goals |
| `goal.clear { sessionId }` | `{ cleared: true }` |

Changes arrive as `goal.changed { change, goal, by?, reason? }` session events.

- Changes are `created`, `edited`, `budget`, `status`, `progress`, `stalled`, `cleared`.
- `by` is `user`, `agent` or `system`.

The terminal rebuilds its goal state and cards from them, so a reopened session shows the same thing.

## Choices worth knowing

- The daemon, not the UI, continues the goal: closing the terminal does not stop it while the daemon runs, and every client sees the same state.
- `usage_limited` and `budget_limited` are separate statuses with separate ways back (`/goal resume`, `/goal budget`).
- Continuation never loops on failure: a failed, cancelled or interrupted turn, or two empty turns, stop it and say why.
- `blocked` and `complete` are the agent's calls (the user cannot set them by command); the templates ask for a per-requirement audit before `complete` and three turns of the same blocker before `blocked`.
- Goal turns are counted by tokens and wall time. Cache reads and writes are not tokens used.

## Storage cleanup

`storage.clean` collects orphan `<data dir>/goals/<goalId>.md` objective files, including those of sessions removed in the same pass.

Live sessions keep their current and historical objective files, including history pruned from the goals table but still owned by session events. Only regular goal files in that folder are eligible; symlinks and unrelated files are left alone.

| Result | Goal fields |
|---|---|
| `storage.report` | Optional `goalFiles`, `goalBytes`, `orphanGoalFiles` and `orphanGoalBytes` |
| Clean result | `goalFilesRemoved`; their bytes count in `bytesReclaimed` |

Dry runs report the same candidates without deleting them. `/storage` shows the category and can confirm an orphan-only clean.

## Not done

- The native engine's goal tools need `main.ts` to pass the daemon's `goals` input on to `createNativeEngine`. Without it the tools are absent and only the text marker works.
