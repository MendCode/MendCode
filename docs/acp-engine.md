# ACP agents

A session can run on any external agent that speaks the [Agent Client Protocol](https://agentclientprotocol.com) (Gemini CLI, Zed's adapters for Claude Code and Codex, and others). Configure the agent, pick its model in `/model`, and that session's turns go to it.

## Configure

`<dataDir>/acp-agents.json`:

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

Open `/acp` (also linked from `/settings`) to list agents: `a` adds, `e` edits, `d` removes after `y` confirmation, and `r` refreshes. The form takes a name, command, args as a JSON string array, and comma-separated environment keys. Names stay fixed when editing; recreate an agent to rename it. Environment values are never shown or returned to clients. Existing values are preserved for retained keys; new keys are stored as `${KEY}` references and resolved from the daemon environment (missing keys resolve to an empty string). Literal values configured by hand still work.

The UI uses `settings.get` and per-agent `settings.set { patch: { acpAgents: { name: { command, args, envKeys } } } }`; `name: null` removes an entry. This writes the existing `acp-agents.json` atomically, with mode 0600, without putting env values in the settings table. Unrelated agents are preserved. Invalid JSON refuses edits rather than replacing the file.

The file is re-read when it changes, so a new agent appears in `/model`. New sessions use edits; already-running agent processes keep their configuration until they exit or the daemon restarts (`restart to apply` on the page). A bad entry is skipped. The models appear only on the native engine (`engine: native`). Set `MENDCODE_ACP_TRACE=<file>` to log the JSON-RPC lines.

## The agent's own models

An agent that offers a `model` select in its `configOptions` (OpenCode does) gets one `/model`
entry per value: `acp:<name>/<value>`, named `<its name> · <Agent> harness` (`· OpenCode harness`, the registry's
name, else the id), after `acp:<name>` (`OpenCode harness`). The name tells them from the same models on a native
provider, which run on MendCode's own harness (`· OpenCode Zen`). The list is the one the agent
gave in its last `session/new`, `session/load`, `session/set_config_option` answer or `config_option_update`, kept in
`<dataDir>/acp-models.json`, so it appears after the agent's first turn and survives restarts. Choosing one sends
`session/set_config_option` before the prompt when the agent's value differs; a refused value fails the turn
(`acp_model`) with the agent's reason, and so does an `acp:<name>/<value>` for an agent with no model option.
`acp:<name>` leaves whatever model the agent is on. Every `acp:<name>/…` is the same engine as `acp:<name>`: switching
between them keeps the agent's session and process.

### Effort

An agent that offers an effort select (ACP category `thought_level`; OpenCode's `effort`) lists the levels of the model
in force: for OpenCode's `deepseek-v4.1-flash-free` `low`, `high`, `max` and `default`; a model with no levels has no
select. Each time it lists them, those levels (without `default`) become that model's `efforts` in
`<dataDir>/acp-models.json`, so `/model`, its ←→, F3 and `--effort` offer them for `acp:<name>/<value>` after the first
turn on that model. Before that, a model whose id is models.dev's `provider/model` (OpenCode's are) shows the levels
models.dev names for it ([providers.md](providers.md#reasoning-levels-from-the-catalog)); a level the agent does not list
then is not sent, and the agent's default applies. With neither, the model has no levels and `--effort` is refused. Before each prompt, after any model
switch, the session's effort is sent with `session/set_config_option` when it differs from the agent's; no effort asked
sends `default`, the agent's own level, and a level the model does not list sends `default` too. A refused level fails
the turn (`acp_effort`). Checked live on 2026-10-17 with OpenCode 1.19.3: the same question took 20 s and 1,719
characters of reasoning at `max`, 4.5 s and 873 at `low`.

## Offline registry (full tier)

Enable with `/tier full` or `/tier acp_registry on`, then open `/acp` and press `c`.
The bundled catalog lists Gemini CLI, Devin, Cline, Kimi CLI, Factory Droid, codex-acp, OpenCode
and Claude Agent (the maintained successor of claude-code-acp), with installation
instructions, upstream links and exact command/argument arrays. Catalog provenance:
[official ACP registry](https://github.com/agentclientprotocol/registry), curated 2026-10-04.
No network is required to browse, detect or add. Install manually outside MendCode,
using pnpm 11+ with release-age protection for npm packages, or the vendor's binary
instructions. Sign in using the agent's own CLI. The catalog never installs, downloads,
authenticates, launches or probes `session/new`.

`installed` means its executable is on the **daemon's PATH**, not that auth or ACP
readiness has been verified. `r` rechecks PATH. Enter adds only the selected preset to
`acp-agents.json`, even if missing; existing names refuse replacement. Choose the
resulting `acp:<name>` in `/model` to run through the existing daemon-owned ACP engine.
Catalog presets use no npx/uvx runner, so they do not implicitly download packages.
The `acp.registry` command (`operation: list|add`, `agentId` for add) is lazy-validated,
local-only, safe-mode disabled and excluded from read-only remote commands. Adding
is an explicit user configuration action; actual turns retain normal ACP approvals.
Remote/peer clients cannot edit `acpAgents` or submit ACP turns.

## Agent transport

MendCode starts the agent with its stdio as the transport (one JSON-RPC 2.0 message per line) and acts as the ACP client:

- `initialize` with protocol version 1. No file-system or terminal capability is offered, so the agent works with its own tools and sandbox, and a request for `fs/*` or `terminal/*` is answered method-not-found.
- `session/new` with the session's directory as `cwd`. An agent that advertises `mcpCapabilities.http` gets MendCode's own tools (feature `harness_tools`, balanced and full: code graph, memory, computer use when on, settings…) as the loopback `mendcode` server in `session/new` and `session/load`, with the same bearer, approvals and turn ownership as [Claude Code](claude-code.md); an agent without it gets an empty list and its own tools only. Full-tier per-agent [thread bridge opt-in](thread-mcp.md) supplies a loopback HTTP entry to both `session/new` and `session/load`, requiring advertised `mcpCapabilities.http`. The agent's session id is stored per MendCode session and agent. After a process restart the conversation is resumed with `session/load` when the agent advertises `loadSession`; otherwise a new agent session starts.
- `session/prompt` with the text and, when the agent accepts images, image blocks. Other attachments become a text marker.
- `session/update` notifications become items: `agent_message_chunk` a streamed agent message, `agent_thought_chunk` reasoning, `tool_call` and `tool_call_update` one tool card that completes on `completed` or `failed`, drawn like MendCode's own: once its input is known, a call of kind `execute`, `read`, `edit` (or a `write`), `search` or `fetch` takes MendCode's name and detail (`shell: <command>`, `edit: <path>`…), an edit shows its unified diff with line numbers (OpenCode's own `rawOutput.metadata.diff`, else a hunk built from the `diff` block, numbered from the call's location line or 1) and a write `Created <path> (N bytes)`; anything else keeps the agent's title and its text or raw output, `plan` a checklist card that keeps the first plan while it streams and is completed with the last one when the turn ends. Everything else (commands, modes, history replay) is ignored.
- `session/request_permission` goes through the normal approval flow. The tool kind decides the class (`read`, `search`, `think`, `fetch` read; `edit`, `delete`, `move` write; the rest execute). Mode `full` approves, `edits` approves writes, `plan` refuses anything that is not reading, otherwise the user is asked. Approve once selects `allow_once`, approve for the session `allow_always`, deny `reject_once`, and an abandoned question answers `cancelled`; when the agent did not offer the preferred kind the other one of the pair is used.
- Stopping the turn sends `session/cancel`; the agent's `cancelled` answer ends the turn as stopped. An agent that does not answer within 5 seconds is cut off anyway.

Turn outcomes: `end_turn` is ok; `refusal` and `max_tokens` / `max_turn_requests` are errors (`acp_refusal`, `acp_limit`); a JSON-RPC error is `acp_turn_failed`; a quiet agent is never cut (it runs as long as it would on its own; Esc stops it); a process that exits mid-turn is `acp_exited` with the end of its stderr; an unreadable command is `acp_missing`; an agent that asks for sign-in (error -32000) is `acp_auth` (sign in with the agent's own CLI; MendCode does not run `authenticate`).

One process per MendCode session stays up between turns and stops after 10 idle minutes, 1 minute once no client shows the session (switched away or closed: each holds several hundred MB), or when the session switches to another agent. The next turn starts it again and resumes with `session/load`. The footer's provider for an agent's model is its harness (`OpenCode harness`), not a native provider. Opted-in thread bridge turns use isolated processes that stop at turn completion, with fresh project-scoped leases each turn and raw tracing disabled.

## Limits

- Context, compaction and `/context` belong to the agent. Non-main roles (aside, dream, permission reviewer) cannot use an ACP model; a session on one falls back to the default model for those calls.
- No token usage or cost is shown: the stable protocol does not report it.
- The plan card updates at the end of the turn, not on every plan change.
- Agents without HTTP MCP support cannot use MendCode's tools or the optional thread bridge; regular turns still work with an empty client server list.
- pi has no MCP client, and Codex runs one app-server for every session, so neither gets MendCode's tools; they keep their own.
- Sessions of an agent without `loadSession` lose their history when the process restarts.
- Per-turn `--model acp:<name>` and `--agent` selections work like those of Claude Code (see [claude-code.md](claude-code.md)): the model routes that turn to the agent (other agent, other process), the MendCode agent is a permission ceiling plus instructions in front of the message, and `--variant` is refused because ACP agents have no variants. A fork of an ACP session hands the copied conversation to the agent on its first turn as a budgeted text handoff, and so does a switch from another engine (see [sessions.md](sessions.md#portable-handoff-between-engines)).

## Catalog identity

ACP models use `acp:<name>` or `acp:<name>/<model>` without a `ModelInfo.engine` value. Prefix routing preserves the specific agent identity
in `engine_bindings` (`acp:<agent>`). Model validation refuses ACP choices for non-main roles, and auxiliary resolution
skips them even when saved older role settings reference one. The native permission reviewer also rejects them.
This works without changing protocol engine enums or introducing another external transport.
