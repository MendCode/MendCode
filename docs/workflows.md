# Workflows

A workflow runs tasks in dependency order, each agent task in its own child session, then checks a completion contract. Start one from chat or the CLI and follow it in `/workflows`.

| Start from | Use |
|---|---|
| Chat | `/workflows` |
| Model | `workflow_start` tool, which asks for approval |
| CLI | `mendcode workflow start` |

For opt-in HTTP routes and donor payload support, see [Workflow REST adapter](workflow-rest.md).

For bounded single/cascade/critic candidates with immutable review and request/token/cost/time accounting, see [Compound orchestration](compound.md). These opt-in runs keep isolated worktrees and never automatically replay after restart.

## Plan

```json
{
  "name": "api-rewrite",
  "objective": "Rewrite the API layer to the new client.",
  "tasks": [
    { "kind": "agent", "id": "survey", "title": "Survey the API", "prompt": "List every endpoint and caller.", "mode": "read" },
    { "kind": "agent", "id": "impl", "title": "Rewrite", "prompt": "Port every endpoint.", "needs": ["survey"], "timeoutMinutes": 60 },
    { "kind": "check", "id": "unit", "title": "Unit tests", "command": "bun test", "needs": ["impl"] }
  ],
  "contract": "release-gate",
  "permission": "edits",
  "maxConcurrent": 2,
  "maxRuntimeMinutes": 240
}
```

- `mode: read` runs in plan mode (it cannot change anything); `work` gets the workflow's permission. Only one `work` task runs per directory at a time, across all workflows.
- A task starts when everything it `needs` is done. A failed task skips what depends on it. An interrupted task (daemon restart, dropped turn) goes back to pending, up to three starts.
- Each start restates the whole task: the objective, the prompt, up to eight results of the tasks it needs (fenced as untrusted), and the rework note after a rejected verification. A task may end with a `TASK_RESULT` block; `status: blocked` fails it.
- An explicit `--permission`, or the originating session's mode, determines the workflow permission; a plan's `permission` is only the default when neither was supplied. A session cannot grant more than its own mode.

## Completion contract

Inline in the plan, or by name from `contracts/<name>.json` in any extension layer (resolved once at start and frozen into the run):

```json
{
  "criteria": [
    { "id": "tests", "text": "The full test suite passes", "owners": ["impl"] },
    { "id": "api-doc", "text": "docs/api.md documents every endpoint", "owners": ["impl"] }
  ],
  "checks": [{ "id": "unit", "command": "bun test", "covers": ["tests"] }],
  "audit": "auto",
  "maxRepairs": 2
}
```

- Checks run on this machine as one plain command (no shell). They decide the criteria they `cover`.
- A rejection sends the owners of what failed (and their dependents) back with the failure as feedback. When repairs run out, or no owner is declared, the run is **blocked**: `resume`/`verify` checks again, `accept` records a reason and completes it.
- Every check command is shown verbatim before anything starts, because checks run outside the model's permission system.

### Audit scope

The auditor is a read-only session:

| Audit mode | Criteria reviewed |
|---|---|
| `auto` | Only criteria no check covers |
| `independent` | All criteria |
| `none` | Never; reported as unverified |

Its verdict is void if it inspected nothing or the workspace changed while it ran.

### Audit retries and time limits

An auditor with no activity for 10 minutes is stopped (`audit stalled: no activity for 10 min`). One that keeps working runs as long as it needs, up to an hour (`audit still running after 60 min`).

A stalled, failed or unstarted audit is asked again in a new read-only session with the same check results, three times in all. Only then does the run wait as `blocked` (`… (3 attempts)`).

Your own cancel of the auditor blocks at once. Loops use the same auditor rules.

The detail in `/workflows` shows `round N — did not finish` with the keys to continue: `v` verifies again, `b` shows the evidence and `a` accepts.

## Controls

| Control | Effect |
|---|---|
| `pause` | Lets running tasks finish; starts nothing new |
| `resume` | Continues and re-verifies a blocked run |
| `stop` | Cancels the workflow's own turns and ends it |
| `retry` | Runs one task and its dependents again |
| `verify` | Verifies |
| `accept` | Accepts with a reason |
| `delete` | Finished runs only; their sessions go too |

Cancelling a task's turn yourself pauses the run.

A headless run targeting a session with an earlier pending approval exits instead of waiting behind it. Answer the approval in the terminal first.

### Page keys

The page opens with workflows from all projects. Press Tab to limit it to the current project.
After opening a task session from the list, press ↑ at an empty prompt to return to the list.

| Key in `/workflows` | Does |
|---|---|
| `↑↓` | Select run |
| `←→` | Select task |
| `enter` | Open the task's session |
| `p` | Pause/resume |
| `x` | Stop |
| `t` | Retry |
| `v` | Verify |
| `a` | Accept |
| `d` | Delete |
| `tab` | This project / all |

### Evidence ledger

Press `b` to open the run's evidence ledger.

| Key | Does |
|---|---|
| `1`, `2`, `3` | Events, artifacts, completion receipts |
| `↑↓` | Select entry |
| `pgup/pgdn` | Scroll detail |
| `[`/`]` | Newer/older pages |
| `r` | Refresh |
| `e` | Preview a JSON export |
| `m` | Preview Markdown |
| `y` | Copy the export |
| `esc` | Return |

Panels fill the page; below 70 columns the ledger stacks in one column.

### Ledger commands and storage

`workflow.events`, `workflow.artifacts`, `workflow.receipt`, `workflow.export` accept:

| Argument | Meaning |
|---|---|
| `limit` | 50 by default, maximum 100; receipts default to 1 |
| `before` | Exclusive sequence cursor |
| `run` | Optional; workflow run number is 0 |

Export returns text and pagination metadata, creates no file and uses `format: json | markdown`.

- Events follow actual state/task transitions.
- Artifacts preserve frozen plans/hashes, task attempts/results, gates, audit judgments, verification rounds and overrides.
- Receipts distinguish verified completion from manual acceptance and missing verification.

The ledger is stored separately and atomically with the run, capped at 512 entries. The newest artifact/receipt per key is protected during trimming.

Pages also fit the protocol byte budget. Oversized individual data retains an explicit byte count and SHA-256 digest.

Existing runs are seeded from their available snapshot and labelled `historical: false`; missing history is never invented. Deletion and workflow retention remove their ledgers.

These content-bearing commands are unavailable to read-only remote tokens.

## Guarantees

- A task waits for input only while its session has an open request. After a restart running tasks are re-derived, never left waiting.
- A verification that finishes after the run moved on is ignored.
- The daemon loads nothing for workflows until one is started or a live run exists at boot.
- Storage is one row per run, at most 160 KB, with at most 50 finished runs.

## Definitions and immutable revisions (B21)

### Save a definition

Run `workflow save <file.json|name>` (or `workflows save --plan-file FILE`) to validate the v2 plan, resolve its named contract now, and store an immutable revision. This runs no checks and creates no sessions.

The receipt contains `definitionId`, `revisionId`, a positive revision number, and a SHA-256 `planHash` over canonical JSON.

| Option | Does |
|---|---|
| `--definition-id ID` | Appends a revision; previous plans and contracts remain unchanged |
| `--name`, `--description` | Optionally describe the definition |
| `--source manual|saved|template|package|session-generated` | Optionally describes its source |

No v1 JSON conversion is implicit. Adapt v1 phase/model/workspace fields to the existing v2 task/contract format.

### Read and start revisions

| Command or option | Does |
|---|---|
| `workflow definitions [--limit 50]` | Lists project metadata |
| `workflow revision <revision-id>` | Reads a full frozen plan |
| `workflow preview|start --definition-id ID` | Selects the current revision |
| `--revision-id ID` | Selects an exact revision |

Starting still requires `--yes`; permissions never exceed the user's grant. Inline/named starts also receive an immutable revision (`saved: false`).

Existing runs without revision metadata remain readable. Revisions survive run deletion and finished-run retention; each is bounded to 128 KiB.

### Retry tasks

`control-plane workflows status` aliases project-scoped `workflow list`.

`control-plane workflows retry-task <run-id> --task-id <task-id> [--reason TEXT] [--wait --timeout S]` retries failed, skipped, stopped or input-waiting tasks and their dependents.

- An input-waiting turn is cancelled before retry.
- Completed/stopped runs reject retry.
- Manual retries preserve the existing attempt counter.

Waiting follows pushed events, with the same completion/failure/input/timeout exit codes as start.

### Human tasks, retries and retention

| Plan feature | Fields and behavior |
|---|---|
| `human` tasks | `{kind:"human", id, title, prompt, needs}`: wait for you. Approve with `workflow approve <id> --task T`, reject with `workflow reject`, or use `y`/`n` in the workflows page. |
| Per-task `retry` | `maxAttempts` 1-6, `backoffMs`, `retryOn` of transient, environment, policy, quality, budget, user_input, terminal; off unless set |
| Per-plan `retention` | `maxArtifacts`, `maxAgeMs`, `maxBytes`, applied to the ledger |

### Model access and page layout

| Model tool | Does |
|---|---|
| `workflow_events`, `workflow_artifacts` | Read project workflow events/artifacts: redacted, 12k characters, `before` cursor |
| `workflow_save` | Saves/revises |
| `workflow_start` | Accepts inline plans, layer names or definition/revision refs |
| `workflow_control` | Pause/resume/stop/retry/delete through normal execution approval |
| `workflow_status` | Includes revision identity |

Resume/retry approval shows every frozen check command. Smart permissions always ask for autonomous controls. All model access stays in the current project.

Event/artifact ledgers and phase retry remain separate audit batches. The `/workflows` page shows frozen revision identity, tasks and verification in the shared bordered panel grid, with header hints and one column below 70 cells.

### Protocol and client helpers

Protocol additions are `workflow.save`, `workflow.definitions`, `workflow.revision.get`. Client helpers are `saveWorkflow`, `workflowDefinitions`, `workflowRevision`.

None is exposed to read-only remote tokens, because full plan/metadata content may contain user text. They use the existing authenticated transport; no listener, service or dependency is added.

## Task routing and limits (B45)

### Choose a task model

Plans and agent tasks accept optional `model: { model, variant?, effort?, parameters? }`, `agent`, `permissions`, `workspace` and `budget`. Agent tasks also accept `permission` and `allowedTools`. Existing plans keep working.

Set the independent workflow default in `/model`'s `workflow` row, a recipe's `roles.workflow`, or `settings.models.workflow`.

Model selection follows this order:

1. Task model.
2. Plan model.
3. Workflow role.
4. Agent's own model.
5. Origin session/main model.

A default workflow variant is applied only with its own model, never to explicit plan/task choices. ACP and Claude Code models are rejected for task routing because they cannot enforce native workflow policies.

Effective settings are frozen on the task and survive retries/restart. `/workflows` shows the selected task's route, workspace and consumed limits. Client helpers `startWorkflow` and `getWorkflow` carry the same typed plan/run.

### Restrict permissions

`permissions` supports `mode: normal | report-only | custom`, exact-name `allowedTools`, `approvalRequiredFor`, `approvedActions`, `allowEdits`, `allowMutatingCommands`, and `allowExternalSend`.

Workflow, task and agent restrictions compose; nothing increases the user's grant:

- Allowlists intersect.
- False side-effect flags win.
- Contradictions are rejected during validation.

Approval-required actions still ask in full mode. In custom mode, side effects outside `approvedActions` ask; approved actions remain subject to session grants and global rules.

Read-only tasks cannot exit plan mode, delegate, send through MCP/custom tools or run host checks. Restrictions also apply to delegated child sessions. No remote read-only command is added.

### Choose a workspace

| Workspace | Behavior |
|---|---|
| `in-place` | Default |
| `read-only` | Caps side effects |
| `per-run-worktree` | Detached worktree under `<data dir>/workflows/workspaces`; shared by all tasks when set on the plan, isolated per task when set on that task |
| `per-loop-worktree` | Reuses its origin session's lease; without an origin it uses the run |

Worktrees contain committed HEAD, excluding uncommitted source edits. They are retained, including on completion, for manual review: no automatic commit, promotion, merge or deletion.

Checks and completion verification use a plan's shared worktree. Task-isolated outputs are not automatically copied to dependent workspaces; use a plan workspace when tasks must share files.

### Set budgets

| Budget | Measures |
|---|---|
| `maxTurns` | Provider calls |
| `maxRuntimeMs` | Runtime |
| `maxTokens` | Input + output, without counting reasoning/cache twice |
| `maxCost` | USD |
| `maxChildren` | Children |
| `maxDepth` | Depth; workflow task is depth 1 |

Plan token/cost/call/child caps are aggregate; task caps are narrower. Usage and child reservations accumulate across retries and children.

Task runtime limits apply per attempt. A plan runtime limit and `maxRuntimeMinutes` cap the whole run. Zero is a real limit.

Reported token/cost exhaustion cancels the owned turn and blocks dependent work. An unknown price fails closed for a cost cap.

A provider request can cross a token/cost cap before it reports usage; no subsequent work is allowed. Limits and worktree isolation are opt-in; no service, listener or dependency is added.

## Phases, map outputs and overlap (B78)

### Order phases and barriers

Optional `phases` are ordered v2 descriptors: `{ id, title, tasks: [taskId], barrier }`. Every declared task belongs to exactly one phase. Dependencies cannot point into a later phase.

| Barrier | Behavior |
|---|---|
| `{ kind: "all" }` | Default; every task must succeed |
| `{ kind: "quorum", quorum: N }` | Releases the next phase as soon as N succeed |
| `{ kind: "best-effort" }` | Waits for every task to finish, including failures |
| `{ kind: "condition", expression: "true|all|completed|false" }` | Preserves v1's deterministic all-success aliases; `false` never releases |

Arbitrary expressions are rejected, never evaluated. Explicit `needs` still require successful producers. Impossible barriers skip later work.

All active tasks drain before completion; a satisfied quorum/best-effort phase can tolerate failures. Retrying a task invalidates dependent outputs and later phases; contract repair uses the same invalidation.

### Declare outputs

| Agent `output` kind | Options |
|---|---|
| `text` | Optional `maxChars`, at most 8000 |
| `json` | Optional `schema` |
| `artifact` | `artifactKind`, optional `schema` |
| `none` | No output |

The prompt requests a fenced `WORKFLOW_OUTPUT` block before `TASK_RESULT`. Raw JSON or a fenced `json` block also works. Artifacts without a schema may be plain text.

Schema validation supports type unions, properties, required, additionalProperties, items, enum, const, numeric/string/array bounds and allOf/anyOf/oneOf.

Unsupported keywords fail preview instead of being silently ignored. Schemas are bounded to 12 nesting levels.

Values are durable data inside the run, not filesystem writes or a new artifact ledger. Summaries/events expose only output kinds, never output values or map items.

### Select inputs

Consumers declare `inputs: [{ taskId, path?, projection?, required? }]`. Producers must be transitive dependencies.

Selectors use dotted paths or JSON pointers; projection is a second path selection. Missing required values fail the consumer before submission; `required: false` yields no value.

Prototype traversal is rejected. Selected inputs and map items are fenced as untrusted data, with no authority to run tools or change grants.

```json
{
  "name": "review-files", "objective": "Review each selected file", "maxConcurrent": 2,
  "tasks": [
    { "kind": "agent", "id": "list", "title": "Find files", "prompt": "Return a JSON array of filenames", "mode": "read", "output": { "kind": "json", "schema": { "type": "array", "items": { "type": "string" }, "maxItems": 8 } } },
    { "kind": "map", "id": "review", "title": "Review files", "needs": ["list"], "map": { "source": { "taskId": "list" }, "maxItems": 8, "taskTemplate": { "title": "Review file", "prompt": "Review the provided map item", "mode": "read", "output": { "kind": "artifact", "artifactKind": "review", "schema": { "type": "object" } } } } },
    { "kind": "agent", "id": "merge", "title": "Summarize", "prompt": "Summarize the selected reviews", "mode": "read", "needs": ["review"], "inputs": [{ "taskId": "review" }] }
  ],
  "phases": [
    { "id": "discover", "title": "Discover", "tasks": ["list"] },
    { "id": "inspect", "title": "Inspect", "tasks": ["review"] },
    { "id": "report", "title": "Report", "tasks": ["merge"] }
  ],
  "overlapPolicy": "queue"
}
```

### Map expansion limits and retries

Map expansion reserves at most 16 items per map and 32 total tasks at validation. An oversized/non-array source fails rather than truncates.

Child IDs are `<map-id>-<1-based-index>`; the frozen plan/hash is unchanged. Templates use existing agent task routing, permissions, workspaces, budgets and timeouts.

Children obey the shared concurrency cap and directory work mutex. The map orchestrator consumes no agent slot.

Successful children produce an ordered JSON array for downstream tasks, including an empty array for zero items.

Retrying a map or any failed child rebuilds that map and its dependents, cancelling only owned live turns. Restart resumes interrupted children without duplicating the expansion.

| Storage | Limit |
|---|---|
| Composed plans | 48 KiB |
| Each value/item | 8000 characters |
| Aggregate output/item storage | 24 KiB within the existing 160 KiB run limit |

### Control overlapping runs

Overlap is opt-in; plans without it retain legacy start behavior. Matching uses project directory plus `overlapKey`, default plan name.

| Policy | Behavior |
|---|---|
| `skip` | Returns the existing live run without creating sessions |
| `queue` | Persists FIFO links; starts only after all earlier matching runs finish/stop/are deleted, including legacy overlapping runs |
| `replace` | Stops prior matching runs and cancels their owned turns/checks/audits before starting the replacement; read-only/report-only plans cannot replace |

Queued time does not consume runtime budgets. Pause/resume cannot bypass the queue. At most 16 live runs may share a queue.

Policies use existing approved workflow commands and authenticated local transport. No listener, network service, read-only remote command or dependency is added.

The bordered `/workflows` page shows phase progress/barriers, map child counts, output kinds and queue status, retaining header hints and compact single-column layout.

## Script workflows

A script is a second kind of plan on the same engine: a short JavaScript program that decides at run time which agents to start.

Use it when work is shaped by results: review every finding, migrate every directory, research from several angles and merge. It also suits loops and branches. The unchanged static plan above remains the right tool for a fixed graph.

Every `agent()` call is an ordinary workflow task with its own child session. Limits, permissions, cost accounting, cancel, the Agent View, the panel and `/workflows` all apply.

The script itself is not an agent: it is deterministic orchestration code that runs in an isolated process.

```js
export const meta = {
  name: "review-and-verify",
  description: "Review a change on several dimensions, then verify each finding",
  phases: [{ title: "Find" }, { title: "Verify" }],
  budget: { agents: 60, tokens: 3000000, usd: 10, minutes: 45 },
}
phase("Find")
const plan = await agent("List up to 5 review dimensions for " + args.target, { schema: { type: "object", required: ["dimensions"], properties: { dimensions: { type: "array", items: { type: "string" } } } } })
return await pipeline(plan.dimensions, (d) => agent("Review for " + d, { label: "Review: " + d }))
```

Three complete examples live in [`examples/workflows/`](../examples/workflows): `review-and-verify.js` (dimensions, findings, adversarial verification), `migrate-many-files.js` (fan out per directory in worktrees, check each, `merge()` on a reviewed branch, ask, apply) and `research.js` (parallel read agents, then a synthesizer with a schema).

### Running

| Where | Command |
|---|---|
| Terminal chat | `/workflows run <file.js\|name> [key=value ... \| {json}] [--yes]`; without `--yes` it shows the origin, source hash, caps and permission and starts nothing |
| | `/workflows new <name>` writes a commented starter to `workflows/<name>.js` in the data folder; `/workflows convert <plan.json>` writes the script of a JSON plan next to it |
| | `/workflows budget <id> agents=60 usd=5`, `/workflows update <id> <file.js>`, `/workflows resume <id>` |
| CLI | `workflow run <file.js\|name> [key=value ... \| --args JSON] [--yes] [--wait]`, `workflow new <name>`, `workflow convert <plan.json>`, `workflow budget <id> --agents N`, `workflow update <id> <file.js>`, `workflow resume <id>` (`--wait` exits 4 when a run pauses at a cap) |
| Model | the `workflow_script` tool, found with `tool_search`; every call that starts a script asks, in every permission mode, and shows the meta, caps, source hash and the source. `workflow_script` with `help: true` returns the API reference without asking |

Saved scripts are `workflows/<name>.js` in the extension layers, next to the JSON plans. Layers are user folder, user packages, project, project packages; a later layer wins a name.

A saved script from a project layer runs only when the project is trusted (`/tools trust`, `trustedToolDirs`), like custom tools.

Agents of a workflow started by package name can read that package's files without an external-directory prompt. Writes and explicit deny rules still follow normal permissions.

`/workflows` lists script runs with:

- Phase progress and one row per agent call under the label and phase the script gave it.
- Live use of every cap, the log tail and the result or error.
- The reason a run paused when it reached a cap.

Saving a run's revision keeps its source and SHA-256, so a script run is as reproducible as a static one.

### API

The first statement is `export const meta = { ... }`, a pure literal read without running anything.

| Meta field | Meaning |
|---|---|
| `name` | Required |
| `description` | Description |
| `phases: [{ title, detail? }]` | Phases |
| `budget: { agents, tokens, usd, minutes }` | Caps |
| `contract` | Inline or name of a saved contract; verified after the script returns, exactly like a static plan's |
| `permission` | Default when no explicit permission or originating session mode is supplied; never a grant |
| `maxConcurrent` | 1 to 16, default 16 |

Calls, template substitutions and spreads in `meta` are refused with a line number.

| Name | What it does |
|---|---|
| `args` | the arguments the run was started with (frozen, at most 8 KiB) |
| `await agent(prompt, opts)` | one sub-agent; resolves with its final text, or the parsed object when `schema` is given |
| `await parallel([() => ..., ...], { settled })` | runs the thunks together; results keep their order; `settled: true` yields `{ ok, value \| error }` per entry |
| `await pipeline(items, stage1, stage2, ...)` | every item moves to its next stage as soon as its own previous stage ends; a stage returning `undefined` drops the item |
| `await check(command, { label, timeoutSeconds, in, stdin })` | runs a command on the host through the existing check runner; resolves `{ ok, detail, truncated }` and never throws for a failing command; `detail` is an `exit N` line followed by the command's whole output, whether it passed or failed, so a script can read what the command printed (JSON of several KB arrives whole). Past 1024 KB of UTF-8 the output is cut at that size and `truncated` is `true`, never silently; otherwise it is `false`. The task, the events, the panel and the journal keep only the last 1,500 characters; the whole output stays in memory until the script receives it, so when the script replays (after a pause, a resume, an edit or a daemon restart) a check whose output was longer than that tail runs again instead of answering from the journal: use `check()` for commands that are safe to repeat; `in` runs it inside the worktree of an earlier `detail` agent; `stdin` (a string, at most 1024 KB of UTF-8) is written to the command's standard input, which is then closed (without it stdin is ignored). The text is never stored: only its size is kept, the task is labelled "with N KB on stdin", and calls that differ only by stdin stay separate on replay; a larger or non-string `stdin` rejects the call without running anything |
| `await ask(question, options?)` | the question dialog (`y`/`n` on the human task, or answer with an option) |
| `await merge(results, { strategy, message })` | combines the results of `worktree: true, detail: true` agents on a reviewed integration branch, see below |
| `await memo(key, fn)` | runs `fn` once per run; replays reuse the journaled value |
| `phase(title)`, `log(...)`, `await sleep(ms)` | progress, a log line (200 characters, last 10 shown), a journaled timer (at most 5 minutes) |
| `Date`, `Math.random`, `setTimeout` | deterministic replacements, see below |

#### Agent options

| `agent` option | Meaning |
|---|---|
| `label`, `phase` | Label and phase |
| `schema` | JSON Schema subset; validates the answer, gives one automatic repair turn in the same session, then rejects |
| `mode` | `read` is default and cannot change anything; `work` edits, one work agent at a time per directory |
| `worktree: true` | Isolated checkout per run; not held by the single-writer rule, so work agents can run in parallel |
| `model` | Catalog model id |
| `effort` | Needs `model`; checked against its efforts |
| `engine` | Engine, described below |
| `agent` | Profile |
| `allowedTools` | Allowed tools |
| `retry` | Number or `{ maxAttempts, retryOn }` |
| `timeoutMinutes` | Timeout |
| `budget: { tokens, usd }` | Per-agent budget |
| `detail: true` | Resolves `{ text, taskId, workspace }`; for a worktree agent also `branch` and `diff: { commit, files, insertions, deletions, changed }` |

An unknown option is an error, not ignored.

#### Engine, model and effort

`engine` is `native`, `claude`, `codex` or `pi`: the engine the agent's model runs on, as in the `task` tool's `engine`.

The call is checked when made, before any session exists:

- The engine must be configured: a catalog model runs on it.
- The model must belong to it: `model native-a runs on native, not on claude`.
- An unknown model or effort is refused.
- A script that writes the engine as a literal (`engine: "claud"`) is refused at start.

Anything but `native` needs the full tier and an exact `model`. It cannot carry `allowedTools` or a per-agent `budget`, which only the native engine can enforce.

Claude Code and Codex honour the read-only mode of `mode: "read"` agents. ACP agents are refused because they cannot enforce workflow policies.

The row in `/workflows` shows `engine/model`. The usage line breaks agents and tokens down per engine; caps count every engine together, using tokens and cost from the engine's usage events.

#### Worktree results and merge

A `worktree: true` agent works in its own detached checkout. When it finishes, its changes are committed on that worktree's branch (`mend/wf-<run>-<task>`); its `detail` result carries `branch` and the change size.

`merge(results, { strategy, message })` takes such results of the same run. With git on the host, it merges their branches into a scratch integration worktree under the data directory: `workflows/merge/<run>`, branch `mend/merge-<run>`.

Your checkout is not touched by that integration.

| Strategy | Result |
|---|---|
| `strategy: "branch"` | Default; stops there and returns `{ branch, worktree, base, commit, merged, files, insertions, deletions, applied: false }` |
| `strategy: "apply"` | Asks you: `merge` or `keep the branch`, with file and line counts. Only on a yes merges into your checkout, and only with no uncommitted changes. |

A merge that conflicts with your own commits is undone and reported; your checkout is unchanged.

A conflict between worktrees is not a failure:

1. The run pauses with the files and integration worktree path.
2. Resolve and `git add` them there.
3. `resume` continues from the journal. Merging branches already in the integration branch again is a no-op.

MendCode has no other review-and-merge path for worktrees. Compound runs keep their candidates and never merge. No commit or merge ever happens in your checkout without the `apply` approval.

### Determinism, journal and resume

The run is event-sourced. Each call's journal key hashes its kind, prompt and options plus its position among identical calls: the nth `agent("same")`.

Keys do not move when `parallel` or `pipeline` reorder completions. The journal lives in the store next to the run (`workflow_journal`, 96 KiB per entry, 24 MiB per run) and is deleted with the run.

#### Replay after restart

On a daemon restart or `resume`, the script starts again from the top in a fresh host. A call whose key is journaled resolves from the journal without asking the model.

A call in flight when the daemon stopped follows the existing interrupted-task rule: it starts again, at most 3 starts. Finished calls are never repeated; a restart mid-run does not double-start agents.

#### Time, randomness and logs

`Date.now()` and `new Date()` return the run's virtual clock. It only moves to the time of the journaled event that resolved the latest call.

`Math.random()` is seeded from the run id; `setTimeout` is `sleep`. A replay computes the same values and therefore the same calls.

Do not depend on anything else that varies between runs. Keep prompts a function of `args` and earlier results.

Logs are keyed by their index, so a replay does not print them twice.

#### Edit a paused run

`/workflows update <id> <file.js>` on a paused, failed or blocked run swaps the source: new hash, new meta. Then `resume` replays it.

Calls whose prompt and options are unchanged come from the journal; changed and new ones run. A call edited while its agent still runs is cancelled and asked again.

#### Restart test

`packages/daemon/test/workflow-script-restart.test.ts` starts a daemon as a separate process on a temp data directory: real SQLite, real script host, faux engine.

It `kill -9`s it with one `agent()` in flight and two finished, then starts a second daemon on the same directory.

The test checks that the result matches an uninterrupted run, finished calls ran once and the in-flight one ran twice. It found and fixed a lost-answer race: a turn faster than `submit` resolved dropped its events.

### Caps and guard rails

| Cap | Default | Notes |
|---|---|---|
| Concurrent agents | 16 (`maxConcurrent`) | also bounded by the workflow permission and the single-writer rule for non-worktree `work` agents |
| Agent calls per run | 200 hard limit; 10 without a declared `meta.budget.agents` | declaring `agents` is mandatory above 10 |
| `tokens`, `usd` | none | live accounting from the tasks' recorded usage; `usd` needs a known price: with an unpriced model the run pauses ("cost cap cannot be enforced") rather than spending blind |
| `minutes` | none | counted from the start of the run |
| Script size, arguments | 48 KiB, 8 KiB | |
| Run record | 160 KiB, 250 task rows | a finished call keeps only a 120-character result clip in its row (its execution record is dropped); the full answer stays in the journal |

A cap never kills the run. It moves to `paused` with the reason: "agent cap reached (40/40); raise it with `workflow budget` and resume".

Running agents are cancelled and go back to pending; the host stops.

Use `/workflows budget <id> agents=80` to raise or set caps (`workflow.script` command, local clients only). Then `resume` continues from the journal, so only unfinished calls are paid again.

### Security model

A script is code a model or a repository can write, so it never runs in the daemon. Isolation was chosen by testing what this runtime offers, in this order:

1. **A Bun `Worker` with a stripped scope: rejected.** In Bun 1.3 a Worker still has `process`, `Bun`, `fetch`, `import()` and `require`; `resourceLimits` is accepted and ignored; a heap bomb grew the daemon's own process to 5.8 GB. It would share the daemon's address space, so it was not used.
2. **A separate OS process under an OS sandbox: chosen** (`packages/daemon/src/workflow-script-host.ts`). The host is the compiled binary itself (`mendcode __script-host`) or `bun script-host.ts` in development; it works in the compiled binary, which was built and tested.
3. **`node:vm` / ShadowRealm: not used.** `vm` alone is not a security boundary: any object that crosses from the host into the context gives its `constructor.constructor` a way out.

#### Isolation layers

Layers of the chosen design, outermost first:

1. A process the daemon can `SIGKILL`.
2. The OS sandbox.
3. A stripped scope inside the process.
4. Runtime limits.
5. Authority checks.

**Process.** No inherited environment (`PATH` only), working directory `/`, stdin/stdout NDJSON as its only channel. Messages are untrusted data: parsed, size-capped (4 MiB per line), validated by the engine before they do anything.

**OS sandbox.** macOS Seatbelt or Linux bubblewrap (`bwrap`) is generated per run. It denies network, every file write, process creation, and reads of home, daemon data, project and temp directories. The host's own files stay readable.

With no sandbox backend the host refuses to start with an explanatory error. `MENDCODE_SCRIPT_UNSANDBOXED=1` runs it with the other layers only.

When the sandbox exists but does not start, such as a missing binary or bubblewrap without user namespaces, the error is not a script crash. The host runs `true` under the same wrapper (`verify()`).

The message gives the command to run by hand (`bwrap --unshare-user --unshare-pid --unshare-net --ro-bind / / true`), the Ubuntu 24.04 `apparmor_restrict_unprivileged_userns` switch and the explicit unsandboxed way out.

**Stripped scope.** The host captures what it needs, then deletes `process`, `Bun`, `fetch`, `WebSocket`, `Worker`, `performance`, `crypto`, timers, `Buffer`, `WebAssembly`, `Intl`, `console` (it becomes `log`) and the rest.

It replaces every `Function` constructor, including async and generator ones, and `eval`. Shadowed parameters keep the script from naming them.

`import` is syntax, not a global. A lexer scans the source, ignoring strings, comments and regular expressions, and refuses `import(`, `import.meta` and unicode-escaped keywords before the host starts.

**Limits.** A heartbeat runs every second. A watchdog kills the process after 30 s without one, catching a loop that never yields (`while (true) {}`).

A resident-memory check runs every 500 ms with a 256 MB limit, catching a heap bomb. Both limits are tested against real processes, with the stripped scope and OS sandbox on.

A `check()` writes at most 1024 KB to the command's stdin and hands back at most 1024 KB of its output (cut past that, with `truncated: true`). Neither text is stored: the journal keeps the stdin's size and the output's last 1,500 characters, and the daemon holds one whole output in memory only until the script receives it.

**Authority.** Package, project, model and typed-in scripts always go through approval showing meta, declared caps, source hash and source. Project scripts also need a trusted project.

Remote clients and authenticated peers cannot start, preview, save or change a script: `workflow.start`, `workflow.preview`, `workflow.save`, `workflow.script`, and revisions that contain one.

The model tool is excluded from peer turns; the REST adapter does not expose script runs. The daemon sets the script's origin, never the client.

#### Verified and unverified isolation

Verified on macOS (Seatbelt): the stripped scope, all limits above, and that a process with every global reachable still cannot read home or the data directory, write a file, open a socket or create a process.

**Warning:** The authors work on macOS and have not verified the Linux `bwrap` profile. Its arguments are unit tested.

`packages/daemon/test/workflow-script-host.test.ts` has a "Linux bubblewrap (Linux CI only)" suite, skipped on every other platform. It runs the real profile:

- The sandbox starts and a script talks through the API.
- A loop and a heap bomb are killed.
- Home, data, writes and network are denied.

The release workflow installs bubblewrap and allows user namespaces before tests. Until that suite has passed on Linux, treat Linux isolation as unproven.

Also not verified:

- Windows: no script host; workflows with scripts fail with a clear message.
- A hostile script exploiting a bug in Bun or JavaScriptCore itself, which the OS sandbox then has to contain.

Memory is polled, not enforced by the kernel, so a script can exceed the limit for up to 500 ms. The CPU limit is wall time without a heartbeat, not a CPU quota.

### What this does not do

- `engine` cannot reach ACP agents, and a non-native engine cannot carry `allowedTools` or a per-agent budget.
- `merge` needs a git checkout; it merges with plain `git merge` (no strategy options, no rebase), keeps the integration branch and worktree for you to delete, and its `apply` refuses a dirty checkout instead of stashing.
- Map tasks of JSON plans have no automatic conversion (`workflow convert` lists them); write the loop with `parallel`.
- Results are plain JSON, and each journal entry holds at most 96 KiB (24 MiB per run); the store refuses a larger entry with a `RangeError` rather than truncating it.
