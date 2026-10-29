# Peers

Sessions of the same project can talk to each other through two agent tools.

## `sessions`

Lists the project's other sessions: id, title, state (`idle`, `generating`, …) and last update. It never shows their transcripts, files or reasoning. Sub-sessions (workflow tasks, subagents) are not listed.

It is a list of recent conversations, not of agents working right now: `idle` does not mean the session is open, and a title does not mean it owns a file.

## `tell`

Sends a plain-text message to one session by its exact id.

- Nothing else is shared: no history, files, reasoning or permissions.
- The message arrives as a notice in the target's queue. A busy target reads it when its turn ends; it is never interrupted. After a user cancel it waits until the user acts, like any notice.
- When the turn that read it ends, the target's last answer is queued back to the sender as a notice, starting with `[reply from session … "title"]`. It says so if that turn failed, was cancelled or was interrupted.
- `mode`: `auto` (default) and `queue` wait for the turn to end; `steer` hands the notice to the target's running turn after its next tool result (native engine only; Claude Code, Codex and ACP targets queue it). There is no `restart`: a model never interrupts another session. `clientRequestId` makes a retry return the first answer and send nothing.
- Replies are never forwarded again, so two sessions cannot bounce acknowledgements.
- Permission class `write`: in `ask` mode the user approves each message; the approval shows the target and the text.

Limits:
- same project (directory) only;
- at most 3 messages per session waiting for an answer, and 20 per hour;
- messages up to 4,000 characters; replies keep the last 4,000;
- deliveries have a durable command lifecycle. After a restart queued commands keep their existing queue id and wait for the user to resume; completed/interrupted turns settle from persisted events. An unverified delivery fails rather than inserting the prompt twice.

Claude Code sessions can receive messages and answer them. The tools themselves are only on native sessions.

The `threads` tool (`message`, `wait`, `read`, `interrupt`, and `merge_back` for a fork of the calling session) and the composer's `@thread` build on the same rules and limits; see [sessions](sessions.md#thread-tools-and-thread-t4-tier-balanced).

## Local command inbox (B31)

`c` in Agent View or `/agents commands` opens active commands, history and policy. `1`/`2`/`3` or Tab switches tabs; arrows select;
Enter opens the related session, `a` accepts an incoming request, `x` rejects it, PgUp/PgDn scrolls details,
`r` refreshes and Esc returns. Push events refresh the open inbox. `/agents policy` opens the policy matrix.

Requests use exact session ids:

- `/agents summary <id> [instructions]` requests a read-only progress summary. Target review queues a summary notice behind active work; its final answer becomes the command result.
- `/agents rename <id> <title>` and `/agents tag <id> <comma-separated tags>` change Agent View metadata after target review. They preserve the saved conversation title.
- `/agents message <id> <text>` queues a user prompt after target review.
- `/agents pause <id> [reason]` and `/agents stop <id> [reason]` record control requests. They run only when the target session accepts them (`approval_required`, same project, local only): pause holds the target after its running turn, stop cancels its running turn and sub-agents. Rejection leaves the target untouched. To control a session directly as the user, see [agent control](agents.md#agent-control-pause-resume-stop).

Protocol: `session.agent-command.create/list/update/policy`, typed helpers on the client, and
`agent-commands.changed` global events. Records have pending/accepted/running/completed/rejected/failed/expired
states, deduplicate active requests from the same source, default to a 30-minute pending TTL and cap active
commands at three per target. Expired pending requests free capacity. Only a client subscribed to the target can review;
clients cannot supply results or arbitrary lifecycle transitions. The policy matrix retains v1's safe_auto,
same_workspace and approval_required classes. Summary, metadata and control auto-accept authority is not enabled.
Command operations are local only; remote authority/relay remains B73, and the HTTP bridge remains B81.
Secret values and session-local markers are redacted before text crosses sessions.

Frames: `bun scripts/render-frames.ts .agents-frames/B31 100x30 180x50 --b31` (isolated fake harness).

Opt-in room leases and authenticated loopback coordination: [Mflow](mflow.md) (B73). Remote agent-command authority remains off.
