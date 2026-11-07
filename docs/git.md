# Git page (terminal)

The Git page lets you review changes, commit selected files, pick a worktree and work with pull requests. Open it with `/git [changes | commit | worktrees | pr]`.

The page is available in balanced and above (`/tier git_hub`). Minimalist keeps `/changes` and `/warp` as they were.

Changes, Commit and Worktrees are local: nothing leaves the machine. The PR tab and its push and pull request actions reach the network through `git` and `gh`; they have a separate switch, off by default ([The switch](#the-switch)).

| Tab | What it is |
|---|---|
| Changes | The [`/changes` review](changes.md), unchanged: same keys, same comments. `/changes` and `/diff` open it here. |
| Commit | Tick files, write a message, confirm, commit. |
| Worktrees | The workspace picker of [`/warp`](worktrees.md), with a `dirty` mark on rows that have uncommitted changes. `/worktrees` (the preview manager) sits under the same tabs. |
| PR | The pull request of the current branch, read through `gh`; push the branch; create the pull request. |

In a folder that is not a Git repository every tab is one state instead: what it is, and one action, [Initialize repository](#folder-that-is-not-a-repository). In a repository with no remote the PR tab offers [Publish to GitHub (private)](#publish-to-github-private) in place of push.

### Navigate the tabs

The first row shows the tabs and repository: branch, commits ahead and behind its upstream, and how many files are dirty, from `git.status`.

| Control | Does |
|---|---|
| `<` and `>` | switch tabs |
| Click a tab | switch to it |
| `git.defaultTab` | choose the tab `/git` opens: `changes`, `commit`, `worktrees` or `pr` |

The tab keys do not switch while you type a comment, line number, workspace name, commit message, pull request field or protected branch name.

Below 70 columns the tabs shorten to `Chg`, `Com`, `Wt`, `PR`.

## Commit

1. Tick the files you want to commit. No file starts ticked.
2. Press `tab` to write the message in the prompt's multi-line editor. `enter` adds a new line; paste works.
3. Press `enter` on the files to open the confirmation card.
4. Check the exact command, every path, branch, hooks that will run and what is staged elsewhere. Press `enter` to commit, or `esc` to go back.

| Key | Does |
|---|---|
| `space` | tick a file |
| `a` | tick all or none |
| `w` | put `/commit` with the ticked files in the prompt so the agent writes the message |

Using `w` costs a turn and goes through normal approvals. Nothing is sent from here.

### `git.commit`

This daemon command is for local clients only. Remote clients and peers, read-only or not, are refused; it is not in `READ_ONLY_COMMANDS`.

Every call is an argv array, never a shell. It uses `GIT_TERMINAL_PROMPT=0`, `GIT_LITERAL_PATHSPECS=1`, no editor, no stdin, output bounded to 16 KB and a timeout.

It runs, in this order:

1. `git add -- <untracked selected paths>`, only for paths git does not know yet.
2. `git commit -m <message> -- <selected paths>`.

The repository's hooks run. The command never uses `--no-verify`, `--amend`, `--force` or `-a`, never includes a path that was not selected, and never pushes.

Paths are contained in the project with the file API's symlink-safe check. It refuses `..`, absolute paths, `.git`, folders and links out of the project.

A path that starts with `-` or `:` is a file name, not an option or a pathspec.

If the commit fails (a hook, for one), the untracked files added for it are removed from the index again, and the last 20 lines of git's output come back redacted for secrets.

**Staged elsewhere:** `git commit -- <paths>` commits those paths only. Changes staged for other files stay staged and out of the commit. The card says "2 other staged files stay staged and out of this commit".

The index of files you did not tick is never touched.

The command returns one line and makes no commit for:

- an empty message or nothing selected;
- a detached HEAD;
- a merge, rebase, cherry-pick or revert in progress;
- no `user.name` or `user.email`.

## Folder that is not a repository

When `git.status` finds no repository, every `/git` tab shows the same state under the tabs row. Its right side reads "not a git repository".

The page shows the folder's path, says there is nothing to review, commit or branch yet, and offers `Initialize repository`.

1. Press `i` or `enter`, or click the action. The daemon is asked first (`preview`); if it would refuse, the reason replaces the action. `r` looks again.
2. Read the card headed "Confirm · local only, nothing leaves this machine". It shows the exact command, directory, first branch and whose choice it is, plus "not done: no commit, no .gitignore, no remote, no network".
3. Press `enter` to initialize, or `esc` to go back.

The page then lands on Commit with the files listed. Nothing is committed. An existing `.gitignore` is honoured and left as it is; none is created.

A failed `git init` keeps the card with what git printed.

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

Push, publish and pull request creation are the only parts that use the network or publish anything. They are behind `experimental.git_actions` (`/experimental git_actions on`), with the same policy as [PR watch](pr-watch.md).

| Tier or setting | Effect |
|---|---|
| balanced | off by default; `/experimental git_actions on` turns it on |
| full | on by default; `/experimental git_actions off` turns it off |
| minimalist | never offers it |
| `features.git_actions: false` | blocks it |

Balanced and full allow the `git_actions` feature; what you set always wins.

Nothing runs by itself in full. Every push, publish and pull request shows its exact command on a card and waits for Enter, with no "always allow". The model has no tool for any of it.

No tier turns the network on for the model.

| | Switch off (default in balanced) | Switch on (default in full) |
|---|---|---|
| Commit tab | as above | as above, unchanged |
| PR tab | one line: "Off: this tab uses the network · /experimental git_actions on" (or "Blocked by features.git_actions" when that blocks it) | the pull request, `u` push, `P` create |
| Processes | no `git push`, no `gh`, no network: the terminal sends nothing and the daemon refuses with the same line | started only by a key you press |
| Hints | no push or pull request hint anywhere | on the PR tab |

There are no model tools for any of this and no prompt text: the page is for you, not for the agent. A session's model cannot push or open a pull request through it.

## PR tab

The tab reads the branch's pull request through `gh pr view --json …`, parsed by the same reader as the PR watch. It shows:

- number and title, `head → base`, state and draft, and the link;
- checks: passed, failed with the failing names, pending with their names;
- review decision and whether it merges cleanly.

| Key | Does |
|---|---|
| `r` | read again |
| `o`, or click the link | copy the link and print it; the terminal has no browser to open |

`gh` runs on the daemon's machine. A remote session shows one line saying to use the tab from a local session.

| Condition | What the tab shows |
|---|---|
| Switch off | one clear line |
| `gh` not installed | one clear line |
| `gh` not logged in | one clear line; run `gh auth login` in your shell |
| No pull request for the branch | one clear line, with `u` and `P` offered |
| No remote | empty state offering [publish](#publish-to-github-private) |

Not built, on purpose: merge, close, comment and delete of a remote branch. Those stay with `gh` in your shell.

## Push

1. Press `u` to open a card headed "leaves this machine".
2. Check the command and what will be sent.
3. Press `enter` to push, or `esc` to cancel.

The card shows:

- the exact command, remote name and address; credentials in a URL are masked as `***`;
- the number of commits to send and the newest subjects;
- repository hooks that will run (`pre-push`);
- what is not done: "no force, no tags, no other branch, no pull request".

There is no "always allow" or grant lasting a session. Every push is confirmed with the command in front of you.

### `git.push`

A daemon command for local clients only (remote clients and peers are refused; not in `READ_ONLY_COMMANDS`). Without `preview` it runs, once:

```
git push --no-recurse-submodules --no-follow-tags [-u] <remote> <branch>
```

`-u` is used only when the branch has no upstream. The branch is the one checked out. The remote is the branch's configured remote, else `origin`; without either, the push is refused.

The command never uses `--force`, `--force-with-lease`, `--tags`, `--all`, `--mirror` or `--delete`, never a refspec of its own and never another branch.

Branch and remote names are refused before anything runs if they:

- start with `-`;
- contain `..`, `:` or control characters;
- are rejected by `git check-ref-format`.

Nothing to push is a refusal, not a no-op push.

A rejected push (non-fast-forward) is shown as git printed it, redacted, last lines only, with "the page never forces, so update the branch and push again". The card stays so the command and the answer are together.

**Protected branches.** `main`, `master` and the remote's default branch need their name typed on the card before `enter` pushes (the daemon asks for the same `confirm` text).

## Publish to GitHub (private)

Where a push would refuse because the repository has no remote ("this repository has no remote"), the PR tab shows "No remote" and offers `Publish to GitHub (private)` (`g`, `u` or a click) instead. With the switch off the tab is the one "Off" line, as for everything else, and nothing is asked.

### Fill in the repository form

1. Press `g` to open the form.
2. Fill in the fields below. `tab` walks them; `enter` goes to the next one and, on the description, to the card. `esc` cancels.
3. Read the confirmation card. Press `enter` to publish, or `esc` to return to the form with what you typed.

| Field | Default and limits |
|---|---|
| `Name` | the folder's name, cleaned to what GitHub takes |
| `Owner` | your gh account, read with `gh api user`; plain text, so type an organization |
| `Description` | optional, one line |

The line under the fields says "private · change visibility on GitHub". **Visibility is not a field.** There is no public or internal option, flag, setting or parameter; `git.publish` has none in its schema.

### Confirm publication

The card is headed "leaves this machine", using the `warning` role. It shows:

- the exact command, `owner/name` and "private · change visibility on GitHub";
- the branch and its commits, or "no commit yet: this creates an empty repository, the first commit comes before the push", or a detached HEAD where only a remote is added;
- "not done: no push, no public repository, no other remote";
- that it uses your own gh login.

After publication the page says "published owner/name, private · origin added". The session gets the passive line "published owner/name as a private repository and added origin (nothing pushed)".

The PR tab reads again and `u` offers the push. Its card is confirmed separately: publishing never pushes.

### `git.publish`

A daemon command for local clients only, behind `experimental.git_actions` like `git.push` (same refusal line when it is off; not in `READ_ONLY_COMMANDS`). It runs, once:

```
gh repo create <owner>/<name> --private --source <root> --remote origin [--description=<text>]
```

When no owner is given, it runs `gh api user --jq .login` first.

There is no `--push`, `--public` or `--internal`, under any input. The builder takes only a validated owner and name; the description is a single `--description=` word. Form text cannot become a flag or reach a shell.

| Input | Validation |
|---|---|
| Name | `^[A-Za-z0-9._-]{1,100}$`; not starting with `.` or `-`, not ending in `.git` |
| Owner | letters, digits, `_` and `-`; up to 60, not starting with `-` |
| Description | one line, at most 350 characters |

Your `deny` rules of `permission.bash` are honoured against:

- `gh repo create <owner>/<name> --private --source …` (the full command);
- `gh repo create <owner>/<name>` and `gh repo create`;
- `gh api user` for the account read.

Output is redacted; the process group is killed on timeout. Only one commit, push, publish or pull request runs at a time per repository. Credentials are the ones gh already has.

### Publication refusals

Each refusal is one line, before or without creating anything:

- a remote named `origin` already exists: it is never replaced or renamed, and its address is masked;
- not a repository;
- an unusable name, owner or description;
- a deny rule, named in the refusal;
- gh not installed or not logged in;
- gh's own first line for the rest, such as name taken or organization not permitted.

A repository with no commit and one on a detached HEAD are allowed. Publishing only adds a remote; the card says which state it is.

### When only part of publication happened

After a failed or timed-out gh, the page looks at `origin` once and reports exactly what is true. The first line says what happened:

- "publish incomplete: owner/name was created, gh failed (exit 1)";
- "gh timed out after 90s: owner/name may or may not exist on GitHub";
- "gh reported success but origin was not added";
- "gh failed after adding origin".

Then it shows:

| Line | Meaning |
|---|---|
| `now:` | where `origin` points, or that there is none |
| `on GitHub:` | the link gh printed, or that it is unknown |
| `run:` | what to type: `git remote add origin <link>` |

It says "nothing was deleted and nothing is retried", then shows what gh printed. The hosted repository is never deleted. Nothing runs a second time unless you press `enter` on the card again.

## Create pull request

The branch must be pushed and level with its upstream. Otherwise the page says "push first" and why, and pushes nothing. Pushing is a separate, confirmed step (`u`), never implicit.

1. Press `P` when the branch has no pull request. A form opens with title, body, base branch and draft.
2. Fill in the fields. `tab` walks them, `space` toggles draft, and `enter` on base or draft opens the card. `esc` cancels.
3. Read the card headed "leaves this machine". Press `enter` to create, or `esc` to return to the form with what you typed.

| Field | Prefilled value |
|---|---|
| Title | from commits since the merge-base with the base: one commit uses its subject; otherwise the branch name |
| Body | commit subjects |
| Base branch | the remote's default branch; editable |

Below 70 columns one field shows at a time.

The card shows:

- the exact command;
- the body, counted in lines: it goes on standard input, never in the command;
- the remote and its address;
- commits in the pull request but not in the base;
- "not done: no merge, no force, no push".

The new pull request's link is shown. When the session metadata feature is on, it is saved on the session the way `/pr link` does.

### `git.pr.create`

Local clients only. It runs:

```
gh pr create --base <base> --head <branch> --title=<title> --body-file - [--draft]
```

The title is one `--title=` argument and the body goes through standard input: neither is ever put in a shell string, so quotes, newlines, backticks and `$(…)` in them are just text. Limits: 256 characters of title, one line; the body is bounded.

## Safety, for push, publish and pull request

### Local access and credentials

Only local clients can use these actions. Remote and peer connections are refused. None of the commands, nor `git.init`, is in `READ_ONLY_COMMANDS`.

Calls use argv arrays, not a shell:

- `GIT_TERMINAL_PROMPT=0`, no askpass;
- ssh in batch mode, unless you set `GIT_SSH_COMMAND` or `core.sshCommand` yourself;
- `GIT_*` variables that relocate the repository removed from the environment.

The page uses your own login: git credential helper, ssh agent, `gh auth`. It never reads, logs or shows a credential. If git or gh would have to ask for one, the action fails.

### Process and path limits

- Output is bounded and passes through secret redaction. A token in a remote URL is masked on the card and in errors.
- Every process has a timeout that kills its process group. One commit, push or pull request runs at a time per repository.
- The repository directory must be inside the project, as in Commit.

### Permission rules

A matching `deny` rule of `permission.bash` refuses the action and is named in the refusal. Rules can come from settings, project rules or the session's own rules.

Matches include `git push origin main`, `gh pr create`, or the full command. `allow` and `ask` rules are not used: the page always asks you on the card.

The `tools` toggles do not apply because this is not a model tool.

After a push or pull request, the session gets a passive transcript line, such as "pushed feat/x to origin". It never starts a model turn.

## New session in its own worktree

Set `git.newSessionWorktree: true` to make `/new` and `/bg` create sessions in fresh workspaces instead of the project folder. It is off by default and needs the Git page: balanced and full.

This uses the same code path as `/warp` → New workspace: `workspace-create` for a worktree, then `workspace-warp`. The folder and `mend/` branch are named the same way. See [Worktrees](worktrees.md#a-new-session-in-its-own-worktree).

## Not here

The page covers review, commit, push and opening a pull request. The rest stays with the agent and your shell:

- merge or close a pull request;
- delete a remote branch or repository;
- create a public or internal repository: change visibility on GitHub;
- make a first commit for you;
- force push, tags, branch switch, stash, amend and staging by hunk.
