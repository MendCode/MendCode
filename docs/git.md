# Git page (terminal)

`/git [changes | commit | worktrees | pr]` opens one page with four tabs. Balanced and above (`/tier git_hub`); minimalist keeps `/changes` and `/warp` as they were. Changes, Commit and Worktrees are local: nothing leaves the machine. The PR tab and its push and pull request actions reach the network through `git` and `gh`, so they are a separate switch, off by default ([The switch](#the-switch)).

| Tab | What it is |
|---|---|
| Changes | The [`/changes` review](changes.md), unchanged: same keys, same comments. `/changes` and `/diff` open it here. |
| Commit | Tick files, write a message, confirm, commit. |
| Worktrees | The workspace picker of [`/warp`](worktrees.md), with a `dirty` mark on rows that have uncommitted changes. `/worktrees` (the preview manager) sits under the same tabs. |
| PR | The pull request of the current branch, read through `gh`; push the branch; create the pull request. |

In a folder that is not a Git repository every tab is one state instead: what it is, and one action, [Initialize repository](#folder-that-is-not-a-repository). In a repository with no remote the PR tab offers [Publish to GitHub (private)](#publish-to-github-private) in place of push.

The first row of every tab shows the tabs and the repository: branch, commits ahead and behind its upstream, and how many files are dirty (from `git.status`). `<` and `>` switch tabs (not while a comment, a line number, a workspace name, the commit message, a pull request field or the name of a protected branch is being typed); a click on a tab does the same. Below 70 columns the tabs shorten to `Chg`, `Com`, `Wt`, `PR`. `git.defaultTab` (`changes`, `commit`, `worktrees` or `pr`) picks the tab `/git` opens.

## Commit

No file starts ticked. `space` ticks, `a` ticks all or none, `tab` goes to the message (the prompt's multi-line editor: `enter` is a new line, paste works), `enter` on the files opens the confirmation card, `w` puts `/commit` with the ticked files in the prompt so the agent writes the message (it costs a turn and goes through the normal approvals; nothing is sent from here).

The card shows the exact command, every path, the branch, the hooks that will run and what is staged elsewhere. `enter` commits, `esc` goes back.

### `git.commit`

A daemon command for local clients only. Remote clients and peers (read-only or not) are refused; it is not in `READ_ONLY_COMMANDS`. It never goes through a shell: every call is an argv array, with `GIT_TERMINAL_PROMPT=0`, `GIT_LITERAL_PATHSPECS=1`, no editor, no stdin, output bounded to 16 KB and a timeout.

It runs, in this order:

1. `git add -- <untracked selected paths>`, only for paths git does not know yet.
2. `git commit -m <message> -- <selected paths>`.

The repository's hooks run. Never `--no-verify`, `--amend`, `--force` or `-a`; never a path that was not selected; never a push. Paths are contained in the project with the same symlink-safe check the file API uses (`..`, absolute paths, `.git`, folders and links out of the project are refused). A path that starts with `-` or `:` is a file name, not an option or a pathspec.

If the commit fails (a hook, for one), the untracked files added for it are removed from the index again, and the last 20 lines of git's output come back redacted for secrets.

**Staged elsewhere.** `git commit -- <paths>` commits those paths only. Changes already staged for other files stay staged and are not in the commit; the card says so ("2 other staged files stay staged and out of this commit"). The index of files you did not tick is never touched.

One line each, and no commit, for: an empty message, nothing selected, a detached HEAD, a merge, rebase, cherry-pick or revert in progress, and no `user.name` or `user.email`.

## Folder that is not a repository

`/git` (any tab) in a folder where `git.status` finds no repository shows one state under the tabs row, whose right side reads "not a git repository": the folder's path, a line saying that there is nothing to review, commit or branch yet, and one action, `Initialize repository` (`i` or `enter`, or a click on it). The daemon is asked first (`preview`); if it would refuse, the reason replaces the action. `r` looks again.

`i` opens a card headed "Confirm · local only, nothing leaves this machine": the exact command, the directory, the first branch and whose choice it is, and "not done: no commit, no .gitignore, no remote, no network". `enter` initializes, `esc` goes back. After it the page lands on the Commit tab with the files listed: nothing is committed, a `.gitignore` that exists is honoured and left as it is, and none is created. A failed `git init` keeps the card with what git printed.

### `git.init`

A daemon command for local clients only (remote clients and peers are refused; not in `READ_ONLY_COMMANDS`; no switch: it never touches the network). It takes the session it belongs to and runs, once, in the session's project folder:

```
git init            # when init.defaultBranch is set to a name git accepts: the first branch is the user's own
git init -b main    # otherwise
```

Argv, no shell, the environment of `git.commit`, output bounded, timeout, one action at a time per folder. It makes `.git` and touches nothing else. Refused, with one line and nothing created:

- the folder is inside any repository, itself or a parent (the line names the root; a linked worktree counts);
- `/`, or the user's home folder itself (also through a link); a folder inside the home folder is fine;
- not the project folder of the session (a subfolder, another folder, a file, a missing path);
- a `.git` that exists but git cannot read, in the folder or above it (an empty folder, a bad gitfile, a dangling link): reported with its path and never deleted, overwritten or repaired;
- git missing, or a `git init` that fails (a read-only folder).

## The switch

Push, publish and pull request creation are the only parts of the page that use the network and the only ones that publish anything, so they are behind `experimental.git_actions` (`/experimental git_actions on`), off by default. It follows the same policy as the [PR watch](pr-watch.md): the tier allows it (balanced and full; the feature is `git_actions`), your switch turns it on, `features.git_actions: false` blocks it, minimalist never offers it, and no tier turns the network on by itself.

| | Switch off (default) | Switch on |
|---|---|---|
| Commit tab | as above | as above, unchanged |
| PR tab | one line: "Off: this tab uses the network · /experimental git_actions on" (or "Blocked by features.git_actions" when that blocks it) | the pull request, `u` push, `P` create |
| Processes | no `git push`, no `gh`, no network: the terminal sends nothing and the daemon refuses with the same line | started only by a key you press |
| Hints | no push or pull request hint anywhere | on the PR tab |

There are no model tools for any of this and no prompt text: the page is for you, not for the agent. A session's model cannot push or open a pull request through it.

## PR tab

Reads the branch's pull request (`gh pr view --json …`, parsed by the same reader as the PR watch) and shows the number and title, `head → base`, state and draft, the link, the checks (passed, failed with the failing names, pending with their names), the review decision and whether it merges cleanly. `r` reads it again, `o` (or a click on the link) copies the link and prints it: the terminal has no browser to open. `gh` runs on the machine of the daemon, so a remote session shows one line saying to use the tab from a local session.

One clear line each for: the switch off, `gh` not installed, `gh` not logged in (`gh auth login` in your shell), and no pull request for the branch (the tab then offers `u` and `P`). With no remote the tab is the empty state that offers [publish](#publish-to-github-private).

Not built, on purpose: merge, close, comment and delete of a remote branch. Those stay with `gh` in your shell.

## Push

`u` opens a card headed "leaves this machine". It shows the exact command, the remote name and its address (credentials in a URL are masked as `***`), the number of commits that will be sent and the newest subjects, the repository hooks that will run (`pre-push`), and what is not done: "no force, no tags, no other branch, no pull request". `enter` pushes, `esc` cancels. There is no "always allow" and no grant that lasts a session: every push is confirmed with the command in front of you.

### `git.push`

A daemon command for local clients only (remote clients and peers are refused; not in `READ_ONLY_COMMANDS`). Without `preview` it runs, once:

```
git push --no-recurse-submodules --no-follow-tags [-u] <remote> <branch>
```

`-u` only when the branch has no upstream. The branch is the one checked out; the remote is the branch's configured remote, else `origin`, else the push is refused. Never `--force`, `--force-with-lease`, `--tags`, `--all`, `--mirror`, `--delete`, never a refspec of its own and never another branch. Branch and remote names that start with `-`, contain `..`, `:` or control characters, or that `git check-ref-format` rejects are refused before anything runs. Nothing to push is a refusal, not a no-op push.

A rejected push (non-fast-forward) is shown as git printed it, redacted, last lines only, with "the page never forces, so update the branch and push again". The card stays so the command and the answer are together.

**Protected branches.** `main`, `master` and the remote's default branch need their name typed on the card before `enter` pushes (the daemon asks for the same `confirm` text).

## Publish to GitHub (private)

Where a push would refuse because the repository has no remote ("this repository has no remote"), the PR tab shows "No remote" and offers `Publish to GitHub (private)` (`g`, `u` or a click) instead. With the switch off the tab is the one "Off" line, as for everything else, and nothing is asked.

`g` opens a form: `Name` (default: the folder's name, cleaned to what GitHub takes), `Owner` (default: your gh account, read with `gh api user`; a plain text field, so an organization is typed) and `Description` (optional, one line). `tab` walks the fields, `enter` goes to the next one and, on the description, to the card; `esc` cancels. Under them one line, "private · change visibility on GitHub": **visibility is not a field**. There is no public or internal option on the page, no flag, setting or parameter for one, and `git.publish` has none in its schema.

The card is headed "leaves this machine" (the `warning` role) and shows the exact command, `owner/name`, "private · change visibility on GitHub", what the repository stands on (the branch and its commits, "no commit yet: this creates an empty repository, the first commit comes before the push", or a detached HEAD, where only a remote is added), "not done: no push, no public repository, no other remote" and that it uses your own gh login. `enter` publishes, `esc` goes back to the form with what you typed.

After it the page says "published owner/name, private · origin added", the session gets a passive line ("published owner/name as a private repository and added origin (nothing pushed)"), the PR tab reads again and `u` offers the push, whose card is confirmed on its own: publishing never pushes.

### `git.publish`

A daemon command for local clients only, behind `experimental.git_actions` like `git.push` (same refusal line when it is off; not in `READ_ONLY_COMMANDS`). It runs, once:

```
gh repo create <owner>/<name> --private --source <root> --remote origin [--description=<text>]
```

and, when no owner is given, `gh api user --jq .login` first. There is no `--push`, `--public` or `--internal`, under any input: the builder takes only a validated owner and name, and the description is a single `--description=` word, so no text typed in the form can become a flag or reach a shell. The name is `^[A-Za-z0-9._-]{1,100}$`, not starting with `.` or `-` and not ending in `.git`; the owner is letters, digits, `_` and `-` (up to 60, not starting with `-`); the description is one line of at most 350 characters.

Your `deny` rules of `permission.bash` are honoured against `gh repo create <owner>/<name> --private --source …` (the full command), `gh repo create <owner>/<name>` and `gh repo create`, and `gh api user` for the account read. Output is redacted, the process group is killed on the timeout, one commit, push, publish or pull request at a time per repository, and your credentials are the ones gh already has.

Refused, one line each, before or without creating anything: a remote named `origin` already exists (a remote is never replaced or renamed; the address is masked), not a repository, a name, owner or description that is not usable, a deny rule (named), gh not installed, gh not logged in, and gh's own first line for the rest (name taken, organization not permitted...). A repository with no commit and one on a detached HEAD are allowed: publishing only adds a remote, and the card says which it is.

**When only part of it happened.** After a failed or timed-out gh the page looks at `origin` once and reports exactly what is true: the first line says what happened ("publish incomplete: owner/name was created, gh failed (exit 1)", "gh timed out after 90s: owner/name may or may not exist on GitHub", "gh reported success but origin was not added", "gh failed after adding origin"), then `now:` (where `origin` points, or that there is none), `on GitHub:` (the link gh printed, or that it is unknown), `run:` what to type (`git remote add origin <link>`) and "nothing was deleted and nothing is retried", then what gh printed. The hosted repository is never deleted and nothing is run a second time unless you press `enter` on the card again.

## Create pull request

`P` (when the branch has no pull request) opens a form: title, body, base branch and draft. The title is prefilled from the commits since the merge-base with the base (one commit: its subject; otherwise the branch name) and the body with the commit subjects. The base is the remote's default branch and can be edited. `tab` walks the fields, `space` toggles draft, `enter` on the base or the draft opens the card, `esc` cancels. Below 70 columns one field shows at a time.

The branch has to be pushed and level with its upstream. If it is not, the page says "push first" and why, and nothing is pushed: pushing is a separate, confirmed step (`u`), never implicit.

The card is headed "leaves this machine" and shows the exact command, the body (counted in lines: it goes on standard input, never in the command), the remote and its address, the commits that are in the pull request but not in the base, and "not done: no merge, no force, no push". `enter` creates it, `esc` goes back to the form with what you typed. The link of the new pull request is shown and, when the session metadata feature is on, saved on the session the way `/pr link` does.

### `git.pr.create`

Local clients only. It runs:

```
gh pr create --base <base> --head <branch> --title=<title> --body-file - [--draft]
```

The title is one `--title=` argument and the body goes through standard input: neither is ever put in a shell string, so quotes, newlines, backticks and `$(…)` in them are just text. Limits: 256 characters of title, one line; the body is bounded.

## Safety, for push, publish and pull request

- Local clients only. Remote and peer connections are refused, and none of the commands (nor `git.init`) is in `READ_ONLY_COMMANDS`.
- Argv arrays, no shell. `GIT_TERMINAL_PROMPT=0`, no askpass, ssh in batch mode (unless you set `GIT_SSH_COMMAND` or `core.sshCommand` yourself), `GIT_*` variables that relocate the repository removed from the environment. The page uses your own login (git credential helper, ssh agent, `gh auth`); it never reads, logs or shows a credential, and if git or gh would have to ask for one the action fails.
- Output is bounded and passes through secret redaction; a token in a remote URL is masked on the card and in errors.
- Timeouts on every process (the process group is killed); one commit, push or pull request at a time per repository.
- The repository is contained as in Commit: the directory has to be inside the project.
- Your permission rules: a `deny` rule of `permission.bash` (settings, project rules or the session's own rules) that matches the command line (`git push origin main`, `gh pr create`, or the full command) refuses the action, and the refusal names the rule. `allow` and `ask` rules are not used: the page always asks you, on the card. The `tools` toggles do not apply (it is not a model tool).
- After a push or a pull request the session gets a passive line in its transcript ("pushed feat/x to origin"). It never starts a model turn.

## New session in its own worktree

`git.newSessionWorktree: true` (off by default; needs the Git page, so balanced and full): `/new` and `/bg` create the session in a fresh workspace instead of in the project folder. It is the same code path as `/warp` → New workspace (`workspace-create` for a worktree, then `workspace-warp`), so the folder and the `mend/` branch are named the same way. See [Worktrees](worktrees.md#a-new-session-in-its-own-worktree).

## Not here

Merge or close a pull request, delete a remote branch or a repository, a public or internal repository (change visibility on GitHub), a first commit made for you, force push, tags, branch switch, stash, amend and staging by hunk. The page is the review, commit, push and open-a-pull-request path; the rest stays with the agent and your shell.
