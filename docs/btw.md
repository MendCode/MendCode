# /btw

`/btw <question>` opens a persistent side chat and asks about the current session without interrupting it. Further questions continue the side chat. It can read files, search, and run read-only commands (`git status`, `git log`, `git diff`) to check before it answers. Tier: balanced and full (minimalist does not list the command).

- `/btw` opens it ready to type, with the last conversation, or closes it.
- `/btw clear` stops a running answer, deletes its side session and clears the panel. The cleared chat is kept for `/btw history`.
- `/btw history` lists the side chats cleared before, newest first (up to 10 per session, each with its last 40 entries). `↑`/`↓` pick, Enter reads one (read-only), Esc steps back to the list and then to the live chat.
- Ctrl+] is the one key for it: it opens the side chat ready to type, takes the keyboard back to it, and closes it from inside. Type a question and press Enter to continue. The main draft stays intact.
- Esc returns the keyboard to the main prompt and keeps the side chat open; so does a click on the chat. A click on the side chat focuses it. Alt+] also closes it. PgUp/PgDn scroll it while it is focused.
- The name row shows the model answering (`btw · luna`). The row under it says what the answers rest on (below). Answers stream; each tool an answer runs is a row like the transcript's tool rows (the kind's glyph, `Read`, `Grep`, `$ shell`…, its target, how long it took; a cross when it failed) above the answer, and while it works the last row says what it is doing (`Running shell…`, `Retrying (attempt 2): stream stalled`). A provider error that does not recover appears in the panel.
- From 110 columns it takes the whole right bar (the panel's cards come back when it closes); below that it opens as a full-width sheet above the prompt. It can also be placed in the [sidebar spec](sidebar.md) as a `sidechat` widget.

## The model

The side chat uses the `aside` model role, then `small`, then the session's own native model. Set it in the settings file, or with `/model roles`:

```json
{ "models": { "aside": { "model": "gpt-6-luna", "effort": "low" } } }
```

`models` is per profile and per project like the other roles ([providers](providers.md#model-roles)). A cheap model is the usual choice: the side chat reads a prompt of several thousand tokens at its first question. Claude Code, pi and ACP models never serve a role; those sessions use a native model for it.

## What it sees

It sees the main session, but as text, not as the main agent's own context:

- **Messages and tools.** User and assistant messages, each tool's name and the first 600 characters of its result, and what a running turn has written so far. Reasoning is not included.
- **How much.** The most recent ~24,000 characters of the transcript (at most the last 4,000 events). When the session is longer, the start is cut: the row under the name reads `sees the session's last 24K chars`, and the model is told the block starts mid-session and that tool results are cut, so it reads the file or runs the command itself instead of guessing.
- **When.** The first question carries that block, including a turn that is running. Each later question carries only what the main session did since, so the cost of a follow-up is its own text; the side session keeps its own history.
- **Cost and cache.** The side session is its own conversation (its own instructions and tools), so it cannot reuse the main session's provider cache, which is keyed by the main prompt. What is cached is the side session's own history: the brief and the session block come first and never change, so every follow-up reads them from the cache. The row under the name shows the side model's last prompt and how much of it came from the cache (`prompt 12.4K tok · 80% cached`). Its usage counts in `/usage`.

## Tools and permissions

The side session runs the read-only `explore` agent (read, grep, glob, list, shell, web, and the code graph tools when they are on) and takes the main session's permission mode, with two changes: a full-access session counts as `smart` there, and the side session is read-only whatever the mode: a shell command passes only if the smart-mode read-only classification passes it (`ls`, `cat`, `rg`, read-only `git`…), so `touch`, `mv`, `cp`, `mkdir`, project checks such as `bun test`, `permissionAllow` prefixes, redirection into a file and `sort -o` are refused. So:

- It has no edit, write or patch tools, and a command that would change files, install, commit or push needs an approval; nobody can give one in the side chat, so it is refused (a `needed approval: refused in the side chat` row) and the model says what to run instead.
- Reads and allow-listed read-only commands run exactly as in the main session's mode. In `ask` and `edits` modes shell commands ask in the main session too, so they are refused here; `plan` stays read-only.
- The reason for the cap: the main agent may be editing the same files or running a build, and a second writer in the same folder, with no one watching the side chat's tool calls, is how a question becomes a conflict. Approvals and "approve for this session" grants of the main session do not carry over.

## How it runs

Each session gets one hidden side session: a child of it in the same folder. It is a real turn, so a stalled or failed provider call is retried like any other. No side session is listed in `/sessions`, `mendcode -c` or the task list, and it is deleted with its session.

The panel's thread is saved under `<dataDir>/asides/<sessionId>.json` (`<sessionId>.history.json` for the cleared ones), separate from the main session log. Closing the panel, switching sessions and restarting keep it; a daemon restart marks an unfinished answer interrupted. The main session's transcript, export, timeline and compaction never contain side messages. One side answer runs at a time per session. Claude Code and ACP sessions use a native model for it; a daemon without the native engine refuses side questions.
