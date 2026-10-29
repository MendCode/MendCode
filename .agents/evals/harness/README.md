# Harness evaluation kit

Offline kit that runs the same coding tasks through MendCode's native engine and through the official Codex CLI, with the
same model and reasoning effort, then checks each result from outside and compares cost. It lives in `.agents/evals/harness/`
and is not part of the product (see "Not part of the product" at the end).

Everything the kit itself proves (task checks, runner, parsers, report math, the MendCode path on the faux engine) runs
without a model, without credentials and without network:

```
bun .agents/evals/harness/verify-tasks.ts                      # every start fails, every reference solution passes
bun test ./.agents/evals/harness/test                          # the kit's own tests (about 1 minute)
./node_modules/.bin/tsc -p .agents/evals/harness/tsconfig.json --noEmit
```

## Layout

```
tasks/<id>/prompt.md        what the agent is told (nothing else is)
tasks/<id>/repo/            the starting repository; copied to a fresh temp dir per run, then `git init` + commit
tasks/<id>/check.sh         hidden check; never inside the agent's directory
tasks/<id>/check/           files only the check uses (overlay tests, expected values, verify scripts)
tasks/<id>/meta.json        category, expectedSteps, timeoutSeconds
tasks/<id>/solution.patch   reference solution (applied by verify-tasks and by the fake adapter)
adapters/                   mendcode, codex, fake: prepare / run / cleanup / describe, plus the usage parsers
lib/                        runner, workspace, check, stats, report, safety, env, process helpers
run.ts  report.ts  verify-tasks.ts  make-patch.ts
first-request.ts            provider input tokens of the first request: pi vs MendCode per tier (`--targets pi,minimalist,balanced,full`)
```

`run.ts --tier minimalist|balanced|full` runs MendCode in that tier (default: the adapter's balanced settings).

## The 12 tasks

| id | category | what it tests |
|---|---|---|
| bug-offbyone | bugfix | a pagination slice one item short |
| bug-async-race | bugfix | concurrent callers of a memoized async function each run the loader |
| bug-boundary | bugfix | shipping tiers use `<` where the contract says `<=` |
| feat-lru-ttl | feature | add TTL support to an LRU cache, with tests (new tests are required) |
| feat-cli-json | feature | add a `--json` flag to a small CLI, with tests |
| refactor-move-rename | refactor | move and rename a helper used by 7 source files plus tests |
| refactor-extract-config | refactor | pull scattered literals into one config module across several files |
| rootcause-logs | rootcause | wrong totals; the cause is only visible in the logs under `logs/` |
| false-cause-rounding | false-cause | the prompt blames `roundHalfUp`; the real bug is in the caller. The check fails the suggested fix |
| long-many-fixes | long | 10 modules, 2 bugs each (20+ steps); the pristine tests overwrite the agent's |
| refuse-weaken-test | refuse | a failing test that must be satisfied by fixing the code; weakening, skipping or deleting it fails |
| search-heavy-timeout | search | one constant in a generated 150+ file repo, with look-alike decoys |

The checks run from outside against a copy of the agent's working tree; they never read the agent's `check.sh`. A lint
(`lib/verify.ts`) ensures nothing in a task's `repo/` mentions the checker.

## One-task calibration (do this first)

Quota is shared with the operator's real use; start with one cheap task, one repeat, to see that credentials, the model id,
the JSON shapes and the check all work. `bug-offbyone` is the cheapest.

Prerequisites, once:

1. `codex login` with the ChatGPT account, then open `codex` once so its token is fresh (a refresh through the kit's link
   could rotate the real refresh token, see "Credentials").
2. A short, empty data directory for MendCode (the unix socket path limit is about 100 characters), for example
   `/tmp/mcev-data`. It is created and owned by the kit; it must never be `~/.mendcode*`.

MendCode:

```
bun .agents/evals/harness/run.ts --harness mendcode --model gpt-6-luna --tasks bug-offbyone --repeat 1 \
  --out /tmp/mcev-out --data-dir /tmp/mcev-data --auth-from ~/.codex --effort medium
```

Codex:

```
bun .agents/evals/harness/run.ts --harness codex --model gpt-6-luna --tasks bug-offbyone --repeat 1 \
  --out /tmp/mcev-out --auth-from ~/.codex --effort medium
```

Then `bun .agents/evals/harness/report.ts --out /tmp/mcev-out`. Look at `/tmp/mcev-out/gpt-6-luna/<harness>/bug-offbyone/r1/`:
`result.json` (outcome, usage, diff, notes), `transcript.jsonl` (the raw stream), `check.log` (the hidden check's output),
`work.diff` (what the agent changed), and for MendCode `settings-applied.json` and `daemon.log`. In `result.json` verify
that `usage.inputTokens`, `outputTokens` and `toolCalls` are numbers and not null. A null means the parser did not recognise
that shape: send me the transcript. The Codex JSON shape in the parsers is written from its documented `exec --json`
events and has not been run against the real binary.

`--dry-run` prints the plan without starting anything. `--resume` skips runs that already have a `result.json`.
`--timeout-scale 0.5` shortens every task's timeout.

Full run, once calibration is clean:

```
bun .agents/evals/harness/run.ts --harness mendcode,codex --model gpt-6-luna --tasks all --repeat 3 \
  --out /tmp/mcev-out --data-dir /tmp/mcev-data --auth-from ~/.codex
```

Models are given exactly as the provider names them. The MendCode adapter prefixes a bare id with `chatgpt/`. Note that the
product's built-in catalog lists `gpt-6-sol` (`packages/engine-native/src/provider-presets.ts:35`); the subscription catalog
that the daemon reads from the linked `models_cache.json` is what decides whether `gpt-6.1-sol` exists. Check
the id in calibration before a long run.

## Credentials: how MendCode reaches the ChatGPT subscription

The adapter never touches a credential file of the operator's. It runs the daemon and the CLI with an isolated `HOME`
(a directory under the kit's data dir) and `MENDCODE_V2_DIR` set to the dedicated data dir.

- The daemon builds subscription request headers in `packages/daemon/src/main.ts:155-159`: if the data dir's own ChatGPT
  login (`<dataDir>/chatgpt-auth.json`, OAuth v2, `packages/engine-native/src/chatgpt-auth.ts:7`) is present it is used, otherwise
  it falls back to `codexSubscriptionHeaders()` (`packages/engine-native/src/codex-auth.ts:24-26`), which reads
  `$CODEX_HOME/auth.json` or `<HOME>/.codex/auth.json`, read-only, on every request. It never refreshes or rewrites that file.
- Because `HOME` is isolated, that path is empty unless provided. `--auth-from <dir>` makes the adapter symlink
  `<dir>/auth.json` (and `models_cache.json`, which the daemon reads from `<HOME>/.codex`, `codex-models.ts:8`) into the isolated
  `<HOME>/.codex`. Only those files are linked; `config.toml`, rules and sessions are not.
- The first option (own OAuth login in the data dir) needs `MENDCODE_OPENAI_OAUTH_CLIENT_ID` and an interactive login
  (`chatgpt-auth.ts:93`); the kit does not use it.

What the orchestrator must provide: a Codex login for the ChatGPT account (`~/.codex/auth.json` with `tokens.access_token`
and `tokens.account_id`, still valid; the product refuses an expired token with "open `codex` once to refresh it") and the path
passed as `--auth-from ~/.codex`. For Codex itself the same flag links the same file into an isolated `CODEX_HOME`.

Risk: Codex, unlike MendCode, refreshes its token and rewrites `auth.json`. Through a symlink that write lands on the real
file and may rotate the real refresh token. Mitigations: `codex` is opened once right before the run so no refresh is due;
a run takes minutes, well inside a token's life. If that is not acceptable, copy `auth.json` to a private directory and pass
that directory as `--auth-from` (the kit then only ever touches the copy; a rotated copy may log the original out).

## Isolation and what is held equal

Same for both harnesses: the task prompt, the model, the reasoning effort (`--effort`, default medium), the sandbox (a
filesystem sandbox that allows writes in the working directory only, no network), the approval mode (never ask), the
timeout (`timeoutSeconds` of the task, times `--timeout-scale`), and a fresh working directory (a copy of `repo/`, `git init`
and one commit) per run. Child processes get an allow-listed environment (no API keys, no proxy, no operator `HOME`, no
`CODEX_HOME`), so a stray `OPENAI_API_KEY` cannot change which credential is used.

MendCode: native engine, `tier balanced`, prompt mode `focus` (family auto, resolves to the Codex-style prompt for this model),
permission `full` with `external_directory: deny` (never blocks inside the workspace, cannot leave it), sandbox
`workspace-write`, network off, Claude detection off. The adapter applies these through the daemon's settings API, reads them
back and fails the run if they differ (`settings-applied.json`).

Codex: `codex exec --json -C <cwd> -s workspace-write -m <model> -c model_reasoning_effort=... ` with `approval_policy="never"`,
`--ignore-user-config` and `--ignore-rules`. Codex's workspace-write sandbox cannot read-protect the rest of the disk; MendCode's
external-directory deny can. An agent could in principle read the kit's `tasks/` from disk; the kit's tasks are written so
`repo/` never points at them, but this is the one place the setups are not strictly equal.

Safety: the kit refuses a state directory under `~/.mendcode*`, `~/.codex`, `~/.pi`, `~/.claude*`, `~/mc2-prueba`, `~/Library`
and similar, refuses a non-empty directory it did not create (marker `.mcev-owned`), starts and stops its own daemon (process
group, SIGTERM then SIGKILL) and removes only directories it created (`mcev-` prefix, marker checked).

## Metrics

Per run, from the harness's own event stream (not the agent's words):

- solved: the hidden check exited 0. Outcomes: solved, failed (check red), timeout (harness cut off; check still run on what
  it left), error (harness did not start or crashed; not counted as a failed attempt in the "harness errors" column).
- input tokens: all prompt tokens billed across all model calls, cached included. MendCode reports uncached input separately,
  so the adapter sums input + cache read + cache write; Codex's `input_tokens` already includes cached.
- cache hit %: cached-read tokens / input tokens. "aggregate" sums over runs, "median" is the median of per-run percentages.
- output tokens: generated tokens, reasoning included (both harnesses).
- tool calls / failed tool calls: items the agent ran. MendCode counts tool items and those that ended in error; Codex counts
  commands and file changes and treats a command that exited non-zero as failed.
- compactions: context compactions during the run. MendCode: `compaction.updated` reaching `packed`. Codex: `compacted`
  records in its session file (found under the isolated `CODEX_HOME`).
- wall time: seconds from the start of the harness process to its exit (check time excluded). Median and p90 are nearest rank.
- The report gives these for all runs and for solved runs only (a failed run that gave up early would otherwise look cheap),
  plus a paired ratio mendcode/codex over tasks both solved.

## Not comparable (the report prints these as n/a, never as 0)

- Codex has no cache-write counter, no per-call count and no turn duration in `exec --json`.
- Compactions exist for Codex only through the session file; if it is not found they are n/a.
- Tool counts are different things per product (different tool sets); read them as indicative.
- Failed tool call definitions differ (see above).
- Cost in money is not computed: both run on a subscription, so only tokens are compared.

## Known unfairness (deliberate)

Different system prompts, tool sets and context management are what is under test, so they are not equalised. Held equal:
model, effort, sandbox and network, approval mode, timeouts, task, fresh workspace. Not equalised and outside the kit's
control: backend load at the time of the run (interleave harnesses rather than running one after the other, and use
`--repeat 3` or more), server-side caching that favours whoever ran second with the same prefix, and model nondeterminism
(one repeat per task is an anecdote, not a result).

## Quota caveat

Both harnesses spend the same ChatGPT subscription quota that the operator uses interactively. 12 tasks x 2 harnesses x 3
repeats is 72 agent runs; some tasks (long, search) take many calls. Check the remaining quota first, run `luna` for
everything and `gpt-6.1-sol` only for the final confirmation, and use `--resume` so an interrupted run does not repeat spent
work. A run that hits the usage limit shows up as a harness error with the error text in `result.json` notes, not as an
unsolved task.

## Not part of the product

`/.agents/` is gitignored in this repository, so the kit's files are committed with `git add -f`. The kit's tests are not
added to the product's shards (`scripts/test-shards.sh` runs `packages/`, `apps/`, `scripts/` and `examples/`), because the
verification spawns many `bun test` subprocesses and the faux-engine daemon tests need free sockets; run them with
`bun test ./.agents/evals/harness/test`. The kit is outside every `tsconfig` include of the product (`tsconfig.base.json`
includes `packages`, `apps`, `features`, `scripts`, `examples`) and nothing in `package.json`, `scripts/` or the release
workflows references `.agents`; the kit has its own `tsconfig.json`.
