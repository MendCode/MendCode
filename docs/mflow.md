# Mflow coordination (B73)

`/mflow` opens the room manager. Tab completes the slash text without executing it. In the page,
arrows select, Enter runs, Tab opens details, `r` refreshes, and Esc returns. Configure edits room,
relay, private token-file path and priority directly in the page; Enter saves, then Start is explicit.
Remove asks for `y` and moves configuration into `<dir>/trash`, preserving project files and the relay.
Panels use the shared grid; below 70 columns the manager and details occupy one column.

```sh
mendcode control-plane mflow status
mendcode control-plane mflow setup --room team/source
mendcode control-plane mflow activate --room team/source --priority 0
mendcode control-plane mflow start
mendcode control-plane mflow stop
mendcode control-plane mflow deactivate
mendcode control-plane mflow remove
mendcode control-plane mflow scan
mendcode control-plane mflow relay-guide
mendcode control-plane mflow plan
mendcode control-plane mflow doctor
mendcode control-plane mflow legacy-status
```

Standalone `mflow` accepts the same operations, `--json`, `--dir DATA` and `--project PATH`.
Headless setup uses flags and conservative local defaults; `/mflow setup` edits them interactively.
Activation is opt-in and saves configuration only. It starts disabled in a new data directory;
after a daemon restart saved enabled rooms require Start again. No project scaffold, installation,
file synchronization or network listener is enabled implicitly. Plan saves a dry run under the data
directory. Doctor checks token/URL readiness, plan presence and coordination availability.
Legacy status explicitly reports live sync unavailable rather than guessing installed package state.

The default relay is `embedded`: peers in this daemon use one serialized coordinator. Rooms isolate
file paths, write leases exclude other reads/writes, reads can coexist, and multi-file acquisition is
atomic. Peer and file leases expire (35 seconds by default, at most 120 seconds). Lease renewal and
release require the creating owner; expired leases cannot be renewed. Records are private (0600),
persist across restart until TTL, contain relative paths and opaque owner IDs, and carry no file contents.

Native `read`, `write`, `edit`, `multiedit` and `apply_patch` hooks resolve canonical paths (including
patch moves), await conflicts up to 90 seconds and block when enabled coordination is unavailable.
Running tools renew their leases, release them on tool completion or turn end, and cancel when renewal
fails. The live footer shows the waiting file and remaining timeout; it clears at acquisition,
cancellation and session switching. These guarantees cover named file tools; shell, custom tools and external Codex/Claude engines
can write outside these hooks. Outside-project paths fail closed while Mflow is enabled.

## Authenticated loopback relay

Use an existing v2 remote token, provisioned with `remote token create --dir RELAY_DATA --name mflow`.
Keep its value in a private regular file (0600) supplied through `--token-file`; Mflow reports never
return it. The optional daemon listener is off by default:

```sh
bun packages/daemon/src/main.ts --dir RELAY_DATA --cwd PROJECT --engine faux --mflow-listen 127.0.0.1:8787
mendcode mflow activate --room team/source --url http://127.0.0.1:8787 --token-file PRIVATE_FILE --dir DATA
mendcode mflow start --dir DATA
```

The coordinator protocol is `mendcode-v2-mflow`; only literal loopback HTTP/WS origins are accepted.
WebSocket spellings normalize to HTTP; this is an HTTP Request protocol, not legacy WebSocket signaling.
Redirects are refused. Use a user-managed SSH tunnel for a relay on another machine. Tokens are
authenticated for every request, revoked tokens fail immediately, read-only tokens cannot use Mflow,
and failed authentication is rate limited. Use separate tokens for independent trust domains.

The six audit endpoints are `GET /mflow/` (also `/mflow/status`), `POST /mflow/activate`,
`GET /mflow/scan`, `GET /mflow/relay-guide`, `POST /mflow/deactivate`, `POST /mflow/remove`.
JSON activation accepts `room`, `relayMode: "local"`, `signaling`, `tokenFile`, `hookPriority`;
raw secret inputs are refused. Additional `/mflow/health`, `/mflow/room?room=NAME` and
`POST /mflow/lease` support rooms and owner-bound joins/leaves/acquire/renew/release. Bodies are bounded
to 32 KiB. Scanning lists the actual listener and probes only an explicitly configured authenticated
loopback relay; it does not scan LANs. Native protocol commands are `mflow.query`, `mflow.change`,
`mflow.lease`, with typed client helpers. None is classified as read-only.

External `mflow-cli` relay compatibility and file sync remain blocked on a real service/protocol adapter.
Remote agent-command authority remains off; this batch shares lease metadata, never session content
or remote pause/stop commands. No external service is exercised by tests.

Frames: `bun scripts/render-frames.ts .agents-frames/B73 --b73 100x30 180x50` (temporary app harness).
