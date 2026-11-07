# Async tools and questions

Async tools let the agent start work or post questions and continue independent work. This guide covers enabling them in the native engine, checking results and understanding what survives a restart.

## Enable async tools and questions

Opt in explicitly through `settings.set`:

```json
{"type":"settings.set","patch":{"experimental":{"async_tools":true,"async_questions":true}}}
```

Both flags default to off and are independent. Non-native engines do not emulate these tools.

**Note:** `experimental` is a settings object: include other experimental values you want to retain when replacing it.

## Start and check a job

1. Use `tool_start { tool, arguments }` to start `read`, `grep`, `glob` or `webfetch`. It returns `job_id` and `status`.
2. Use `tool_status { job_id, offset?, limit? }` to read the current session's stored result. Pages default to 8,000 characters, cap at 16,000 and return `next_offset` when there is more.
3. To wait for results, use `tool_wait { job_ids, timeout_ms? }`. It waits once for 1–12 jobs, defaults to 10 seconds and caps the wait at 60 seconds.

The wait returns immediately when all jobs are terminal. A timeout or caller cancellation returns current states.

To stop a queued or running job, use `tool_cancel { job_id }`. Cancellation retains its history and any late output.

Starting a job checks the target's arguments, agent allow/deny, tool rules, approvals and extension hooks. Shell, writes, overridden built-ins and arbitrary MCP tools are excluded.

## Ask without blocking independent work

1. Use `question_start { questions }` to post the same ordered batch as `question`. It returns `question_id`, and the agent can continue independent work.
2. Use `question_status { question_id }` to read the real reply or dismissal.

**Warning:** Silence stays `pending` and never grants permission. See [batch questions](layout.md#question-batches-and-todo-lists-b57).

## Limits and cancellation

The daemon owns the jobs and enforces these limits:

| Scope | Limit |
|---|---|
| Active jobs per session | four |
| Queued jobs per session | eight |
| Active jobs globally | 16 |
| Unfinished jobs globally | 128 |
| Pending questions per session | 12 |

Jobs never mutate foreground state. Disabling a flag cancels its work and queued continuations.

Cancelling the user's turn invalidates its generation and withdraws queued async notices, so later work cannot resume it.

## Results and restarts

| Stored content | Limit or behavior |
|---|---|
| Completed output | masked before storage; capped at 50,000 characters |
| Mailbox context | capped at 4,096 characters |
| Terminal records | the daemon keeps 256 per session |
| Undelivered mailbox entries | retained; apply backpressure at 256 |

Media is not replayed asynchronously: the result directs the agent to synchronous `read`.

Restart marks unfinished jobs `interrupted` without repeating them. Pending questions and actual answers survive.

## Find jobs and questions in the CLI

The CLI reuses its question panel, ordered answer controls and bordered Ctrl+T Jobs dock. Compact layouts stay single-column. No sidebar is enabled by async work.

Persisted jobs and questions are restored even when their original events precede the loaded transcript window.

## How delivery and the protocol work

Results and replies enter a persisted mailbox, then the session actor's synthetic notice queue at a safe boundary. The usual queue policy applies; a notice is not a new user authorization.

Delivery is deduplicated across reconnects and restarts.

All protocol commands are scoped by `sessionId`:

| Command | Purpose |
|---|---|
| `continuity.list` | list records |
| `continuity.get` | get a record, paged |
| `continuity.cancel` | cancel work |
| `continuity.wait` | wait for work |

Replies use the existing `request.resolve`/`answerQuestions` path, with first reply winning.

Typed client helpers are `continuity(sessionId, kind?)` and `continuityRecord(sessionId, id, offset?, limit?)`.

Content and control commands require full-access peers; none are added to `READ_ONLY_COMMANDS`.
