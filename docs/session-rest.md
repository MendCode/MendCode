# Session REST adapter (B81)

Use the opt-in [HTTP adapter](remote.md#http-adapter-b34) to read and control sessions through the existing daemon. Binding remains loopback-only; every request requires a v2 remote token.

## Access and IDs

The `session.rest.*` commands (read, update, control, mutate) and `attachment.put` require full tokens. They are deliberately absent from `READ_ONLY_COMMANDS`; `/command` retains its existing observational permissions.

These compatibility projections use native v2 session/item/request IDs, not v1 database IDs. No listener, provider or external service is enabled by this adapter.

## Read sessions and messages

`GET /session`, `/session/status`, `/session/agent-view`, `/session/:id`, `/session/:id/children`, `/session/:id/todo`, `/session/:id/diff`, `/session/:id/message` and `/session/:id/message/:messageID` return v1-style arrays, status maps, session records, or `{info, parts}` messages.

Project identity is derived from v2's canonical Git/project root. Session records add `path`, the directory relative to that root, omitted at the root.

### Choose a project scope

The list routes (`/session`, `/session/agent-view`, `/experimental/session`, `/api/session`) accept:

| Filter | Scope |
|---|---|
| `scope=project` | Every session of the selected workspace's project, not only its directory |
| `path=<project-relative dir>` | Sessions at or below it, across the project; an empty value means the whole project |
| Neither | The exact workspace directory |

`path` must stay inside the project: no leading `/`, drive letter or `..`. Otherwise the response is 400. Both filters are fixed inside a cursor, so a `cursor` cannot be combined with them.

### Message fields

Messages are full donor DTOs:

| Field or part | Contents |
|---|---|
| Assistant info | Always has `mode`, `agent`, `cost` and `tokens`, with zeros until usage is recorded |
| `error` | `{name: "UnknownError", data: {message}}` |
| Text/reasoning parts | Carry `time` |
| Tool states | `pending|running|completed|error` with `title`, `metadata`, and `error` for failures |
| Compaction parts | Say `auto` |

`GET /session/:id/message/:messageID` honours `view`, `partsLimit` and `partsAfter`. The `tui`/`history` views drop reasoning and cap tool output at 2,000 characters.

`/api/session/:id/message` and `/context` return donor v2 messages:

- User `files`/`agents`.
- Assistant `content`: `text`, `reasoning` with `id`, `tool` with donor `state` content/structured and `time`.
- `{type: "compaction", reason, summary}` and `error: {type: "unknown", message}`.

### Agent View and todos

Agent View rows (`/session/agent-view`) are the donor `BackgroundSession.Entry`: `sessionID`, derived `state`, `summary`, `error`, `pinned`, `process`, `writer` (only while its lease is live), `time`, `metadata` overrides and `session`, plus v2's `status`.

Sessions without a background record use the directory as summary. Todo records come from completed todo tool inputs; diffs are described below.

## Inspect diffs and summaries

`GET .../diff` returns v1 `SnapshotFileDiff` rows `{file, patch, additions, deletions, status}`. By default, this is the net change of every live turn: each file's first before-state to last after-state, as a git-style patch with header.

Use `?messageID=` for one user message's persisted diff. Shell changes are included only with `snapshotScope: "worktree"`, an opt-in setting; see [sessions](sessions.md#undo-and-redo).

Only the newest 20 turns keep file bytes. A path whose bytes were pruned falls back to the per-turn summaries that survive pruning: counts add up, patches follow each other, and the row carries `truncated: true`.

| Projection | Summary fields |
|---|---|
| User messages | `info.summary.diffs` from the persisted summary; patches cut to 4 KB per file, 16 KB per message |
| `GET /session/:id` | `summary {additions, deletions, files}`, summed from persisted per-turn summaries, not in lists; `revert {messageID, partID?}` while an unrevert can restore something |

Unknown provider/model/cost counters are omitted. Reverted turns remain in the event log and are excluded from these projections.

## Create, archive and restore sessions

| Route | Body and behavior |
|---|---|
| `POST /session` | Empty body or `{title?, parentID?, agent?, model?}`; `model` is `{providerID, modelID, variant?}` |
| `PATCH /session/:id` | `{title?, time?: {archived?: epochMilliseconds | null}}` |
| `DELETE /session/:id` | Existing session deletion safeguards apply |
| `POST .../fork {messageID?}` | Copy the transcript, excluding the selected message |
| `.../revert {messageID, partID?}` | Use v2 undo, including tracked file restoration |
| `.../unrevert` | Use v2 redo, including tracked file restoration |

Archive state persists privately in the daemon data directory and is excluded from REST lists by default. Restore it with `null`.

### Revert boundaries

- A user `messageID` reverts that message and everything after it.
- An assistant `messageID` or a `partID` reverts from that part on; see [part-level revert](sessions.md#part-level-revert).
- An unknown message returns 404.

`.../unrevert` restores every waiting undo group and part-level revert (`session.redo {all}`). When nothing is reverted, it returns the session unchanged.

## Submit prompts and commands

| Route | Result |
|---|---|
| `POST .../message {parts: [{type: "text", text}], model?, agent?}` | Wait for that specific queued turn and return its assistant message |
| `.../prompt_async` | Accept the same body and return 204 after admission |
| `.../command {command, arguments, model?, agent?}` | Expand daemon-side Markdown commands; `init` queues repository instruction generation |
| `.../init {providerID, modelID, messageID}` | Use that same initialization prompt and keep the supplied `messageID` as the user message's id |

Text parts can be ignored with `ignored: true`. For initialization, `user.submit` accepts an optional `messageId`; an id that already exists is refused without queuing anything. `.../init` now keeps the requested `messageID`.

### R7 write fidelity

Prompt bodies (`message`, `prompt_async`) also take `messageID`, `variant`, `system` and these parts:

| Part | Behavior |
|---|---|
| `text` | `synthetic` text goes to the model but not the transcript; `ignored` text shows in the transcript but not to the model |
| `file` | Must be a `data:` URL, never a path or remote URL (501) |
| `agent`, `subtask` | Become an instruction to use the task tool |

PNG/JPEG/GIF/WebP/PDF bytes are stored as attachments by their real type through `attachment.put` (about 140 KB). `text/*` or JSON files are inlined into the prompt (64 KB).

`system` becomes a leading block of that turn's prompt: user level, not the engine's system prompt. `noReply`, per-prompt `tools` and structured `format` are described under R9a below.

### Message IDs and command defaults

`messageID`, or one the adapter generates, is passed to `user.submit` and becomes the user message's item ID. A prompt queued behind a running turn keeps one ID from admission to the transcript.

`/api/session/:id/prompt` returns that ID for `deferred` and `immediate` delivery. A duplicate ID is refused.

`.../command` also takes `messageID`, `variant` and file `parts`. A Markdown command's `agent`, `model` and `subtask` front matter apply unless the request names its own.

A sub-task command is delegated to its agent through the task tool and leaves the turn's agent alone.

## Run a shell command

`POST .../shell {agent, command, model?, messageID?}` queues your own `!command`, waits for it and returns the shell message. It uses `user.shell`: no model call and no approval, with the same authority as a full-token `user.shell`.

The agent must exist and a model must be a known provider/model pair. Both only label the response, since the transcript stores the session's own agent and model.

This route needs an engine with shell mode and is absent from `READ_ONLY_COMMANDS`.

## Revise messages

These routes apply native message revisions through `session.rest.mutate`:

| Route | Operation |
|---|---|
| `DELETE .../message/:messageID` | Delete a message |
| `DELETE .../message/:messageID/part/:partID` | Delete a part |
| `PATCH .../message/:messageID/part/:partID` | Patch a text part with `{id, type: "text", text}`; identity fields are checked against the route |

REST ids resolve to native items and their current revisions, so no `If-Match` is needed. Every revision safeguard remains:

- `allowMessageEdits` must be on; otherwise 403.
- The session must be idle with an empty queue; otherwise 409.
- History must be exact native history. Compacted, shell-composed or external history is refused.
- Reasoning and compaction parts are not revisable. A part PATCH accepts text only.

Deleting a user message removes its text and attachments. Deleting just the text of a message that has attachments clears the text.

A message deletion applies item by item after checking that all are revisable. The original events stay in the log.

## Compact and read model context

`POST .../summarize {providerID, modelID, instructions?, auto?}` queues a compaction with the instructions. When the model differs from the session's, it also selects that model (`session.compact {instructions, model}`).

The native engine then writes a portable summary on that model instead of a native checkpoint. Other engines refuse the options (400). `auto` is accepted and ignored.

`GET /api/session/:id/context` returns the native engine's own saved history after compaction and revisions. IDs are `ctx_NNNNNN` by position, and tool results are folded into their calls.

| History source | Header |
|---|---|
| Native engine's saved history | `X-Context-Source: engine` |
| No native history: external engines or nothing saved yet | Transcript projection, `X-Context-Source: transcript` |

Over the 256 KB frame, the oldest entries are dropped and `X-Truncated: true` is set. `GET /api/session/:id/context` projects visible messages since the last recorded compaction.

## Control turns and approvals

| Route | Behavior |
|---|---|
| `POST .../abort` | Stop the active turn |
| `.../cancel-turn {targetMessageID}` | Return `cancelled`, `already_terminal`, `target_mismatch` or `not_running`, without cancelling a different turn |
| `.../interrupt` | Promote the oldest queued prompt and interrupt the active one |
| `.../permissions/:requestID {response: "once" | "always" | "reject"}` | Resolve the actual pending approval |

**Note:** `always` means session scope, not permanent global permission.

## Page through results

`GET /api/session` and `/api/session/:id/message` return `{items, cursor: {previous?, next?}}`.

| Option | Default or rule |
|---|---|
| `limit` | 50 |
| `order` | `desc` |
| `cursor` | Preserves order, filters and selected workspace/session; do not combine it with order or filters |
| `view` | Supports full/tui/tui-all/history; tui/history omit reasoning |

Legacy messages default to chronological order and the newest requested window. `before`/`after` require a positive limit. Legacy navigation uses `X-Older-Cursor`, `X-Newer-Cursor`, `X-Next-Cursor` and `Link` headers.

Large messages/pages are bounded. `partsMore`/`partsCursor` and `X-Truncated` identify cuts.

## Queue work and wait

| Route | Completion |
|---|---|
| `POST /api/session/:id/prompt {prompt: {text}, delivery?: "immediate" | "deferred"}` | Queue the prompt; immediate waits, deferred returns after admission |
| `POST .../compact` | Queue compaction; return 204 after completion |
| `POST .../wait` | Return 204 once idle |

Waits are event-driven, cancel on disconnect and have a 55-second deadline (409 on expiry). Native clients can use `restSessions`, `updateRestSession` and `controlRestSession`; a wait's explicit `timeoutMs` is independent of the client's usual RPC deadline.

## List across projects and inspect usage

`GET /experimental/session` lists sessions across daemon projects. It accepts optional `roots`, `start`, `search`, `limit`, `archived`, and a numeric update-time `cursor`.

An explicit workspace/directory scopes the global list. `archived=true` includes archived sessions. Normal routes remain scoped to the selected registered workspace.

### Usage insights

`GET /experimental/usage-insights?start=EPOCH_MS&limit=1000&messageLimit=500` returns v1-style `days`, `totals`, `topTools`, `topAgents`, and `topModels`. These use native observed usage, messages and tracked file snapshots.

Every local day from `start` to today is a row, zeroed when idle. To keep one answer inside a daemon frame, only the most recent 366 days are padded; older days appear only when they had activity.

A day is active with tokens or user messages. `activeDays`, `currentStreak` and `longestStreak` follow that rule; `currentStreak` is zero unless today is active.

## Set session permissions

`POST /session` and `PATCH /session/:id` accept `permission: [{permission, pattern, action}]`: max 500 rules, and `[]` clears them. The session projection lists them. A full token is required.

The native engine evaluates these rules after settings and agent rules, with the last match winning. They apply to that session and the sub-agent sessions it spawns.

- A deny refuses the call.
- An allow skips the approval ask.
- Rules do not hide a tool from the model's tool list.

Rules are private daemon state in `session-permissions.json`, mode 0600, and are removed with the session.

## R9a prompt leftovers

These options are native engine only. Claude Code, ACP and Codex sessions answer 501 because they would silently ignore them.

### Record without a reply

`noReply: true` records the user message in the transcript and model history without calling the model; no budget applies. The response is that user message, and the next prompt sees it.

### Limit tools for one prompt

`tools: { name: false }` removes tools for that prompt only; wildcards are allowed. `true` never adds a tool the agent, permission rules or run limits withhold.

Sub-agents, whose tools this option cannot bound, are off for that turn.

### Request structured output

`format: { type: "json_schema", schema, retryCount }` gives the model a `StructuredOutput` tool whose arguments are validated against the schema.

| Setting | Limit or default |
|---|---|
| Schema | Object schema, up to 16 KB, local `$ref`s only |
| `retryCount` | Default 2 |

A valid call ends the turn; its arguments become the assistant message's `info.structured`. A plain-text or invalid answer is retried. After the retries, the turn fails with `info.error.name = "StructuredOutputError"`.

A structured answer over 64 KB is not exposed in `info.structured`; the tool part still shows it.

### Queuing and model steps

The three options travel as `turnOptions` on `user.submit`. They are stored on the queued message, survive a restart and keep that prompt from joining a running turn.

Assistant messages of turns with model calls carry `step-start`/`step-finish` parts. Each model call is a step, opened before its first part and closed after its tool calls with that call's tokens and cost.

The `reason` is `tool-calls`, `stop` or the turn's end state. Without usage reports, a step ends where tool calls give way to a new answer.

Turns without a model call (`!command`, compaction, `noReply`) have no steps. The `tui`/`history` views and v2 content omit them, and they cannot be edited or deleted.

## Remaining compatibility limits

The following remain compatibility limits:

- v1's full snapshot accounting in usage.
- The user message's stored `system`/`tools` fields.
- Complete unbounded message bodies and exact v1 message/part IDs.
- `file:`/remote file URLs (501).
- `noReply`, `tools` and `format` on a session whose engine is not the native one (501).
- A per-message agent/model stored for shell and prompts: the transcript keeps the session's.
- A real system-prompt override: `system` is prompt text.
- Active model-context retention beyond the recorded compaction boundary.

Deferred prompts queued behind active turns keep their message ID from admission. Unsupported request fields are rejected before submission.

No TUI screens change in B81, R6 or R7, so terminal frames are not applicable.
