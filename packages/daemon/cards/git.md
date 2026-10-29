---
summary: review changes, commit, push, pull requests, worktrees (the Git page)
docs: git, changes, worktrees, pr-watch, github
aliases: worktree, worktrees, pr, commit, branch, push, merge, warp, github
---
For: "show me the diff", "commit this", "open a pull request", "work in a separate worktree", "tell me when CI finishes".

The user's Git page: /git [changes|commit|worktrees|pr] (tier balanced; /tier git_hub). Tabs: Changes (/changes, alias /diff: review hunks, comment, send the review to the agent), Commit (tick files, confirm; never --no-verify, --amend, -a, or a push), Worktrees (/warp, /worktrees), PR. Setting [[setting:git]]: git.defaultTab changes|commit|worktrees|pr, git.newSessionWorktree true makes /new and /bg start each session in a fresh worktree on a mend/ branch (from the current commit; uncommitted changes stay behind). Push, "publish to GitHub (private)" and "create pull request" use the user's own git and gh logins, so they stay off until the user types /experimental git_actions on. There is no model tool for them: for the agent, commit with git in the shell under the normal approvals (/commit starts a prompt that does it, and can push or open a PR), and never push unasked.

Model tools:
  review {action: summary|file|comment_add|comment_list|...}: reads the working tree and the user's review comments; it stages and edits nothing.
Commands the user types: /review (review changes in a subtask), /security-review and /bughunter (read-only, no edits), /pr comments (shows a pull request's review comments; /pr on|off switches PR watching and the reviewer), /verify (builds and tests the project).
  worktree {action: enter|exit|status|list|handoff|close}: off until the user turns on experimental.worktree_tool (full tier). enter makes a worktree on a new mend/<name> branch (naming: [[setting:worktreeBranch]]) and moves this session into it mid-turn; every enter and exit needs the user's approval. Refused for a sub-agent, a session already in one, and while commands, children, a goal, a loop or a workflow run. Commit your work before leaving.
  pr_watch {action: watch|unwatch|list}: wakes the session only when a PR's checks fail or pass, someone comments, or it conflicts; needs experimental.pr_watch and gh; 5 watches per session. The user types /pr.

Limits: the Git page does not merge, close, tag, force-push, switch branch, stash or stage by hunk. Worktrees are cleaned only when merged, clean, unused and idle for [[setting:worktreeGcDays]] days (off by default). Nothing makes a worktree per sub-agent. A folder that is not a repository shows only "Initialize repository".

Data honesty: branch, ahead/behind and dirty counts come from git itself in this folder; the PR tab reads gh. If gh is not logged in, say so.

Check: git status or the Git page header (branch, ahead, behind, dirty); say when you could not see the screen.
