# ACP agents

A session can run on any external agent that speaks the [Agent Client Protocol](https://agentclientprotocol.com) (Gemini CLI, Zed's adapters for Claude Code and Codex, and others). Configure the agent, pick its model in `/model`, and that session's turns go to it.

## Configure

Add agents in `<dataDir>/acp-agents.json`:

```json
{
  "gemini": { "command": "gemini", "args": ["--acp"] },
  "codex": { "command": "codex-acp", "args": [], "env": { "CODEX_HOME": "/path" } }
}
```

| field | meaning |
|---|---|
| name | Letters, digits, `.`, `-`, `_`; becomes the model `acp:<name>`. |
| `command` | Executable, looked up in `PATH`. |
| `args` | Arguments. |
| `env` | Extra environment for the agent process (added to the daemon's). |

### Manage agents in the terminal

Open `/acp` (also linked from `/settings`) to list agents.

| Key | Does |
|---|---|
| `a` | Add |
| `e` | Edit |
| `d` | Remove after `y` confirmation |
| `r` | Refresh |

The form takes a name, command, args as a JSON string array, and comma-separated environment keys. Names stay fixed when editing; recreate an agent to rename it.

Environment values are never shown or returned to clients:

- Existing values are preserved for retained keys.
- New keys are stored as `${KEY}` references and resolved from the daemon environment. Missing keys resolve to an empty string.
- Literal values configured by hand still work.

### Apply configuration changes

The file is re-read when it changes, so a new agent appears in `/model`. A bad entry is skipped. The models appear only on the native engine (`engine: native`).

New sessions use edits. Already-running agent processes keep their configuration until they exit or the daemon restarts (`restart to apply` on the page).

## The agent's own models

An agent that offers a `model` select in its `configOptions` (OpenCode does) gets one `/model` entry per value, after its base entry.

| Entry | Name and behavior |
|---|---|
| `acp:<name>` | `OpenCode harness`; leaves whatever model the agent is on |
| `acp:<name>/<value>` | `<its name> · <Agent> harness` (`· OpenCode harness`, the registry's name, else the id) |

The name distinguishes these from the same models on a native provider, which run on MendCode's own harness (`· OpenCode Zen`).

The list comes from the agent's last `session/new`, `session/load`, `session/set_config_option` answer or `config_option_update`. It is kept in `<dataDir>/acp-models.json`, so it appears after the agent's first turn and survives restarts.

Choosing a value sends `session/set_config_option` before the prompt when the agent's value differs. A refused value fails the turn (`acp_model`) with the agent's reason; so does an `acp:<name>/<value>` for an agent with no model option.

Every `acp:<name>/…` is the same engine as `acp:<name>`. Switching between them keeps the agent's session and process.

### Effort

An agent that offers an effort select (ACP category `thought_level`; OpenCode's `effort`) lists the levels of the model in force. OpenCode's `deepseek-v4.1-flash-free` offers `low`, `high`, `max` and `default`; a model with no levels has no select.

Each time the agent lists levels, those levels without `default` become that model's `efforts` in `<dataDir>/acp-models.json`. After the first turn on that model, `/model`, its ←→, F3 and `--effort` offer them for `acp:<name>/<value>`.

Before that, a model whose id is models.dev's `provider/model` (OpenCode's are) shows the levels models.dev names for it ([providers.md](providers.md#reasoning-levels-from-the-catalog)). A level the agent does not list then is not sent, and the agent's default applies.

With neither source, the model has no levels and `--effort` is refused.

Before each prompt, after any model switch, the session's effort is sent with `session/set_config_option` when it differs from the agent's:

| Requested effort | Sent value |
|---|---|
| No effort asked | `default`, the agent's own level |
| Level the model does not list | `default` |
| Listed level | That level |

A refused level fails the turn (`acp_effort`).

Checked live on 2026-10-17 with OpenCode 1.19.3: the same question took 20 s and 1,719 characters of reasoning at `max`, 4.5 s and 873 at `low`.

## Offline registry (full tier)

1. Enable with `/tier full` or `/tier acp_registry on`.
2. Open `/acp` and press `c`.
3. Install manually outside MendCode, using pnpm 11+ with release-age protection for npm packages, or the vendor's binary instructions.
4. Sign in using the agent's own CLI.
5. Press Enter to add only the selected preset to `acp-agents.json`, even if missing. Existing names refuse replacement.
6. Choose the resulting `acp:<name>` in `/model` to run through the existing daemon-owned ACP engine.

The bundled catalog lists Gemini CLI, Devin, Cline, Kimi CLI, Factory Droid, codex-acp, OpenCode and Claude Agent (the maintained successor of claude-code-acp). Each has installation instructions, upstream links and exact command/argument arrays.

Catalog provenance: [official ACP registry](https://github.com/agentclientprotocol/registry), curated 2026-10-04.

### What detection means

No network is required to browse, detect or add. The catalog never installs, downloads, authenticates, launches or probes `session/new`.

`installed` means its executable is on the **daemon's PATH**, not that auth or ACP readiness has been verified. `r` rechecks PATH.

Catalog presets use no npx/uvx runner, so they do not implicitly download packages. Adding is an explicit user configuration action; actual turns retain normal ACP approvals.

### Registry command boundaries

The `acp.registry` command (`operation: list|add`, `agentId` for add) is lazy-validated, local-only, safe-mode disabled and excluded from read-only remote commands.

Remote/peer clients cannot edit `acpAgents` or submit ACP turns.

## Agent transport

MendCode starts the agent with its stdio as the transport (one JSON-RPC 2.0 message per line) and acts as the ACP client:

### Initialize and resume

`initialize` uses protocol version 1. No file-system or terminal capability is offered, so the agent works with its own tools and sandbox. A request for `fs/*` or `terminal/*` is answered method-not-found.

`session/new` uses the session's directory as `cwd`. The agent's session id is stored per MendCode session and agent.

After a process restart, the conversation resumes with `session/load` when the agent advertises `loadSession`. Otherwise a new agent session starts.

### Tools supplied to the agent

An agent that advertises `mcpCapabilities.http` gets MendCode's own tools as the loopback `mendcode` server in `session/new` and `session/load`. Feature `harness_tools`, in balanced and full, supplies code graph, memory, computer use when on, settings…

These use the same bearer, approvals and turn ownership as [Claude Code](claude-code.md). An agent without HTTP support gets an empty list and its own tools only.

Full-tier per-agent [thread bridge opt-in](thread-mcp.md) supplies a loopback HTTP entry to both `session/new` and `session/load`. It requires advertised `mcpCapabilities.http`.

### Prompt content

`session/prompt` sends the text and, when the agent accepts images, image blocks. Other attachments become a text marker.

ACP has no system prompt. The first prompt of a new agent session, not one resumed with `session/load`, starts with one more text block: what MendCode draws and where its docs are (`mendcode docs`), as [Claude Code](claude-code.md) gets after its prompt.

The agent's own prompt is untouched. The `minimal` prompt mode sends no such block.

### Streamed items and tool cards

`session/update` notifications become items:

| Notification | Item |
|---|---|
| `agent_message_chunk` | Streamed agent message |
| `agent_thought_chunk` | Reasoning |
| `tool_call` and `tool_call_update` | One tool card that completes on `completed` or `failed` |
| `plan` | Finished list card on every change |

Tool cards are drawn like MendCode's own. Once its input is known, a call of kind `execute`, `read`, `edit` (or a `write`), `search` or `fetch` takes MendCode's name and detail (`shell: <command>`, `edit: <path>`…).

- An edit shows its unified diff with line numbers: OpenCode's own `rawOutput.metadata.diff`, else a hunk built from the `diff` block, numbered from the call's location line or 1.
- A write shows `Created <path> (N bytes)`.
- Anything else keeps the agent's title and its text or raw output.

A plan card shows `todo d/n`, each entry with its priority. The progress row above the prompt and the dock follow it live ([the visible plan](layout.md#the-visible-plan)).

A plan sent again unchanged adds none; an empty plan after one clears the list. Everything else (commands, modes, history replay) is ignored.

### Permission requests

`session/request_permission` goes through the normal approval flow. The tool kind decides the class:

| Tool kind | Class |
|---|---|
| `read`, `search`, `think`, `fetch` | Read |
| `edit`, `delete`, `move` | Write |
| The rest | Execute |

Mode `full` approves, `edits` approves writes, `plan` refuses anything that is not reading, otherwise the user is asked.

| Answer | ACP selection |
|---|---|
| Approve once | `allow_once` |
| Approve for the session | `allow_always` |
| Deny | `reject_once` |
| Abandoned question | `cancelled` |

When the agent did not offer the preferred kind, the other one of the pair is used.

### Stop a turn

Stopping the turn sends `session/cancel`; the agent's `cancelled` answer ends the turn as stopped. An agent that does not answer within 5 seconds is cut off anyway.

### Turn outcomes

| Outcome | Result |
|---|---|
| `end_turn` | Ok |
| `refusal` | Error `acp_refusal` |
| `max_tokens` / `max_turn_requests` | Error `acp_limit` |
| JSON-RPC error | `acp_turn_failed` |
| Quiet agent | Never cut; runs as long as it would on its own. Esc stops it. |
| Process exits mid-turn | `acp_exited` with the end of its stderr |
| Unreadable command | `acp_missing` |
| Agent asks for sign-in (error -32000) | `acp_auth`; sign in with the agent's own CLI. MendCode does not run `authenticate`. |

### Process lifetime

One process per MendCode session stays up between turns. It stops:

- After 10 idle minutes.
- After 1 minute once no client shows the session (switched away or closed: each holds several hundred MB).
- When the session switches to another agent.

The next turn starts it again and resumes with `session/load`. The footer's provider for an agent's model is its harness (`OpenCode harness`), not a native provider.

Opted-in thread bridge turns use isolated processes that stop at turn completion, with fresh project-scoped leases each turn and raw tracing disabled.

## Limits

- Context, compaction and `/context` belong to the agent. Non-main roles (aside, dream, permission reviewer) cannot use an ACP model; a session on one falls back to the default model for those calls.
- No token usage or cost is shown: the stable protocol does not report it.
- Agents without HTTP MCP support cannot use MendCode's tools or the optional thread bridge; regular turns still work with an empty client server list.
- pi has no MCP client, and Codex runs one app-server for every session, so neither gets MendCode's tools; they keep their own.
- Sessions of an agent without `loadSession` lose their history when the process restarts.

### Per-turn selections and handoffs

Per-turn `--model acp:<name>` and `--agent` selections work like those of Claude Code (see [claude-code.md](claude-code.md)):

- The model routes that turn to the agent: other agent, other process.
- The MendCode agent is a permission ceiling plus instructions in front of the message.
- `--variant` is refused because ACP agents have no variants.

A fork of an ACP session hands the copied conversation to the agent on its first turn as a budgeted text handoff. So does a switch from another engine (see [sessions.md](sessions.md#portable-handoff-between-engines)).

## Catalog identity

The configuration UI uses `settings.get` and per-agent `settings.set { patch: { acpAgents: { name: { command, args, envKeys } } } }`; `name: null` removes an entry.

This writes the existing `acp-agents.json` atomically, with mode 0600, without putting env values in the settings table. Unrelated agents are preserved. Invalid JSON refuses edits rather than replacing the file.

Set `MENDCODE_ACP_TRACE=<file>` to log the JSON-RPC lines.

ACP models use `acp:<name>` or `acp:<name>/<model>` without a `ModelInfo.engine` value. Prefix routing preserves the specific agent identity in `engine_bindings` (`acp:<agent>`).

Model validation refuses ACP choices for non-main roles. Auxiliary resolution skips them even when saved older role settings reference one. The native permission reviewer also rejects them.

This works without changing protocol engine enums or introducing another external transport.
