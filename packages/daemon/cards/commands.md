---
summary: the built-in slash commands, hide/pin/alias them; add a custom command
docs: commands, customize, resources-config
aliases: command, slash, slash-commands, prompts, aliases
---
Built-in slash commands are typed by the user (Tab completes, Enter runs); the model cannot type them. The list below is this install's: its tier, the commands it offers by menu group (name=alias), what the profile hides, pins or moves, the user's own commands and aliases, and what the next tier adds. {{program}} docs commands <name> prints one command.
Set up the menu: <data dir>/tui/profile.json, key slashCommands, a list with one entry per command (only name is required):
  { "name": "changes", "aliases": ["d"], "pinned": true, "hidden": false, "group": "code", "order": 2 }
aliases: up to 8 lowercase words (letters, digits, - _) that run the command with its arguments (alias d on changes: the user types the alias, then arguments, and /changes runs with them); never a built-in's name or alias, never used twice. hidden: true takes it out of the menu's browsing (typing still finds it and it runs); hidden: false lists one the tier leaves out. pinned: first in its group and in recent. group: session|context|code|agents|setup|look|more. order: 0..10000 within the group. A word that was a built-in alias once is no command: it answers "/<word> is now /<command>".
Apply: customize_ui {"action":"settings","values":{"slashCommands":[{ "name": "changes", "aliases": ["d"] }]}} (in minimalist find the tool with tool_search). The value REPLACES the whole list: send every entry to keep, from "slashCommands now" below. It is validated (an error changes nothing), saved and applied live to every open terminal. Undo: send the old list, or {{program}} control-plane tui rollback. Editing the file by hand also works and applies on the next start. The user's way: /customize > Slash menu > Edit commands (h hides, p pins, arrows regroup).
A command that computes something (a UUID, the branch) with no model turn: {{program}} docs extend. A prompt command is a markdown file: <data dir>/commands/<name>.md (or <project>/.mendcode/commands/<name>.md, which wins). Typed as /<name>; a subfolder becomes folder:name. The body is the prompt template.
  ---
  description: Review the diff of a branch
  argument-hint: <branch>
  ---
  Review the changes of $1 against main. Point out bugs first.
Frontmatter: description, argument-hint, agent, model, subtask (true runs it as a sub-agent). $ARGUMENTS is everything after the name, $1..$9 the quoted words; with no placeholder the arguments are appended. @path inlines a file; !`cmd` embeds a command's output (through normal permissions; project ones need /tools trust). Templates are capped at 32,000 characters.
Without a file: a "command" map in mendcode.json (data dir or project root): { "command": { "audit": { "description": "...", "template": "Review $ARGUMENTS", "agent": "explore", "subtask": true } } }. An enabled skill also runs as /<skill-name>. A command never replaces a built-in. /doctor lists commands that fail or are shadowed.
Everything the program offers outside a session is a CLI command: {{program}} help.
