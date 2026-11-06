# Shell hooks and project trust

Shell hooks run a command of yours at points of a session, the way Claude Code and Codex command hooks do. They are
different from [extensions](extensions.md) (TypeScript modules in the daemon); both can be active at once.

## Configuring

Add commands to a layer's `hooks.json`, grouped by event. The layers are the same as for extensions and custom tools:

| Layer | Configuration |
|---|---|
| Data dir | `hooks.json`, your own hooks. |
| Packages | Package hooks. |
| Project | The project's `.mendcode/hooks.json`. |

For example:

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

| Field | Value and behavior |
|---|---|
| `command` | A string run by `/bin/sh -c` (`cmd /c` on Windows), or an argv array. `./x` is relative to the folder holding `hooks.json`; the working directory is the session's project. |
| `timeout` | Seconds; default 15, at most 120 seconds. A timed-out hook is killed and ignored. |
| `matcher` | A case-insensitive regular expression for tool events, `SessionStart`, `Notification`, `PreCompact` and `PostCompact`. Empty or `*` matches everything. |
| `type` | `command` (the default), `http` or `prompt`; see [Hook types](#hook-types). |

The matcher is tested against the whole tool name (`bash`, `write`, `edit`, `read`, MCP tools as named in the tool list), the session source, the notification type or the compaction trigger.

Event names are case-insensitive. A bad file, unknown event or invalid matcher is listed as a problem in `/hooks`; the rest still loads.

Hooks of one event run in order, one at a time. The first one that blocks ends the chain.

Files are re-read at the start of every turn, and at most every 5 s otherwise.

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

### Run a command

The `command` type runs a program as described under Configuring.

### Send an HTTP request

An `http` hook can use this configuration:

`{ "type": "http", "url": "https://hooks.example.com/mendcode", "headers": { "x-team": "core" }, "timeout": 10 }`

It POSTs the same JSON that `command` hooks get on stdin to the URL.

| Response | Result |
|---|---|
| 2xx | Continue, or block with the same JSON decision described below. |
| Any other status, network error or timeout | Log and ignore. |
| Redirect | Not followed. |

**Note:** HTTP hooks are off by default. A hook runs only when its whole URL matches a pattern of `allowedHttpHookUrls`, on top of project trust for project-layer hooks.

In that setting, `*` spans any characters; unset or empty means none run. The URL shown in `/hooks` and in the log has no query or credentials. Headers are sent as written, with no variables.

### Ask a model

A `prompt` hook asks the model to judge the event:

`{ "type": "prompt", "prompt": "Does this command look safe? $ARGUMENTS" }`

`$ARGUMENTS` is the event JSON, masked and cut at 8 000 characters. When absent, the JSON goes at the end of the prompt.

The model answers `{"ok": false, "reason": "..."}` to block. An unreadable answer, an error or a missing model is a failed run and never blocks.

Each run costs a model call: it uses the native engine's budgeted completion with the default model, counted in budgets. Use rare events and a precise matcher.

### Continue or block

Exit 0 continues. A hook that must gate something has to exit 2; any other exit code, a spawn failure or a timeout is recorded and ignored, so the call goes ahead.

Stdout of an exit-0 hook may be JSON, `{"decision":"block","reason":"..."}`, or Claude Code's `hookSpecificOutput.permissionDecision: "deny"`. These block like exit 2.

Nothing a hook prints can approve a call or skip a permission prompt. Hooks cannot rewrite tool arguments.

## What a hook receives

One JSON object on stdin:

```json
{ "session_id": "ses_…", "cwd": "/work/app", "hook_event_name": "PreToolUse",
  "turn_id": "turn_…", "tool_name": "bash", "tool_use_id": "call_…", "tool_input": { "command": "ls" } }
```

| Event | Additional fields |
|---|---|
| `PostToolUse` | `tool_response: { output, is_error }`; output cut at 32 KB. |
| `PostToolUseFailure` | `error` |
| `PermissionRequest` | `tool_name`, `tool_input`, `detail` |
| `Notification` | `notification_type`, `title`, `message` |
| `PreCompact` | `trigger`, `tokens` |
| `PostCompact` | `trigger`, `summary` |
| `SubagentStop` | `agent_session_id` |
| `UserPromptSubmit` | `prompt` |
| `Stop` | `stop_hook_active` |
| `SessionStart` | `source`, `parent_session_id` |
| `SessionEnd` | `reason` |

| Environment variable | Value |
|---|---|
| `MENDCODE_PROJECT_DIR`, also `CLAUDE_PROJECT_DIR` | Project directory. |
| `MENDCODE_HOOK_DIR` | The folder of the `hooks.json`. |
| `MENDCODE_HOOK_EVENT` | Hook event. |
| `MENDCODE_SESSION_ID` | Session ID. |

## Security

**Warning:** Hooks run commands as you. User-layer hooks run as configured; project-layer hooks run only after you trust the directory.

### Project trust and environment

Project-layer hooks include the repository's `.mendcode/` and its packages. They use the same trust as project tools and extensions (`trustedToolDirs`).

Untrusted project hooks appear in `/hooks` with `not trusted` and never start. Trust is per canonical directory, so a worktree is a different directory.

Project hooks do not inherit environment variables with credential-like names containing `API_KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `CREDENTIAL` or `PRIVATE_KEY`. User hooks get the daemon's environment.

Configuration comes from the daemon machine's own folders. Nothing a client, remote peer or MCP server sends can add a hook.

`hooks.list` refuses remote connections; it is not a read-only remote command.

### Payloads, output and failures

Tool arguments and results reach hooks the way they reach the model: secrets from the secrets store are markers. The whole stdin payload, stdout and stderr are masked again before use or display.

| Protection | Limit or behavior |
|---|---|
| Captured hook output | 64 KB |
| Feedback to the model | 4 000 characters |
| Every run | Has a timeout and is killed with its process group. |
| Failed or timed-out hook | Logs one line: event, source, outcome, exit code, program name; never what it printed. |

`http` hooks reach only URLs you list in `allowedHttpHookUrls`, never follow redirects and log no URL. `prompt` hooks send the masked event to your configured model. `PermissionRequest` hooks can only refuse.

Start the daemon with `MENDCODE_HOOKS=0` to turn all shell hooks off.

## `/hooks`

Open `/hooks` to inspect configuration, recent runs and file problems. It is read-only apart from trust; edit `hooks.json` to change hooks.

| List | What it shows |
|---|---|
| Configured hooks | Event, matcher, command, layer (`user`, `project` or `user package <name>`), whether it runs and why not, file, timeout, type. |
| Recent runs of this daemon for the project | Time, event, tool, outcome, exit code, duration, first line of what the hook said. |

A hook that cannot run shows `not trusted`, or `not allowed` for an http hook outside `allowedHttpHookUrls`.

| Key | Does |
|---|---|
| `tab` or `1`/`2` | Switch between the two lists. |
| `t` | Trust or untrust the project. |
| `r` | Refresh. |

## Project trust

On start, a project whose hooks, custom tools or extensions are waiting for trust shows a prompt before anything project-local runs:

1. Press `y` to trust the directory.
2. Or press `n` (or esc) to leave it untrusted and ask again next time.

No prompt appears when nothing project-local is waiting, with `--no-approve`, with a startup prompt (`-p`), or on remote sessions.

| Command or flag | Does |
|---|---|
| `/trust` | Show the prompt on demand. |
| `/trust on`, `/trust off` | Set trust directly. |
| `/trust status` | Show where trust stands. |
| `/tools`, `/extensions` (`t`) | Set the same trust. |
| `--approve` | Global flag, local daemons only: trust the current project before anything runs, for the TUI and `run`. Persists like any trust. |
| `--no-approve` | Skip the startup prompt for that launch. |
