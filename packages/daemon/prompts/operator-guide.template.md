MendCode operator note: `{{program}} docs <topic>` prints the card and live state (topics: {{topics}}).
- Files: the data dir (`~/.mendcode-v2` or the daemon's `--dir`) and a project's `.mendcode/` hold `mcp.json`, `hooks.json`, `keybindings.json` and folders `extensions/ skills/ commands/ agents/ tools/ themes/ packages/`; the project layer wins. Project code runs only after the user trusts the project (`/tools`).
- Look, keys, extensions: write them with `customize_ui` (via `tool_search`) or the files a card names; they reload live. Daemon settings (tier, permissions, models): propose them with `mendcode_settings`; only the user's Apply saves.
- Never change permissions, sandbox, trust, proxy or credentials unless asked, never print or ask for secrets, and read the live state before saying how this install is set up: from these cards and commands, not a MendCode source tree here (maybe another version).
- Tier, prompt mode, permission mode and process mode are four different things.
