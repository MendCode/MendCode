import { Cause, Context, Effect, Layer, Schema, Types } from "effect"
import { errorMessage } from "@/util/error"
import { SessionPrompt } from "@/session/prompt"
import { LoopWorkflow } from "@/session/loop"
import { ModelID, ProviderID } from "@/provider/schema"

export const TickResult = Schema.Struct({
  workflowID: LoopWorkflow.LoopID,
  runID: Schema.optional(LoopWorkflow.RunID),
  state: Schema.Literals(["completed", "failed", "skipped"]),
  summary: Schema.String,
})
export type TickResult = Types.DeepMutable<Schema.Schema.Type<typeof TickResult>>

export interface Interface {
  readonly runOne: (input: RunOneInput) => Effect.Effect<TickResult, unknown, LoopWorkflow.Service | SessionPrompt.Service>
  readonly runDue: (input?: {
    now?: number
    limit?: number
    execute?: boolean
    reportOnly?: boolean
  }) => Effect.Effect<TickResult[], unknown, LoopWorkflow.Service | SessionPrompt.Service>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LoopRunner") {}

export type RunOneInput = {
  id: LoopWorkflow.LoopID
  execute?: boolean
  reportOnly?: boolean
}

function iterationPrompt(workflow: LoopWorkflow.Info) {
  const turn = (workflow.metrics.turns ?? 0) + 1
  const maxTurns = workflow.policy.maxTurns ?? "unlimited"
  const next = workflow.nextWakeup ? new Date(workflow.nextWakeup).toISOString() : "now"
  const gates = workflow.spec.gates?.length ? workflow.spec.gates.join(", ") : "none"
  const stopWhen = workflow.spec.stopWhen?.length ? workflow.spec.stopWhen.join(", ") : "none"
  const approval = workflow.policy.requireApprovalFor?.length ? workflow.policy.requireApprovalFor.join(", ") : "none"
  return [
    `Loop workflow iteration ${turn}/${maxTurns}: ${workflow.name}`,
    "",
    `Objective: ${workflow.objective}`,
    `Current phase: ${workflow.phase}`,
    `Next scheduled wakeup: ${next}`,
    `Gates: ${gates}`,
    `Stop conditions: ${stopWhen}`,
    `Approval required for: ${approval}`,
    "",
    "Work autonomously for this iteration. Inspect the current repo/session state, make only useful progress toward the objective, and stop when this iteration has a clear checkpoint.",
    "Do not push, merge, publish releases, send external messages, or perform destructive shell actions unless the user has explicitly approved that action in this session.",
    "End with a concise loop checkpoint that says: status, progress made, blockers, next wakeup/action.",
  ].join("\n")
}

function reportOnlyPrompt(workflow: LoopWorkflow.Info) {
  return [
    iterationPrompt(workflow),
    "",
    "REPORT-ONLY MODE:",
    "- Do not edit files.",
    "- Do not run mutating shell commands.",
    "- Produce an inspection checkpoint and next-action recommendation only.",
  ].join("\n")
}

function reportOnlyTools() {
  return {
    edit: false,
    write: false,
    apply_patch: false,
    bash: false,
    task: false,
  }
}

function promptModel(workflow: LoopWorkflow.Info) {
  const model = workflow.spec.model
  if (!model) return undefined
  return {
    providerID: ProviderID.make(model.providerID),
    modelID: ModelID.make(model.modelID),
  }
}

export const layer = Layer.effect(
  Service,
  Effect.sync(() => {
    const runOne = Effect.fn("LoopRunner.runOne")(function* (input: RunOneInput) {
      const workflow = yield* LoopWorkflow.Service
      const id = input.id
      const before = yield* workflow.get(id)
      if (typeof before.policy.maxTurns === "number" && (before.metrics.turns ?? 0) >= before.policy.maxTurns) {
        return {
          workflowID: before.id,
          state: "skipped",
          summary: `Loop already reached its iteration limit (${before.metrics.turns ?? 0}/${before.policy.maxTurns}).`,
        } satisfies TickResult
      }
      if (before.state === "paused" || before.state === "stopped" || before.state === "completed") {
        return {
          workflowID: before.id,
          state: "skipped",
          summary: `Loop is ${before.state}.`,
        } satisfies TickResult
      }
      if (input.execute !== true) {
        return {
          workflowID: before.id,
          state: "skipped",
          summary: `Dry-run: would run loop "${before.name}" in phase ${before.phase}. Pass --execute to run.`,
        } satisfies TickResult
      }
      const prompt = yield* SessionPrompt.Service
      const run = yield* workflow.startRun({ id, trigger: before.spec.trigger?.mode === "interval" ? "interval" : "adaptive" })
      const current = yield* workflow.get(id)
      if (!current.rootSessionID) {
        return yield* workflow.failRun({ id, runID: run.id, error: "Loop has no root session after activation." }).pipe(
          Effect.map((failed) => ({
            workflowID: id,
            runID: failed.id,
            state: "failed" as const,
            summary: failed.evaluatorReason ?? "Loop run failed.",
          })),
        )
      }
      const result = yield* prompt
        .prompt({
          sessionID: current.rootSessionID,
          agent: current.spec.agent,
          model: promptModel(current),
          variant: current.spec.model?.variant,
          tools: input.reportOnly ? reportOnlyTools() : undefined,
          parts: [{ type: "text", text: input.reportOnly ? reportOnlyPrompt(current) : iterationPrompt(current) }],
        })
        .pipe(Effect.exit)
      if (result._tag === "Failure") {
        const message = errorMessage(Cause.squash(result.cause))
        const failed = yield* workflow.failRun({ id, runID: run.id, error: message })
        return {
          workflowID: id,
          runID: failed.id,
          state: "failed",
          summary: message,
        } satisfies TickResult
      }
      const completed = yield* workflow.completeRun({
        id,
        runID: run.id,
        reason: "Iteration completed by session runner.",
      })
      return {
        workflowID: id,
        runID: completed.id,
        state: "completed",
        summary: completed.evaluatorReason ?? "Loop run completed.",
      } satisfies TickResult
    })

    const runDue = Effect.fn("LoopRunner.runDue")(function* (input?: {
      now?: number
      limit?: number
      execute?: boolean
      reportOnly?: boolean
    }) {
      const workflow = yield* LoopWorkflow.Service
      const due = yield* workflow.due(input)
      return yield* Effect.forEach(due, (item) => runOne({ id: item.id, execute: input?.execute, reportOnly: input?.reportOnly }), { concurrency: 1 })
    })

    return Service.of({ runOne, runDue })
  }),
)

export const defaultLayer = Layer.suspend(() => layer)

export * as LoopRunner from "./loop-runner"
