# Automation runtime

MendCode exposes the same session runtime used by the TUI through the public CLI. An external agent can create work, continue an existing session, wait for a terminal state, inspect progress, stream events, or cancel active work without duplicating the model/provider/session stack.

## Commands

All session commands accept `--dir <path>`, `--format table|json`, and `--json` (an alias for JSON output).

```bash
mendcode session create --title "Implement the feature" --format json
mendcode session send ses_... "Inspect the repository and implement the change" --format json
mendcode session status ses_... --format json
mendcode session inspect ses_... --format json
mendcode session wait ses_... --timeout-ms 1800000 --format json
mendcode session events ses_... --follow --format json
mendcode session cancel ses_... --format json
```

The available operations are:

- `create`, `list`, `get`, `inspect`, `rename`, `fork`
- `archive`, `delete`, `send`, `status`, `wait`, `cancel`
- `events` for persisted history or live events
- `export` for a complete session snapshot

`session send --async` starts a detached MendCode runtime and returns an acceptance envelope. Follow it with `session wait` or `session events --follow`. Without `--async`, `send` waits for the prompt operation to finish before returning.

## Versioned JSON contract

Every JSON line is an envelope with protocol `mendcode.cli.v1`:

```json
{
  "protocol": "mendcode.cli.v1",
  "kind": "event | result | error",
  "event": "session.completed",
  "eventID": "evt_...",
  "timestamp": 1760000000000,
  "sessionID": "ses_...",
  "data": {}
}
```

`eventID` is stable for a single emitted event. `session events` also includes the persisted `sequence` for historical records. JSON errors use the same envelope and exit non-zero. Secret-like fields such as API keys, authorization headers, passwords, cookies, bearer tokens, and private keys are redacted before they are emitted; normal usage counters such as `tokens.input` remain available.

`mendcode run --format json` is the lower-level streaming surface. It emits `session.started`, tool/step/text events as they arrive, and `session.completed` or `error` at the end. Use `--thinking` only when reasoning events are intentionally needed.

## Model and agent selection

Automation resolves the effective model through the same shared resolver used by the prompt UI. The effective precedence is:

1. explicit `--model provider/model` and `--variant`;
2. a newer local TUI model override;
3. the latest user-message model for an existing session;
4. the stored session model;
5. the selected subagent's model when the session uses a subagent;
6. the configured local role/agent model, project model, or provider fallback.

The selected agent is taken from `--agent`, the session, or the runtime default. Global/project model roles are read from the existing MendCode model configuration; automation does not maintain a second model registry.

## Inspection and lifecycle state

`session inspect`, `status`, and `export` expose the current session, messages, derived state, pending questions and permissions, plan reviews, child sessions, background tasks/subagents, owned loops, persisted events, and the current diff. Derived states include `running`, `retrying`, `waiting_for_input`, `waiting_for_approval`, `waiting_for_lock`, `waiting_for_subagent`, `completed`, `failed`, `cancelled`, and `idle`.

`session cancel` calls the real `SessionPrompt` cancellation path. It does not delete the session or its history. `session wait` polls the persisted runtime state with bounded timeout and interval settings, and returns a timeout envelope plus a non-zero exit when the deadline is reached.

## Integration guidance

- Treat stdout JSON as a line-delimited stream; do not parse human-readable output in automation.
- Store the returned `sessionID` and use it for later `send`, `status`, `wait`, `events`, and `cancel` calls.
- Use `events` for progress and `inspect`/`export` for a complete snapshot.
- Keep authentication and provider configuration in MendCode's normal local configuration. Do not put credentials in prompts, titles, or custom event data.
- The command is local-first and uses the selected project directory; it does not create a separate agent server or provider abstraction.
