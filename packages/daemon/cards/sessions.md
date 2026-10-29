---
summary: reopen, fork, undo, export, search and tidy sessions; the queue and drafts
docs: sessions, storage, editor
aliases: session, resume, fork, undo, redo, export, import, history, drafts, queue, archive, stash
---
Figures of a session (time per turn, day and hour, tokens per model, sub-agents, approvals): {{program}} docs session-stats.
For: "continue yesterday's chat", "go back to an earlier message", "fork this", "undo what you did", "export or copy the conversation", "find that session", "my unsent prompt".

The user types these (the model cannot run slash commands: say which one):
  Find and reopen: /sessions (alias /resume): words, "a phrase", tag:x, re:pattern; ctrl+f also searches message text (newest 300 messages of at most 200 sessions, never tool output). /history browses turns; /find searches the open transcript.
  Branch: /tree is one tree of messages, forks and child agents with cost per branch: type to search, tab filters, enter jumps or opens, ^F forks, ^L bookmarks, ^Y copies, ^R recaps, ^B merges back. /timeline opens it on the messages; /fork pick; plain /fork copies the session; /label bookmarks a message; /recap summarises.
  Undo: /undo undoes the last message and its file edits, /redo restores it. Files come back only for what the edit tools changed; shell effects and services do not. [[setting:snapshot]] false turns file capture off; [[setting:snapshotScope]] worktree captures every file (git repos).
  Export: /export [markdown|json|html] [path]; /copy; /import [claude-code|codex] [file] reads those tools' logs; {{program}} export [id] prints JSON. Secrets stay masked, long text is cut.
  Prompt in flight: /queue shows the queue and sets its policy (after-response, after-tools, immediate; [[setting:queue]] { mode }); /stash and ctrl+x p / ctrl+x o keep unsent prompts; /drafts restores earlier ones (kept per session).
  Earlier prompts: /prompt-history searches this project's prompts; /backtrack edits an earlier prompt and resends it (esc esc). Directory: /pwd shows the session's directory, /cd PATH moves an idle session and its children to an existing directory (refused while work runs, and for remote terminals). /quit (/exit) leaves; sessions are kept.
  Tidy: /rename, /title, /pin, /settle (archives, history kept; ctrl+a in /sessions); /limit resumes a turn a usage limit paused ({{program}} docs usage).

Model tools: session_meta (own session: rename, title, link a PR, settle; tier balanced, /tier session_meta on) and session_search, session_read, session_notes (earlier messages and versioned notes of this session and its children; off until the user turns on experimental.session_recall in /experimental). Other sessions: {{program}} docs threads.

Data honesty: history is the daemon's stored events, not the model's compacted context. A fork copies the transcript up to the message, not file snapshots. Old streaming detail is compacted after [[setting:retentionDays]] (7 to 3650); editing past messages needs [[setting:allowMessageEdits]], off by default.

Not possible: undoing shell side effects; a tool that opens, forks or exports for the user; recall across projects.

Check: after a user command, /sessions or /timeline shows the result; if you cannot see the screen, say you could not check.
