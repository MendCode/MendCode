# Advisor

The advisor is a second model the session's main model consults at the moments where the quality of the plan decides the result: before a plan is followed, when the same thing keeps failing, and before a turn that edited files ends. A cheaper or faster model does the work; the advisor reads a summary and answers a verdict. It is off until you pick the advisor model.

It applies to native sessions with any model of the catalog (a ChatGPT subscription model, an API provider's model), so the executor and the advisor can come from different families. Claude Code sessions get Claude Code's own advisor (`--advisor`) instead.

## Turning it on

| input | does |
|---|---|
| `/advisor` | status: the model, whether it applies (and why not), the checkpoints, this session's consultations and tokens, and which account they draw on |
| `/advisor <model>` | sets the `advisor` model role, e.g. `/advisor gpt-6.1-sol` |
| `/advisor <model>#<effort>` | with an effort, e.g. `/advisor gpt-6.1-sol#high` |
| `/advisor off` | removes the role; nothing is consulted |

The role is the `advisor` entry of `models` in settings, so it also works per profile and per project like any other role, and the `/model` page lists it. Unlike the other auxiliary roles it has **no fallback**: without its own setting there is no advisor, never "same as main".

The advisor must differ from the main model in model or effort. MendCode does not rank models by intelligence, so it does not require a "more capable" one; pick the one you trust more for judgment.

The `advisor` feature belongs to the balanced and full tiers as a permit: the tier only allows it, and nothing happens until the role is set. Minimalist never offers it. `features.advisor: false` turns it off whatever the role says.

## When it is consulted

The main agent has an `advisor` tool and calls it when it decides to (its description asks for exactly the three moments below). On top of that, the engine consults it itself at three checkpoints. These need no model to decide: they are comparisons the engine already makes.

| checkpoint | when | what happens with the verdict |
|---|---|---|
| `plan` | `plan_submit` / `plan_review`, before you see the plan | `revise` or `stop` sends the plan back to the agent with the findings; it revises and submits again, and the second submission reaches you. `proceed` shows you the plan with the advice attached to the agent's result |
| `repeat_error` | the second time a tool call fails with the same arguments and the same first error line | the verdict joins the history as an `advisor` call, so the next step sees it |
| `completion` | the agent answers without tool calls, the turn edited files, and no consultation happened after the last edit | `revise` or `stop` gives the agent exactly one more step to address it (or to stop and tell you); `proceed` ends the turn as usual |

Each checkpoint runs at most once per turn. Only the main agent is advised: sub-agents never get the tool or the checkpoints. A scripted run's tool allow-list and an agent's tool list apply to the tool as to any other; permission rules can deny `advisor`.

Checkpoint calls appear in the transcript as ordinary `advisor` tool rows (marked as made by the engine), so you see every consultation and its verdict.

## What the advisor sees

Not the whole conversation. A brief of at most `maxBriefTokens` (24,000 by default, 4 characters each): the checkpoint and question, your latest request in full, the plan, the working tree's `git diff HEAD` (bounded), and as much of the current turn's transcript as fits. Secrets are redacted before the brief leaves the process. The advisor has no tools.

It answers JSON: `verdict` (`proceed`, `revise` or `stop`), a short `summary`, up to 8 `findings` (claim, evidence, severity) and up to 6 `next` steps. An answer that cannot be read becomes a neutral `proceed` with the text as its summary. A timeout (60 s), a provider error or a refused budget is reported in the tool row and the turn continues without the advice; the advisor never fails a turn.

## Usage and limits

Consultations use tokens of the advisor model's account: your ChatGPT subscription quota for a ChatGPT model, your API key for a provider's model, your Claude subscription for Claude Code's advisor. `/advisor` says which. Each consultation is a usage event under the advisor's model, so `/usage` counts it with the session. The budget guard runs before every consultation.

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

A Claude Code model (`/advisor claude-opus#high`) can advise a native session, on your Claude subscription. Each consultation is one headless `claude -p` run: the bounded, redacted brief goes on stdin, the call has no tools, saves no session, runs no hooks and loads no `CLAUDE.md` or auto memory (it starts in the daemon's empty probe folder, never in your project), and the answer is read from Claude Code's JSON result. It finds `claude` the way the Claude Code engine does (`MENDCODE_CLAUDE_BIN`, else `claude` on `PATH`) and uses Claude Code's own login; MendCode reads no credential.

The child's environment is the daemon's own without a Claude Code shell's session variables (the list the launcher drops: `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_ENTRYPOINT`…) and without `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL`, which would move the run off the Claude login onto an API key or another endpoint. A missing or signed-out `claude`, an error answer, a bad exit and the timeout (90 s, then the process is killed) become the same neutral verdict as any failed consultation; the turn goes on.

The tokens `claude` reports come back as a usage event of the turn under the advisor's model with provider `claude`, so `/usage` counts them with the session once, and the tool row names the account ("Claude subscription"). They are not also recorded as an [auxiliary call](usage.md#auxiliary-calls): a consultation is part of a turn, and counting it in both places would count it twice.

## How it differs from

- **Claude Code's advisor**: that one is Anthropic-only, reads the full conversation, and is consulted only when the model decides. This one takes any provider, reads a bounded brief, adds the engine's checkpoints, and answers a verdict the engine acts on.
- **`/compound critic`** ([compound.md](compound.md)): a separate, explicit run in a detached worktree with deterministic checks. The advisor works inside your normal session.
- **Adaptive reasoning** ([reasoning.md](reasoning.md)): chooses how hard the main model thinks; it does not give a second opinion.

## Measured on the evaluation kit

`bun .agents/evals/harness/run.ts --harness mendcode --advisor gpt-6.1-sol#high …` sets the advisor role for a run ([the kit](../.agents/evals/harness/README.md)). One run per task, six tasks (bug-async-race, bug-boundary, false-cause-rounding, feat-lru-ttl, refuse-weaken-test, rootcause-logs), balanced tier, ChatGPT subscription, main effort `medium`, 2026-11-01. One run per cell is a sample, not a distribution: the differences below are within what a repeat could change.

| arm | solved | input tokens (cached) | output tokens | agent time | advisor consultations |
|---|---|---|---|---|---|
| gpt-6-luna alone | 5/6 (bug-boundary failed its hidden check) | 249,025 (190,336) | 6,363 | 128 s | 0 |
| gpt-6-luna + advisor gpt-6.1-sol#high | 6/6 | 363,388 (264,064) | 10,988 | 246 s | 7 (6 `completion`, 1 by the model's own call; no `plan` or `repeat_error`) |
| gpt-6.1-sol alone | 6/6 | 303,073 (228,736) | 10,283 | 245 s | 0 |

The advisor arm's totals include the advisor model's own tokens: 29,353 in and 2,542 out over the 7 consultations. Every task of the advisor arm was consulted at least once (the completion sign-off after an edit).
