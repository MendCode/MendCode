---
summary: the terminal look: profile keys, presets, schema, rollback
docs: customize, automation, config-bundle
aliases: look, profile, appearance, ui, density, logo, view, config-bundle, migrate-setup
---
The look of the terminal is a profile (<data dir>/tui/profile.json): theme, density, view, prompt box and border, logo, tagline, home layout, footer, sidebar, markdown style, pet, slash menu, and about 190 more keys.

Change keys yourself when the user asks (validated, applied live to every connected terminal; do not send them to /customize):
  customize_ui {"action":"settings","values":{"density":"compact","messageMeta":"off"}}
Which key changes a part: customize_ui {"action":"keys","query":"top bar"} returns the matching keys, what each does, its values and the value now; every part of the screen and its key: {{program}} docs screen-parts.
Not in your tool list (minimalist): tool_search finds customize_ui. The result lists errors; a bad key or value changes nothing and names the nearest keys.
All keys, types, defaults and allowed values at once: {{program}} control-plane tui schema
Current values: {{program}} control-plane tui profile  (or status)
Presets (the user's terminal; from your shell use customize_ui, the CLI only reads): {{program}} control-plane tui apply-preset compact|comfortable|spacious|toggle-worktree. Every apply returns a backup id; {{program}} control-plane tui rollback [--backup ID] restores it. --dry-run validates without changing.
The user's way: /customize (a page with every control and a live preview), /theme, /view.

Not a profile key: the theme itself has its own card (theme), key bindings (keys), the footer rows, icons and presets (footerRows and /footer preset: card footer; no extension needed), layout and drawing that need code (extensions).
Packages can carry a whole look (theme, profile values, keys, views) and turn it on and off: {{program}} docs packages.
A package may not set keys that start things or touch the clipboard (processMode, altScreen, copyOnSelect, turnNotify, fileOpener, ...); only the user sets those, with /customize.
Move the user's whole setup (profile, own skills/commands/agents, AGENTS.md, keybindings, installed packages and their state, preference settings) to another machine: {{program}} config-bundle inventory | export <file> | inspect <file> | import <file> (preview; prints a plan id) | import <file> --apply --plan ID [--on-conflict keep|replace] [--resolve ITEM=keep|replace] [--rewrite-home] | rollback <import-id>. Secrets, history and trust never travel; code is quarantined, MCP arrives pending in /mcp, models/permissions/budgets wait in pending.json; journal.json, backups and report.json stay under config-imports/<id>/. A session cannot apply one: give the user the command. packages create is different: it snapshots a project's .mendcode/ only.
