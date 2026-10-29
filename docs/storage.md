# Disk usage

Goal: thousands of sessions and worktrees in well under 1 GB. Everything below is local and additive: an existing
data dir opens unchanged, every old value stays readable, and nothing is rewritten until you ask (or retention runs).

## Where the bytes went (measured)

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

Measured on this worktree before changes with the same disk budget test: **222,822 bytes per 8-turn session** in the
60-session fixture, and **381,255,680 bytes for 2,000 sessions** (363.6 MiB, 190,628 bytes/session). The plan's older
230 KB / 382 MB values were rounded measurements from another run, not this baseline.

The new content sharing measures **204,527 bytes/session** in the 60-session fixture (25,566 bytes/turn).
The 2,000-session fixture measures **345,686,016 bytes** (329.7 MiB, 172,843 bytes/session, 9.3% less). Both include SQLite/WAL/blob files after checkpoint, before any
finished deltas are removed. The budget is now **350 MiB for 2,000 sessions**, plus 210 KiB/session in the small fixture.
Fixed schema/index pages make the small fixture's per-session cost higher than the large fixture's.

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
  the current non-fork fixtures measure 206,165 bytes/session (60 sessions) and 345,800,704 bytes (2,000 sessions).

## What changed

- **Compression.** Tool results (and their live output), model history rows and snapshot content over 1 KB are stored as
  zstd. A tool event keeps its JSON shape (`text` is base64 zstd, `z` the original length), so item id, kind and status
  stay plain for every query. User and assistant messages are never compressed: search and recall read them in SQL.
- **Shared content.** Snapshot file content is content-addressed (`snap_objects`, sha256): the same bytes before one turn
  and after the previous one, or in two sessions of the same repository, are stored once. Objects nothing references go
  with the next clean (and after enough pruned snapshots).
- **Page size.** A database created now uses 16 KB pages. In 4 KB pages every event over about 1 KB spilled into overflow
  pages and took 8 KB or more. An existing database keeps its page size (WAL mode cannot change it).
- **Worktrees.** The daemon's worktrees are `git worktree add` checkouts: they already share the project's object store,
  so a worktree costs its working files and ignored build output. `storage --worktrees` measures them (allocated bytes).
  Cleaning removes only a worktree that is merged (its branch is in HEAD or the default branch), clean (no uncommitted or
  untracked files), unused (no session, loop or workflow) and idle for 14 days; it uses plain `git worktree remove`
  (no `--force`, so git itself refuses unsafe removals) and `branch -d`. Old copies in the daemon trash go too.
- **Retention.** `retentionDays` (daily 03:30) now also compacts and drops the streaming deltas of finished messages in
  sessions idle 3 days (the final text stays in the completed event). `worktreeGcDays` (off by default, `/settings`) adds the
  worktree cleanup to the same daily pass. A per-session mark means a daily pass only reads what is new.

## Forks share their history

A fork used to write its parent's model history and transcript again, so ten forks of a long session cost ten sessions.
Now (`packages/store/src/engine-history.ts`, `transcript-prefix.ts`, `event-objects.ts`; additive tables, nothing rewritten on upgrade):

- **Model history by reference.** A fork stores a prefix (`engine_prefix`: "messages 0..n of this engine are the ones of
  session X") and only its own new messages. Reads, appends, undo/redo, compaction and export go through one resolver, so
  nothing else sees the difference. Copy-on-write: when the parent undoes below the fork point or compacts, each fork that
  still reads those rows gets its own copy of just that tail first; when the parent is deleted (or cleaned by retention) its
  rows are handed to the fork that needs the most of them (an UPDATE, no copy) and the other forks point at that one. A
  fork of a fork points at the deepest session that holds the rows. A fork that compacts or edits a message in its prefix
  writes its own history from then on (there is no shared prefix left to point at).
- **Large tool output once.** New results go straight to `event_objects` (sha256 of the zstd bytes); older packed output
  moves there on compaction. Physical event rows keep their JSON shape and point at it
  (`zref`), and every session holding such an event has a row in `event_object_refs`. The object goes with the last
  session that references it (deleting a session, cleaning, `collectBlobs`).
- **Finished deltas are not repeated.** A fork's transcript leaves out the streaming deltas of items that have their
  final text (compaction drops them for the same reason); an item still open at the fork point keeps them.
- **Transcript and turns by reference.** A new fork stores event addresses in `transcript_prefix` and turn addresses
  in `turn_prefix`, not inherited event payloads or turn projections. `events_read` and `turns_read` resolve them
  for replay, pagination, search, recall, permission anchors, revisions, sync and undo. Event IDs/times stay intact;
  session IDs and dense fork sequence numbers are translated on read. Fork-of-fork addresses point straight at the
  physical owner, so reads never walk a recursive chain. Appends store only the fork's own events.
  A projection edit first freezes dependent forks and copies only the affected turn. Deletion/retention hands each
  physical row to one surviving reader and retargets the others, without N-way copies. Compression registers new
  object refs for inherited readers; cleanup retains deltas still needed by a mid-turn fork.
- A duplicate index (`recall_event_items` was identical to `events_message_item`) is dropped when the store opens; it was
  about 14% of the events table for every session. Existing forks written before this stay as they were (copies); nothing is
  converted, and no VACUUM runs.

Measured (`disk-budget.test.ts`, `MEND_DISK_REPORT=1`; synthetic 40-turn session, 10 forks at its end): a physical copy
grows the files by 526 KiB, a shared fork by 104 KiB (20%); the model history of all ten is stored once (3,200
messages read, 572 KiB, no model rows added). The report separates the two costs: `engineBytes`/`eventBytes` are physical,
`sharedMessages`/`sharedBytes` are what forks read through a reference, `eventObjects`/`eventObjectRefs` the shared tool
output. `storage` prints a `forks:` line when any exists.

## Commands

```text
mendcode --dir DATA storage                       report: disk, bytes per turn, snapshots, compression, top sessions
mendcode --dir DATA storage --worktrees           worktrees the daemon created: size, merged or not, why one is kept
mendcode --dir DATA storage --compact [--dry-run] pack old data, drop finished deltas (--delta-idle 3d)
mendcode --dir DATA storage --compact --offline [--dry-run] convert pages without starting a daemon
mendcode --dir DATA storage --clean [--older-than 90d] [--worktrees [--worktree-idle 14d]] [--dry-run] [--vacuum]
```

`/storage` has the same actions: `c` clean, `z` compact, `w` worktrees, `v` vacuum, each previewed with a dry run first.
`--clean` removes sessions idle past the cutoff except one with a running turn, a queued message, a draft saved since the
cutoff, a live loop's root or an unfinished workflow's sessions. The same pass drops global events older than the cutoff
(quota snapshots, job states), keeping the settings history and the newest event.
Compaction works in bounded batches; when it says more remain, run it again. `--vacuum` rewrites the database file and
needs free disk equal to its size.

`--compact --offline` is available from minimalist in every tier and is manual only. A persisted `storage_compact: false`
feature override refuses preview and execution before changing database bytes; `/tier storage_compact on` re-enables it. It requires an explicit `--dir`,
refuses remote/socket attachments and the store's writer lock, and opens no daemon. Preview reads the current page size
without modifying database bytes. Execution leaves WAL mode, uses `VACUUM INTO` to create 16 KiB pages in the same
directory, checks integrity and foreign keys, fsyncs and atomically renames the new database. `.compact-*/original.db`
keeps the previous database for recovery; the output includes that path. Blobs, encryption keys and other data-dir
files stay in place. The preserved backup occupies additional disk until the user moves it elsewhere. Small databases
can grow with larger pages. Stop all readers/writers first; do not restore a backup while the daemon is running.
This path converts page layout only; it neither cleans sessions nor drops deltas, and cannot be combined with cleanup
flags. Existing row packing remains the separate online `--compact` operation.

## Decisions

- Daily worktree removal is opt-in (`worktreeGcDays` unset), because it deletes directories. Manual cleaning always asks
  after a dry run. `storage.worktrees` and cleaning worktrees are refused for remote and peer clients, and
  `worktreeGcDays` cannot be set remotely; neither is a read-only command.
- Old data is not repacked on startup: `--compact` (or retention) does it, so an upgrade never makes the daemon busy.
- An existing database keeps its page size unless the user explicitly runs offline compaction; startup/retention never convert pages.
