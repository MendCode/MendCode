# PR watch

A session can watch a GitHub pull request and wake only when something changes. The daemon checks about once a minute through your own `gh` login, so waiting for CI or a review costs no model calls.

## Turn on PR watch

1. Use the `balanced` tier or above. In [tiers](tiers.md), feature `pr_watch` uses mode `permit`: the tier allows it, and the switch turns it on. Minimalist never offers it.
2. Run `/experimental pr_watch on` to enable `experimental.pr_watch`. It is **off by default** and reaches the network.
3. Run `/pr watch [pr]` to link a pull request to the session.

With the switch off, the daemon runs no `gh` at all, including for watches it already holds.

The `pr-watch` loop template ([loops](loops.md)) stays for goal-style babysitting: it uses a model turn per wake. PR watch is the zero-token alternative for "tell me when it changes".

## Use

### Commands

| Command | Does |
|---|---|
| `/pr on`, `/pr off` | Turn PR watch and the [PR reviewer](pr-review.md) on or off together: `experimental.pr_watch` and `experimental.pr_review`, in one save |
| `/pr` | List the session's watches; with both switches off, say so |
| `/pr watch [pr]` | Start a watch |
| `/pr unwatch [pr]` | Stop a watch |
| `/pr check [pr]` | Read one PR now, with no watch and no wake |
| `/pr comments [pr]` | Show a pull request's review comments (read-only) |
| `/pr-watch` | Alias of `/pr` |

Tab after `/pr ` lists every word ([commands](commands.md#arguments)). For `pr`, use a number, `#number`, a github.com pull URL or a branch. Omit it to use the current branch's PR.

The page shows the PR's checks (passed, failed, pending and the failing names), review decision, mergeability and each watch with its last known state.

### Model tool

The main agent can use the `pr_watch` tool: `watch [pr]`, `unwatch [pr]`, `list`. Starting a watch is a write action that you approve; the approval says `gh pr view` will run now and every minute.

`list` and `unwatch` need no approval. The tool is main agent only.

For a whole repository's pull requests to be reviewed, rather than one PR watched, see the [PR reviewer](pr-review.md): `/pr watch-repo` and `/pr review` use their own switch, `experimental.pr_review`.

## What wakes the session

Only four events, each reported once:

1. a check failed (again only when the set of failing checks changes);
2. all checks passed (again only after they went pending or red and passed anew);
3. someone other than you commented or reviewed (your `gh` account, or the PR's author when `gh api user` fails; bots count);
4. the PR conflicts with its base.

What is already on the PR when the watch starts is the baseline. The `watch` answer shows it; nothing from it wakes you.

The wake is a queued notice that starts a turn when the session is free. A busy session keeps the news and gets it, merged with anything newer, when it is idle.

The notice says PR content is untrusted evidence. Titles, check names and comment excerpts are quoted, and secrets are masked. It tells the agent to inspect with its own tools (`gh pr checks`, `gh run view --log-failed`) under its current permissions.

Required-versus-optional checks are not distinguished: any red check counts. "All passed" needs every reported check done and green.

### When a watch ends

| Condition | What you see |
|---|---|
| PR merged or closed | Ends silently; `/pr` shows it as ended |
| 10 wakes caused only by comments | The last wake says the watch ends |
| PR gone or inaccessible for 15 awake minutes | The session wakes once with the reason |
| Session deleted | Its watch ends |

A network outage never ends a watch. Failing time is counted awake, as the [repo watch](pr-review.md#on-your-machine-pr-review-and-the-repo-watch) counts it: a sleeping laptop adds nothing, and the session is told once.

| Limit | Watches |
|---|---|
| Per session | 5 |
| In all | 20 |

## Where it lives

The [Git page](git.md)'s PR tab reads the same pull request with the same parser. It uses `experimental.git_actions`, a separate switch from `experimental.pr_watch`.

### Protocol and validation

The protocol command is `pr.watch` (`sessionId`, `action`, `pr`). It is local clients only: it runs `gh` on the daemon's machine, so remote and peer clients are refused. It is not a read-only command.

Peer model turns also exclude `pr_watch`, including automatic continuations. PR metadata and diagnostics are masked and redacted before replies, persistence and wake notices.

A poll only accepts a canonical `https://github.com/owner/repo/pull/number` returned URL; loaded watches are checked again. A reference is validated before it reaches `gh`: a number, a github.com pull URL or a plain branch, never an option.

### Implementation and storage

The implementation is `packages/daemon/src/pr-watch.ts`. It starts `gh` with an argument array, never a shell, and inherits your environment. MendCode stores no token.

State is `<dir>/pr-watch.json`, mode 0600, written atomically using an exclusive random temporary file. What was already reported survives a restart; secrets are masked before anything is stored.

The timer exists only while a watch is active. Tests inject a fake `gh` (`DaemonOptions.prWatch.run`).
