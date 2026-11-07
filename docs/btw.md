# /btw

Ask about the current session in a persistent side chat without interrupting it. The side chat can read files, search, and run read-only commands (`git status`, `git log`, `git diff`) to check before answering.

## Ask a side question

1. Run `/btw <question>` to open the side chat and ask your question.
2. Type another question and press Enter to continue the same conversation. Your main draft stays intact.

Tier: balanced and full; minimalist does not list the command.

| Command | Does |
|---|---|
| `/btw` | Open ready to type, with the last conversation, or close it. |
| `/btw clear` | Stop a running answer, delete its side session and clear the panel. Keep the cleared chat for `/btw history`. |
| `/btw history` | List cleared side chats, newest first: up to 10 per session, each with its last 40 entries. |

### Keys and focus

| Key or action | Does |
|---|---|
| Ctrl+] | Open ready to type, return the keyboard to the side chat, or close it from inside. |
| Esc or a click on the main chat | Return the keyboard to the main prompt and keep the side chat open. |
| Click on the side chat | Focus it. |
| Alt+] | Close it. |
| PgUp/PgDn | Scroll while focused. |
| `↑`/`↓` in history | Pick a cleared chat. |
| Enter in history | Read the selected chat (read-only). |
| Esc in history | Step back to the list, then to the live chat. |

### Read answers and tool activity

The name row shows the model answering (`btw · luna`). The row under it says what the answers rest on, described below.

Answers stream. Each tool appears above the answer as a row like the transcript's tool rows: the kind's glyph, `Read`, `Grep`, `$ shell`…, its target and how long it took. A cross marks failure.

While the answer runs, the last row says what it is doing: `Running shell…` or `Retrying (attempt 2): stream stalled`. A provider error that does not recover appears in the panel.

From 110 columns, the side chat takes the whole right bar; the panel's cards come back when it closes. Below that, it opens as a full-width sheet above the prompt.

You can also place it in the [sidebar spec](sidebar.md) as a `sidechat` widget.

## The model

The side chat uses the `aside` model role, then `small`, then the session's own native model. Set it in the settings file, or with `/model roles`:

```json
{ "models": { "aside": { "model": "gpt-6-luna", "effort": "low" } } }
```

`models` is per profile and per project like the other roles ([providers](providers.md#model-roles)). A cheap model is the usual choice: the first question reads a prompt of several thousand tokens.

Claude Code, pi and ACP models never serve a role; those sessions use a native model for it.

## What it sees

It sees the main session, but as text, not as the main agent's own context:

| Included | Limit |
|---|---|
| User and assistant messages | The most recent ~24,000 characters of the transcript, at most the last 4,000 events. |
| Tools | Each tool's name and the first 600 characters of its result. |
| Running turn | What it has written so far. |
| Reasoning | Not included. |

When the session is longer, the start is cut. The row under the name reads `sees the session's last 24K chars`.

The model is told the block starts mid-session and tool results are cut, so it reads the file or runs the command itself instead of guessing.

The first question carries that block, including a running turn. Each later question carries only what the main session did since, so the cost of a follow-up is its own text; the side session keeps its own history.

### Cost and cache

The side session is its own conversation, with its own instructions and tools. It cannot reuse the main session's provider cache, which is keyed by the main prompt.

The side session's own history is cached: the brief and session block come first and never change, so every follow-up reads them from the cache.

The row under the name shows the side model's last prompt and how much came from the cache (`prompt 12.4K tok · 80% cached`). Its usage counts in `/usage`.

## Tools and permissions

The side session runs the read-only `explore` agent: read, grep, glob, list, shell, web, and the code graph tools when they are on.

It takes the main session's permission mode with two changes: full-access counts as `smart`, and the side session is read-only whatever the mode.

| Shell operation | Rule |
|---|---|
| `ls`, `cat`, `rg`, read-only `git`… | Pass only if the smart-mode read-only classification passes them. |
| `touch`, `mv`, `cp`, `mkdir` | Refused. |
| Project checks such as `bun test` | Refused. |
| `permissionAllow` prefixes | Refused. |
| Redirection into a file, `sort -o` | Refused. |

- It has no edit, write or patch tools, and a command that would change files, install, commit or push needs an approval; nobody can give one in the side chat, so it is refused (a `needed approval: refused in the side chat` row) and the model says what to run instead.
- Reads and allow-listed read-only commands run exactly as in the main session's mode. In `ask` and `edits` modes shell commands ask in the main session too, so they are refused here; `plan` stays read-only.

The main agent may be editing the same files or running a build. A second writer in the same folder, with no one watching the side chat's tool calls, could turn a question into a conflict.

Approvals and "approve for this session" grants of the main session do not carry over.

## How it runs

Each session gets one hidden side session: a child of it in the same folder. It is a real turn, so a stalled or failed provider call is retried like any other.

No side session is listed in `/sessions`, `mendcode -c` or the task list. It is deleted with its session.

The panel's thread is saved under `<dataDir>/asides/<sessionId>.json` (`<sessionId>.history.json` for cleared ones), separate from the main session log.

Closing the panel, switching sessions and restarting keep it. A daemon restart marks an unfinished answer interrupted.

The main session's transcript, export, timeline and compaction never contain side messages. One side answer runs at a time per session.

Claude Code and ACP sessions use a native model for it. A daemon without the native engine refuses side questions.
