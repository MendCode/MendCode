# Tracing (B52)

Tracing lets you inspect correlated daemon RPC, session/turn, model-attempt, client-event and TUI-frame diagnostics for your local terminal. It adds no terminal chrome and records no row text or keystrokes.

## Enable tracing for your terminal

Start your local terminal:

```sh
mendcode --dir DATA --trace
```

The command `mendcode --dir DATA --trace` works with an already running daemon and survives client reconnects.

Auto-launch keeps daemon-wide tracing off: the terminal owns its opt-in. Remote attach cannot enable tracing, and help/version do not start a daemon.

| Flag or environment variable | Effect |
|---|---|
| `--trace=true` | Enable tracing; accepted globally. |
| `--trace=false`, `--no-trace` | Disable tracing; accepted globally. Explicit off overrides the environment. |
| `MENDCODE_TRACE=1` | Enable tracing when no explicit CLI flag is given. |

Tokens after `--` stay literal.

## What samples contain

Samples contain only generated session/turn/command IDs, protocol operation names, event sequence numbers, role enums, geometry, timing and numeric usage.

There are no prompts, answers, reasoning, paths, provider/model names, tool arguments/results, HTTP headers, user names, credentials or exception messages.

Model attempts include retries, sub-agent and compaction calls. Error/cancellation status is preserved without error text.

## Storage and correlation

| Storage | Limit or protection |
|---|---|
| In-memory spans | The daemon keeps the latest 512 spans. |
| `<DATA>/trace.jsonl` | 0600, no symlinks; resets before exceeding 1 MiB. |

IO/export errors increment counters and never fail a turn.

Spans are correlated as follows:

- Session IDs group spans into a trace; model attempts are children of their active turn.
- CLI/daemon RPCs share command IDs.
- Received event samples share the daemon's session ID and sequence number.

Client sample timestamps use daemon receipt time with the bounded client duration, avoiding clock skew.

## Enable OpenTelemetry

Use `settings.set` with `{ experimental: { openTelemetry: true } }` to record native model spans and their turn parents, even without `--trace`. This includes single completions such as side questions and memory maintenance.

| Setting behavior | Detail |
|---|---|
| Default | Unset/false is off. |
| Persistence | Saved in the daemon database. |
| Activation | Takes effect at each call. |
| Collector | None configured by default. |

External engine internals (Codex, Claude, ACP) remain outside the native provider instrumentation.

### Export to a local collector

Optional export uses [OTLP/HTTP JSON](https://opentelemetry.io/docs/specs/otlp/):

1. Set `MENDCODE_OTEL_ENDPOINT` to an explicit `http://127.0.0.1:4318/v1/traces` (or literal `[::1]`, HTTP/HTTPS).
2. Supply `MENDCODE_OTEL_TOKEN` through the process environment. The token is sent as a bearer header, never stored or returned.
3. Enable `experimental.openTelemetry: true`; export additionally requires this setting.

Exporter configuration is read at daemon startup; settings remain live. Hostnames, non-loopback addresses, URL credentials/query/fragment and redirects are refused.

### Export limits and failures

Export is best effort:

| Limit | Value |
|---|---|
| Concurrent requests | One request at a time. |
| Queued spans | At most 256 queued spans. |
| Batch size | Batches of 64, with the deadline below. |
| Deadline | One second. |
| Response parsing | Bounded. |

Failure/rejection drops that batch and increments `exportErrors`; no network retry loop runs in the background. Disabling the setting discards queued exports. Shutdown is bounded.

## Protocol commands and client helpers

| Protocol command | Typed client helper | Scope and limits |
|---|---|---|
| `trace.configure { enabled }` | `client.configureTrace(enabled)` | Local, per connection, not persisted. |
| `trace.record { sample }` | `client.recordTrace(sample)` | Opted-in local clients only; strict content-free fields. |
| `trace.query { sessionId?, limit? }` | `client.traces(sessionId?, limit?)` | Safe read, limit 1–512. |

The report includes `enabled`, `openTelemetry`, exporter mode and dropped/export/write-error counters. Only `trace.query` is available to read-only remote tokens.

Closing the last opted-in client stops diagnostics. An explicit daemon `--trace`/environment opt-in keeps them enabled until daemon stop.

Disabling diagnostics does not disable the separately opted-in OpenTelemetry setting.

## Implementation and verification

Tests use temporary directories, scripted models and injected local collector fakes with no network.

`bun scripts/render-frames.ts .agents-frames/B52 --b52 100x30 180x50` renders the unchanged home/chat surfaces with the observer enabled through the app harness. No dependency or v1 runtime is imported.
