# Advisor

Use an advisor as a second model that reads a summary and returns a verdict while a cheaper or faster model does the work. It is off until you pick the advisor model.

Run `/advisor` to check the model and whether it applies to your session.

The main model consults it before a plan is followed, when the same thing keeps failing, and before a turn that edited files ends.

It applies to native sessions with any catalog model, including a ChatGPT subscription model or an API provider's model. The executor and advisor can come from different families; Claude Code sessions get Claude Code's own advisor (`--advisor`) instead.

## Turning it on

| input | does |
|---|---|
| `/advisor` | status: the model, whether it applies (and why not), the checkpoints, this session's consultations and tokens, and which account they draw on |
| `/advisor <model>` | sets the `advisor` model role, e.g. `/advisor gpt-6.1-sol` |
| `/advisor <model>#<effort>` | with an effort, e.g. `/advisor gpt-6.1-sol#high` |
| `/advisor off` | removes the role; nothing is consulted |

### Choose a model

1. Pick the model you trust more for judgment. It must differ from the main model in model or effort; MendCode does not rank intelligence or require a "more capable" model.
2. Set it with `/advisor <model>` or `/advisor <model>#<effort>`.
3. Check `/advisor` for status and the account consultations draw on.

The role is the `advisor` entry of `models` in settings. It works per profile and per project like any other role, and the `/model` page lists it.

**Note:** Unlike other auxiliary roles, it has **no fallback**. Without its own setting there is no advisor, never "same as main".

### Tier and feature limits

- Balanced and full permit the `advisor` feature; nothing happens until the role is set.
- Minimalist never offers it.
- `features.advisor: false` turns it off whatever the role says.

## When it is consulted

The main agent has an `advisor` tool and calls it when it decides to (its description asks for exactly the three moments below). On top of that, the engine consults it itself at three checkpoints. These need no model to decide: they are comparisons the engine already makes.

| checkpoint | when | what happens with the verdict |
|---|---|---|
| `plan` | `plan_submit` / `plan_review`, before you see the plan | `revise` or `stop` sends the plan back to the agent with the findings; it revises and submits again, and the second submission reaches you. `proceed` shows you the plan with the advice attached to the agent's result |
| `repeat_error` | the second time a tool call fails with the same arguments and the same first error line | the verdict joins the history as an `advisor` call, so the next step sees it |
| `completion` | the agent answers without tool calls, the turn's edits touched at least 2 files or changed at least 20 lines, and no consultation happened after the last edit | `revise` or `stop` gives the agent exactly one more step to address it (or to stop and tell you); `proceed` ends the turn as usual |

### Small edits

A trivial turn (one file, fewer than 20 changed lines: a config value, a one-line fix) ends without the `completion` sign-off. This avoids waiting after the answer for a change you can read at a glance.

The agent can still call the advisor itself; `plan` and `repeat_error` are unaffected.

Lines are counted from the edits themselves, summed over the turn: each replacement's larger side, a write's content, or a patch's `+`/`-` lines.

### Who gets advice

Each checkpoint runs at most once per turn. Only the main agent is advised.

Sub-agents never get the tool or checkpoints, on any engine. A child on another engine is not lent it, and Claude Code's own sub-agents are refused it.

A scripted run's tool allow-list and an agent's tool list apply as to any other tool. Permission rules can deny `advisor`.

Checkpoint calls appear in the transcript as ordinary `advisor` tool rows (marked as made by the engine), so you see every consultation and its verdict. While one runs, the working row reads "Consulting advisor...".
## What the advisor sees

The advisor sees a brief, not the whole conversation. It is bounded by `maxBriefTokens` (24,000 by default, 4 characters each) and contains:

- The checkpoint and question.
- Your latest request in full and the plan.
- The working tree's `git diff HEAD` (bounded).
- As much of the current turn's transcript as fits.
- The files this turn edited and checks it ran (tests, typecheck, lint, build), listed apart from earlier turns'.

The turn starts at your last message. An image a tool read during the turn does not count as your request; images attached to your request go with it when the advisor model accepts images.

Secrets are redacted before the brief leaves the process. The advisor has no tools.

### Verdict and failures

It answers JSON:

| Field | Content |
|---|---|
| `verdict` | `proceed`, `revise` or `stop` |
| `summary` | short summary |
| `findings` | up to 8 findings: claim, evidence, severity |
| `next` | up to 6 steps |
| `example` | a short code snippet or ASCII sketch, when it shows the change better than words |

An answer that cannot be read becomes a neutral `proceed` with the text as its summary.

A timeout (60 s), provider error or refused budget is reported in the tool row. The turn continues without advice; the advisor never fails a turn.

## Usage and limits

Run `/advisor` to see which account consultations draw on.

| Advisor model | Account |
|---|---|
| ChatGPT model | your ChatGPT subscription quota |
| Provider's model | your API key |
| Claude Code's advisor | your Claude subscription |

Each consultation is a usage event under the advisor's model, so `/usage` counts it with the session. The budget guard runs before every consultation.

| setting (`advisor` in settings) | default | range |
|---|---|---|
| `checkpoints` | `["plan", "repeat_error", "completion"]` | any subset; empty leaves only the agent's own calls |
| `maxCallsPerTurn` | 3 | 1–10 |
| `maxCallsPerSession` | 20 | 1–200 |
| `maxBriefTokens` | 24000 | 4000–100000 |

Over a cap, the agent's own call is refused with the reason and checkpoints are skipped silently. Session counts restart with the daemon.

## Engines

| session runs on | advisor |
|---|---|
| native | the `advisor` tool and checkpoints, with any native catalog model as advisor |
| Claude Code | a Claude Code model as advisor is passed as `--advisor <alias>`; Claude Code decides when to consult it and refuses an advisor less capable than the main model |
| Codex, pi, ACP | not applied; `/advisor` and the AI config page say so |

An API or ChatGPT model cannot advise a Claude Code session. `/advisor` shows "not applied" with that reason instead of saving a setting that is silently ignored. The status reflects the project's main model; a session switched to another model is checked again when it runs.

### Claude as the advisor of a native session

A Claude Code model (`/advisor claude-opus#high`) can advise a native session on your Claude subscription. Each consultation is one headless `claude -p` run.

- The bounded, redacted brief goes on stdin; the answer is read from Claude Code's JSON result.
- The call has no tools, saves no session and runs no hooks.
- It loads no `CLAUDE.md` or auto memory: it starts in the daemon's empty probe folder, never in your project.

It finds `claude` the way the Claude Code engine does: `MENDCODE_CLAUDE_BIN`, else `claude` on `PATH`. It uses Claude Code's own login; MendCode reads no credential.

#### Child environment and failures

The child uses the daemon's own environment, without:

- A Claude Code shell's session variables: the launcher drops `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_ENTRYPOINT`…
- `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL`, which would move the run off the Claude login onto an API key or another endpoint.

A missing or signed-out `claude`, an error answer, a bad exit and the timeout (90 s, then the process is killed) become the same neutral verdict as any failed consultation. The turn goes on.

#### Usage accounting

The tokens `claude` reports return as a usage event of the turn under the advisor's model with provider `claude`. `/usage` counts them with the session once; the tool row names the account ("Claude subscription").

They are not also recorded as an [auxiliary call](usage.md#auxiliary-calls). A consultation is part of a turn; recording it in both places would count it twice.

## How it differs from

- **Claude Code's advisor**: that one is Anthropic-only, reads the full conversation, and is consulted only when the model decides. This one takes any provider, reads a bounded brief, adds the engine's checkpoints, and answers a verdict the engine acts on.
- **`/compound critic`** ([compound.md](compound.md)): a separate, explicit run in a detached worktree with deterministic checks. The advisor works inside your normal session.
- **Adaptive reasoning** ([reasoning.md](reasoning.md)): chooses how hard the main model thinks; it does not give a second opinion.

## Measured on the evaluation kit

`bun .agents/evals/harness/run.ts --harness mendcode --advisor gpt-6.1-sol#high …` sets the advisor role for a run ([the kit](../.agents/evals/harness/README.md)).

Evaluation date: 2026-11-01. It used one run per task, balanced tier, ChatGPT subscription and main effort `medium`. Its six tasks were bug-async-race, bug-boundary, false-cause-rounding, feat-lru-ttl, refuse-weaken-test and rootcause-logs.

**Note:** One run per cell is a sample, not a distribution. The differences below are within what a repeat could change.

| arm | solved | input tokens (cached) | output tokens | agent time | advisor consultations |
|---|---|---|---|---|---|
| gpt-6-luna alone | 5/6 (bug-boundary failed its hidden check) | 249,025 (190,336) | 6,363 | 128 s | 0 |
| gpt-6-luna + advisor gpt-6.1-sol#high | 6/6 | 363,388 (264,064) | 10,988 | 246 s | 7 (6 `completion`, 1 by the model's own call; no `plan` or `repeat_error`) |
| gpt-6.1-sol alone | 6/6 | 303,073 (228,736) | 10,283 | 245 s | 0 |

The advisor arm's totals include the advisor model's own tokens: 29,353 in and 2,542 out over the 7 consultations. Every task of the advisor arm was consulted at least once (the completion sign-off after an edit).
