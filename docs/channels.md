# Remote channels (Telegram)

Drive a MendCode session from a phone: pair a Telegram chat, send prompts, get answers, approve tool calls with buttons and
receive project files. Off by default: no network call, no listener and no polling until you turn it on.

## Setup

1. Create a bot with `@BotFather` and copy its token.
2. Give the daemon the token, never through a slash command or a flag: export `MENDCODE_TELEGRAM_TOKEN`, or save it to
   `<data dir>/telegram-token` with mode 600 (a group/world-readable file is refused).
3. In the terminal: `/remote-control on`, then `/remote-control pair`. It prints an 8-character code valid for 10 minutes.
4. In a private chat with your bot send `/pair CODE`. That chat now runs turns in the project where the code was made.

`/remote-control` shows the state, `off` stops the bridge, `unpair [chat id]` removes one or all chats; `/remote-control pair` makes a
code. State lives in `<data dir>/channels.json` (mode 0600): `enabled` and the paired chat ids and sessions, never the token.
With `enabled: true` the daemon starts the bridge on launch.

## From the phone

- Any text runs a turn in the chat's session (an ordinary session titled "Telegram"; you can open it in the TUI). The final answer
  comes back as a message, split under Telegram's size limit and masked for session secrets.
- Approvals arrive as a message with **Allow once** / **Deny** buttons. Questions arrive with their options as buttons, or answer
  by typing. Plan reviews and multi-question batches are answered in the terminal. An approval answered elsewhere expires.
- `/stop` cancels the turn, `/new` starts a fresh session, `/status`, `/file PATH`, `/unpair`, `/help`.
- `/file PATH` sends a file as a document. It must resolve (symlinks included) inside the chat's project, outside the data
  directory, be a regular file up to 20 MB, and not look like a credential (`.env*`, `*.pem`, `*.key`, `id_*`, `.npmrc`, files
  under `.git`/`.ssh`/`.aws`). Only the paired chat's owner can ask; the model cannot send files on its own.

## Security

- The daemon calls the Telegram Bot API outward by long polling (`getUpdates`); nothing listens. Tests use a local fake.
- Unpaired chats get no reply except to `/pair` and `/start`. A code is single use and expires; five wrong codes silence a chat for
  15 minutes. Groups are ignored: only private chats pair. At most 16 chats.
- Messages sent while the daemon was off are dropped on start, not replayed as turns.
- The bridge is an ordinary local client of the daemon's socket, so permission modes and approvals apply as in the TUI.
  Approving from the phone is equivalent to approving in the terminal: pair only a chat you control, and treat the bot token
  as a credential (anyone with it can read the bot's messages, not your files).
- `channels.status` and `channels.change` are local-only and not read-only peer commands: remote or peer clients get `forbidden`.
  The token, pair codes and error text never include the token (it is scrubbed from transport errors).
- Voice messages are transcribed only when `voice.enabled` is on and a transcription provider is configured; see [voice.md](voice.md).
- Not supported: files or photos sent from the phone, groups, other chat services.

Code: `packages/daemon/src/channels*.ts`, `packages/protocol/src/channels.ts`, `apps/cli/src/ui/app/channels.ts` (`/remote-control`).
See also [remote.md](remote.md) for TCP/HTTP attach.
