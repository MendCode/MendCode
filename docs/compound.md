# Compound orchestration

`/compound` inspects opt-in native execution: `single`, `cascade`, or `critic`. Configuration is
`<dataDir>/ai.json`; absent configuration is off. The profile is frozen with its hash, resolved model
choices and catalog pricing at start. Configuration never changes the current session model or starts a run.
The `ai_config` advisor/planner remains B70.

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

Direct refs use `{providerID, modelID, variant?}`; role refs use `{role}`. Roles other than main must
be configured. Models and variants must exist in the native catalog. A critic must use a different
model or variant. Limits require 1–32 requests (at least 1/2/3 for single/cascade/critic), a positive
total token cap and 1 second–1 hour runtime. Profiles are capped at 16.

`/compound configure <json>` applies the complete configuration with an expected-hash check;
`/compound on` or `off` changes only the opt-in switch. To start, pass the prompt and explicit host checks:

```text
/compound run reviewed {"prompt":"Repair the parser","permission":"edits","checks":[{"id":"diff","command":"git diff --check"},{"id":"unit","command":"bun test test/parser.test.ts","timeoutMs":30000}]}
```

Checks run as argv, without shell expansion, in the isolated candidate. Supported families are git diff
--check, bun test/typecheck/run validation scripts, pnpm validation scripts, deno test/lint/check,
pytest/python -m pytest, go test, cargo test/check/clippy and make validation targets. Shell syntax,
absolute paths and parent traversal are refused. Explicit checks can run project scripts; starting a run
authorizes exactly those checks. Model tools still obey ask/edits permission. Nested agents, hosted tools,
MCP, extension tools, request hooks and automatic compaction are excluded from compound execution.

Each run creates a detached worktree from HEAD under `<dataDir>/compound-worktrees/<runId>`.
The source checkout and its uncommitted work are not altered. Candidates are kept for inspection;
MendCode never commits, merges or automatically removes them. Only one compound run is active per daemon.
`o` opens the active leg's session, including approvals; `r` refreshes, `x` cancels, ↑↓ selects a profile,
`[`/`]` selects a receipt, PageUp/PageDown scrolls, and `e` toggles orchestration. Hints remain in the header;
under 70 columns the page uses a scrollable single panel.

Single runs the primary and deterministic checks. Cascade escalates once only for a quality check failure,
then checks again. A missing executable, timeout, cancellation or tool denial never triggers escalation.
Critic receives a bounded immutable snapshot with no tools or mutable workspace access, in a separate session.
Malformed JSON, findings outside the snapshot, uncertainty, a changed base or candidate, and acceptance of
failing checks block the run. A revise verdict permits one primary revision, requires dispositions for all
findings, and checks again. Success is `unreviewed-revision`, explicitly distinct from independent acceptance.

Every provider request in every tool loop reserves requests, tokens and estimated USD before dispatch.
Output is capped at 4096 tokens or the remaining reservation. Missing usage and interrupted calls retain
their reservations; reported overages block further dispatch and acceptance. Unknown dispatches are never
retried. Provider usage replaces estimates only when it is complete and valid; estimates remain conservative.
USD uses provider-reported cost or a catalog estimate (`models[].compoundPricing` in the provider configuration,
carried into `ModelInfo.compoundPricing`, with a source).
All-zero catalog prices count as unknown. Unknown cost blocks by default; `allow-with-token-cap` is an explicit
opt-in to proceed under request/token/runtime limits without a guaranteed USD ceiling. Current adapters without
verified catalog prices require that opt-in; the run never describes missing prices as free.

Commands: `compound.get {directory?,runId?}` → `{report}`; `compound.configure {config,expectedHash}` → `{report}`;
`compound.start {input}` → `{run}`; `compound.cancel {runId}` → `{report}`. Typed client helpers are
`compound`, `configureCompound`, `startCompound`, `cancelCompound`. Remote access requires the existing
token-authenticated loopback connection. None is allowed to read-only remote peers because receipts contain
user content. No listener or credentials are introduced. Receipts persist under `<dataDir>/compound-runs`
(at most 100); interrupted runs restart as blocked, with no automatic provider replay. Live provider acceptance
requires configured credentials and remains external to the local fake-provider tests.
