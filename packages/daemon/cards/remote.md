---
summary: drive MendCode from a phone or another machine; share a session; editors
docs: remote, channels, console, mflow, tsm, editor, automation, herdr
aliases: telegram, phone, remote-control, tailscale, share-link, ssh, ide, zed, jetbrains, console, org, rooms, multiplexer, herdr, tuios
---
For: "control it from my phone", "attach to the daemon on my server", "send someone a link to this session", "connect my editor". Each is off until the user turns it on; none starts by itself.

Phone (Telegram): the user creates a bot with @BotFather and gives the daemon the token as MENDCODE_TELEGRAM_TOKEN or a mode-600 file <data dir>/telegram-token (never through a slash command or flag, never in chat). Then /remote-control on, /remote-control pair (an 8-character code valid 10 minutes); in a private chat the user sends the bot "pair CODE". /remote-control shows state, off stops it, unpair removes chats. State is <data dir>/channels.json (mode 0600; paired chats, never the token); Console state is console.json.
Another machine (token create and revoke, console setup and share are the user's; refused from your shell): on the server {{program}} remote token create --dir DATA --name laptop (the token prints once; list and revoke exist), run mendcode daemon run --dir DATA --listen 127.0.0.1:9876 (foreground; daemon start stays local) (a non-loopback host needs --tls-cert and --tls-key; there is no insecure switch), then on the client {{program}} --connect HOST:PORT --token-file PATH. Read-only tokens are refused for writes. No listener by default; {{program}} daemon service install --listener keeps one across reboots (remote.json; "mode": "tailscale" binds only a tailnet address). Remote and peer clients cannot change permissions, ACP agents or other host-local settings; they run ACP or pi turns only for engines the host lists in [[setting:remoteEngines]]. One command for a Linux VPS with Tailscale (the user runs it): {{program}} remote setup HOST --ssh USER@VPS [--dry-run] [--migrate-settings|--migrate-sessions|--acp-agents]; another device: remote pair HOST --ssh USER@VPS; remote unpair DEVICE. Or by hand: remote add NAME HOST:PORT --token-file PATH --default (remotes.json, no tokens): plain mendcode connects, --remote NAME picks one, --local skips it.

Share a session (Console, off by default): /share (Enter creates or syncs, u unshares), /unshare, policy disabled|manual|auto in the same page ([[setting:share]]). A link holds user and assistant text with credentials redacted; no local paths, attachments, reasoning or tool output. Needs a Console origin and token file ({{program}} console setup URL --token-file PATH); /org switches organization; /console manages accounts. 
Editors: /ide on reads the open file, cursor and selection from Zed. JetBrains or Zed as an agent host: point them at `mendcode acp` (no JetBrains plugin).

Rooms and terminals: /mflow (rooms, peers, file leases), /tsm (cmux, kitty, ghostty, wezterm adapter); opt-in.

If a feature is off, tell the user the switch above; never edit remote.json, tokens or Console settings yourself. Check: /remote-control, /share; {{program}} remote token list.

herdr and tuios: their pane sidebar shows the session working, blocked or idle with its resume command; MENDCODE_HERDR=0 turns it off.
