---
summary: drive MendCode from a phone or another machine; share; editors
docs: remote, vps, channels, console, mflow, tsm, editor, automation, herdr
aliases: telegram, phone, remote-control, tailscale, share-link, ssh, ide, zed, jetbrains, console, org, rooms, multiplexer, herdr, tuios
---
For: "control it from my phone", "attach to the daemon on my server", "send someone a link to this session", "connect my editor". Each is off until the user turns it on; none starts by itself.

Phone (Telegram): the user creates a bot with @BotFather and gives the daemon the token as MENDCODE_TELEGRAM_TOKEN or a mode-600 file <data dir>/telegram-token (never by slash command, flag or chat). Then /remote-control on, /remote-control pair (8-character code, 10 minutes); in a private chat they send the bot "pair CODE". /remote-control shows state, off stops it, unpair removes chats. State: <data dir>/channels.json (paired chats, never the token); Console: console.json.
Another machine (token, console setup and share commands are the user's; refused from your shell): on the server {{program}} remote token create --dir DATA --name laptop (prints once), run mendcode daemon run --dir DATA --listen 127.0.0.1:9876 (foreground; a non-loopback host needs --tls-cert and --tls-key), then on the client {{program}} --connect HOST:PORT --token-file PATH. Read-only tokens are refused for writes. No listener by default; {{program}} daemon service install --listener keeps one across reboots (remote.json; "mode": "tailscale" binds only a tailnet address). Remote clients cannot change permissions, ACP agents or other host-local settings; they run ACP or pi turns only for engines listed in [[setting:remoteEngines]]. One command for a Linux VPS with Tailscale (the user runs it): {{program}} remote setup HOST --ssh USER@VPS [--dry-run] [--migrate-settings|--migrate-sessions|--acp-agents]; another device: remote pair HOST --ssh USER@VPS; remote unpair DEVICE. By hand: remote add NAME HOST:PORT --token-file PATH --default (remotes.json); --remote NAME picks one, --local skips it.

Share a session (Console, off by default): /share (Enter creates or syncs, u unshares), /unshare, policy disabled|manual|auto in the same page ([[setting:share]]). A link holds user and assistant text with credentials redacted, no paths, attachments or tool output. Needs {{program}} console setup URL --token-file PATH; /org switches organization; /console manages accounts.
Editors: /ide on reads Zed's open file and selection; JetBrains or Zed as agent host: `mendcode acp`. Rooms /mflow, terminals /tsm: opt-in.

Code between machines (the user runs it): {{program}} remote code handoff pushes the working tree to a new mend/wip-* branch (never forced, their branch untouched); remote code receive on the other machine checks it out in a worktree; remote code clone URL. Opt-in live sync needs Mutagen: remote code live enable --ssh USER@HOST (same branch and commit on both; live status|resume|disable|list).

If a feature is off, tell the user the switch above; never edit remote.json, tokens or Console settings yourself. Check: /remote-control, /share; {{program}} remote token list.
herdr and tuios: their pane sidebar shows the session state and resume command; MENDCODE_HERDR=0 turns it off.
