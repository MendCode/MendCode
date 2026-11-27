# Session sync

Session sync keeps this machine's daemon and an always-on host (a VPS, set up with [`remote setup`](remote.md#one-command-for-a-vps-remote-setup)) in step while both are online. The host is the **hub**: it owns sessions. This machine is a **device**: it shows the hub's sessions and can continue one here. A session has one writer at a time; there is no offline merge.

Sync is off by default. With it off, nothing of it loads, no table is created and no turn does extra work.

## Turn it on

```sh
mendcode remote setup vps.tailnet.ts.net --ssh user@vps --sync      # or: remote pair HOST --ssh USER@HOST --sync
mendcode sync now                                                   # sync once now; it also runs every few seconds
mendcode sync status
```

`--sync` creates a second token on the hub, `<device>-sync`, that may only sync (it cannot run turns, read settings or anything else; `--run` lets it also run turns in the hub's projects, see [Running on the hub](#running-on-the-hub)), saves it to `<data dir>/remote/<remote>.sync-token` (mode 0600) and writes `<data dir>/sync.json`. By hand, with a token from `mendcode remote token create --sync --name laptop-sync` on the hub:

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

## Stop copying

Pick the smallest step that does what you want. Each one leaves what is already on the hub where it is.

| You want | Run | What happens |
|---|---|---|
| No configuration copied, sessions still sync | `mendcode sync follow off` | The parity check and its `--apply` stop running on their own. Sessions, memories and settings keep syncing. |
| No memories or settings copied | `mendcode sync enable REMOTE --no-memories --no-settings` | Rewrites the sync settings with both skipped. Re-enabling turns `--follow` off unless you pass it again. |
| All sync off | `mendcode sync disable` | Removes the sync settings from `sync.json`. Nothing more is copied in either direction. Copies already here stay here. |
| Also stop the hub accepting this device | On the hub: `mendcode remote token revoke DEVICE-sync --dir DATA` | Revokes the sync token. Use the name you gave it, `<device>-sync` by default. A `--run` token is revoked the same way. |

Notes:

- `sync disable` does not delete the sync-token file (`remote/<remote>.sync-token`) and does not touch the hub. Revoke the token on the hub if the device should lose access.
- Sessions this machine took (`sync take`) hold a lease on the hub. Run `mendcode sync release ID` first so the hub owns them again. Otherwise the hub takes them back when the lease ends, a minute after this machine stops renewing it.
- Turning sync back on later with `mendcode sync enable REMOTE` picks the hub's sessions up again; a session that diverged here stays a separate copy.

## Running on the hub

A device whose sync token was made with `--run` (`remote setup HOST --sync --run`, or `remote token create --sync --run` on the hub) can work on the hub's chats and projects from here. A chat started in a folder that is only the hub's, a prompt, a cancel or an approval answer for a chat the hub owns goes to the hub, which runs it there; the turn streams back into this machine's copy while it runs, so the transcript, the approval card and the cancel work as in any chat. The tools and model are the hub's. A chat started from a device begins in the hub's `syncRunPermission` mode (`ask`, `edits` or `full`; default `edits`: file edits run, commands ask for approval, answered from the device); the device cannot change it.

The run token adds only these commands to what a sync token may send: start a chat (in a folder the hub already works in, with no parent, agent, model or title), send a prompt (text only, to a root chat of the hub that no device holds), cancel, answer an approval (without saving rules or memories), act on the chat's queue (send now, steer, drop, edit, move a queued message), `/cd` for a root chat of the hub (`session.cd`: the folder must exist on the hub and lie inside a folder it already works in, the same rule as a new chat, and the chat must be idle and not held by a device; the mirror follows with the hub's workspace change) and the folder list that `/cd` completion shows (`session.dirs`: the names of the subfolders of such a folder, nothing else, at most 500 names; no file names or contents). Paths in these two commands are the hub's: relative ones start at the chat's folder on the hub and `~` is the hub's home. A path outside the hub's project folders, or that does not exist, is refused with the reason; with the hub unreachable they say "hub is not connected". A hub built before these two commands answers that it does not know them (the device says to update the hub or make the token with `--run`); the existing `--run` token covers them, nothing is re-issued. It cannot run a shell, read files, change settings or a chat's permission mode, start sub-agents or touch anything else. A plain sync token (`--sync` alone) cannot run anything: the refusal says so.

### Live streaming

While a chat runs on the hub for this machine, the device keeps one extra connection to the hub with a long poll (`sync.peer` op `tail`, up to 20 s): the hub answers as soon as the chat has new events (after gathering what arrives within 20 ms), so streamed text reaches this machine about one round trip after the hub stored it, a few events at a time, instead of in bursts of the 300 ms polling round. The same ordering, de-duplication and settled-prefix rules apply; the polling round stays on as a 1.5 s safety net while the push works, and takes over at 300 ms when it does not. A hub that does not know `tail` (an older build) is simply polled; the device asks again after 10 minutes. The extra connection exists only while a hub chat is live, and the hub holds at most one wait per device.

### When the hub is away

A command of a chat the hub already owns (prompt, cancel, approval, queue action) given while the hub is unreachable is held on this machine and sent, in order, when the link is back; the screen says "sending when reconnected", and `mendcode sync status` shows how many are held. At most 32 are held, for at most 10 minutes each. Starting a new chat is refused with a short "hub is not connected" message instead. While something is held or a hub chat is live, the device looks for the hub again every 2 seconds at most (a quiet device backs off up to a minute).

## Keeping the hub like this machine

The hub should be set up like the machine you work on. Sessions, memories and preference settings already sync; `parity` carries the rest of the portable setup. It compares this machine (the reference) with the hub and, on request, brings the hub level.

```sh
mendcode sync parity [REMOTE]                 # compare; changes nothing
mendcode sync parity --apply                  # bring the hub level (same as: remote parity --apply)
mendcode sync parity --apply --code           # also send code that runs on its own
mendcode sync parity --apply --allow-flagged packages/NAME   # a reviewed folder the credential scan held back
mendcode sync enable REMOTE --follow          # or: sync follow on|off
```

| Compared | `--apply` does |
|---|---|
| Profiles (packages): present, same files, on or off, switched-off parts | Installs or replaces them with the profile installer and sets on or off as here |
| Skills, agents, themes, commands, recipes, prompt files (`APPEND_SYSTEM.md`, `SYSTEM.md`, `AGENTS.md`) | Writes the same bytes; a changed one replaces the hub's, with a backup |
| MCP servers | Adds them disabled and pending: approve each in `/mcp` on the hub and sign in there. A definition with a literal secret in `env` or `headers` is refused |
| Extensions and profiles with tools, hooks or extensions | Listed as `code` and held back; `--code` sends them |
| graft | Reported only: the version here and there. Parity installs no tools |
| Preference settings | Listed when they differ; session sync carries them (`--no-settings` turns that off) |

Left alone, always: what only the hub has (listed as `only there`), credentials and logins (providers, keys, MCP sign-ins, tokens), authority and machine settings (permissions, tier, models, execution, trusted folders), the terminal's own look (`tui/`, `activation.json`) and bot state. A unit the hub keeps behind a link (a `skills` folder pointing into a checkout) is `blocked`, never written through.

It runs on this machine and talks to the hub with the full token of the saved remote (`remote add NAME HOST:PORT --token-file F`; `remote setup` saves one). The hub accepts it only from a full token: a sync, run, bot or read-only token is refused, so a device that can only sync cannot change the hub's configuration. The hub checks the bundle's hashes, plans it as a configuration import that replaces what differs, and applies it with a journal and backups: `mendcode config-bundle rollback ID --dir HUB_DIR` on the hub undoes it. A bundle holds at most 32 MiB.

`--follow` repeats the same comparison and apply, without `--code` or `--allow-flagged`, while sync runs: at most every 10 minutes and on each `sync now`. It reads and hashes the configuration folders at those moments only; with it off nothing runs and nothing loads. `sync status` shows the last check and what still differs.

## Projects

A session's folder is matched by the project's normalized git remote plus the path inside the repository, the same way [`--migrate-sessions`](remote.md#one-command-for-a-vps-remote-setup) does: `/Users/me/code/app/pkg` here and `/home/me/src/app/pkg` on the hub are one project when both clones have the same `origin`. `pathMap` rules (`--path-map LOCAL=HUB`) cover folders that are not git clones. A handoff whose project the hub does not have is refused with the reason; clone it there and try again. A mirror whose project this machine lacks keeps the hub's path. A new chat in that folder runs on the hub when the token allows it ([Running on the hub](#running-on-the-hub)), and is refused naming the hub otherwise.

## Limits and load

Each round sends at most 64 requests, one at a time; a history page holds at most 2,000 events or 160 KB; a session too large to carry is marked unsyncable with the reason. When the hub is unreachable, rounds back off up to a minute. Sync runs in the daemon, not in the terminal.

## Files

| File | What it holds |
|---|---|
| `sync.json` | This machine is a device: the remote's name, the token file, `pathMap`, `memories`, `settings`, `follow` (mode 0600, no token) |
| `sync-hub.json` | This machine serves as a hub |
| `remote/<remote>.sync-token` | The sync-only token (mode 0600, never printed) |

The sync state (cursors, leases, owners) lives in tables of the daemon's database created the first time sync runs.
