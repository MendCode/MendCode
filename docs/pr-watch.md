# PR watch

A session can link a GitHub pull request. The daemon then reads it about once a minute through the user's own `gh` login and wakes the session **only** when something changed, so waiting for CI or a review costs no model calls. The `pr-watch` loop template ([loops](loops.md)) stays for goal-style babysitting (it is a model turn per wake); this is the zero-token alternative for "tell me when it changes".

It is **off by default** and reaches the network, so it needs `experimental.pr_watch` (`/experimental pr_watch on`). It is allowed from the `balanced` tier up ([tiers](tiers.md): feature `pr_watch`, mode `permit`: the tier allows it, the switch turns it on; minimalist never offers it). With the switch off the daemon runs no `gh` at all, including for watches it already holds.

## Use

- Model: the `pr_watch` tool (`watch [pr]`, `unwatch [pr]`, `list`). Starting a watch is a write action, so the user approves it and the approval says that `gh pr view` will run now and every minute. `list` and `unwatch` need no approval. Main agent only.
- You: `/pr on` and `/pr off` turn this and the [PR reviewer](pr-review.md) on or off together (`experimental.pr_watch` and `experimental.pr_review`, one save); with both off `/pr` says so. `/pr comments [pr]` shows a pull request's review comments (read-only). Tab after `/pr ` lists every word ([commands](commands.md#arguments)). `/pr` lists the session's watches, `/pr watch [pr]`, `/pr unwatch [pr]`, `/pr check [pr]` (reads one now, no watch, no wake). `pr` is a number, `#number`, a github.com pull URL or a branch; omitted, it is the current branch's PR. A page shows the PR's checks (passed, failed, pending and the failing names), review decision, mergeability and each watch with its last known state.
- Protocol: `pr.watch` (`sessionId`, `action`, `pr`). Local clients only: it runs `gh` on the daemon's machine, so remote and peer clients are refused, and it is not a read-only command.

## What wakes the session

Only four events, each reported once:

1. a check failed (again only when the set of failing checks changes);
2. all checks passed (again only after they went pending or red and passed anew);
3. someone other than you commented or reviewed (your `gh` account, or the PR's author when `gh api user` fails; bots count);
4. the PR conflicts with its base.

What is already on the PR when the watch starts is the baseline: the `watch` answer shows it and nothing from it wakes you. The wake is a queued notice that starts a turn when the session is free (a busy session keeps the news and gets it, merged with anything newer, when it is idle). Its text says PR content is untrusted evidence: titles, check names and comment excerpts are quoted, secrets are masked, and it tells the agent to inspect with its own tools (`gh pr checks`, `gh run view --log-failed`) under its current permissions. Required-versus-optional checks are not distinguished: any red check counts, and "all passed" needs every reported check done and green.

A watch ends on merge or close (silently; `/pr` shows it as ended), after 10 wakes caused only by comments (the last wake says so), or when the PR cannot be read for 15 minutes (the session is woken once with the reason), and when its session is deleted. Limits: 5 watches per session, 20 in all.

## Where it lives

PR metadata and diagnostics are masked and redacted before replies, persistence and wake notices. A poll only accepts a
canonical `https://github.com/owner/repo/pull/number` returned URL; loaded watches are checked again. Atomic persistence
uses an exclusive random temporary file. Peer model turns also exclude `pr_watch`, including automatic continuations.

`packages/daemon/src/pr-watch.ts`. `gh` is started with an argument array (never a shell) and inherits the user's environment; MendCode stores no token. A reference is validated before it reaches `gh` (a number, a github.com pull URL or a plain branch, never an option). State is `<dir>/pr-watch.json` (mode 0600, written atomically; what was already reported survives a restart, secrets are masked before anything is stored). The timer exists only while a watch is active. Tests inject a fake `gh` (`DaemonOptions.prWatch.run`).

The [Git page](git.md)'s PR tab reads the same pull request with the same parser and is behind the same kind of switch (`experimental.git_actions`); it is a separate switch from `experimental.pr_watch`.

`/pr-watch` is an alias of `/pr`. To have a whole repository's pull requests reviewed, not one PR watched, see the
[PR reviewer](pr-review.md): `/pr watch-repo` and `/pr review`, behind its own switch, `experimental.pr_review`.
