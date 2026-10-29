# Dream

`memory dream daemon` and `memory dream service …` control the same [user daemon service](automation.md#user-daemon-service-b68)
as loops. Installing it does not enable Dream; `dreamAt` remains off until configured. `daemon --once` previews a tick,
and `--once --execute` dispatches the existing scheduler window without repeating a handled day.

The [memory control plane](automation.md#memory-control-plane) adds synchronous `memory dream status|tick|run|consolidate`. Run/consolidate default to deterministic auto-consolidation for v1 CLI parity; `--preview` only records decisions over Pending and `--auto` resolves them. The report retains at most 50 decisions: duplicates are archived, and approval requires confidence ≥ .9, durability ≥ .85, change risk ≤ .2, a low sensitivity and an allowed category (commands, stack, constraints or conventions). Control proposals, redacted text and revisions of user or pinned facts are archived for explicit review rather than auto-applied. Missing scores use .7/.7/.3. The configured global-compaction cap bounds each pass; remaining Pending is reported.

Semantic consolidation is opt-in: it runs only when the `memoryConsolidator` model role is set (`/model`, row `memoryConsolidator`; unset means the deterministic pass above, and there is no fallback to other roles). Then the pass sends redacted, bounded batches of 24 pending proposals plus up to 64 saved memories as read-only context to that model, tool-free, within the run's token budget (the Dream limit minus what the run already spent; calls and tokens appear in the report's `cleanup` row). The model may recommend per proposal: apply, archive/reject, merge/supersede into a known canonical memory (a saved one, or a proposal that was not itself archived), or keep for review. The host gates stay authoritative: model scores can only lower confidence/durability or raise change risk, an unknown canonical id leaves the proposal pending, and a refused call, provider error or empty reply makes that batch fall back to the gates alone (reported as `fallback`). Decisions record `by: model|host`; the new `kept` outcome means left pending for review. `memory dream run|consolidate --deterministic` skips the model for one run; `memory dream status` shows the consolidator in force. `preview` records what the model would do and changes nothing.

Dream is the background job that reads recent conversations and proposes [memories](memory.md). It never edits files or runs commands. Without configured auto-consolidation, updates and archives of saved memories wait for your review, and new memories follow their category's [policy](memory.md#categories-and-policies).

It runs when you ask (`/dream`, `dream.run`) and, if `dreamAt` is set, once a day for every project with a session updated in the last 24 hours. It yields to foreground work, and a project has at most one run at a time.

## What it reads

Dream does not read whole transcripts. For each of the 12 newest sessions of the project it reads a **digest**:

- the first request and the newest exchange that fits in 3 000 characters (user prompts and final agent answers, never tool output or reasoning);
- the sentences where you corrected the agent or stated a preference or rule, and mentions of test, typecheck or build results (at most 8 of each, 200 characters each).

Secrets are redacted before anything is kept. A digest is cached and reused while its session has not changed (the session's last event number is the same and the digest format is the same); a session that changes gets a new one, and deleting a session deletes its digest. Digests are at most a few KB each.

## Safety report

Every run stores a report (`DreamRun.report`; `dream.list` carries it for the newest five runs, `dream.list` with `runId` returns any run's):

| part | says |
|---|---|
| `read` | the sessions read (title, messages, whether the digest was built or reused, secrets redacted), how many memories the model was shown, characters sent |
| `proposed` | what Dream proposed (new, update, archive), its category and what became of it: `pending`, `saved` or `dropped` |
| `refused` | what the model suggested and Dream did not take, with the reason: duplicates, invalid items, over the limit, unknown or busy memory ids, unsafe text, dropped by policy |
| `redactions` | secrets redacted in the evidence and in proposals (a proposal that had one always waits for review) |
| `model` | calls and input/output tokens; `estimated` when the provider reported none (then characters / 4) |
| `budget` | the limit, the tokens used, and whether the budget stopped the run, with the reason |
| `evolution` | what [Evolution](evolution.md) did, when it is on |
| `failures` | why a step failed |

The report is bounded (at most 12 proposals, 20 refusals, 5 failures) and refused items are redacted too.

## Token budget

`dreamMaxTokens` (1 000 to 2 000 000; default 60 000) caps the tokens of all the model calls of one run. A call is made only if its prompt plus room for an answer still fits; one already made is always kept. A run whose first call does not fit is `skipped`; a run whose later step (Evolution) does not fit finishes `done` without it. Either way the report has `budget.stopped` and says why, and so do the run's notes.

## Schedule and missed windows

`dreamAt` is a local time (`HH:MM`). The daemon remembers the day of the last window it handled and checks at the window and at most every 15 minutes before it, because a timer can be late by hours after the machine sleeps. A window newer than the last handled one runs once:

| `trigger` | when |
|---|---|
| `manual` | you ran it |
| `scheduled` | the window arrived on time (within 5 minutes) |
| `recovered` | the daemon was down or the machine asleep across the window; this is the first check after it |

Several missed days are one recovery, never one per day, and a window already handled is never run again (a restart the same day does nothing). A recovery runs for projects active in the last 24 hours at that moment. Turning the schedule on, or changing its time, never recovers today's window retroactively. A day with no active project is marked handled without any run.

## Settings

| setting | meaning |
|---|---|
| `dreamAt` | daily time; off when unset |
| `dreamMaxTokens` | token cap per run |
| `evolution` | `off` (default), `observe`, `suggest`, `auto-safe` — see [evolution.md](evolution.md) |
| `memoryPolicies` | per category policy — see [memory.md](memory.md#categories-and-policies) |

## Ported from v1, and not

Ported: the per-run safety report (what it read, proposed, refused and why, redactions), session digests with a signal extraction (decisions, corrections, validations), the daily window, redaction and review of unsafe text, approval-first proposals, and category policies.

Left out: v1's window *range* (start and end) and "manual trigger required" after a missed window (v2 recovers instead), v1's files per run (v2 keeps one bounded row per run, 50 per project), and graph proposals. v1's consolidator also fell back to the dream/extractor/small roles and could rewrite or retarget proposals (`update`/`remove`/`add`); v2 uses only an explicitly set `memoryConsolidator`, and rewrites stay Dream revisions that wait for review. The deterministic pass uses score gates and lexical duplicate checks.
