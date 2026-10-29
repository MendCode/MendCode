# Global/config REST adapter (B82)

The [HTTP adapter](remote.md#http-adapter-b34) remains opt-in and loopback-only. Every route requires a v2 remote token. Only health and the memory sample accept read-only tokens; config and global SSE require full authority because they can include model parameters or conversation content. No new dependencies, background release checks or external services are started.

| Route | Result |
|---|---|
| `GET /global/health` | `healthy`, runtime `version`/`channel`, plus v2 protocol/build/listener metadata |
| `GET /global/diagnostics/memory` | `pid`, `role: server`, RSS/heap/external/array-buffer bytes, uptime seconds, guardrail |
| `GET /config`, `GET /global/config` | Effective project config or global config |
| `PATCH /config`, `PATCH /global/config` | Deep-merged configuration; arrays replace; returns the resulting config |
| `POST /log` | `{service, level: debug\|info\|warn\|error, message, extra?}`; returns `true` |
| `GET /global/event` | Live SSE with `event: message` and `{directory?, payload: {id, type, properties}}` |
| `POST /instance/dispose`, `POST /global/dispose` | Interrupt and release project/all session actors; returns `true`; server keeps listening |
| `POST /global/upgrade` | `{target?}` → `{success: true, version}` or `{success: false, error}` |

The memory sample performs no GC, heap snapshot, diagnostic-file write or provider call. RSS thresholds match v1: warning at 2 GiB, critical at 4 GiB. v2 has one state-owning daemon, so v1's optional shared-server lease diagnostics are omitted. Token authentication still updates the token's normal last-used metadata.

Global config accepts native v2 settings plus v1 aliases `model`, `small_model`, `subagent_model`, `subagent_variant`, `default_agent`, `plan_exit_agent`. Models use `provider/model`, must exist in the daemon's catalog, and map to native model roles. Alias/native conflicts fail atomically. `$schema` is accepted as metadata and not persisted. Unknown default agents fall back to Build on session creation. Project config accepts model roles, default agent/permission, and the existing per-project memory settings. Project overrides are private daemon settings keyed by canonical directory, independent of global settings and other registered workspaces; later global role changes remain inherited. Changes notify attached terminals and invalidate daemon extension/MCP caches for the next request without stopping active turns.

`x-opencode-directory`/`directory` and `x-mendcode-workspace`/`workspace` select an existing registered project. Donor config fields with no runtime equivalent (for example `theme` in project scope, or `server` in project scope) return 501, malformed values 400; nothing is silently stored. `provider` (public routing settings, never keys) and `shell` were already native; R9 adds the file-backed fields:

| Field | Global (`/global/config`) | Project (`/config`) |
| --- | --- | --- |
| `mcp` | `<data dir>/mcp.json`; entries are `{type: "local", command[], environment, cwd, enabled, timeout}` or `{type: "remote", url, headers, oauth, enabled, timeout}`; `{enabled}` toggles an existing one | `<project>/.mendcode/mcp.json` (only the project's own servers) |
| `plugin` | `mendcode.json` in the data dir: specifiers or `[specifier, options]`; new specifiers go through the offline plugin installer (`plugins.install`), omitted ones are removed | the project's `mendcode.json`/`.mendcode/mendcode.json` (loaded only when the project is trusted) |
| `server` | `remote.json` `server`: `port`, `hostname` (loopback only), `cors`; legacy `mdns: false`/`mdnsDomain` accepted, `mdns: true` rejected before writing; read on the next daemon start, never enables the listener | 501 |
| `shell` | setting | per-project override in `projectConfig`, used by commands run in that project |
| `instructions`, `skills` | settings | `.mendcode/project.json`; paths must stay inside the project, remote URLs are stored for `skills.urls` only (never fetched) |

Servers are not started by a config write: MCP connects lazily, and the daemon only invalidates its MCP/extension caches. Reads mask secret-looking values (`env`/`headers`/plugin option keys such as `token`, `key`, `authorization`, URL query values, `oauth.clientSecret`) as `[redacted:secret]`; sending that placeholder back unchanged keeps the stored value, and anywhere there is nothing to restore it is a 400. Project reads report only the project's own `mcp`, `plugin`, `instructions` and `skills`, so read-modify-write never copies global values into a project. Validation runs before any file or setting is written; a plugin install failure after MCP or server writes leaves those writes in place. Project settings and project-file writes require a registered workspace and a full token. Decisions: non-loopback `server.hostname` is refused (the HTTP adapter stays loopback-only) and `server` never sets `enabled`.

Logs go through the daemon's configured sink and severity threshold. Known secret patterns are redacted in messages/extra metadata, and terminal control characters are removed. No log file or log-reading endpoint is introduced.

Global SSE has no historical replay; native `/event` and `/wire` retain their existing replay semantics. Without selectors it observes all projects; with selectors it observes that project plus global events. Session/global events use native v2 types and IDs inside the v1-style envelope. Disposal maps to `server.instance.disposed`/`server.disposed`; successful upgrade maps to `installation.updated`. Connected/heartbeat events use fresh IDs; heartbeat is every ten seconds. Backlog is bounded to 512 KiB per stream, all HTTP SSE shares a 128-stream cap, and cancellation/revocation/daemon stop releases subscriptions. Slow readers are closed and should reconcile via REST before reconnecting.

Disposal retains durable session history and queued prompts, releases actors and background shell tasks, and invalidates caches. It interrupts ordinary active turns with the existing restart reason. Active/scheduled loops and running workflows return 409 until explicitly stopped/paused; an active Dream run must finish first. Disposal does not silently rewrite their lifecycle. The same session can continue afterward. Disposal never calls daemon shutdown.

Runtime upgrade is disabled in the standard daemon (400, `success: false`); no release service or install method is assumed. An embedding may explicitly supply `DaemonOptions.runtimeUpgrade`, taking the validated target and request AbortSignal and returning the typed result. The adapter validates its result and redacts failures to `Update failed`. Production release/install integration remains blocked for SERVER-031; use the existing local [upgrade command](upgrade.md) until configured. Local fake-port tests prove dispatch, idempotent command replay and successful lifecycle events, not a real installation.

Native clients can use `serverHealth`, `serverMemory`, `serverConfig`, `updateServerConfig`, `disposeInstances`, `appLog`, `upgradeRuntime`. These helpers use the additive v2 command schemas and the existing transport. `server.memory` and `server.health` are the only B82 additions to `READ_ONLY_COMMANDS`.

B82 adds no terminal page or visual style. Config/lifecycle interaction frames of the existing chat:

```sh
bun scripts/render-frames.ts .agents-frames/B82 --b82 100x30 180x50
```

Project/worktree/workspace and local sync routes are documented in [project-rest.md](project-rest.md) (B85).
