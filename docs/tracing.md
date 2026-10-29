# Tracing (B52)

`mendcode --dir DATA --trace` opts this local terminal into correlated daemon RPC, session/turn,
model-attempt, client-event and TUI-frame diagnostics. The flag works with an already running daemon
and survives client reconnects. `--trace=true`, `--trace=false` and `--no-trace` are accepted globally;
`MENDCODE_TRACE=1` enables tracing when no explicit CLI flag is given. Tokens after `--` stay literal.
Auto-launch keeps daemon-wide tracing off; the terminal owns its opt-in, and explicit off overrides the environment.
Help/version do not start a daemon. Remote attach cannot enable tracing.

Tracing adds no terminal chrome and records no row text or keystrokes. Samples contain only generated
session/turn/command IDs, protocol operation names, event sequence numbers, role enums, geometry, timing and numeric usage.
There are no prompts, answers, reasoning, paths, provider/model names, tool arguments/results,
HTTP headers, user names, credentials or exception messages. Model attempts include retries,
sub-agent and compaction calls; error/cancellation status is preserved without error text.

The daemon keeps the latest 512 spans in memory and writes `<DATA>/trace.jsonl` (0600, no symlinks).
The file resets before exceeding 1 MiB. IO/export errors increment counters and never fail a turn.
Session IDs group spans into a trace; model attempts are children of their active turn. CLI/daemon
RPCs share command IDs; received event samples share the daemon's session ID and sequence number.
Client sample timestamps use daemon receipt time with the bounded client duration, avoiding clock skew.

`settings.set` accepts `{ experimental: { openTelemetry: true } }`; unset/false is off. This setting
persists in the daemon database and takes effect at each call. It records native model spans and
their turn parents even without `--trace`, including single completions such as side questions and
memory maintenance. No collector is configured by default. External engine internals (Codex,
Claude, ACP) remain outside the native provider instrumentation.

Optional export uses [OTLP/HTTP JSON](https://opentelemetry.io/docs/specs/otlp/): set
`MENDCODE_OTEL_ENDPOINT` to an explicit `http://127.0.0.1:4318/v1/traces` (or literal `[::1]`, HTTP/HTTPS)
and supply `MENDCODE_OTEL_TOKEN` through the process environment. Export additionally requires
`experimental.openTelemetry: true`. The token is sent as a bearer header, never stored or returned.
Hostnames, non-loopback addresses, URL credentials/query/fragment and redirects are refused.
Exporter configuration is read at daemon startup; settings remain live. Export is best effort:
one request at a time, at most 256 queued spans, batches of 64, a one-second deadline and bounded
response parsing. Failure/rejection drops that batch and increments `exportErrors`; no network retry
loop runs in the background. Disabling the setting discards queued exports. Shutdown is bounded.

Protocol commands and typed client helpers:

- `trace.configure { enabled }` / `client.configureTrace(enabled)`: local, per connection, not persisted.
- `trace.record { sample }` / `client.recordTrace(sample)`: opted-in local clients only; strict content-free fields.
- `trace.query { sessionId?, limit? }` / `client.traces(sessionId?, limit?)`: safe read, limit 1–512.

The report includes `enabled`, `openTelemetry`, exporter mode and dropped/export/write-error counters.
Only `trace.query` is available to read-only remote tokens. Closing the last opted-in client stops
diagnostics; an explicit daemon `--trace`/environment opt-in keeps them enabled until daemon stop.
Disabling diagnostics does not disable the separately opted-in OpenTelemetry setting.

Tests use temporary directories, scripted models and injected local collector fakes with no network.
`bun scripts/render-frames.ts .agents-frames/B52 --b52 100x30 180x50` renders the unchanged home/chat
surfaces with the observer enabled through the app harness. No dependency or v1 runtime is imported.
