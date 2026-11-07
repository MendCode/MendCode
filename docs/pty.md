# PTY API (B89)

Use the PTY API for real interactive terminals owned by the daemon, independently of agent turns and background shell tools. PTY stays off by default; its only UI is the `web` client's Terminal tab.

## Enable terminals

Choose how to enable PTY:

| Option | Does |
|---|---|
| `serve/web --dir TEMP_DATA --cwd PROJECT --pty` | Enables PTY explicitly |
| `{"server":{"pty":true}}` in the explicit data directory's `remote.json` | Enables PTY through configuration |
| `--no-pty` | Overrides an enabled config |

The existing HTTP listener is opt-in, loopback-only and token-authenticated. `--pty` is a server opt-in, not permission for the terminal to create shells automatically.

PTY adds no terminal page to the TUI and no startup process. The browser's Terminal tab uses a line terminal over the ticket flow below: colors are dropped and full-screen programs are unsupported.

## Routes

| Route | Payload/result |
| --- | --- |
| `GET /pty/shells` | `{path, name, acceptable}[]`; installed shells, including excluded agent-shell choices |
| `GET /pty` | Active terminals belonging to this token and project |
| `POST /pty` | `{command?, args?, cwd?, title?, env?}` → terminal info |
| `GET /pty/:ptyID` | `{id, title, command, args, cwd, status, pid}` |
| `PUT /pty/:ptyID` | `{title?, size?: {cols, rows}}` → updated info; applies real PTY resize |
| `DELETE /pty/:ptyID` | Terminates the process, closes subscribers, invalidates tickets; returns `true` |
| `POST /pty/:ptyID/connect-token` | Header `x-mendcode-ticket: 1` (legacy `x-opencode-ticket` also accepted) → `{ticket, expires_in:60}` |
| `GET /pty/:ptyID/connect?ticket=…&cursor=N` | WebSocket, scoped one-use ticket; authenticated owner token also accepted |

### Ownership and project scope

All routes require full authority. A terminal belongs to the **token hash** that created it and its canonical project. Token names or client-provided owner fields cannot transfer ownership.

- Other owners receive 404 for specific IDs and an empty list.
- Local Unix clients share a local owner, separate from HTTP tokens; ticket issuance requires a remote token.
- `directory`/`workspace` and the existing routing headers select registered projects.
- `cwd` must resolve inside that project, including symlink checks.

| Condition | Response |
|---|---|
| Unknown IDs | 404 |
| Malformed payloads | 400 |
| Disabled/unavailable PTY | 501 |

Exited processes are removed automatically, matching v1. Instance disposal, daemon stop and token revocation also terminate owned PTYs.

## Connect with a ticket

Ticket creation requires both the token and the explicit header. Tickets permit browser WebSockets without putting long-lived tokens in URLs.

| Ticket property | Rule |
|---|---|
| Randomness | 256 random bits |
| Storage | Only hashes in memory |
| Lifetime | Expire in 60 seconds and are consumed once |
| Scope | Retain owner/project/PTY scope; die on deletion or revocation |

An unapproved browser Origin is rejected before token or ticket dispatch. Allowed origins follow the existing exact CORS list.

**Warning:** Do not log ticket URLs.

## Replay output and reconnect

Socket output is text. Replay ends with a binary control frame `0x00` followed by UTF-8 JSON `{"cursor":N}`. Cursor units match v1 JavaScript string offsets (UTF-16), not byte offsets.

| Cursor | Output |
|---|---|
| Omitted | Replays retained output |
| `-1` | Starts live |
| Last cursor on reconnect | Replays only later output |

The last 2 Mi characters are retained per PTY; replay is sent in 64 Ki-character chunks. Socket input may be text or binary UTF-8.

**Warning:** PTY output and argv can contain unredacted content. None of these commands enter READ_ONLY_COMMANDS or ordinary chat event streams.

## Limits and defaults

| Resource | Limit |
|---|---|
| PTYs/creations | 64 |
| Sockets per PTY | 8 |
| Active HTTP sockets | PTY upgrades stop at 128 |
| Outstanding tickets | 1,024 |
| Input per write/backlog | 128 KiB |
| Dimensions | 1–1,000 |

Slow readers close and reconnect from their cursor.

Default PTYs are 80×24 and use the preferred shell. They append `-l` for login shells, inherit daemon environment plus supplied overrides and force `TERM=xterm-256color`.

## Client helpers

Clients have these helpers:

- `ptyShells`, `ptyList`, `ptyCreate`, `ptyGet`.
- `ptyUpdate`, `ptyRemove`, `ptyConnectToken`.
- `connectPtySocket(remote, {ptyId, ticket, directory?, cursor?, onData, onCursor?, onClose?})`.

Socket helpers keep PTY traffic separate from framed commands. Reopen with a fresh ticket and the returned cursor.

## How it works

### Environment hooks

Trusted daemon extensions receive the existing `shell.env` hook before spawn. `sessionId` is the PTY id; `cwd` is the validated terminal directory. Returned values override user env before the fixed terminal markers.

Disposal/aborted HTTP creation while a hook is pending prevents spawn. Hook values obey the same env bounds, and no PTY env is broadcast to chat clients.

### Native driver

Native PTY uses Bun.Terminal on macOS/Linux with no new dependency. Windows ConPTY is off by default in this adapter: `MENDCODE_CONPTY=1` opts in when the runtime exposes `Bun.Terminal`, but is unverified.

The preferred Windows shell is `pwsh`, `powershell` or `%COMSPEC%`. `DaemonOptions.pty.driver` permits local fakes/embeddings; tests never open network ports or invoke a real shell.

The CLI startup graph remains free of PTY runtime/schema code.

The model's own interactive processes (`shell_session`, see `docs/interactive-tools.md`) use the same native driver but a separate registry. They are not listed by `GET /pty`, have no ticket or socket, and do not need `--pty`.

### Evidence

```sh
bun scripts/render-frames.ts .agents-frames/B89 --b89 100x30 180x50
bun scripts/pty-canary.ts --dir TEMP_PROJECT
```

Frames use the existing remote chat host, with local fake process state, at both sizes. The OS canary uses a real PTY and
an isolated bash without profiles/history, checks TTY stdin/stdout, Unicode, both resize sizes, cursor replay and cleanup.
Fake tests cover HTTP dispatch, auth/ownership, tickets, revocation, bounded buffers and client framing. A macOS canary
does not validate Linux or Windows behavior; Windows support remains a runtime gap.
