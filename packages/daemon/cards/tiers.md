---
summary: feature tiers: minimalist, balanced, full, and per-feature switches
docs: tiers
aliases: tier, features, feature, safe-mode
---
One tier setting ({{tiers}}) selects a bundle of switches that already exist; with no tier set nothing changes. A tier sets the chat view, density and the project's prompt mode once when applied (minimalist: minimal, balanced: focus, full: full), and turns feature modules on or off live. Every feature stays individually switchable.
The user changes it: /tier lists the bundles and what is on now and why; /tier minimalist|balanced|full applies one and says what it added or removed; /tier <feature> on|off|default overrides one feature; /tier off clears it; the Tier row of /setup. The daemon refuses tier changes from remote terminals. No CLI command writes it; when the user asks, propose it with mendcode_settings ({"tier":"full"} or {"features":{...}}, the whole object), saved only on the user's Apply.
What differs (the user's /tier shows the exact list for this version): minimalist keeps the lean coding core of tools in every request and the rest behind tool_search, with the smallest prompt; balanced adds sub-agents, the code graph, script workflows, the orientation block and output filters; full adds MCP, plan tools, pets and adaptive reasoning. Risky features (computer control, browser, voice) are never turned on by a tier: they need their own switch.
Per-feature override: the settings key [[setting:features]] { id: true|false } (the user's /tier id on|off|default).
Precedence, highest first: safe mode (--safe-mode: no extensions, packages, hooks, MCP, project tools), the per-feature override, the feature's own flag, the tier, the default.
Check: /tier lists every feature with on or off and the reason, and the live lines below say the same for this install; a tier change applies from the next call, a setting a feature needs is separate.
Do not confuse a tier with a prompt mode ({{program}} docs prompt-modes), a permission mode ({{program}} docs permissions) or the process mode (--process daemon|auto|solo).

Minimalist sends the smallest request: read, write, edit, apply_patch, shell, glob, grep and tool_search. In every tier (feature aux_tools, opt-in) shell_output and shell_kill are listed once a command runs in the background, task_status once a sub-agent was launched, the plan tools in plan mode; webfetch and question through tool_search (customize_ui too, in minimalist). Nothing is removed. /tier aux_tools on lists them always.
A Claude Code session, and an ACP agent that takes HTTP MCP, also gets MendCode's tools as mcp__mendcode__<tool> (feature harness_tools, balanced and full): code graph, computer use, memory, customize_ui, mendcode_settings. Same approvals as native. Off: /tier harness_tools off.
