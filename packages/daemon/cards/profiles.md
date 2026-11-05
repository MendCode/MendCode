---
summary: bundle skills, commands, agents, themes, keys, views; share them
docs: profiles, customize
aliases: profile, package, packages, pkg, bundle
---
A profile is a folder with mendcode-profile.json that carries any of: skills/ commands/ agents/ tools/ themes/ extensions/ hooks mcp.json keybindings, and optionally a whole look (activate: theme, tuiProfile, views, keybindings). Disabling or removing it puts everything back; your own settings win over a profile's.
  mendcode-profile.json: { "name": "acme", "version": "1.0.0", "description": "..." }   (name: lowercase letters, digits, . _ - equal to the folder name; also author, homepage, license); the older mendcode-package.json also loads
Commands (add --project for this project's .mendcode/packages; else user scope; your shell: only new, check, list):
  {{program}} profile new <name> [--dir PARENT]     scaffold a complete, commented profile that already loads
  {{program}} profile check [folder]                validate without running anything (schema, compatibility, capabilities, forbidden keys, size)
  {{program}} profile install <folder|github:owner/repo#ref|git:URL|npm:name@x.y.z> [--replace]   refuses links, secrets and trees over 2000 files or 20 MB
  {{program}} profile list | config [name] | enable|disable <name> [--switch] | remove <name> [--purge] | restore <name>
  {{program}} profiles create   snapshots this project's .mendcode/ (own setup: docs profile)
To try one, write it straight into <project>/.mendcode/packages/<name>/ or <data dir>/packages/<name>/; no restart.
In chat, the profiles tool (find it with tool_search) does list, info, search, check (read-only) and install, enable, disable, switch-look, remove, new (each needs an approval card, even in full permission mode; install takes only an exact name from a configured local source). One profile owns the look per scope; switch-look says which.
The approval card of a big profile is a summary: files and size per folder, the largest files, and every script, hook, tool definition and executable listed in full. Over 2000 files, 20 MB, 12 folder levels or 150 runnable files the tool refuses and names the limit, what it measured and the shell command to run instead (for example {{program}} profile enable <name> [--switch]); do not retry, give the user that command.
Features (balanced): profile_tools (the profiles tool above); profile_capabilities (/marketplace preview shows declared capabilities and static hints from a bounded scan; absent hints never prove safety); official_profiles (the examples/official-profiles catalog, added by the user as a source: mendcode-review, mendcode-autoresearch, mendcode-web-routing, all on-demand skills). Catalogs never contact a service alone. A user's keep or override of a profile is recorded in activation.json. Turned off: [[setting:disabledProfiles]], [[setting:disabledProfileResources]].
A profile cannot change permissions, trust, credentials, budgets, models, sandbox, hooks or MCP through activate; the manifest fails the schema if it tries. The user manages profiles in /profiles (o lists what a profile overrides, p the precedence report). Install only what was asked.
