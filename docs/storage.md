# Disk usage

Use the storage report to inspect disk use, compact old data and preview cleanup. The goal is thousands of sessions and worktrees in well under 1 GB.

Start with `mendcode --dir DATA storage` for disk, bytes per turn, snapshots, compression and top sessions.

Existing values stay readable. Completed streaming items are folded in the background while the daemon is idle; opening a database never migrates its event rows.

## Commands

```text
mendcode --dir DATA storage                       report: disk, bytes per turn, snapshots, compression, top sessions
mendcode --dir DATA worktrees list|size|gc [--yes] [--artifacts] [--idle 14d]   see Worktrees above
mendcode --dir DATA storage --worktrees           worktrees the daemon created: size, merged or not, why one is kept
mendcode --dir DATA storage --compact [--dry-run] pack old data, drop finished deltas (--delta-idle 3d)
mendcode --dir DATA storage --compact --offline [--dry-run] convert pages without starting a daemon
mendcode --dir DATA storage --clean [--older-than 90d] [--worktrees [--worktree-idle 14d]] [--dry-run] [--vacuum]
```

### Terminal actions

`/storage` has the same actions, each previewed with a dry run first:

| Key | Does |
|---|---|
| `c` | clean |
| `z` | compact |
| `w` | worktrees |
| `v` | vacuum |

### Cleanup and online compaction

`--clean` removes sessions idle past the cutoff, except those with:

- A running turn or queued message.
- A draft saved since the cutoff.
- A live loop's root.
- An unfinished workflow's sessions.

The same pass drops global events older than the cutoff (quota snapshots, job states), keeping settings history and the newest event.

Compaction works in bounded batches. When it says more remain, run it again.

**Warning:** `--vacuum` rewrites the database file and needs free disk equal to its size.

### Convert pages offline

`--compact --offline` is manual only and available from minimalist in every tier. A persisted `storage_compact: false` feature override refuses preview and execution before changing database bytes; `/tier storage_compact on` re-enables it.

1. Stop all readers/writers first. Do not restore a backup while the daemon is running.
2. Supply an explicit `--dir`. This path refuses remote/socket attachments and the store's writer lock, and opens no daemon.
3. Preview the conversion. Preview reads the current page size without modifying database bytes.
4. Execute the conversion. It leaves WAL mode, uses `VACUUM INTO` to create 16 KiB pages in the same directory, checks integrity and foreign keys, fsyncs and atomically renames the new database.

`.compact-*/original.db` keeps the previous database for recovery; the output includes that path. Blobs, encryption keys and other data-dir files stay in place.

The preserved backup occupies additional disk until you move it elsewhere. Small databases can grow with larger pages.

This path converts page layout only. It neither cleans sessions nor drops deltas, and cannot be combined with cleanup flags; existing row packing remains the separate online `--compact` operation.

## Folded streaming history

While an item runs, every delta remains durable. A self-contained completion folds those rows into one lossless compressed block in the same transaction.

Normal history reads the completion. Historical cuts and exact reconnect or synchronization recover original sequences, timestamps and text from the item's block; no model history is rebuilt to reopen a session.

Original rows stay when needed:

- Existing fork references keep their physical source rows.
- Empty or missing final text, blob-backed completions and oversized blocks retain their original deltas.

### Idle maintenance

Maintenance starts after a delay, pauses during active turns and jobs, and resumes from a persistent cursor. It returns pages using incremental vacuum; it never runs a full VACUUM at startup.

Foreground-state history is retained because compaction timing and automation still consume it. Storage reports count archived blocks in each session's bytes.

**Warning:** Older executables can read completed messages but cannot use archived delta blocks for exact replay or late mid-item cuts. Keep a pre-migration backup when testing this representation; do not downgrade a migrated directory.

### Delta-length blocks

When plain delta text concatenates exactly to the completion, an `MDL1` block stores varint sequence gaps, signed timestamp differences and UTF-16 chunk lengths instead of repeating text.

A historical read slices the completion using those lengths, including split surrogate pairs. Other items retain their compressed archive.

Idle batches also convert eligible existing tuple archives, with a resumable cursor and no startup scan. Executables predating `MDL1` cannot read these blocks; this experiment does not install or migrate live data.

## Event envelopes in columns

Every event row already holds its session, sequence, time and type in columns. A new row's JSON payload leaves out the leading envelope only when it is exactly the prefix `{"sessionId":…,"seq":…,"at":…,"type":…,`, which becomes `{`.

The full event rebuilds byte-identical. Readers put the envelope first again (`compress.ts`, `eventFromColumns`); an inherited fork row takes its session and sequence from the address, as `json_set` does for older rows.

### Conversion and compatibility

Rows written before this keep their envelope and read as before. After the delta phases, the idle batch converts them with its own cursor, checking each rebuilt payload before writing it.

A converted row frees space inside its page. The file itself shrinks with `storage --compact --offline` or `--vacuum`.

**Warning:** Earlier executables cannot read compact rows. Do not downgrade a written or converted directory.

### Measured results

On a private 863 MB copy, 1,953,057 rows converted with zero byte mismatches. Every replay, recall, revision and permission read compared equal to the previous build's, key order included.

| Measurement | Before → after |
|---|---|
| Payloads | 371 MB → 183 MB |
| `VACUUM INTO` | 813 MB → 606 MB |
| Allocated bytes per short or long session, session-disk probe | 5,571 → 4,424 (Pi: 4,096 short, 8,192 long) |

With fork object references held only by physical owners, a fork of the 40-turn disk-budget fixture grows by 83 KiB against 285 KiB for a physical copy. Before: 102 and 338 KiB.

## What a settled session no longer keeps

`foreground.state` and `queue.changed` are snapshots: each carries the whole state, and every reader of stored history uses the last.

When a session settles (its foreground state becomes `idle`), an idle step deletes earlier snapshots written by the running daemon. It runs 10 seconds after the daemon is idle and keeps the newest of each kind (`transient-events.ts`).

Exceptions and retained state:

- A restart in between leaves snapshots as they are.
- A reconnecting client still receives the newest snapshot.
- A run that compacted keeps all snapshots: the compaction view reads the state change that ended it.
- A row that a fork's transcript points at stays.
- Existing rows are not touched.

### Usage profiles and file snapshots

A `usage.recorded` request profile is stored as its eleven numbers in a fixed order (`compactProfile`) and read back as the same object. Earlier executables cannot read those rows.

A turn that changed no file in the default `tools` scope keeps no `turn_snapshots` row. A missing row reads as an unsealed, incomplete, empty one.

### Short-session fixture

`packages/daemon/test/real-session-disk.test.ts` drives one short turn through the daemon with a scripted model: a prompt, one `read`, a streamed answer, two usage records and a title.

It sums every column of the session's rows per table, the metric of the public comparison.

## Repeated fields in model messages and delta blocks

A model message with one of four fixed opening spellings stores one control character in its place (`message-prefix.ts`):

- `{"role":"user","content":`
- The assistant form.
- The assistant form with an empty reply and a tool call.
- `{"role":"tool","toolCallId":`

JSON never starts with a control character, so the codec expands it unambiguously. Rows written without it read unchanged; larger messages keep their zstd or shared-output form.

### Grouped delta columns

`MDL2` delta blocks store sequence steps, time steps and chunk lengths as three columns of groups. Each group is a repeated value or literals: a stream steps its sequence by one and mostly repeats its time and chunk size.

The writer keeps whichever of `MDL1` and `MDL2` is smaller; both read. The idle batch rewrites existing `MDL1` blocks on its own cursor (`delta-lengths-cursor-v2`) only when the columns are smaller and decode to the same entries.

Old model rows are not rewritten. Earlier executables cannot read either form.

## Preset dictionaries for small rows

zstd learns repeated text inside one frame. A row of a few hundred bytes or a short turn gains little: most is MendCode's own spelling, written once per row.

Two frozen dictionaries hold that spelling. Raw deflate (`node:zlib`, built into Bun) starts each small row with it; each dictionary is used only when it makes the row smaller.

A test pins each SHA-256 because every stored row was deflated against those exact bytes. A new dictionary is a new kind.

### Dictionary contents and gains

- Model messages under 1 KB (`message-dictionary.ts`, kind `D` of the `\0MZ1` header): the JSON envelope, the tool names
  and their argument keys, the `<orientation>` block and the read tool's numbered lines. On a real data directory's 6,495
  small rows: 46 % smaller than as text, against 31 % for zstd alone; about 9 µs to write a row and 3.5 µs to read one.
- Sealed turns of up to 32 KB (`event-dictionary.ts`, turn block version 2): event types, id prefixes and the keys of
  `item.*`, `queue.*` and `usage.recorded`. Turns under 4 KB are 17 % smaller than with zstd alone; larger turns keep
  zstd (version 1), and across all turns the gain is 1.5 %.

Neither dictionary holds a model name, a path past `/Users/` or any project or user text. Earlier executables cannot read the new forms.

The short real session above shrinks from 3,200 → 2,528 bytes. The auxiliary usage table no longer keeps a row per session: it keeps one per day, role, model and directory; no report read the session.

### Allocated growth

The probe's 100 sessions now add 24 pages beyond the empty store:

| Area | Pages |
|---|---|
| Events | 14 |
| Model history | 5 |
| Message-item index | 3 |
| Turns | 2 |
| Delta blocks | fit the page the empty table already has |

Allocated growth goes from 4,424 to 3,932 bytes per session, short and long (Pi: 4,096 short, 8,192 long).

A `VACUUM INTO` of the probe database is two pages smaller than the file as written, due to holes left by folded deltas and half-filled pages. The probe measures the file as written; it does not compact first.

Sessions without inherited transcript or model history read both by primary key. The inherited (fork) queries remain for the rest and join in key order; the model-history query used to scan every `engine_messages` row.

### Run the probe

`bun scripts/session-disk-probe.ts` measures an isolated persistence fixture. Optional `--pi-manager /absolute/path/to/pi/dist/core/session-manager.js` compares the installed Pi session writer with the same content, without provider calls.

It reports logical payloads, physical file growth, allocated bytes, CPU and latency separately. Fixed empty-database overhead is excluded from per-session growth and reported explicitly.

## Where the bytes went (measured)

### Profile and settings safety

Profile writes re-read the raw JSON and preserve unknown keys and uninterpretable values. Before atomic replacement, they save the previous bytes in `tui/backups/profile-<timestamp>-<unique>-<hash>.json`.

| Item | Value |
|---|---|
| Backup IDs shown by restore | `profile-<timestamp>` |
| File permissions | private (0600) |
| New profile and backup directory permissions | 0700. |
| Retention | newest 30 snapshots plus the newest snapshot of each day in the last 30 days, at most 60 |

Unchanged content does not create another backup. Startup compares a content hash with the newest backup and captures external changes; keys lost since that backup are recovered automatically.

Explicit restore also snapshots its target, so a later startup does not reverse a deliberate restore.

**Warning:** A stale `profile.json.lock` after a crash blocks writes safely. Remove that lock directory only after verifying no profile writer is running, then retry.

#### Restore daemon settings

Daemon settings use `settings_history` in `mendd.db`, with the same retention and database privacy/encryption as settings. Snapshot and settings write share a transaction.

| API | Does |
|---|---|
| `store.settings.history()` | lists IDs/times |
| `store.settings.restore(id)` | restores a raw snapshot, saving the current settings first |

This store API does not restore the separate ACP credential/config file. Invalid and future settings remain stored and are ignored only by the runtime view.

### Synthetic session comparison


`packages/store/test/disk-budget.test.ts` writes synthetic sessions (8 turns, 3 tool calls per turn: source and log
output, model history that repeats it, streaming deltas, 2 file snapshots per turn from a shared repository) into a temp
data dir, once the way `main` wrote them and once with this change. `MEND_DISK_REPORT=1` prints the table.

| per session | before | after |
|---|---|---|
| total on disk | 582 KB | 230 KB |
| event payloads | 124 KB | 81 KB |
| model history (engine messages) | 89 KB | 31 KB |
| undo snapshots | 187 KB | 29 KB |
| 2,000 sessions | about 1.16 GB | 382 MB |

These are synthetic: the ratios come from text that looks like code and logs, not from anyone's real data.

### Disk round 2 (2026-10-04)

The same disk budget test measured this worktree before changes:

| Fixture | Baseline | New content sharing |
|---|---|---|
| 60-session fixture, 8-turn sessions | 222,822 bytes per 8-turn session | 204,527 bytes/session (25,566 bytes/turn) |
| 2,000 sessions | 381,255,680 bytes (363.6 MiB, 190,628 bytes/session) | 345,686,016 bytes (329.7 MiB, 172,843 bytes/session, 9.3% less) |

The plan's older 230 KB / 382 MB values were rounded measurements from another run, not this baseline.

Both include SQLite/WAL/blob files after checkpoint, before any finished deltas are removed. The budget is now 350 MiB for 2,000 sessions, plus 210 KiB/session in the small fixture.

Fixed schema/index pages make the small fixture's per-session cost higher than the large fixture's.

#### Sharing and experiments

- Large tool transcript text and a model message's identical `role: tool` string content share one zstd object from
  the first write. Model envelopes preserve every other JSON field. Legacy TEXT/zstd rows still decode; explicit
  compaction revisits old packed output and its old progress marks once. Model-only content, undo stashes and forks
  keep their objects alive through replacement, parent deletion and garbage collection. User/assistant text stays
  available to SQL search. `eventObjectBytes` reports the shared objects separately from event/model envelopes.
- Prefix delta experiment: 128 held-out model rows, an anchor every 16 rows, compared suffix-zstd plus a 17-byte
  prefix/index envelope against each standalone row. **59,413 → 59,412 bytes** in the initial run (the reproducible
  test saved 2 bytes; random item IDs slightly vary the frames): no useful gain, not adopted.
- Dictionary experiment: trained local `zstd --train --maxdict=16384` on **640 synthetic rows written through our
  store**, then tested 128 separate rows. **59,413 → 40,922 bytes**, excluding the 16 KiB dictionary. This is an
  experiment, not shipped compression: Bun 1.3.13's zstd API accepts `level` only, and adding a native library or
  spawning a program per row is outside the dependency/performance contract. No user data or network was used.
  Reproduce both experiments with `MEND_DISK_REPORT=1 bun test packages/daemon/test/disk-experiments.test.ts`;
  that developer test skips when local `zstd` is absent and verifies every held-out row's exact roundtrip.
- Transcript and turn projections now resolve the inherited prefix through SQL views (details below).
  The current long-session fixture grows by **104 KiB/fork**, versus 526 KiB for a physical copy (formerly about
  290 KiB with model sharing alone). The fork budget is **115 KiB/fork** and at most 25% of a copy.
  The 100-fork fixture grows by **68 KiB/fork**, with an 80 KiB budget. Address tables/indexes add fixed overhead:
  the non-fork fixtures measured 154,283 bytes/session (60 sessions) and 235,356,160 bytes (2,000 sessions) on 2026-11-02 (README, Measurements).

## What changed

### Compression, sharing and page size

Tool results (and their live output), completed message text, model history rows and snapshot content over 1 KB use zstd when it saves space.

Completed messages keep compressed text inside their event instead of adding shared-object references per fork. Search and recall decode only the messages they read; incomplete message deltas remain uncompressed. Item id, kind and status stay queryable in SQL.

Snapshot file content is content-addressed (`snap_objects`, sha256). The same bytes before one turn and after the previous one, or in two sessions of the same repository, are stored once.

Objects nothing references go with the next clean, and after enough pruned snapshots.

A database created now uses 16 KB pages. In 4 KB pages every event over about 1 KB spilled into overflow pages and took 8 KB or more; an existing database keeps its page size because WAL mode cannot change it.

### Worktree cleanup

The daemon's worktrees are `git worktree add` checkouts. They already share the project's object store, so a worktree costs its working files and ignored build output; `storage --worktrees` measures allocated bytes.

Cleaning removes only worktrees meeting every condition:

| Condition | Meaning |
|---|---|
| Merged | branch is in HEAD or the default branch |
| Clean | no uncommitted or untracked files |
| Unused | no session, loop or workflow |
| Idle | idle for 14 days |

It uses plain `git worktree remove` and `branch -d`, with no `--force`, so git itself refuses unsafe removals. Old copies in the daemon trash go too.

The sweep covers project sandboxes and worktrees of loops, fan-outs, workflows (routing workspaces and merge worktrees) and compound runs.

A detached worktree counts as merged when its commit is in the project's history or held by a branch or tag. A compound run that ends with nothing changed removes its worktree at once, like a loop.

`mendcode worktrees list|size|gc` shows each worktree's size, state and why it is kept. `gc` only previews until `--yes`.

Worktrees shown by `git worktree list` that MendCode did not make appear in `list` and `size`. `gc --yes` removes them only under the same rules (clean, merged, idle); the daily pass never touches them.

### Measure many worktrees

Sizes come from the system's `du -sk`, at most two at a time; nothing is walked or kept in the daemon. A measured size is reused while the folder is unchanged, for 10 minutes at most.

| Command | Behavior |
|---|---|
| `worktrees list` | answers at once with known sizes, `?` for the rest, plus a note |
| `worktrees size` | measures everything and prints `measuring worktrees: n/m`; the request may take minutes |

Two identical requests at the same time share one scan. A scan stops when the requesting client has gone away; a removal already started finishes. The daily pass uses the same code.

### Worktree cap

`worktreeCapGb` in the settings file warns on the storage page when MendCode's own worktrees exceed it. Unset means no cap.

The daily pass and `gc --yes` then also free clean, merged, unused worktrees that are not idle yet, oldest first, until the rest fits.

Anything with changes, unmerged commits or a session stays, even over the cap.

### Remove build output

`mendcode worktrees gc --artifacts [--yes]` removes ignored output of idle, unused worktrees without removing the worktree. A directory must be ignored by git and hold no tracked file.

Eligible output: `dist`, `build`, `out`, `target`, `.next`, `.nuxt`, `.turbo`, `.svelte-kit`, `.parcel-cache`, `coverage`, `node_modules`.

It also removes `bun build --compile` leftovers (`.<hash>-00000000.bun-build`, as large as the executable) older than ten minutes in those worktrees and the projects' own checkouts.

`scripts/build.ts` deletes those older than five minutes next to its output after each build.

### Daily retention

`retentionDays` (daily 03:30) also compacts and drops streaming deltas of finished messages in sessions idle 3 days. The final text stays in the completed event.

`worktreeGcDays` (14 by default, `0` = off, `/settings`) adds worktree cleanup to the same daily pass. A per-session mark means a daily pass only reads what is new.

### Images pasted and never sent

A paste writes the image to `blobs/` before the message exists. When the message is never sent, the file has no `blobs` row.

The daemon's first idle step after startup removes such files once they are a week old (`removeStrayBlobs`). `storage --clean` removes them after an hour, as before.

Files a draft or queued message still holds are kept. Rows, sent images and sessions are never touched.

### Images are stored as sent

Attachments are content-addressed by the sha256 of the original bytes. An image pasted twice is one file; images are not recompressed.

On a real data directory (804 PNGs, mostly full-resolution screenshots), zstd saves 2 to 3%. Smaller encodings (re-deflated PNG, lossless WebP) change the bytes, breaking the hash each session, sync and the model read back.

Shrinking an attachment to what a provider sees would lose pixels, so it is not done.

## Forks share their history

A fork used to write its parent's model history and transcript again, so ten forks of a long session cost ten sessions.
Now (`packages/store/src/engine-history.ts`, `transcript-prefix.ts`, `event-objects.ts`; additive tables, nothing rewritten on upgrade):

### Model history by reference

A fork stores a prefix (`engine_prefix`: "messages 0..n of this engine are the ones of session X") and only its own new messages. Reads, appends, undo/redo, compaction and export use one resolver, so nothing else sees the difference.

Copy-on-write handles changes:

- When the parent undoes below the fork point or compacts, each fork still reading those rows first gets its own copy of just that tail.
- When the parent is deleted or cleaned by retention, its rows go to the fork needing the most of them (an UPDATE, no copy); other forks point at that one.
- A fork of a fork points at the deepest session holding the rows.
- A fork that compacts or edits a message in its prefix writes its own history from then on: no shared prefix remains to point at.

### Tool output and transcript references
- **Large tool output once.** New results go straight to `event_objects` (sha256 of the zstd bytes); older packed output
  moves there on compaction. Physical event rows keep their JSON shape and point at it
  (`zref`), and every session physically holding such an event has a row in `event_object_refs`. A fork reading the
  row by address relies on the owner's reference; when a deletion hands the row to the fork, the fork gets the
  reference with it. The object goes with the last session that references it (deleting a session, cleaning,
  `collectBlobs`).
- **Finished deltas are not repeated.** A fork's transcript leaves out the streaming deltas of items that have their
  final text (compaction drops them for the same reason); an item still open at the fork point keeps them.
- **Transcript and turns by reference.** A new fork stores event addresses in `transcript_prefix` and turn addresses
  in `turn_prefix`, not inherited event payloads or turn projections. `events_read` and `turns_read` resolve them
  for replay, pagination, search, recall, permission anchors, revisions, sync and undo. Event IDs/times stay intact;
  session IDs and dense fork sequence numbers are translated on read. Fork-of-fork addresses point straight at the
  physical owner, so reads never walk a recursive chain. Appends store only the fork's own events.
  A projection edit first freezes dependent forks and copies only the affected turn. Deletion/retention hands each
  physical row to one surviving reader, with the row's shared-output reference, and retargets the others, without
  N-way copies. Cleanup retains deltas still needed by a mid-turn fork.
- A duplicate index (`recall_event_items` was identical to `events_message_item`) is dropped when the store opens; it was
  about 14% of the events table for every session. Existing forks written before this stay as they were (copies); nothing is
  converted, and no VACUUM runs.

Measured (`disk-budget.test.ts`, `MEND_DISK_REPORT=1`; synthetic 40-turn session, 10 forks at its end): a physical copy
grows the files by 526 KiB, a shared fork by 104 KiB (20%); the model history of all ten is stored once (3,200
messages read, 572 KiB, no model rows added). The report separates the two costs: `engineBytes`/`eventBytes` are physical,
`sharedMessages`/`sharedBytes` are what forks read through a reference, `eventObjects`/`eventObjectRefs` the shared tool
output. `storage` prints a `forks:` line when any exists.

## Decisions

- Daily worktree removal is on by default (14 days; `worktreeGcDays: 0` turns it off) and removes only what a manual
  clean would: clean, merged, unused and idle, by plain `git worktree remove`. Manual cleaning always asks after a dry run. `storage.worktrees` and cleaning worktrees are refused for remote and peer clients, and
  `worktreeGcDays` cannot be set remotely; neither is a read-only command.
- Old data is not repacked on startup: `--compact` (or retention) does it, so an upgrade never makes the daemon busy.
- An existing database keeps its page size unless the user explicitly runs offline compaction; startup/retention never convert pages.
