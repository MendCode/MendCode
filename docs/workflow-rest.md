# Workflow REST adapter (B86)

The existing HTTP adapter is opt-in, loopback-only and token authenticated. Every workflow route requires a full remote token: snapshots, revisions and ledgers contain user text. No command is added to `READ_ONLY_COMMANDS`. Select a registered project with `directory` / `x-opencode-directory` or `workspace` / `x-mendcode-workspace`. Run IDs cannot cross that boundary, including native `/command` requests.

| Route | Payload / result |
|---|---|
| `POST /workflow/preview` | `{plan}` → validated bounded estimates; creates no sessions, revision or runner |
| `POST /workflow/save` | `{plan, definitionID?, name?, description?, source?, ownerSessionID?, saved?}` → immutable revision receipt |
| `POST /workflow/start` | Exactly one of `plan`, `revisionID`, `definitionID`; optional metadata, `originSessionID`, `loopID`, `loopRunID`, `overlapKey` → snapshot |
| `GET /workflow` | Project snapshots; `limit` defaults to 50, capped at 100 |
| `GET /workflow/:runID` | Durable snapshot with definition, revision, preview, phases, tasks, events, artifacts, gates and observed usage |
| `DELETE /workflow/:runID` | Terminal runs only; removes native run/session/ledger records; retains immutable definitions/revisions; returns `true` |
| `GET /workflow/:runID/events` | Durable event array; `limit`, optional exclusive `before` sequence |
| `GET /workflow/:runID/artifacts` | Durable artifact array, including captured task outputs; same paging |
| `POST /workflow/:runID/pause`, `/resume`, `/stop` | `{reason?}` → updated snapshot; uses native drain/resume/cancel semantics |
| `POST /workflow/:runID/permission-mode` | `{mode?: normal\|report-only\|custom, sessionMode?: approval\|smart\|full_access\|global_default\|null, reason?}` → updated snapshot |
| `POST /workflow/:runID/retry-task` | `{taskID, reason?}` → retries a failed/input-waiting task and invalidates dependent outputs |
| `POST /workflow/:runID/retry-phase` | `{phaseID, reason?}` → atomically retries the phase, its dependents and later phases; attempts remain counted |

Routes and payload schemas are included in `/doc` and `/openapi.json`. Malformed payloads/queries and invalid transitions return 400, missing resources 404, workspace mismatch/read-only authority 403, unsupported donor plan features (retry limits, `human` output schemas or inputs, unrecorded historical runs) 501. JSON bodies use the existing byte limit. Event/artifact arrays expose `X-Next-Before` and `X-Truncated`; snapshot pagination is also in `pagination`. Lists stop before the native frame byte budget and mark `X-Truncated`. Empty/truncated history never claims evidence that was not retained.

## Plan compatibility

Plans accept native v2 JSON or v1 `formatVersion: 1` JSON. The donor form maps phases (`name`, `ordinal`, `taskIDs`), task kinds `agent`, `synthesize`, `verify`, `validate`, `map`, dependencies, selectors, output contracts, model/provider pairs, agent profiles, tool restrictions, workspaces, budgets, completion criteria/checks and overlap policy to native execution. Verify/validate agent tasks run read-only. Donor task/phase identifiers remain visible in HTTP and are mapped to bounded internal slugs. Donor JSON is retained on the immutable revision, preserving original metadata and IDs across restarts; native callers use their native IDs and plans. Output captures also enter the existing bounded ledger. Ledger IDs/event types remain native v2 identities inside donor-shaped envelopes; this is not an exact v1 SDK ABI.

Required gates, `human` tasks, per-task retry and per-plan retention are accepted. Each `requiredGates` entry (and a `human` task) becomes a native human task that waits with no session; the run is `needs_input` until it is answered. A human task takes no `inputs`, and its output is `none` or `text` (the approval note). Answer with `POST /workflow/:runID/approve-task` or `/reject-task` (`{taskID, reason?}`, full token; `gate-N` or the gate id for gates), a native extension of the donor API; rejecting fails the task. The model cannot approve. `retry` maps to `{maxAttempts, backoffMs, retryOn}`: with neither `maxAttempts` nor `retryOn` it is 3 transient attempts after `backoffMs` (default 1 s), `retryOn` alone means no retry, and `maxAttempts` above 6 or `backoffMs` above one hour return 501. Budget failures never retry. `budget.retention` (`maxArtifacts`, `maxAgeMs`, `maxBytes`) prunes the run's events and artifacts in the ledger; receipts are kept and the run is marked truncated. Native bounds remain: 32 task nodes including map overhead, four concurrent tasks, supported JSON-schema keywords, and the native text/plan byte limits. Historical native runs without immutable revision metadata cannot produce the full donor snapshot and return 501; their native APIs remain available. The native map scheduler also invalidates dependents and later phase outputs on retry, preserving its stronger stale-output protection.

Completion uses v2 contracts: donor completion criteria become required native criteria; explicit donor completion requests a fresh independent audit. Legacy donor plans use native automatic audit rather than v1 same-run semantic closure. No provider is called by preview/save. Starting and completion use the configured engine; tests use local fake ports only. Real provider compatibility is not live-tested.

## Conservative decisions

- The HTTP listener stays off by default, loopback only, with token auth; no new listener, dependency or external service.
- IDs, state ownership, storage, model catalog and ledger retention remain native. Loop IDs are durable provenance; worktree reuse uses the existing origin-session lease, not a new loop runtime.
- `overlapKey` is a project-scoped idempotency key; concurrent repeats return the existing run, including terminal runs. It is separate from plan overlap scheduling.
- Permission changes are durable runtime overrides; they do not rewrite the frozen plan or task settings. Session aliases map conservatively: `approval → ask`, `smart → edits`, `full_access → full`, `global_default/null → inheritance`. Effective permission never exceeds the initial grant or inherited restrictions. Captured live policies update at the next tool/provider boundary; an operation already in flight cannot be undone. Report-only changes reject workflows with host checks, which cannot safely be retroactively restricted. Native `custom` retains its existing approval semantics.
- The native client adds `setWorkflowPermissions` and `retryWorkflowPhase` alongside existing typed save/start/get/ledger helpers. Terminal UI uses the existing workflow factories and panel grid; no new chrome or keys.

Script workflows ([workflows.md](workflows.md#script-workflows)) are not exposed here: a route that reads a script run answers 501, and script runs are left out of the run list.

App-harness frames use the actual HTTP adapter, workflow host, SQLite records and renderer with local pending-task ports:

```sh
bun scripts/render-frames.ts .agents-frames/B86 --b86 100x30 180x50
```
