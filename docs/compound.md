# Compound orchestration

Use `/compound` to inspect opt-in native execution with `single`, `cascade`, or `critic`. This guide covers configuring a profile, starting a run with explicit checks, and inspecting its candidate and receipt.

For a second opinion inside a normal session, see the [advisor](advisor.md).

## Configure a profile

Configuration lives in `<dataDir>/ai.json`; absent configuration is off. Configuration never changes the current session model or starts a run.

Use this configuration shape:

```json
{
  "version": 1,
  "orchestration": {
    "enabled": false,
    "profiles": {
      "reviewed": {
        "strategy": "critic",
        "primary": { "role": "main" },
        "critic": { "providerID": "openai", "modelID": "gpt-6-sol" },
        "limits": {
          "maxModelRequests": 3,
          "maxTotalTokens": 40000,
          "maxRuntimeMs": 120000,
          "maxCostUsd": 1,
          "unknownCost": "block"
        }
      }
    }
  }
}
```

### Model references and limits

| Reference | Format | Requirement |
|---|---|---|
| Direct | `{providerID, modelID, variant?}` | models and variants must exist in the native catalog |
| Role | `{role}` | roles other than main must be configured; models and variants must exist in the native catalog |

A critic must use a different model or variant.

| Limit | Requirement |
|---|---|
| Requests | 1–32; at least 1/2/3 for single/cascade/critic |
| Total tokens | a positive cap |
| Runtime | 1 second–1 hour |
| Profiles | capped at 16 |

### Apply and enable the configuration

1. Use `/compound configure <json>` to apply the complete configuration with an expected-hash check.
2. Use `/compound on` or `off` to change only the opt-in switch.

## Start a run with checks

Pass the prompt and explicit host checks:

```text
/compound run reviewed {"prompt":"Repair the parser","permission":"edits","checks":[{"id":"diff","command":"git diff --check"},{"id":"unit","command":"bun test test/parser.test.ts","timeoutMs":30000}]}
```

The profile is frozen with its hash, resolved model choices and catalog pricing at start.

### Supported checks

Checks run as argv, without shell expansion, in the isolated candidate.

| Family | Supported checks |
|---|---|
| git | diff --check |
| bun | test/typecheck/run validation scripts |
| pnpm | validation scripts |
| deno | test/lint/check |
| pytest/python | pytest/python -m pytest |
| go | test |
| cargo | test/check/clippy |
| make | validation targets |

Shell syntax, absolute paths and parent traversal are refused.

**Warning:** Explicit checks can run project scripts; starting a run authorizes exactly those checks. Model tools still obey ask/edits permission.

Compound execution excludes nested agents, hosted tools, MCP, extension tools, request hooks and automatic compaction.

## Inspect a run and its candidate

Each run creates a detached worktree from HEAD under `<dataDir>/compound-worktrees/<runId>`. The source checkout and its uncommitted work are not altered.

Candidates are kept for inspection; MendCode never commits, merges or automatically removes them. Only one compound run is active per daemon.

| Key | Does |
|---|---|
| `o` | opens the active leg's session, including approvals |
| `r` | refreshes |
| `x` | cancels |
| ↑↓ | selects a profile |
| `[`/`]` | selects a receipt |
| PageUp/PageDown | scrolls |
| `e` | toggles orchestration |

Hints remain in the header. Under 70 columns the page uses a scrollable single panel.

## Choose a strategy

| Strategy | Behavior |
|---|---|
| Single | runs the primary and deterministic checks |
| Cascade | escalates once only for a quality check failure, then checks again |
| Critic | receives a bounded immutable snapshot in a separate session, with no tools or mutable workspace access |

A missing executable, timeout, cancellation or tool denial never triggers escalation.

### Critic verdicts

These conditions block the run:

- Malformed JSON.
- Findings outside the snapshot.
- Uncertainty.
- A changed base or candidate.
- Acceptance of failing checks.

A revise verdict permits one primary revision, requires dispositions for all findings, and checks again. Success is `unreviewed-revision`, explicitly distinct from independent acceptance.

## Understand budgets and unknown costs

Every provider request in every tool loop reserves requests, tokens and estimated USD before dispatch. Output is capped at 4096 tokens or the remaining reservation.

- Missing usage and interrupted calls retain their reservations.
- Reported overages block further dispatch and acceptance.
- Unknown dispatches are never retried.
- Provider usage replaces estimates only when it is complete and valid; estimates remain conservative.

USD uses provider-reported cost or a catalog estimate (`models[].compoundPricing` in the provider configuration, carried into `ModelInfo.compoundPricing`, with a source).

All-zero catalog prices count as unknown. Unknown cost blocks by default.

**Warning:** `allow-with-token-cap` is an explicit opt-in to proceed under request/token/runtime limits without a guaranteed USD ceiling. Current adapters without verified catalog prices require that opt-in; the run never describes missing prices as free.

## Protocol, receipts and verification

| Command | Returns |
|---|---|
| `compound.get {directory?,runId?}` | `{report}` |
| `compound.configure {config,expectedHash}` | `{report}` |
| `compound.start {input}` | `{run}` |
| `compound.cancel {runId}` | `{report}` |

Typed client helpers are `compound`, `configureCompound`, `startCompound`, `cancelCompound`.

Remote access requires the existing token-authenticated loopback connection. None of these commands is allowed to read-only remote peers because receipts contain user content. No listener or credentials are introduced.

Receipts persist under `<dataDir>/compound-runs` (at most 100). Interrupted runs restart as blocked, with no automatic provider replay.

Live provider acceptance requires configured credentials and remains external to the local fake-provider tests.
