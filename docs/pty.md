# PTY API (B89)

The daemon owns real interactive PTYs independently of agent turns and background shell tools. It stays off by default.
Use `serve/web --dir TEMP_DATA --cwd PROJECT --pty`, `--no-pty` to override an enabled config, or
`{"server":{"pty":true}}` in the explicit data directory's `remote.json`. The existing HTTP listener is opt-in,
loopback-only and token-authenticated. PTY adds no terminal page to the TUI and no startup process; the `web` client's Terminal tab is its only UI (line terminal over the ticket flow below; colors dropped, full-screen programs unsupported).

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

All routes require full authority. A terminal belongs to the **token hash** that created it and its canonical project;
token names or client-provided owner fields cannot transfer ownership. Other owners receive 404 for specific IDs and an
empty list. Local Unix clients share a local owner, separate from HTTP tokens; ticket issuance requires a remote token.
`directory`/`workspace` and the existing routing headers select registered projects. `cwd` must resolve inside that project,
including symlink checks. Unknown IDs return 404, malformed payloads 400, disabled/unavailable PTY 501. Exited processes
are removed automatically, matching v1. Instance disposal, daemon stop and token revocation also terminate owned PTYs.

Ticket creation requires both the token and the explicit header. Tickets contain 256 random bits, are stored only as
hashes in memory, expire in 60 seconds and are consumed once. They retain owner/project/PTY scope and die on deletion or
revocation. An unapproved browser Origin is rejected before token or ticket dispatch; allowed origins follow the existing
exact CORS list. Tickets permit browser WebSockets without putting long-lived tokens in URLs. Do not log ticket URLs.

Socket output is text; the replay ends with a binary control frame `0x00` followed by UTF-8 JSON `{"cursor":N}`.
Cursor units match v1 JavaScript string offsets (UTF-16), not byte offsets. Omitting cursor replays retained output; `-1`
starts live; reconnecting with the last cursor replays only later output. The last 2 Mi characters are retained per PTY,
and replay is sent in 64 Ki-character chunks. Socket input may be text or binary UTF-8. PTY output and argv can contain
unredacted content, so **none of these commands enter READ_ONLY_COMMANDS** or ordinary chat event streams.

Limits: 64 PTYs/creations, 8 sockets per PTY, PTY upgrades stop at 128 active HTTP sockets, 1,024 outstanding tickets, 128 KiB input per write/backlog,
dimensions 1–1,000. Slow readers close and reconnect from their cursor. Default PTYs are 80×24, use the preferred shell,
append `-l` for login shells, inherit daemon environment plus supplied overrides and force `TERM=xterm-256color`.
Trusted daemon extensions receive the existing `shell.env` hook before spawn (`sessionId` is the PTY id, `cwd` the validated
terminal directory); returned values override user env before the fixed terminal markers. Disposal/aborted HTTP creation
while a hook is pending prevents spawn. Hook values obey the same env bounds, and no PTY env is broadcast to chat clients.
Native PTY uses Bun.Terminal on macOS/Linux with no new dependency; Windows ConPTY is off by default in this adapter (`MENDCODE_V2_CONPTY=1` opts in when the runtime exposes `Bun.Terminal`; unverified), and its preferred shell there is `pwsh`, `powershell` or `%COMSPEC%`.
`DaemonOptions.pty.driver` permits local fakes/embeddings; tests never open network ports or invoke a real shell.

Clients have `ptyShells`, `ptyList`, `ptyCreate`, `ptyGet`, `ptyUpdate`, `ptyRemove`, `ptyConnectToken` and
`connectPtySocket(remote, {ptyId, ticket, directory?, cursor?, onData, onCursor?, onClose?})`. Socket helpers keep PTY
traffic separate from framed commands; reopen with a fresh ticket and the returned cursor. `--pty` is a server opt-in,
not permission for the terminal to create shells automatically. The CLI startup graph remains free of PTY runtime/schema code.

The model's own interactive processes (`shell_session`, see `docs/interactive-tools.md`) use the same native driver but a
separate registry: they are not listed by `GET /pty`, have no ticket or socket, and do not need `--pty`.

Evidence:

```sh
bun scripts/render-frames.ts .agents-frames/B89 --b89 100x30 180x50
bun scripts/pty-canary.ts --dir TEMP_PROJECT
```

Frames use the existing remote chat host, with local fake process state, at both sizes. The OS canary uses a real PTY and
an isolated bash without profiles/history, checks TTY stdin/stdout, Unicode, both resize sizes, cursor replay and cleanup.
Fake tests cover HTTP dispatch, auth/ownership, tickets, revocation, bounded buffers and client framing. A macOS canary
does not validate Linux or Windows behavior; Windows support remains a runtime gap.
