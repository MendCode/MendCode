---
summary: recurring work: every N minutes, daily, on an external trigger (loops)
docs: loops, automation, pr-watch
aliases: loop, schedule, recurring, cron, every, interval, repeat, periodic, babysit
---
For: "run this every 10 minutes", "every morning at 9 check X", "keep an eye on CI", "fire it from a script". A loop is recurring or long-running work: an objective, a trigger, a budget and a root session; each wake is a run, a normal message in a session with its own queue and approvals. One standing task in this session is a goal instead ({{program}} docs goals).

Model tool: loop {action: create|list|pause}. It is a write action (asks in ask and smart modes). Inspect existing loops first, and never set an iteration cap to zero. Loops the model creates are report-only (plan mode, nothing is edited) unless it sets reportOnly: false. Resume, stop, delete and accept stay with the user. Sub-agents do not get the tool.

Triggers (text form): manual · every 30m (1 minute to 30 days after the last run ended) · daily 09:00 or daily 09:00 Europe/Madrid (a missed window is not caught up) · adaptive 30m or adaptive 30m 5m..4h (doubles when a run found nothing, halves when it acted) · external (fired from outside: {{program}} loop fire <id> [--note text]).
Budget: monitor (never finishes by itself), goal (done when a stated condition holds, capped runs) or fixed.
Templates fill the rest: pr-watch (adaptive 15m, edits), ci-repair (every 10m), research-digest (adaptive 1h, report-only), repo-maintenance (every 30m).
Worktree: workspace worktree gives each run its own git worktree and branch loop/<name>-<id>-r<n>; a run that changed nothing leaves no trace, otherwise the branch stays for review. A report-only loop cannot use one. If no worktree can be made the run fails; it never falls back to the user's checkout.

The user's page: /loops (alias /loop): c new loop, t from a template, e edit, p pause or resume, n run now, a accept, s stop, d delete, f fire an external loop. From the user's shell (yours may only list and read; use the loop tool): {{program}} loop list [--all] | create [--every 1h|--daily 09:00] [--goal] [--runs N] "objective" | pause|resume|stop|run|delete <id> | fire <id>.

Metric experiments (feature autoresearch, full tier, on demand): the optional mendcode-autoresearch skill package, loaded by name, drives a loop that accepts a numeric improvement only when the correctness gates pass and the iteration, token and cost caps hold ({{program}} docs packages).
Not the same: pr_watch wakes a session with no model call only when a pull request changes ({{program}} docs git); the pr-watch loop template spends a model turn on every wake.

Limits: a paused, blocked or finished loop refuses a fire; edits to a running loop are refused until the run ends. Scheduling, the user daemon service, usage caps and the run ledger: {{program}} docs automation.

Check: the loop tool's list (or /loops) shows state, trigger and next wake. If the next wake is not shown, say it could not be read; do not state a time.
