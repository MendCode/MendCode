# Independent Workflows

Independent Workflows are durable, one-shot orchestration runs. They own a validated plan, phases, tasks, attempts, artifacts, gates, usage, and a root session. They are separate from recurring `LoopWorkflow` records: use a loop only when cadence or repeated wakeups are part of the request.

## Workflow versus loop

| Surface | Independent Workflow | Loop Workflow |
|---|---|---|
| Purpose | One validated execution | Repeated or scheduled execution |
| Canonical monitor | `/workflows` | `/loops` |
| Identity | Workflow run ID and definition revision | Loop ID and loop run ID |
| Graph | Phases, dependencies, attempts, artifacts | One root iteration plus loop gates |
| Agent View | One `Workflow` root row; child task sessions stay grouped | One `Looping` root row |

A loop can reference a saved Workflow definition. The loop remains responsible for cadence and wakeups; `/workflows` remains responsible for the phase/task graph.

## Plan shape

A plan contains a name, description, objective, phases, tasks, a final task, completion criteria, required gates, and optional completion, model, permission, workspace, retry, and budget policies. Each task declares its phase, dependencies, execution kind, bounded output, and optional route/policy overrides.

## Terminal completion

Completing the task DAG proves that every scheduled task reached its output contract; it does not by itself prove the objective. Plans that declare `completion` use a durable terminal protocol:

1. The finished DAG creates a generation-bound completion candidate and keeps the run non-terminal.
2. A separately leased, fresh read-only child session audits the current workspace. It must actually inspect through read-only tools; a JSON verdict without inspection is rejected.
3. Host-side allowlisted validation checks are rerun and workspace fingerprints before and after the audit must match.
4. Every criterion needs current evidence. `ownerTaskIDs` identify the tasks capable of repairing that criterion.
5. A passing receipt completes the run. A quality failure reopens only failed criterion owners and their descendants, invalidating only their artifacts. Missing ownership, stale evidence, approval, policy, budget, or environment failures remain blocked or retry according to their own gate.

`completion.confirmation` defaults to `next-run` whenever the `completion` block is present. Definitions saved before this contract, or plans that omit the block, retain legacy `same-run` closure. Approval gates remain separate from completion gates: authorizing execution is not evidence that the objective succeeded.

Example completion policy:

```json
{
  "completion": {
    "confirmation": "next-run",
    "maxAuditAttempts": 2,
    "criteria": [
      {
        "id": "tests-green",
        "description": "Focused regression tests pass",
        "ownerTaskIDs": ["implement", "verify"]
      }
    ],
    "validationChecks": [
      {
        "id": "focused-tests",
        "command": "bun test test/session/example.test.ts",
        "timeoutMs": 30000
      }
    ]
  }
}
```

### Representative fan-out template

For a bounded repository investigation, use this phase shape:

| Phase | Tasks | Barrier and output |
|---|---:|---|
| Investigate | 8 independent agents | `all`; bounded evidence artifacts |
| Draft | 1 synthesis task | waits for investigators; one review draft |
| Verify | 6 independent verifiers | `all`; structured pass/fail artifacts |
| Synthesize | 1 final synthesis task | waits for verifiers; final report |

Set `budget.maxFanOut` and `budget.maxConcurrency` to the intended limits, require verification artifacts before synthesis, and make the final synthesis task the plan's `finalTaskID`. Preview this graph before saving or starting it.

Preview a new plan before starting it:

```bash
mend workflows preview --plan-file ./plan.json
```

The preview validates the graph and reports phase count, task count, bounded fan-out, concurrency, estimated budgets, and side-effect classes. Preview does not create a run.

## CLI controls

Save an immutable revision:

```bash
mend workflows save --plan-file ./plan.json --name "Repository review"
```

Start a one-shot run from a plan or saved revision:

```bash
mend workflows start --plan-file ./plan.json
mend workflows start --revision-id <revision-id>
```

Inspect and list runs:

```bash
mend workflows list
mend workflows show <run-id>
mend workflows events <run-id> --limit 50
mend workflows artifacts <run-id> --limit 50
```

Control a run through the durable backend contract:

```bash
mend workflows pause <run-id> --reason "Waiting for review"
mend workflows resume <run-id>
mend workflows stop <run-id> --reason "No longer needed"
mend workflows delete <run-id>
mend workflows retry-task <run-id> --task-id <task-id>
mend workflows retry-phase <run-id> --phase-id <phase-id>
```

Control actions rehydrate the canonical snapshot and start or stop the runner as appropriate. A retry does not mutate the saved definition revision.

## Session tool

The assistant-facing `workflow` tool supports preview, save, start, list/show, pause, resume, stop, retry-task, and retry-phase actions. Prefer `preview` for a new plan. Snapshots and receipts are bounded; request artifacts or events explicitly instead of exposing full child transcripts.

The chat receipt shows the workflow name, state, phase/task counts, elapsed time, model/agent, usage when available, blocker or next action, and an explicit link to `/workflows`. Child transcripts remain hidden until the operator opens the linked task/session.

## TUI monitor

Open the dedicated monitor with `/workflows`. It uses the shared `CommandDeck` layout:

- The left rail selects active or historical runs.
- The center shows the selected run, phases, tasks, blockers, and recent events.
- The context panel shows the objective and linked root session.
- The monitor refreshes from workflow events and a bounded polling fallback.

Keyboard controls are:

| Key | Action |
|---|---|
| `j` / `k` or arrows | Select a run |
| `Enter` / `o` | Open the linked root/origin chat |
| `p` | Pause |
| `u` | Resume |
| `x` | Stop after confirmation |
| `d` | Delete a terminal run after confirmation |
| `t` | Retry the selected eligible task |
| `f` | Retry the selected eligible phase |
| `r` | Rehydrate the canonical snapshot |
| `q` / `Esc` | Return to the previous route |

Agent View shows one distinct Workflow root row with state, current phase, completed/total tasks, active tasks, and blocked or input-needed indicators. If the root or origin session is unavailable, the row remains visible and opens the `/workflows` monitor by run ID.

## API surface

The instance API exposes these additive endpoints:

```text
POST   /workflow/preview
POST   /workflow/save
POST   /workflow/start
GET    /workflow
GET    /workflow/:runID
DELETE /workflow/:runID
GET    /workflow/:runID/events
GET    /workflow/:runID/artifacts
POST   /workflow/:runID/pause
POST   /workflow/:runID/resume
POST   /workflow/:runID/stop
POST   /workflow/:runID/retry-task
POST   /workflow/:runID/retry-phase
```

`GET /workflow/:runID` is the canonical durable snapshot used to rehydrate the monitor after reconnects or event loss. Runs are project-scoped by the instance context, and control routes enforce the backend policy/state contract rather than trusting local UI state.

## Safety and limits

- Plan validation rejects cycles and invalid phase/task references before execution.
- Workflow policy is narrowed by task policy; a task cannot escalate permissions, workspace access, or side-effect classes.
- Report-only and read-only modes deny edits, mutating commands, and external sends.
- Required gates remain durable and cannot be waived by model output.
- Strict completion runs cannot become `completed` without a current audit receipt; leases and generations reject duplicate, late, or post-restart stale audit results.
- Fan-out, concurrency, depth, child, runtime, token, cost, artifact, and event limits remain bounded.
- Actual agent attempts reuse the durable `BackgroundTask` supervisor; Workflow owns graph readiness while BackgroundTask owns task leases, generations, cancellation, and bounded results.
- Full child output is not rendered in the chat receipt or Agent View by default.

## Release and rollout

One-shot Workflow execution is additive and can be enabled independently from loop-triggered adapters. Keep the loop adapter behind the scheduler durability evidence and service-health gate. Existing Loop records and `/loops` behavior remain unchanged when no Workflow reference is present.

─── ?DOC | 1 doc creado
