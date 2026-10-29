# Loops

A loop is recurring or long-running agent work: an objective, a trigger (when it wakes), a budget (how it finishes) and a root session. Each wakeup is a **run**: a normal message in a session, so the session actor keeps its queue, cancel and approvals. The CLI side (`mendcode loop …`) is in [automation.md](automation.md); this page is the model and the daemon commands.

`loops daemon` and `loops service …` control the shared [user daemon service](automation.md#user-daemon-service-b68).
There is no competing service per repository; persisted loop triggers remain authoritative.

## Triggers

| trigger | wakes |
|---|---|
| `manual` | never by itself (`loop.control run`) |
| `interval` `{ everyMs }` | every `everyMs` (1 min to 30 days) after the last run ended |
| `daily` `{ at, timezone? }` | every day at wall-clock `HH:MM` in `timezone` (an IANA name like `Europe/Madrid`; local time when absent). A missed window is not caught up |
| `adaptive` `{ everyMs, minMs?, maxMs? }` | like `interval`, but the pace follows the runs (below) |
| `external` | never by itself; fired from outside with `loop.fire` (cron, CI, a script) |

Text form (`parseTrigger`): `every 30m`, `daily 09:00`, `daily 09:00 Europe/Madrid`, `adaptive 30m`, `adaptive 30m 5m..4h`, `external`, `manual`.

### Daily and time zones

With a `timezone` the next run is computed on that zone's calendar, so a day is 23 hours long when clocks go forward and 25 when they go back. A time that does not exist (02:30 on the spring-forward day in Madrid) runs at the same offset shifted past the gap (03:30); a time that happens twice (02:30 when clocks go back) runs the first time. Without `timezone` the machine's local clock is used, as before.

### Adaptive

An adaptive loop starts at `everyMs`. After each run its interval **doubles** (up to `maxMs`) when the run found nothing and **halves** (down to `minMs`) when it acted; a run that reports no activity, or that failed, keeps the pace. The run says which in its checkpoint: the prompt of an adaptive loop asks for `activity: idle | acted`. Bounds default to a quarter and eight times `everyMs` (at least one minute, at most 30 days) and must satisfy `minMs <= everyMs <= maxMs`. The current pace is `Loop.adaptiveMs`.

### External

`loop.fire { loopId, note? }` starts a run now. `note` (what happened: a CI URL, an alert) is shown to the run, and the run is recorded with `trigger: "external"`. While a run is in progress a fire waits (several count once, the last note wins) and the next run starts as soon as the loop is free. Only `external` loops accept a fire, and only while active; paused, blocked, stopped or finished loops refuse it (`busy`).

```bash
# from cron or CI (apps/cli):
mendcode loop fire <id>
```

## Templates

`loop.create { template }` fills whatever you leave out; what you give wins. `loop.templates` lists them. Ported from v1, with a trigger and budget added:

| id | objective | trigger | budget | mode |
|---|---|---|---|---|
| `pr-watch` | watch a PR until checks and review are resolved; ask before push/merge (every wake is a model turn; for a zero-token watch that wakes only on a change see [pr-watch](pr-watch.md)) | adaptive 15m (5m..2h) | goal (cap 100), done when "PR merged" | edits |
| `ci-repair` | investigate failing CI, focused fixes, narrow validation | every 10m | goal (cap 50), done when "all targeted checks pass" | edits |
| `research-digest` | research a topic from primary sources, keep a journal | adaptive 1h (30m..24h) | monitor | report-only |
| `repo-maintenance` | focused hygiene, no broad refactors | every 30m | monitor | edits |

v1's *gates* and *stop conditions* become `Rules:` and `Stop and report when:` lists in the objective, so every run reads them. An `objective` given with a template is added as `Specifically: …`.

## Report-only

`reportOnly` loops report but never change anything. Their sessions start in **plan mode** (the same mechanism as the independent auditor): write and execute tools are refused by the engine whatever the default permission is, and the run prompt says so. A report-only loop cannot use a worktree (it never edits).

## Worktree lease

`workspace: "worktree"` gives each run its own git worktree so it never collides with your edits:

1. The run gets a fresh session in a worktree under `<data dir>/loop-worktrees/<loopId>-r<n>` on branch `loop/<name>-<loopId>-r<n>`, cut from the current `HEAD`. Goal and fixed loops cut it from the branch the previous run kept, so iterating toward a goal continues; monitors start from `HEAD` every time.
2. A goal run that claims completion is verified (checks, audit) inside its worktree, because that is where the work is.
3. When the run (and its verification) ends, the lease ends: anything left uncommitted is committed to the branch, then a run that changed nothing leaves **no trace** (worktree and branch deleted); otherwise only the directory is deleted and the **branch stays** for you to review or merge (`LoopRun.worktree.state: "retained"`, with the commit count in `detail`).
4. If the worktree cannot be made (not a git checkout, no commit yet), the run fails with `worktree unavailable: …`; it never falls back to your checkout. After a daemon restart, a lease held by a dead run ends the same way.

Edits made in a worktree session do not see project memories or profile of the original directory (they are keyed by directory).

## The `loop` tool

The agent can `create`, `list` and `pause` loops of its session's project (permission `write`: it asks in `ask` and `smart` mode, like `tell`, and runs without asking in `edits` and `full`). Loops the agent creates are report-only unless it sets `reportOnly: false`. The approval shows the schedule, budget and what a run may do, or the problems found. Resume, stop, delete and accept stay with you. Sub-agents do not get the tool.

## Commands

| command | does |
|---|---|
| `loop.create` | `template`, `reportOnly`, `workspace`, triggers above; `objective`/`trigger`/`budget` optional with a template |
| `loop.update` | `{ loopId, name?, objective?, criteria?, trigger?, budget?, checks?, audit?, template?, reportOnly?, workspace?, runNow? }`: partial edit; keeps id, directory, root session, history and state, bumps `updatedAt`, recomputes the next wake for active loops and emits `loop.changed`. An explicit template supplies defaults like create. `criteria: ""`, `checks: []`, `reportOnly: false` and `workspace: "in-place"` clear those options. `runNow` only advances an active loop; disabled loops stay disabled. Running, waiting-input and verifying loops refuse edits with `busy`; retry after the run |
| `loop.templates` | `{ templates: [{ id, name, description, summary }] }` |
| `loop.fire` | `{ loopId, note? }` → `{ loop, queued }` |
| `loop.list`, `loop.control` | as before |
| `loop.draft` | `{ directory, name?, objective?, template?, trigger?, budget?, reportOnly? }`: paused draft, no wake or provider call. Without a template, name/objective are required; defaults are manual/monitor |
| `loop.activate` | `{ loopId, reason? }`: enable a draft on the integrated scheduler; interval/adaptive wake immediately. Idempotent for non-drafts; resume uses the existing control command |
| `loop.snapshot` | `{ loopId }` → `{ loop, children, events, scheduler }`; last 50 journal events and child tasks |
| `loop.events` | `{ loopId, limit?, before?, run? }` → `{ events, ledger }`: last 1–200 journal events (default 50), chronological, plus a ledger page capped at 100 entries. `before` and `run` filter the ledger |
| `loop.tick` | `{ directory, loopId?, limit?, execute?, reportOnly? }` → `{ results }`. Immutable dry-run by default; executing waits for the checkpoint or input state, up to 15 minutes |

Existing loop records stay valid: every new field is optional.

New lifecycle changes persist a journal bounded to 200 events with increasing sequence numbers. Drafts use `state: "paused"` plus the optional `draft` marker, so existing clients still recognize their disabled state. Snapshots and journal reads redact secret-bearing historical text; all new B20 commands require full-access peers. Typed client helpers are `loopSnapshot` and `loopEvents`. The CLI spellings and monitor behavior are documented in [automation.md](automation.md).

## v1 comparison

Ported: adaptive triggers (v1 had the mode but no pacing; the backoff here is new), external fire (v1: `POST /loop/signal`; here a daemon command, no HTTP and no dedupe key), time zones for daily triggers, the four templates, report-only, per-run worktree leases (v1 `per-run-worktree`, with its retain/clean semantics simplified to commit-and-keep-the-branch), `maxRuns` as a safety cap.

Left out: v1's OS service for waking loops while the app is closed (the daemon wakes loops while it runs), `per-loop-worktree` (one worktree for the whole loop; goal loops chain branches instead), `validationCommands`, signal rate limits and queueing by source, `update_agent` and the v1 HTTP override endpoint (v2 uses the additive `loop.review` command).

## The /loops page

`/loops` (terminal UI) lists this project's loops with the state, the trigger and the next wake. Keys: `↑↓` select, `enter` open, `tab` scope, `1`/`2` tabs, `p` pause or resume, `n` run now, `a` accept, `s` stop, `d` delete, `esc` back.

- **`c` new loop** opens a form: name, objective, trigger (`←→`: manual, interval, daily, adaptive, external), the fields that trigger needs, budget (monitor, goal, fixed), report-only, worktree lease, run now. Interval, `min` and `max` take a span such as `30m`, `2h` or `1d`; daily takes `HH:MM` and an optional IANA time zone. `enter` moves to the next row and saves on the last one; the line under the form shows what will be sent, or what is missing.
- **`t` new from a template** starts the same form on a template (the daemon's `loop.templates`, else the four in this document). Rows left as `template` are not sent, so the template's trigger, budget and report-only apply; set a row to override it. The objective you type becomes the template's "Specifically" line.
- **`e` edit** prefills the form from the selected loop. Saving sends `loop.update` and preserves its id, session, history and enabled state. Checks and audit settings are carried over.
- **Report-only and worktree** are checkboxes and exclude each other: a report-only run edits nothing, so it has no worktree.
- **Adaptive** loops show the interval they are on now against their bounds (`now every 1h`, `slowest`, `fastest`), and every loop shows its last run: outcome, activity, age, run number and whether it came from the schedule or an external fire.
- **External** loops show `mendcode loop fire <id>` with their id. `y` copies it, `f` fires the loop from the page. From a shell, `mendcode loop fire <id> [--note <text>]` sends `loop.fire` and prints `started` or `queued`.


## Usage caps, runtime rubric and gate review (B44)

These are opt-in: existing loops have no token/USD cap, rubric or additional action policy. Older unrecorded runs remain unknown when caps are added. The new form rows and `loop.create` / `loop.update` accept:

- `costBudget: { maxTokens?, maxCost?, unknownCost?: "block" | "allow" }`. `maxCost` is API USD, not subscription quota. Usage sums input, output, reasoning and cache tokens from the worker **and** its independent auditors, and persists on the loop and each run. At a cap the current turn is cancelled and the loop blocks before another run. One in-flight model call may overshoot a cap before its usage arrives. A missing price blocks a USD cap unless `unknownCost: "allow"`; a turn without reported tokens blocks a token cap. Prices and missing usage are never guessed as zero. `costBudget: {}` disables caps without clearing consumption.
- `rubric: { name?, passThreshold?, criteria: [{ id, description, weight?, minScore?, evidenceRequired? }], mandatoryBlockers? }` for goal loops. The form accepts this JSON; the agent's `loop` tool also accepts the typed object, with the normal create approval. Defaults: threshold `0.85`, weight `1`, score `0` or `5`, minimum `0`. Like v1, the weighted threshold **and every criterion** must pass. Runtime evidence requirements include `checkpoint evidence`, `success checks`, `validation output`, `policy gate status`, `independent audit`, `gate:<id>`, or a text match in recorded evidence. The checkpoint's optional `evidence` row is a JSON array of concrete references; host checks preserve bounded output for rubric evaluation. Results retain score, reasons, missing evidence and mandatory blockers. `rubric: { criteria: [] }` disables it.
- `approvalPolicy: { requireApprovalFor: ["push", "merge", "deploy", "publish", "delete"] }`. A checkpoint reporting one of these actions blocks completion until the user records approval. This supplements the actor's existing **before-action** tool permissions; a reported action never authorizes execution. An empty list disables it.

`/loop now --goal --max-tokens 50000 --max-cost 2 --require-approval push,deploy <objective>` sets caps and policy; `--unknown-cost allow` is an explicit opt-in under a USD cap. The agent cannot review, accept or approve gates.

The page fills a bordered panel grid, with Budget and Gates / Rubric panels. Under 70 columns it uses one scrollable column. `pgup` / `pgdn` scroll details and evidence; `w` prefills a waiver of the first failed quality gate, `o` prefills an action approval, and `a` prefills completion acceptance. Add a reason before submitting. Hints stay in the header.

The client sends `loop.review { loopId, action: "waive" | "accept" | "approve", run, checkpointHash, reviewer, reason, gateId?, approvalAction? }` using the latest finished run/hash. `/loop waive <id> "<gate id>" <reason>`, `/loop approve <id> <action> <reason>` and `/loop accept <id> <reason>` use that evidence after opening `/loops`. A stale hash/run or blank reviewer/reason is refused. Each reviewed gate records actor, reason, time and checkpoint hash. Approving a policy gate re-runs verification before completion. A waiver stays blocked until explicit acceptance or resume, so review alone never schedules more spending.

Budget/policy gates, missing inspections, changed audit workspaces and mandatory rubric blockers cannot be waived or accepted. Acceptance requires a completion proposal and a failed quality gate or prior waiver. The legacy reason-only `loop.control accept` remains available for unconfigured loops; it cannot bypass protected evidence gates. The artifact ledger is described below (B69).

Editing review rules or their evidence inputs invalidates the current claim for configured loops (`reviewInvalidatedAt`). History and reviewer evidence stay intact; a new run is required before reviewing again. A no-op save does not invalidate it.

## Evidence ledger (B69)

`b` on `/loops` opens events, artifacts and completion receipts, with the same keys and export preview as [workflows](workflows.md). `loop.events`, `loop.artifacts`, `loop.receipt`, `loop.export` accept `run`, `before` and `limit` (default 50, maximum 100; receipt default 1), plus `format: json | markdown` for export. Events and artifacts outlive the 20-run projection: the ledger retains 50 wakeups, capped at 512 entries each, protecting the latest evidence per key during trimming. Deleting the loop removes its ledger.

Artifacts record checkpoints/evidence/hash, run memory (the checkpoint summary and next action; no generated global memories), actual token/USD usage including unknown cost, host gates and waivers, independent judgments, rubric, action approvals, worktree retention and user overrides. Receipts are immutable revisions: a worker claim alone, a waived gate, or a manual override is never labelled verified. Old rows seed only the available snapshot (`historical: false`). Pagination/export reports retention truncation and cannot reconstruct discarded history. No background export or external service is enabled.
# On-demand metric experiments

Scheduler text edits preserve the existing due time. Workspace creation rechecks the attempt and revision before dispatch, so an intervening edit/stop/delete cannot submit the old prompt or revive a removed loop. An unused lease is released through the existing lifecycle; cleanup failure is retained for inspection. A queue ACK still records dispatch rather than successful completion.

The optional `mendcode-autoresearch` data package reuses loops, checks, audit, caps and receipts. `acceptExperiment` in `@mendcode/loops` accepts a numeric improvement only with passing unwaived correctness gates, finite metrics, known cost, and iteration/token/cost caps. It does not run a process or edit a checkout. Metric, direction, checks, budget and worktree must be provided explicitly; unknown cost is never zero.

Use `workspace: "in-place"` only in a separately user-authorized isolated checkout for these experiments. Loop-managed `workspace: "worktree"` has its own commit-on-release behavior and is not selected by this package. The package never commits, resets or reverts automatically. Numeric evaluation is a host helper; a dedicated automated measurement tool is not activated by installing the skill.
