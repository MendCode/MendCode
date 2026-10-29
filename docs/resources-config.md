# Resources and config safety

All settings below are daemon settings (`settings.set`, `/debug-config` to inspect). Secret values are never printed. Remote and peer clients cannot set `proxy`, `shellEnvironment`, `shellCommandPrefix`, `loginShell`, `web`, `sandbox`, `trustedToolDirs` (or run `tools.trust`), `allowedHttpHookUrls`, `permission`, `permissionAllow` or `projectConfig`, and `/debug-config` is local only.

## `.agents` and `.claude` resources

MendCode reads, as data only, the folders other agents use:

| Folder | Read |
|---|---|
| `<project>/.agents/skills`, `~/.agents/skills` | skills |
| `<project>/.claude/{skills,commands,agents}`, `~/.claude/{skills,commands,agents}` | skills, slash commands, agents |
| `.mendcode` of the project's parent folders inside its repository (`repo/.mendcode` when you open `repo/apps/web`) | skills, slash commands, agents |

- MendCode's own folders win on the same name: `.claude` sits under `~/.mendcode-v2` (user) and `<project>/.mendcode` (project). The project's `.agents`/`.claude` beat the user's own folder.
- Nothing executable is read from them: no tools, hooks, MCP, extensions or `mendcode.json`.
- Parent folders: the walk goes from the project's parent up to the folder holding `.git`, farthest first, so the nearest
  folder wins and the project's own `.mendcode` wins over all of them. A project that is itself the repository root, a
  folder outside any repository, and a walk that would reach your home folder inherit nothing. Like `.claude`, they give
  prompt data only (v1 inherited command folders the same way); they are read even with `foreignResources` off.
- Claude command files: `description` and `argument-hint` are cut to fit; `model` and `agent` are kept and applied only when that model or agent exists here (`sonnet` or `Explore` names another tool's), otherwise the session's model and the current agent stay; `subtask` works as in native files; a file that does not fit is reported and skipped, and a command never replaces a built-in. `$ARGUMENTS`, `$1` and `` !`cmd` `` work as in MendCode's own commands (the shell part still goes through permissions).
- Claude agent files keep `name`, `description`, `tools` and `disallowedTools` (Claude tool names mapped: Read, Grep, Glob, LS, Bash→shell, Edit/Write, WebFetch, WebSearch…; unknown names are dropped). `model`, `color`, `permissionMode` are ignored; `build` and `plan` are reserved. Project agents still need the project to be trusted (`/tools`).
- A project `.claude`/`.agents` that is a symlink leaving the project is skipped. Inside a skills folder a symlinked directory is followed when it resolves inside the layer's own folder (or the project, for project layers), exactly like a symlinked `SKILL.md`; one that leaves is refused and listed in `/doctor`.
- Home folders are read only by a daemon on the default data directory, or when `MENDCODE_FOREIGN_HOME` names the home. A daemon started with its own `--dir` stays self-contained.
- Decision: on by default (v1 did the same and these are prompt data). `settings.set {"foreignResources": false}` turns it all off.

## Instruction files

Per directory, from the session directory up to the project root, the first file found of `AGENTS.override.md`, `AGENTS.md`, `CLAUDE.md`, `CONTEXT.md`, then `instructionFallbacks` names. `AGENTS.override.md` replaces the rest in its directory (a local override; keep it out of git). In the data directory, `AGENTS.override.md` replaces the global `AGENTS.md`.

One loader serves both paths. The system prompt gets the chain of directories from the session directory up to the project root, and the `read` tool and `@file` mentions get the instructions of the directories below the session directory when a file there is read. Both use the same file rule, `@include` lines, limits (16,000 characters per file, 64,000 in total, 100 files, include depth 8) and settings. A file is re-read when its mtime or size changes; on `read`, an edited instruction file is delivered again (a delivery is keyed by path and version), an unchanged one is not.

- Both `AGENTS.md` and `CLAUDE.md` in one directory: `AGENTS.md` is used and `CLAUDE.md` is not, so a `CLAUDE.md` that is only `@AGENTS.md` (or a symlink to it) never loads twice. A `CLAUDE.md` with its own content next to an `AGENTS.md` is not read; put it behind an `@CLAUDE.md` line in `AGENTS.md` (include) or use `AGENTS.override.md` for the local part. The rule is documented and tested; change it only for a real layout it breaks.
- `projectRootMarkers` (default `[".git"]`): names that mark the root while walking up. `[]` reads the session directory only. With no marker in sight the walk is bounded: inside the user's home it stops at the home (or where the filesystem changes), elsewhere only the session directory is used. It never reaches `/`.
- `instructionFallbacks`: extra file names (no `/`), used only where no standard file exists.
- `instructions` (settings) and `instructions` in `.mendcode/project.json`: extra files or globs (a project's stay inside
  the project). An `https://` entry in your own settings is downloaded by the daemon (at start, when the setting changes,
  then again when the copy is older than 10 minutes; 5-second timeout, at most 64 KB, a redirect must stay on https) into
  `<data dir>/instructions-remote/`, and the prompt reads that copy: a URL added while a session runs reaches the next
  prompt once downloaded, and a failed refresh keeps the last copy (logged as `[INSTRUCTIONS]:` on the daemon's stderr).
  `http://` and any URL in a project's config are listed as blocked, never fetched: a repository cannot pull in text that
  changes after you reviewed it. v1 read remote instructions the same way.
- Every prompt mode carries these files ([prompt modes](prompt-modes.md)); `--no-context-files` is the only way to leave them out.
- `--no-context-files` (alias `-nc`, TUI and `run`): leaves all instruction files out of that session's prompt (a per-session run limit; skills, memory and the packaged prompt stay).

## Skills, commands and agents: how files are read

Frontmatter is YAML (`Bun.YAML`): `description: |` blocks, quoted and multi-line values, lists and maps work as in Claude Code, Codex and pi files; the whole frontmatter is read. A frontmatter that is not valid YAML falls back to `key: value` lines and says so. A skill's `name` may be namespaced (`plugin:skill`, `acme.lint`); a skill is `/skill-name` when its name is slash-safe (letters, digits, `_ - :`).

Layers resolve first, caps apply after: the 100-skill, 200-command and 100-agent quotas drop the lowest-priority layers first, so project entries never fall off because a lower layer is full. `/doctor` lists, one line each: what another layer overrides (`skill review (user) is overridden by project`), what a cap left out, files that failed (one bad command or skill never stops the others), fields read but not applied, and unknown fields. The skills page shows the same per skill, `/doctor` also lists a skill or command a terminal built-in shadows (the built-in wins).

Honoured means applied; noted means read and shown as a note (on load, in `/skills`, in `/doctor`) but not applied; ignored means not read, and the field name is listed.

| Field | Skill (`SKILL.md`) | Command (`commands/*.md`, `command/*.md`, `.claude/commands`) |
|---|---|---|
| `name` | honoured (namespaced names, lowercase) | not read: the file path names it (`dir/file.md` is `dir:file`) |
| `description` | honoured (one line, 300 characters, in the catalog) | honoured (120 characters in `.claude`) |
| `argument-hint` | honoured (shown in the slash menu of `/skill-name`); `[a]` and `<a>` forms | honoured |
| `allowed-tools` | noted: a skill file neither grants nor restricts tools here, normal permissions apply (in Claude Code and Agent Skills it pre-approves tools; MendCode does not widen permissions from a file) | noted, same reason |
| `model` | noted when the model loads the skill; honoured as `/skill-name` when the model exists, else the session model stays | honoured; for `.claude` and skill commands only when the model exists |
| `effort` | noted | ignored |
| `agent` | ignored | honoured; for `.claude` only when a trusted agent of that name exists |
| `subtask` | ignored | honoured |
| `disable-model-invocation: true` | honoured: not in the catalog, not listed or loaded by the `skill` tool; the user runs it as `/name` | ignored |
| `user-invocable: false` | honoured: hidden from `/skills` and the slash menu; the model still sees it | ignored |
| `on-demand: true` | honoured (MendCode): kept out of the catalog, loadable by name | ignored |
| `license`, `compatibility`, `metadata`, `version` | read, informational | ignored |
| anything else (`context`, `hooks`, `paths`, …) | ignored, listed once | ignored, listed once |
| Codex `$NAME` placeholders (`argument-hint: FILE=<path>`) | not applicable | not substituted: noted; use `$1`…`$9` or `$ARGUMENTS` |

Skill commands: `/skill-name args` sends the skill's folder and body with `$ARGUMENTS` filled (arguments are appended when the body has no placeholder). Only `$ARGUMENTS` is replaced, and `!` shell markers in a skill body are never run. A skill whose `/name` is taken by a built-in or a custom command does not become a command; `/doctor` says so. Skills of the package that ships with MendCode itself stay out of the slash menu (the model and `/skills` reach them). The `skill` tool called with no `name` lists the skills it can load, which is how the model finds them in `minimal` mode, where the prompt carries no catalog.

Reload: the daemon watches the data directory (skills, commands, agents and extensions of its own and of its packages) and, for projects trusted for project tools, the project's `.mendcode`, `.claude` and `.agents` folders including their packages, with an 80 ms debounce and at most 16 project folders. An edit reloads extensions and tells terminals; an untrusted project is never watched.

## Shell policy

For the model's `shell`, background `shell` and `shell_session` commands (the user's own `!command` too):

```json
{
  "shellEnvironment": { "inherit": "core", "exclude": ["AWS_*"], "includeOnly": ["PATH", "HOME", "LANG"], "set": { "CI": "1" }, "keepSecrets": false },
  "shellCommandPrefix": "set -u",
  "loginShell": true
}
```

- `shellEnvironment` unset: the command inherits everything (unchanged). When set: `inherit` `all` (default), `core` (PATH, HOME, USER, SHELL, LANG, LC_*, TERM, TMPDIR, TZ…) or `none`; then `includeOnly`, then names containing KEY, SECRET, TOKEN, PASSWORD or CREDENTIAL are dropped unless `keepSecrets`, then `exclude` (case-insensitive globs); `set` is applied last. The result is what the permission review sees.
- `shellCommandPrefix` is placed before the command in the same shell. `loginShell` starts POSIX shells with `-l`. Both off unless set.

## Config problems

Settings the daemon ignores (invalid, unknown, or an unreadable `.mendcode/project.json`) are listed first under Warnings in `/debug-config`, and the TUI shows a one-line notice at startup. `--strict-config` (global flag) prints them to stderr and exits 78 before anything runs. Values are never shown, only the setting name and the reason.

## Proxy and CA

```json
{ "proxy": { "url": "http://proxy.local:3128", "noProxy": ["internal.corp", ".lan"], "caFile": "/etc/ssl/corp-ca.pem" } }
```

Every outbound request of the daemon (providers, search, fetch, MCP) goes through the proxy; loopback and `noProxy` hosts (suffix match, `*` for all) go direct. `caFile` (PEM, under 2 MB) is trusted in addition to the system roots; an unreadable file fails the request rather than skipping verification. http and https proxies only (no SOCKS, no CIDR in `noProxy`). The URL may carry credentials and is never logged or shown. Shell commands the model runs are not proxied; set `shellEnvironment.set` for those.

## Web domain rules

```json
{ "web": { "allowDomains": ["docs.example.com"], "blockDomains": ["spam.io"] } }
```

Apply to `webfetch` (every redirect hop) and `websearch` (results). A block wins; with an allow list only those domains and their subdomains pass. `websearch` also takes `recency` (`day`, `week`, `month`, `year`): sent to Exa, Brave and Tavily; the OpenRouter plugin has no date filter, so the reply says so. Exa and Tavily get the domains natively, Brave gets `-site:` terms, and every result is checked locally either way.

## Settings the model proposes

The model can change any daemon setting (tier, default permission, models and roles, compaction, budgets, output style, experimental flags, providers' extras, ...) through the `mendcode_settings` tool, and only with your approval of that exact change. It is lent to Claude Code sessions as `mcp__mendcode__mendcode_settings`.

- `get` returns the saved settings with secrets hidden: values under credential-like names (`key`, `token`, `secret`, `password`, ...) and every value of `env`, `headers` and `shellEnvironment.set` read `[hidden]`, and secret-looking text is masked.
- `propose { patch, reason }` takes a `settings.set` patch: each top-level key's value replaces the whole value and `null` resets it. The patch is validated against the settings schema first, without writing; an invalid one is refused and you are not asked. A patch that changes nothing is not asked either.
- Otherwise a question card **Change MendCode settings?** shows one `path: before → after` line per changed value (the same redaction on both sides, up to 24 lines) and `Why: <reason>`, with **Apply** and **Don't apply**. Only Apply saves, through the same write as `settings.set`: every terminal gets `settings.changed` and the services that read the setting follow. Any other answer, a typed reply or a dismissed card saves nothing.

The card asks in every permission mode, `full` included, and in every tier: no mode, grant or allow rule answers it. With nobody to ask (a headless `mendcode run`, a host without questions) the tool refuses and returns the change for you to make in `/settings`. A patch that names a key only the machine running MendCode sets (`permission`, `sandbox`, `shellEnvironment`, `trustedToolDirs`, `proxy`, `projectConfig`, `tier`, `features`, `experimental` and the rest a remote `settings.set` refuses) is titled **Change MendCode settings? (answer on this machine)**, and the daemon refuses an Apply to it from a remote or peer client. The model is told to propose only what you asked for and never to raise or remove a spend limit unless you asked for that exact change. Terminal look (theme, footer, prompt box) stays with `customize_ui`.

Code: `packages/packages/src/layers.ts`, `packages/engine-native/src/project-instructions.ts`, `packages/tools/src/shell-policy.ts`, `web-policy.ts`, `packages/daemon/src/network-policy.ts`, `config-layers.ts`.
