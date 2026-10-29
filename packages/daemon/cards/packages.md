---
summary: bundle skills, commands, agents, themes, keys, views; install and share them
docs: packages, customize
aliases: package, pkg, bundle
---
A package is a folder with mendcode-package.json that carries any of: skills/ commands/ agents/ tools/ themes/ extensions/ hooks mcp.json keybindings, and optionally a whole look (activate: theme, tuiProfile, views, keybindings). Disabling or removing one puts everything back; your own settings win over a package's.
  mendcode-package.json: { "name": "acme", "version": "1.0.0", "description": "..." }   (name: lowercase letters, digits, . _ - and equal to the folder name; also author, homepage, license)
Commands (add --project for this project's .mendcode/packages; else user scope; your shell: only new, check, list):
  {{program}} package new <name> [--dir PARENT]     scaffold a complete, commented package that already loads
  {{program}} package check [folder]                validate without running anything (schema, compatibility, capabilities, forbidden keys, size)
  {{program}} package install <folder|github:owner/repo#ref|git:URL|npm:name@x.y.z> [--replace]   refuses links, secrets and trees over 2000 files or 20 MB
  {{program}} package list | config [name] | enable|disable <name> [--switch] | remove <name> [--purge] | restore <name>
  {{program}} packages create   snapshots this project's .mendcode/ (own setup: docs profile)
To try one, write it straight into <project>/.mendcode/packages/<name>/ or <data dir>/packages/<name>/; no restart.
In chat, the packages tool (find it with tool_search) does list, info, search, check (read-only) and install, enable, disable, switch-look, remove, new (each needs an approval card, even in full permission mode; install takes only an exact name from a configured local source). One package owns the look per scope; switch-look says which.
The approval card of a big package is a summary: files and size per folder, the largest files, and every script, hook, tool definition and executable listed in full. Over 2000 files, 20 MB, 12 folder levels or 150 runnable files the tool refuses and names the limit, what it measured and the shell command to run instead (for example {{program}} package enable <name> [--switch]); do not retry the tool, give the user that command.
Features (balanced): package_tools (the packages tool above); package_capabilities (the user's /marketplace preview shows declared capabilities and static hints from a bounded scan; absent hints never prove safety); official_packages (the examples/official-packages catalog, added by the user as a source: mendcode-review, mendcode-autoresearch, mendcode-web-routing, all on-demand skills). Catalogs never contact a service on their own. A user's keep or override of a package is recorded in activation.json. Turned off: [[setting:disabledPackages]], [[setting:disabledPackageResources]].
A package cannot change permissions, trust, credentials, budgets, models, sandbox, hooks or MCP through activate; the manifest fails the schema if it tries. The user manages packages in /packages (o lists what a package overrides, p the precedence report). Install only what the user asked for.
