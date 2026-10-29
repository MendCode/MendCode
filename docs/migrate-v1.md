# Importing legacy MendCode history

`mendcode migrate-v1` copies the history of a legacy MendCode data directory into a MendCode data directory. It is safe to run more than once, it never writes to the legacy MendCode directory, and it never decides the target for you.

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

Exit codes: `0` done, `1` done with session errors (or an unexpected failure), `64` usage, `65` refused.

## What is refused

- `--dir` or `--from` missing.
- `--dir` equal to or inside `--from`, or inside `~/.mendcode` or `~/.local/share/mendcode` (symbolic links are resolved first).
- `--from` without `mendcode-local.db`.
- A `--dir` that a MendCode daemon is using: stop it first (`stop MendCode first (a daemon is using <dir>)`). The import takes the same writer lock as the daemon.

## What is imported

Each v1 session becomes one v2 session, created at the v1 creation time with the v1 directory and title (an untitled session takes its first user text). Sessions without messages are skipped and counted; archived sessions are kept (and counted). A child session gets its parent when the parent is imported, also when the parent was created later; otherwise it is kept without a parent and counted as orphaned.

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

A turn ends with `turn.cancelled` (by the user) when the last assistant message failed with `MessageAbortedError`, `turn.failed` (code `v1_error`, the v1 message) for any other error, `turn.interrupted` (reason `restart`) when the user message got no reply, and `turn.completed` otherwise. Event times are the v1 times and never go backwards within a session.

Token usage and cost are not imported: no `usage.recorded` events are written, so the v2 usage pages show no tokens or cost for imported history. Tool and assistant durations do appear in the activity counters, dated by the day the item finished in v1.

### Engine context

So an imported session can be continued in MendCode, the native engine's history is written for it (`engine_messages`, engine `native`, the same `ModelMessage` payloads the daemon stores). Only what follows the last compaction is written: the summary as the first user message (with the native engine's own prefix), then user text (with attachments), assistant text, and each tool call with its result, at most 200 messages. Reasoning is not included. A tool that never finished gets an error result saying so. v1's `tail_start_id` (messages a compaction kept verbatim) is not used: the summary stands for everything before the compaction.

### Memories

`memory/entries.jsonl` becomes saved memories and `memory/archived.jsonl` archived ones. Scope `global` is a user memory; any other entry with a `cwd` is a project memory for that directory; the category is the first category id; the stored source is `v1:<source>` (the store reads any source other than `agent` back as `user`). Entries whose exact text already exists, and entries with sensitivity `high`, are skipped and counted. Texts over 2,000 characters are shortened.

## Not imported

Reported with their size and the reason, never copied: `session-transcripts`, `storage`, `snapshot`, `worktree`, `archive`, `log`, `memory/dream`, `generated_images`, `bin`, `tui`, and every other `*.db`. Sizes come from a bounded stat walk (a `>` in the summary marks a lower bound).

`auth.json` and `mcp-auth.json` are credentials: they are never opened and appear in the report only as "not migrated (credentials)".

## Safety and recovery

- The v1 database is opened read-only. With a live write-ahead log (`mendcode-local.db-wal` with content) it is a plain read-only connection, because the log has to be read; SQLite may update the transient `-shm` index in that case, never the database or the log. Without a log the database is opened `immutable`, so no `-shm` or `-wal` file is created next to it. Close legacy MendCode before migrating for a consistent copy.
- Every id is derived from the v1 id, so a rerun finds what it imported before. A session is marked complete only after all its events and its engine context are written; a session that throws (bad JSON, bad data URL, an event over the size limit) is deleted again, recorded in the report (at most 200 errors are kept) and the run continues. A run killed in the middle leaves at most one unmarked session, which the next run deletes and imports again.
- A rerun skips imported sessions and memories. It does not update a v1 session that grew after it was imported.
- Memory stays bounded: sessions are streamed in creation order and one message's parts are loaded at a time.
- Blob files written for a session that then failed stay in the store as orphans until the next storage clean.

## Report

`MigrationReport` (`schema: "mendcode-next.migrate-v1@1"`) has: session counts (seen, imported, already, empty, failed, archived, orphaned), messages, items by kind, turns by outcome, parts skipped by type, attachments (count, decoded bytes, unique bytes after dedupe, saved bytes), long texts, memories (imported, already, duplicate, skipped as high sensitivity, invalid, shortened), engine context (sessions, messages), not-migrated directories, credential files not read, errors and the duration.
