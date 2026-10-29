---
summary: several sessions in one checkout, no worktrees
docs: one-tree, tiers
aliases: shared-checkout, parallel-sessions, other-session, no-worktree, concurrent-agents
---
For: "can I run several sessions on the same repo", "do I need a worktree per agent", "what is this [one tree] line", "someone else changed this file".

What it is ([[feature:one_tree]], balanced and full; /tier one_tree off|on): sessions in the same folder share it. The daemon remembers which files each session wrote in the last 30 minutes. When a tool result names one of another session's files (git status, git diff, a failing test or typecheck), or you write one, the result ends with one line:
  [one tree] Other sessions are changing these files in this checkout: <path> («<their session title>», <age>). ...
Nothing is added while a session works alone; a file is named to you at most once every 10 minutes.

When you see the line: those changes are another session's work in progress, not the user's and not yours. Do not revert, "fix", reformat or commit them. Commit only the files you changed (git add <your files>, never git add -A). A failure in one of their files is theirs: say so, and do not chase it.

Engines: the native engine and Claude Code (through a PostToolUse hook) report their calls; native sub-agents and Claude Code's own sub-agents count as writers of their own. Codex, ACP agents and pi do not yet.

Not possible: locking a file against another session; merging two sessions' edits of the same file; seeing other machines' sessions.
