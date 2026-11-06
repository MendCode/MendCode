Use daemon settings to control resource discovery, instruction files, shell policy and network access. Inspect the saved configuration with `/debug-config`; secret values are never printed.

## Resources and config safety

All settings below are daemon settings, changed through `settings.set`. `/debug-config` is local only.

Remote and peer clients cannot set these fields:

| Restricted settings |
|---|
| `proxy` |
| `shellEnvironment`, `shellCommandPrefix`, `loginShell` |
| `web`, `sandbox` |
| `trustedToolDirs` (or run `tools.trust`) |
| `allowedHttpHookUrls` |
| `permission`, `permissionAllow` |
| `projectConfig` |

## `.agents` and `.claude` resources

MendCode reads, as data only, the folders other agents use:

| Folder | Read |
|---|---|
| `<project>/.agents/skills`, `~/.agents/skills` | skills |
| `<project>/.claude/{skills,commands,agents}`, `~/.claude/{skills,commands,agents}` | skills, slash commands, agents |
| `.mendcode` of the project's parent folders inside its repository (`repo/.mendcode` when you open `repo/apps/web`) | skills, slash commands, agents |

### Priority and parent folders

MendCode's own folders win on the same name: `.claude` sits under `~/.mendcode` (user) and `<project>/.mendcode` (project). The project's `.agents`/`.claude` beat the user's own folder.

Nothing executable is read from them: no tools, hooks, MCP, extensions or `mendcode.json`.

The parent-folder walk goes from the project's parent up to the folder holding `.git`, farthest first. The nearest folder wins and the project's own `.mendcode` wins over all of them.

These cases inherit nothing:

- A project that is itself the repository root.
- A folder outside any repository.
- A walk that would reach your home folder.

Like `.claude`, parent folders give prompt data only (v1 inherited command folders the same way). They are read even with `foreignResources` off.

### Claude commands and agents

| Claude command field or case | Behavior |
|---|---|
| `description`, `argument-hint` | Cut to fit |
| `model`, `agent` | Kept and applied only when that model or agent exists here; otherwise the session's model and current agent stay (`sonnet` or `Explore` names another tool's) |
| `subtask` | Works as in native files |
| File that does not fit | Reported and skipped |
| Built-in command name | Never replaced |
| `$ARGUMENTS`, `$1` and `` !`cmd` `` | Work as in MendCode's own commands; the shell part still goes through permissions |

Claude agent files keep `name`, `description`, `tools` and `disallowedTools`. Claude tool names are mapped: Read, Grep, Glob, LS, Bash→shell, Edit/Write, WebFetch, WebSearch…; unknown names are dropped.

`model`, `color`, `permissionMode` are ignored; `build` and `plan` are reserved. Project agents still need the project to be trusted (`/tools`).

### Symlinks and home folders

A project `.claude`/`.agents` that is a symlink leaving the project is skipped.

Inside a skills folder a symlinked directory is followed when it resolves inside the layer's own folder (or the project, for project layers), exactly like a symlinked `SKILL.md`. One that leaves is refused and listed in `/doctor`.

Home folders are read only by a daemon on the default data directory, or when `MENDCODE_FOREIGN_HOME` names the home. A daemon started with its own `--dir` stays self-contained.

Decision: on by default (v1 did the same and these are prompt data). `settings.set {"foreignResources": false}` turns it all off.

## Instruction files

### Choose the instruction file

Per directory, from the session directory up to the project root, the first file found wins, in this order:

1. `AGENTS.override.md`.
2. `AGENTS.md`.
3. `CLAUDE.md`.
4. `CONTEXT.md`.
5. `instructionFallbacks` names.

`AGENTS.override.md` replaces the rest in its directory (a local override; keep it out of git). In the data directory, `AGENTS.override.md` replaces the global `AGENTS.md`.

### Loading and limits

One loader serves both paths:

| Path | Instructions loaded |
|---|---|
| System prompt | The chain of directories from the session directory up to the project root |
| `read` tool and `@file` mentions | Directories below the session directory when a file there is read |

Both use the same file rule, `@include` lines and settings, with these limits:

| Limit | Value |
|---|---|
| Per file | 16,000 characters |
| Total | 64,000 characters |
| Files | 100 |
| Include depth | 8 |

A file is re-read when its inode, size, mtime or ctime changes, so a rewrite within a coarse filesystem's timestamp tick is still noticed.

On `read`, an edited instruction file is delivered again (a delivery is keyed by path and version); an unchanged one is not.

### Overrides, roots and extra files

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
- `--no-context-files` (alias `-nc`, TUI and `run`): leaves all instruction files out of that session's prompt, `SYSTEM.md` and `APPEND_SYSTEM.md` of every layer included (a per-session run limit; skills, memory and the packaged prompt stay).

## Skills, commands and agents: how files are read

### Frontmatter and names

Frontmatter is YAML (`Bun.YAML`): `description: |` blocks, quoted and multi-line values, lists and maps work as in Claude Code, Codex and pi files. The whole frontmatter is read.

A frontmatter that is not valid YAML falls back to `key: value` lines and says so. A skill's `name` may be namespaced (`plugin:skill`, `acme.lint`).

A skill is `/skill-name` when its name is slash-safe (letters, digits, `_ - :`).

### Layer quotas and diagnostics

Layers resolve first, caps apply after:

| Resource | Quota |
|---|---|
| Skills | 100-skill |
| Commands | 200-command |
| Agents | 100-agent |

Quotas drop the lowest-priority layers first, so project entries never fall off because a lower layer is full.

`/doctor` lists, one line each:

- What another layer overrides (`skill review (user) is overridden by project`).
- What a cap left out.
- Files that failed; one bad command or skill never stops the others.
- Fields read but not applied, and unknown fields.
- A skill or command a terminal built-in shadows; the built-in wins.

The skills page shows the same per skill.

### Supported fields

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

### Invoke skill commands

`/skill-name args` sends the skill's folder and body with `$ARGUMENTS` filled. Arguments are appended when the body has no placeholder.

Only `$ARGUMENTS` is replaced, and `!` shell markers in a skill body are never run. A skill whose `/name` is taken by a built-in or a custom command does not become a command; `/doctor` says so.

Skills of the profile that ships with MendCode itself stay out of the slash menu; the model and `/skills` reach them.

The `skill` tool called with no `name` lists the skills it can load. This is how the model finds them in `minimal` mode, where the prompt carries no catalog.

### Reload edited files

The daemon watches these locations with an 80 ms debounce and at most 16 project folders:

- The data directory: skills, commands, agents and extensions of its own and of its profiles.
- For projects trusted for project tools: the project's `.mendcode`, `.claude` and `.agents` folders including their profiles.

An edit reloads extensions and tells terminals; an untrusted project is never watched.

## Shell policy

For the model's `shell`, background `shell` and `shell_session` commands (the user's own `!command` too):

```json
{
  "shellEnvironment": { "inherit": "core", "exclude": ["AWS_*"], "includeOnly": ["PATH", "HOME", "LANG"], "set": { "CI": "1" }, "keepSecrets": false },
  "shellCommandPrefix": "set -u",
  "loginShell": true
}
```

When `shellEnvironment` is unset, the command inherits everything (unchanged). When set, the environment is built in this order:

1. Apply `inherit`: `all` (default), `core` (PATH, HOME, USER, SHELL, LANG, LC_*, TERM, TMPDIR, TZ…) or `none`.
2. Apply `includeOnly`.
3. Drop names containing KEY, SECRET, TOKEN, PASSWORD or CREDENTIAL unless `keepSecrets`.
4. Apply `exclude` (case-insensitive globs).
5. Apply `set` last.

The result is what the permission review sees.

| Setting | Effect | Default |
|---|---|---|
| `shellCommandPrefix` | Placed before the command in the same shell | Off unless set |
| `loginShell` | Starts POSIX shells with `-l` | Off unless set |

## Config problems

Settings the daemon ignores (invalid, unknown, or an unreadable `.mendcode/project.json`) are listed first under Warnings in `/debug-config`, and the TUI shows a one-line notice at startup. `--strict-config` (global flag) prints them to stderr and exits 78 before anything runs. Values are never shown, only the setting name and the reason.

## Proxy and CA

```json
{ "proxy": { "url": "http://proxy.local:3128", "noProxy": ["internal.corp", ".lan"], "caFile": "/etc/ssl/corp-ca.pem" } }
```

Every outbound request of the daemon (providers, search, fetch, MCP) goes through the proxy. Loopback and `noProxy` hosts (suffix match, `*` for all) go direct.

`caFile` (PEM, under 2 MB) is trusted in addition to the system roots. An unreadable file fails the request rather than skipping verification.

- http and https proxies only: no SOCKS, no CIDR in `noProxy`.
- The URL may carry credentials and is never logged or shown.
- Shell commands the model runs are not proxied; set `shellEnvironment.set` for those.

## Web domain rules

```json
{ "web": { "allowDomains": ["docs.example.com"], "blockDomains": ["spam.io"] } }
```

Rules apply to `webfetch` (every redirect hop) and `websearch` (results). A block wins; with an allow list only those domains and their subdomains pass.

`websearch` also takes `recency` (`day`, `week`, `month`, `year`):

| Provider | Recency | Domain filtering |
|---|---|---|
| Exa and Tavily | Sent to the provider | Domains passed natively |
| Brave | Sent to the provider | `-site:` terms |
| OpenRouter plugin | No date filter; the reply says so | |

Every result is checked locally either way.

## Settings the model proposes

The model can change any daemon setting through the `mendcode_settings` tool, only with your approval of that exact change. This includes tier, default permission, models and roles, compaction, budgets, output style, experimental flags and providers' extras.

It is lent to Claude Code sessions as `mcp__mendcode__mendcode_settings`.

### Inspect and propose

`get` returns the saved settings with secrets hidden:

- Values under credential-like names (`key`, `token`, `secret`, `password`, ...) read `[hidden]`.
- Every value of `env`, `headers` and `shellEnvironment.set` reads `[hidden]`.
- Secret-looking text is masked.

`propose { patch, reason }` takes a `settings.set` patch. Each top-level key's value replaces the whole value and `null` resets it.

The patch is validated against the settings schema first, without writing. An invalid one is refused and you are not asked; a patch that changes nothing is not asked either.

### Approve an exact change

1. Review the **Change MendCode settings?** question card. It shows one `path: before → after` line per changed value, with the same redaction on both sides, up to 24 lines, and `Why: <reason>`.
2. Choose **Apply** or **Don't apply**. Only Apply saves, through the same write as `settings.set`.
3. After Apply, every terminal gets `settings.changed` and the services that read the setting follow.

Any other answer, a typed reply or a dismissed card saves nothing.

A call from Claude Code that waits on the card for about 40 seconds is answered `Pending`, instead of the harness dropping it with a timeout. The card stays open while the turn runs and saves on Apply.

From a session another session started, the card is shown on the launching session too ([permissions](permissions.md#what-a-session-cannot-do-from-its-own-shell)).

### Approval boundaries

The card asks in every permission mode, `full` included, and in every tier: no mode, grant or allow rule answers it.

With nobody to ask (a headless `mendcode run`, a host without questions), the tool refuses and returns the change for you to make in `/settings`.

A patch naming a machine-only key is titled **Change MendCode settings? (answer on this machine)**. The daemon refuses an Apply to it from a remote or peer client.

Machine-only keys include `permission`, `sandbox`, `shellEnvironment`, `trustedToolDirs`, `proxy`, `projectConfig`, `tier`, `features`, `experimental` and the rest a remote `settings.set` refuses.

The model is told to propose only what you asked for and never to raise or remove a spend limit unless you asked for that exact change. Terminal look (theme, footer, prompt box) stays with `customize_ui`.

Code: `packages/packages/src/layers.ts`, `packages/engine-native/src/project-instructions.ts`, `packages/tools/src/shell-policy.ts`, `web-policy.ts`, `packages/daemon/src/network-policy.ts`, `config-layers.ts`.
