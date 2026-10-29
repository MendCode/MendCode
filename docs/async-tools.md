# Async tools and questions

The native engine offers these tools only after explicit opt-in through `settings.set`:

```json
{"type":"settings.set","patch":{"experimental":{"async_tools":true,"async_questions":true}}}
```

Both flags default to off and are independent. `experimental` is a settings object: include other
experimental values you want to retain when replacing it. Non-native engines do not emulate these tools.

- `tool_start { tool, arguments }` starts `read`, `grep`, `glob` or `webfetch`, returning `job_id` and
  `status`. It checks the target's arguments, agent allow/deny, tool rules, approvals and extension hooks.
  Shell, writes, overridden built-ins and arbitrary MCP tools are excluded.
- `tool_status { job_id, offset?, limit? }` returns the current session's stored result. Pages default
  to 8,000 characters, cap at 16,000 and return `next_offset` when there is more.
- `tool_cancel { job_id }` cancels a queued or running job and retains its history and any late output.
- `tool_wait { job_ids, timeout_ms? }` waits once for 1–12 jobs, default 10 seconds, capped at 60 seconds.
  It returns immediately when all jobs are terminal; a timeout or caller cancellation returns current states.
- `question_start { questions }` posts the same ordered batch as `question` and returns `question_id`.
  The agent can continue independent work. `question_status { question_id }` reads the real reply or dismissal.
  Silence stays `pending` and never grants permission. See [batch questions](layout.md#question-batches-and-todo-lists-b57).

The daemon owns four active and eight queued jobs per session, with a global cap of 16 active and 128
unfinished jobs. Up to 12 questions can remain pending per session. Jobs never mutate foreground state.
Results and replies enter a persisted mailbox, then the session actor's synthetic notice queue at a safe
boundary. The usual queue policy applies; a notice is not a new user authorization. Delivery is deduplicated
across reconnects and restarts. Disabling a flag cancels its work and queued continuations. Cancelling the
user's turn invalidates its generation and withdraws queued async notices, so later work cannot resume it.

Completed output is masked before storage, capped at 50,000 characters, and mailbox context at 4,096.
Media is not replayed asynchronously: the result directs the agent to synchronous `read`. The daemon keeps
256 terminal records per session; undelivered mailbox entries are retained and apply backpressure at 256.
Restart marks unfinished jobs `interrupted` without repeating them. Pending questions and actual answers survive.

The CLI reuses its question panel, ordered answer controls and bordered Ctrl+T Jobs dock. Persisted jobs and
questions are restored even when their original events precede the loaded transcript window. Compact layouts
stay single-column. No sidebar is enabled by async work.

Protocol commands: `continuity.list`, `continuity.get` (paged), `continuity.cancel` and `continuity.wait`,
all scoped by `sessionId`. Replies use the existing `request.resolve`/`answerQuestions` path, with first reply
winning. Typed client helpers are `continuity(sessionId, kind?)` and `continuityRecord(sessionId, id, offset?, limit?)`.
Content and control commands require full-access peers; none are added to `READ_ONLY_COMMANDS`.
