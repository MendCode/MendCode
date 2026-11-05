# Disk usage

Goal: thousands of sessions and worktrees in well under 1 GB. Existing values stay readable. Completed streaming
items are folded in the background while the daemon is idle; opening a database never migrates its event rows.

## Folded streaming history

While an item runs, every delta remains durable. A self-contained completion folds those rows into one lossless
compressed block in the same transaction. Normal history reads the completion; historical cuts and exact reconnect
or synchronization recover original sequences, timestamps and text from the item's block. Existing fork references
keep their physical source rows. Empty or missing final text, blob-backed completions and oversized blocks retain
their original deltas. No model history is rebuilt to reopen a session.

Maintenance starts after a delay, pauses during active turns and jobs, resumes from a persistent cursor and returns
pages using incremental vacuum. It never runs a full VACUUM at startup. Foreground-state history is retained because
compaction timing and automation still consume it. Storage reports count archived blocks in each session's bytes.

Older executables can read completed messages but do not understand archived delta blocks for exact replay or late
mid-item cuts. Keep a pre-migration backup when testing this representation; do not downgrade a migrated directory.

When plain delta text concatenates exactly to the completion, an `MDL1` block stores varint sequence gaps,
signed timestamp differences and UTF-16 chunk lengths instead of repeating text. A historical read slices the
completion using those lengths, including split surrogate pairs. Other items retain their compressed archive.
Idle batches also convert eligible existing tuple archives, with a resumable cursor and no startup scan.
Executables predating `MDL1` cannot read these blocks; this experiment does not install or migrate live data.

## Event envelopes in columns

Every event row already holds its session, sequence, time and type in columns. A new row's JSON payload leaves out
that leading envelope (`{"sessionId":…,"seq":…,"at":…,"type":…,` becomes `{`) only when it is exactly that prefix, so
the full event rebuilds byte-identical. Readers put the envelope first again (`compress.ts`, `eventFromColumns`);
an inherited fork row takes its session and sequence from the address, as `json_set` does for older rows. Rows
written before this keep their envelope and read as before; after the delta phases, the idle batch converts them
with its own cursor, checking each rebuilt payload before writing it. A converted row frees space inside its page;
the file itself shrinks with `storage --compact --offline` or `--vacuum`. Earlier executables cannot read compact
rows; do not downgrade a written or converted directory.

Measured on a private 863 MB copy: 1,953,057 rows converted with zero byte mismatches, payloads 371 MB → 183 MB
(`VACUUM INTO` 813 MB → 606 MB), and every replay, recall, revision and permission read compared equal to the
previous build's, key order included. The session-disk probe goes from 5,571 to 4,424 allocated bytes per short or
long session (Pi: 4,096 short, 8,192 long). With fork object references held only by physical owners, a fork of
the 40-turn disk-budget fixture grows by 83 KiB against 285 KiB for a physical copy (before: 102 and 338 KiB).

## What a settled session no longer keeps

`foreground.state` and `queue.changed` are snapshots: each carries the whole state and every reader of a stored history
uses the last. When a session settles (its foreground state becomes `idle`) the earlier ones written by the running
daemon are deleted by an idle step, 10 seconds after the daemon is idle, and the newest of each kind stays
(`transient-events.ts`; a restart in between leaves them as they are). A reconnecting client still receives the
newest snapshot; a run that compacted keeps all of them, because the compaction view reads the state change that ended
it, and a row that a fork's transcript points at stays. Existing rows are not touched.

A `usage.recorded` request profile is stored as its eleven numbers in a fixed order (`compactProfile`) and read back as
the same object (earlier executables cannot read those rows). A turn that changed no file in the default `tools` scope keeps no `turn_snapshots` row: a missing row
reads as an unsealed, incomplete, empty one. `packages/daemon/test/real-session-disk.test.ts` drives one short turn (a
prompt, one `read`, a streamed answer, two usage records, a title) through the daemon with a scripted model and sums
every column of the session's rows per table, the metric of the public comparison.

## Repeated fields in model messages and delta blocks

A model message that opens with one of four fixed spellings (`{"role":"user","content":`, the assistant form, the
assistant form with an empty reply and a tool call, and `{"role":"tool","toolCallId":`) is stored with one control
character in its place (`message-prefix.ts`); JSON never starts with one, so the codec expands it unambiguously and rows
written without it read unchanged. Larger messages keep their zstd or shared-output form. `MDL2` delta blocks store the
sequence steps, time steps and chunk lengths as three columns of groups, each a repeated value or literals, because a
stream steps its sequence by one and mostly repeats its time and chunk size; the writer keeps whichever of `MDL1` and
`MDL2` is smaller and both read. The idle batch rewrites existing `MDL1` blocks on its own cursor (`delta-lengths-cursor-v2`),
only when the columns are smaller and decode to the same entries; old model rows are not rewritten. Earlier executables
cannot read either form.

## Preset dictionaries for small rows

zstd learns repeated text inside one frame, so a row of a few hundred bytes or a short turn gains little: most of it is
MendCode's own spelling, written once per row. Two frozen dictionaries hold that spelling, and raw deflate (`node:zlib`,
built into Bun) starts each small row with it. Each is used only when it makes the row smaller, and a test pins its
SHA-256, because every stored row was deflated against those exact bytes: a new dictionary is a new kind.

- Model messages under 1 KB (`message-dictionary.ts`, kind `D` of the `\0MZ1` header): the JSON envelope, the tool names
  and their argument keys, the `<orientation>` block and the read tool's numbered lines. On a real data directory's 6,495
  small rows: 46 % smaller than as text, against 31 % for zstd alone; about 9 µs to write a row and 3.5 µs to read one.
- Sealed turns of up to 32 KB (`event-dictionary.ts`, turn block version 2): event types, id prefixes and the keys of
  `item.*`, `queue.*` and `usage.recorded`. Turns under 4 KB are 17 % smaller than with zstd alone; larger turns keep
  zstd (version 1), and across all turns the gain is 1.5 %.

Neither holds a model name, a path past `/Users/` or any project or user text. The short real session above: 3,200 →
2,528 bytes, with the auxiliary usage table no longer keeping a row per session (one per day, role, model and directory;
no report read the session). Earlier executables cannot read the new forms.

The probe's 100 sessions now add 24 pages beyond the empty store (events 14, model history 5, message-item index 3,
turns 2; delta blocks fit the page the empty table already has), so the allocated growth goes from 4,424 to 3,932 bytes
per session, short and long (Pi: 4,096 short, 8,192 long). A `VACUUM INTO` of the probe database is two pages smaller than
the file as written (holes left by folded deltas and half-filled pages); the probe measures the file as written and does
not compact first.

Sessions without inherited transcript or model history read both by primary key; the inherited (fork) queries are
kept for the rest and join in key order. The model-history query used to scan every `engine_messages` row.

`bun scripts/session-disk-probe.ts` measures an isolated persistence fixture. Optional
`--pi-manager /absolute/path/to/pi/dist/core/session-manager.js` compares the installed Pi session writer with the
same content, without provider calls. It reports logical payloads, physical file growth, allocated bytes, CPU and
latency separately; fixed empty-database overhead is not included in per-session growth and is reported explicitly.

## Where the bytes went (measured)

### Profile and settings safety

Profile writes re-read the raw JSON, preserve unknown keys and uninterpretable values, and save the previous bytes in
`tui/backups/profile-<timestamp>-<unique>-<hash>.json` before an atomic replacement. Backup IDs shown by restore are
`profile-<timestamp>`. Files are private (0600), new profile directories and backup directories are 0700.
Unchanged content does not create another backup. Startup compares a content hash with the newest backup and captures
external changes; keys lost since that backup are recovered automatically. Explicit restore also snapshots its target,
so a later startup does not reverse a deliberate restore. A stale `profile.json.lock` after a crash blocks writes safely;
remove that lock directory only after verifying no profile writer is running, then retry.

Retention keeps the newest 30 snapshots plus the newest snapshot of each day in the last 30 days (at most 60).
Daemon settings use `settings_history` in `mendd.db`, with the same retention and database privacy/encryption as settings.
Snapshot and settings write share a transaction. `store.settings.history()` lists IDs/times and
`store.settings.restore(id)` restores a raw snapshot, saving the current settings first. This store API does not restore
the separate ACP credential/config file. Invalid and future settings remain stored and are ignored only by the runtime view.


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

- **Compression.** Tool results (and their live output), completed message text, model history rows and snapshot
  content over 1 KB use zstd when it saves space. Completed messages keep compressed text inside their event instead
  of adding shared-object references per fork. Search and recall decode only the messages they read; incomplete
  message deltas remain uncompressed. Item id, kind and status stay queryable in SQL.
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
