# Automation CLI

GitHub install/run and PR checkout: [GitHub automation](github.md). Workflows, publication and tool approvals are opt-in; GitHub commands require a local daemon.

`mendcode` exposes the daemon to scripts, CI and VPS jobs. Daemon commands connect to the running daemon (starting one if needed), do one thing and exit. Local support commands and [uninstall](uninstall.md) run before any connection.

Common flags: `--dir D` (daemon data directory), `--json` (alias `--format json`), `--help`.

`cache status|enable|on|disable|off` controls passive prompt-cache policies. See [scopes, exact-model selectors and
configuration layers](prompt-cache.md#scoped-policy-b49). `--global` edits the daemon data directory's policy; otherwise
the mutation is project-local. Status never makes provider calls; no keepalive is scheduled.

Plugin compatibility: `plugin <module>` / `plug <module>` accept `--global/-g` and `--force/-f`. NPM installs
are offline, pinned and skip scripts. `plugin-auth` lists registered methods; `plugin-auth <provider> [index]`
runs the selected method with hidden secret input. Global `--pure` starts without external extensions and
requires an already running daemon to be pure too; select a separate `--dir` or `--isolated` when needed.
`[control-plane] tsm` provides status, dry-run install/setup plans, opt-in
activation, deactivation, scaffold recycling, doctor and worktree previews.
See [TSM](tsm.md) for commands, defaults and executable requirements.

## Reference cards (`mendcode docs`)

`mendcode docs` lists the topics and `mendcode docs <topic>` prints one card: plain text, under about 2,500 characters, embedded in the binary and loaded only when `docs` runs (the cards are not part of the startup graph). Topics include `settings`, `theme`, `keys`, `key-actions`, `footer`, `extensions`, `commands`, `tools`, `skills`, `agents`, `hooks`, `mcp`, `packages`, `models`, `permissions`, `tiers`, `prompt-modes`, `budgets` and `customize`; a few have aliases (`themes`, `keybindings`, `statusline`). Under the card, a "On this machine now" block lists what is true here: the theme in force, theme and extension files, the user's keybindings, installed folders, and, only when a daemon already runs, the daemon's settings. The command never starts a daemon and never writes; with no daemon the card prints without the settings lines. `--dir` / `--data-dir` select the data directory like every command. An unknown topic prints one line and the topic list to stderr and exits 2; a usage error exits 64. `mendcode docs commands` also lists the built-in slash commands this install offers (its tier, grouped as the menu groups them), what `<data dir>/tui/profile.json` hides, pins, moves or aliases, the user's own commands and what the next tier adds; `mendcode docs commands <name>` prints one command (a second word is accepted by that topic only, and smart permission mode runs it without asking like the bare card).

The cards are authored in `packages/daemon/cards/*.md` and compiled with the docs they stand on into `packages/daemon/cards/cards.generated.json` by `bun scripts/self-knowledge.ts` (`--check` verifies only; it also fails when a doc a card lists changes). The generator refuses a card that names a slash command, setting or doc the repository does not have. In smart permission mode `mendcode docs [topic]` runs without asking, but only alone on its line with one plain topic word; pipes, redirections, other subcommands and expansions ask as usual.

## Local support commands (B18)

`--help`/`-h`, `--version`/`-v` and `completion [bash|zsh]` exit without a daemon. Source the generated completion script in the matching shell.
`--print-logs` sends CLI diagnostics to stderr; `--log-level DEBUG|INFO|WARN|ERROR` filters them and is forwarded to a newly launched daemon.
`--approve` trusts the current project (its hooks, tools and extensions, see [hooks](hooks.md)) before anything runs; `--no-approve` skips the startup trust prompt. `--approve` needs a local daemon.
`--trace` enables local content-free correlated diagnostics; see [Tracing](tracing.md) for the opt-in OpenTelemetry setting and loopback collector.
An already running daemon keeps its own logging configuration. `settings.set { logLevel }` persists its level in the data directory's database and applies immediately; an explicit daemon startup level takes precedence.

```bash
mendcode context <sessionID> [--limit 20] [--json]
mendcode status|doctor [--json]
mendcode control-plane ai status|env [status]
mendcode control-plane system status|doctor|check|toolchain|config-paths|config-layers|adapter-status
mendcode debug rg tree|files [--query TEXT] [--glob PATTERN]… [--limit N]
mendcode debug rg search PATTERN [--glob PATTERN]… [--limit N]
mendcode generate
```

`context` opens with the session's limits (model, context window, compaction point and current tokens, each with its source; `limits` in JSON, see [compaction](compaction.md)), then inspects 1–100 recent calls (default 20), excluding undone turns. Native calls persist text estimates, first-token/request timing, tool/image counts and provider cache counters. Older calls and external engines can report usage without estimates/timing. Image token costs are not guessed. Provider input includes uncached input plus cache read/write, with cache hit rate computed from that total. JSON uses the existing CLI envelope.

System reports describe the v2 daemon, its actual data/config paths, writer lock, socket and adapter binaries. Doctor/check/toolchain return exit 1 for failed required checks. AI reports show model roles, credential readiness and environment **presence**, without environment values, masked key tails or provider calls. Subscription readiness is unavailable when no local login probe exists. These reports do not audit v1 donor checkouts.

Debug search runs in the daemon's project directory, honours ripgrep ignore rules and bounds results to 128 KB and five seconds; a bounded local walker works when `rg` is absent. `--limit` accepts 1–10,000; globs are repeatable or space separated. `--query` filters file paths case insensitively. Recognized credentials are redacted; content search is unavailable to read-only remote peers. JSON includes `truncated` when a bound is reached.

`generate` emits the v2 newline-JSON protocol's JSON Schema. The daemon never sends it as one frame: `system.query generate` answers with an entry index, per-entry schemas (`entry`, e.g. `command:tui.query`, with only the definitions it references) and byte-bounded pages (`page`), each far below the 256 KB frame, so adding commands cannot break it and no compaction is needed. The CLI fetches the pages and reassembles the exact schema; `generate --index` lists entries and sizes, `generate --entry command:tui.query` prints one command's schema. The new `system.query` fields (`entry`, `page`, `index`) are optional and additive. `generate --httpapi` prints the OpenAPI 3.1 contract of the opt-in B34 HTTP adapter (the same document served at `/doc` and `/openapi.json`) offline: no daemon, listener, token or data directory is touched. Plain output is the bare document for redirecting to a file; `--json` wraps it in the usual result envelope. The unused Hono option has been withdrawn from help and completions; legacy `--hono` is a usage error (exit 64) before opening storage. See [remote attach](remote.md).

`bun scripts/render-frames.ts .agents-frames/B18 --b18 100x30 180x50` records local-fake support output and actual app-harness diagnostics frames.

## Headless and startup parity (B16)

`run [MESSAGE…]` combines positional text with piped stdin. Without a message, stdin is the prompt and is read to its end. With a message, stdin is optional: `run` waits 1 second for its first byte, then reads everything to the end however large or slow (`echo text | mendcode run "question"`, `git diff | mendcode run "review"`); a stdin that stays silent for that second (a parent that hands down an open pipe and never writes or closes it) is skipped with a note on stderr instead of blocking the run forever. A pipe cannot say whether its writer will ever write, so time is the only signal; add a bare `-` (`slow-command | mendcode run "question" -`) to wait for stdin to end whatever it takes. `--command NAME` expands a Markdown or extension command with that text as its arguments. `--file PATH…` (also `-f`) includes small UTF-8 files, supported images, or a non-recursive directory listing; paths resolve in the selected session project. `--file` takes the existing paths that follow it, and the first argument that is not an existing file or directory starts the message, so `run --file a.png "describe it"`, `run --file a b c "compare"` and `run "describe it" --file a.png` all work. The value right after `--file` is always an attachment: one that does not exist fails with `[ATTACHMENT]: not a file or directory`. The check runs in the project the command names (`--cwd`/`--project`, else the shell's directory); with `--session` of another directory, put the message first or use absolute paths. Existing limits remain: 200 KiB text, 20 MiB images, 32 attachments; directory listings stop at 1,000 entries. Remote attachments are disabled.

`--model provider/model` (`-m`), `--agent NAME`, `--variant NAME` and `--effort LEVEL` select the session's next execution using the daemon catalog and primary-agent validation. `--variant` names a provider variant; `--effort minimal|low|medium|high|xhigh` (or `-c effort=LEVEL`) sets the reasoning effort and must be one of the model's own levels, otherwise the run stops with a usage error listing them (see [providers](providers.md#reasoning-effort-from-the-command-line)). `--continue` (`-c`) resumes the latest root worked in for the project (empty chats and ones holding only an unsent draft are skipped); `--session ID` (`-s`) takes precedence. The ID may be lowercase, lack `ses_`, be a piece of the id (its start or end, 4 characters or more) or carry a stray character or two typed after it: it opens the one session it fits, and none or several stops with `no session …` or `fits N sessions` (the newest 500 sessions are searched). A command the daemon refuses says `it may be an older build` only when the daemon is another build; the same build names the invalid field instead. `--fork` requires one of those and copies the transcript into a new session before changes. `--title [TEXT]` names a new session or fork; a bare flag uses the first 50 prompt characters.

`--format default|json` preserves the existing raw-event JSON stream. `--thinking` reveals streamed reasoning in text output; it is hidden by default. `--approve` approves pending tool approvals once; `--dangerously-skip-permissions` does the same and also approves a command that Claude Code itself flagged as dangerous in `full` access (see [permissions](permissions.md#commands-the-engine-flags-in-full-access)). That class is the one difference: with `--approve` alone the call is rejected (`headless run: the engine flagged this command as dangerous and --approve does not cover that…` goes to the model as the tool result and `? … → denied` to stderr), nothing runs, and the turn continues, so the exit code is the turn's usual one from the table below (`0` when it completes). Unanswered questions are denied, and explicit agent/policy denials still win. `session send` takes both flags the same way. Without `--approve`, an approval request is denied (`? … → denied (pass --approve to allow)` on stderr) and the turn goes on; when it then completes with no tool call succeeding after the last such denial, the command exits `5` instead of `0`, so a script can tell a blocked turn from a finished one. A turn where the model went on to run something else successfully, or where the approvals were granted, keeps its usual code.

`--cwd PROJECT` or `--project PROJECT` selects the project; `--dir DATA` / `--data-dir DATA` selects daemon storage for `run` and TUI startup. `acp --cwd PROJECT` sets the fallback directory when the editor omits its own cwd. In B34's `attach URL` command, `--dir PROJECT` instead selects a registered server project; `--data-dir DATA` retains its storage meaning. `--share` remains unavailable without a sharing service. HTTP Basic `--password`/`--username` are scoped to HTTP URL attach; `--port` belongs to `serve`/`web`.

`app-server [--cwd PROJECT]` is a JSON-RPC server on stdio (threads, turns, approvals, resume) for third-party UIs, shaped like Codex's app-server; local-only. See [Embedding](embedding.md).

## Background sessions (B17)

`run --bg [MESSAGE…]` creates or continues the session as usual, hands the turn to the daemon and returns at once with
the session id (`--json`: `{"sessionId","status":"started"}`). It cannot combine with `--approve`,
`--dangerously-skip-permissions`, `--thinking`, `--ephemeral`, `--output-schema` or `-o`: nobody is attached to answer
an approval, so the turn waits for `attach`; use `--permission` to choose the mode up front. Follow it with shorthands
over `session`: `ps` (= `session list --active`, `--all-projects` for every project), `logs ID [-f]` (= `session
events ID [--follow]`), `kill ID` (= `session cancel ID`) and `attach ID` (opens the TUI on that session).

## Scripting flags for `run` (B2)

For CI and scripts. Every flag below belongs to `run`, except `--offline`, which is global.

```bash
mendcode run "list the TODOs" --output-schema todos.json -o todos.out.json --max-turns 12 --tools read,grep,glob --offline
echo "summarize the diff" | mendcode run --ephemeral --tools read,grep --exclude-tools shell
```

| Flag | Effect |
|---|---|
| `--add-dir PATH` | Repeatable (also on the TUI). Treats an existing directory as part of the workspace for this session: no external-directory ask, writable in the sandbox. Local only; see [permissions.md](permissions.md#extra-directories). |
| `--output-schema FILE` | The final answer must be one JSON document valid for the schema (a fenced block is accepted). The schema is added to the session's system prompt. stdout carries only the validated JSON (compact), nothing streams. A mismatch prints one line per problem on stderr and exits 3. |
| `-o`, `--output-last-message FILE` | Writes the final message of a completed run to FILE (parent folders are created). With a schema the validated JSON is written, and nothing is written when validation fails or the turn does not complete. Output still goes to stdout unless a schema is set. |
| `--ephemeral` | Creates a new session and deletes it when the run ends (also after a failure). A kill or crash can leave it behind. It cannot combine with `--continue`, `--session` or `--fork`. |
| `--max-turns N` | Stops the turn after N model calls (1 to 1000). The turn fails with code `max_steps` and exit 4. The cap only lowers the daemon's own limit. |
| `--tools a,b` / `--no-tools` | Allow-list: only these tools (globs such as `mcp__*` work) are offered and callable. It intersects with what the agent and permission rules already allow, so it narrows and never grants. Sub-agents (`task`) are off in a restricted run, and plan-mode tools disappear with an allow-list. Names that match nothing are ignored. |
| `--exclude-tools a,b` | Removes tools from whatever is allowed. Combines with `--tools`. |
| `--offline` | Global flag. Removes the tools that reach the network on their own (`webfetch`, `websearch`, `image_gen`) from the session started by this invocation, for `run` and the TUI. It does not block model provider calls, MCP servers or commands the model runs in `shell`. |
| `--system-prompt TEXT` / `--append-system-prompt TEXT` | Replaces, or extends, the project's system prompt for this run's session. |
| `--permission ask\|edits\|plan\|smart` | Starts the run in that permission mode. `full` is not accepted here. |
| `-c`, `--config KEY=VALUE` | Per-run override, repeatable. `-c` followed by `KEY=VALUE` is a config override; a bare `-c` stays `--continue`. Supported keys (dashes or underscores): `model`, `agent`, `variant`, `permission`, `max_turns`, `tools`, `exclude_tools`, `system_prompt`, `append_system_prompt`, `output_schema`, `output_last_message`, `offline`, `ephemeral`, `thinking`. An explicit flag wins over its key. Other keys are a usage error: overrides never edit global settings. |
| stdin | A piped stdin is appended to the message arguments; `run -` with only stdin works too. |

These limits live in daemon memory for that session (`session.run.configure`) and vanish with it. A daemon that does not know the command fails the run instead of running unrestricted; restart it with `--restart-daemon`.

**Schema subset.** The validator is built in (no dependency). It supports `type` (a name or a list of `string`, `number`, `integer`, `boolean`, `null`, `object`, `array`), `required`, `properties`, `additionalProperties` (true or false), `items` (one schema), `enum`, `const`, boolean schemas, and ignores `$schema`, `$id`, `title`, `description`, `default`, `examples`, `$comment`. Any other keyword (`$ref`, `pattern`, `oneOf`, `minimum`, ...) makes the schema a usage error (exit 64), so a constraint is never silently skipped.

**Exit codes.** `0` completed, `1` failed (turn error, daemon error, unwritable `-o` file), `2` stopped (cancelled or interrupted), `3` answer rejected by `--output-schema`, `4` `--max-turns` reached, `5` the turn completed but an approval was denied for lack of `--approve` and nothing ran after it, `64` usage error (bad flag, unreadable or unsupported schema file) before any session exists. `--json` keeps streaming the raw event lines and uses the same exit codes; with `--compat` the `session.completed` line of an exit-5 turn carries `"approvalDenied": true`.

**Shell environment.** Every `shell` call gets `MENDCODE_SESSION_ID`, `MENDCODE_MODEL` and `MENDCODE_PROJECT_DIR`. Every command a session starts (`shell`, background, `shell_session`) also gets `MENDCODE_AGENT_SHELL` (the daemon's data directory) and, in `sh`, `bash`, `zsh`, `dash` and `ksh`, a hard file-size limit of 512 PiB: a `mendcode` started there reads, and is refused what only the user decides, `--approve` included ([permissions](permissions.md#what-a-session-cannot-do-from-its-own-shell)).

**Completions.** `completion bash|zsh|fish|powershell` (fish: `mendcode completion fish > ~/.config/fish/completions/mendcode.fish`; PowerShell: add `mendcode completion powershell | Out-String | Invoke-Expression` to the profile).

**`apply`.** `mendcode apply [SESSION_ID] [--to DIR] [--check] [--json]` writes the files a session changed (default: the project's latest session) onto another checkout. It is all or nothing: binary or cut-short diffs, files whose current content no longer matches the diff, paths outside the target and the session's own project are refused with nothing written. `--check` reports what would change.

## Standalone binary

`bun run build` produces `dist/mendcode` (`.exe` on Windows) for the host. Use `--outfile PATH` for another location,
or `--target darwin-arm64|darwin-x64|linux-x64|linux-arm64|windows-x64` to cross-compile. On a macOS build host the
script applies an ad-hoc signature to Darwin output; [release signing](release.md) uses cosign keyless, without notarization.
The executable contains both clients and daemon: the launcher re-executes `process.execPath __daemon --dir D`.
`__daemon` is internal; source launches retain `bun packages/daemon/src/main.ts`.

Packaged resources:

- Native system/compaction/continuation prompts and the three goal templates are embedded file imports; user/project overrides still read their explicit paths.
- Built-in `quick`, `balanced`, `deep` recipes are embedded (no skills ship built in; self-knowledge is `mendcode docs`), then materialized at `<dir>/builtin/<build-id>` for the folder loaders. Higher extension layers still win.
- Store SQL/DDL is already TypeScript string data; SQLite comes from Bun. No daemon worker entry points or native addons are loaded from the repository.
- The build ID is embedded at compilation, avoiding a source-tree scan in the installed executable.
- The CLI's lazy WebP decoder embeds its WASM file. User pets, packages, tools, themes, MCP/ACP configuration and project files remain runtime inputs; external `codex`, `claude`, language servers and other configured programs must be installed separately when used.

`bun run test:compiled` opts into the standalone smoke (excluded from the fast suite). It compiles to a temp directory,
runs with no Bun on PATH and no checkout in its cwd, tests explicit daemon mode and automatic launch, queries `daemon.info`,
checks packaged recipes/skills and all goal templates, runs the faux engine and starts a native daemon without a provider turn.
It shuts down every daemon and skips when host compilation is unavailable. CI sets `MENDCODE_REQUIRE_COMPILE=1`
to make unavailable compilation fail and `MENDCODE_TEST_BINARY=/absolute/path` to smoke the exact release artifact
instead of rebuilding it. Windows CI still exercises packaged CLI/upgrade help only; the Windows code paths below
(loopback transport, PowerShell, process-tree kill) are unit-tested on any host with injected platforms and have not
been verified on a Windows machine.

## Windows

- **Local transport.** On Windows the daemon listens on `127.0.0.1` with an OS-chosen port instead of `mendd.sock` (Bun
  has no verified named-pipe listener; named pipes are not used). It publishes `{port, secret, pid}` in
  `<dir>/mendd.endpoint` (owner-only, atomic) and removes it on stop. A client reads that file on every connect and sends
  the secret as its first frame; any other first frame, or a wrong secret, closes the connection with no echo. The
  connection is local (no peer, no read-only limit), so GitHub, clipboard and other local-data commands work as on a
  Unix socket. Elsewhere it is opt-in: `MENDCODE_V2_LOCAL_TRANSPORT=tcp` (or `--local-transport tcp` on the daemon);
  `unix` forces sockets on Windows. The launcher finds a running daemon on either transport. `--socket` still means a Unix
  socket attach. Anything that can read the daemon directory has full daemon authority, as with the socket.
- **Shell tool.** `shell`, background tasks and `!command` run in `pwsh`, else `powershell`, else `%ComSpec%`, unless the
  `shell` setting names another (`bash`/`sh` keep `-c`; `cmd` gets `/d /s /c`). PowerShell runs with `-NoLogo -NoProfile
  -NonInteractive`, UTF-8 output, and a native command's exit code is restored. Timeouts and cancel stop the whole tree
  with `taskkill /T` (no console window opens). POSIX hosts keep `/bin/sh -c`.
- **Interactive sessions (ConPTY).** Off on Windows by default: the model sees `shell` only. `MENDCODE_V2_CONPTY=1` offers
  `shell_session` and the terminal pane when the Bun runtime exposes `Bun.Terminal` there; that path is unverified.
- **Host limits.** Persistent user service activation is macOS/Linux only. Windows uses manual `daemon start|run`; Authenticode signing and a Windows CI daemon smoke are outside the local implementation checks.

## Commands

```bash
mendcode session list [--all] [--all-projects] [--max-count N] [--search TEXT]
mendcode session create [--title T] [--parent ID] [--agent A] [--model P/M] [--variant V] [--effort LEVEL]
mendcode session get|status|inspect|export <id>
mendcode session rename <id> <title...>
mendcode session fork <id> [--message-id ITEM]
mendcode session delete <id>
mendcode session send <id> "text" [--async|--wait] [--approve|--dangerously-skip-permissions] [--timeout-ms MS]
mendcode session wait <id> [--timeout-ms MS] [--interval-ms MS]
mendcode session events <id> [--after SEQ] [--follow] [--keep-open] [--limit N]
mendcode session cancel <id>
mendcode session pause|resume|stop <id>
mendcode session archive <id> [--restore]
mendcode session list [--archived]             # include archived sessions

mendcode memory list [--status saved|pending|archived]
mendcode memory add [--user] [--category C] "text"
mendcode memory search "query" [--limit N]

mendcode backlog [list]                        # this directory's project backlog, open items first
mendcode backlog add [--file PATH] [--commit SHA] [--session ID] "text"
mendcode backlog done|reopen|remove <id>
mendcode backlog clear                         # removes the finished items

mendcode loop list [--all]
mendcode loop create [--every 1h | --daily 09:00] [--now] [--goal [--check "cmd"]… [--no-audit]] [--runs N] [--name N] [--criteria C] "objective"
mendcode loop pause|resume|stop|run|delete <id>
mendcode loops status [--all]
mendcode loops examples|templates
mendcode loops draft [NAME OBJECTIVE] [--template ID] [--name N] [--objective O] [--interval-ms N | --daily-at HH:MM --timezone Z]
mendcode loops show|tail|monitor <id> [--limit N | --once --interval-ms N]
mendcode loops tick [id] [--limit N] [--execute] [--report-only]
mendcode loops activate <id> [--reason TEXT] [--no-service]

mendcode workflow list [--all]
mendcode workflow preview <file.json|name>
mendcode workflow start <file.json|name> [--permission ask|edits|full] [--yes] [--wait [--timeout S]]
mendcode workflow show <id>
mendcode workflow pause|resume|stop|verify|delete <id>
mendcode workflow retry <id> --task <taskId>
mendcode workflow approve|reject <id> --task <taskId> [--reason TEXT]   # answer a human task or gate
mendcode workflow accept <id> --reason "why it is done"

mendcode profile [list]
mendcode profile add <name> <folder>... [--permission ask|edits|full]
mendcode profile remove <name>
mendcode recipe list
mendcode recipe apply <name>

mendcode usage [--days N]
mendcode run [--json] [--approve] [--session ID] "prompt"
mendcode export <id> [--json] [--reasoning]
mendcode help
```

- `session list` shows root sessions of the current directory. `--all` includes children; `--all-projects` spans projects. Filters: `--project PATH` (v2 projects are directories), `--state` (foreground or derived state), `--active`, `--since MS`, `--search TEXT`, `--agent A`, `--model provider/model`; `--max-count N`/`-n` aliases `--limit N` (1–500). Filters precede the limit; title search is literal and case insensitive.
- For session commands, `--dir PROJECT` after `session` targets a project; a prefix `--dir DATA` retains v2's daemon storage selection. `--data-dir DATA` also selects storage, regardless of position. Example: `mendcode --dir /tmp/data session create --dir /work/repo --title Review`.
- `session create` accepts `--parent ID`, `--agent A`, `--model provider/model` (or a catalog ID), `--variant V` and `--effort LEVEL`. Unknown parents and invalid selections fail before creation.
- `session stats ID [--json]` reports how the session spent its time and tokens: every turn's real start, end and status, active time per day and per hour (a turn's time and usage are split over the hours it ran; the last 72 active hours are listed), usage per provider and model, ended turns with no recorded usage (unknown, not zero) and turns whose usage is the sum of the calls the engine reported before it stopped (`partial`), Claude Code sub-agent runs with their tool calls, tokens and time, tool calls by name with errors, child sessions' usage, and time spent waiting on approvals. The native `threads` tool has the same report as `action: "stats"` (no `sessionId` = the current session; no approval, since it holds no message text).
- `session get ID` reads metadata. `inspect ID [--limit N]` and `status ID` include progress, visible conversation turns, children, subagents, loops, pending questions/approvals and file changes. The derived state (`State:` line, `status` in JSON, `--state` of `session list`) is `idle`, `running`, `waiting_for_input`, `waiting_for_approval`, `completed`, `failed`, `cancelled` (a deliberate cancel) or `interrupted` (the daemon lost the turn: restart, transport or a stalled stream; daemons before this change reported it as `cancelled`). Treat a value you do not know as "not running". `export ID` uses that snapshot with as much history as fits the wire limit. These reads redact older secret-bearing text and metadata and expose `truncated` when bounded. Conversation views omit reasoning; event snapshots retain the sanitized event log. Full transcript Markdown/JSON export remains available with the top-level `export` command.
- `session rename ID TITLE…`, `fork ID [--message-id ITEM]`, and `delete ID` reuse the daemon lifecycle. CLI forks carry the finished transcript and model history; `--message-id` forks before a user message (excludes its turn) or an assistant message (keeps the prompt and earlier steps). A native assistant message without a recorded history boundary is cut at its own model message when the turn's answers pair one to one with the stored history; compacted or unpairable ones are refused. Forks of Claude Code or ACP sessions cut the transcript the same way and carry it to the external engine on its first turn (up to 60,000 characters, newest kept; see [claude-code.md](claude-code.md)). Deleting a busy session is refused.
- `session send ID [TEXT…]` streams its own turn and waits by default; `--async` returns the queued ID and the daemon continues independently. `--wait` overrides `--async`; `--interval-ms` optionally reconciles missed events. Approvals follow `--approve` (denied otherwise; a waited turn that ends with such a denial and nothing run after it exits `5`, and its `--json` result has `status: "denied"` and `approvalDenied: true`). `--mode auto|queue|steer|restart` picks how the message meets a running turn (see [sessions.md](sessions.md#managing-the-queue-any-terminal)); `auto` and `steer` join the running turn, return `steered` at once and cannot `--wait`; `--request-id ID` makes a retry return the first answer instead of sending twice. `--model`, `--agent` and `--variant` override that queued turn only, survive restarts and preserve saved selections. Overrides also work on Claude Code and ACP sessions and models (`--variant` there must name an effort of a Claude model; ACP has none; a MendCode agent is a permission ceiling plus instructions, see [claude-code.md](claude-code.md)); only a daemon whose engine fixes its own model (Codex, faux) refuses them. `--file PATH` is repeatable (UTF-8 text or supported image, up to 32); `--command NAME` executes a saved or extension command with its agent/model/subtask attributes in the session's project. Subtasks stream and resolve approvals in the actual child; `--async` includes its task id. See [commands.md](commands.md). Files are resolved from the CLI project directory and disabled on remote attach; no client-side provider or process execution is used.
- `session wait` returns after completion, failure, cancellation or interruption and queue drainage. A fresh idle session has no terminal result and waits. `--idle` retains the earlier v2 idle check. `--timeout-ms MS` uses milliseconds; `--timeout S` remains seconds (mutually exclusive). Default wait timeout is 30 minutes. Pushes drive the wait; optional `--interval-ms MS` reconciles with a bounded snapshot. Exit codes: completed 0, failed 1, cancelled or interrupted 2 (the status word and the error line say which), timeout 3.
- `session events` prints persisted history after `--after`. `--follow` exits on a live idle event; `--keep-open` keeps following until Ctrl-C. `--limit N` caps printed events.
- `session archive ID [--restore]` changes visibility without removing history. Lists hide archived sessions unless `--archived`; JSON metadata includes `archivedAt` while archived. Exact v1 JSON payload compatibility remains undecided; the v2 schema and opt-in envelope alias below stay authoritative.
- `session cancel` cancels the active turn, if any (it is not an error when there is none).
- `session pause ID` lets the running turn finish and starts nothing new until `session resume ID` (which also releases a cancel hold). `session stop ID` cancels the running turn and its running sub-agents, then holds the queue. Local or full-access remote only. See [agents.md](agents.md#agent-control-pause-resume-stop).
- `memory add` saves to the project of the current directory, or to the user scope with `--user`.
- `loop create` needs a trigger: `--every 30m|1h|2d`, `--daily HH:MM` or `--now` (manual, starts immediately). `--goal` stops when a run reports the goal complete (`--runs N` caps it); `--runs N` alone runs exactly N times; otherwise the loop repeats until stopped.
- `loop create --goal --check "bun test"` runs the check (repeatable, up to 5) before the independent audit; `--no-audit` keeps only the checks.
- `loop`, `loops` and `control-plane loops` share the same commands. No subcommand means `status`. Drafts stay paused across restarts and cannot run until activated (or resumed). `activate` is idempotent outside drafts; interval/adaptive drafts wake immediately, daily drafts wait for their next window, manual drafts wait for `run`/`tick ID`. The scheduler is the running v2 daemon; `--no-service` is accepted for v1 scripts, and neither spelling installs an OS service (B68).
- `show` includes objective, budget, scheduler, run history, children and the last 50 journal events. `tail --limit N` reads 1–200 persisted events (default 50); `--json` emits one event per line. `monitor` uses bordered native panels, header hints and a single column below 70 columns. It refreshes sequentially every 2000ms on a TTY; Ctrl-C stops it, and `--once` or a non-TTY prints once. `--json` uses the normal result envelope.
- `tick` previews due active loops without writes or provider calls unless `--execute` is present. It selects this project's earliest due loops (default limit 1, maximum 100), or an explicit active id, and waits for the run/checkpoint or user-input state. A 15-minute wait deadline reports the still-running state without cancelling it and exits 3. `--report-only` creates a fresh read-only session for that run, suppresses host checks and cannot complete an editing goal; the saved loop policy stays unchanged. Failed or interrupted runs exit 1.
- `workflow start` always previews first and prints every check command verbatim and the applied permission; nothing starts without `--yes`. A name is a saved plan (`workflows/<name>.json` in any extension layer); an argument ending in `.json` or containing `/` is a plan file. `--wait` follows the `workflow.changed` pushes (no polling) until the run ends or needs the user. See [workflows.md](workflows.md).
- `profile add company ~/Code/acme` makes every session under that folder use the `company` profile: its own user memories, model roles (a recipe applied there sets them) and default permission. See [profiles.md](profiles.md).
- `recipe list` shows the model recipes of every layer (built-in `quick`, `balanced`, `deep`; then packages, user, project; a later layer replaces a recipe of the same name) and marks the active one with `*`. `recipe apply` sets every model role from it; only engines that let you choose a model accept it.
- `usage` totals the last N days (default 30) and lists tokens and calls per model; JSON carries the whole usage report.

## Memory control plane

`memory` defaults to `status`. `control-plane memory …` is an alias for the same operations.

```text
memory preview [query] [--mode request|after-compaction|manual] [--provider P] [--model M]
memory edit <id> "text" [--scope global|project]
memory delete|apply|reject <id> [--scope global|project]
memory propose "text" [--scope global|project] [--category C] [--tags a,b]
memory propose --from-file PATH [--max-proposals N]
memory import-codex [--from PATH] [--apply] [--max-proposals N]
memory import-v1 --from PATH [--apply] [--max-proposals N]
memory index
memory config [--project] [--enable|--disable] [--use|--no-use] [--generate|--no-generate]
  [--max-prompt-tokens N] [--max-entries N] [--project-max-entries N]
  [--global-compaction-max-entries N] [--dream-consolidation-policy disabled|preview|auto-consolidate]
memory dream [status|tick|run|consolidate] [--preview|--auto] [--deterministic]
```

Use `--dir D` for an isolated daemon. `global` maps to the active profile's user scope. Edits and deletes default to project scope; proposal resolution checks visibility and requires Pending. Preview uses native retrieval without a provider call. Index rebuilds the daemon's FTS transactionally without changing memories.

Manual proposals always wait for approval. File extraction requires a configured extractor and creates pending proposals. Codex import previews at most 20 files by default (1–50 with `--max-proposals`), skipping rollout summaries, symlinks and files over 256 KB; each candidate is redacted and capped at 12 000 characters. `--apply` calls the extractor, deduplicates its output and creates user proposals tagged `codex-import`; it does not approve them. A missing extractor returns an explicit skipped result.

Configuration persists in daemon settings; `--project` writes an override for the current directory. It affects retrieval, generation and Dream without changing other projects. `--input`/`--no-input` alias use and `--output`/`--no-output` alias generation. Disabling also turns both off. Caps follow v2 limits (prompt 1–32 000 tokens, entry caps 1–10 000).

Dream status includes the integrated service, daily window and five recent reports. Tick shares the scheduler's persisted window and cannot repeat it. Run and consolidate are aliases that wait for the final result; failed runs exit 1. These v1 CLI operations default to deterministic auto-consolidation unless configured otherwise; `--preview` keeps existing proposals unchanged. When the `memoryConsolidator` model role is set, run/consolidate also consult it (see [Dream](dream.md)); `--deterministic` skips it for that run. Ordinary `dream.run` remains a background command with its existing review behavior unless the consolidation setting is explicitly configured. No separate OS service is installed by these commands.

File extraction has a 45-second abortable provider deadline and a 50-second client deadline. Synchronous Dream gets a one-hour client deadline to allow foreground yielding; quick queries retain the normal 15-second RPC deadline. Closing the client or daemon still settles pending requests.

The additive `memory.control` and `dream.control` protocol commands and typed client helpers own these operations. Neither is allowed to remote read-only peers, since they can expose input files, call providers or mutate state.

## User daemon service (B68)

`daemon start|run|status|logs|stop` controls the existing user daemon. `start` detaches and reuses a running instance;
`run` stays in the foreground. A detached daemon stops itself after 10 minutes with no client, no work and nothing
standing (loops, workflows, Dream, a scheduled usage resume, channels, remote peers); the loopback HTTP listener does not
keep it. `run` and the user service stay up. `status` and `logs` never start one. Logs are bounded to 128 KiB per stream and
1–1000 lines (`--lines`, default 100), redact recognized secrets and omit terminal controls. JSON retains the CLI envelope.

`daemon service plan|install|start|stop|restart|status|logs|uninstall` manages one fixed user service, shared by loops
and Dream. macOS uses launchd; Linux uses systemd user units. Install enables login startup without starting immediately;
start is explicit. `--dir D`, `--cwd PROJECT`, `--engine ENGINE` and `--service-dir D` configure its binding.
A second data directory cannot overwrite an existing binding. Uninstall retains the definition under `<dir>/service/trash`.
Stop/restart/uninstall refuse active turns, loop verification and background jobs unless `--force` is given.
Persistent activation is supported only on macOS/Linux. Windows service mutations fail before creating files or invoking a manager; use `daemon start` or `daemon run` with the local loopback transport instead. No Task Scheduler integration is advertised.

`[control-plane] loops daemon|service …` (also `loop`) and `[control-plane] memory dream daemon|service …` alias
this same daemon. They do not install competing per-project schedulers. `daemon --once` on either scheduler alias
performs one integrated tick; `--execute` opts into dispatch, otherwise it reports due state. Configured schedules remain
active in the shared daemon. Independent `--interval-ms` polling is replaced by loop triggers and `dreamAt`.
Starting a service does not enable Dream or create loops. `daemon.status`, `daemon.logs`, `daemon.tick` are additive protocol
commands; only status is allowed to remote read-only peers. Local lifecycle CLI commands reject remote transports.

The service explicitly disables TCP listeners, including persisted listener configuration. Existing Unix socket permissions
authenticate local clients; manually configured remote daemons retain token authentication. No secret is embedded in the unit.
Installers leave the service off by default; `MENDCODE_INSTALL_SERVICE=1` opts into installation on macOS/Linux.

`bun scripts/render-frames.ts .agents-frames/B68 --b68 100x30 180x50` records isolated service command frames.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | ok |
| 1 | failure (daemon error, unknown session, failed turn, session in error state) |
| 2 | stopped, cancelled or interrupted turn |
| 3 | timeout (`--timeout`) |
| 4 | a workflow needs the user (`workflow start --wait`; the waiting task's session is printed) |
| 5 | `session send --wait`: the turn completed but an approval was denied for lack of `--approve` and no tool call succeeded after it |
| 64 | usage error (bad arguments) |

A closed pipe (`| head`) ends the command quietly with exit 0.

## JSON output

With `--json` every line of stdout is one object carrying `"schema": "mendcode-next.cli.v1"`:

```json
{"schema":"mendcode-next.cli.v1","kind":"result","command":"session.create","data":{"sessionId":"ses_…"}}
{"schema":"mendcode-next.cli.v1","kind":"event","event":{"sessionId":"ses_…","seq":12,"type":"turn.completed",…}}
{"schema":"mendcode-next.cli.v1","kind":"error","command":"session.list","error":{"code":"failed","message":"…"}}
```

- `result` — one per command, `data` depends on the command (`sessions`, `sessionId`, `queueId`, `memories`, `loops`, `loop`, the usage report…). `session send --wait` and `session wait` end with a result carrying `status` (`completed`, `stopped`, `denied`, `failed`, `timeout` for `send`; `completed`, `cancelled`, `interrupted`, `failed`, `timeout`, `idle`, `error` for `wait`).
- `event` — session events, in order, exactly as persisted (`session events`, `session send --wait`).
- `error` — the failure, on stdout in JSON mode; human mode writes `error: …` to stderr.

`run --json` keeps its existing output: raw session events, one per line, without the envelope.

### `mendcode.cli.v1` compatibility alias

Add `--compat mendcode.cli.v1` to an automation command or `run` to select v1 envelopes (implies JSON):

```bash
mendcode --dir /tmp/mend-data session create --format json --compat mendcode.cli.v1
mendcode --dir /tmp/mend-data run --compat mendcode.cli.v1 "prompt"
```

Each line carries `protocol`, `kind`, `event`, `eventID`, `timestamp`, optional `sessionID` and `data`:
`{"protocol":"mendcode.cli.v1","kind":"result","event":"session.create","eventID":"evt_…","timestamp":1760000000000,"sessionID":"ses_…","data":{"sessionID":"ses_…"}}`.
Persisted events have a stable ID derived from session/sequence and include `data.sequence`; turn lifecycle names become
`session.started`, `session.completed`, `session.cancelled` or `error`. Nested `sessionId` fields become `sessionID` and
credential-like fields are redacted; `tokens.input` counters are preserved. Errors use `kind: "error"` and exit nonzero.
`run` ends with a `kind: "result"`, `event: "session.completed"` envelope on success.

## Prompt control plane

`control-plane prompt sources|build|mode|cycle-mode` (also `prompt …`) inspects native prompt sources, previews a composition without provider calls, or reads/saves/cycles the project's mode. Build accepts `--mode`, `--focus`, `--model`, `--role`, `--workflow`, `--show-full`; mode accepts a mode argument and optional `--focus`. Common JSON/data-directory flags apply. See [prompt-modes.md](prompt-modes.md) for boundaries, defaults and custom sources.
Without the selector, the existing `mendcode-next.cli.v1` schema and raw `run --json` output remain unchanged.

The v2 plan names the alias without specifying how to select it. This implements the narrow envelope alias using v1's
documented JSON shape: payloads remain v2 and `--timeout` remains seconds (`--timeout-ms` is explicit milliseconds).
Unsupported v1 commands/flags are usage errors, not silently emulated; exact payload compatibility remains pending.

## Comments envelope

The terminal's comments on passages of an answer ([editor.md](editor.md#comments-on-an-answer)) travel as the text of one ordinary `user.submit` message, so every engine and client carries them with no schema change. A script or another UI that wants to send the same thing builds this text:

````
<mendcode_comments count="1">
Comments on your answer. Each <comment> has a verbatim <quote> and my comment on it: answer each by number. A <note> is general.

<comment n="1" of="last answer">
<quote>
```
the passage, verbatim
```
</quote>
the user's words
</comment>
<note>
general text, optional
</note>
</mendcode_comments>
````

Rules a producer keeps: the quote sits in a fence of backticks longer than any run inside it (three at least) with the closing tag on its own line; the user's words and the note never contain a literal `</comment>`, `</note>`, `</quote>` or `</mendcode_comments>` (the terminal writes `</\comment>`, and `parseCommentMessage` in `apps/cli/src/view/reply-comments.ts` turns it back); `of` is `last answer`, `earlier answer` or `context`; `cut="N"` on `<quote>` says N characters were dropped from an over-long quote (2000 characters kept). The text may have lines before or after the envelope. The whole message stays under 60,000 characters.

Consumers that do not parse it lose nothing: `session events`, `--json` output, `/export` and history carry the envelope as the message text, which reads as labelled plain text. A consumer that wants the pieces can use `parseCommentMessage` (also `parseCommentDraft` for a saved draft, which adds `draft="1"`, `parked="1"` and `item="…"` and is never sent). `prompt.history` lists a sent message with the envelope as written.

## Examples

```bash
id=$(mendcode session create --title "nightly review")
mendcode session send "$id" "review yesterday's commits" --wait --approve --timeout 900
mendcode session events "$id" --json | jq -r 'select(.event.type=="turn.completed")'
mendcode loop create --every 1h --goal --criteria "CI is green" "keep CI green"
```

## Native TUI control plane

`control-plane tui` (also `tui`) has `status`, `schema`, `profile`, `apply`, `apply-preset`, `rollback`, `preview`, `propose`, `project`, and `render`. Use an explicit `--dir D` for isolated operation.

- `status`, `schema`, `profile`: validated current profile, field schema, or full values.
- `apply --proposal ID` applies a saved proposal; `apply-preset compact|comfortable|spacious|toggle-worktree` changes one preset. Both return a backup id; `rollback` restores the latest backup; `rollback --backup ID` selects an earlier one. `--dry-run` validates without changing the active profile.
- `propose "compact green without worktree" --dry-run` saves a deterministic reviewable proposal. The CLI requires `--dry-run`; it never applies automatically or calls a provider.
- `preview`, `project`, `render` accept `--state home|session` and optional `--session ID`. They produce profile/projection JSON and native app text frames at 100×30 and 180×50 beneath `<dir>/tui/runtime/`. Project uses v2's Line[] renderer; `project --check` validates the native profile and exported frames, with no generated plugin package. The selected session's newest bounded event window supplies real messages.

Profiles, proposals and backups stay under `<dir>/tui/`. Schema validation and operations belong to the daemon (`tui.query` read-only, `tui.change` mutating); typed client helpers and the CLI share that contract. Frame export uses the actual app harness without terminal input or alternate-screen effects.

### Permission control plane

`control-plane permissions` defaults to `status`. `set-default approval|smart|full_access` changes new-session permissions
(`ask|edits|full` are also accepted). `set-reviewer-role <model role>` selects the smart reviewer's role, without changing
its model. All commands support `--dir D` and `--json`; invalid modes/roles are usage errors. The daemon persists changes
and broadcasts them to connected terminals. See [permissions.md](permissions.md) for ordered tool/path rules and loop policy.
## Model, provider and MCP catalog (B17)

- `models [provider] [--verbose] [--refresh]` lists sorted `provider/model` references and available metadata. Native subscription models use `chatgpt/`; wire ids remain unchanged. Refresh asks enabled API providers for their own model lists. The subscription cache remains read-only and cannot be refreshed by this command.
- `control-plane models status|show|plan|presets` reports active folder-profile roles, effective choices, validation failures and fourteen v1 preset names. `plan` exits 1 on failures. `set-default <provider> <model> [--auth-mode api-key|chatgpt-subscription-oauth]` and `use-preset <name>` write the active profile's main role; `--dry-run` validates without writing. `--enable` is accepted because v2 roles are already active. Presets must be available in the real catalog; historical prices are not invented. Ambiguous OpenAI API/subscription choices require an explicit auth mode.
- `providers list|login|logout` (alias `auth`) supports `--provider ID`; login also matches display names and accepts `--api-key-env VAR` or a masked terminal prompt. `--method LABEL` chooses an API/OAuth method; ChatGPT browser/device login uses its own v2 credentials. Logout removes only the selected v2 credential. `control-plane providers auth|status|adapters` reports credential presence and environment variable names; `smoke [--provider ID] [--model ID]` is a dry-run unless `--execute` is present, and exits 1 for executed failures. Subscription smoke still requires its external auth adapter.
- `mcp list|auth [name]|auth list|logout [name]|debug <name>` uses daemon status and OAuth events. Auth waits for completion, handles denial and cancels on interrupt or its five-minute deadline. Missing names open a terminal selector. `mcp add` opens a local/remote wizard; explicit arguments and `--scope user|project` work without a terminal. Put local argv after `--`, or use `--url URL [--no-oauth] [--client-id ID --client-secret-env VAR]`. `--dry-run` does not write; duplicates require `--replace`. `control-plane mcp status|preview` reads without starting servers; `add-local <name> <command> [args…]` writes the project entry.

All commands accept `--json` and use the existing v2 envelope. `--dir` / `--data-dir` selects daemon storage; MCP project entries use the working directory. No v1 code or generated runtime config is loaded. Noninteractive commands missing required wizard choices exit 64; cancelled prompts exit 2 before any mutation. Interactive screens use the shared panel grid, header hints and a single column below 70 cells.

`bun scripts/render-frames.ts .agents-frames/B17 --b17 100x30 180x50` records local-fake daemon/CLI output and the actual wizard app harness. Real OAuth authorization and provider canaries require their external services and are not part of these fixtures.

## Theme CLI (B65)

```bash
mendcode theme validate ./forest.json --dir /tmp/mendcode-data
mendcode theme install ./forest.json --name Forest_Mode --scope project --dir /tmp/mendcode-data
mendcode theme select Forest_Mode --scope project --dir /tmp/mendcode-data
```

`validate` reports `{ ok, file, errors, callsProviders: false }` without writing; invalid documents exit 1. `install` validates before an atomic write; the name defaults to the source filename. Names accept letters, numbers, `.`, `_`, `-`, begin with a letter or digit and are limited to 40 characters. Documents are limited to 16 KiB, including the installed pretty JSON. Native v2 palettes and v1 `{ defs, theme }` documents with references, dark/light variants, hex or ANSI colors are supported; the client maps v1 roles into its native palette without loading v1 code.

Scope defaults to `project`: files go to `<cwd>/.mendcode/themes`, and selection persists by project directory in the daemon settings. `user` installs to `<dir>/themes` and selects the user's theme in settings and `<dir>/tui/profile.json`; `global` is an alias for `user`. Selection requires an installed, valid file in that scope. Project selections override user preferences only in that project. Other settings are preserved, connected terminals refresh immediately, and selections survive daemon restart. No provider is called. File reads/install are local-only; none of these commands is available to read-only remote peers.

`--dir` / `--data-dir` selects daemon storage, not the project. `--json` / `--format json` uses the v2 result envelope. `bun scripts/render-frames.ts .agents-frames/B65 --b65 100x30 180x50` records real temporary-daemon output and the selected themes in the actual app harness.

## Agent CLI (B66)

`agent list`, `agent create [--path DIR --description TEXT --mode all|primary|subagent --permissions KEYS --model P/M --generate]`
and `debug agent NAME [--tool ID --params JSON]` use daemon commands and the standard JSON envelope. Creation prompts
only for missing choices; cancellation exits 2, missing noninteractive choices exit 64, and duplicate files exit 1.
Generation is deterministic without a provider unless `--generate` is given: then the model (`--model` or the main model) writes name, when-to-use text and prompt, with a plain-template fallback. See [Agents](agents.md#agent-cli-b66)
for frontmatter, trust, permissions, model aliases and debug boundaries. Frames live under `.agents-frames/B66/`.


## Session export and import (B36)

`export [sessionID] [--format json|markdown] [--sanitize]` emits a native transcript, with an interactive searchable picker when the ID is omitted. JSON is the default and includes retained details; `--no-reasoning`, `--no-tools`, `--no-metadata`, `--no-timestamps` omit them. `import <file.json|URL>` creates a new local project session after bounded validation. `session export <id> --json` returns the transcript in the automation envelope's `data.text`, rather than a session metadata snapshot. See [sessions.md](sessions.md#session-transfer-b36) for limits, attachment handling and pending v1/ShareNext compatibility.
## Project control (B43)

`control-plane project` provides `init`, `config-show`, `context-status`, `context-refresh`, `context-show`,
`focus-status`, `focus-list`, `focus-show [ID]`, `focus-use ID`, `package-show`, and `package-set`.
`--dir`/`--data-dir` selects daemon storage; the current directory selects the project. Metadata uses `.mendcode/project.json`.

Init seeds `.mendcode/project.json`, project context and memory/skill/command folders.
Existing files, model roles, focus choices and `.agents` remain intact. It creates no synthetic spending state or
unread focus/memory/budget defaults. Real opt-in spending guards use daemon [budget settings](budgets.md), and memory
controls use daemon settings. Focus uses the existing per-project prompt selector, independently of models and folder
profiles; `focus-show` reports the actual native prompt description, without fictitious reasoning, tool or worktree policies.

Context refresh is deterministic and local: input metadata and bounded hashes, docs, commands, dependency/script names
and bounded git freshness. Scripts are never executed. `context-show` refreshes only if the summary is missing.
The 64 KiB per-input hashing limit is reported as `truncated`. No remote requests or model turns run.

Package-set accepts `--id`, `--title`, `--description`, `--version`, `--kind`, `--channel`, `--source-type`,
`--source-url`, `--compat-mendcode`, `--compat-runtime-pack`. Only supplied fields change; empty values clear them.
A source URL is metadata, never fetched. Version is package metadata in this subcommand.
`project.control` is excluded from read-only peers: it includes mutations, content and credential-bearing config.
Frames: `bun scripts/render-frames.ts .agents-frames/B43 --b43 100x30 180x50`.
## Worktree manager (B30)

`[control-plane] worktree status|plan|create|open|adopt|remove|reset|doctor` uses the
daemon's native registry and safe previews. `--dir` selects data, `--project`
selects the checkout, and `--json` preserves the v2 envelope. Create/open/remove/
reset never execute Git or switch sessions; plan/create/adopt only write registry
data. See [worktrees.md](worktrees.md) for options, ownership gates and TUI keys.
## Automation evidence (B69)

`workflow events|artifacts|receipt|export <id>` and `loop events|artifacts|receipt|export <id>` expose the local ledger. v1 spellings `workflows` and `control-plane workflows` are aliases of `workflow`. `--limit 1..100` bounds rows; `--before SEQ` reads the next older page; loops accept `--run N`. Export defaults to JSON text; `--format markdown` emits Markdown, `--json` wraps either format in the CLI envelope. Outputs include pagination and truncation metadata. Reads create no files. See [workflows](workflows.md) and [loops](loops.md) for evidence, retention and history limitations.
## Provider auth control plane (B10)

- `control-plane auth status [provider]`: sanitized local credential presence and expiry; no HTTP.
- `control-plane auth login-plan <provider> [--method LABEL]`: offline method availability and callback plan.
- `control-plane auth login <provider> [--method LABEL]`: the same plan by default; `--execute` starts OAuth and waits up to five minutes. `--open` opts into browser opening. Interrupt/timeout cancels only the flow this invocation started. API-key plans direct users to `providers login`.
- `control-plane auth refresh|logout chatgpt --execute`: explicit v2 refresh/removal; Codex credentials are untouched.
- `providers login <loopback-url> [--execute]`: plan by default; opt-in token-authenticated well-known local command login. See [providers.md](providers.md) for daemon configuration and private storage. Public metadata hosts are blocked.

OAuth capabilities are printed to stderr in JSON mode; the final stdout report contains only status. All auth mutation commands are local-only. `bun scripts/render-frames.ts .agents-frames/B10 --b10 100x30 180x50` records each connect/method/login state through the app harness with local fakes.

## Setup and global API budgets (B61)

`control-plane setup status|plan|doctor` and `control-plane budget status|doctor` accept `--json` and existing data-directory flags. They use daemon commands, never direct provider requests. Setup plan writes a local data-directory artifact; failed doctor exits 1. See [setup.md](setup.md) and [budgets.md](budgets.md) for readiness, helper/preset keys, opt-in USD gates and unknown-cost semantics.
## Debug/database compatibility (B67)

```bash
mendcode --dir /tmp/mend-data db path
mendcode --dir /tmp/mend-data db "SELECT name FROM sqlite_schema" --format tsv
mendcode --dir /tmp/mend-data db "SELECT title FROM sessions" --format json
mendcode --dir /tmp/mend-data db
mendcode --dir /tmp/mend-data debug config|info|paths|scrap|skill|startup
mendcode --dir /tmp/mend-data debug agent NAME [--tool ID --params JSON --approve]
mendcode --dir /tmp/mend-data debug file search QUERY|read PATH|status|list PATH|tree [DIR]
mendcode --dir /tmp/mend-data debug lsp diagnostics FILE|symbols QUERY|document-symbols URI
mendcode --dir /tmp/mend-data debug snapshot track|patch HASH|diff HASH
mendcode --dir /tmp/mend-data debug wait [--timeout-ms MS]
```

These support commands are opt-in. `db` queries the v2 daemon's database through RPC using a read-only SQLite connection, with a 5-second worker deadline, 1,000-row / 100-KB output cap and no ATTACH or write statements. TSV is the default; JSON emits a literal row array as in v1. No SQL opens a read-only multiline shell (`.tables`, `.schema [TABLE]`, `.quit`); writes remain disabled. `db path` prints the actual database path. v1's writable external sqlite3 shell is deliberately not exposed.

Debug uses resolved v2 settings, actual paths, trusted agents/tools, known session projects and discovered skills. `debug` alone prints help; it never waits. `wait` is explicit and exits on SIGINT/SIGTERM or its optional deadline. `startup` reports CLI elapsed startup milliseconds (JSON also includes daemon elapsed time). `--json` retains the v2 automation envelope for debug reports. File search uses the shared fuzzy index; reads/list/tree are project-contained, including symlinks, and bounded. Reads provide text or image base64, binary classification, diff/patch and truncation state. Recognized credentials are redacted.

Agent inspection includes resolved tool availability. `--tool` needs `--approve` even for reads; agent trust, allow/deny lists, plan restrictions and explicit permission denials still apply. Execution creates an isolated debug session without calling a model; interactive questions are declined. LSP uses the configured daemon service; workspace symbols discover file types from the ignore-aware project file list. No server downloads or network tests are added.

For compatibility, `debug agent NAME` without `--approve` retains B66's native-engine inspection and tool execution, including its transcript and hosted task support. `--approve` selects B67's support RPC, including inspection on non-native engines. Both routes retain agent trust, tool and path permission checks; neither agent-debug RPC is read-only remote access.

Snapshots use a private Git object store and index under `<data dir>/debug-snapshots`, survive daemon restarts and never stage or revert the project's index/files. Track prints the tree hash; patch lists changed absolute paths; diff prints its patch. Files are capped at 2 MiB, snapshots at 10,000 paths. Debug and raw SQL RPCs require full-access remote authorization; none is in `READ_ONLY_COMMANDS`. Existing loopback/token transport defaults remain intact.

Frames: `bun scripts/render-frames.ts .agents-frames/B67 --b67 100x30 180x50`. The command surfaces have no new Operate-mode page; frames capture real CLI output with local fake LSP and temporary data directories.

Mflow room lifecycle and diagnostics: [Mflow](mflow.md), including all `control-plane mflow` operations (B73).
