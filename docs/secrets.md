# Pasted secrets

For named credentials (`/env`) and opt-in chat encryption (`/privacy`), see [Environment & privacy](environment-privacy.md). The limits below describe pasted secrets; configured vault values are also masked by the native engine even if never pasted.

When you paste a secret (an API key, a token, a password) MendCode keeps working with it, but the model and every
stored transcript only ever see a marker: `‹secret:1›`. The value lives in one encrypted table and is put back only
inside a tool run that you approved.

## Historical JSON

Historical JSON redaction shares the recursive walker in `packages/daemon/src/secrets.ts`.
Each caller keeps its key policy: transcript transfer also redacts key text, session inspection
and debug reports mask their respective sensitive field names, and loop reports redact values.
Existing secret markers and non-string structure are preserved.

## What becomes a marker

At `user.submit`, `user.shell`, `draft.set` and `prompt.record` (a slash command or discarded draft entered in the terminal, kept in the prompt history; a line that is only markers is not kept) (and the text of loops and workflows), the daemon runs the detectors of
`packages/protocol/src/redact.ts` (`findSecrets`: OpenAI, Anthropic, GitHub, AWS access key ids, Slack, Google, Stripe,
JWTs, PEM private keys, `scheme://user:password@`, `Authorization: Bearer|Basic`, and `NAME=value` where the name holds
SECRET, TOKEN, PASSWORD, API_KEY, PRIVATE_KEY or ACCESS_KEY). Each distinct value gets the next number of its session;
the same value again (in any later message) is the same marker. Numbers follow detection order (self-identifying tokens
first, then assignments), not position in the text. A value that is known in a session is also masked wherever else it
appears in the text, even if no detector would catch it there. A placeholder such as `<your key>` or `${KEY}` and a
marker itself are never treated as a secret. `redactSecrets` behaves as before (`[redacted:kind]`) and stays as the
last net on every event text.

## Where it is stored

`secrets(session_id, n, kind, iv, ciphertext, tail, created_at)`, one row per value, AES-256-GCM with a fresh 12-byte
IV per row and the session id and number as authenticated data. `tail` is the last 4 characters (2 for a value under 12
characters) for display.

The key is 32 random bytes in `<data dir>/keys/secrets.key`, created on first use with mode 0600 in a 0700 folder
(a key file readable by others is tightened to 0600 when used). A missing key file is never replaced while encrypted
rows exist, and a key file of the wrong size or content is a clear `[SECRETS]` error (`secrets.reveal` and any message
that carries a new secret fail with code `internal`; the message is not sent). Back up `keys/` separately: without it
the ciphertext is unreadable, which is also what a backup of the database alone gives an attacker.

Deleting a session deletes its secrets (`ON DELETE CASCADE`, also for retention cleaning). A fork (`session.fork`,
`copyConversation`) gets the same numbers, re-encrypted for the new session. `secrets.forget` erases the value and
keeps its number taken, so a marker never starts to mean another value. A session keeps at most 256 secrets of at most
16 384 characters; past that a value is redacted (`[redacted:kind]`) instead of stored.

The marker, never the value, is what these hold: the `user.submit` event text, queue items, prompt history, session
titles, `engine_messages` (the model's history), drafts, memory proposals, Dream's input (it reads the events), the
`/btw` question and transcript, and what extension `input`, `tool.before` and `tool.after` hooks receive. A memory the
agent proposes is also passed through `redactSecrets`, in case it read a secret from a file.

## How the agent uses one

The system prompt of a session that has secrets lists its markers (kind and tail) and says how to use them. The agent
cannot read a value. It writes the marker:

- in the `command` of a `shell` call, and in the `content` of `write`, the `oldString`/`newString` of `edit` and the
  `patch` of `apply_patch`: the engine replaces `‹secret:N›` with the decrypted value just before `execute`, after the
  permission check and after `tool.before` hooks. The approval prompt, the tool card, `server.request.detail`, the log
  and hooks show the marker (`packages/engine-native/src/engine.ts`, `runCall`).
- only for the built-in tools: a tool an extension overrides, a custom tool or an MCP tool gets the marker as written.
  A sub-agent (`task`) sees the same markers and its built-in calls resolve the same way.

A tiny read-only tool, `secrets`, lists markers with kind and tail (no values).

Everything a tool returns is masked before the model or the event log sees it: the exact value and its JSON-escaped form
become the marker in `output`, `title`, `meta`, the render tree and the `afterWrite` diagnostics; live output deltas
are masked with a hold-back so a value cut by chunk boundaries never appears. This covers `cat .env` and `@file`
mentions (masked before they reach the history). Background commands are listed and announced masked.

## Commands (daemon side)

| Command | Ack |
|---|---|
| `{ type: "secrets.list", sessionId }` | `{ secrets: [{ n, kind, tail, createdAt }] }`; needs no key, never a value |
| `{ type: "secrets.reveal", sessionId, n }` | `{ value }`; `target_mismatch` if absent, `internal` if the key file is wrong. A user action only: the agent has no tool that sends it, and the reply is not kept for retries |
| `{ type: "secrets.forget", sessionId, n }` | `{}`; `target_mismatch` if absent. The marker stays in the transcript but no longer resolves |

The terminal can wire a "reveal" action to `secrets.reveal` and show the marker's kind and tail from `secrets.list`; the
daemon does not decide when to ask. Exports read the event log and usage reads counters, so neither contains a value.
(The session export in `apps/cli` was not changed here; it reads events, which hold markers.)

## Limits

- Native engine only. The Claude Code and Codex engines run their own tools: they see the markers, cannot resolve them
  and their output is not masked.
- Detection is heuristic. A secret the detectors do not recognize (a short or unusual password with no `NAME=`) is
  stored as typed until it is caught; `NAME=value` needs 8 characters or more. Images and attachments are not scanned.
- Masking is exact text: the value and its JSON-escaped form. A tool that prints it encoded (base64, URL-encoded, hex,
  split, reversed, hashed) is not masked. Images a tool returns (screenshots) are not masked.
- A secret the user never pasted (a key inside a file the agent reads) is not masked in what the model sees; only the
  event log redacts those (`redactSecrets`).
- The real value exists in the daemon's memory for the sessions in use, in the arguments of the process a tool starts
  (visible to `ps` while it runs), in files the agent writes with it, and in a background command's record. The
  approval prompt shows the marker, so the user approves the command as the model wrote it, not the value.
- Anyone who can open the daemon socket can send `secrets.reveal`; "user action only" means no agent path, not
  authentication.
- Transcripts written before this feature keep the older `[redacted:kind]` text.
