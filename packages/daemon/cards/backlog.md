---
summary: project backlog: the user's own pending items, kept across sessions
docs: sidebar, automation, permissions
aliases: pending, later, left-undone, to-do, todo-list, follow-up
---
For: "what is pending in this project", "put that on my list", "what did we leave undone", "add it to the backlog".

What it is: the user's own list of pending things for a project (full tier; /tier backlog on|off). It survives sessions and daemon restarts. It is not your todo tool (your working checklist for this session), not /scratch (a private note) and not memory.

Read it, when the user asks about pending work or before proposing what to do next:
  {{program}} backlog list --json
prints { directory, items: [{ id, text, done, createdAt, doneAt?, origin?: { sessionId?, path?, commit? } }] } for the directory the command runs in, open items first. Without --json: one line per item, "#3 [ ] text  (file · commit · session id)". "the project backlog is off" means the feature is off: say so, the user turns it on.

You never write it. add, done, reopen, remove and clear are refused from a session's own shell, by the command and by the daemon. Do not look for another way (the file under the data directory is the user's).

Proposing an item: when a turn ends with something left undone, or you notice work outside the request, say it in plain text, one line each:
  Left undone: <one line the user can paste, 300 characters at most>
and tell the user the command: /backlog add <text> (they may add --file PATH and --commit SHA so it opens from where it was born). The item exists only once they add it. Never say it was added.

When the user finishes something that is on the list, name the item and its number so they can type /backlog done <id>.

The user types: /backlog (the list) · /backlog add [--file PATH] [--commit SHA] <text> · /backlog done|reopen|remove <id> · /backlog open <id> (switches to the session it was added in and opens its file) · /backlog clear (removes the finished ones). Card in the right panel: /panel widget backlog. Headless: {{program}} backlog list|add|done|reopen|remove|clear [--json].

Limits: 200 items per project, one line of 300 characters each; numbers are never reused.

Not possible: a model tool for the list; items per session; due dates, priorities or assignees; sharing a list between projects.
