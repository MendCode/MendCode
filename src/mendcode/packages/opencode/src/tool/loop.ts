import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./loop.txt"
import { LoopWorkflow } from "@/session/loop"
import { InstanceState } from "@/effect/instance-state"
import { loopServiceArgsFromConfig, loopServiceStart } from "@/mend/runtime/loop-service"
import { Provider } from "@/provider/provider"

const Action = Schema.Literals(["draft", "activate", "show", "list", "pause", "resume", "stop", "delete", "run_once"])
const TriggerMode = Schema.Literals(["manual", "interval", "adaptive", "external-signal", "self-paced"])
const PermissionMode = Schema.Literals(["report-only", "normal", "custom"])
const BudgetMode = Schema.Literals(["fixed", "max-goal", "unbounded-monitor"])

export const Parameters = Schema.Struct({
  action: Action.annotate({
    description:
      "Loop workflow action. Use activate to create/start a loop, draft to create a reviewable draft, show/list to inspect, and pause/resume/stop/delete/run_once for control.",
  }),
  workflowID: Schema.optional(LoopWorkflow.LoopID).annotate({
    description:
      "Existing loop workflow id. Provide it for precise show, pause, resume, stop, and run_once actions. If omitted, the tool may resolve the current session's contextual loop or fall back to a list.",
  }),
  name: Schema.optional(Schema.String).annotate({
    description: "Short workflow name when creating a draft or activating a new loop.",
  }),
  objective: Schema.optional(Schema.String).annotate({
    description: "Durable loop objective. Required when creating a draft or activating a new loop.",
  }),
  triggerMode: Schema.optional(TriggerMode).annotate({
    description: "How the loop wakes up. Use manual for on-demand tests or interval for scheduled background loops.",
  }),
  intervalMs: Schema.optional(Schema.Number).annotate({
    description: "Interval in milliseconds when triggerMode is interval.",
  }),
  maxTurns: Schema.optional(Schema.Number).annotate({
    description:
      "Iteration budget/cap. For goal work this is a maximum, not a plan to spend every iteration. Use budgetMode=fixed only for exactly-N iteration jobs.",
  }),
  maxRuntimeMs: Schema.optional(Schema.Number).annotate({
    description: "Maximum wall-clock runtime in milliseconds before the loop should stop.",
  }),
  maxChildren: Schema.optional(Schema.Number).annotate({
    description: "Maximum child/subagent sessions the loop should create while working.",
  }),
  maxDepth: Schema.optional(Schema.Number).annotate({
    description: "Maximum recursive/delegation depth for loop work.",
  }),
  model: Schema.optional(Schema.String).annotate({
    description:
      "Optional model for loop iterations in provider/model-id format. A trailing #variant is accepted, for example openai/gpt-5.5#medium.",
  }),
  variant: Schema.optional(Schema.String).annotate({
    description:
      "Optional model variant/reasoning effort for loop iterations, for example low, medium, high, or max. Use this when the user says reasoning medium/high/etc.",
  }),
  agent: Schema.optional(Schema.String).annotate({
    description: "Optional MendCode agent/profile name to use when the loop runner wakes this workflow.",
  }),
  permissionMode: Schema.optional(PermissionMode).annotate({
    description: "Loop execution permission mode. Use report-only by default, normal only after explicit user approval, or custom with gates/approval lists.",
  }),
  budgetMode: Schema.optional(BudgetMode).annotate({
    description:
      "Loop budget semantics: fixed runs exactly to maxTurns, max-goal uses maxTurns as a cap and completes as soon as the goal is verified, unbounded-monitor runs until stopped/blocker.",
  }),
  completionCriteria: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Concrete criteria that prove the loop goal is complete. Required for max-goal implementation loops.",
  }),
  successChecks: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Validation commands, inspections, or review checks the loop should run before reporting complete.",
  }),
  targetTurns: Schema.optional(Schema.Number).annotate({
    description: "Soft target number of iterations to finish the goal before using the remaining budget for recovery/verification.",
  }),
  reserveTurns: Schema.optional(Schema.Number).annotate({
    description: "Number of final budget turns reserved for validation, cleanup, retry, or blocker reporting.",
  }),
  notifyOwnerOnComplete: Schema.optional(Schema.Boolean).annotate({
    description: "When true, wake the parent session with a loop completion summary after a max-goal loop completes.",
  }),
  stopWhen: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Natural-language stop conditions for the loop.",
  }),
  gates: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Review, permission, safety, or quality gates the loop must respect.",
  }),
  reportOnly: Schema.optional(Schema.Boolean).annotate({
    description: "Whether the loop should inspect and report without editing. Defaults to true for newly created loops.",
  }),
  ensureService: Schema.optional(Schema.Boolean).annotate({
    description: "When activating, best-effort start the project loop service so wakeups continue outside the TUI.",
  }),
  reason: Schema.optional(Schema.String).annotate({
    description: "Short reason recorded in the loop journal for this action.",
  }),
})

type Metadata = {
  workflowID?: string
  sessionId?: string
  rootSessionID?: string
  ownerSessionID?: string
  state?: string
  phase?: string
  nextWakeup?: number
  name?: string
  objective?: string
  triggerMode?: string
  intervalMs?: number
  permissionMode?: "report-only" | "normal" | "custom"
  budgetMode?: "fixed" | "max-goal" | "unbounded-monitor"
  model?: {
    providerID: string
    modelID: string
    variant?: string
  }
  agent?: string
  count?: number
  serviceEnsured?: boolean
  workflows?: Array<{
    workflowID: string
    ownerSessionID?: string
    rootSessionID?: string
    state: string
    phase: string
    name: string
    nextWakeup?: number
    turns?: number
    maxTurns?: number
    objective?: string
    triggerMode?: string
    intervalMs?: number
    permissionMode?: "report-only" | "normal" | "custom"
    budgetMode?: "fixed" | "max-goal" | "unbounded-monitor"
    model?: {
      providerID: string
      modelID: string
      variant?: string
    }
    agent?: string
    created?: number
    activated?: number
    updated?: number
  }>
}

const reportOnlyApprovalGates = ["edit", "write", "apply_patch", "shell", "subagent"]
const normalApprovalGates = ["push", "merge", "release", "version-bump", "external-send", "destructive-shell", "broad-refactor"]

function sameStringSet(values: Set<string>, expected: string[]) {
  return values.size === expected.length && expected.every((item) => values.has(item))
}

function permissionModeFor(workflow: LoopWorkflow.Info): "report-only" | "normal" | "custom" {
  const gates = workflow.spec.gates ?? []
  if (gates.some((gate) => /report-only|do not edit/i.test(gate))) return "report-only"
  const approvals = new Set(workflow.policy.requireApprovalFor ?? [])
  if (reportOnlyApprovalGates.every((gate) => approvals.has(gate))) return "report-only"
  if (gates.length > 0) return "custom"
  if (!approvals.size || sameStringSet(approvals, normalApprovalGates)) return "normal"
  return "custom"
}

function modelMetadata(model?: LoopWorkflow.Info["spec"]["model"] | { providerID: string; modelID: string; variant?: string }) {
  if (!model) return undefined
  return {
    providerID: model.providerID,
    modelID: model.modelID,
    variant: model.variant,
  }
}

function parseLoopModel(input: string, explicitVariant?: string) {
  const [modelName, hashVariant] = input.split("#", 2)
  const parsed = Provider.parseModel(modelName)
  const variant = explicitVariant?.trim() || hashVariant?.trim() || undefined
  return {
    providerID: parsed.providerID,
    modelID: parsed.modelID,
    variant,
  }
}

function inferBudgetMode(params: Schema.Schema.Type<typeof Parameters>): "fixed" | "max-goal" | "unbounded-monitor" {
  if (params.budgetMode) return params.budgetMode
  const objective = params.objective ?? ""
  const fixedLanguage = /\b(exactly|fixed|solo|solamente|exactamente)\b.*\b(iteration|iterations|iteracion|iteraciones|veces)\b/i
  if (params.maxTurns && fixedLanguage.test(objective)) return "fixed"
  if (!params.maxTurns && (params.triggerMode === "interval" || params.triggerMode === "external-signal")) return "unbounded-monitor"
  return "max-goal"
}

function defaultTargetTurns(maxTurns: number | undefined) {
  if (!maxTurns) return undefined
  return Math.max(1, Math.min(8, Math.ceil(maxTurns * 0.6)))
}

function defaultReserveTurns(maxTurns: number | undefined) {
  if (!maxTurns || maxTurns < 4) return undefined
  return Math.max(1, Math.min(3, Math.floor(maxTurns * 0.2)))
}

function positiveMaxTurns(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined
  return Math.floor(value)
}

function maxTurnsFor(params: Schema.Schema.Type<typeof Parameters>, budgetMode: "fixed" | "max-goal" | "unbounded-monitor") {
  const maxTurns = positiveMaxTurns(params.maxTurns)
  if (budgetMode === "fixed" && !maxTurns) throw new Error("fixed loop workflows require maxTurns > 0; do not use 0")
  if (budgetMode === "max-goal" && params.maxTurns !== undefined && !maxTurns) throw new Error("max-goal maxTurns must be > 0; omit it for no cap")
  return maxTurns
}

function objectiveExplicitlyRequestsEdits(objective: string | undefined) {
  const text = objective ?? ""
  if (/\b(report-only|read-only|inspect only|solo report|solo inspecci[oó]n|solo lectura|sin editar)\b/i.test(text)) return false
  if (/\b(make|hacer)\s+(code changes|changes|cambios)\b/i.test(text)) return true
  return /\b(write|edit|modify|update|fix|implement|code|delete|remove|rename|refactor|apply|patch|arregl\w*|corr(?:eg|ig)\w*|implement\w*|code\w*|escrib\w*|modific\w*|actualiz\w*|elimin\w*|borr\w*|renombr\w*|aplic\w*|parch\w*|cambi(?:ar|a|e|en|emos|ando|ado))\b/i.test(text)
}

function createInput(params: Schema.Schema.Type<typeof Parameters>, sessionID: Tool.Context["sessionID"]) {
  if (!params.objective?.trim()) throw new Error("objective is required when creating a loop workflow")
  const name =
    params.name?.trim() ||
    params.objective
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 80)
  const model = params.model ? parseLoopModel(params.model, params.variant) : undefined
  const allowEditsFromObjective = params.permissionMode === undefined && params.reportOnly === undefined && objectiveExplicitlyRequestsEdits(params.objective)
  const reportOnly =
    params.permissionMode === "report-only" ||
    params.reportOnly === true ||
    (params.permissionMode === undefined && params.reportOnly !== false && !allowEditsFromObjective)
  const budgetMode = inferBudgetMode(params)
  const maxTurns = maxTurnsFor(params, budgetMode)
  const trigger =
    params.triggerMode || params.intervalMs
      ? {
          mode: params.triggerMode ?? (params.intervalMs ? "interval" : "manual"),
          intervalMs: params.intervalMs,
        }
      : undefined
  return {
    name,
    objective: params.objective.trim(),
    source: "converted-session" as const,
    ownerSessionID: sessionID,
    trigger,
    budgetMode,
    completionCriteria: params.completionCriteria,
    successChecks: params.successChecks,
    strategy: {
      targetTurns: params.targetTurns ?? (budgetMode === "max-goal" ? defaultTargetTurns(maxTurns) : undefined),
      reserveTurns: params.reserveTurns ?? (budgetMode === "max-goal" ? defaultReserveTurns(maxTurns) : undefined),
      notifyOwnerOnComplete: params.notifyOwnerOnComplete ?? budgetMode === "max-goal",
    },
    stopWhen: params.stopWhen,
    gates: [
      ...(reportOnly ? ["report-only; do not edit files"] : []),
      ...(params.gates ?? []),
    ],
    model: model
      ? {
          providerID: model.providerID,
          modelID: model.modelID,
          variant: model.variant,
        }
      : undefined,
    agent: params.agent?.trim() || undefined,
    policy: {
      maxTurns,
      maxRuntimeMs: params.maxRuntimeMs,
      maxChildren: params.maxChildren,
      maxDepth: params.maxDepth,
      requireApprovalFor: reportOnly ? [...reportOnlyApprovalGates, "push", "merge", "release"] : normalApprovalGates,
    },
  } satisfies LoopWorkflow.CreateDraftInput
}

function formatWorkflow(workflow: LoopWorkflow.Info) {
  const lines = [
    `loop_id: ${workflow.id}`,
    `loop_state: ${workflow.state}`,
    `loop_phase: ${workflow.phase}`,
    `loop_name: ${workflow.name}`,
    `root_session_id: ${workflow.rootSessionID ?? "none"}`,
    `owner_session_id: ${workflow.ownerSessionID ?? "none"}`,
    `next_wakeup: ${workflow.nextWakeup ? new Date(workflow.nextWakeup).toISOString() : "none"}`,
    `budget_mode: ${workflow.spec.budgetMode ?? "legacy"}`,
    `max_turns: ${workflow.policy.maxTurns ?? "unlimited"}`,
    `max_runtime_ms: ${workflow.policy.maxRuntimeMs ?? "unlimited"}`,
    `model: ${
      workflow.spec.model
        ? `${workflow.spec.model.providerID}/${workflow.spec.model.modelID}${workflow.spec.model.variant ? `#${workflow.spec.model.variant}` : ""}`
        : "session default"
    }`,
    `agent: ${workflow.spec.agent ?? "session default"}`,
    `target_turns: ${workflow.spec.strategy?.targetTurns ?? "auto"}`,
    `reserve_turns: ${workflow.spec.strategy?.reserveTurns ?? "auto"}`,
    `notify_owner_on_complete: ${workflow.spec.strategy?.notifyOwnerOnComplete === true ? "true" : "false"}`,
    "",
    "<loop_objective>",
    workflow.objective,
    "</loop_objective>",
  ]
  return lines.join("\n")
}

function formatList(workflows: LoopWorkflow.Info[]) {
  if (!workflows.length) return "No loop workflows found."
  return workflows
    .map((workflow) =>
      [
        `${workflow.id}  ${workflow.state}/${workflow.phase}  ${workflow.name}`,
        `  root_session_id: ${workflow.rootSessionID ?? "none"}`,
        `  next_wakeup: ${workflow.nextWakeup ? new Date(workflow.nextWakeup).toISOString() : "none"}`,
      ].join("\n"),
    )
    .join("\n")
}

function listOutput(items: LoopWorkflow.Info[]) {
  return {
    title: `${items.length} loops`,
    output: formatList(items),
    metadata: {
      count: items.length,
      workflows: items.map((item) => ({
        workflowID: item.id,
        ownerSessionID: item.ownerSessionID,
        rootSessionID: item.rootSessionID,
        state: item.state,
        phase: item.phase,
        name: item.name,
        nextWakeup: item.nextWakeup,
        turns: item.metrics.turns,
        maxTurns: item.policy.maxTurns,
        objective: item.objective,
        triggerMode: item.spec.trigger?.mode,
        intervalMs: item.spec.trigger?.intervalMs,
        permissionMode: permissionModeFor(item),
        budgetMode: item.spec.budgetMode,
        model: modelMetadata(item.spec.model),
        agent: item.spec.agent,
        created: item.time.created,
        activated: item.time.activated,
        updated: item.time.updated,
      })),
    },
  }
}

const terminalStates = new Set(["completed", "failed", "stopped"])

function canControl(action: Schema.Schema.Type<typeof Action>, workflow: LoopWorkflow.Info) {
  if (action === "delete") return true
  if (action === "resume") return workflow.state === "paused"
  if (action === "show") return true
  if (action === "run_once") return workflow.state !== "paused" && !terminalStates.has(workflow.state)
  return !terminalStates.has(workflow.state)
}

function createFromShowInput(params: Schema.Schema.Type<typeof Parameters>) {
  return params.action === "show" && !params.workflowID && (!!params.name?.trim() || !!params.objective?.trim())
}

function metadata(workflow: LoopWorkflow.Info, serviceEnsured?: boolean, rootSessionModel?: { providerID: string; modelID: string; variant?: string }): Metadata {
  const permissionMode = permissionModeFor(workflow)
  const model = modelMetadata(workflow.spec.model ?? rootSessionModel)
  return {
    workflowID: workflow.id,
    sessionId: workflow.rootSessionID,
    rootSessionID: workflow.rootSessionID,
    ownerSessionID: workflow.ownerSessionID,
    state: workflow.state,
    phase: workflow.phase,
    nextWakeup: workflow.nextWakeup,
    name: workflow.name,
    objective: workflow.objective,
    triggerMode: workflow.spec.trigger?.mode,
    intervalMs: workflow.spec.trigger?.intervalMs,
    permissionMode,
    budgetMode: workflow.spec.budgetMode,
    model,
    agent: workflow.spec.agent,
    serviceEnsured,
    workflows: [
      {
        workflowID: workflow.id,
        ownerSessionID: workflow.ownerSessionID,
        rootSessionID: workflow.rootSessionID,
        state: workflow.state,
        phase: workflow.phase,
        name: workflow.name,
        nextWakeup: workflow.nextWakeup,
        turns: workflow.metrics.turns,
        maxTurns: workflow.policy.maxTurns,
        objective: workflow.objective,
        triggerMode: workflow.spec.trigger?.mode,
        intervalMs: workflow.spec.trigger?.intervalMs,
        permissionMode,
        budgetMode: workflow.spec.budgetMode,
        model,
        agent: workflow.spec.agent,
        created: workflow.time.created,
        activated: workflow.time.activated,
        updated: workflow.time.updated,
      },
    ],
  }
}

export const LoopTool = Tool.define<typeof Parameters, Metadata, LoopWorkflow.Service>(
  "loop",
  Effect.gen(function* () {
    const workflows = yield* LoopWorkflow.Service

    const contextualWorkflow = Effect.fn("LoopTool.contextualWorkflow")(function* (
      action: Schema.Schema.Type<typeof Action>,
      sessionID: Tool.Context["sessionID"],
    ) {
      const items = yield* workflows.list()
      const candidates = items.filter((item) => canControl(action, item))
      const scoped = candidates.filter((item) => item.ownerSessionID === sessionID || item.rootSessionID === sessionID)
      return scoped[0] ?? candidates[0]
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const action = createFromShowInput(params) ? "activate" : params.action

          if (action === "list") {
            const items = yield* workflows.list()
            return listOutput(items)
          }

          let workflow: LoopWorkflow.Info | undefined

          if (params.workflowID) workflow = yield* workflows.get(params.workflowID)
          else if (action !== "draft" && action !== "activate") workflow = yield* contextualWorkflow(action, ctx.sessionID)

          if (!workflow && action === "show") {
            const items = yield* workflows.list()
            return listOutput(items)
          }

          if (!workflow && action !== "draft" && action !== "activate") {
            return {
              title: `No loop to ${action}`,
              output: `No matching loop workflow was found for action ${action}.`,
              metadata: {
                count: 0,
                workflows: [],
              },
            }
          }

          if (action === "draft") {
            workflow = yield* workflows.createDraft(createInput(params, ctx.sessionID))
            return {
              title: `Drafted loop ${workflow.id}`,
              output: formatWorkflow(workflow),
              metadata: metadata(workflow),
            }
          }

          if (action === "activate") {
            const instance = yield* InstanceState.context
            const draft = workflow ?? (yield* workflows.createDraft(createInput(params, ctx.sessionID)))
            workflow = yield* workflows.activate({ id: draft.id, reason: params.reason ?? "Activated from loop tool." })
            const snapshot = yield* workflows.snapshot(workflow.id, 1)
            let serviceEnsured = false
            if (params.ensureService !== false) {
              yield* Effect.promise(() =>
                loopServiceStart(loopServiceArgsFromConfig(instance.directory))
                  .then(() => {
                    serviceEnsured = true
                  })
                  .catch(() => undefined),
              )
            }
            return {
              title: `Activated loop ${workflow.id}`,
              output: [
                formatWorkflow(workflow),
                "",
                serviceEnsured
                  ? "Loop service was started or confirmed for this project."
                  : "Loop service was not confirmed. The workflow is durable, but scheduled wakeups need an active loop service.",
              ].join("\n"),
              metadata: metadata(workflow, serviceEnsured, snapshot.rootSession?.model),
            }
          }

          if (!workflow) return yield* Effect.fail(new Error(`No loop workflow resolved for action ${action}`))

          if (action === "show") {
            const snapshot = yield* workflows.snapshot(workflow.id, 10)
            return {
              title: `Loop ${workflow.id}`,
              output: [
                formatWorkflow(snapshot.workflow),
                "",
                `runs: ${snapshot.runs.length}`,
                `threads: ${snapshot.threads.length}`,
                `events: ${snapshot.events.length}`,
              ].join("\n"),
              metadata: metadata(snapshot.workflow, undefined, snapshot.rootSession?.model),
            }
          }

          if (action === "delete") {
            const deleted = yield* workflows.delete(workflow.id)
            return {
              title: `Deleted loop ${deleted.id}`,
              output: [`deleted_loop_id: ${deleted.id}`, `deleted_loop_name: ${deleted.name}`].join("\n"),
              metadata: metadata(deleted),
            }
          }

          if (action === "pause") workflow = yield* workflows.pause({ id: workflow.id, reason: params.reason })
          if (action === "resume") workflow = yield* workflows.resume({ id: workflow.id, reason: params.reason })
          if (action === "stop") workflow = yield* workflows.stop({ id: workflow.id, reason: params.reason })
          if (action === "run_once") {
            const run = yield* workflows.runOnce({ id: workflow.id, reason: params.reason })
            const updated = yield* workflows.get(workflow.id)
            return {
              title: `Recorded loop run ${run.id}`,
              output: [formatWorkflow(updated), "", `run_id: ${run.id}`, `run_state: ${run.state}`].join("\n"),
              metadata: metadata(updated),
            }
          }

          return {
            title: `Loop ${action} ${workflow.id}`,
            output: formatWorkflow(workflow),
            metadata: metadata(workflow),
          }
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
