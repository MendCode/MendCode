# Commands

Use commands for feature setup, repository work and reusable prompts.

## Notices

Every command reply, confirmation, warning, error and daemon notice is the same one-row notice. One shows at a time; a newer one replaces it.

- **Shape:** a severity mark, an optional bold title, a short message in words and a muted hint for what to do next (`Minimalist: small prompt, 11 of 77 features on · /tier full to go back`). The mark has a glyph and the theme's colour: `✓` success, `•` info, `!` warning, `✗` error (`+`, `*`, `!`, `x` with ASCII glyphs).
- **Place:** in a chat, the notice row above the prompt; it never covers the transcript. On a page, which has no prompt, the same row sits in the top right corner on the panel fill.
- **How long:** info and success go after 5 s (a command can ask longer) and when you change page; a warning stays 8 s; an error stays until you send the next prompt or command, a newer notice replaces it, or you open it with F4.
- **More:** when the row has to cut the message, or the message is a summary of a longer reply, it ends with `F4 details`. **F4** opens the latest notice's full text on the shared scrollable text page without interrupting the prompt or an open form.

| Key | Does |
|---|---|
| ↑↓, Space, PgUp/PgDn, g/G | read the whole reply |
| Esc | restore the previous page |

The latest full text stays one key away after the notice has gone. The same rule applies to daemon errors and extension replies; `/pr repos` opens its list directly.

## One-step feature setup

- `/pr setup [all|requested]` (balanced): checks prerequisites, then one confirmation enables reviews, watches this repository
  and allows GitHub publishing. Already-configured steps are skipped. See [PR setup](pr-review-setup.md#one-step-setup).
  Headless: `mendcode pr setup [all|requested] --session ID [--yes] [--json]`.
- `/voice setup` (full): shows the selected transcription provider, upload implications and readiness. One confirmation enables
  dictation without recording; missing credentials, recorder or OS permissions remain visible with recovery guidance.
- `/graph setup` (balanced): one confirmation enables indexing for this project and builds or refreshes its local code graph.
  Global defaults, autopilot and model settings stay unchanged; protected folders remain excluded.

Setup uses the existing scrollable page and keyboard controls; Escape cancels before applying. Existing feature subcommands
continue to work. No setup silently changes tiers or installs dependencies.

### Terminal-session adapters

`/tsm` opens the terminal-session adapter manager. Tab completes without executing.

Its `/tsm setup`, `activate
--mux kitty`, `deactivate`, `remove`, `doctor` and `open TARGET` operations use the same daemon contract as automation. See [TSM](tsm.md).

### Repository instructions and approvals

`/init [focus]` investigates repository commands, instructions, CI and source before guiding creation or improvement of `AGENTS.md`. It runs in the current session; writing uses the normal tools and permission policy.

`/approvals` goes to the session whose card lists the child sessions waiting for your approval.

### Review changes

`/review [commit|branch|pr]` starts a saved child conversation, leaving the parent's selection and history unchanged.

| Input | Reviews |
|---|---|
| No argument | uncommitted changes |
| Commit | `git show` |
| Branch | its merge-base diff |
| PR | requires the agent's available GitHub tooling |

1. Start the review. The prompt instructs review-only behavior; tool permissions remain the caller's policy.
2. Press Enter to open the child in the TUI.
3. Use `/tasks` to reopen or cancel it.

Headless `--command review` waits for the child's result, or returns its id with `session send --async`.

### Open Git

`/git [changes | commit | worktrees]` opens the [Git page](git.md): review, a local commit of the files you tick, and worktrees.

It has no alias. `/changes`, `/diff`, `/worktrees` and `/warp` open the same page on their tab.

## Bundled git and verify commands

Bundled prompts like `/init` and `/review`; they run in the current session, so every `git`, `gh` and build command goes through the shell tool and the normal approval policy. A project or user command with the same name overrides them. They are not available to read-only peers (`commands.execute`).

### Commit and publish

| Command | Does | Limits |
|---|---|---|
| `/commit [hint]` | inspects status and diff, stages only the files of the change by path, skips secrets and local data, commits in the repository's message style and stops | never `--no-verify`, `--amend` or a config change |
| `/commit push [hint]` | does the same, then pushes the current branch (`-u origin <branch>` when it has no upstream) | never forces; on `main`/`master` it asks first |
| `/commit pr [title hint]` | branches off the default branch when needed, commits, pushes and opens the pull request with `gh pr create` | without `gh` or authentication it reports the manual steps |

### Inspect and plan without edits

| Command | Does |
|---|---|
| `/pr comments [number|url]` | reads the conversation, inline review comments and reviews of a pull request (the current branch's by default), grouped by file and line; read-only, with comment text treated as data |
| `/security-review [commit|branch|path]` | read-only child (`explore` agent, no edit tools); reports only exploitable findings with a concrete attack path and never prints secret values |
| `/bughunter [security|perf] [scope]` | read-only child (`explore` agent), based on OpenClaude's `/bughunter`; reports a scored table (file:line, severity, confidence, trigger, fix) |
| `/ultraplan <task>` | read-only child that grounds the plan in code, compares options, writes ordered steps with a check each, then critiques its own plan; never implements |

The bughunter runs four phases:

1. Map the riskiest files.
2. Hunt.
3. Run a skeptic pass that drops low-confidence candidates.
4. Propose minimal fixes it never applies.

`/ultraplan` is local only. OpenClaude's version launches a remote cloud session, which v2 does not do.

### Keep a project wiki

`/wiki [init|status|scan|ingest <path>|query <question>]` keeps a markdown project wiki in `.mendcode/wiki`: `index.md`, `log.md`, `conventions.md`, `pages/`, `sources/`. Without arguments it reports status.

It runs in the current session. Every write and read uses the normal file tools and approvals, stays inside that folder and treats ingested text as data.

### Verify the project

`/verify [focus]` detects typecheck, lint, build and test commands from the repository, runs them and reports a step table. When the app has a documented start command, it boots it on a local port with a temporary data dir.

Browser and screenshot checks are not included. With `MENDCODE_BROWSER=1` the agent can do them with the [browser tool](browser.md).

The `verify` of `workflow verify <id>` is a different, existing feature.

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

### Markdown definitions and precedence

Markdown in `command/*.md` or `commands/*.md` accepts the same `description`, `argument-hint`, `agent`, `model` and boolean `subtask` frontmatter. The body is the template; nested folders become `name:space`.

The frontmatter is YAML: multi-line `description: |`, quoted values and lists. `allowed-tools` is read and noted but never applied; unknown fields are listed.

| Collision | Winner |
|---|---|
| Project and user definitions | project |
| Markdown and JSON within a layer | markdown |
| Extension-registered command and another command | extension-registered command |
| Enabled skill `/skill-name` and a built-in or custom command | built-in or custom command; `/doctor` reports the clash |

Templates and expanded prompts are limited to 32,000 characters. The 200-command cap applies after precedence, dropping the lowest-priority layers first.

A file or `mendcode.json` entry that does not fit is listed in `/doctor` and skipped. Other commands still load. See the field-by-field table for skills and commands in [resources](resources-config.md#skills-commands-and-agents-how-files-are-read).

### Load a template from a file

A JSON `template` may be `{file:./prompts/audit.md}`: v1's and opencode's spelling, also supported inside a longer template. The file's text is read relative to the config file when commands load.

- The file must stay inside the project (for the project's own files), data directory or profile.
- Its size must be at most 256 KB.
- An entry whose file is missing or outside is listed in `/doctor` and skipped.

### Arguments and mentions

| Template text | Expansion |
|---|---|
| `$ARGUMENTS` | preserves the argument string |
| `$1`, `$2`, … | binds quoted positional arguments; the highest numbered placeholder consumes the remaining arguments |
| No placeholders | arguments are appended |
| `@file`, `@directory` | uses the native engine's project mention resolver and trust rules |

### Embed shell output

`!` followed by a backtick-delimited shell command embeds its output. Only markers written in the template are expanded, at most 20; each runs in the session project with a 30-second deadline.

Project inline shell requires `/tools` trust and is refused in plan mode. Inline shell needs the native engine and a native model.

Each fragment runs as an ordinary `shell` tool call of the turn. It meets the same controls as the model's own commands:

- An approval card in `ask`, and in `edits`/`smart` when the command is not allowed.
- Your deny rules and allow rules.
- Auto-run in `full` access.
- The OS sandbox and shell hooks.

Nothing runs before the turn starts. A refused, failed or oversized fragment fails the turn before any model call.

### Pass arguments safely to shell

In a shell fragment, `$1`…`$9` and `$ARGUMENTS` become single-quoted words. The highest placeholder and `$ARGUMENTS` give every remaining word, each quoted.

For example, `/show "HEAD; echo x"` runs `git show 'HEAD; echo x'`, never a second command.

Write placeholders unquoted. A placeholder with a value that would land inside quotes (`"$1"`, `'$1'`) or after a backslash cannot be quoted safely; the command is refused with a message naming it. An empty value inserts nothing and is fine.

- Placeholders outside shell fragments are plain text as before.
- On Windows, placeholders in shell fragments are refused.
- Output is never re-expanded as a template.
- Chat displays the original invocation, not shell output or the expanded prompt.

## Selection and MCP

### Model and child selection

Model priority is command model, then an explicit command agent's model, then the current session model. Selection is per turn, never a change to the parent.

On a Claude Code or ACP session it follows [claude-code.md](claude-code.md). A subtask command needs a native session; execution attributes require a native session and model.

- A subagent defaults to a child unless `subtask: false`.
- `subtask: true` forces a child, subject to existing admission limits, cancellation and restart handling.
- Unknown/untrusted agents or unavailable models are refused before shell expansion.

### MCP prompts

Opening slash completion lazily discovers enabled MCP prompts through `commands.discover`. Passive `commands.list` only uses cached metadata and never starts a server.

A prompt appears as `/server:prompt <required> [optional]`. Quoted positional arguments bind the server's named arguments.

Only text prompt messages are supported; media/resources are explicitly refused. Server prompt content is data: inline shell markers in it are not executed.

Real MCP or PR service availability is not guaranteed by the local fixture tests.

### Invoke a command in text or headlessly

A custom command or skill can be named after other text. Typing `/` at the start of a word opens the same suggestions as `@` mentions, for custom commands and skills only; built-ins stay at the start of the prompt.

On send, `explain the parser /review` runs as `/review explain the parser`. Paths such as `/usr/bin` and unknown names stay text.

| Input or endpoint | Behavior |
|---|---|
| TUI Tab | completes without executing |
| Enter | sends `commands.execute` |
| `run --command NAME`, `session send ID --command NAME` | same daemon path, with attachments and separate file context |
| `commands.expand` | read-only text compatibility helper, not an execution endpoint |

Neither `commands.execute` nor `commands.discover` is available to read-only peers.

### Tiers and small commands

`/tier [minimalist|balanced|full|off]` and `/tier <feature> on|off|default` control the feature tier and per-feature overrides ([tiers](tiers.md)). `--safe-mode` starts without extensions, profiles, hooks, MCP and project tools.

B17 small commands:

| Command | Does |
|---|---|
| `/fast [on|off]` | [fast mode](providers.md) |
| `/output-style [name]` | [styles](prompt-modes.md) |
| `/language [auto|name|next]` | the language replies are in ([reply language](prompt-modes.md#reply-language-language)) |
| `/experimental [flag [on|off]]` | lists boolean `experimental` flags, all off by default; toggles one while keeping the other `experimental` values |
| `/debug-config` | config layers from defaults to environment, local only, no secret values; also `control-plane system config-layers` |
| `/cd PATH` | moves this idle session and its children to an existing directory, relative to the session; `~` is home |
| `/pwd` | companion to `/cd PATH` |

Moving drops the session's runtime grants. `/cd PATH` refuses while a turn, queue or child work is running, and for remote terminals. Settings commands are refused for read-only peers.

### Coordination, remote access and voice

| Command | Does |
|---|---|
| `/mflow` | room coordination, peer/file leases and local relay setup: [Mflow](mflow.md) (B73) |
| `/remote-control` | opt-in Telegram bridge: `on`, `off`, `pair`, `unpair [chat id]`; see [channels](channels.md) (B13) |
| `/voice` (key `ctrl+x v`) | opt-in push-to-talk dictation: record, press again to transcribe into the prompt; `on`, `off`, `status`, `start`, `stop`, `cancel`, `language <code|auto>`; see [voice](voice.md) (B14) |

B74 provides `/org`, `/console`, `/share [create|sync]`, `/unshare`, and headless `console` and `share`. See [Console and sharing](console.md).

## Arguments

After a command's name and a space, the `/` menu lists its fixed words (`view/slash-arguments.ts`). Matches appear in order: exact word, words that start with what you typed, then words that only contain it.

| Prompt | Suggestions |
|---|---|
| `/pr ` | `on`, `off`, `review`, `comments`, `watch`, `watch-repo`, `publish`… |
| `/experimental ` | flags; after a flag, `on`, `off`, `toggle` |
| `/tier `, `/graph `, `/sandbox `, `/git `, `/stash ` | the command's fixed words, the same way |

### Complete fixed words

| Key and context | Result |
|---|---|
| Tab | writes the highlighted word and a space; a second Tab goes to the next word |
| Enter on a half-typed word | runs the highlighted word |
| Enter on a word another word must follow (`publish`) | only writes it |
| Enter on a blank word (`/experimental `) | runs the command as typed |

For example: `/pr pub` Tab `/pr publish ` Tab `/pr publish on `.

Numbers and free text are never guessed: no row is shown. A command the tier leaves out lists no words; a word of a feature that is off (`/panel galaxy`) is left out.

### Complete paths

In local terminals, `/cd `, `/add-dir ` and `/attach ` list entries of the directory typed so far (`view/path-arguments.ts`). Paths are relative to the session directory; `~/` is home.

Directories come first and end in `/`. Hidden entries appear once you type a dot.

- Tab writes the highlighted path without a space, so the next Tab goes inside it.
- Enter sends the line as typed.

## Aliases

A built-in command has at most one other name, only for a word people bring from other tools or a universal short form. `/quit` is the exception with two: `/exit`, `/q`.

| Command | Alias |
|---|---|
| `/changes` | `/diff` |
| `/sessions` | `/resume` |
| `/settings` | `/config` |
| `/quit` | `/exit`, `/q` |
| `/help` | `/?` |
| `/mcps` | `/mcp` |
| `/find` | `/search` |
| `/usage` | `/stats` |
| `/model` | `/models` |
| `/theme` | `/themes` |
| `/keymap` | `/keybindings` |
| `/context` | `/ctx` |
| `/memory` | `/mem` |
| `/extensions` | `/ext` |
| `/profiles` | `/pkg` |
| `/workflows` | `/wf` |
| `/loops` | `/loop` |
| `/bg` | `/background` |
| `/permissions` | `/perm` |
| `/providers` | `/provider` |
| `/jump-to-latest` | `/jump` |
| `/pr` | `/pr-watch` |

### Features that are off

A command whose feature is off is absent from browsing and prefix matches. Its exact name or alias finds one muted row explaining how to turn it on:

| Reason | Row |
|---|---|
| Tier does not include it | `/pr  off · /tier balanced` |
| Its own flag is off | `off · /experimental <flag> on` |
| Override or opt-in feature | `off · /tier <feature> on` |

Enter, Tab or a click on that row runs nothing and shows the same line. `/panel` and `/sidebar` still answer for themselves.

### Removed names

A name that used to be an alias is no command and nothing runs. The terminal answers one line, `/tui is now /customize`, and keeps the prompt out of history.

The line comes from a fixed table of removed names, never a guess. A command file, extension command or profile alias with the same name runs instead.

| Old name | Now |
|---|---|
| `/commit-push` | `/commit push` |
| `/commit-pr` | `/commit pr` |
| Old pr-comments name | `/pr comments` |

`/commit-push` and `/commit-pr` were two behaviours under one name. Every pull request word now lives under `/pr`.

### Your own aliases

Set `aliases` on an entry of `slashCommands` in terminal settings. `{ "name": "changes", "aliases": ["d"] }` makes `/d` run `/changes`, with the arguments following.

`/customize` > Advanced > Edit commands shows them; see [customize](customize.md#aliases-of-your-own).

## Stop background work

`/ps` opens a card over the prompt with background work in the open session. It lists commands the model started with `shell` in the background, plus Claude Code's background commands and agents, each with its kind and run time.

| Key | Does |
|---|---|
| ↑↓ | select |
| `x` | stop the selected item |
| `a` | stop all items |
| Esc | close |

The row over the prompt that names background work ends with `/ps`.

A command you stopped is `killed (user)` when the model reads it; nothing wakes the model for it. A Claude Code task is stopped through Claude Code's own `stop_task` request; one it refuses is named in the notice.

Clients send `background.stop` with the session and, for one item, the id `background.list` gave it.
