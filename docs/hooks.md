# Shell hooks and project trust

Shell hooks run a command of yours at points of a session, the way Claude Code and Codex command hooks do. They are
different from [extensions](extensions.md) (TypeScript modules in the daemon); both can be active at once.

## Configuring

A layer's `hooks.json` lists commands per event. Layers are the same as for extensions and custom tools: the data dir
(`hooks.json`, your own hooks), packages, and the project's `.mendcode/hooks.json`.

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "bash|write", "hooks": [ { "type": "command", "command": "./check.sh", "timeout": 10 } ] }
    ],
    "Stop": [ { "hooks": [ { "command": "npm test --silent" } ] } ]
  }
}
```

- `command` is a string (run by `/bin/sh -c`, or `cmd /c` on Windows) or an argv array (`./x` is relative to the folder
  holding `hooks.json`). The working directory is the session's project.
- `timeout` is in seconds (default 15, at most 120). A timed-out hook is killed and ignored.
- `matcher` (tool events, `SessionStart`, `Notification`, `PreCompact` and `PostCompact`) is a case-insensitive regular
  expression tested against the whole tool name (`bash`, `write`, `edit`, `read`, MCP tools as named in the tool list),
  the session source, the notification type or the compaction trigger; empty or `*` matches everything.
- `type` is `command` (the default), `http` or `prompt`; see [Hook types](#hook-types).
- Event names are case-insensitive. A bad file, unknown event or invalid matcher is listed as a problem in `/hooks`; the
  rest still loads. Hooks of one event run in order, one at a time, and the first one that blocks ends the chain.
- Files are re-read at the start of every turn (and at most every 5 s otherwise).

## Events

| Event | When | Exit 2 |
|---|---|---|
| `PreToolUse` | after approval, right before a tool runs (also `!command`) | refuses the call; stderr is the tool's error, which the model reads |
| `PostToolUse` | after a tool ran | stderr is appended to the result the model sees |
| `UserPromptSubmit` | `user.submit`, before the text is queued | the prompt never reaches the model; stderr is shown to you. Stdout of a hook that exits 0 is added to the prompt as context (10 000 characters at most) |
| `Stop` | a turn completed (not for sub-agent tasks) | starts one follow-up turn carrying stderr; at most 3 in a row until the next prompt (`stop_hook_active` is true in them) |
| `SessionStart` | a session was created (`source`: `startup`, or `child` for forks and sub-agents) | observer |
| `SessionEnd` | a session was deleted or archived (`reason`) | observer |
| `PostToolUseFailure` | a tool failed (after `PostToolUse`, which also fires for failures) | stderr is appended to the error the model sees |
| `PermissionRequest` | right before you would be asked to approve a call (not for calls a rule or mode already settled) | refuses the call without a prompt; the model is told `blocked by a PermissionRequest hook: <stderr>`. It can never approve |
| `Notification` | the agent is waiting for you: matcher `permission_prompt` (an approval) or `question`; a turn ended: matcher `turn_completed` or `turn_failed` (only a hook that names it runs; this is the external `notify` command, see [return](return.md)) | observer |
| `PreCompact` | before a compaction; matcher `auto` or `manual` | cancels the compaction |
| `PostCompact` | after a compaction (`trigger`, `summary`); matcher `auto` or `manual` | observer |
| `SubagentStop` | a sub-agent task session finished a turn | observer |

Tool, `PermissionRequest` and compaction events apply to the native engine (the Claude Code and Codex engines run their
own loops). Prompt, `Stop`, `Notification`, `SubagentStop` and session events work with every engine.

## Hook types

- **`command`**: runs a program, as above.
- **`http`**: `{ "type": "http", "url": "https://hooks.example.com/mendcode", "headers": { "x-team": "core" }, "timeout": 10 }`
  POSTs the same JSON as `command` hooks get on stdin to the URL. A 2xx reply continues, or blocks with the same JSON
  decision as above; any other status, a network error or a timeout is logged and ignored, and redirects are not followed.
  **Off by default**: an http hook runs only when its whole URL matches a pattern of the `allowedHttpHookUrls` setting
  (`*` spans any characters; unset or empty means none run), on top of the project trust for project-layer hooks. The
  URL shown in `/hooks` and in the log has no query or credentials, and headers are sent as written (no variables).
- **`prompt`**: `{ "type": "prompt", "prompt": "Does this command look safe? $ARGUMENTS" }` asks the model to judge the
  event; `$ARGUMENTS` (or the end of the prompt when absent) is the event JSON, masked and cut at 8 000 characters. The
  model answers `{"ok": false, "reason": "..."}` to block; an unreadable answer, an error or a missing model is a failed
  run and never blocks. It uses the budgeted completion of the native engine (the default model, counted in budgets), so
  each run costs a model call; put it on rare events and a precise matcher.

Exit 0 continues. Any other exit code, a spawn failure or a timeout is recorded and ignored (the call goes ahead): a hook
that must gate something has to exit 2. Stdout of an exit-0 hook may be JSON, `{"decision":"block","reason":"..."}`, or
Claude Code's `hookSpecificOutput.permissionDecision: "deny"`, which block like exit 2. Nothing a hook prints can approve a
call or skip a permission prompt, and hooks cannot rewrite tool arguments.

## What a hook receives

One JSON object on stdin:

```json
{ "session_id": "ses_…", "cwd": "/work/app", "hook_event_name": "PreToolUse",
  "turn_id": "turn_…", "tool_name": "bash", "tool_use_id": "call_…", "tool_input": { "command": "ls" } }
```

`PostToolUse` adds `tool_response: { output, is_error }` (output cut at 32 KB); `PostToolUseFailure` has `error`;
`PermissionRequest` has `tool_name`, `tool_input` and `detail`; `Notification` has `notification_type`, `title` and
`message`; `PreCompact` has `trigger` and `tokens`; `PostCompact` has `trigger` and `summary`; `SubagentStop` has
`agent_session_id`; `UserPromptSubmit` has `prompt`; `Stop` has
`stop_hook_active`; `SessionStart` has `source` and `parent_session_id`; `SessionEnd` has `reason`. Environment:
`MENDCODE_PROJECT_DIR` (also `CLAUDE_PROJECT_DIR`), `MENDCODE_HOOK_DIR` (the folder of the `hooks.json`),
`MENDCODE_HOOK_EVENT`, `MENDCODE_SESSION_ID`.

## Security

- Hooks run commands as you. **User-layer hooks run as configured. Project-layer hooks (the repository's `.mendcode/`
  and its packages) run only after you trust the directory**, with the same trust as project tools and extensions
  (`trustedToolDirs`). Untrusted project hooks are listed in `/hooks` with `not trusted` and never started. Trust is per
  canonical directory, so a worktree is a different directory.
- Project hooks do not inherit environment variables that look like credentials (names containing `API_KEY`, `TOKEN`,
  `SECRET`, `PASSWORD`, `CREDENTIAL`, `PRIVATE_KEY`). User hooks get the daemon's environment.
- The configuration is read from the daemon machine's own folders. Nothing a client, remote peer or MCP server sends can
  add a hook, and `hooks.list` refuses remote connections (it is not a read-only remote command).
- Tool arguments and results reach hooks the way they reach the model: secrets from the secrets store are markers, and
  the whole stdin payload, stdout and stderr are masked again before they are used or shown. Hook output is capped (64 KB
  captured; feedback to the model 4 000 characters), and every run has a timeout and is killed with its process group.
- A failed or timed-out hook logs one line (event, source, outcome, exit code, program name) and never what it printed.
- `http` hooks reach only URLs you list in `allowedHttpHookUrls`, never follow redirects and log no URL; `prompt` hooks
  send the masked event to your configured model. `PermissionRequest` hooks can only refuse.
- `MENDCODE_HOOKS=0` starts the daemon with all shell hooks off.

## `/hooks`

Lists the configured hooks (event, matcher, command, the layer it came from (`user`, `project` or `user package <name>`),
whether it runs and why not (`not trusted`, or `not allowed` for an http hook outside `allowedHttpHookUrls`), file,
timeout, type), the recent runs of this daemon for
the project (time, event, tool, outcome, exit code, duration, first line of what the hook said) and problems with the
files. `tab` or `1`/`2` switch between the two lists, `t` trusts or untrusts the project, `r` refreshes. It is read-only
apart from trust; edit `hooks.json` to change hooks.

## Project trust

- On start, a project whose hooks, custom tools or extensions are waiting for trust shows a prompt before anything of it
  runs: `y` trusts the directory, `n` (or esc) leaves it untrusted and asks again next time. Nothing is asked when nothing
  project-local is waiting, with `--no-approve`, with a startup prompt (`-p`), or on remote sessions.
- `/trust` shows that prompt on demand; `/trust on`, `/trust off` set the trust directly; `/trust status` says where it
  stands. `/tools` and `/extensions` (`t`) set the same trust.
- `--approve` (a global flag, local daemons only) trusts the current project before anything runs, for the TUI and for
  `run`; it persists like any trust. `--no-approve` skips the startup prompt for that launch.
