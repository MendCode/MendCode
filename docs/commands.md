# Commands

`/tsm` opens the terminal-session adapter manager; `/tsm setup`, `activate
--mux kitty`, `deactivate`, `remove`, `doctor` and `open TARGET` use the same
daemon contract as automation. See [TSM](tsm.md). Tab completes without executing.

`/init [focus]` investigates repository commands, instructions, CI and source before guiding creation or improvement of `AGENTS.md`. It runs in the current session; writing uses the normal tools and permission policy.

`/review [commit|branch|pr]` starts a saved child conversation, leaving the parent's selection and history unchanged. No argument reviews uncommitted changes, a commit uses `git show`, a branch compares its merge-base diff, and a PR requires the agent's available GitHub tooling. Enter opens the child in the TUI; reopen or cancel it with `/tasks`. Headless `--command review` waits for that child's result (or returns its id with `session send --async`). The prompt instructs review-only behavior; tool permissions remain the caller's policy.

`/git [changes | commit | worktrees]` opens the [Git page](git.md): review, a local commit of the files you tick, and worktrees. It has no alias; `/changes`, `/diff`, `/worktrees` and `/warp` open the same page on their tab.

## Bundled git and verify commands

Bundled prompts like `/init` and `/review`; they run in the current session, so every `git`, `gh` and build command goes through the shell tool and the normal approval policy. A project or user command with the same name overrides them. They are not available to read-only peers (`commands.execute`).

- `/commit [hint]` inspects status and diff, stages only the files of the change by path, skips secrets and local data, commits in the repository's message style and stops. Never `--no-verify`, `--amend` or a config change.
- `/commit push [hint]` does the same, then pushes the current branch (`-u origin <branch>` when it has no upstream). Never forces; on `main`/`master` it asks first.
- `/commit pr [title hint]` branches off the default branch when needed, commits, pushes and opens the pull request with `gh pr create`. Without `gh` or authentication it reports the manual steps.
- `/pr comments [number|url]` reads the conversation, inline review comments and reviews of a pull request (the current branch's by default) and groups them by file and line. Read-only; comment text is treated as data.
- `/security-review [commit|branch|path]` is a read-only child (`explore` agent, no edit tools) that reports only exploitable findings with a concrete attack path and never prints secret values.
- `/bughunter [security|perf] [scope]` is a read-only child (`explore` agent) that runs four phases: map the riskiest files, hunt, a skeptic pass that drops low-confidence candidates, and minimal fix proposals it never applies. Output is a scored table (file:line, severity, confidence, trigger, fix). Based on OpenClaude's `/bughunter`.
- `/ultraplan <task>` is a read-only child that grounds the plan in the code, compares options, writes ordered steps with a check each, then critiques its own plan. Local only: OpenClaude's `/ultraplan` launches a remote cloud session, which v2 does not do. It never implements.
- `/wiki [init|status|scan|ingest <path>|query <question>]` keeps a markdown project wiki in `.mendcode/wiki` (`index.md`, `log.md`, `conventions.md`, `pages/`, `sources/`). It runs in the current session, so every write and read uses the normal file tools and approvals, stays inside that folder and treats ingested text as data. Without arguments it reports status.
- `/verify [focus]` detects typecheck, lint, build and test commands from the repository, runs them, boots the app on a local port with a temporary data dir when it has a documented start command, and reports a step table. Browser and screenshot checks are not included; with `MENDCODE_BROWSER=1` the agent can do them with the [browser tool](browser.md). The `verify` of `workflow verify <id>` is a different, existing feature.

## Definition

Put a `command` map in `mendcode.json` (or `mendcode.jsonc`, which may hold comments and trailing commas; with both, the `.jsonc` one wins a name both define) at the project root, user data directory or an extension layer:

```json
{
  "command": {
    "audit": {
      "description": "Inspect code",
      "argument-hint": "<scope>",
      "template": "Review @notes.txt for $ARGUMENTS",
      "agent": "explore",
      "model": "openai/gpt-6-luna",
      "subtask": true
    }
  }
}
```

Markdown in `command/*.md` or `commands/*.md` accepts the same `description`, `argument-hint`, `agent`, `model` and boolean `subtask` frontmatter; the body is the template. Nested folders become `name:space`. Project definitions override user definitions; markdown overrides JSON within its layer. Extension-registered commands win name collisions. Templates and expanded prompts are limited to 32,000 characters. The frontmatter is YAML (multi-line `description: |`, quoted values, lists); `allowed-tools` is read and noted but never applied, and unknown fields are listed. The 200-command cap applies after precedence (the lowest-priority layers drop first). A file or `mendcode.json` entry that does not fit is listed in `/doctor` and skipped; the other commands still load. Enabled skills run as `/skill-name` (built-in and custom commands win a name clash, which `/doctor` reports). The field-by-field table for skills and commands is in [resources](resources-config.md#skills-commands-and-agents-how-files-are-read).

A JSON `template` may be `{file:./prompts/audit.md}` (v1's and opencode's spelling, also inside a longer template): the
file's text, relative to the config file, read when commands load. It must stay inside the project (for the project's own
files), the data directory or the package, and be at most 256 KB; an entry whose file is missing or outside is listed in
`/doctor` and skipped.

`$ARGUMENTS` preserves the argument string. `$1`, `$2`, … bind quoted positional arguments; the highest numbered placeholder consumes the remaining arguments. With no placeholders, arguments are appended. `@file` and `@directory` use the native engine's project mention resolver and trust rules.

`!` followed by a backtick-delimited shell command embeds its output. Only markers written in the template are expanded, at most 20; each runs in the session project with a 30-second deadline. Project inline shell requires `/tools` trust and is refused in plan mode. Each fragment runs as an ordinary `shell` tool call of the turn, so it meets the same permission decision as the model's own commands: an approval card in `ask` (and `edits`/`smart` when the command is not allowed), your deny rules and allow rules, auto-run in `full` access, the OS sandbox and the shell hooks. Nothing runs before the turn starts; a refused, failed or oversized fragment fails the turn before any model call. Inline shell needs the native engine and a native model.

Arguments are passed safely: in a shell fragment `$1`…`$9` and `$ARGUMENTS` become single-quoted words (the highest placeholder and `$ARGUMENTS` give every remaining word, each quoted), so `/show "HEAD; echo x"` runs `git show 'HEAD; echo x'`, never a second command. Write placeholders unquoted: a placeholder with a value that would land inside quotes (`"$1"`, `'$1'`) or after a backslash cannot be quoted safely, and the command is refused with a message naming it (an empty value inserts nothing and is fine). Placeholders outside shell fragments are plain text as before. On Windows placeholders in shell fragments are refused. Output is never re-expanded as a template, and the original invocation—not shell output or the expanded prompt—is displayed in chat.

## Selection and MCP

Model priority is command model, then an explicit command agent's model, then the current session model. Selection is per turn, never a change to the parent; on a Claude Code or ACP session it follows [claude-code.md](claude-code.md), and a subtask command needs a native session. A subagent defaults to a child unless `subtask: false`; `subtask: true` forces a child, subject to existing admission limits, cancellation and restart handling. Execution attributes require a native session and model. Unknown/untrusted agents or unavailable models are refused before shell expansion.

Opening slash completion lazily discovers enabled MCP prompts through `commands.discover`; passive `commands.list` only uses cached metadata and never starts a server. A prompt appears as `/server:prompt <required> [optional]`. Quoted positional arguments bind the server's named arguments. Only text prompt messages are supported; media/resources are explicitly refused. Server prompt content is data: inline shell markers in it are not executed. Real MCP or PR service availability is not guaranteed by the local fixture tests.

A custom command or skill can also be named after other text: typing `/` at the start of a word opens the same suggestions as `@` mentions (custom commands and skills only; built-ins stay at the start of the prompt), and on send `explain the parser /review` runs as `/review explain the parser`. Paths such as `/usr/bin` and unknown names stay text.

TUI Tab completes without executing; Enter sends `commands.execute`. `run --command NAME` and `session send ID --command NAME` use the same daemon path with attachments and separate file context. `commands.expand` remains a read-only text compatibility helper, not an execution endpoint. Neither `commands.execute` nor `commands.discover` is available to read-only peers.

`/tier [minimalist|balanced|full|off]` and `/tier <feature> on|off|default`: the feature tier and per-feature overrides ([tiers](tiers.md)). `--safe-mode` starts without extensions, packages, hooks, MCP and project tools.

B17 small commands: `/fast [on|off]` ([fast mode](providers.md)), `/output-style [name]` ([styles](prompt-modes.md)),
`/experimental [flag [on|off]]` (lists the boolean `experimental` flags, all off by default, and
toggles one while keeping the other `experimental` values), `/debug-config` (the config layers
from defaults to environment, local only, no secret values; also `control-plane system config-layers`),
`/cd PATH` (moves this idle session and its children to an existing directory; relative to the session, `~` is the
home; refuses while a turn, queue or child work is running, and for remote terminals) and `/pwd`. Moving drops the
session's runtime grants. Settings commands are refused for read-only peers.

`/mflow` manages room coordination, peer/file leases and local relay setup: [Mflow](mflow.md) (B73).

`/remote-control` runs the opt-in Telegram bridge: `on`, `off`, `pair`, `unpair [chat id]`; see [channels](channels.md) (B13).

`/voice` (key `ctrl+x v`) is opt-in push-to-talk dictation: record, press again to transcribe into the prompt. `on`, `off`, `status`, `start`, `stop`, `cancel`, `language <code|auto>`; see [voice](voice.md) (B14).

B74: `/org`, `/console`, `/share [create|sync]`, `/unshare`; headless `console` and `share`. See [Console and sharing](console.md).

## Arguments

After a command's name and a space the `/` menu lists the fixed words that command takes (`view/slash-arguments.ts`): `/pr ` shows
`on`, `off`, `review`, `comments`, `watch`, `watch-repo`, `publish`…; `/experimental ` the flags, and after a flag `on`, `off`, `toggle`;
`/tier `, `/graph `, `/sandbox `, `/git `, `/stash ` and the others the same way. The exact word comes first, then words that start with
what is typed, then words that only contain it. Tab writes the highlighted word and a space, so a second Tab goes on to the next word
(`/pr pub` Tab `/pr publish ` Tab `/pr publish on `). Enter on a half-typed word runs the highlighted one; on a word another word must
follow (`publish`) it only writes it; on a blank word (`/experimental `) it runs the command as typed. Paths, numbers and free text
are never guessed: no row is shown for them. A command the tier leaves out lists no words, and a word of a feature that is off
(`/panel galaxy`) is left out.

## Aliases

A built-in command has at most one other name, and only when it is the word people bring from other tools or a universal short form. `/quit` is the one command with two (`/exit`, `/q`). The aliases are `/changes`=`/diff`, `/sessions`=`/resume`, `/settings`=`/config`, `/quit`=`/exit` `/q`, `/help`=`/?`, `/mcps`=`/mcp`, `/find`=`/search`, `/usage`=`/stats`, `/model`=`/models`, `/theme`=`/themes`, `/keymap`=`/keybindings`, `/context`=`/ctx`, `/memory`=`/mem`, `/extensions`=`/ext`, `/packages`=`/pkg`, `/workflows`=`/wf`, `/loops`=`/loop`, `/bg`=`/background`, `/permissions`=`/perm`, `/providers`=`/provider`, `/jump-to-latest`=`/jump`, `/pr`=`/pr-watch`.

A command whose feature is off is left out of browsing and of prefix matches, but its exact name or alias finds one muted
row that says how to turn it on: `/pr  off · /tier balanced` when the tier does not include it, `off · /experimental <flag> on`
when its own flag is off, `off · /tier <feature> on` for an override or an opt-in feature. Enter, Tab or a click on that row
runs nothing and shows the same line; `/panel` and `/sidebar` still answer for themselves.

A name that used to be an alias is no command and nothing runs: the terminal answers one line, `/tui is now /customize`, and keeps the prompt out of the history. The line is a fixed table of the removed names, never a guess; a command file, an extension command or a profile alias of the same name is run instead. `/commit-push` and `/commit-pr` were two behaviours under one name: they are now `/commit push` and `/commit pr`. The old pr-comments name is now `/pr comments`: every pull request word lives under `/pr`.

Your own aliases are `aliases` on an entry of `slashCommands` in the terminal profile: `{ "name": "changes", "aliases": ["d"] }` makes `/d` run `/changes` (the arguments follow). `/customize` > Slash menu > Edit commands shows them; see [customize](customize.md#aliases-of-your-own).

`/ps` opens a card over the prompt with what runs in the background of the open session: the commands the model started with `shell` in the background and the background commands and agents of Claude Code, each with its kind and run time. ↑↓ select, `x` stops the selected item, `a` stops all of them, Esc closes. The row over the prompt that names background work ends with `/ps`. A command the user stopped is `killed (user)` when the model reads it, and nothing wakes the model for it; a Claude Code task is stopped through Claude Code's own `stop_task` request, and one it refuses is named in the notice. Clients send `background.stop` with the session and, for one item, the id `background.list` gave it.
