# /btw

`/btw <question>` opens a persistent side chat and asks about the current session without interrupting it. Further questions continue the side chat. It can read files, search, and run read-only commands (`git status`, `git log`, `git diff`) to check before it answers.

- `/btw` opens it ready to type, with the last conversation, or closes it.
- `/btw clear` stops a running answer, clears the side chat and deletes its side session.
- Ctrl+] is the one key for it: it opens the side chat ready to type, takes the keyboard back to it, and closes it from inside. Type a question and press Enter to continue. The main draft stays intact.
- Esc returns the keyboard to the main prompt and keeps the side chat open; so does a click on the chat. A click on the side chat focuses it. Alt+] also closes it. PgUp/PgDn scroll it while it is focused.
- The name row shows the model answering (`btw · luna`). Answers stream; each tool an answer runs is a muted `⎿` row above it, and while it works the last row says what it is doing (`Running shell…`, `Retrying (attempt 2): stream stalled`). A provider error that does not recover appears in the panel.
- From 110 columns it takes the whole right bar (the panel's cards come back when it closes); below that it opens as a full-width sheet above the prompt. It can also be placed in the [sidebar spec](sidebar.md) as a `sidechat` widget.

## How it runs

Each session gets one hidden side session: a child of it in the same folder, running the read-only `explore` agent (read, grep, glob, list, shell, web, and the code graph tools when they are on; no edits) on the `aside` role's model, then `small`, then the session's own native model. It is a real turn, so a stalled or failed provider call is retried like any other, and its usage counts in `/usage`. The first question sends the latest part of the main conversation (about 24,000 characters), including a running turn; a follow-up sends only what the main session did since, and the side session keeps its own history.

The side session takes the main session's permission mode. A call that would need approval is refused in the side chat (a `needed approval: refused in the side chat` row) and the model says what to run instead: run it in the main chat, or allow it there. No side session is listed in `/sessions`, `mendcode -c` or the task list, and it is deleted with its session.

The panel's thread is saved under `<dataDir>/asides/<sessionId>.json`, separate from the main session log. Closing the panel, switching sessions and restarting keep it; a daemon restart marks an unfinished answer interrupted. The main session's transcript, export, timeline and compaction never contain side messages. One side answer runs at a time per session. Claude Code and ACP sessions use a native model for it; a daemon without the native engine refuses side questions.
