---
summary: drive MendCode from a phone or another machine; share a session; editors
docs: remote, channels, console, mflow, tsm, editor, automation, herdr
aliases: telegram, phone, remote-control, tailscale, share-link, ssh, ide, zed, jetbrains, console, org, rooms, multiplexer, herdr, tuios
---
For: "control it from my phone", "attach to the daemon on my server", "send someone a link to this session", "connect my editor". Each is off until the user turns it on; none starts by itself.

Phone (Telegram): the user creates a bot with @BotFather and gives the daemon the token as MENDCODE_TELEGRAM_TOKEN or a mode-600 file <data dir>/telegram-token (never through a slash command or flag, never in chat). Then /remote-control on, /remote-control pair (an 8-character code valid 10 minutes), and in a private chat the user sends the bot "pair CODE" as the bot's own pair command. /remote-control shows state, off stops it, unpair removes chats. State is <data dir>/channels.json (mode 0600; paired chats, never the token); Console state is console.json. Approvals arrive as buttons.

Another machine (token create and revoke, console setup and share are the user's; refused from your shell): on the server {{program}} remote token create --dir DATA --name laptop (the token prints once; list and revoke exist), start the daemon with --listen 127.0.0.1:9876 (a non-loopback host needs --tls-cert and --tls-key; there is no insecure switch), then on the client {{program}} --connect HOST:PORT --token-file PATH. Read-only tokens are refused for writes. No listener exists by default. Remote and peer clients cannot change permissions, ACP agents or other host-local settings.

Share a session (Console, off by default): /share (Enter creates or syncs, u unshares), /unshare, policy disabled|manual|auto in the same page ([[setting:share]]). A link holds user and assistant text with credentials redacted; no local paths, attachments, reasoning or tool output. Needs a configured Console origin and token file ({{program}} console setup URL --token-file PATH); /org switches organization; /console manages accounts. No public backend is chosen for the user. Changing policy never shares old sessions.

Editors: /ide on reads the open file, cursor and selection from Zed (read-only; files inside the project only; over 1 MiB refused). For JetBrains or Zed as an agent host, point them at the command `mendcode acp`. There is no JetBrains plugin.

Rooms and terminals: /mflow (rooms, peers, file leases between agents), /tsm (terminal-session adapter for cmux, kitty, ghostty, wezterm); both are opt-in managers with a status and doctor under {{program}} control-plane mflow|tsm.

Say what is not on: if a feature is off, tell the user the switch above; do not edit remote.json, tokens or Console settings yourself.

Check: /remote-control and /share show their own state; {{program}} remote token list names tokens without secrets.

herdr and tuios: run inside a herdr or tuios pane and their sidebar shows the session working, blocked on an approval or idle, with its resume command; nothing to install. MENDCODE_HERDR=0 turns it off.
