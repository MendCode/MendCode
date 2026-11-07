Run a session on your own [pi](https://github.com/earendil-works/pi) (`pi --mode rpc`) while MendCode shows the turn and handles approvals with its own permission modes. Start by opting in below.

## pi engine

pi keeps its loop, tools, extensions, skills, prompt templates, models and login. MendCode keeps pi's session files as the conversation.

MendCode never reads pi's credentials or settings. pi finds its own `~/.pi` files; sign in inside pi by running `pi`, then `/login`.

It is off by default and a `full` tier feature (`pi` in [tiers.md](tiers.md), mode `permit`). The tier only allows it; you opt in.

Nothing is loaded, listed or started until you opt in. No process starts until a session on a pi model sends a turn.

## Opt in

Either create `<dataDir>/pi.json` (an empty `{}` is enough) or run `/tier pi on` (`features.pi`, which also allows it in a lower tier). `--safe-mode` and `features.pi: false` turn it off.

```json
{
  "command": "pi",
  "args": ["--no-skills"],
  "env": { "PI_CODING_AGENT_DIR": "${MY_PI_DIR}" },
  "models": ["anthropic/claude-sonnet-4-5", "openai/gpt-5:high"],
  "sessionDir": "/data/pi-sessions"
}
```

| field | meaning |
|---|---|
| `command` | Executable, looked up in `PATH`. Default `pi`. |
| `args` | Extra arguments after `--mode rpc`, before MendCode's safety flags. Explicit `-e`/`--extension` arguments require project trust; `--` is refused. |
| `env` | Extra environment (added to the daemon's). `${NAME}` is read from the daemon's environment. |
| `models` | `--model` patterns (`provider/id`, optional `:thinking`) offered in `/model` as `pi:<pattern>`. |
| `sessionDir` | `--session-dir`. pi's own default when absent. |

### Choose a pi model

1. Open `/model`. Its **pi** group lists `pi` (whatever model pi is set to use) and one entry per pattern.
2. Choose a model and effort. The effort becomes pi's thinking level (`set_thinking_level`); a model without reasoning ignores it.

The file is re-read when it changes. A model switch restarts the process on the same session.

For JSONL logs, set `MENDCODE_PI_TRACE=<file>`.

## How a turn runs

### Start and resume

MendCode starts pi in the session's directory, with an argument array and no shell:

`pi --mode rpc [--append-system-prompt <text>] [--no-extensions] -e <bridge> [--session-dir …] [--session <file>] [--model <pattern>]`

The appended text keeps pi's own prompt and says what MendCode draws, where its docs are (`mendcode docs`) and the names of the session's `/env` credentials.

The `minimal` prompt mode leaves out all but the credentials. A change takes effect with the next process.

`get_state` returns pi's session file, kept per MendCode session. After a restart, the process resumes it with `--session`; a file that is gone starts a new pi session.

The process stays up between turns and stops after 10 idle minutes.

### Read the stream

| pi event or output | What MendCode shows |
|---|---|
| `message_update` text and thinking deltas | Messages and reasoning |
| Each tool execution | One tool card: arguments as the call, result as the output |
| Each assistant message | Usage and pi's cost |
| `compaction_*` | A compaction card |
| `auto_retry_start` | The "retrying" line |

While a turn runs, the output tokens of the message in progress update the working row live. They are not stored; the usage record gives the exact figure.

### Finish a run

Only `agent_settled` finishes a turn. The first `agent_end` can be followed by a retry (`willRetry`), a compaction (overflow) or queued continuations, so it never finishes one.

An `agent_settled` that arrives before this turn's own `agent_start` belongs to an earlier run and is ignored.

A prompt that pi handled without starting a run, such as an extension command or a template, is detected through `get_state`: not streaming, not compacting, nothing pending.

### Errors

| Failure | Result |
|---|---|
| pi's own error text | Ends the turn with `pi_turn_failed` |
| Exhausted retries | `pi_retry_failed` |
| Authentication failure | `pi_auth`, pointing at pi's login |
| Output limit | `pi_limit` |
| Process dies | `pi_exited`, with the end of its stderr |
| Command not found | `pi_missing` |

A quiet run is never cut: pi retries its own calls. Esc stops it.

### Queue and cancel

With the `after-tools` queue mode, a message you queue while pi works is taken at pi's `turn_end` and sent as `steer`. pi delivers it before its next model call.

If pi has no run left, it starts one with `prompt` inside the same turn. Otherwise it waits for the settled turn like any queued prompt.

Cancellation runs in order:

1. `clear_queue` stops pi's queued messages from continuing.
2. `abort_retry` runs if a retry is waiting.
3. `abort` runs; pi answers once it is idle.

A pi that does not answer within 5 seconds is stopped. The next turn resumes the session file.

### Compaction and roles

`/compact` is pi's `compact` with your instructions; pi also compacts on its own. `/context` is pi's.

Non-main roles (aside, dream, reviewer) cannot use a pi model.

### Version and capability checks

When the engine is created, MendCode reads `pi --version` and `pi --no-extensions --help` in an empty temporary cwd. Help confirms the extension-discovery flag.

The [upstream CLI help](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/cli/args.ts) documents that explicit `-e` paths still load. The relevant excerpt is in `packages/engine-pi/test/fixtures/pi-help.txt`.

The version decides lifecycle capabilities:

| Capability | Behavior |
|---|---|
| `agent_settled` | Exists since 0.80.4 |
| Older or unreadable versions | Fall back to the final `agent_end` plus 1.5 quiet seconds |
| `agent_settled` seen at run time | Trusted over the version |
| Answer error to an unknown courtesy command | Ignored, as with `clear_queue` |

## Approvals

pi is local-only: peer clients cannot select it or submit/compact a pi turn. Plan mode refuses writes even with a previous session grant.

The temporary bridge refuses tool arguments over 6,000 characters rather than approving a clipped operation.

RPC traces redact detected credentials, omit the handshake challenge, and record only framing for streaming message updates.

### Trust project extensions

Project extensions require MendCode's existing project-tools trust (`/extensions` → trust, also `tools.trust`). `full` permission does not grant project trust.

- Without trust, MendCode adds `--no-extensions`. This also disables user/global and built-in extension discovery; its explicit temporary bridge still loads.
- If help cannot confirm that flag and the project has a `.pi` entry, the turn and compaction are refused before spawning a session process. This conservative check also covers project settings/package declarations.
- Explicit extensions in `pi.json` require trust too.

### Tool approvals

pi has no permission prompts. MendCode loads a small extension from a private temporary directory (`-e`, deleted with the engine; never written into pi's folders) whose `tool_call` hook asks MendCode before every tool call and blocks it unless it is approved. Your permission mode decides:

| mode | `read` `grep` `find` `ls` | `write` `edit` | `bash` and any other tool |
|---|---|---|---|
| `ask` | runs | asks | asks |
| `edits` | runs | runs | asks |
| `plan` | runs | refused | refused |
| `full` | runs | runs | runs |
| `smart` | runs | asks | bash uses native smart command analysis; other tools ask |

The approval shows the command, or the path and content. Approve for the session covers the exact tool and all its arguments, including content, nested edits and bash options.

A different argument asks again; object key order does not. Plan mode and smart bash refusals override previous grants.

Outside `full`, turns and compaction are refused (`pi_gate_missing`) unless the bridge answers a fresh per-process handshake within 15 seconds, before `prompt`/`compact` is sent.

The bridge registers its tool hook before announcing readiness. In `full`, the handshake is optional.

**Warning:** MendCode's per-path permission rules (secret files and so on) are not applied inside pi's tools.

### Sandbox and session grants

When `/sandbox` is on, pi's entire process and capability probes use the same OS profile as native shell commands: write roots (including declared extra directories), protected paths and network policy.

- A missing backend refuses the process; there is no unconfined fallback.
- Trust or sandbox changes restart pi before the next operation.
- The sandbox also limits pi's own session writes and provider connections. A session directory outside writable roots or network-off policy can prevent pi from working.
- MendCode does not silently widen the policy.

With sandbox off, approved tools have the user's OS rights. Session grants remain in memory and disappear when the process restarts.

### Extension dialogs

| Dialog or request | MendCode behavior |
|---|---|
| `confirm` or two-way `select` (`Allow`/`Block`, `Yes`/`No`) | Approval; plan mode refuses without asking |
| Any other `select` | Question with those options |
| `input`, `editor` | Questions |
| Notifications, widgets, status and title requests | Ignored |

Dialogs with a timeout disappear with it. When you cancel the turn or pi exits, open questions are withdrawn and a late answer is dropped, never sent to a restarted process.

## Limits

### oh-my-pi is unsupported

**oh-my-pi (`omp`) is unsupported.** No omp executable or upstream source checkout was available locally to confirm its launch arguments, JSONL RPC lifecycle, extension-discovery isolation or `tool_call`/UI bridge API.

Being a pi distribution does not establish those contracts. `command` can select an executable, but it does not certify omp compatibility; `binary` and `omp:<pattern>` are not supported.

Before enabling omp, verify those contracts against a local version and run the fake-process isolation, approvals and fresh-handshake tests under the omp name. No placeholder adapter is shipped.

### Bridge and attachments

The bridge needs pi's extension API (`tool_call` with `ctx.ui.select`); that is how approvals are mapped. The handshake confirms that bridge's readiness, not the integrity of arbitrary trusted extensions.

OS confinement comes from `/sandbox`, off by default.

Images are sent as `images` blocks; other attachments become a text marker. pi decides whether its model takes images.

pi's own MCP support, if your version has it, is pi's. MendCode passes no tools into pi and offers none of its thread tools there; there is no orchestration bridge yet.

### What the tests verify

A real pi run is not part of the tests. They use a scripted process that speaks the documented RPC (`packages/engine-pi/test/fake-pi.ts`) and a fake sandbox backend to verify the native profile/argv and failure path.

This is not proof of real OS enforcement or provider access. Behaviour against a given pi version is verified separately.
