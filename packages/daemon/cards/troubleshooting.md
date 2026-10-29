---
summary: daemon down, something broken, safe mode, disk, updates, uninstall
docs: setup, storage, upgrade, uninstall, accessibility, tracing, migrate-v1, fetch
aliases: troubleshoot, doctor, daemon, logs, restart, storage, disk, upgrade, update, uninstall, broken, crash, stuck
---
For: "the daemon does not respond", "MendCode is stuck / slow / broken", "start without my extensions", "how much disk does it use", "update it", "remove it", "first run".

Look before you change anything (read-only):
  {{program}} status; {{program}} doctor (add --json); {{program}} daemon status | logs --lines 100. The user types /status, /doctor (terminal capabilities, failed commands, shadowed skills), /debug-config (config layers and every ignored setting, with reasons, no values), /daemon.
  {{program}} control-plane system config-layers | config-paths | precedence: which file and layer wins. A start with --strict-config lists ignored settings and refuses (exit 78).
  Read logs only through daemon logs. /fetch shows project and install details, /mend-assets the runtime assets, /intro replays the intro, /changelog what changed.

Fix, each one the user's decision:
  A bad extension, package, hook, MCP server or project tool: {{program}} --safe-mode starts without any of them; then disable the culprit in /extensions or /packages, or MENDCODE_EXTENSIONS=0, MENDCODE_HOOKS=0, --pure. /doctor names what failed.
  /restart: this terminal, same chat, after the running response. /reload: extensions, packages, keys, themes, no restart. Daemon not answering: {{program}} daemon restart (--force interrupts work: say so). Never kill others' processes.
  Keys, Shift+Enter, tmux: /terminal-setup. Screen reader: /accessible, --accessible, MENDCODE_ACCESSIBLE=1.
  First run or no model: /setup lists what it found (ChatGPT login, Claude Code, Codex, API keys) and the command that fixes each; /connect adds a key; /tutorial tours the terminal.

Heavy on RAM: the Processes row of /customize (processMode, feature single_process): the minimalist tier runs the daemon inside the terminal, which saves memory but a hard-killed terminal interrupts its running turn.

Disk: {{program}} --dir DATA storage reports bytes per turn, snapshots, top sessions; storage --clean [--older-than 90d] [--worktrees] [--dry-run] and --compact; /storage with previews. Ages: retentionDays and worktreeGcDays ({{program}} docs git). A big database: storage --compact --offline --dry-run (feature storage_compact; stop writers first; the old file is kept). Never edit mendd.db by hand.

Bug report: {{program}} --trace (or MENDCODE_TRACE=1) records spans; OTLP export needs experimental flag openTelemetry. Old v1 history: {{program}} migrate-v1 --from OLD --dir NEW [--dry-run] (never writes to OLD).

Updates: {{program}} upgrade [--check] [--channel stable|beta|dev|nightly] [--rollback]; /release-channel saves the channel (remembered in upgrade.json); rollback is offline. Uninstall: {{program}} uninstall --dry-run first; --keep-config and --keep-data keep what you name; it never touches a running daemon, project files or shell startup files.

Cannot: heal a corrupt database, restore deleted sessions, or speak for a remote daemon. Say what you ran and printed; if the user declined a command, stop.
