---
summary: which tool and key changes what: window, model, theme, title, permissions
docs: customize, compaction, tiers
aliases: map, where, how-to, change-setting, settings-map, which-key
---
Never read MendCode's binary or source (no strings, grep, python on it) to change MendCode: use the line below, {{program}} docs --search <words>, or {{program}} docs <topic>. Every daemon change is mendcode_settings {"action":"propose","patch":{key:value},"reason":"..."}; the user's Apply saves it; null resets a key.
Context window. "Global" = every session (a daemon setting), not "all models". This session only: the user's /context-window 450k. Global, the model in use: [[setting:modelContext]] {"provider/model":{"window":450000}} (ref: {{program}} models; or the user's /context-window 450k --always). Every model: [[setting:defaultContextWindow]] 450000 (for models with no window of their own; a model's own entry wins), never one entry per model. Compaction point: [[setting:compactAtTokens]]. Card: compaction.
Default model and roles: [[setting:models]] (get it first, send the whole object), or {{program}} control-plane models set-default <provider> <model>. Card: models.
Reasoning effort: per model in /model or in the role in [[setting:models]]. Card: reasoning.
Theme, footer, density, prompt box, any screen part: customize_ui {"action":"keys","query":"footer"} finds the key, then {"action":"settings","values":{...}}. Card: customize.
Session title, pin, archive: session_meta (tier balanced). Card: sessions.
Permissions and sandbox: [[setting:defaultPermission]], [[setting:permission]], [[setting:sandbox]]; only when asked. Card: permissions.
Tier: [[setting:tier]]. Feature flags: [[setting:experimental]], /tier. Spend limits: [[setting:budgets]], only if asked for that exact change.
MCP: {{program}} mcp add (the user runs it). Skills, commands, hooks, agents: files in skills/ commands/ hooks.json agents/; cards mcp, skills, hooks, agents.
Keys: write keybindings.json ({{program}} docs keys). Secrets and credentials: /env and /connect, typed by the user; never ask for or print one.
