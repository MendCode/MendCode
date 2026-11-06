# Dream

Dream reads recent conversations and proposes [memories](memory.md). It never edits files or runs commands.

Run `/dream` to ask for a pass, or set `dreamAt` for a daily schedule.

Without configured auto-consolidation, updates and archives of saved memories wait for your review. New memories follow their category's [policy](memory.md#categories-and-policies).

## Run Dream

Dream runs when you ask (`/dream`, `dream.run`). With `dreamAt` set, it also runs once a day for every project with a session updated in the last 24 hours.

It yields to foreground work. A project has at most one run at a time.

### Daemon service and control plane

`memory dream daemon` and `memory dream service …` control the same [user daemon service](automation.md#user-daemon-service-b68) as loops. Installing it does not enable Dream; `dreamAt` remains off until configured.

| Command | Does |
|---|---|
| `daemon --once` | previews a tick |
| `--once --execute` | dispatches the existing scheduler window without repeating a handled day |
| `memory dream status|tick|run|consolidate` | synchronous operations through the [memory control plane](automation.md#memory-control-plane) |

## Consolidate proposals

Run/consolidate default to deterministic auto-consolidation for v1 CLI parity. `--preview` only records decisions over Pending; `--auto` resolves them.

The report retains at most 50 decisions. Duplicates are archived; approval requires confidence ≥ .9, durability ≥ .85, change risk ≤ .2, a low sensitivity and an allowed category (commands, stack, constraints or conventions).

Missing scores use .7/.7/.3. The configured global-compaction cap bounds each pass; remaining Pending is reported.

Control proposals, redacted text and revisions of user or pinned facts are archived for explicit review rather than auto-applied.

### Opt into semantic consolidation

Set the `memoryConsolidator` model role in `/model`, row `memoryConsolidator`. Unset means the deterministic pass above; there is no fallback to other roles.

The pass sends redacted, bounded batches of 24 pending proposals plus up to 64 saved memories as read-only context. The call is tool-free and stays within the run's token budget: the Dream limit minus what the run already spent.

Calls and tokens appear in the report's `cleanup` row. Per proposal, the model may recommend:

- Apply.
- Archive/reject.
- Merge/supersede into a known canonical memory: a saved one, or a proposal that was not itself archived.
- Keep for review.

The host gates stay authoritative:

- Model scores can only lower confidence/durability or raise change risk.
- An unknown canonical id leaves the proposal pending.
- A refused call, provider error or empty reply makes that batch fall back to the gates alone, reported as `fallback`.

Decisions record `by: model|host`; the new `kept` outcome means left pending for review.

| Command or option | Does |
|---|---|
| `memory dream run|consolidate --deterministic` | skips the model for one run |
| `memory dream status` | shows the consolidator in force |
| `preview` | records what the model would do and changes nothing |

## What it reads

Dream does not read whole transcripts. For each of the 12 newest sessions of the project it reads a **digest**:

- the first request and the newest exchange that fits in 3 000 characters (user prompts and final agent answers, never tool output or reasoning);
- the sentences where you corrected the agent or stated a preference or rule, and mentions of test, typecheck or build results (at most 8 of each, 200 characters each).

Secrets are redacted before anything is kept. Digests are at most a few KB each.

A digest is cached and reused while both the session's last event number and the digest format stay the same. A session that changes gets a new digest; deleting a session deletes its digest.

## Model and interruptions

Dream uses the `dream` model role (`/model`). Unset, it falls back to the `small` role and then to `main`, so a cheap `small` model runs the nightly pass without more setup.

### Resume after interruption

A run cut short because the daemon stopped or was killed is closed as `Interrupted` at the next start. It runs again once for its project only while the schedule is on and within 36 hours.

Digests already built are cached, so the second run starts where the first stopped.

After a successful pass, exact duplicates among generated memories are archived when `memoryMaintenance` is `auto-consolidate`.

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

`dreamMaxTokens` (1 000 to 2 000 000; default 60 000) caps the tokens of all model calls in one run.

A call is made only if its prompt plus room for an answer still fits. A call already made is always kept.

| What does not fit | Result |
|---|---|
| First call | the run is `skipped` |
| Later step (Evolution) | the run finishes `done` without it |

Either way, the report has `budget.stopped` and says why; the run's notes say why too.

## Schedule and missed windows

Set `dreamAt` to a local time (`HH:MM`). The daemon remembers the day of the last window it handled.

It checks at the window and at most every 15 minutes before it: a timer can be late by hours after the machine sleeps. A window newer than the last handled one runs once:

| `trigger` | when |
|---|---|
| `manual` | you ran it |
| `scheduled` | the window arrived on time (within 5 minutes) |
| `recovered` | the daemon was down or the machine asleep across the window; this is the first check after it |

### Recovery rules

- Several missed days are one recovery, never one per day.
- A window already handled is never run again; a restart the same day does nothing.
- A recovery runs for projects active in the last 24 hours at that moment.
- Turning the schedule on, or changing its time, never recovers today's window retroactively.
- A day with no active project is marked handled without any run.

## Settings

| setting | meaning |
|---|---|
| `dreamAt` | daily time; off when unset |
| `dreamMaxTokens` | token cap per run |
| `evolution` | `off` (default), `observe`, `suggest`, `auto-safe` — see [evolution.md](evolution.md) |
| `memoryPolicies` | per category policy — see [memory.md](memory.md#categories-and-policies) |

## Ported from v1, and not

### Ported

- Per-run safety report: what it read, proposed, refused and why, and redactions.
- Session digests with signal extraction: decisions, corrections and validations.
- Daily window.
- Redaction and review of unsafe text.
- Approval-first proposals and category policies.

### Left out or changed

| v1 | v2 |
|---|---|
| Window *range* (start and end) | a daily window |
| "manual trigger required" after a missed window | recovers instead |
| Files per run | one bounded row per run, 50 per project |
| Graph proposals | left out |
| Consolidator fallback to dream/extractor/small roles | only an explicitly set `memoryConsolidator` |
| Consolidator could rewrite or retarget proposals (`update`/`remove`/`add`) | rewrites stay Dream revisions that wait for review |

The deterministic pass uses score gates and lexical duplicate checks.
