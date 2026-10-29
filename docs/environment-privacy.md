# Environment credentials and optional chat encryption

Both controls work in the **minimal, balanced and full** terminal views. The **minimalist tier** hides `/env` and `/privacy`, like other commands outside its 20-command set; use `/tier balanced` or list either command explicitly in the command editor. No release, protocol-version or database-schema bump is required.

## `/env`

Open the local credential panel:

- **a** adds a name and a hidden value; **tab** switches fields; **Enter** advances/saves.
- **Ctrl+S** selects project (default), session or global scope.
- **e** replaces a selected value without revealing the previous one.
- **x**, then **y**, removes a selected credential.
- **i** imports a dotenv file inside the current project. Enter previews names only; **y** imports after confirmation. A content digest prevents importing a file that changed since preview. The source file is not modified, deleted or encrypted.
- **r** reloads; **Esc** cancels an edit or leaves. Values never appear in rendered frames, prompt history, a chat message or a toast.

Project scope means the session's stored project directory. Session overrides project; project overrides global. Imported values are literal: quotes, comments, `export` and multiline quoted values are supported, but there is no shell execution or `${VARIABLE}` expansion. Empty imported assignments are skipped. Runtime configuration names such as `PATH`, `BASH_ENV`, `NODE_OPTIONS` and `LD_*` are refused; imports are validated and saved atomically.

The vault is `environment.enc`, an authenticated AES-256-GCM file with its own random 32-byte key in `keys/environment.key`. Credential values are encrypted regardless of chat encryption. Names/scopes are returned by `env.list`; there is no agent tool to reveal a value.

In the **native engine**, the model receives available names and instructions to use them directly, without asking the user again. Built-in `shell` and `shell_session` processes (including background commands) receive the applicable credentials. They do not require `keepSecrets: true`, and custom/overridden tools do not receive vault injection.

```python
import os
key = os.environ["MY_API_KEY"]
```

The daemon registers configured values with its existing secret masker before tool execution. Exact values and their JSON-escaped forms, including streaming chunks, become `‹env:NAME›` in results. These markers are output masks, not substitution tokens. Already-running processes keep their original environment; replacement/removal applies to new processes. Recently used values remain masked while their session is cached.

**Claude Code, Codex, pi and ACP agents** get the same credentials too: the values go into the environment of the process MendCode starts for the session, so their own shells inherit them, and Claude Code, Codex and pi are told the names in their system prompt (`--append-system-prompt`, Codex `developerInstructions`). ACP has no system prompt, so its agent only finds them in its environment. Codex normally drops inherited variables named like a key, secret or token; MendCode turns that filter off for the credentials while still excluding the daemon's own such variables by name. A credential added or changed later starts a new process at the next turn. Claude Code waits for that while one of its background agents runs, because a new process would stop the agent.

These engines print through their own tools, so MendCode **cannot mask** a value they print as `‹env:NAME›`; their models are told never to print them. To keep credentials native-only, set `engineEnvironment` to `false` (`settings.set { patch: { engineEnvironment: false } }` or the daemon's settings file; local clients only).

## `/privacy`

Opens the same panel with an encryption confirmation. **p**, then **y**, changes the setting. It is **off by default**; turning it off again restores ordinary SQLite/files for local analyzers. Conversion waits until active turns and scheduled jobs finish.

When enabled:

- The whole local `mendd.db` is an authenticated, versioned encrypted snapshot, including session titles, events, engine histories, drafts, memories, settings and rewind snapshots.
- SQLite executes in memory. Successful write operations/transactions synchronously save an encrypted snapshot with a fresh nonce through fsync + atomic rename. No decrypted database/temp/WAL file is created.
- Existing and future attachment blobs, compaction transcripts, saved tool outputs and application-owned goal objective files are encrypted too. Built-in native `read` and attachment APIs decrypt them in memory. Ordinary `cat`, external `grep`, and direct SQLite readers cannot read encrypted storage.
- Interrupted file conversion resumes at the next store open. Unreadable or unauthenticated files stay byte-for-byte in place, are listed in privacy status, and produce one warning per file per conversion pass through the daemon log. Other files still convert; reading an affected attachment returns the existing error response. The panel and privacy RPC report incomplete conversion with a pending count and the requested ON/OFF target; `enabled` is true only after every convertible file succeeds. Restore damaged files from backup (or explicitly remove them), then reopen to retry.
- A failed database write stops further database operations until the store is reopened; it is not acknowledged as durable success. File replacement failures leave conversion pending for the next open.
- Disabling restores plaintext storage without losing sessions. Encryption does not depend on the tier and changing a tier does not turn it off.

The key is `keys/chats.key` (0600, inside a 0700 directory). Back up `keys/` separately: missing, invalid or wrong keys fail closed instead of resetting data. This protects a copy of the data **without its keys**, not an attacker who can also read the keys. The encrypted mode holds the database in RAM and serializes it on writes; large histories cost additional RAM, CPU and disk I/O compared with plain SQLite. Offline SQLite maintenance/inspection requires disabling encryption first.

Conversion intent is stored as JSON in the existing `mendd.db` table `meta`, key `privacy_conversion`; no schema change, migration or sidecar is needed. It records the ON/OFF target before changing the database or any stored file, using a durable SQLite commit (or the encrypted database's atomic snapshot). An interrupted first pass is repeated with full blob SHA-256 comparisons, even when the target is OFF and a damaged sealed header looks plain. After a full pass, the marker records only pending blob hashes and relative private file names, including unreadable files. Later opens retry that list without reading or hashing healthy files again. Successfully converted or user-removed files leave the list; the marker is cleared only when the completed pass has no pending or unreadable files. A crash before the first conversion or after the last conversion but before clearing the marker safely repeats the work. The panel continues to show INCOMPLETE and the pending count until those files are resolved.

Conversion recognizes plaintext blobs by their SHA-256 filename, including plaintext starting with `MENDENC1`; other blob bytes must authenticate as sealed data. Without a marker, ordinary plaintext blob reads and ordinary opens with encryption off add no full-file reads, hashes or rewrites; opening retains the existing cheap header checks. Private files are not content-addressed and still use the magic header: a plaintext private file starting with `MENDENC1` is ambiguous and will be left unreadable if authentication fails.

On open, cleanup removes only `<exact-final-name>.<UUID>.tmp` regular files with one link, after the final file exists and opens in its current format. Missing, unreadable or damaged finals keep their temporaries. Other `.tmp` names, links and directories are left alone. Database authentication errors still prevent opening the database and preserve its temporaries.

## Boundaries

This is encryption **at rest**, not password unlocking, OS Keychain integration, or isolation from other programs running as the same user. The authenticated local owner can toggle it, read chat APIs and access the key files; a tool with shell/network access can also attempt to exfiltrate credentials. Existing tool approvals and sandbox policy still matter.

Explicit exports/shares, previous backups, files in the user's checkout (including imported `.env`), provider copies, adapter-owned session logs, and separately enabled debug traces are outside this encryption boundary. Encryption does not retroactively erase old plaintext copies or promise secure deletion on SSDs. To let another local AI analyze encrypted chats, deliberately export them or disable encryption; protect the exported copy yourself.

Masking shares the existing `docs/secrets.md` limitations: encoded/transformed values, screenshots and unknown credentials are not covered. Do not print secrets or assume a shell process cannot read the values that it needs to use.
