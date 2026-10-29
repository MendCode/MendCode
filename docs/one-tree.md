# One tree

Several sessions, one checkout. Open five terminals in the same repository, give each its own task, and let them work at
the same time: no worktree per agent, no branch per task, no pull request and merge for every change, nothing to sync.
Each session commits its own files to the branch you are on, and you push once.

What usually goes wrong when agents share a folder is not the editing: a write tool already refuses to overwrite a file it
did not read. It is what the agent concludes from the other sessions' work. A `git status` full of changes it did not make,
a typecheck failing in a file it never touched: it takes them for the user's edits or for its own unfinished work, and
reverts them, "fixes" them, or commits them. One tree tells it whose they are, at the moment it sees them.

## What the model sees

One line at the end of a tool result, only when that result names a file another session wrote in the last 30 minutes:

```
[one tree] Other sessions are changing these files in this checkout: apps/cli/src/pets/art.ts («Pets», 3 min ago). They are
not the user's edits and not unfinished work of yours: leave them, do not revert or fix them, and commit only the files you changed.
```

- **Where it appears**: a shell command whose output names such a file (`git status`, `git diff`, a failing test or
  typecheck), and a write (`edit`, `write`, `apply_patch`) to a file another session is changing.
- **When it does not**: a session working alone never gets a line. A file named to a session is not named to it again for
  10 minutes. At most six files are named; the rest are counted.
- **Cost**: about 40 tokens on the results that need it, none on the others. Nothing is added to the system prompt (the
  prompt cache is untouched), no tool is added, no file is read or scanned and no `git` command runs: the daemon remembers in
  memory which files each session wrote, and reads only the output the tool already produced.

Files are matched as whole paths, absolute or relative to the session's folder, also after `./` and git diff's `a/` and
`b/`: `src/data.ts` does not match `a.ts`, and `art.tsx` does not match `art.ts`.

## Engines

- **Native engine**: every tool result is checked; the line ends the result the model reads.
- **Claude Code** (`claude-*` models): MendCode registers a `PostToolUse` hook for `Bash`, `Edit`, `Write`, `MultiEdit`
  and `NotebookEdit` when it starts Claude Code; the line reaches the model as that call's added context. The hook answers
  from memory, so a call waits for it no more than a local round trip.
- **Sub-agents**: a native sub-agent (`task`) is a session of its own, so it and the session it works for each hear about the
  other's files. Claude Code's own sub-agents (its `Agent` tool) share their session; when Claude Code says which sub-agent made
  a call (`agent_id`), each one counts as a writer of its own, named `a sub-agent of «Title»`, so parallel sub-agents and the
  main thread do not take each other's half-done files for their own.
- Other engines (Codex, ACP agents, pi) run their own tools: their sessions are not seen yet.

## Switch

`one_tree` is on in the balanced and full tiers and off in minimalist; `/tier one_tree off` (or `on`) overrides the tier
([tiers](tiers.md)). Off, nothing is recorded and nothing is said.

## Working this way

- Give each session a task in its own part of the code. Two sessions on the same large file (`daemon.ts`, `ui/app.ts`) will
  still trip over each other's edits: the line makes that visible, it does not merge them.
- Each session commits its own files (`git add <its files>`, never `git add -A`). Commits land one after another on the same
  branch; there is nothing to merge.
- A typecheck or test run in one session sees the other sessions' half-done work. One tree names those files so the session
  does not chase them; run the full suite once, from one session, when the others are done.
- One session installs and restarts the daemon. With more than one terminal open, the default process mode already moves the
  daemon out of the first terminal ([customize](customize.md)), so closing or losing one terminal does not stop the others'
  turns.
- Use a worktree only when two tasks must change the same files, or for an experiment that may break the build for everyone.
