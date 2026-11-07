Evolution turns corrections and preferences that **recur across sessions** into [memory](memory.md) proposals or skill and instruction suggestions. It runs inside the [Dream](dream.md) job, has no timer of its own and is off by default.

## Evolution

Choose a mode with the `evolution` setting:

| mode | does |
|---|---|
| `off` (default) | nothing: nothing is recorded, no model is called |
| `observe` | notes which corrections and preferences recur. Keeps **no text** (only a fingerprint per idea) and calls no model |
| `suggest` | also keeps the text of what recurs, and asks the model to turn it into memory proposals (always **to review**, whatever the category policy says) and skill or instruction suggestions |
| `auto-safe` | like `suggest`, but memory proposals follow their category [policy](memory.md#categories-and-policies): `auto` ones are saved, `review` ones wait, `never` ones are dropped |

`auto-safe` never applies anything but a memory: skills and instructions always wait for you, and Evolution never touches code or configuration.

## What it sees

Evolution reads corrections and preferences in the session digests of a Dream run, for example *"Actually use pnpm instead of npm"* and *"Always answer in Spanish"*.

Each becomes a **fingerprint**: the sentence's sorted content words without the marker words. That makes *"Don't use npm, use pnpm"* and *"Use pnpm instead of npm"* count as one idea.

An idea **recurs** when it appears in at least two different sessions of the project.

| Evidence rule | Limit |
| --- | --- |
| Retention | 30 days |
| Capacity | At most 500 rows per project |
| Session deletion | Its evidence is deleted with it |
| Sensitive text | Text that may contain a secret or credential is never kept |

## What it proposes

In `suggest` and `auto-safe`, one extra model call (inside the Dream run's token budget) gets the recurring ideas and what is already remembered, and answers with at most 5 candidates:

| kind | becomes |
|---|---|
| `memory` | a project memory of at most 500 characters, with a category (see the policy rules above) |
| `skill` | a suggestion: name, description and a Markdown body |
| `instruction` | a suggestion: text for the project's instructions file |
| `workflow` (opt-in) | a v2 JSON plan with read-only agent tasks and an independent completion audit |

Every candidate is checked. A refusal includes its reason in the run's report.

A candidate is refused when it:

- Is malformed.
- Cites evidence it was not shown.
- May contain a secret.
- Repeats a memory.
- Has a name that is not `lowercase-hyphen`.
- Has a skill body that carries frontmatter.

A suggestion that already exists (pending or accepted) is not filed again.

| Candidate storage | Limit |
| --- | --- |
| Waiting suggestions | At most 100 per project |
| Ledger | At most 200 candidates per project; never evicts an active promotion receipt |

## Suggestions

| command | does |
|---|---|
| `evolution.list` (`directory`, optional `status`) | `{ mode, suggestions, observed }`: the mode, the last 50 suggestions (newest first) and what Evolution has seen there (`corrections`, `preferences`, `recurring`, counted in distinct ideas) |
| `evolution.resolve` (`suggestionId`, `decision`) | `accept` or `reject`. Accepting a `skill` writes `.mendcode/skills/<name>/SKILL.md` in its project and replies with its `path`; an `instruction` is only marked accepted (its text is in the suggestion) |
| `evolution.promote` (`suggestionId`, `expectedHash`, `policyRevision`) | Publishes a reviewed skill or workflow; returns `{ suggestion, path }` with a durable receipt |
| `evolution.rollback` (`suggestionId`, `expectedHash`, `expectedRevision`) | Retires the exact promoted artifact, increments its receipt revision and marks the candidate `rolled_back` |

### Review a suggestion

1. Open `/memory` and press `7` to open Evolution.
2. Select a candidate with `↑↓` and read its full content and receipt with `pgup/pgdn`.
3. Promote, accept or reject it with the keys below.

| Key | Does |
| --- | --- |
| `a` | Promote, or accept instruction text |
| `x` | Reject |
| `r` | Roll back |
| `←→` | Change mode |
| `o` | Toggle `evolutionWorkflows` (off by default) |

Keys stay in the page header. Below 70 columns the panel grid becomes one column.

### Workflow candidates

Workflow candidates require `evolutionWorkflows: true` and `suggest` or `auto-safe`. They use v2's plan schema:

| Task field | Requirement |
| --- | --- |
| Task | Every task is `agent` |
| Mode | `mode: read` |
| Permission | `permission: ask` |
| Contract | Inline `contract` with `audit: independent` and no host checks |

Promotion writes a new `.mendcode/workflows/evo-<name-prefix>-<id>.json` for the existing workflow loader; it never starts a run.

Global/user definitions, code, configuration and instruction files are not promotion destinations.

### Review guards

Each candidate has a SHA-256 review hash and a policy revision. Changing mode or workflow consent invalidates older candidates, even after switching off and on again.

`evolution.list` includes the current `workflows` switch and `policyRevision` when enabled or candidates exist.

`evolution.resolve` also accepts an optional `expectedHash`; accepting skills/workflows follows the same promotion guards. Neither promotion nor rollback is available to read-only remote tokens.

Writing a skill never overwrites a file. A write is refused when:

- The project folder is gone.
- `.mendcode`, `skills` or the skill's folder is a symlink or not a folder.

A refused write leaves the suggestion pending.

### Receipts and rollback

A write-ahead receipt records destination, exact artifact hash, revision and activation time before publication. A failed/interrupted publication stays `blocked` with its receipt.

Rollback remains available after Evolution is off. It refuses changed files or symlinks, and moves intact artifacts into `<data dir>/evolution/retired/<id>-<hash-prefix>/` instead of deleting them.

It recovers interruptions before publication or after retirement. Manually changed or partially written artifacts require manual review. Already running workflows keep their frozen plans.

### Run report

The run's report has an `evolution` part with:

- Mode and what was observed.
- What was suggested: memories, skills, instructions and opt-in workflows.
- How many memories were saved directly.
- A note when no model call was made: nothing recurs yet, observe mode or budget used up.

## Ported from v1, and not

### Ported behavior

- The four modes and their semantics: observe keeps no text and calls no model; suggest proposes; auto-safe applies only what a deterministic rule allows.
- Recurring corrections as the evidence.
- Conservative rejection of sensitive text.
- Bounded evidence and candidate capacity.
- Validation of every candidate.
- Accepting a skill as an explicit action that never overwrites.

Also ported:

- Opt-in workflow candidates and explicit promotion.
- Persistent review/policy hashes.
- Write-ahead revision receipts and guarded rollback of skills/workflows.

### Left out

| v1 feature | Current behavior |
| --- | --- |
| Other evidence sources | Tool results and test results are left out |
| Per-project consent files and `remoteProcessing` switch | Left out; the model call uses the Dream role's model |
| Separate daily Evolution schedule | Left out; Evolution runs with Dream |
