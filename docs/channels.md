# Remote channels (Telegram, Discord)

Drive MendCode sessions from a phone: pair a Telegram chat or a Discord channel, send prompts, get answers, approve tool calls
with buttons and receive project files. Off by default: no network call, no listener and no polling until you turn one on.
Both can run at once; everything below works the same on each, except where [Discord](#discord) says otherwise.

## Setup

1. Create a bot with `@BotFather` and copy its token.
2. Give the daemon the token, never through a slash command or a flag: export `MENDCODE_TELEGRAM_TOKEN`, or save it to
   `<data dir>/telegram-token` with mode 600 (a group/world-readable file is refused).
3. In the terminal: `/remote-control on`, then `/remote-control pair`. It shows an 8-character code valid for 10 minutes
   and copies `/pair CODE` to the clipboard; the notice stays until the code expires or you send a prompt.
4. In a private chat with your bot paste `/pair CODE`. The chat joins the session the code was made in: its last turns
   arrive, and from then on the terminal and the phone share it. A paired chat that pastes a new code moves to that one,
   unless topics are on (below).

### Several sessions and projects: topics

Turn on topics for the bot in `@BotFather` (bot settings, topics in private chats). Then every session gets its own topic in the
same chat with the bot, and they all run side by side; one bot is enough.

- A code from another project's terminal opens that session in a new topic; the chat stays paired with the others.
- `/new` opens a fresh session in a new topic, and a `/sessions` pick opens that session in its topic (or links to it).
- A topic you create yourself runs a new session in the chat's project.
- Deleting a topic stops following its session there; the session itself stays.

The bridge reads the setting when it starts and again at most once a minute while it is off, so no restart is needed.

### Manage the bridge

| Command | Does |
|---|---|
| `/remote-control` | Shows the state. |
| `off` | Stops the bridge. |
| `unpair [chat id]` | Removes one or all chats. |
| `/remote-control pair` | Makes a code. |

State lives in `<data dir>/channels.json` (mode 0600), one section per service: `enabled` and the paired chat ids, their topics
and sessions, and who paired each, never a token. With `enabled: true` the daemon starts the bridge on launch.

## Discord

On Discord a paired channel of your server is the lobby and every session has its own thread, as in Hermes.

1. In the [Discord Developer Portal](https://discord.com/developers/applications) create an application, add a bot, turn on
   its **Message Content** intent and copy its token.
2. Invite the bot to your server (OAuth2 URL generator, scope `bot`) with View Channel, Send Messages, Send Messages in Threads,
   Create Public Threads, Read Message History and Attach Files. Use a channel only you (or people you trust to read it) can see.
3. Give the daemon the token: `MENDCODE_DISCORD_TOKEN`, or `<data dir>/discord-token` with mode 600.
4. In the terminal: `/remote-control discord on`, then `/remote-control discord pair`, and paste `/pair CODE` in the channel.

- A message in the channel starts a new session in a thread made from that message; replies in the thread continue it.
- A code from a terminal session (or another project's terminal) opens that session in its own thread; `/new` and a
  `/sessions` pick open threads too. The channel gets a link to each new thread.
- Only the person who paired the channel drives it: messages and button presses from other members are ignored.
- Answers keep their Markdown (Discord shows it); tables arrive as aligned columns in a code block. Mentions never ping anyone.
- Commands start with `/` or `!` (`!new`, `!sessions`), so they work even where Discord would open its own command menu.

`/remote-control discord` shows the Discord bridge's state; `off` and `unpair [channel id]` work as for Telegram.

## From the phone

Any text runs a turn in the chat's session: the terminal's session when the code was made there, otherwise an ordinary
session titled "Telegram" that you can open in the TUI. The final answer comes back as a message, split under Telegram's
size limit and masked for session secrets. Its Markdown is formatted: bold, italics, code, links, lists and quotes as Telegram
shows them, code blocks and tables in monospace. A part Telegram cannot read formatted arrives as plain text.

Turns started on the computer show in the chat too: your prompt (as "From the computer:") and then the answer; joining a
session while one runs shows it from its start. A message from the phone waits until that turn ends (or `/stop` it). While a
turn runs, one message shows its progress (tools used, the one running, time) and is edited at most every 3 seconds; it
ends as `Done`, `Stopped` or `Failed` just above the answer.

### Approvals and questions

- Approvals arrive as a message with **Allow once** / **Deny** buttons. An approval answered elsewhere expires.
- Questions arrive with their options as buttons, or you can answer by typing.
- Answer plan reviews and multi-question batches in the terminal.

### Phone commands

| Command | Does |
|---|---|
| `/sessions` | Lists the project's recent sessions as buttons; one tap moves the chat there (with topics, opens its topic) and shows its last turns. |
| `/history [n]` | Shows the last `n` turns of the session (5 by default, up to 20). |
| `/stop` | Cancels the running turn, also one started on the computer. |
| `/new` | Starts a fresh session (with topics, in a new topic). |
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
