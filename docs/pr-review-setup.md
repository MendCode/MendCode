# PR reviewer: team setup

## One-step setup

In a local session in the repository clone, run **`/pr setup [all|requested]`**. It checks the origin, `gh` login and
`.mendcode/review.yaml` on the origin base branch, then shows one confirmation listing what will change. Enter enables the
reviewer, starts the watch and allows publishing reviews to GitHub using your login. Escape changes nothing. Already-enabled
steps are skipped; failures and their fixes stay on a scrollable page. The result opens PR repositories.

The default is `all` when the base config's `reviewers` is `all`, otherwise `requested`. The balanced tier or a permitted
`pr_review` override is required; when the tier does not include it (unset or minimalist), setup lists "Allow the PR reviewer in this tier (features.pr_review: true; the tier stays …)" among its changes and writes it on confirmation. Safe mode and an explicit `features.pr_review: false` stay problems it will not override; the latter says how to turn it back on. Setup never changes the tier, model, repository files or remotes. A `public` remote with
review enabled is identified when origin lacks it; use a clone of that repository rather than silently redirecting origin.
The quick path currently checks GitHub; the manual commands below remain available for GitLab and Gitea.

A development daemon ([dev mode](dev-mode.md)) records the watch but never runs it; setup says so. When something needs attention, nothing is applied, even with `--yes`, and the output ends with "Nothing changed".

Headless: `mendcode pr setup [all|requested] --session ID`. It uses that session's checkout and model and asks once in a terminal.
For automation, add `--yes` to consent to the listed changes, including model calls and GitHub publishing; without consent it
returns a preview and exit code 4. `--json` is noninteractive. `--dir DATA` selects the daemon storage.

The base config and machine credentials still need to exist; setup does not commit configuration, install programs, start a
system service or obtain credentials. A missing base ref reports how to fetch origin and set its default branch.

How to set up MendCode's [PR reviewer](pr-review.md) for a team, including a team whose developers use laptops that are
sometimes off, asleep or offline. This page is the how-to. For what each key or rule does, follow the links to
[the reference](pr-review.md).

## Pick a topology

| Topology | Runs on | Good for | What you give up |
|---|---|---|---|
| **A. Hosted workflow** | GitHub's own runners | No machine to keep on; GitHub only | No fixes pushed (`@mendcode fix`, `fix.mode`), no `checks`, no follow-ups on failing checks, a provider API key as a repository secret |
| **B. One always-on server, plus optional personal reviewers** (recommended) | A VPS or any machine that stays on; laptops optional | Laptops that sleep; fixes; GitHub, GitLab and Gitea / Forgejo | One machine to run, with `gh` (or `glab`, or a Gitea token) and a model it can use without a browser |
| **C. Personal reviewers only** | Each developer's laptop | Small teams where everyone reviews their own requests | A PR waits while the laptop of the reviewer it is routed to is off |

The main question is whether a PR may wait for one person's laptop. With B, the server reviews every PR and laptops add
personal reviews when they are on. With C, nothing reviews a PR routed to a laptop that is off. It waits, with its reason shown,
until that laptop comes back.

You can combine A with personal reviewers on laptops (`/pr watch-repo requested`). Only one MendCode review is posted per PR
head: whichever reviewer posts first, the others keep theirs in their own session
([one review per head](pr-review.md#many-reviewers-on-one-repository)).

## Set it up with your session

You can do the steps below by hand, or ask your MendCode session in the repository's checkout: "set up PR review for this repo".

1. The session calls `review_config` with `setup`, which is read-only and writes nothing. It reports:
   - the forge, your login and permission;
   - `.mendcode/review.yaml` and `.mendcode/reviewers.yaml` on the base branch, and their working-tree diff;
   - whether the hosted workflow is installed;
   - this daemon's watches and their posting consent;
   - other devices' claims on open PRs, and your personal profile's path;
   - the signals of your role: permission, `CODEOWNERS`, `MAINTAINERS`, a `reviewers.yaml` entry, recent PR activity, and saved
     memories that state a role.

   On GitLab and Gitea your login, permission and activity are not read there, so you are asked.
2. The report ends with what is missing and the questions to ask: your role, global or personal reviewer, topology, posting
   consent, language, fixes and budget. The session confirms an inferred role with you instead of assuming it.
3. Each answer is applied through `review_config` preview and apply, and every apply shows you the before and after and asks you.
   A `global` change edits the checkout's working-tree `review.yaml` only; you commit it to the base branch. The `/pr` commands
   (`/pr on`, `/pr watch-repo`, `/pr publish on`) you type yourself.

To review a PR now, the session uses the `pr_review` tool (`review`, which asks your approval outside full access) or you run `/pr review <n>`. A
session never posts `@mendcode`, or anything else, from your account to start a review.

## Before any topology: the repository config

Commit `.mendcode/review.yaml` to the base branch (usually `main`). Nothing is posted until it says `enabled: true`. The base
branch is the trust root: a PR's own copy of the file can only add path instructions
([repository config](pr-review.md#repository-config)). A minimal team file:

```yaml
enabled: true
```

That is the `balanced` preset: automatic reviews of ready PRs, normal profile, at most 8 inline comments, incremental reviews,
no fixes. Common additions:

```yaml
enabled: true
filters:
  labels: { exclude: [no-review] }   # a label that keeps a PR out of review
  paths: ["src/**"]                  # review only PRs that touch these paths
template: { language: English }      # every review's language (repository only); auto = the PR author's language
budget: { tokens_per_pr: 1000000 }   # per PR head; null = no internal cap
backlog: { max_prs: 10, window_days: 30 }  # open PRs with no review yet, reviewed when a watch starts; 0 = none
```

To let MendCode push fixes, add these keys. Keep them off until the team has seen a few reviews:

```yaml
fixes: true                        # @mendcode fix may push one commit
fix: { mode: fix-once, push: true } # fix the confirmed findings once, automatically, and push
```

A fix is never force-pushed and never merged. It is pushed only when the branch is still where the fix started, and only when the
reviewer may push there (a fork must allow edits from maintainers). In every other case it is kept on a local ref
`refs/mendcode/fix/<pr>/<time>` with the reason ([fix modes](pr-review.md#fix-modes-and-taking-over)).

Who may post and who may ask:

- `publishers: maintainers` (the default): only a login with write access posts. A reviewer that may not post keeps its reviews
  in its own session.
- `@mendcode` commands are taken only from someone with write access. Anyone else gets one reply that only maintainers can run
  it, and nothing changes ([commands](pr-review.md#commands-in-a-pull-request)).

## A. Hosted workflow (GitHub only)

```sh
mendcode --dir /tmp/mend-ci github install --hosted --model openai/MODEL --release TAG --sha256 HEX         # preview
mendcode --dir /tmp/mend-ci github install --hosted --model openai/MODEL --release TAG --sha256 HEX --write # write the file
```

1. Run it in a clean checkout of the repository. It writes `.github/workflows/mendcode-review.yml`, and only when that file does
   not exist yet.
2. `--release` and `--sha256` pin one MendCode release. The hash is the `install.sh` line of that release's `SHA256SUMS`.
3. Add the provider key as a repository secret, named after the provider (`OPENAI_API_KEY` for `openai/...`). A model with no
   API key (a local server, a subscription login) is refused at install.
4. Commit the workflow and `.mendcode/review.yaml` with `enabled: true`. MendCode never pushes the workflow for you.

It reviews on `pull_request` (opened, synchronize, ready for review) and on an `@mendcode` comment from an owner, member or
collaborator. A fork's PR gets no secret. Its run says so in the job summary, and a maintainer's `@mendcode review` reviews it
from the base repository. Details: [hosted PR reviewer](github.md#hosted-pr-reviewer).

Limits of this topology: the job's token cannot push, so `@mendcode fix` and `fix.mode` do nothing useful. A hosted review runs
no `checks`, explains no failing check, and does not apply the repository's filters to an `@mendcode` comment yet.

## B. Always-on server, plus personal reviewers on laptops

### On the server (the global reviewer)

The server is one MendCode daemon that watches the repository with `all`. Steps:

1. **A machine that stays on**, with `git`, `gh` and `mendcode` installed. Linux or macOS, so the daemon can run as a user
   service.
2. **A GitHub login for the server.** `gh auth login` as that login. With `publishers: maintainers` it needs write access to
   the repository, or list it in `publishers`. A separate machine account keeps the server's reviews apart from any developer's.
3. **A model that works on that machine without a browser**: an API key provider, or Claude Code or Codex already signed in on
   that machine. `/connect chatgpt` has no device code, so it needs a browser on the machine that runs the daemon
   ([setup](setup.md)). Review children run on the model of the session that started the watch.
4. **A clone of the repository**, for example `/srv/repos/app`, with `origin` pointing at the repository.
5. **Start the daemon as a user service**, so it survives logouts, reboots and closed terminals
   ([user daemon service](automation.md#user-daemon-service-b68)):

   ```sh
   mendcode daemon service install --cwd /srv/repos/app
   mendcode daemon service start
   mendcode daemon status
   ```

   On Linux this is a systemd user unit (`Restart=always`). systemd normally runs a user's units only while that user is logged
   in. `loginctl enable-linger <user>` keeps them running, and MendCode does not set it for you. On macOS it is a launchd agent
   (`RunAtLoad`, `KeepAlive`).
6. **Start the watch from a session on that machine.** Over SSH, in the clone, run `mendcode`, pick the model (`/model`), then:

   ```text
   /pr setup all
   ```

   Confirm the page once, including permission to publish. It enables `experimental.pr_review`, which the `balanced` tier and
   above allow ([tiers](tiers.md)). Then close the terminal. The watch belongs to the daemon.
   While a watch, a held notice or a later job exists, the daemon does not stop itself when idle
   ([review language and session notices](pr-review.md#review-language-and-session-notices)).
7. **Check it.** The `/pr watch-repo` answer lists the open PRs it queued for review and every PR it skipped, with the reason.
   This is the backlog: open PRs whose current head has no review yet, newest first, at most `backlog.max_prs` (10), updated
   within `backlog.window_days` (30) ([open PRs when a watch starts](pr-review.md#on-your-machine-pr-review-and-the-repo-watch)).
   `/pr repos` lists the watch, and `/reviews` shows the jobs. Open a test PR: within about a minute a job runs, and a review
   appears on the PR.

`/pr` and `/reviews` work only from a local session on the daemon's machine. A remote terminal attached to the daemon is refused,
because the reviewer runs `gh` on that machine. One daemon watches at most 10 repositories.

### `.mendcode/reviewers.yaml` (only when you add personal reviewers)

Without this file the repository has one implicit global reviewer, and that is enough for the server alone. To route areas to
developers, commit this file to the base branch ([reviewers, routing and devices](pr-review.md#reviewers-routing-and-devices)):

```yaml
version: 1
reviewers:
  - id: team
    scope: global
    login: acme-review-bot        # the server's gh login: only a daemon logged in as it runs the global reviewer
  - id: alice
    scope: personal
    login: alice
    areas: ["src/api/**"]
  - id: bob
    scope: personal
    login: bob
    areas: ["web/**"]
routing:
  default: team
  global: always                  # always: the server reviews every PR too; personal-only: only PRs no personal reviewer matched
```

- Give the global reviewer the server's `login`. A global reviewer without a login runs on every daemon that watches with `all`,
  including a laptop's.
- `global: always` is the choice for laptops that are often off: every PR gets the server's review, and personal reviewers add
  theirs when their laptop is on. Only one review is posted per head, so a personal review of a head the server already posted
  stays in that developer's session, and both reviews spend tokens.
- `global: personal-only` (with `fallback`) sends the server only the PRs no personal reviewer matched. A PR routed to Alice
  then waits for Alice's laptop, and the server does not take it over, however long it is off.
- `capabilities` (default: all of `review`, `fix`, `publish`) is enforced. A reviewer without `publish` keeps its reviews in its
  owner's session and posts no claim comment. One without `fix` runs no automatic fix, and its `@mendcode fix` gets one reply
  saying so. `review.yaml` still decides whether a capability is used.
- A `login` follows the checkout's forge. On GitLab and Gitea it may hold `_` and `.`, but not end in `.`.
- A typo or an unknown key (such as `memory:`) makes the whole file a problem. The implicit global reviewer is then used, and the
  problem is named. The file never holds memory, profiles or credentials.

### On each laptop (a personal reviewer)

1. `gh auth login` as the developer, a model in MendCode, a clone of the repository.
2. Optional, so the daemon starts at login without opening a terminal:
   `mendcode daemon service install --cwd ~/code/app` and then `mendcode daemon service start`.
3. In a MendCode session in the clone:

   ```text
   /pr setup requested
   ```

`requested` runs your personal reviewer. It reviews the PRs that request a review from your login or are assigned to you, and the
PRs that `reviewers.yaml` routes to your personal reviewer by area or label. It never runs the global reviewer. A watch with
`all` would also run a global reviewer without a `login`, so give the global reviewer the server's login as above.

To push fixes from a personal reviewer, the repository must also set `fix.personal: true`. Without it, the fix is committed and
kept locally, never pushed.

Your personal profile (tone, cap, stricter filters, your own memory) lives in `<dir>/pr-review/profiles/`, never in the
repository. It can only narrow the repository's config. Change it by asking your session ("make my review of this repo quiet"):
the `review_config` tool shows the before and after and asks you first
([configuration layers](pr-review.md#configuration-layers), [memory in reviews](pr-review.md#memory-in-reviews)).

## C. Personal reviewers only

Every developer runs the laptop steps above with `/pr watch-repo requested`, and nobody runs a server. Request a reviewer on
GitHub (or assign the PR) to start that person's review. A PR whose requested reviewer's laptop is off waits for it. The hosted
workflow (A) can be the shared reviewer instead of a server.

## GitLab and Gitea / Forgejo

Topologies B and C work the same way on these forges. There is no hosted workflow, because it is a GitHub Action
([providers](pr-review.md#providers)).

- **GitLab**: install `glab` on the daemon's machine and run `glab auth login` for the host (or set `GITLAB_TOKEN` for glab).
- **Gitea / Forgejo**: the daemon reads a token from `GITEA_TOKEN` in its own environment at each call and never stores it. The
  user service does not embed secrets in its unit, so when you run the daemon as a service you provide that variable yourself.
- **A self-hosted instance** on a host whose name does not say `gitlab`, `gitea` or `forgejo`: tell the checkout which forge it
  is.

  ```sh
  git config mendcode.forge gitlab                      # or gitea
  git config mendcode.forgeUrl http://git.example:8929  # for an ssh remote, another port or scheme
  ```

The `/pr watch-repo` answer names what the forge lacks: no explanation of failing checks on either forge, and no thread
resolution on Gitea / Forgejo. Logins in `reviewers.yaml` and in `review.yaml`'s `reviewers` and `publishers` follow the forge's
username syntax: `_` and `.` are allowed, but not a trailing `.`.

## When a laptop is off, asleep or offline

Nothing depends on an event the laptop missed. The provider's current state is the source of truth
([jobs, restarts and remote effects](pr-review.md#jobs-restarts-and-remote-effects)).

**While the laptop is off.** The server (or any other daemon) records each PR routed to the laptop's personal reviewer as a
`waiting` job with its reason: `waiting for @alice's MendCode (offline or another device) …`. It is never run there and never
counted as a failure. Every 10 minutes the waiting daemon reads that PR again. Once Alice's login has submitted a review of the
head, the waiting job closes as `done`, naming the device that ran it.

**When it stays away (opt-in).** Add `routing.offline_fallback: { after_minutes: 30 }` to `.mendcode/reviewers.yaml` and the
server's global reviewer takes such a PR after 30 minutes, unless the laptop claims or reviews it first. The waiting job names the
reviewer and the time (`offline fallback: team reviews this pull request at … unless @alice's MendCode (alice-backend) claims or
reviews its head first`). When the laptop comes back after the fallback posted, it sees that review and posts nothing. Without
the key nothing changes. Details: [offline fallback](pr-review.md#reviewers-routing-and-devices).

**When the laptop comes back.** Its daemon's first listing is a catch-up. It reads the open PRs, review requests and assignees,
and the changed files of at most the 20 newest unreviewed PRs for area routing. It starts what is routed to it and not yet
reviewed at the current head. The backlog also runs then: open PRs with no review of their head, within `backlog.max_prs` and
`backlog.window_days`. PRs opened, heads pushed and `@mendcode` comments written meanwhile are read then. Heads that were already
reviewed are skipped.

**Two devices, one reviewer** (Alice's laptop and desktop both watching). Each review job claims its PR with a hidden comment
(two hours, renewed every hour while it runs, edited to "released" when it ends). The other device's job waits and names the
holder. When the holder releases the claim early, the comment edit wakes the waiting device at its next poll (about a minute
live), instead of after the full two hours. Right before each write, the job checks that it still holds its claim, so a laptop
that went to sleep mid-review and lost its claim posts nothing. Claims are best-effort, not compare-and-swap. Two devices that
claim within the same few seconds can both start. The check before each write and the per-head review marker are what keep the
posts single ([one writer per pull request](pr-review.md#reviewers-routing-and-devices)).

**Sleep and network loss** ([outages and sleep](pr-review.md#on-your-machine-pr-review-and-the-repo-watch)):

- The watch counts failing time in awake time. The daemon compares the wall clock with a monotonic clock that stops while the
  machine sleeps, so the hours a laptop sleeps with its lid closed do not count, and neither do its dark wakes without network.
- A failed listing is tried again at the next tick. After that the gap doubles (2, 4, 8 minutes), up to 15 minutes.
- A network or forge outage never ends a watch. That covers no route, DNS, timeouts, 5xx and rate limits, and also an error that
  says neither. After 15 awake minutes the session is told once, and told again when listing works. At the first listing that
  works, the watch catches up on the PRs, pushes and `@mendcode` comments of the outage.
- Only a permanent error for 15 awake minutes in a row ends a watch: the repository is gone (a 404), access was revoked (a 403
  that is not a rate limit), or the checkout no longer points at the forge. `/pr watch-repo` starts it again.
- A job whose attempt failed on the network or the forge, or that the machine slept through, waits and runs again without
  spending one of its 5 attempts. The wait is at most 15 minutes, and this holds for up to 24 hours after the first such failure.
- A missing or logged-out `gh` pauses the watch instead, with one notice. The watch retries every 5 minutes.

**Closing the lid in the middle of a fix.** A fix is committed and kept on its local ref before anything is pushed. A push is
refused when the branch moved, and MendCode never force-pushes. The kept commit and the job's checkpoint survive a restart.

## Day to day

For each developer:

- **`/reviews`** (or `/pr dashboard`) is the page of review jobs, grouped by state and stack. Use `enter` for a job's detail
  (stages, findings, stop reason, tokens), `o` to open the PR, `s` for the review session and `S` for the fix session. `p` and
  `u` pause and resume, `x` cancels, and `R` retries (it asks for a reason). `t` takes a job's fix session over, or releases it.
  `c` shows the job's effective config and where each key came from, `/` filters, and `2` shows the watches and reviewers with
  each one's device and availability. The header names only `enter detail · / search · ? keys` (and `esc follow latest` while
  a job is pinned); `?` lists every key under the tabs. Next to the tabs the page counts only what needs attention (running,
  queued, waiting, failed) or says `idle`; the Watches tab's ledger keeps the 24-hour totals and tokens.
- **`/pr list`** shows each watched PR and, for a PR that is not reviewed, why (`draft: waits for ready for review`, `label
  \`no-review\` excluded`). It also shows `jobs: N queued, M waiting`.
- **`/pr review 42`** reviews one PR now, in your session. Asking your session ("review PR 42") does the same through the
  `pr_review` tool, which asks your approval first unless the session has full access. Nothing is commented on the PR to start it, and the review is posted only as
  `/pr publish` allows.
- **Notices.** A failed or stopped job's notice names the repository, the PR, the head's first 12 characters, the reason, the
  next retry time and the attempts left, with a `Head: <sha12>` line.
- **Taking over a fix.** `t` on a job that is fixing pauses it, and no automatic fix or push runs. You get its fix session to
  steer. Releasing it (`t` again) continues from the kept fix and does not count the interrupted round.

In a pull request (write access needed):

| Comment | Effect |
|---|---|
| `@mendcode review` | Reviews the PR. A head already reviewed gets one reply linking that review ("the next push will be reviewed"), and the request is kept: the next head is reviewed even with `triggers.synchronize` off, after a restart too, until the PR closes. A PR the filters exclude gets one reply naming the filter. |
| `@mendcode review @alice` | The same, answered only by the reviewer running as `@alice`. |
| `@mendcode fix [what]` | One fix commit, pushed only with `fixes: true` and passing checks; never on the hosted workflow. |
| `@mendcode explain [question]` | A reply to one of MendCode's review comments: a read-only child answers about that finding. |
| `@mendcode pause` / `resume` | Stop or restart automatic reviews of new pushes on this PR. |
| `@mendcode learn <text>` | Replies with the line to add to `.mendcode/review-learnings.md` on the base branch. |

A command is checked in one order: the commenter's write access, then the filters, then whether the head was reviewed. A comment
from the daemon's own login runs like `/pr review` (its `@mendcode fix` still needs write access), and anything it is refused is
said in the session only. Full rules: [commands in a pull request](pr-review.md#commands-in-a-pull-request).

## Troubleshooting

| Symptom | Cause and what to do |
|---|---|
| `/pr repos` says `ended (unreadable)` | A permanent error for 15 awake minutes: the repository is gone, access was revoked, or the origin changed. Fix the access, then run `/pr watch-repo` again. A network outage does not end a watch. |
| `/pr repos` says `paused (…)` | `gh` is missing or logged out (GitLab: `glab`; Gitea: `GITEA_TOKEN`). Log it in. The watch retries every 5 minutes and resumes by itself, and `/pr watch-repo` retries now. |
| Nothing is posted | `enabled: true` is missing on the base branch, `/pr publish on` was never answered, the login is not a publisher, or another reviewer already posted a MendCode review of that head. The session notice says which. |
| A PR is not reviewed | `/pr list` gives the reason (draft, label, path, author, mode). On a `requested` watch, only PRs that request your login, are assigned to you, or route to your personal reviewer by area or label count. A PR open before the watch started is reviewed only within the backlog's limits, and the `/pr watch-repo` answer says why it skipped one. |
| A job is `waiting` | Another device or login runs that reviewer, a claim is held elsewhere, a quota reset is due, or a network outage is being waited out. The job's detail in `/reviews` says which. |
| A job is `checkpointed` | The token budget, a quota or a rate limit stopped it. Its candidates are kept. Raise `budget.tokens_per_pr` if it was the budget, then `R` retry with a reason: only the verify pass runs, and nothing is reviewed twice. With `on_quota: wait`, a quota stop resumes by itself after the reset ([budgets](pr-review.md#budgets-quotas-and-accounting)). MendCode never switches to another model, provider or paid usage. |
| A job is `stale` | Someone pushed while it ran. Its result is not posted, and the new head gets its own job. |
| A job is `failed` | It failed 5 attempts on something other than a network or forge outage. Or its fix round left a finding open: the re-check of the pushed fix still found it, the stop names it (`1 confirmed finding still open (cancel.ts:8)`), and `fix-once` never ends `done` then. The detail shows the reason. `R` retries it, and a new push starts a new job. |
| A turn "stalled" | The model sent no event for 10 minutes (a fix session waiting for your approval does not count), or the turn reached its 2-hour cap. The job's work is kept in its checkpoint and retried with backoff, and each retry spends an attempt. There is no fixed time limit for a turn that keeps working. |
| A fix was not pushed | One of `fix.push`, `fix.personal` (personal reviewers), `/pr publish on`, write access, the fork's maintainer edits, or an unmoved branch was missing. The commit is on `refs/mendcode/fix/<pr>/<time>` in the daemon's clone, and the notice names the reason. |
| A post timed out | The review may have gone through. MendCode reads the PR for its marker before sending anything again, and never posts twice for the same effect. |
| The daemon stopped | `mendcode daemon status`. With a user service it restarts by itself. Without one, start MendCode again: the watch, its jobs and its kept commands are in `<dir>/pr-review/` and are picked up. |
| `daemon status` says `not answering · process N holds the data directory` | A daemon runs but does not answer on its socket, and no new one can start while it holds the lock. Stop it with `kill N`; an open MendCode terminal starts a new one, or run `mendcode daemon start`. |

## Limits

- **Hosted workflow:** cannot push fixes, runs no `checks`, has no follow-ups, and does not apply the filters to a comment yet.
- **Claims are best-effort.** They are not compare-and-swap. Daemons with different logins do not see each other's claims. Only
  the "one MendCode review per head" check keeps them from both posting, after both have spent tokens.
- **A PR routed to a personal reviewer waits for that laptop.** With `routing.global: personal-only` nothing covers it meanwhile,
  unless `routing.offline_fallback` is set (see "When a laptop is off, asleep or offline").
- **A Codex review child** still reads your own `~/.codex/AGENTS.md`. Codex 0.162.1 has no switch to turn that off, and MendCode
  never moves or copies `~/.codex` to get around it.

What was verified live and what rests on tests:

| Area | Evidence |
|---|---|
| GitHub: the watch, reviews, inline findings, dedupe across restarts, `@mendcode` commands and filters, automatic fixes and their re-review, take-over and release, budget checkpoint and resume, stacks, two daemons as one personal reviewer, a released claim waking the other device, reviews in the repository's language, the daemon staying up with no client | Live, in a private test repository, with a Claude model through Claude Code (2026-10-30) |
| GitLab CE 19.5.3 and Gitea 28.2.0: the watch, one post per head with an inline comment and a claim, a reader's command refused, a writer's `@mendcode fix` pushed and answered | Live against local instances, with scripted review children (no model) |
| GitLab and Gitea: a reply inside a diff thread, thread resolution, a push to a fork; Forgejo itself | Adapter-level live checks and contract tests only |
| Claim renewal after an hour | Tests only (every live job finished in under 10 minutes) |
| A watch surviving a sleep without network; transient job retries | Tests only |
| The open-PR backlog, enforced capabilities, forge logins, `requested` area routing, the kept `@mendcode review` request, turn stalls and diffs in parts, `template.language: auto`, the `pr_review` tool, `review_config setup` | Tests only (added after the live runs) |
| The hosted workflow with the platform's changes | Tests only |
