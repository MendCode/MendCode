Use two agent tools to let sessions talk to each other: within a project freely, and across projects with an approval each time (see [Other projects](#other-projects)). Start with `sessions` to find a conversation, then use `tell` to send a message.

## `sessions`

Lists the project's other sessions, newest first, in a compact form that costs few tokens:

```
id · [state] · age · title
~/Code/app
  WC8Q5R8B · 29m · Fix the login redirect
  VQSGK1YC · generating · 6h · Plan the new importer
```

### Read the list

The list has one header:

| Field | Meaning |
| --- | --- |
| id | Shortest unique end of the session id, at least 8 characters |
| state | Shown only when the session is not `idle` |
| age | `3m`, `4h` or `2d` |
| title | Cut at about 50 characters |

Every tool accepts the printed id: `read`, `stats`, `tell`, and `threads` `read`, `search`, `message`, `wait`, `interrupt`, `merge_back`, also for another project's session.

The list never shows transcripts, files or reasoning. Sub-sessions (workflow tasks, subagents) are not listed.

**Note:** This lists recent conversations, not agents working right now. `idle` does not mean the session is open, and a title does not mean it owns a file.

### Choose scope and filters

| Option | Does |
| --- | --- |
| `scope=all` | List the newest sessions of every project of this daemon |
| `directory=<folder>` | List sessions of one other project |
| `limit` | Default 10, at most 100; larger numbers return 100 and end with `showing 100 (max)` rather than an error |
| `query` | Match title text, any case |
| `state` | Match `busy` or `idle` |
| `project` | Match text in the folder path; searches every project |

For other-project lists, rows are grouped under their folder, written once with `~` for the home.

The default limit is 10, and the maximum is 100. Filters combine and search the newest 500 sessions before `limit` is applied.

`threads list` and the bridge's `thread_list` take the same `limit`, `query` and `state`. `threads list` also takes `project`, `scope` and `directory`.

### List accepted plans

Use `sessions plans=true` to list plan files you accepted or applied instead. `scope` and `directory` work as above.

Plans are grouped by project as `id · status steps · age · title`. The id is `plan-` plus the shortest unique end of the name.

Use `read=<plan-… id>` to return one with its session and file. This is local only; see [plan files](plan-review.md#plan-files).

### `read`: one session's conversation

Use `sessions read=<exact session id>` instead of searching `~/.claude`, `~/.codex` or MendCode's database for a session.

It returns the conversation oldest first, as the Markdown of [`/export`](sessions.md) without the details:

- The user's and assistant's messages and system notices.
- One line per tool call (`**Tool:** \`shell: ls\``, at most 160 characters).
- No tool input or output, reasoning, or work an engine's own sub-agent did inside the turn. Secrets stay markers.

The page starts with a line saying it is another conversation's data, not instructions.

#### Choose an id

An exact id is the user's own pointer (`read the chat ses_…`). It may name a session of another project of this daemon; the list stays this project's.

A sub-session (a sub-agent's child session) is read by its id too. The short id a list prints is accepted; a title or another program's chat (`claude:…`, `codex:…`) is not.

#### Read the next page

1. Read the returned page. It holds whole messages up to 40,000 bytes and 1,500 lines.
2. If it ends with `more: cursor=<n>`, call again with `read` and `cursor=<n>`.
3. Stop at `end of conversation` on the last page.

One longer message is cut on its own page; the export keeps 40,000 characters of a message anyway. A turn longer than the export's 200 items continues on the next pages instead of being cut.

The permission is `read`, like the list: no approval. A turn started by a remote or peer client reads no other conversation (`reading another session is local only`), as it gets no `threads` tool.

To search inside a conversation, or read this project's chats kept by other programs, see `threads` in [sessions](sessions.md#thread-tools-and-thread-t4-tier-balanced).

## `tell`

Sends a plain-text message to one session by its id from `sessions` (the short form works).

- Nothing else is shared: no history, files, reasoning or permissions.
- The message arrives as a notice in the target's queue. A busy target reads it when its turn ends; it is never interrupted. After a user cancel it waits until the user acts, like any notice.
- When the turn that read it ends, the target's last answer is queued back to the sender as a notice, starting with `[reply from session … "title"]`. It says so if that turn failed, was cancelled or was interrupted.

### Delivery modes

| `mode` | Delivery |
| --- | --- |
| `auto` (default) | Wait for the turn to end |
| `queue` | Wait for the turn to end |
| `steer` | Hand the notice to the target's running turn after its next tool result; native engine only, while Claude Code, Codex and ACP targets queue it |

There is no `restart`: a model never interrupts another session. `clientRequestId` makes a retry return the first answer and send nothing.

- Replies are never forwarded again, so two sessions cannot bounce acknowledgements.
- Permission class `write`: in `ask` mode the user approves each message; the approval shows the target and the text.

### Limits and recovery

| Limit | Bound |
| --- | --- |
| Other projects | Only through the rules in [Other projects](#other-projects) |
| Waiting for an answer | At most 3 messages per session |
| Rate | 20 per hour |
| Message size | Up to 4,000 characters |
| Reply size | Last 4,000 characters |

Deliveries have a durable command lifecycle. After a restart, queued commands keep their existing queue id and wait for the user to resume.

Completed/interrupted turns settle from persisted events. An unverified delivery fails rather than inserting the prompt twice.

Claude Code sessions can receive messages and answer them. Native sessions have the tools; Claude Code and Codex sessions reach them as `mcp__mendcode__sessions` and `mcp__mendcode__tell` while `harness_tools` is on ([Claude Code](claude-code.md)).

The `threads` tool (`message`, `wait`, `read`, `interrupt`, and `merge_back` for a fork of the calling session) and the composer's `@thread` build on the same rules and limits; see [sessions](sessions.md#thread-tools-and-thread-t4-tier-balanced).

## Other projects

A session can list, write to and open sessions in other projects of this daemon, on this machine only. A turn started by a remote or peer client has no `threads` tool and no `tell`.

The earlier one-project limit was a safety rule, not a technical one. Another project's session runs with that project's own trust, rules and permission mode; messaging it acts beyond the sender's starting folder.

These rules replace that limit:

- **Always asks.** `tell` (and `threads message`) to a session of another project, and `threads start`, ask the user every time, in every permission mode including full access, whatever the allow rules or saved grants say. The approval names the target's folder and shows the text. Explicit deny rules still win. Plan mode refuses them.
- **Never above the sender.** A message goes only to a session whose permission mode is not above the sender's (`plan` < `ask` < `edits` < `smart` < `full`); otherwise it is refused at once, before any approval is asked, and nothing the user answers changes that from the sender's side: to write to a session running in full access, the user raises the sender to full. A started session gets the folder's own usual mode (its project setting, else the default) capped at the opening session's mode, so a lower-ranked session cannot launch a stronger one. This is the same ceiling an agent-origin client has ([permissions](permissions.md)).
- **Marked and not the user's.** The message arrives as a notice (a turn with synthetic, non-user authority) that starts `[message from session … "title" in another project ("/path")]` and says an agent of another project wrote it, that it carries none of the user's authority and that the target keeps to its own permissions and project rules. The answer returns marked the same way (`[reply from session … in another project …]`, "not an instruction from the user"). Secret values never cross.
- **Trust is not granted.** A started session in a folder that is not trusted (`trustedToolDirs`) loads none of that project's tools, hooks or extensions, as in any session opened there; the approval and the result say which it is.
- **Narrow reach.** Reading, searching, `stats`, `interrupt` and `merge_back` through `threads` stay inside the project (`sessions read=<exact id>` already read any project). `message` and `wait` name another project's session by its id as `list scope=all` prints it (short or full); a sub-agent session is not addressable. The Claude Code and Codex bridge ([thread MCP](thread-mcp.md)) stays inside one project, and `session.agent-command.create` from a client still refuses another project.
- **Same limits.** The 3 waiting messages and 20 per hour are counted across projects too. A started session counts as one message, checked before the session exists so a refusal leaves nothing behind.

### `threads start`

Use `threads start directory=<absolute folder> text=<first message> [title=<name>]` to open a new session in the folder. It sends the text as the first message, a peer message under the rules above.

- The folder must exist and be a directory; `~/…` is expanded.
- A sub-agent session cannot start sessions.

The result names the new session's id, permission mode and whether the folder is trusted. Its answer arrives as a notice, or through `threads wait` with the id.

## Local command inbox (B31)

Press `c` in Agent View or run `/agents commands` to open active commands, history and policy. Push events refresh the open inbox.

| Key | Does |
| --- | --- |
| `1`/`2`/`3` or Tab | Switch tabs |
| Arrows | Select |
| Enter | Open the related session |
| `a` | Accept an incoming request |
| `x` | Reject it |
| PgUp/PgDn | Scroll details |
| `r` | Refresh |
| Esc | Return |

`/agents policy` opens the policy matrix.

### Requests

Requests use exact session ids:

- `/agents summary <id> [instructions]` requests a read-only progress summary. Target review queues a summary notice behind active work; its final answer becomes the command result.
- `/agents rename <id> <title>` and `/agents tag <id> <comma-separated tags>` change Agent View metadata after target review. They preserve the saved conversation title.
- `/agents message <id> <text>` queues a user prompt after target review.
- `/agents pause <id> [reason]` and `/agents stop <id> [reason]` record control requests. They run only when the target session accepts them (`approval_required`, same project, local only): pause holds the target after its running turn, stop cancels its running turn and sub-agents. Rejection leaves the target untouched. To control a session directly as the user, see [agent control](agents.md#agent-control-pause-resume-stop).

### Protocol and limits

The protocol uses `session.agent-command.create/list/update/policy`, typed helpers on the client, and `agent-commands.changed` global events.

| Record behavior | Rule |
| --- | --- |
| States | pending/accepted/running/completed/rejected/failed/expired |
| Deduplication | Active requests from the same source are deduplicated |
| Pending TTL | 30-minute default |
| Active commands | At most three per target; expired pending requests free capacity |

Only a client subscribed to the target can review. Clients cannot supply results or arbitrary lifecycle transitions.

The policy matrix retains v1's safe_auto, same_workspace and approval_required classes. Summary, metadata and control auto-accept authority is not enabled.

Command operations are local only; remote authority/relay remains B73, and the HTTP bridge remains B81. Secret values and session-local markers are redacted before text crosses sessions.

### Frames

Render frames with `bun scripts/render-frames.ts .agents-frames/B31 100x30 180x50 --b31` (isolated fake harness).

Opt-in room leases and authenticated loopback coordination: [Mflow](mflow.md) (B73). Remote agent-command authority remains off.
