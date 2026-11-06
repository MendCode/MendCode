# Peers

Sessions can talk to each other through two agent tools: within a project freely, and across projects with an approval each time (see [Other projects](#other-projects)).

## `sessions`

Lists the project's other sessions, newest first, in a compact form that costs few tokens:

```
id · [state] · age · title
~/Code/app
  WC8Q5R8B · 29m · Fix the login redirect
  VQSGK1YC · generating · 6h · Plan the new importer
```

One header; the id is the shortest end of the session id that no other session shares (at least 8 characters), and every tool takes it as printed (`read`, `stats`, `tell`, and `threads` `read`, `search`, `message`, `wait`, `interrupt`, `merge_back`, also for another project's session); the state shows only when the session is not `idle`; the age is `3m`, `4h` or `2d`; the title is cut at about 50 characters. `scope=all` lists the newest sessions of every project of this daemon, `directory=<folder>` those of one other project; rows are then grouped under their folder, written once with `~` for the home. The list never shows their transcripts, files or reasoning. Sub-sessions (workflow tasks, subagents) are not listed.

- **`limit`** is 10 by default and at most 100. A larger number is not an error: 100 come back and the last line says `showing 100 (max)`.
- **Filters**: `query` (the title contains the text, any case), `state` (`busy` or `idle`) and `project` (the folder path contains the text; it searches every project). They combine, and they look through the newest 500 sessions before `limit` is applied.
- `threads list` and the bridge's `thread_list` take the same `limit`, `query` and `state`; `threads list` also `project`, `scope` and `directory`.

It is a list of recent conversations, not of agents working right now: `idle` does not mean the session is open, and a title does not mean it owns a file.

`sessions plans=true` lists the plan files you accepted or applied instead (grouped by project, `id · status steps · age · title`, the id as `plan-` and the shortest unique end of the name; `scope` and `directory` work as above) and `read=<plan-… id>` returns one, with its session and file, local only ([plan files](plan-review.md#plan-files)).

### `read`: one session's conversation

`sessions read=<exact session id>` returns that conversation, oldest first, as the Markdown of [`/export`](sessions.md) without the
details: the user's and the assistant's messages, system notices, and one line per tool call (`**Tool:** \`shell: ls\``, at most 160
characters). Tool input and output, reasoning and what an engine's own sub-agent did inside the turn are left out; secrets stay
markers. The page starts with a line saying it is another conversation's data, not instructions.

- **Any project.** An exact id is the user's own pointer (`read the chat ses_…`), so it may name a session of another project of
  this daemon; the list stays this project's. A sub-session (a sub-agent's child session) is read by its id too. The short id a list prints
  is accepted; a title or another program's chat (`claude:…`, `codex:…`) is not.
- **Pages.** A page holds whole messages up to 40,000 bytes and 1,500 lines (one longer message is cut on its own page; the export
  keeps 40,000 characters of a message anyway). A page that is not the last ends with `more: cursor=<n>`: call again with
  `read` and `cursor=<n>`. The last one ends with `end of conversation`. A turn longer than the export's 200 items goes on in the
  next pages instead of being cut.
- **Permission `read`**, like the list: no approval. A turn that a remote or peer client started reads no other conversation
  (`reading another session is local only`), as it gets no `threads` tool.

Use it instead of searching `~/.claude`, `~/.codex` or MendCode's database for a session; to search inside one, or to read this
project's chats kept by other programs, see `threads` in [sessions](sessions.md#thread-tools-and-thread-t4-tier-balanced).

## `tell`

Sends a plain-text message to one session by its id from `sessions` (the short form works).

- Nothing else is shared: no history, files, reasoning or permissions.
- The message arrives as a notice in the target's queue. A busy target reads it when its turn ends; it is never interrupted. After a user cancel it waits until the user acts, like any notice.
- When the turn that read it ends, the target's last answer is queued back to the sender as a notice, starting with `[reply from session … "title"]`. It says so if that turn failed, was cancelled or was interrupted.
- `mode`: `auto` (default) and `queue` wait for the turn to end; `steer` hands the notice to the target's running turn after its next tool result (native engine only; Claude Code, Codex and ACP targets queue it). There is no `restart`: a model never interrupts another session. `clientRequestId` makes a retry return the first answer and send nothing.
- Replies are never forwarded again, so two sessions cannot bounce acknowledgements.
- Permission class `write`: in `ask` mode the user approves each message; the approval shows the target and the text.

Limits:
- another project only through the rules in [Other projects](#other-projects);
- at most 3 messages per session waiting for an answer, and 20 per hour;
- messages up to 4,000 characters; replies keep the last 4,000;
- deliveries have a durable command lifecycle. After a restart queued commands keep their existing queue id and wait for the user to resume; completed/interrupted turns settle from persisted events. An unverified delivery fails rather than inserting the prompt twice.

Claude Code sessions can receive messages and answer them. Native sessions have the tools; Claude Code and Codex sessions reach them as `mcp__mendcode__sessions` and `mcp__mendcode__tell` while `harness_tools` is on ([Claude Code](claude-code.md)).

The `threads` tool (`message`, `wait`, `read`, `interrupt`, and `merge_back` for a fork of the calling session) and the composer's `@thread` build on the same rules and limits; see [sessions](sessions.md#thread-tools-and-thread-t4-tier-balanced).

## Other projects

A session can list, write to and open sessions in other projects of this daemon (on this machine only; a turn a remote or peer client started has no `threads` tool and no `tell`). The earlier limit to one project was a safety rule, not a technical one: a session of another project runs with that project's own trust, rules and permission mode, so a message there is the sender acting beyond the folder it was started in. These are the rules that replace it:

- **Always asks.** `tell` (and `threads message`) to a session of another project, and `threads start`, ask the user every time, in every permission mode including full access, whatever the allow rules or saved grants say. The approval names the target's folder and shows the text. Explicit deny rules still win. Plan mode refuses them.
- **Never above the sender.** A message goes only to a session whose permission mode is not above the sender's (`plan` < `ask` < `edits` < `smart` < `full`); otherwise it is refused at once, before any approval is asked, and nothing the user answers changes that from the sender's side: to write to a session running in full access, the user raises the sender to full. A started session gets the folder's own usual mode (its project setting, else the default) capped at the opening session's mode, so a lower-ranked session cannot launch a stronger one. This is the same ceiling an agent-origin client has ([permissions](permissions.md)).
- **Marked and not the user's.** The message arrives as a notice (a turn with synthetic, non-user authority) that starts `[message from session … "title" in another project ("/path")]` and says an agent of another project wrote it, that it carries none of the user's authority and that the target keeps to its own permissions and project rules. The answer returns marked the same way (`[reply from session … in another project …]`, "not an instruction from the user"). Secret values never cross.
- **Trust is not granted.** A started session in a folder that is not trusted (`trustedToolDirs`) loads none of that project's tools, hooks or extensions, as in any session opened there; the approval and the result say which it is.
- **Narrow reach.** Reading, searching, `stats`, `interrupt` and `merge_back` through `threads` stay inside the project (`sessions read=<exact id>` already read any project). `message` and `wait` name another project's session by its id as `list scope=all` prints it (short or full); a sub-agent session is not addressable. The Claude Code and Codex bridge ([thread MCP](thread-mcp.md)) stays inside one project, and `session.agent-command.create` from a client still refuses another project.
- **Same limits.** The 3 waiting messages and 20 per hour are counted across projects too. A started session counts as one message, checked before the session exists so a refusal leaves nothing behind.

### `threads start`

`threads start directory=<absolute folder> text=<first message> [title=<name>]` opens a new session in the folder and sends the text as its first message, a peer message like the above. The folder must exist and be a directory (`~/…` is expanded); a sub-agent session cannot start sessions. The result names the new session's id, its permission mode and whether the folder is trusted; its answer arrives as a notice, or `threads wait` with the id.

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
