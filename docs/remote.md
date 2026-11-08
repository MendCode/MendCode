# Remote attach

Attach your terminal to a daemon on another machine using an SSH tunnel, authenticated TCP or the opt-in HTTP adapter. Session paths and work run on the daemon; a remote attach never launches or manages a local daemon.

Start with [Setup](#setup) for TCP or [SSH tunnel: simplest safe path](#ssh-tunnel-simplest-safe-path) to forward an existing Unix socket.

## Session HTTP bridge (B87)

The daemon's `--http-listen 127.0.0.1:9877` opt-in flag enables four donor-shaped routes; no HTTP listener opens by default.
Only loopback is accepted. Use the existing remote token store and `Authorization: Bearer <token>`; read-only tokens,
browser `Origin` requests and revoked tokens are denied. Bodies are JSON, bounded to 80 KiB; responses disable caching.

- `POST /session/:sessionID/shell`: `{ agent, command, messageID?, model?: { providerID, modelID } }`. Runs a native shell
  turn without a model call and waits for completed output (120 s deadline, abort cancels). Commands are at most 8,000
  characters; optional `messageID` is a unique v2 item ID. Returns bounded `{ info, parts }` with v2 identifiers.
- `DELETE /session/:sessionID/message/:messageID`: tombstones a native item; returns `true`.
- `DELETE /session/:sessionID/message/:messageID/part/:partID`: deletes a native part; returns `true`.
- `PATCH /session/:sessionID/message/:messageID/part/:partID`: native text/file part plus matching `sessionID`, `messageID`
  and `id`; returns that part. `If-Match: N` supplies the expected revision (default 0), with the new revision in `ETag`.

Edits require `allowMessageEdits: true` and the history safeguards in [sessions.md](sessions.md). This is an additive v2
bridge, not a complete v1 HTTP server or SDK schema. The TUI and regular clients continue using the framed protocol.

TUI startup accepts `--server-url HOST:PORT` as an alias for `--connect` (B16). HTTP(S) URLs also work with `attach URL`, `--connect URL` and `--server-url URL` (B34); see the HTTP adapter below. TCP uses the v2 framed protocol and the token-file/TLS setup below. The separate `--attach` alias remains unassigned.
Incompatible `--password`, `--username`, and `--port` fail without revealing their values.

Remote TCP is opt-in. On Windows the local transport is a secret-gated loopback TCP port (`automation.md`, Windows); it is local, not a remote peer. The Unix socket stays available and uses the existing protocol without a token. TCP uses the same framing and reconnect cursors, with an authenticated first frame. TLS uses [Bun's TCP listeners](https://bun.sh/docs/runtime/networking/tcp).

## Setup

On the daemon machine, create a token against its explicit data directory:

```sh
mendcode remote token create --dir /srv/mendcode --name laptop
mendcode remote token list --dir /srv/mendcode
mendcode remote token revoke laptop --dir /srv/mendcode
```

`create` prints a random token once. Copy it into a private file on the client (mode 0600) or a secret manager that supplies `MENDCODE_TOKEN`.

| Command | Result |
|---|---|
| `list` | Prints name, scope (`full` or `read-only`), creation time and last-used time; never tokens or hashes |
| Revocation | Rejects subsequent requests and closes active streams within one second |

Tokens are stored as SHA-256 hashes in `<dir>/remote-tokens.json`, mode 0600. Names use 1–64 letters, digits, `_` or `-`.

### Start the daemon

Start a foreground daemon that listens (`daemon start` and the background service stay local-only, so a stray `remote.json` never opens a port on their own):

```sh
mendcode daemon run --dir /srv/mendcode --cwd /srv/project --listen 127.0.0.1:9876
```

No listener is enabled by default. Use literal `127.0.0.1` or `[::1]` for plaintext loopback. Hostnames, wildcard addresses and other IPs require both PEM files:

```sh
mendcode daemon run --dir /srv/mendcode --cwd /srv/project \
  --listen 0.0.0.0:9876 --tls-cert /srv/tls/server.pem --tls-key /srv/tls/server-key.pem
mendcode --connect server.example:9876 --token-file /private/path/mendcode-token --session SESSION_ID
```

Alternatively, save listener settings in `<dir>/remote.json` (flags override matching entries):

```json
{ "listen": "127.0.0.1:9876" }
```

For TLS use `tlsCert` and `tlsKey` with PEM paths. Certificate SANs must cover the hostname/IP used by the client. Protect the private key. A loopback TLS listener is supported too: pass `--tls` on the client.

TLS is automatic for any non-literal-loopback host. Certificate chain and hostname checks are mandatory; there is no insecure switch. For a private/self-signed CA:

```sh
mendcode --connect server.example:9876 --ca /private/path/ca.pem --token-file /private/path/mendcode-token
```

| Client option | Effect |
|---|---|
| `--ca` | Adds trust to the normal roots and enables TLS |
| `--token-file` | Takes precedence over `MENDCODE_TOKEN` |
| `--token` | No plain flag exists |

Transport flags also work with automation commands, for example `mendcode --connect server.example:9876 session list --all`.

### Choose a session

The TUI attaches to `--session`, otherwise the newest session. With no sessions a full token creates one in the daemon's reported project directory; a read-only token requires an existing session.

Session paths, mentions (`files.search`), diffs and custom Markdown commands resolve on the daemon. Switching sessions updates the remote directory.

A remote attach never launches, upgrades, shuts down for version freshness, or restarts a local daemon. Topbar/home show `remote <host>` and `read-only` where applicable.

## SSH tunnel: simplest safe path

Run the daemon normally, with only its Unix socket. Forward a local Unix socket with OpenSSH:

```sh
ssh -N -L /tmp/mendcode-vps.sock:/srv/mendcode/mendd.sock user@server
mendcode --socket /tmp/mendcode-vps.sock --session SESSION_ID
```

`--socket` explicitly attaches to the forwarded Unix endpoint without launching a local daemon. It applies the same remote TUI restrictions and reconnect behavior. The Unix endpoint has no TCP token handshake; SSH and socket permissions authenticate it, with full authority. Alternatively, enable the daemon's loopback TCP listener and tunnel that instead:

```sh
ssh -N -L 127.0.0.1:9876:127.0.0.1:9876 user@server
mendcode --connect 127.0.0.1:9876 --token-file /private/path/mendcode-token
```

The token is still required, while SSH encrypts the link. Keep local forwarded sockets private; remove only your own stale tunnel socket before reuse. SSH access to the daemon's Unix socket grants full daemon authority.

## Read-only attach

```sh
mendcode remote token create --dir /srv/mendcode --read-only --name observer
mendcode --connect server.example:9876 --token-file /private/path/observer-token --session SESSION_ID
```

Read-only tokens can subscribe, page history and run observational queries.

| Operation | Read-only behavior |
|---|---|
| Mutating commands: submit, shell, draft saves, settings, token-independent daemon shutdown, attachments and workflow controls | Return `forbidden` before retry-cache access |
| New command types | Denied until explicitly classified in the protocol |
| `secrets.reveal` | Denied; peers see secret markers and tails, never values |
| `extensions.list` and `status.watch` | Denied because they load executable extension code or start status scripts |
| Command discovery | Skips extension code and reads Markdown definitions only |

**Warning:** Read-only covers daemon-wide data, including sensitive queries. It is not a per-project privacy boundary.

## Terminal features while remote

Project scratchpads use daemon-side `scratchpad.get/set`, so writable remote terminals can edit them without local files. Read-only terminals may display them.

The remote TUI disables:

- Path/drop attachments (`/attach` and pasted paths), clipboard-image reads (`ctrl+v`), and the external editor (`ctrl+x e`); ordinary text paste and OSC 52 copy remain available.
- Local TUI extension loading, keybindings from `--dir`, pet discovery/cache, and all local TUI persistence: appearance profile, model favorites/recents, prompt stash and review comments. Transient in-memory editing remains available.
- Project-file export writes: use `/export --copy` or the headless `export` command to stdout.
- Workflow JSON files read by the terminal: use a daemon-side workflow name.
- Editing goals whose full objective lives in a file; inline goals still work.
- Remote use of local-only CLI commands: `acp` (editor-supplied local project paths), `upgrade` and `migrate-v1`. Invoke those without remote transport flags on the intended machine.

Startup shows a note; blocked actions show a terse explanation. Mentions, themes, changes and Markdown commands continue through the daemon and never inspect the client's project path. Tokens and CA files are the only remote setup files read by the CLI. `--dir` does not point the remote TUI at local configuration.

## Security

Bind loopback unless direct TLS access is needed. Restrict exposed ports with the host's network policy; prefer SSH tunnels.

Every TCP peer authenticates before commands. Failed auth closes the connection without echoing token contents, with per-address exponential backoff (250 ms to 30 s), bounded memory and a five-second auth deadline. Successful authentication does not erase that backoff.

**Warning:** Never put tokens in shell arguments, logs, screenshots or commits. Full tokens grant the daemon's complete command authority, including tools, shell and shutdown.

Unix sockets retain their filesystem-based trust; keep the daemon directory private.

## HTTP adapter (B34)

HTTP stays off by default. `serve` and `web` require an explicit data directory and at least one previously created remote token. They own a foreground daemon; SIGINT/SIGTERM stops listeners, streams and engine. Default binding is `127.0.0.1`, port `0` (allocated); `--hostname` accepts only loopback. `localhost` becomes literal loopback. Use an SSH tunnel for remote access.

```sh
mendcode remote token create --dir /tmp/mend-http --name terminal
mendcode serve --dir /tmp/mend-http --cwd /work/project --port 4096
mendcode attach http://127.0.0.1:4096 --token-file /private/token --continue --fork --diagnostics
mendcode web --dir /tmp/mend-http --cwd /work/project --port 4096 --no-open
```

### Use the browser client

1. Start `web`. It serves a dependency-free browser client at `/` and opens it unless `--no-open` is set.
2. Paste a v2 token into its password field. It stays in memory, with no cookies or browser storage.
3. Choose Chat, Files or Terminal. The Workspace selector uses registered workspaces from `/experimental/workspace` to retarget sessions, files and terminals through the `x-mendcode-workspace` header.

Sessions, prompts, cancel and streamed conversation use the same daemon. The conversation offers:

- Tool calls, with sub-steps hidden.
- Pending tool approvals: allow once / for session / deny.
- Simple questions with options or a typed answer.
- A model picker, rename, fork (with transcript) and a changes panel with per-file diffs, all through existing commands.

Read-only tokens see requests but cannot answer or change anything. Multi-question batches and plan reviews say to answer in the terminal UI.

| Pane | Capability | Opt-in |
|---|---|---|
| **Files** | Lists the project, opens any path and saves with `file.edit` ([file API](file-rest.md#browser-editor-file-edit)) | Saving needs `web --edit` (off by default); otherwise it is a read-only viewer |
| **Terminal** | Drives the [PTY API](pty.md) with a one-use ticket and a bounded line terminal: colors dropped, no full-screen programs | `web --pty`, off by default |

Read-only tokens get neither pane. `/` contains only the login shell; data, `/doc` and `/openapi.json` require auth.

**Note:** No real-browser visual check has been run. The client is covered by DOM-fake tests only.

### Authenticate an HTTP attach

HTTP accepts `Authorization: Bearer TOKEN`, or HTTP Basic with username `mendcode` and **a v2 token as password**. Arbitrary v1 passwords do not authorize a v2 daemon.

| Credential source | Rule |
|---|---|
| `--token-file` | Preferred to avoid shell history; wins over password, then `MENDCODE_TOKEN` |
| `attach --password TOKEN` / `-p` | v1 password spelling |
| `--username NAME` / `-u` | v1 username spelling |
| `OPENCODE_SERVER_PASSWORD` and `OPENCODE_SERVER_USERNAME` | Fallbacks accepted by HTTP alone |

URL credentials, fragments, query strings and paths are rejected. Plain HTTP attach requires loopback; HTTPS verifies certificates and supports `--ca`.

### Choose the HTTP project and session

For `attach`, `--dir` is the **server project directory**, passed unchanged even when absent locally. The daemon accepts its root or a registered local workspace.

| Option | Does |
|---|---|
| `--data-dir` | Retains its storage meaning |
| `--continue` | Resumes the newest project root |
| `--session` | Wins over continue |
| `--fork` | Requires one of these and preserves the transcript |
| `--diagnostics` | Enables the existing TUI diagnostics page |

Remote restrictions above remain in effect.

### Configure the listener

Listener settings can live under `server` in `<dir>/remote.json`, alongside existing TCP settings:

```json
{ "server": { "enabled": false, "port": 4096, "hostname": "127.0.0.1", "cors": ["http://localhost:3000"], "mdns": false, "mdnsDomain": "mendcode.local", "username": "mendcode" } }
```

Explicit flags override config. `--cors ORIGIN` is repeatable and replaces the configured CORS list when supplied.

- Origins must match exactly; wildcards, paths and URL credentials fail.
- Preflights disclose no data; all data calls require tokens.
- There is no cookie auth.

mDNS publication is withdrawn. Its CLI flags are usage errors, and `mdns: true` is rejected before launch or configuration writes. Legacy `mdns: false` and `mdnsDomain` remain readable for wire compatibility; they publish nothing.

### Protocol and workspace routing

The initial OpenAPI 3.1 contract describes `GET /global/health`, `POST /command` (the strict v2 command envelope, result JSON), `GET /wire` (WebSocket carrying unchanged v2 frames), `POST /event` (hello JSON or SSE v2 frames) and `/experimental/workspace` registration/list/status/adapter/removal. Session/config REST compatibility groups remain in batches B81–B86/B88; `/command` already exposes existing operations without another engine. Request bodies and WebSocket frames obey the protocol size limit; stream backlogs are bounded, subscriptions close on disconnect and revoked tokens close active streams.

Local workspaces register **existing directories**:

| Command | Does |
|---|---|
| `workspace.create { name, directory, adapter: "local" }` | Registers a directory |
| `workspace.query` | Lists workspaces/adapters/status |
| `workspace.remove` | Unregisters without deleting project files |

HTTP routing uses `x-opencode-directory`/`directory`, or `x-mendcode-workspace`/`workspace`. Symlinks resolve before routing; directory/session/parent mismatches are refused before replay-cache access.

Full tokens remain daemon-wide authority, not tenant credentials. Workspace commands are deliberately excluded from `READ_ONLY_COMMANDS`. Cloud provisioning, session warp and remote synchronization require a future adapter/service.

### Related REST adapters

B81 adds the [session REST adapter](session-rest.md), including native v2 pagination and cancellation. Its compatibility limits and full-token policy are documented there; it adds no terminal screens.

B82 adds [global/config REST](server-rest.md): health, read-only memory sampling, scoped config, logs, global SSE, instance disposal and an opt-in upgrade port. Unsupported v1 config and real upgrade integration remain explicit gaps.

Frames: `bun scripts/render-frames.ts .agents-frames/B34 --b34 100x30 180x50`.

The separate opt-in loopback HTTP coordinator (`--mflow-listen`) reuses full remote tokens: [Mflow](mflow.md) (B73). `session.share.get` requires full access because its service URL can grant access to shared content and its status may include private service errors.

B83 adds [catalog/provider/MCP REST](catalog-rest.md), including indexed OAuth, private credentials,
native tool schemas and explicit MCP connect/disconnect. Full-token and adapter limits remain explicit.

B84 adds [TUI control REST](tui-rest.md): opt-in project ownership, correlated UI requests and a polling bridge.

B88 adds the [permission/question/plan-review/memory REST bridge](interaction-rest.md), with donor payloads, native ids,
workspace-scoped pending lists and full-token replies. Memory side chat returns reviewable actions without applying them.

B35 adds the [file/find REST adapter](file-rest.md): donor content/list/search/status/symbol payloads, bounded native reads and full-token project authority. It adds no terminal page.

B89 adds the opt-in [PTY API](pty.md): owner-scoped interactive terminals, real resize, single-use WebSocket tickets and
cursor replay. Enable with `serve/web --pty`; no shell or PTY listener starts by default.

B13 adds the opt-in [Telegram chat bridge](channels.md): the daemon polls the Bot API outward and relays paired chats; its commands are local-only.
