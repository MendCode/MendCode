import { Effect, Option, Schema } from "effect"

import * as Tool from "./tool"
import DESCRIPTION from "./workflow.txt"
import { Workflow } from "@/session/workflow"
import { SessionID } from "@/session/schema"
import { WorkflowPlan } from "@/session/workflow-plan"
import type { WorkflowPlan as WorkflowPlanInput } from "@/session/workflow-plan"
import { WorkflowRunner } from "@/session/workflow-runner"
import { WorkflowService } from "@/session/workflow-service"

const Action = Schema.Literals(["preview", "save", "start", "list", "show", "pause", "resume", "stop", "retry_task", "retry_phase"])

export const Parameters = Schema.Struct({
  action: Action.annotate({
    description: "Workflow action. Preview or save a plan before starting it; use show/list for bounded inspection and controls for an existing run.",
  }),
  runID: Schema.optional(Schema.String).annotate({ description: "Workflow run ID for show, controls, or retry actions." }),
  revisionID: Schema.optional(Schema.String).annotate({ description: "Saved immutable workflow revision to start." }),
  definitionID: Schema.optional(Schema.String).annotate({ description: "Saved workflow definition whose current revision should start." }),
  plan: Schema.optional(WorkflowPlan).annotate({ description: "Validated declarative workflow plan for preview, save, or direct start." }),
  name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  source: Schema.optional(Schema.Literals(["session-generated", "saved", "template", "package", "manual"])),
  saved: Schema.optional(Schema.Boolean),
  originSessionID: Schema.optional(Schema.String),
  overlapKey: Schema.optional(Schema.String),
  taskID: Schema.optional(Schema.String).annotate({ description: "Task ID for retry_task." }),
  phaseID: Schema.optional(Schema.String).annotate({ description: "Phase ID for retry_phase." }),
  reason: Schema.optional(Schema.String),
})

export type Metadata = {
  action: Schema.Schema.Type<typeof Action>
  count?: number
  runID?: string
  state?: Workflow.WorkflowRunState
  definitionID?: string
  revisionID?: string
  phaseCount?: number
  taskCount?: number
  objective?: string
  model?: { providerID: string; modelID: string; variant?: string }
  agent?: string
  originSessionID?: string
  rootSessionID?: string
  createdAt?: number
  updatedAt?: number
  inputTokens?: number
  outputTokens?: number
  cost?: number
}

type Snapshot = WorkflowService.WorkflowSnapshot

function requireValue<A>(value: A | undefined, name: string) {
  if (value === undefined) return Effect.fail(new Error(`${name} is required for this workflow action.`))
  return Effect.succeed(value)
}

function snapshotMetadata(snapshot: Snapshot): Metadata {
  const model = snapshot.revision.plan.model
  return {
    action: "show",
    runID: snapshot.run.id,
    state: snapshot.run.state,
    definitionID: snapshot.definition.id,
    revisionID: snapshot.revision.id,
    phaseCount: snapshot.phases.length,
    taskCount: snapshot.tasks.length,
    objective: snapshot.revision.plan.objective,
    ...(model ? { model: { providerID: model.providerID, modelID: model.modelID, ...(model.variant ? { variant: model.variant } : {}) } } : {}),
    ...(snapshot.run.originSessionID ? { originSessionID: snapshot.run.originSessionID } : {}),
    ...(snapshot.run.rootSessionID ? { rootSessionID: snapshot.run.rootSessionID } : {}),
    createdAt: snapshot.run.createdAt,
    updatedAt: snapshot.run.updatedAt,
    ...(snapshot.usage?.inputTokens === undefined ? {} : { inputTokens: snapshot.usage.inputTokens }),
    ...(snapshot.usage?.outputTokens === undefined ? {} : { outputTokens: snapshot.usage.outputTokens }),
    ...(snapshot.usage?.cost === undefined ? {} : { cost: snapshot.usage.cost }),
  }
}

function snapshotOutput(snapshot: Snapshot) {
  const phases = snapshot.phases.map((phase) => `${phase.ordinal}. ${phase.name}: ${phase.state} (${phase.counts.completed}/${phase.counts.total})`)
  const tasks = snapshot.tasks.slice(0, 24).map((task) => `- ${task.id}: ${task.state}${task.blocker ? ` — ${task.blocker}` : ""}`)
  return [
    `run_id: ${snapshot.run.id}`,
    `definition_id: ${snapshot.definition.id}`,
    `revision_id: ${snapshot.revision.id}`,
    `state: ${snapshot.run.state}`,
    `name: ${snapshot.definition.name}`,
    `phases: ${snapshot.phases.length}`,
    `tasks: ${snapshot.tasks.length}`,
    phases.length ? ["phases:", ...phases].join("\n") : "phases: none",
    tasks.length ? ["tasks:", ...tasks].join("\n") : "tasks: none",
    snapshot.artifacts.length ? `artifacts: ${snapshot.artifacts.length}` : "artifacts: none",
    snapshot.gates.length ? `gates: ${snapshot.gates.length}` : "gates: none",
  ].join("\n")
}

function receiptOutput(receipt: WorkflowService.WorkflowRevisionReceipt) {
  return [
    `definition_id: ${receipt.definitionID}`,
    `revision_id: ${receipt.revisionID}`,
    `revision: ${receipt.revision}`,
    `name: ${receipt.plan.name}`,
    `phases: ${receipt.preview.phaseCount}`,
    `tasks: ${receipt.preview.taskCount}`,
    `max_concurrency: ${receipt.preview.maxConcurrency}`,
    `max_fan_out: ${receipt.preview.maxFanOut}`,
  ].join("\n")
}

const mutablePlan = (plan: unknown) => plan as WorkflowPlanInput

export const WorkflowTool = Tool.define<typeof Parameters, Metadata, WorkflowService.Service>(
  "workflow",
  Effect.gen(function* () {
    const workflows = yield* WorkflowService.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const runner = Option.getOrUndefined(yield* Effect.serviceOption(WorkflowRunner.Service))
          const requireRunner = () =>
            runner
              ? Effect.succeed(runner)
              : Effect.fail(new Error("Workflow runner service is unavailable for this workflow action."))

          if (params.action === "list") {
            const snapshots = yield* workflows.list()
            return {
              title: `Workflows (${snapshots.length})`,
              output: snapshots.length
                ? snapshots.slice(0, 20).map((snapshot) => `${snapshot.run.id}: ${snapshot.definition.name} — ${snapshot.run.state} (${snapshot.tasks.length} tasks)`).join("\n")
                : "No workflow runs found.",
              metadata: { action: params.action, count: snapshots.length },
            }
          }

          if (params.action === "preview") {
            const plan = yield* requireValue(params.plan, "plan")
            const preview = yield* workflows.preview(mutablePlan(plan))
            return {
              title: `Workflow preview: ${plan.name}`,
              output: [
                `name: ${plan.name}`,
                `objective: ${plan.objective}`,
                `phases: ${preview.phaseCount}`,
                `tasks: ${preview.taskCount}`,
                `max_concurrency: ${preview.maxConcurrency}`,
                `max_fan_out: ${preview.maxFanOut}`,
                `side_effect_classes: ${preview.sideEffectClasses.join(", ") || "none"}`,
              ].join("\n"),
              metadata: {
                action: params.action,
                phaseCount: preview.phaseCount,
                taskCount: preview.taskCount,
              },
            }
          }

          if (params.action === "save") {
            const plan = yield* requireValue(params.plan, "plan")
            const receipt = yield* workflows.save({
              plan: mutablePlan(plan),
              definitionID: params.definitionID ? Workflow.WorkflowDefinitionID.make(params.definitionID) : undefined,
              name: params.name,
              description: params.description,
              source: params.source,
              ownerSessionID: ctx.sessionID,
              saved: params.saved ?? true,
            })
            return {
              title: `Saved workflow revision ${receipt.revisionID}`,
              output: receiptOutput(receipt),
              metadata: {
                action: params.action,
                definitionID: receipt.definitionID,
                revisionID: receipt.revisionID,
                phaseCount: receipt.preview.phaseCount,
                taskCount: receipt.preview.taskCount,
              },
            }
          }

          if (params.action === "start") {
            const scheduler = yield* requireRunner()
            const started = yield* workflows.start({
              plan: params.plan === undefined ? undefined : mutablePlan(params.plan),
              revisionID: params.revisionID ? Workflow.WorkflowRevisionID.make(params.revisionID) : undefined,
              definitionID: params.definitionID ? Workflow.WorkflowDefinitionID.make(params.definitionID) : undefined,
              name: params.name,
              description: params.description,
              source: params.source,
              originSessionID: params.originSessionID ? SessionID.make(params.originSessionID) : ctx.sessionID,
              overlapKey: params.overlapKey,
            })
            yield* scheduler.start(started.run.id)
            return {
              title: `Started workflow ${started.run.id}`,
              output: snapshotOutput(started),
              metadata: { ...snapshotMetadata(started), action: params.action },
            }
          }

          const runID = yield* requireValue(params.runID, "runID")
          const id = Workflow.WorkflowRunID.make(runID)

          if (params.action === "show") {
            const snapshot = yield* workflows.show(id)
            return { title: `Workflow ${snapshot.run.id}`, output: snapshotOutput(snapshot), metadata: snapshotMetadata(snapshot) }
          }

          if (params.action === "pause") {
            const scheduler = yield* requireRunner()
            const snapshot = yield* workflows.pause({ runID: id, reason: params.reason, actor: "tool" })
            yield* scheduler.stop(id)
            return { title: `Paused workflow ${snapshot.run.id}`, output: snapshotOutput(snapshot), metadata: { ...snapshotMetadata(snapshot), action: params.action } }
          }

          if (params.action === "resume") {
            const scheduler = yield* requireRunner()
            const snapshot = yield* workflows.resume({ runID: id, reason: params.reason, actor: "tool" })
            yield* scheduler.start(snapshot.run.id)
            return { title: `Resumed workflow ${snapshot.run.id}`, output: snapshotOutput(snapshot), metadata: { ...snapshotMetadata(snapshot), action: params.action } }
          }

          if (params.action === "stop") {
            const scheduler = yield* requireRunner()
            const snapshot = yield* workflows.stop({ runID: id, reason: params.reason, actor: "tool" })
            yield* scheduler.stop(snapshot.run.id)
            return { title: `Stopped workflow ${snapshot.run.id}`, output: snapshotOutput(snapshot), metadata: { ...snapshotMetadata(snapshot), action: params.action } }
          }

          if (params.action === "retry_task") {
            const scheduler = yield* requireRunner()
            const taskID = yield* requireValue(params.taskID, "taskID")
            const snapshot = yield* workflows.retryTask({ runID: id, taskID: Workflow.WorkflowTaskID.make(taskID), reason: params.reason, actor: "tool" })
            yield* scheduler.start(snapshot.run.id)
            return { title: `Retried task in workflow ${snapshot.run.id}`, output: snapshotOutput(snapshot), metadata: { ...snapshotMetadata(snapshot), action: params.action } }
          }

          const scheduler = yield* requireRunner()
          const phaseID = yield* requireValue(params.phaseID, "phaseID")
          const snapshot = yield* workflows.retryPhase({ runID: id, phaseID: Workflow.WorkflowPhaseID.make(phaseID), reason: params.reason, actor: "tool" })
          yield* scheduler.start(snapshot.run.id)
          return { title: `Retried phase in workflow ${snapshot.run.id}`, output: snapshotOutput(snapshot), metadata: { ...snapshotMetadata(snapshot), action: params.action } }
        }).pipe(Effect.orDie),
    }
  }),
)
