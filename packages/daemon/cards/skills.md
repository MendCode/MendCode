---
summary: write a skill the model loads for a kind of task
docs: resources-config
aliases: skill
---
A skill is instructions for a kind of task: <data dir>/skills/<name>/SKILL.md (every project) or <project>/.mendcode/skills/<name>/SKILL.md (that project). MendCode also reads .agents/skills and .claude/skills as data. Nothing ships built in.
  ---
  name: release-notes
  description: Draft release notes from merged PRs. Use when asked for a changelog or release notes.
  ---
  Steps, rules, examples... Other files in the folder can be referenced by path from the body.
Only name and description ride in every prompt (the description is cut at 300 characters, so it must say when to use the skill); the body loads when the model calls the skill tool (called with no name it lists them). The user runs an enabled skill as /<name> [args]; $ARGUMENTS in the body is replaced.
Optional frontmatter: argument-hint; model (applies when run as /<name>); disable-model-invocation: true (only the user runs it); user-invocable: false (hidden from the menu, the model still sees it); on-demand: true (left out of the prompt catalog, loadable by name). allowed-tools is only noted: a skill never grants permissions.
New files are picked up by the file watcher; /skills (user) lists them with what overrides what. Layers: user packages, user folder, project packages, project folder, later wins a name.
A skill exists only as a file in those folders or in a package: the skill tool cannot fetch one by name or from a URL ("unknown skill" lists what is installed). To use one from elsewhere, the user saves its SKILL.md under <data dir>/skills/<name>/ or installs the package that holds it.
Extra skill locations are the user's daemon setting [[setting:skills]] { paths, urls }; the skill tool still only loads what is installed.
Check: /skills lists what is installed and what overrides what; /doctor lists shadowed ones.
Share several skills with commands and themes as a package: {{program}} docs packages.
