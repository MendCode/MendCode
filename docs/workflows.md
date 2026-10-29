# Workflows

The opt-in HTTP routes and donor payload support are documented in [Workflow REST adapter](workflow-rest.md).

For bounded single/cascade/critic candidates with immutable review and request/token/cost/time accounting,
see [Compound orchestration](compound.md). These opt-in runs keep isolated worktrees and never automatically replay after restart.

A workflow is a plan of tasks that run in dependency order, each agent task in its own child session, followed by a completion contract that decides whether the work is done. It is started from chat (`/workflows`, or the model's `workflow_start` tool, which asks for approval), from the CLI (`mendcode workflow start`), and followed in `/workflows`.

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
- `permission` is a request: the applied permission is the lower of it and what the user granted.

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
- The auditor is a read-only session asked only about the criteria no check covers (`auto`), about all of them (`independent`), or never (`none`, reported as unverified). Its verdict is void if it inspected nothing or the workspace changed while it ran. An auditor that shows no activity for 10 minutes is stopped (`audit stalled: no activity for 10 min`); one that keeps working runs as long as it needs, up to an hour (`audit still running after 60 min`). A stalled, failed or unstarted audit is asked again in a new read-only session, with the same check results, three times in all; only then does the run wait as `blocked` (`… (3 attempts)`). Your own cancel of the auditor blocks at once. Loops use the same auditor rules. The detail in `/workflows` shows `round N — did not finish` with the keys to continue: `v` verifies again, `b` shows the evidence and `a` accepts.
- A rejection sends the owners of what failed (and their dependents) back with the failure as feedback. When repairs run out, or no owner is declared, the run is **blocked**: `resume`/`verify` checks again, `accept` records a reason and completes it.
- Every check command is shown verbatim before anything starts, because checks run outside the model's permission system.

## Controls

`pause` lets running tasks finish and starts nothing new · `resume` continues (and re-verifies a blocked run) · `stop` cancels the workflow's own turns and ends it · `retry` runs one task and its dependents again · `verify` · `accept` (with a reason) · `delete` (finished runs only; their sessions go too). Cancelling a task's turn yourself pauses the run.

On `/workflows`: `↑↓` run · `←→` task · `enter` open the task's session · `p` pause/resume · `x` stop · `t` retry · `v` verify · `a` accept · `d` delete · `tab` this project / all.

`b` opens the run's evidence ledger: `1` events, `2` artifacts, `3` completion receipts, `↑↓` entry, `pgup/pgdn` detail, `[`/`]` newer/older pages, `r` refresh. `e` previews a JSON export, `m` Markdown, `y` copies the export, `esc` returns. Panels fill the page; below 70 columns the ledger stacks in one column.

`workflow.events`, `workflow.artifacts`, `workflow.receipt`, `workflow.export` accept `limit` (50 by default, maximum 100; receipts default to 1), `before` (exclusive sequence cursor), and optional `run` (workflow run number is 0). Export returns text and pagination metadata, creates no file and uses `format: json | markdown`. Events follow actual state/task transitions; artifacts preserve frozen plans/hashes, task attempts/results, gates, audit judgments, verification rounds and overrides. Receipts distinguish verified completion from manual acceptance and missing verification. The ledger is stored separately and atomically with the run, capped at 512 entries; the newest artifact/receipt per key is protected during trimming. Pages also fit the protocol byte budget. Oversized individual data retains an explicit byte count and SHA-256 digest. Existing runs are seeded from their available snapshot and labelled `historical: false`; missing history is never invented. Deletion and workflow retention remove their ledgers. These content-bearing commands are unavailable to read-only remote tokens.

## Guarantees

A task waits for input only while its session has an open request; after a restart running tasks are re-derived, never left waiting. A verification that finishes after the run moved on is ignored. The daemon loads nothing for workflows until one is started or a live run exists at boot. One stored row per run (at most 160 KB) and at most 50 finished runs.

## Definitions and immutable revisions (B21)

`workflow save <file.json|name>` (or `workflows save --plan-file FILE`) validates the v2 plan, resolves its named contract now, and stores an immutable revision without running checks or creating sessions. The receipt contains `definitionId`, `revisionId`, a positive revision number, and a SHA-256 `planHash` over canonical JSON. `--definition-id ID` appends a revision; previous plans and contracts remain unchanged. Optional `--name`, `--description` and `--source manual|saved|template|package|session-generated` describe the definition. No v1 JSON conversion is implicit: v1 phase/model/workspace fields must be adapted to the existing v2 task/contract format.

`workflow definitions [--limit 50]` lists project metadata; `workflow revision <revision-id>` reads a full frozen plan. `workflow preview|start --definition-id ID` selects the current revision; `--revision-id ID` selects an exact revision. Starting still requires `--yes`, and permissions never exceed the user's grant. Inline/named starts also receive an immutable revision (`saved: false`). Existing runs without revision metadata remain readable. Revisions survive run deletion and finished-run retention; each is bounded to 128 KiB.

`control-plane workflows status` aliases project-scoped `workflow list`. `control-plane workflows retry-task <run-id> --task-id <task-id> [--reason TEXT] [--wait --timeout S]` retries failed, skipped, stopped or input-waiting tasks and their dependents. An input-waiting turn is cancelled before retry. Completed/stopped runs reject retry; manual retries preserve the existing attempt counter. Waiting follows pushed events, with the same completion/failure/input/timeout exit codes as start.

Plans accept `human` tasks (`{kind:"human", id, title, prompt, needs}`: wait for you, approve with `workflow approve <id> --task T`, reject with `workflow reject`, or `y`/`n` in the workflows page), a per-task `retry` (`maxAttempts` 1-6, `backoffMs`, `retryOn` of transient, environment, policy, quality, budget, user_input, terminal; off unless set) and a per-plan `retention` (`maxArtifacts`, `maxAgeMs`, `maxBytes`, applied to the ledger). Model tools: `workflow_events` and `workflow_artifacts` read a project workflow's recorded events and artifacts (redacted, 12k characters, `before` cursor); `workflow_save` saves/revises; `workflow_start` accepts inline plans, layer names or definition/revision refs; `workflow_control` offers pause/resume/stop/retry/delete through normal execution approval. Resume/retry approval shows every frozen check command; smart permissions always ask for autonomous controls. All model access stays in the current project. `workflow_status` includes revision identity. Event/artifact ledgers and phase retry remain separate audit batches. The `/workflows` page shows frozen revision identity, tasks and verification in the shared bordered panel grid, with header hints and one column below 70 cells.

Protocol additions: `workflow.save`, `workflow.definitions`, `workflow.revision.get`; client helpers: `saveWorkflow`, `workflowDefinitions`, `workflowRevision`. None is exposed to read-only remote tokens, because full plan/metadata content may contain user text. They use the existing authenticated transport; no listener, service or dependency is added.

## Task routing and limits (B45)

Plans and agent tasks accept optional `model: { model, variant?, effort?, parameters? }`, `agent`, `permissions`, `workspace` and `budget`. Agent tasks also accept `permission` and `allowedTools`. Existing plans keep working. Set the independent workflow default in `/model`'s `workflow` row, a recipe's `roles.workflow`, or `settings.models.workflow`. Task model wins over plan model, then the workflow role, the agent's own model and the origin session/main model. A default workflow variant is applied only with its own model, never to explicit plan/task choices. ACP and Claude Code models are rejected for task routing because they cannot enforce native workflow policies. Effective settings are frozen on the task and survive retries/restart; `/workflows` shows the selected task's route, workspace and consumed limits. Client helpers `startWorkflow` and `getWorkflow` carry the same typed plan/run.

`permissions` supports `mode: normal | report-only | custom`, exact-name `allowedTools`, `approvalRequiredFor`, `approvedActions`, `allowEdits`, `allowMutatingCommands`, and `allowExternalSend`. Workflow, task and agent restrictions compose; nothing increases the user's grant. Allowlists intersect, false side-effect flags win, and contradictions are rejected during validation. Approval-required actions still ask in full mode. In custom mode, side effects outside `approvedActions` ask; approved actions remain subject to session grants and global rules. Read-only tasks cannot exit plan mode, delegate, send through MCP/custom tools or run host checks. Restrictions also apply to delegated child sessions. No remote read-only command is added.

Workspace defaults to `in-place`. `read-only` caps side effects; `per-run-worktree` creates a detached worktree under `<data dir>/workflows/workspaces`, shared by all tasks when set on the plan and isolated per task when set on that task. `per-loop-worktree` reuses its origin session's lease; without an origin it uses the run. Worktrees contain committed HEAD, excluding uncommitted source edits. They are retained, including on completion, for manual review; no automatic commit, promotion, merge or deletion. Checks and completion verification use a plan's shared worktree. Task-isolated outputs are not automatically copied to dependent workspaces; use a plan workspace when tasks must share files.

Budgets accept `maxTurns` (provider calls), `maxRuntimeMs`, `maxTokens` (input + output, without counting reasoning/cache twice), `maxCost` (USD), `maxChildren` and `maxDepth` (workflow task is depth 1). Plan token/cost/call/child caps are aggregate; task caps are narrower. Usage and child reservations accumulate across retries and children. Task runtime limits apply per attempt; a plan runtime limit and `maxRuntimeMinutes` cap the whole run. Zero is a real limit. Reported token/cost exhaustion cancels the owned turn and blocks dependent work; an unknown price fails closed for a cost cap. A provider request can cross a token/cost cap before it reports usage; no subsequent work is allowed. Limits and worktree isolation are opt-in; no service, listener or dependency is added.

## Phases, map outputs and overlap (B78)

Optional `phases` are ordered v2 descriptors: `{ id, title, tasks: [taskId], barrier }`. Every declared task belongs to exactly one phase. Dependencies cannot point into a later phase. Barriers are `{ kind: "all" }` (default), `{ kind: "quorum", quorum: N }`, `{ kind: "best-effort" }`, or `{ kind: "condition", expression: "true|all|completed|false" }`. All requires every task to succeed; quorum releases the next phase as soon as N succeed; best-effort waits for every task to finish, including failures. Conditions preserve v1's deterministic all-success aliases; `false` never releases. Arbitrary expressions are rejected, never evaluated. Explicit `needs` still require successful producers. Impossible barriers skip later work. All active tasks drain before completion; a satisfied quorum/best-effort phase can tolerate failures. Retrying a task invalidates dependent outputs and later phases; contract repair uses the same invalidation.

Agent `output` contracts support `text` (optional `maxChars`, at most 8000), `json` (optional `schema`), `artifact` (`artifactKind`, optional `schema`) and `none`. The prompt requests a fenced `WORKFLOW_OUTPUT` block before `TASK_RESULT`; raw JSON or a fenced `json` block also works. Schema validation supports type unions, properties, required, additionalProperties, items, enum, const, numeric/string/array bounds and allOf/anyOf/oneOf. Unsupported keywords fail preview instead of being silently ignored. Schemas are bounded to 12 nesting levels. Artifacts without a schema may be plain text. Values are durable data inside the run, not filesystem writes or a new artifact ledger. Summaries/events expose only output kinds, never output values or map items.

Consumers declare `inputs: [{ taskId, path?, projection?, required? }]`. Producers must be transitive dependencies. Selectors use dotted paths or JSON pointers; projection is a second path selection. Missing required values fail the consumer before submission; `required: false` yields no value. Prototype traversal is rejected. Selected inputs and map items are fenced as untrusted data, with no authority to run tools or change grants.

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

Map expansion reserves at most 16 items per map and 32 total tasks at validation. An oversized/non-array source fails rather than truncates. Child IDs are `<map-id>-<1-based-index>`; the frozen plan/hash is unchanged. Templates use existing agent task routing, permissions, workspaces, budgets and timeouts. Children obey the shared concurrency cap and directory work mutex; the map orchestrator consumes no agent slot. Successful children produce an ordered JSON array for downstream tasks, including an empty array for zero items. Retrying a map or any failed child rebuilds that map and its dependents, cancelling only owned live turns. Restart resumes interrupted children without duplicating the expansion. Composed plans are bounded to 48 KiB, each value/item to 8000 characters, and aggregate output/item storage to 24 KiB within the existing 160 KiB run limit.

Overlap is opt-in; plans without it retain legacy start behavior. `skip` returns the existing live run without creating sessions. `queue` persists FIFO links and starts only after all earlier matching runs finish/stop/are deleted, including legacy overlapping runs; queued time does not consume runtime budgets. Pause/resume cannot bypass the queue. At most 16 live runs may share a queue. `replace` stops prior matching runs and cancels their owned turns/checks/audits before starting the replacement; read-only/report-only plans cannot replace. Matching uses project directory plus `overlapKey` (default plan name). Policies use existing approved workflow commands and authenticated local transport: no listener, network service, read-only remote command or dependency is added. The bordered `/workflows` page shows phase progress/barriers, map child counts, output kinds and queue status, retaining header hints and compact single-column layout.

## Script workflows

A script is a second kind of plan on the same engine: a short JavaScript program that decides at run time which agents to start. Use it when the work is shaped by results (review every finding, migrate every directory, research from several angles and merge) or needs loops and branches. A static plan above stays the right tool for a fixed graph and is unchanged.

Every `agent()` call is an ordinary workflow task with its own child session, so limits, permissions, cost accounting, cancel, the Agent View, the panel and `/workflows` all apply. The script itself is not an agent: it is deterministic orchestration code that runs in an isolated process.

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

Saved scripts are `workflows/<name>.js` in the extension layers, next to the JSON plans: user folder, user packages, project, project packages; a later layer wins a name. A saved script from a project layer runs only when the project is trusted (`/tools trust`, `trustedToolDirs`), like custom tools. `/workflows` lists script runs with phase progress, one row per agent call under the label and phase the script gave it, the live use of every cap, the log tail and the result or error. A run that reached a cap shows why it paused. Saving a run's revision keeps its source and SHA-256, so a script run is as reproducible as a static one.

### API

The first statement is `export const meta = { ... }`, a pure literal read without running anything: `name` (required), `description`, `phases: [{ title, detail? }]`, `budget: { agents, tokens, usd, minutes }`, `contract` (inline or the name of a saved contract; verified after the script returns, exactly like a static plan's), `permission` (a request, never a grant), `maxConcurrent` (1 to 16, default 16). Calls, template substitutions and spreads in `meta` are refused with a line number.

| Name | What it does |
|---|---|
| `args` | the arguments the run was started with (frozen, at most 8 KiB) |
| `await agent(prompt, opts)` | one sub-agent; resolves with its final text, or the parsed object when `schema` is given |
| `await parallel([() => ..., ...], { settled })` | runs the thunks together; results keep their order; `settled: true` yields `{ ok, value \| error }` per entry |
| `await pipeline(items, stage1, stage2, ...)` | every item moves to its next stage as soon as its own previous stage ends; a stage returning `undefined` drops the item |
| `await check(command, { label, timeoutSeconds, in })` | runs a command on the host through the existing check runner; resolves `{ ok, detail }` and never throws for a failing command; `in` runs it inside the worktree of an earlier `detail` agent |
| `await ask(question, options?)` | the question dialog (`y`/`n` on the human task, or answer with an option) |
| `await merge(results, { strategy, message })` | combines the results of `worktree: true, detail: true` agents on a reviewed integration branch, see below |
| `await memo(key, fn)` | runs `fn` once per run; replays reuse the journaled value |
| `phase(title)`, `log(...)`, `await sleep(ms)` | progress, a log line (200 characters, last 10 shown), a journaled timer (at most 5 minutes) |
| `Date`, `Math.random`, `setTimeout` | deterministic replacements, see below |

`agent` options: `label`, `phase`, `schema` (JSON Schema subset; the answer is validated and gets one automatic repair turn in the same session, then the call rejects), `mode` (`read`, the default, cannot change anything; `work` edits, one work agent at a time per directory), `worktree: true` (an isolated checkout per run: such agents are not held by the single-writer rule, so work agents can run in parallel), `model` (a catalog model id), `effort` (needs `model`; checked against the model's efforts), `engine`, `agent` (a profile), `allowedTools`, `retry` (a number or `{ maxAttempts, retryOn }`), `timeoutMinutes`, `budget: { tokens, usd }`, `detail: true` (resolves `{ text, taskId, workspace }`, and for a worktree agent also `branch` and `diff: { commit, files, insertions, deletions, changed }`). An unknown option is an error, not ignored.

**Engine, model, effort.** `engine` is `native`, `claude`, `codex` or `pi`: the engine the agent's model runs on, as in the `task` tool's `engine`. The call is checked when it is made, before any session exists: the engine must be configured (a catalog model runs on it), the model must belong to it (`model native-a runs on native, not on claude`), an unknown model or effort is refused, and a script that writes the engine as a literal (`engine: "claud"`) is refused at start. Anything but `native` needs the full tier and an exact `model`, and cannot carry `allowedTools` or a per-agent `budget`, which only the native engine can enforce; Claude Code and Codex honour the read-only mode of `mode: "read"` agents. ACP agents are refused (they cannot enforce workflow policies). The row in `/workflows` shows `engine/model`, the run's usage line breaks agents and tokens down per engine, and the run's caps count every engine together (tokens and cost come from the engine's usage events).

**Worktree results and `merge`.** A `worktree: true` agent works in its own detached checkout. When it finishes, its changes are committed on a branch of that worktree (`mend/wf-<run>-<task>`) and its `detail` result carries `branch` and the size of the change. `merge(results, { strategy, message })` takes such results of the same run and, with git on the host, merges their branches into a scratch integration worktree under the data directory (`workflows/merge/<run>`, branch `mend/merge-<run>`); your checkout is not touched. `strategy: "branch"` (the default) stops there and returns `{ branch, worktree, base, commit, merged, files, insertions, deletions, applied: false }`. `strategy: "apply"` then asks you (`merge` or `keep the branch`, with the file and line counts) and only on a yes merges that branch into your checkout, and only when the checkout has no uncommitted changes; a merge that conflicts with your own commits is undone and reported, your checkout unchanged. A conflict between worktrees is not a failure: the run pauses with the files and the integration worktree path, you resolve and `git add` them there, and `resume` continues from the journal (merging branches already in the integration branch again is a no-op). MendCode has no other review-and-merge path for worktrees (compound runs keep their candidates and never merge), so this is the whole of it: no commit or merge ever happens in your checkout without the `apply` approval.

### Determinism, journal and resume

The run is event-sourced. Each call is journaled under a key that is the hash of its kind, prompt and options plus the position of that call among identical calls (the nth `agent("same")`), so the keys do not move when `parallel` or `pipeline` reorder completions. The journal lives in the store next to the run (`workflow_journal`, 96 KiB per entry, 24 MiB per run) and is deleted with the run.

- **Tested with a real kill.** `packages/daemon/test/workflow-script-restart.test.ts` starts a daemon as a separate process on a temp data directory (real SQLite, real script host, faux engine), `kill -9`s it with one `agent()` in flight and two finished, starts a second daemon on the same directory and checks that the run completes with the same result as an uninterrupted run, the finished calls ran once and the in-flight one ran twice. (That test found and fixed a lost-answer race: a turn that ran faster than `submit` resolved dropped its events.)
- **Replay.** On a daemon restart or `resume` the script starts again from the top in a fresh host. A call whose key is journaled resolves from the journal without asking the model. A call that was in flight when the daemon stopped follows the existing interrupted-task rule (it starts again, at most 3 starts). Calls that finished are never repeated, and a restart mid-run does not double-start agents.
- **Time and randomness.** `Date.now()` and `new Date()` return the run's virtual clock, which only moves to the time of the journaled event that resolved the latest call; `Math.random()` is seeded from the run id; `setTimeout` is `sleep`. So a replay computes the same values and therefore the same calls. Do not depend on anything else that varies between runs, and keep prompts a function of `args` and earlier results.
- **Editing.** `/workflows update <id> <file.js>` on a paused, failed or blocked run swaps the source (new hash, new meta) and `resume` replays it: calls whose prompt and options are unchanged come from the journal, changed and new ones run. A call that is edited while its agent still runs is cancelled and asked again.
- **Logs** are keyed by their index, so a replay does not print them twice.

### Caps and guard rails

| Cap | Default | Notes |
|---|---|---|
| Concurrent agents | 16 (`maxConcurrent`) | also bounded by the workflow permission and the single-writer rule for non-worktree `work` agents |
| Agent calls per run | 200 hard limit; 10 without a declared `meta.budget.agents` | declaring `agents` is mandatory above 10 |
| `tokens`, `usd` | none | live accounting from the tasks' recorded usage; `usd` needs a known price: with an unpriced model the run pauses ("cost cap cannot be enforced") rather than spending blind |
| `minutes` | none | counted from the start of the run |
| Script size, arguments | 48 KiB, 8 KiB | |
| Run record | 160 KiB, 250 task rows | a finished call keeps only a 120-character result clip in its row (its execution record is dropped); the full answer stays in the journal |

A cap never kills the run. It moves to `paused` with the reason ("agent cap reached (40/40); raise it with `workflow budget` and resume"), running agents are cancelled and go back to pending, the host stops. `/workflows budget <id> agents=80` raises or sets caps (`workflow.script` command, local clients only) and `resume` continues from the journal, so only unfinished calls are paid again.

### Security model

A script is code a model or a repository can write, so it never runs in the daemon. Isolation was chosen by testing what this runtime offers, in this order:

1. **A Bun `Worker` with a stripped scope: rejected.** In Bun 1.3 a Worker still has `process`, `Bun`, `fetch`, `import()` and `require`; `resourceLimits` is accepted and ignored; a heap bomb grew the daemon's own process to 5.8 GB. It would share the daemon's address space, so it was not used.
2. **A separate OS process under an OS sandbox: chosen** (`packages/daemon/src/workflow-script-host.ts`). The host is the compiled binary itself (`mendcode __script-host`) or `bun script-host.ts` in development; it works in the compiled binary, which was built and tested.
3. **`node:vm` / ShadowRealm: not used.** `vm` alone is not a security boundary: any object that crosses from the host into the context gives its `constructor.constructor` a way out.

Layers of the chosen design, outermost first:

- A process the daemon can `SIGKILL`: no inherited environment (`PATH` only), working directory `/`, stdin/stdout NDJSON as its only channel. Messages from it are untrusted data: parsed, size-capped (4 MiB per line), validated by the engine before they do anything.
- The OS sandbox: macOS Seatbelt or Linux bubblewrap (`bwrap`), generated per run. Network denied, every file write denied, process creation denied, reads of the home folder, the daemon's data directory, the project and the temp directories denied (the host's own files stay readable). With no sandbox backend the host refuses to start with an explanatory error; `MENDCODE_SCRIPT_UNSANDBOXED=1` runs it with the other layers only. When the sandbox exists but does not start (a missing binary, bubblewrap without user namespaces), the error is not a script crash: the host runs `true` under the same wrapper (`verify()`) and the message gives the command to run by hand (`bwrap --unshare-user --unshare-pid --unshare-net --ro-bind / / true`), the Ubuntu 24.04 `apparmor_restrict_unprivileged_userns` switch and the explicit unsandboxed way out.
- A stripped scope inside the process: the host captures what it needs, then deletes `process`, `Bun`, `fetch`, `WebSocket`, `Worker`, `performance`, `crypto`, timers, `Buffer`, `WebAssembly`, `Intl`, `console` (it becomes `log`) and the rest, replaces every `Function` constructor (including the async and generator ones) and `eval`, and runs the script with shadowed parameters so it cannot name them. `import` is syntax, not a global, so the source is scanned with a lexer that ignores strings, comments and regular expressions and refuses `import(`, `import.meta` and unicode-escaped keywords before the host starts.
- Limits: a heartbeat every second and a watchdog that kills the process after 30 s without one (a loop that never yields, `while (true) {}`), and a resident-memory check every 500 ms with a 256 MB limit (a heap bomb). Both are tested against real processes, with the stripped scope and with the OS sandbox on.
- Authority: package, project, model and typed-in scripts always go through an approval that shows meta, declared caps, source hash and the source. Project scripts also need a trusted project. Remote clients and authenticated peers cannot start, preview, save or change a script (`workflow.start`, `workflow.preview`, `workflow.save`, `workflow.script`, and revisions that contain one), the model tool is excluded from peer turns, and the REST adapter does not expose script runs. The origin of a script is set by the daemon, never taken from the client.

Verified on macOS (Seatbelt): the stripped scope, all of the limits above, and that a process with every global reachable still cannot read the home folder or the data directory, write a file, open a socket or create a process. **Not verified by its authors, who work on macOS:** the Linux `bwrap` profile. Its arguments are unit tested, and `packages/daemon/test/workflow-script-host.test.ts` has a "Linux bubblewrap (Linux CI only)" suite (skipped on every other platform) that runs the real profile: the sandbox starts, a script talks through the API, a loop and a heap bomb are killed, home, data, writes and network are denied. The release workflow installs bubblewrap and allows user namespaces before the tests; until that suite has passed on Linux, treat the Linux isolation as unproven. Also not verified: Windows (no script host: workflows with scripts fail with a clear message), and a hostile script that exploits a bug in Bun or JavaScriptCore itself, which the OS sandbox then has to contain. Memory is polled, not enforced by the kernel, so a script can exceed the limit for up to 500 ms. The CPU limit is wall time without a heartbeat, not a CPU quota.

### What this does not do

- `engine` cannot reach ACP agents, and a non-native engine cannot carry `allowedTools` or a per-agent budget.
- `merge` needs a git checkout; it merges with plain `git merge` (no strategy options, no rebase), keeps the integration branch and worktree for you to delete, and its `apply` refuses a dirty checkout instead of stashing.
- Map tasks of JSON plans have no automatic conversion (`workflow convert` lists them); write the loop with `parallel`.
- Results are plain JSON, and each journal entry holds at most 96 KiB (24 MiB per run); the store refuses a larger entry with a `RangeError` rather than truncating it.
