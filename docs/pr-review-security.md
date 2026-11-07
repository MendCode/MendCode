# PR reviewer: what a malicious pull request can do

A pull request is written by someone else. Its code, title, description, comments and files may try to talk the reviewer into doing something harmful (prompt injection): delete files, run commands, leak secrets or push code. This page says what the [PR reviewer](pr-review.md) lets a pull request reach, by default and with each option, and how to make it stricter.

## Short answer

With the default configuration, the reviewer only reads. The model that reviews has no tool that writes a file, runs a command or reaches the network, so text in a pull request cannot make it do so, however it is worded. The worst an injection can do is make a review wrong: miss a defect or report a false one. A human still merges.

## What the review model can and cannot do

| | Review and verify passes |
|---|---|
| Read the checkout | Yes: `read`, `grep`, `glob` and the code graph, inside a throwaway worktree of the PR head |
| Write or delete files | No: the `explore` agent in plan mode has no edit tool |
| Run commands | No: `shell` is not offered, and plan mode refuses every command |
| Ask you to approve something | No: any approval it asks for is refused without asking you |
| Reach the network | No tool for it |
| Read your other files | No: reads outside the checkout are refused |

The worktree is checked out detached under `<dir>/pr-review/worktrees/` and removed afterwards. Your branches and your own checkout are never touched.

## What the pull request cannot steer

- **Its text is data.** The title, description and linked issues reach the model marked as untrusted data, never as instructions.
- **Its instruction files are not loaded.** `AGENTS.md`, `CLAUDE.md` and skills, yours or the PR's, are not offered to the review. The review prompt is the whole brief.
- **Its tool configuration is not loaded.** A Claude Code child does not read the PR's `.claude/` settings or hooks. A Codex child treats every directory of the checkout as an untrusted project, so its `.codex/config.toml`, hooks and rules stay off. See [Harness isolation](pr-review.md#harness-isolation).
- **Its config cannot widen the reviewer.** Repository options that control who may review, post or fix are read from the base branch, not from the pull request.
- **Its comments cannot command it.** `@mendcode` commands run only for logins with write access to the repository, checked with GitHub right before any write.

## What does run code from the pull request

Two things build or run the pull request's code. Both are bounded:

- **Checks** (`checks` in `.mendcode/review.yaml`) come from the base branch's configuration, never from the pull request. They run in the [OS sandbox](sandbox.md) with no network; the checkout is read-only and only scratch and temp directories are writable. Without a sandbox backend they do not run at all.
- **The cost measurement**, only on MendCode's own repository, builds the head and runs it on an offline test engine with a throwaway home directory: no model, no login and no network access is needed. It runs only when the head branch is in the repository itself, so only code from someone who already has write access; a head in a fork is never built. It does not run inside the OS sandbox.

## Options that give it more power

These are off by default. Turn one on only for repositories whose contributors you trust.

| Option | What it allows | Risk |
|---|---|---|
| `fixes: true` and `@mendcode fix` | A session edits the PR branch to fix confirmed findings | That session works under your normal permissions: it can edit files in its worktree and ask to run commands, and its approvals follow your own settings |
| `fix.push: true` | The fix commit is pushed to the PR branch | Only after a fresh check that the asker and you may push, and that the branch has not moved |
| `publishers: anyone` | Reviews from any login's reviewer are posted | Posting only, no code runs |

## Make it stricter

- Keep `fixes: false` (the default) on repositories with outside contributors.
- Ask outside contributors to open pull requests from forks: a head in a fork is never built.
- Keep `checks` short and offline; they already have no network.
- On a shared machine, run the reviewer in its own user account or container so a mistake in any tool cannot reach your files.
- Turn the cost measurement off with `prReview.perfAttrib: false` if your repository's branches can be pushed by people you do not trust.

## Known limits

- A Codex review child still receives your own `~/.codex/AGENTS.md`; Codex has no switch for it. Keep instructions there that are safe for any repository.
- The cost measurement runs outside the OS sandbox. Moving it into the sandbox is planned.
- A fix session is as safe as the permissions you gave MendCode. In a repository with outside contributors, keep fixes off or run them in a sandboxed account.
