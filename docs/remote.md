# Remote attach

Attach your terminal to a daemon on another machine using an SSH tunnel, authenticated TCP or the opt-in HTTP adapter. Session paths and work run on the daemon; a remote attach never launches or manages a local daemon.

Start with [Setup](#setup) for TCP or [SSH tunnel: simplest safe path](#ssh-tunnel-simplest-safe-path) to forward an existing Unix socket.

For several people on one server with their own domain and passkeys, see the [gateway](gateway.md). Pair a terminal with `remote login URL`, then `attach URL`.

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

`create` prints a random token once; `--expires-days N` makes it stop working after N days (`list` shows when). Copy it into a private file on the client (mode 0600) or a secret manager that supplies `MENDCODE_TOKEN`.

| Command | Result |
|---|---|
| `list` | Prints name, scope (`full` or `read-only`), creation time and last-used time; never tokens or hashes |
| Revocation | Rejects subsequent requests and closes active streams within one second |

Tokens are stored as SHA-256 hashes in `<dir>/remote-tokens.json`, mode 0600. Names use 1–64 letters, digits, `_` or `-`.

### Bot tokens

`mendcode remote token create --dir DIR --name vorlen --bot /home/coder/bots/vorlen` makes a token for a chat bot (another program on another machine that sends each of its turns to this daemon). `list` shows it as `bot FOLDER`. The token may only:

- create sessions whose folder is inside `FOLDER` (symlinks are followed before the check), with no parent and no custom agent;
- on sessions inside `FOLDER`: subscribe, send text messages (no attachments), cancel a turn or take a waiting message out of the queue, answer approvals and questions (`request.resolve`), set the session's permission mode and run limits (`session.run.configure`, for example a system prompt), and delete the session;
- list the models (`models.list`).

Everything else is refused as `forbidden`, and the daemon's broadcasts (other projects, settings, quota, activity) are never sent to it. The turns still run as the daemon's own user with the daemon's own logins, so give the bot a folder of its own and keep the daemon's container or user as small as the bot deserves.

### Start the daemon

Start a foreground daemon that listens (`daemon start` and a background service installed without `--listener` stay local-only, so a stray `remote.json` never opens a port on their own; see [Remote daemon as a service](#remote-daemon-as-a-service)):

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

### Remote daemon as a service

The user service (launchd or systemd-user) is local-only unless it is installed with a listener, so it survives a reboot with its listener:

```sh
mendcode daemon service install --listener                       # listener from <dir>/remote.json
mendcode daemon service install --listen 100.64.0.9:9876 --tls-cert /srv/tls/c.pem --tls-key /srv/tls/k.pem
```

The same checks as `daemon run` happen before anything is written: a non-loopback address needs both PEM files, and a listener that could not start is refused instead of crash-looping under the service manager. The flags are kept in the service binding, so `restart` and `status` keep them; to change them, stop and reinstall. `daemon restart` of a daemon that listens (started with `daemon run --listen ...` or by another supervisor) starts the next one with the same `--listen`, `--tls-cert` and `--tls-key`. Every other background daemon (`daemon start`, loops, Dream) stays local. Tokens are still created with `remote token create`, and a remote client still cannot change host-local authority settings.

**Tailscale mode.** `remote.json` accepts `"mode": "tailscale"`: the listener binds only a literal Tailscale address (`100.64.0.0/10` or `fd7a:115c:a1e0::/48`; a name or any other address is refused, TLS is still required) and a peer from outside those ranges is rejected before it can authenticate. A certificate from `tailscale cert` works as `tlsCert`/`tlsKey`.

**Certificate renewal.** A daemon that listens with TLS notices when the certificate or key file is rewritten or replaced and serves the new certificate from then on, with no restart; open connections stay. A new pair that does not load is ignored and the previous one keeps serving. A daemon without TLS watches nothing.

### Remote engines

By default a remote client cannot run turns on engines that execute tools on the host (ACP agents, pi). The host can allow them with the local-only `remoteEngines` setting, for example `{ "remoteEngines": ["acp:hermes"] }` (`"acp"` allows every configured ACP agent, `"pi"` pi). Remote clients cannot change it, read-only tokens still cannot submit turns, and opencode and Cursor stay local. Telegram and Discord turns use the daemon's own socket and need no listing.

### Saved remotes and auto-connect

```sh
mendcode remote add vps vps.example:9876 --token-file /private/path/token --ca /private/path/ca.pem --default
mendcode remote list | default [NAME|none] [--local-first|--remote-first] | remove NAME
mendcode                       # connects to the default remote
mendcode --remote lab          # a named one; --local ignores the saved default
```

`<data dir>/remotes.json` (mode 0600) holds names, addresses and token-file and CA paths, never a token. An explicit `--connect`, `--server-url` or `--socket` wins. The default applies only to a bare terminal start (`mendcode`, `mendcode --session ID`), never to `daemon`, `session` or other commands. `remote-first` (the default) checks that the remote answers and otherwise starts on this machine with a one-line note; `local-first` uses a local daemon that already runs and goes remote only when none does. `--remote NAME` never falls back. A terminal without `remotes.json` reads nothing and loads nothing extra.

### One command for a VPS (`remote setup`)

For a Linux VPS with systemd and Tailscale (MagicDNS and HTTPS certificates enabled for the tailnet), where `ssh USER@HOST` already works without a password prompt:

```sh
mendcode remote setup vps.tailnet.ts.net --ssh user@vps --dry-run     # prints the plan; opens no connection
mendcode remote setup vps.tailnet.ts.net --ssh user@vps               # does it
mendcode                                                              # now connects to the VPS
```

HOST is the host's Tailscale name; the host must report the same name. The steps, each skipped when the host already has the result:

1. Check the host over SSH (read-only): Linux, systemd, Tailscale running.
2. Install MendCode with the official `install.sh` (https only, `--installer-url` to change it). The installer checks the binary's SHA256 and the signature when cosign is present. An installed version is kept; `--upgrade` replaces it, `--channel` picks stable, beta or nightly.
3. `tailscale cert` into `<remote dir>/tls` (default `~/.mendcode`, `--remote-dir`) and a systemd user timer `mendcode-cert.timer` that renews it every 30 days; the daemon reloads it without a restart. If `tailscale cert` needs permission, run `sudo tailscale set --operator=$USER` on the host once.
4. Write `remote.json` (`"mode": "tailscale"`, the host's tailnet address, port 9876 or `--port`; other keys already there are kept).
5. Create a token named after this device (`--device`, `--expires-days N` to make it expire) in the host's token store and save it to `<data dir>/remote/<remote>.<device>.token` (mode 0600; one file per host, so setting up a second host never replaces the first one's token). It is never printed or logged; `--rotate` replaces it.
6. `daemon service install --listener` and start (`--reinstall-service` to force; it stops a running service first, which refuses while a turn runs).
7. Save the remote (named after the host, `--name`) as the default (`--no-default` to skip) and check that it answers over the tailnet.

**Tailscale without root (userspace).** Many shared VPSes run Tailscale as an unprivileged user service (`tailscaled --tun=userspace-networking --socket ~/.local/state/tailscale/tailscaled.sock`, often with a `~/.local/bin/tailscale` wrapper). Setup supports this: it looks for `tailscale` in PATH, `~/.local/bin`, `/usr/local/bin`, `/usr/bin` and `/opt/homebrew/bin` (every remote script has those on its PATH), and uses `~/.local/state/tailscale/tailscaled.sock` when the system socket is absent. Name them yourself with `--tailscale PATH` and `--tailscale-socket PATH` (also on `remote pair`); the socket is passed to every `tailscale` call and to the renewal timer. Setup treats the host as userspace when its tailnet address is on no network interface (`tailscale status --json` has no field for the mode). Then the daemon cannot bind the tailnet address: `remote.json` gets `"listen": "127.0.0.1:PORT"` with the `tailscale cert` files and no `mode`, because userspace `tailscaled` accepts inbound tailnet TCP on its own address and dials `127.0.0.1` on the same port (`acceptTCP` in tailscale's `wgengine/netstack/netstack.go`; the [forum answer](https://forum.tailscale.com/t/why-does-localhost-work/4240) says such connections appear to come from the local machine). The saved remote still uses the tailnet name and port. This was confirmed live on a real userspace host: inbound tailnet TCP to the port reached a daemon listening on `127.0.0.1` with TLS, and a session list over the tailnet worked. `tailscale cert` needs no root with the user's socket. Setup prints which mode it found; `--dry-run` shows both.

**No HTTPS certificates in the tailnet.** If `tailscale cert` fails with "your Tailscale account does not support getting TLS certs", setup does not stop: it makes a private CA on the host with `openssl` (EC P-256; the CA key stays in `<remote dir>/tls`, mode 0600), signs a 825-day server certificate for the DNS name, the short name, the tailnet address and 127.0.0.1, copies `ca.pem` to `<data dir>/remote/<remote>.ca.pem` (0600) and saves the remote with that CA (`--ca`). There is no renewal timer: setup prints the expiry date, and running the same command again renews the certificate. Enabling HTTPS certificates in the Tailscale admin console and running setup again switches to real certificates. Without `openssl` on the host, setup stops and says to enable HTTPS certificates.

An SSH, Tailscale or certificate failure stops with the cause and what to do. Run the same command again to continue: finished steps are detected on the host or in the ledger `<data dir>/remote-setup/NAME.json` (mode 0600, no secrets).

**Another device** (needs SSH to the host): `mendcode remote pair vps.tailnet.ts.net --ssh user@vps --device tablet` creates that device's own token and saves the remote. `mendcode remote unpair tablet --remote vps` revokes it on the host, with its `-sync` token if it has one (connected clients drop within a second), and removes this machine's token file, sync token and session sync setup for that remote. Tokens never expire unless created with `--expires-days`; an expired token fails like a revoked one. There is no shared token: one name per device.

**Migrating** (all optional and previewable with `--dry-run`; credentials never travel):

| Flag | What moves |
|---|---|
| `--migrate-settings` | This machine's [config bundle](config-bundle.md) is imported on the host with `--rewrite-home` and `--on-conflict keep`: skills, commands, themes, preference settings. Provider credentials, tokens, `environment.enc`, keys and authority settings (permissions, tier, models) are left out or wait for approval on the host. Once per saved remote. |
| `--acp-agents` | ACP agents of this machine whose command is a plain program name found on the host's PATH, as command and args only. No `env` values, no credentials; sign in on the host. Agents already there are kept. To use one from this machine, the host lists it in `remoteEngines`. Hermes and other agents can run on both machines. |
| `--migrate-sessions` | Up to `--session-limit` (default 100) newest sessions of all projects, as transcripts imported on the host as new sessions (the host owns them afterwards; there is no offline merge). A project is matched by its normalized git remote plus the path inside the repo, after any `--path-map LOCAL=REMOTE` prefix rules; clones are looked for under `~/code`, `~/src`, `~/projects`, `~/work`, `~/dev`, `~/repos`, `~/git` and each `--search-root`. `--clone-missing` clones a repository the host lacks into `~/code` (the host needs git access). Sessions whose project is not on the host are skipped with the reason, and a later run moves them once it is. Exports are bounded (the `export` limit), and a cut one is noted. Attachment files and engine-side state (ACP session ids) do not move. |

**Keeping sessions in step:** `--sync` (on `setup` or `pair`) also creates a sync-only token and turns on [session sync](sync.md): the host's sessions show here as read-only mirrors, `mendcode sync take ID` continues one on this machine, and `mendcode sync handoff ID` gives the host a session made here.

Not done yet: the device-key challenge that would replace the bearer token and approval-code pairing without SSH.

### Code between machines (`remote code`)

Sessions move with `remote setup --migrate-sessions`; the code moves with git. Nothing here runs unless you type it, and none of it loads at start-up.

```sh
mendcode remote code handoff [PROJECT] [--git-remote origin] [--dry-run]   # on the machine you leave
mendcode remote code receive [PROJECT] [--git-remote origin] [--branch mend/wip-...] [--into DIR]   # on the machine you arrive at
mendcode remote code clone GIT_URL [--root DIR] [--search-root DIR] [--dry-run]
```

**Handoff.** It takes a snapshot of the working tree with a temporary index: tracked changes (including deletions and files staged as new) plus new files that are not ignored. The snapshot is committed on top of HEAD and pushed to a new branch `mend/wip-<branch>-<time>-<commit>` of the git remote (`origin` unless `--git-remote`). The push is never forced and the branch name is new each time. Your branch, index, files, stash and worktrees are not touched; `--dry-run` lists the changed files and pushes nothing. New files that look like credentials (`.env`, `*.pem`, `*.key`, `id_rsa`, `.npmrc`, ...) or are over 5 MiB are left out and named; more than 5,000 new files stops it (add the build output to `.gitignore`). A clean tree has nothing to hand off. The git remote must already be reachable with your own credentials (it never asks for a password).

**Receive.** It fetches `mend/wip-*` into remote-tracking refs only, picks the newest (or `--branch`), and checks it out with `git worktree add` in `<data dir>/remote-code/worktrees/` (or `--into`) on a local branch of the same name. It never changes your checkout, never resets or deletes a branch, and a second run reports the worktree that already exists. To bring the changes into your own checkout, `git cherry-pick --no-commit <commit>` (printed). Old `mend/wip-*` branches stay on the git remote until you delete them.

**Clone here.** `clone` looks under `--root` (default `~/code`), `--search-root` and `~/code`, `~/src`, `~/projects`, `~/work`, `~/dev`, `~/repos`, `~/git` for a clone with the same normalized git remote (the same matching as `--migrate-sessions`) and clones only when none exists.

**Live two-way sync (opt-in, per project).** Needs [Mutagen](https://mutagen.io) installed by you (MendCode does not bundle or install it).

```sh
mendcode remote code live enable [PROJECT] --ssh USER@HOST [--remote-path /abs/dir | --path-map LOCAL=REMOTE] [--ignore PATTERN] [--include-env]
mendcode remote code live status|resume|disable [PROJECT] [--name N]
mendcode remote code live list
```

`enable` finds the clone on the host by git remote (or uses `--remote-path` / `--path-map`) and refuses unless both clones are the same repository, on the same branch, at the same commit. It then runs `mutagen sync create` in `two-way-safe` mode, which keeps conflicts instead of overwriting either side. The `.git` folder, `node_modules`, `dist`, `build`, `.next`, `target`, `.venv`, `*.log` and `.env` / `.env.*` (unless `--include-env`) are never synced. After that each side commits on its own; fetch on the side that is behind. Nothing watches the branches between checks (Mutagen keeps syncing files after a checkout on one side), so run `live status` after switching a branch. `live status` compares the branches over SSH and pauses the session when they differ (`live resume` checks again before resuming) and shows Mutagen's state, conflicts and last error. `disable` terminates only sessions this command created (recorded in a ledger under `<data dir>/remote-code/`, mode 0600, no secrets) and leaves the files as they are. Without Mutagen, `enable` says so and does nothing.

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
