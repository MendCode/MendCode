# Interactive and model-tool additions (B4)

Use these model-callable tools alongside `shell`, `shell_output` and `shell_kill` to run interactive programs, wait for work, monitor output or edit notebook cells.

## `shell_session` (interactive process on a PTY)

Use `shell_session` for programs that need stdin or a TTY: scaffolders that ask questions, REPLs, debuggers, `ssh` and TUIs.

1. Call `start` with the command. You get a session id and its first output.
2. Use `write` to send input; `\n` presses enter. Use `read` for output since the last read.
3. Use `kill` when you want to stop the process.

Choose the operation with one `action` argument:

| Action | Arguments | Result |
| --- | --- | --- |
| `start` | `command`, `workdir?`, `cols?`, `rows?`, `waitMs?` (default 1000), `maxChars?` | Session id plus the first output |
| `write` | `id`, `input`, `waitMs?` (default 500), `maxChars?` | Waits for the reply to settle, returns it |
| `read` | `id`, `waitMs?` (default 0, max 30000), `maxChars?` | Output since the last read |
| `resize` | `id`, `cols`, `rows` (1-1000) | Real PTY resize |
| `signal` | `id`, `INT` (ctrl-c), `EOF` (ctrl-d), `TERM`, `HUP`, `QUIT`, `KILL` | Signals the process group, then reads |
| `kill` | `id` | SIGTERM, SIGKILL after 2 s |
| `list` | none | This chat session's sessions |

### Input and output

`command` runs as `$shell -c command` on a pseudo-terminal (`TERM=xterm-256color`, `PAGER=cat`). Output has escape sequences and control characters removed, CRLF is normalized, and a sequence cut by a chunk boundary is held back.

| Limit | Behavior |
|---|---|
| `maxChars` per read | Default 10 000, max 50 000; the reply says how many characters remain, and the next read returns the rest in order |
| Retained output per session | 256 000 characters; older output scrolls out and the next read says how much was lost |
| `write` input | At most 16 384 characters |

### Security model

`start` goes through the same approval path as `shell`. The prompt reads "Run interactive command" and says the process stays open for input.

| Check | Applies to `start` |
|---|---|
| Permission | Name is `bash`; patterns come from the command's segments, so `permission: { shell: { "git *": "allow" } }` and deny rules apply |
| Paths | The same `external_directory` check covers `workdir` and paths in the command |
| Smart mode | Classifies it with the shell rules |
| Identity | The executable and script are bound for the identity check |
| Environment | The `shell.env` hook supplies it |
| Refusals | Plan mode, workflow policies (read-only, no mutating commands) and a global `tools.shell = false` refuse it |

Other actions (`write`, `read`, `resize`, `signal`, `kill`, `list`) are `read`-class. They only reach a session this chat started and approved.

**Warning:** A write cannot be matched against rules. A **bare interactive shell** (`bash`, `sh`, `zsh`... with no script or `-c`, also behind `sudo`/`env`/`exec`) is refused because its commands would skip the shell rules. Run each command with `shell`.

A REPL such as `python3` is allowed once approved, as approving `python3 -c` would be. The approval shows exactly what was started.

### Ownership and lifetime

A session belongs to the chat session that created it. Others cannot read, write, resize, signal, kill or list it.

The registry is separate from the PTY HTTP service: no route, ticket, remote client or peer tool reaches it. Nothing is added to `READ_ONLY_COMMANDS`; output enters the chat event stream only as tool results, secret-masked like any other.

A session runs until it ends or is stopped. It is killed when the chat session is deleted, its project is disposed or the daemon stops.

| Limit | Behavior |
|---|---|
| `processLimits.idleMinutes` | Optional cap when nobody touched the session with a tool call; 0 or unset means no cap |
| `processLimits.lifetimeMinutes` | Optional lifetime cap; 0 or unset means no cap |
| Running sessions | At most 4 per chat and 8 in total |
| Finished sessions | Stay readable; 16 kept |

The sweep timer exists only while a session is running. The daemon does not evict a chat session from memory while it has a running session.

### Background commands

`shell` with `background: true` follows the same rule: no cap by default, and `processLimits.lifetimeMinutes` stops one that runs longer.

Compaction keeps background commands: the registry lives in the daemon, and the summary lists running ones with their ids. `shell_output` and `shell_kill` stay listed while the chat owns any. A daemon restart still ends them.

### Availability and transcript

The tool is available on macOS and Linux under Bun (`Bun.Terminal`, no new dependency). Elsewhere it is not offered and `shell` remains. Start failures return a tool error, never throw.

The transcript card follows the `shell_output` card: head `Session <action> <command or id>`, live tail while running,
`ctrl+o` expands. The tool is listed with the core tools of `tool_search`.

`ctrl-c` is delivered as `SIGINT` to the process group (the Bun terminal has no foreground job for a keypress).

## `sleep`

`sleep { ms, reason? }` waits 1-300 000 ms without a command. A turn cancel ends it immediately. It is `read` class and needs no approval.

Prefer `shell_output` when waiting for a background task:

| Option | Waits for |
|---|---|
| `waitMs` | The task's output |
| `until: "exit"` | Its end, whatever it prints; default 120 s, at most 600 s, the limits of a foreground `shell`. An exit read this way is not announced again |

### Background notices

When a background task ends, the session gets a notice and the model answers it. `shell_monitor` notices are delivered the same way. Tasks that ended together are one notice.

| Session or turn state | Notice delivery |
|---|---|
| Turn running | Right after its next tool result, at its next model call; the notice appears in the transcript then, with no polling or sleeping needed |
| Turn already writing its answer | The turn ends first; the notice then starts its own turn |
| Engine cannot take a message mid-turn (Claude Code, Codex, ACP), compaction or paused session | The notice starts its own turn |

A notice never interrupts a tool or model call. Until read, it shows in the queue box.

After you cancel a turn, the session is stopped. Notices wait instead of starting turns on their own; the chat shows one line (`2 background results ·
sent with your next message`). Your next message carries them in one turn.

| Key | Does |
|---|---|
| `ctrl+s` | Send the waiting notices now |
| `ctrl+k` | Drop the last one |

A message from another session is not folded this way; it keeps its own turn.

## `shell_monitor` (push-style monitor)

Use `shell_monitor { id, match?, stop? }` to watch a background task from `shell` with `background: true`. Matching output lines arrive as notices while the task runs.

| Matching and batching | Limit |
|---|---|
| `match` | Case-insensitive substring; at most 8 texts of 100 characters |
| Patterns | No regular expressions, so a model-written pattern cannot stall the daemon |
| Batches | 2 s, 20 lines per notice, 300 characters per line |

A monitor starts from the moment it is set; earlier output is not replayed. It ends:

- When the task exits; waiting lines are flushed before the exit notice.
- When `stop` is set.
- After 30 notices; the last one says so.

A task stopped by the agent or by cleanup sends nothing more. The tool is `read` class: it only observes a command approved when it started, for the session that owns it.

## `notebook_edit`

Use `notebook_edit { path, action, cellId?, cellIndex?, cellType?, source? }` to edit a `.ipynb` by cell.

| Action | Does |
|---|---|
| `replace` | Replace a cell's source and optionally its type |
| `insert` | Insert after `cellId`, at `cellIndex` or at the end; nbformat 4.5 notebooks get a cell id |
| `delete` | Delete a cell |

Replacing a code cell clears its outputs and execution count. Everything else, including metadata and other cells' outputs, is preserved. JSON is rewritten with Jupyter's one-space indent.

The permission is `write` under the `edit` family. Edit rules, plan mode, smart mode path checks and the per-turn undo snapshot all apply; the approval shows what would change. Notebooks over 20 MiB are refused.

## `shell` output

A foreground `shell` call writes output to temporary files while the command runs, so the daemon does not keep it in memory. The model reads the head and tail of long output; the middle is dropped from what is kept in memory.

| Limit | Result |
|---|---|
| More than 256 MB to one stream | Command stops; reply ends with `[stopped: more than 256 MB of output]` |
| Timeout: 120 seconds by default, at most 600 | Command ends with `[timed out after … ms]` |
| Still running after 15 seconds | Command moves to the background (see below) |

### A slow command does not hold the model

A model's `shell` command still running after 15 seconds moves to the background with what it printed so far. The model gets control back at once and the reply names the task id.

- It can keep working, wait for the task with `shell_output` and `until: "exit"`, or stop it with `shell_kill`.
- Once moved, it may run up to 30 minutes, so a long build or toolchain download is not cut at 10. A timeout the model set below 600 seconds still applies. It also stops when the turn is cancelled, with no exit notice.
- The turn does not end while it runs. If the model answers before it ends, a "waiting for …" card shows while the turn waits. The model then gets how it ended and its output, and answers again. A scripted run (`mendcode run`) or a workflow task therefore never finishes before the command does.
- A command you type yourself (`!command`) and a command started with `background: true` do not use this. When eight background tasks already run, the command stays in the foreground.

## Not done: model-callable worktree enter/exit (K85)

A chat session's directory is fixed at creation. Permission roots, undo snapshots, project instructions and the session list are keyed on it.

Switching it mid-session is the same change as an in-session `/cd` (K23) and belongs with it. Existing worktree flows (`/worktrees`, loops, workflows) are unchanged.

## Implementation and tests

None of these tools adds a startup process, a route, a protocol command or CLI startup code. The tools live in `packages/tools`; the registry behind `shell_session` lives in `packages/daemon/src/interactive-processes.ts`.

| Test | Coverage |
|---|---|
| `packages/daemon/test/interactive-processes.test.ts` | Real PTY, a tiny Bun line-reader in a temp directory, no network |
| `packages/engine-native/test/shell-session-permission.test.ts` | Approval path |
| `packages/tools/test/monitor.test.ts` | Monitor |
| `packages/tools/test/sleep-notebook.test.ts` | Sleep and notebook |
| `apps/cli/test/tool-card-sessions.test.ts` | Session tool cards |
