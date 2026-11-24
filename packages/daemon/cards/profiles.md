---
summary: profiles = packages = plugins: install, turn on/off, make your own
docs: profiles, customize
aliases: profile, package, packages, pkg, bundle, plugin, plugins
---
A profile is a folder with mendcode-profile.json that carries any of: skills/ commands/ agents/ tools/ themes/ extensions/ hooks mcp.json keybindings, and optionally a whole look (activate: theme, tuiProfile, views, keybindings). Disabling or removing it puts everything back; your settings win over its.
  mendcode-profile.json: { "name": "acme", "version": "1.0.0", "description": "..." }   (name: lowercase letters, digits, . _ - equal to the folder name); the older mendcode-package.json also loads
"Package" and "plugin" mean profile: {{program}} package|plugins ... is {{program}} profile ... ({{program}} plugin MODULE installs an extension instead). To turn one on or off, call the profiles tool (below): your shell is refused install, enable, disable, remove. It applies at once, no /reload or restart. /reload (no /reload-plugins) re-reads extensions, profiles, keys, themes, and in a Claude session its idle Claude Code restarts on the next message; /restart: this terminal only. Neither restarts the daemon.
Commands (add --project for this project's .mendcode/packages; else user scope; your shell: only new, check, list):
  {{program}} profile new <name> [--dir PARENT]     scaffold a profile that already loads
  {{program}} profile check [folder]                validate without running anything
  {{program}} profile install <folder|github:owner/repo#ref|git:URL|npm:name@x.y.z> [--replace]   refuses links, secrets, trees over 2000 files or 20 MB
  {{program}} profile list | config [name] | enable|disable <name> [--switch] | remove <name> [--purge] | restore <name>
  {{program}} profiles create   snapshots this project's .mendcode/ (own setup: docs profile)
To try one, write it into <project>/.mendcode/packages/<name>/ or <data dir>/packages/<name>/.
The profiles tool (find it with tool_search) does list, info, search, check (read-only) and install, enable, disable, switch-look, remove, new (each needs an approval card, even in full permission mode; install takes only an exact name from a configured local source). One profile owns the look per scope; switch-look says which.
The approval card of a big profile is a summary: size per folder, the largest files, and every script, hook, tool definition and executable. Over 2000 files, 20 MB, 12 folder levels or 150 runnable files the tool refuses and names the limit and the command for the user's own terminal; do not retry, give the user that command.
Features (balanced): profile_tools; profile_capabilities (/marketplace preview shows declared capabilities; absent hints never prove safety); official_profiles (examples/official-profiles, a source the user adds). Overrides: activation.json. Turned off: [[setting:disabledProfiles]], [[setting:disabledProfileResources]].
A profile cannot change permissions, trust, credentials, budgets, models, sandbox, hooks or MCP through activate; the manifest fails the schema if it tries. The user manages profiles in /profiles (o lists what a profile overrides, p the precedence report).