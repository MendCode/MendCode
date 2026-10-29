# Evolution

Evolution learns from how you work: corrections and preferences that **recur across sessions** become [memory](memory.md) proposals or skill and instruction suggestions. It runs inside the [Dream](dream.md) job (no timer of its own) and is off by default.

`evolution` setting:

| mode | does |
|---|---|
| `off` (default) | nothing: nothing is recorded, no model is called |
| `observe` | notes which corrections and preferences recur. Keeps **no text** (only a fingerprint per idea) and calls no model |
| `suggest` | also keeps the text of what recurs, and asks the model to turn it into memory proposals (always **to review**, whatever the category policy says) and skill or instruction suggestions |
| `auto-safe` | like `suggest`, but memory proposals follow their category [policy](memory.md#categories-and-policies): `auto` ones are saved, `review` ones wait, `never` ones are dropped |

`auto-safe` never applies anything but a memory: skills and instructions always wait for you, and Evolution never touches code or configuration.

## What it sees

It reads the corrections and preferences in the session digests of a Dream run (for example *"Actually use pnpm instead of npm"*, *"Always answer in Spanish"*). Each becomes a **fingerprint**, the sorted content words of the sentence without the marker words, so *"Don't use npm, use pnpm"* and *"Use pnpm instead of npm"* count as one idea. An idea **recurs** when it appears in at least two different sessions of the project. Evidence is kept 30 days, at most 500 rows per project, and goes with its session when the session is deleted. Text that may contain a secret or credential is never kept.

## What it proposes

In `suggest` and `auto-safe`, one extra model call (inside the Dream run's token budget) gets the recurring ideas and what is already remembered, and answers with at most 5 candidates:

| kind | becomes |
|---|---|
| `memory` | a project memory of at most 500 characters, with a category (see the policy rules above) |
| `skill` | a suggestion: name, description and a Markdown body |
| `instruction` | a suggestion: text for the project's instructions file |
| `workflow` (opt-in) | a v2 JSON plan with read-only agent tasks and an independent completion audit |

Every candidate is checked and refused (with the reason in the run's report) when it is malformed, cites evidence it was not shown, may contain a secret, repeats a memory, has a name that is not `lowercase-hyphen`, or a skill body that carries frontmatter. A suggestion that already exists (pending or accepted) is not filed again, and at most 100 wait per project. The ledger retains at most 200 candidates per project and never evicts an active promotion receipt.

## Suggestions

| command | does |
|---|---|
| `evolution.list` (`directory`, optional `status`) | `{ mode, suggestions, observed }`: the mode, the last 50 suggestions (newest first) and what Evolution has seen there (`corrections`, `preferences`, `recurring`, counted in distinct ideas) |
| `evolution.resolve` (`suggestionId`, `decision`) | `accept` or `reject`. Accepting a `skill` writes `.mendcode/skills/<name>/SKILL.md` in its project and replies with its `path`; an `instruction` is only marked accepted (its text is in the suggestion) |
| `evolution.promote` (`suggestionId`, `expectedHash`, `policyRevision`) | Publishes a reviewed skill or workflow; returns `{ suggestion, path }` with a durable receipt |
| `evolution.rollback` (`suggestionId`, `expectedHash`, `expectedRevision`) | Retires the exact promoted artifact, increments its receipt revision and marks the candidate `rolled_back` |

In `/memory`, `7` opens Evolution. `↑↓` selects a candidate, `pgup/pgdn` scrolls its full content and receipt, `a` promotes (or accepts instruction text), `x` rejects, `r` rolls back, `←→` changes mode and `o` toggles `evolutionWorkflows` (off by default). Keys stay in the page header. Below 70 columns the panel grid becomes one column.

Workflow candidates require `evolutionWorkflows: true` and `suggest` or `auto-safe`. They use v2's plan schema: every task is `agent` with `mode: read`, `permission: ask`, and an inline `contract` with `audit: independent` and no host checks. Promotion writes a new `.mendcode/workflows/evo-<name-prefix>-<id>.json` for the existing workflow loader; it never starts a run. Global/user definitions, code, configuration and instruction files are not promotion destinations.

Each candidate has a SHA-256 review hash and a policy revision. Changing mode or workflow consent invalidates older candidates, even after switching off and on again. `evolution.list` includes the current `workflows` switch and `policyRevision` when enabled or candidates exist. `evolution.resolve` also accepts an optional `expectedHash`; accepting skills/workflows follows the same promotion guards. Neither promotion nor rollback is available to read-only remote tokens.

A write-ahead receipt records destination, exact artifact hash, revision and activation time before publication. A failed/interrupted publication stays `blocked` with its receipt. Rollback remains available after Evolution is off, refuses changed files or symlinks, and moves intact artifacts into `<data dir>/evolution/retired/<id>-<hash-prefix>/` instead of deleting them. It recovers interruptions before publication or after retirement; manually changed or partially written artifacts require manual review. Already running workflows keep their frozen plans.

Writing a skill never overwrites a file, and is refused when the project folder is gone or when `.mendcode`, `skills` or the skill's folder is a symlink or not a folder. A refused write leaves the suggestion pending.

The run's report has an `evolution` part: mode, what was observed, what was suggested (memories, skills, instructions and opt-in workflows), how many memories were saved directly, and a note when no model call was made (nothing recurs yet, observe mode, budget used up).

## Ported from v1, and not

Ported: the four modes and their semantics (observe keeps no text and calls no model; suggest proposes; auto-safe applies only what a deterministic rule allows), recurring corrections as the evidence, conservative rejection of sensitive text, bounded evidence and candidate capacity, validation of every candidate, accepting a skill as an explicit action that never overwrites.

Ported additionally: opt-in workflow candidates, explicit promotion, persistent review/policy hashes, write-ahead revision receipts and guarded rollback of skills/workflows.

Left out: v1's other evidence sources (tool results, test results), per-project consent files and the `remoteProcessing` switch (the model call uses the Dream role's model), and a separate daily Evolution schedule (it runs with Dream).
