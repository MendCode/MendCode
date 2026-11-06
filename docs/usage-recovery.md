# Recover local harness usage

Recovery is explicit and local-only. It reads one selected JSONL session log, extracts usage metadata, and reconciles it with a linked, idle MendCode session. It never modifies the harness log or imports conversation content. It does not read login files or run an automatic home-directory scan.

Supported readers: Claude Code assistant-message usage, Codex `event_msg/token_count` cumulative usage, and Pi assistant-message usage. Other harness formats are unsupported, not zero usage. This does not promise compatibility with every version of those formats.

```sh
mendcode usage recover preview --session SESSION_ID --engine claude --from-file /absolute/session.jsonl --json
mendcode usage recover apply --session SESSION_ID --engine claude --from-file /absolute/session.jsonl --id PREVIEW_FINGERPRINT --json
mendcode usage recover undo --session SESSION_ID --engine claude --json
```

Use `--engine codex` or `--engine pi` for those logs. The preview includes observed, existing recovered and proposed recovered counters by local day, plus a fingerprint. Apply rejects a changed preview. Repeating the same import does not add its tokens again. Undo removes recovered observations for that session and engine only; original usage stays intact.

Claude and Codex logs must match the saved external session ID. Pi must match the saved session-file path. Shared bindings are refused. Symlink files, non-regular files, files larger than 32 MiB, unbound sessions and active sessions are refused. No data is sent to a provider.

Recovered tokens appear in Usage's day totals and project/directory filters. Model rows use `recovered:ENGINE` rather than guessing the original model. Costs, call counts, reasoning, lifetime insights and session counts are not reconstructed.

Reconciliation is deliberately conservative: per session, engine and local day, recovered tokens are the positive difference between imported counters and recorded counters. Pi subtracts all providers in the session to avoid duplication after a model switch. Partial logs may undercount; separately importing several disjoint files for the same day does not sum them. Claude sub-agent files are not discovered automatically. Codex counters before the first available cumulative sample cannot be assigned to earlier dates; use a complete log. Records with invalid dates or missing stable IDs are skipped. These limits mean recovery is not proof of an exact historical total.

This is a CLI entry point; no recovery button or automatic scan is added to the Usage page. New code must be installed/restarted before the command is available in an existing installation.
