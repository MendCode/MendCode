# One tree

One tree lets several sessions work in one checkout and tells each session which files the others are changing. Each session commits its own files to your current branch, and you push once.

1. Open five terminals in the same repository.
2. Give each session its own task and let them work at the same time.
3. Commit each session's own files to the branch you are on, then push once.

You need no worktree per agent, branch per task, or pull request and merge for every change. There is nothing to sync.

## Working this way

1. Give each session a task in its own part of the code. Two sessions on the same large file (`daemon.ts`, `ui/app.ts`) will still trip over each other's edits: the line makes that visible, it does not merge them.
2. Have each session commit only its own files: `git add <its files>`, never `git add -A`. Commits land one after another on the same branch; there is nothing to merge.
3. Run the full suite once, from one session, when the others are done. A typecheck or test run sees the other sessions' half-done work; One tree names those files so the session does not chase them.
4. Have one session install and restart the daemon. With more than one terminal open, the default process mode already moves the daemon out of the first terminal ([customize](customize.md)), so closing or losing one terminal does not stop the others' turns.

Use a worktree only when two tasks must change the same files, or for an experiment that may break the build for everyone.

## Switch

`one_tree` follows your tier unless you override it ([tiers](tiers.md)):

| Tier | Default |
|---|---|
| balanced | on |
| full | on |
| minimalist | off |

Use `/tier one_tree off` (or `on`) to override the tier. Off, nothing is recorded and nothing is said.

## What the model sees

One line at the end of a tool result, only when that result names a file another session wrote in the last 30 minutes:

```
[one tree] Other sessions are changing these files in this checkout: apps/cli/src/pets/art.ts («Pets», 3 min ago). They are
not the user's edits and not unfinished work of yours: leave them, do not revert or fix them, and commit only the files you changed.
```

| Result | When the line appears |
|---|---|
| Shell command | Its output names such a file: `git status`, `git diff`, a failing test or typecheck |
| Write (`edit`, `write`, `apply_patch`) | It writes to a file another session is changing |

A session working alone never gets a line. A file named to a session is not named to it again for 10 minutes. At most six files are named; the rest are counted.

### Why the line matters

A write tool already refuses to overwrite a file it did not read. The usual problem is what the agent concludes from other sessions' work, not the editing itself.

A `git status` full of changes it did not make, or a typecheck failing in a file it never touched, can look like the user's edits or its own unfinished work. It may revert, "fix" or commit them.

One tree tells the agent whose files they are, at the moment it sees them.

### Path matching and cost

Files are matched as whole paths, absolute or relative to the session's folder, also after `./` and git diff's `a/` and `b/`:

- `src/data.ts` does not match `a.ts`.
- `art.tsx` does not match `art.ts`.

The line costs about 40 tokens on results that need it, none on the others. Nothing is added to the system prompt, so the prompt cache is untouched.

No tool is added, no file is read or scanned and no `git` command runs. The daemon remembers in memory which files each session wrote, and reads only the output the tool already produced.

## Engines

| Engine | How the line reaches the model |
|---|---|
| Native engine | Every tool result is checked; the line ends the result the model reads |
| Claude Code (`claude-*` models) | MendCode registers a `PostToolUse` hook when it starts Claude Code; the line reaches the model as that call's added context |
| Other engines (Codex, ACP agents, pi) | They run their own tools; their sessions are not seen yet |

The Claude Code hook covers `Bash`, `Edit`, `Write`, `MultiEdit` and `NotebookEdit`. It answers from memory, so a call waits for it no more than a local round trip.

### Sub-agents

A native sub-agent (`task`) is a session of its own. It and the session it works for each hear about the other's files.

Claude Code's own sub-agents (its `Agent` tool) share their session. When Claude Code says which sub-agent made a call (`agent_id`), each one counts as a writer of its own, named `a sub-agent of «Title»`.

This keeps parallel sub-agents and the main thread from taking each other's half-done files for their own.
