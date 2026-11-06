# Sealed turn blocks

Goal: a short session (the blog's "read colors.css and list its colors", one turn, one tool call) stores under 3 KB.
Today it allocates 5,898 bytes; its 15 event rows alone 2,621.

## Measured (1,000 clones of the real session in a fresh database, allocated pages after VACUUM)

| Change | Bytes/session |
|---|---:|
| Today | 5,898 |
| Events of a finished turn in one zstd block | 4,059 |
| Events and engine messages in blocks | 3,629 |
| Plus the small usage tables folded into one row per session (estimate) | ~2,800 |

Small cuts that keep the format (dropping settled snapshots, ids repeated in payloads, the per-call profile) total
1,306 bytes and mostly overlap with what the block already removes.

## Codec

`packages/store/src/turn-blocks.ts`: one zstd frame per turn; sequence and time as varint deltas, types through a table
local to the block, payloads the stored strings unchanged. Decoding returns rows byte-identical to the `events` rows, so
every existing decoder (`eventFromColumns`, shared objects, profiles) applies unchanged. The blog turn: 1,957 → 919
bytes, 6 µs to decode.

## Constraint

`bun:sqlite` registers no SQL functions (only `loadExtension`), so SQL cannot read inside a block. 57 statements read
`events` (19 files, 61 `json_extract` calls, mostly `$.itemId`, `$.text`, `$.z`, `$.kind`, `$.status`).

## Plan

1. Table `turn_blocks(session_id, first_seq, last_seq, data)`; a settled turn's rows move into one block in the idle
   step after delta folding and snapshot pruning. Never a running turn, never a row a fork's `transcript_prefix` names.
2. The core reads (`readAfter`, pages, ranges, newest) merge blocks and rows in sequence order: session open, history
   and reconnect never go through SQL on sealed turns.
3. Every other statement must see sealed rows: each reader is classified (per-session JS over merged rows, item index,
   or unaffected because it only touches unsealed rows: delta folding, envelope migration, transient pruning).
4. Engine messages: the same block idea per turn, after events. Not done: on the real database they are already zstd
   per row, and one block per session saves 9% of their bytes (21.6 → 19.7 MB) against forks, undo cuts and shared
   objects that read them by index.
5. Migration: existing sessions seal in idle batches; unsealed sessions read exactly as before.

## As built

- A turn over 64 KB of stored rows seals as consecutive blocks of about 64 KB, so the newest page decodes one small block.
  A turn over 64 MB stays in rows.
- Before a turn seals, each completed item of it gets one more folding try; deltas left after that (reasoning and
  compaction items whose completion carries no text) are the item's content and seal with the turn.
- Recall reads `events_all` (sealed rows copied into an indexed temp table); stats reads `events_own_all`, whose temp
  table has no item index because no stats statement looks a row up by item. Each copies only the rows its statements can
  select (`ThawFilter`), and the stats event count comes from `turn_blocks.row_count`.

Real database copy (328 sessions, 479 MB): 210 MB after sealing and VACUUM (367 MB with VACUUM alone); every session's
exact read (`readExactAfter`) identical. Five alternating pairs, plain → sealed, 20 largest sessions: open newest page
7.7 → 9.8 ms, replay 562 → 513 ms, search 212 → 85 ms, stats 422 → 248 ms, recall turns 1,653 → 116 ms.

## Acceptance

Byte-identical rebuild of every event of the real database copy; the full suite; five alternating pairs of session
open, history page, search and stream p95 against main, no regression beyond noise; per-session bytes measured the
same way as the table above. Anything that regresses is not merged.
