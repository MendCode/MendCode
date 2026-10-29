# Interactive and model-tool additions (B4)

Model-callable tools that sit next to `shell`, `shell_output` and `shell_kill`. None of them adds a startup process,
a route, a protocol command or CLI startup code: the tools live in `packages/tools`, the registry behind
`shell_session` in `packages/daemon/src/interactive-processes.ts`.

## `shell_session` (interactive process on a PTY)

For programs that need stdin or a TTY: scaffolders that ask questions, REPLs, debuggers, `ssh`, TUIs. One tool, one
`action` argument:

| Action | Arguments | Result |
| --- | --- | --- |
| `start` | `command`, `workdir?`, `cols?`, `rows?`, `waitMs?` (default 1000), `maxChars?` | Session id plus the first output |
| `write` | `id`, `input`, `waitMs?` (default 500), `maxChars?` | Waits for the reply to settle, returns it |
| `read` | `id`, `waitMs?` (default 0, max 30000), `maxChars?` | Output since the last read |
| `resize` | `id`, `cols`, `rows` (1-1000) | Real PTY resize |
| `signal` | `id`, `INT` (ctrl-c), `EOF` (ctrl-d), `TERM`, `HUP`, `QUIT`, `KILL` | Signals the process group, then reads |
| `kill` | `id` | SIGTERM, SIGKILL after 2 s |
| `list` | none | This chat session's sessions |

`command` runs as `$shell -c command` on a pseudo-terminal (`TERM=xterm-256color`, `PAGER=cat`). Output has escape
sequences and control characters removed, CRLF is normalized, and a sequence cut by a chunk boundary is held back.
A read returns at most `maxChars` (default 10 000, max 50 000) and says how many characters remain; the rest comes with
the next read, in order. 256 000 characters are retained per session; older output scrolls out and the next read says
how much was lost. `write` input is at most 16 384 characters. `\n` presses enter.

### Security model

- **Approval.** A `start` goes through the same path as `shell`: the permission name is `bash`, patterns come from the
  command's segments (so `permission: { shell: { "git *": "allow" } }` and deny rules apply), the same
  `external_directory` check covers `workdir` and paths in the command, smart mode classifies it with the shell rules,
  the executable and script are bound for the identity check, the `shell.env` hook supplies the environment, and plan
  mode, workflow policies (read-only, no mutating commands) and a global `tools.shell = false` refuse it. The approval
  prompt reads "Run interactive command" and says the process stays open for input.
- **Other actions** (`write`, `read`, `resize`, `signal`, `kill`, `list`) are `read`-class: they only reach a session this
  chat started and approved. A write cannot be matched against rules, so a **bare interactive shell** (`bash`, `sh`,
  `zsh`... with no script or `-c`, also behind `sudo`/`env`/`exec`) is refused: its commands would skip the shell
  rules. Run each command with `shell`. A REPL such as `python3` is allowed once approved, as approving `python3 -c`
  would be; the approval shows exactly what was started.
- **Ownership.** A session belongs to the chat session that created it. Others cannot read, write, resize, signal, kill
  or list it. The registry is separate from the PTY HTTP service: no route, ticket, remote client or peer tool reaches
  it, nothing is added to `READ_ONLY_COMMANDS`, and its output is not part of the chat event stream except as tool
  results (which are secret-masked like any other).
- **Lifetime.** Killed when the chat session is deleted, when its project is disposed, and when the daemon stops. A
  session nobody touched (any tool call on it) for 15 minutes is stopped; any session is stopped after 2 hours. At most
  4 running sessions per chat and 8 in total. Finished sessions stay readable (16 kept). The idle sweep timer exists only
  while a session is running. The daemon does not evict a chat session from memory while it has a running session.
- **Availability.** macOS and Linux under Bun (`Bun.Terminal`, no new dependency). Elsewhere the tool is not offered and
  `shell` remains. Start failures return a tool error, never throw.

The transcript card follows the `shell_output` card: head `Session <action> <command or id>`, live tail while running,
`ctrl+o` expands. The tool is listed with the core tools of `tool_search`.

`ctrl-c` is delivered as `SIGINT` to the process group (the Bun terminal has no foreground job for a keypress).

## `sleep`

`sleep { ms, reason? }` waits 1-300 000 ms without a command; a turn cancel ends it immediately. `read` class, no
approval. Prefer `shell_output` with `waitMs` when waiting for a background task's output, and `until: "exit"` (default 120 s, at most 600 s, the limits of a foreground `shell`) to wait for its end whatever it prints; an exit read that way is not announced again.

When a background task ends, the session gets a notice and the model answers it. A turn that is running reads it right
after its next tool result, at its next model call: the notice appears in the transcript at that point and the model
does not have to poll or sleep for it. It never interrupts a tool or a model call, and tasks that ended together are one
notice. A turn already writing its answer ends first and the notice then starts a turn of its own; so does a turn of an
engine that cannot take a message mid-turn (Claude Code, Codex, ACP), a compaction and a paused session. Until it is
read it shows in the queue box. `shell_monitor` notices are delivered the same way. After you cancel a turn the session is
stopped, so those notices wait instead of starting turns on their own: the chat shows one line (`2 background results ·
sent with your next message`), and your next message carries them, in one turn. `ctrl+s` sends them now, `ctrl+k` drops
the last one. A message from another session is not folded this way; it keeps its own turn.

## `shell_monitor` (push-style monitor)

`shell_monitor { id, match?, stop? }` watches a background task from `shell` with `background: true`. While the task
runs, output lines containing any `match` text (case-insensitive substring, at most 8 texts of 100 characters; no
regular expressions, so a model-written pattern cannot stall the daemon) are delivered to the session as a notice, in
batches (2 s, 20 lines per notice, 300 characters per line). A monitor starts from the moment it is set (earlier output
is not replayed), ends when the task exits (waiting lines are flushed before the exit notice), when `stop` is set, or
after 30 notices (the last one says so). A task stopped by the agent or by cleanup sends nothing more. `read` class: it
only observes a command that was approved when it started, for the session that owns it.

## `notebook_edit`

`notebook_edit { path, action, cellId?, cellIndex?, cellType?, source? }` edits a `.ipynb` by cell: `replace` a cell's
source (and optionally its type), `insert` (after `cellId`, at `cellIndex`, or at the end; nbformat 4.5 notebooks get a
cell id) or `delete`. Replacing a code cell clears its outputs and execution count; everything else, including
metadata and other cells' outputs, is preserved (JSON rewritten with Jupyter's one-space indent). Permission `write`
under the `edit` family: edit rules, plan mode, smart mode path checks and the per-turn undo snapshot all apply, and the
approval shows what would change. Notebooks over 20 MiB are refused.

## Not done: model-callable worktree enter/exit (K85)

A chat session's directory is fixed at creation (permission roots, undo snapshots, project instructions and the
session list are keyed on it). Switching it mid-session is the same change as an in-session `/cd` (K23) and belongs
with it; the existing worktree flows (`/worktrees`, loops, workflows) are unchanged.

Tests: `packages/daemon/test/interactive-processes.test.ts` (real PTY, a tiny Bun line-reader in a temp directory, no
network), `packages/engine-native/test/shell-session-permission.test.ts` (approval path), `packages/tools/test/monitor.test.ts`,
`packages/tools/test/sleep-notebook.test.ts`, `apps/cli/test/tool-card-sessions.test.ts`.
