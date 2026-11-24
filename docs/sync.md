# Session sync

Session sync keeps this machine's daemon and an always-on host (a VPS, set up with [`remote setup`](remote.md#one-command-for-a-vps-remote-setup)) in step while both are online. The host is the **hub**: it owns sessions. This machine is a **device**: it shows the hub's sessions and can continue one here. A session has one writer at a time; there is no offline merge.

Sync is off by default. With it off, nothing of it loads, no table is created and no turn does extra work.

## Turn it on

```sh
mendcode remote setup vps.tailnet.ts.net --ssh user@vps --sync      # or: remote pair HOST --ssh USER@HOST --sync
mendcode sync now                                                   # sync once now; it also runs every few seconds
mendcode sync status
```

`--sync` creates a second token on the hub, `<device>-sync`, that may only sync (it cannot run turns, read settings or anything else), saves it to `<data dir>/remote/<remote>.sync-token` (mode 0600) and writes `<data dir>/sync.json`. By hand, with a token from `mendcode remote token create --sync --name laptop-sync` on the hub:

```sh
mendcode sync enable vps --sync-token-file ~/.mendcode/remote/vps.sync-token [--path-map /Users/me/code=/home/me/code] [--no-memories] [--no-settings]
mendcode sync disable
```

The remote must be saved in `remotes.json` (`remote add` or `remote setup`). The hub needs nothing extra: the first device that syncs makes it a hub (it writes `sync-hub.json`); `mendcode sync hub-off` on the hub stops that once no device holds a session.

## Who writes a session

| Session | Here | On the hub |
|---|---|---|
| Made on the hub | A mirror: read-only, new turns arrive within a few seconds | Writes it |
| Taken here (`mendcode sync take ID`) | Writes it while it holds the lease | Refuses new prompts, naming this machine |
| Made here | Writes it; the hub does not see it | Sees it after `mendcode sync handoff ID` |

A refused prompt says which machine owns the session and the command that moves it. `mendcode sync release ID` hands a taken session back (it also happens by itself after 10 idle minutes). `handoff ID` copies a session made here to the hub, which owns it from then on; this machine keeps a mirror. Neither moves a session while a turn runs.

A lease lasts a minute and is renewed while this machine is online. If this machine stops or loses the network, the lease ends and the hub writes the session again. When this machine comes back:

- nothing unsent: the copy becomes a mirror again;
- turns that never reached the hub: the hub's copy is kept, this machine's copy is marked **diverged** and stays only here (it can be continued here as a separate session). Nothing is merged or interleaved.

## What syncs

- Sessions: every event, at the same sequence numbers on both machines; a retry or a repeated round stores nothing twice. Only finished turns travel; a running one follows when it ends. Title, archive and pin go both ways. Mirrors cover sessions updated in the last 30 days. Usage statistics stay with the machine that ran the turn.
- Attachments: copied in 128 KiB pieces, hash-checked; one over 8 MiB stays on its machine and the session shows a note.
- Memories (`--no-memories` to skip): user and project memories, newest edit wins, deletes travel.
- Preference settings (`--no-settings` to skip): the same ones the [config bundle](config-bundle.md) moves; the hub wins a conflict.

Never synced: provider credentials, tokens, `environment.enc`, keys, channel and Console state, engine bindings (ACP session ids), and authority or machine settings (permissions, tier, models, shell, remote engines). The hub refuses them even when asked.

## Projects

A session's folder is matched by the project's normalized git remote plus the path inside the repository, the same way [`--migrate-sessions`](remote.md#one-command-for-a-vps-remote-setup) does: `/Users/me/code/app/pkg` here and `/home/me/src/app/pkg` on the hub are one project when both clones have the same `origin`. `pathMap` rules (`--path-map LOCAL=HUB`) cover folders that are not git clones. A handoff whose project the hub does not have is refused with the reason; clone it there and try again. A mirror whose project this machine lacks keeps the hub's path.

## Limits and load

Each round sends at most 64 requests, one at a time; a history page holds at most 2,000 events or 160 KB; a session too large to carry is marked unsyncable with the reason. When the hub is unreachable, rounds back off up to a minute. Sync runs in the daemon, not in the terminal.

## Files

| File | What it holds |
|---|---|
| `sync.json` | This machine is a device: the remote's name, the token file, `pathMap`, `memories`, `settings` (mode 0600, no token) |
| `sync-hub.json` | This machine serves as a hub |
| `remote/<remote>.sync-token` | The sync-only token (mode 0600, never printed) |

The sync state (cursors, leases, owners) lives in tables of the daemon's database created the first time sync runs.
