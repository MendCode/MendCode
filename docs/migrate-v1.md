# Importing legacy MendCode history

`mendcode migrate-v1` copies legacy MendCode history into a MendCode data directory you choose. It is safe to run more than once and never writes to the legacy MendCode directory.

1. Close legacy MendCode for a consistent copy.
2. Choose the source and target directories; the command never decides the target for you.
3. Run the import:

```
mendcode migrate-v1 --from <v1 data dir> --dir <v2 data dir> [--dry-run] [--since YYYY-MM-DD] [--no-memories] [--json]
```

| Option | Meaning |
| --- | --- |
| `--from D` | The legacy MendCode data directory. It must contain `mendcode-local.db`. Required. |
| `--dir D` | The MendCode data directory to import into. Required: there is deliberately no default, so the real data directory is never hit by accident. |
| `--dry-run` | Reads everything and prints the full report. Opens no MendCode store, creates no file. |
| `--since DATE` | Only sessions updated on or after `DATE` (UTC). |
| `--no-memories` | Skip the v1 memory files. |
| `--json` | Print the report as JSON instead of the summary. |

Progress goes to stderr (one line per 50 sessions with the elapsed time); the summary (or the JSON) goes to stdout. The report is also saved as `<dir>/migrations/v1-<timestamp>.json` (not on a dry run).

| Exit code | Meaning |
| --- | --- |
| `0` | Done |
| `1` | Done with session errors (or an unexpected failure) |
| `64` | Usage |
| `65` | Refused |

## What is refused

- `--dir` or `--from` missing.
- `--dir` equal to or inside `--from`, or inside `~/.mendcode-v1` (where v1's `~/.mendcode` is set aside) or `~/.local/share/mendcode` (symbolic links are resolved first).
- `--from` without `mendcode-local.db`.
- A `--dir` that a MendCode daemon is using: stop it first (`stop MendCode first (a daemon is using <dir>)`). The import takes the same writer lock as the daemon.

## What is imported

Each v1 session becomes one v2 session, created at the v1 creation time with the v1 directory and title. An untitled session takes its first user text.

- Sessions without messages are skipped and counted.
- Archived sessions are kept and counted.
- A child session gets its parent when the parent is imported, also when the parent was created later. Otherwise it is kept without a parent and counted as orphaned.

Each v1 user message opens a turn. The assistant messages after it, up to the next user message, add items in part order:

| v1 | v2 |
| --- | --- |
| user text (not synthetic, not ignored), joined with a blank line | `user_message` |
| file part with a `data:` URL | decoded, stored as a blob, attached to the user message (identical bytes are stored once) |
| file part with another URL | a text line `[file: <name> <url>]` |
| `reasoning` | `reasoning` item, text only (the provider metadata and encrypted content are dropped) |
| `text` | `agent_message` |
| `tool` | `tool_call` with meta `tool` and `title`; text is the output, or the error; completed is `ok`, error is `error`, pending or running is `interrupted` |
| `compaction` part and its `summary` assistant message | one `compaction` item whose text is the summary |
| `patch`, `step-start`, `step-finish`, `agent`, `subtask` | nothing (counted in the report) |

Text longer than an event can carry (more than 64 KiB, or more than about 60 KiB once JSON-escaped) is stored as a `text/plain` blob with a 4,000 character preview as the inline text.

| Condition | Turn ending |
| --- | --- |
| Last assistant message failed with `MessageAbortedError` | `turn.cancelled` (by the user) |
| Any other error | `turn.failed` (code `v1_error`, the v1 message) |
| User message got no reply | `turn.interrupted` (reason `restart`) |
| Otherwise | `turn.completed` |

Event times are the v1 times and never go backwards within a session.

Token usage and cost are not imported: no `usage.recorded` events are written, so the v2 usage pages show no tokens or cost for imported history.

Tool and assistant durations do appear in the activity counters, dated by the day the item finished in v1.

### Engine context

You can continue an imported session in MendCode because the native engine's history is written for it: `engine_messages`, engine `native`, with the same `ModelMessage` payloads the daemon stores.

Only what follows the last compaction is written, at most 200 messages, in this order:

1. The summary as the first user message, with the native engine's own prefix.
2. User text with attachments, assistant text, and each tool call with its result.

Reasoning is not included. A tool that never finished gets an error result saying so.

v1's `tail_start_id` (messages a compaction kept verbatim) is not used: the summary stands for everything before the compaction.

### Memories

| Source or field | Imported as |
| --- | --- |
| `memory/entries.jsonl` | Saved memories |
| `memory/archived.jsonl` | Archived memories |
| Scope `global` | User memory |
| Any other entry with a `cwd` | Project memory for that directory |
| Category | First category id |
| Source | `v1:<source>`; the store reads any source other than `agent` back as `user` |

Entries whose exact text already exists, and entries with sensitivity `high`, are skipped and counted. Texts over 2,000 characters are shortened.

## Not imported

These are reported with their size and the reason, never copied:

- `session-transcripts`, `storage`, `snapshot`, `worktree`, `archive`, `log`.
- `memory/dream`, `generated_images`, `bin`, `tui`, and every other `*.db`.

Sizes come from a bounded stat walk. A `>` in the summary marks a lower bound.

`auth.json` and `mcp-auth.json` are credentials: they are never opened and appear in the report only as "not migrated (credentials)".

## Safety and recovery

### Read-only source

The v1 database is opened read-only. Close legacy MendCode before migrating for a consistent copy.

| Source state | How it is opened |
| --- | --- |
| Live write-ahead log (`mendcode-local.db-wal` with content) | Plain read-only connection, because the log has to be read. SQLite may update the transient `-shm` index, never the database or the log. |
| No log | `immutable`; no `-shm` or `-wal` file is created next to it. |

### Retry a failed import

Every id is derived from the v1 id, so a rerun finds what it imported before. A session is marked complete only after all its events and its engine context are written.

- A session that throws (bad JSON, bad data URL, an event over the size limit) is deleted again and recorded in the report. At most 200 errors are kept; the run continues.
- A run killed in the middle leaves at most one unmarked session, which the next run deletes and imports again.
- A rerun skips imported sessions and memories. It does not update a v1 session that grew after it was imported.

### Memory and orphaned blobs

Memory stays bounded: sessions are streamed in creation order and one message's parts are loaded at a time.

Blob files written for a session that then failed stay in the store as orphans until the next storage clean.

## Report

`MigrationReport` uses `schema: "mendcode-next.migrate-v1@1"`. It contains:

| Field group | Details |
| --- | --- |
| Session counts | Seen, imported, already, empty, failed, archived, orphaned |
| Messages and items | Messages, items by kind, turns by outcome, parts skipped by type |
| Attachments | Count, decoded bytes, unique bytes after dedupe, saved bytes |
| Long texts | Long texts |
| Memories | Imported, already, duplicate, skipped as high sensitivity, invalid, shortened |
| Engine context | Sessions, messages |
| Not migrated | Directories and credential files not read |
| Run | Errors and the duration |
