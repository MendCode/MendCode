# Remote channels (Telegram)

Drive a MendCode session from a phone: pair a Telegram chat, send prompts, get answers, approve tool calls with buttons and
receive project files. Off by default: no network call, no listener and no polling until you turn it on.

## Setup

1. Create a bot with `@BotFather` and copy its token.
2. Give the daemon the token, never through a slash command or a flag: export `MENDCODE_TELEGRAM_TOKEN`, or save it to
   `<data dir>/telegram-token` with mode 600 (a group/world-readable file is refused).
3. In the terminal: `/remote-control on`, then `/remote-control pair`. It shows an 8-character code valid for 10 minutes
   and copies `/pair CODE` to the clipboard; the notice stays until the code expires or you send a prompt.
4. In a private chat with your bot paste `/pair CODE`. That chat now runs turns in the project where the code was made.

### Manage the bridge

| Command | Does |
|---|---|
| `/remote-control` | Shows the state. |
| `off` | Stops the bridge. |
| `unpair [chat id]` | Removes one or all chats. |
| `/remote-control pair` | Makes a code. |

State lives in `<data dir>/channels.json` (mode 0600): `enabled` and the paired chat ids and sessions, never the token. With `enabled: true` the daemon starts the bridge on launch.

## From the phone

Any text runs a turn in the chat's session, an ordinary session titled "Telegram" that you can open in the TUI. The final answer comes back as a message, split under Telegram's size limit and masked for session secrets.

### Approvals and questions

- Approvals arrive as a message with **Allow once** / **Deny** buttons. An approval answered elsewhere expires.
- Questions arrive with their options as buttons, or you can answer by typing.
- Answer plan reviews and multi-question batches in the terminal.

### Phone commands

| Command | Does |
|---|---|
| `/stop` | Cancels the turn. |
| `/new` | Starts a fresh session. |
| `/file PATH` | Sends a file as a document. |

Also available: `/status`, `/unpair`, `/help`.

### Receive a project file

Use `/file PATH` to receive a document. The file must:

- Resolve inside the chat's project, including symlinks, and outside the data directory.
- Be a regular file up to 20 MB.
- Not look like a credential: `.env*`, `*.pem`, `*.key`, `id_*`, `.npmrc`, or files under `.git`/`.ssh`/`.aws`.

Only the paired chat's owner can ask; the model cannot send files on its own.

## Security

The bridge is an ordinary local client of the daemon's socket, so permission modes and approvals apply as in the TUI. Approving from the phone is equivalent to approving in the terminal.

**Warning:** Pair only a chat you control, and treat the bot token as a credential. Anyone with it can read the bot's messages, not your files.

### Pairing limits

- Unpaired chats get no reply except to `/pair` and `/start`.
- A code is single use and expires; five wrong codes silence a chat for 15 minutes.
- Groups are ignored: only private chats pair. At most 16 chats.
- Messages sent while the daemon was off are dropped on start, not replayed as turns.

### Supported input

Voice messages are transcribed only when `voice.enabled` is on and a transcription provider is configured; see [voice.md](voice.md).

Not supported: files or photos sent from the phone, groups, other chat services. See also [remote.md](remote.md) for TCP/HTTP attach.

## How it works

The daemon calls the Telegram Bot API outward by long polling (`getUpdates`); nothing listens. Tests use a local fake.

`channels.status` and `channels.change` are local-only and not read-only peer commands: remote or peer clients get `forbidden`. The token, pair codes and error text never include the token (it is scrubbed from transport errors).

| Code | Role |
|---|---|
| `packages/daemon/src/channels*.ts` | Daemon channel code. |
| `packages/protocol/src/channels.ts` | Channel protocol. |
| `apps/cli/src/ui/app/channels.ts` | `/remote-control`. |
