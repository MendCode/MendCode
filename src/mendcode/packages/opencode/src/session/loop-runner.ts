import { Cause, Context, Effect, Layer, Schema, Types } from "effect"
import { errorMessage } from "@/util/error"
import { SessionPrompt } from "@/session/prompt"
import { LoopWorkflow } from "@/session/loop"
import * as MessageV2 from "@/session/message-v2"
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

type LoopCheckpoint = {
  status?: LoopWorkflow.GoalStatus
  summary?: string
  evidence?: string[]
  nextAction?: string
  confidence?: string
}

function numberedList(items: string[] | undefined, fallback: string) {
  if (!items?.length) return fallback
  return items.map((item, index) => `${index + 1}. ${item}`).join("\n")
}

function budgetSemantics(workflow: LoopWorkflow.Info) {
  const mode = workflow.spec.budgetMode ?? "legacy"
  if (mode === "fixed") return "fixed: run exactly until the iteration cap unless blocked or stopped."
  if (mode === "unbounded-monitor") return "unbounded-monitor: continue monitoring until a stop condition, blocker, or user stop."
  if (mode === "max-goal") return "max-goal: maxTurns is a budget cap, not a work plan; finish as soon as the goal is complete and verified."
  return "legacy: preserve existing loop behavior; use stop conditions and budget carefully."
}

function remainingBudget(workflow: LoopWorkflow.Info) {
  if (typeof workflow.policy.maxTurns !== "number") return "unlimited"
  return Math.max(0, workflow.policy.maxTurns - (workflow.metrics.turns ?? 0))
}

function iterationPrompt(workflow: LoopWorkflow.Info) {
  const turn = (workflow.metrics.turns ?? 0) + 1
  const maxTurns = workflow.policy.maxTurns ?? "unlimited"
  const next = workflow.nextWakeup ? new Date(workflow.nextWakeup).toISOString() : "now"
  const gates = workflow.spec.gates?.length ? workflow.spec.gates.join(", ") : "none"
  const stopWhen = workflow.spec.stopWhen?.length ? workflow.spec.stopWhen.join(", ") : "none"
  const approval = workflow.policy.requireApprovalFor?.length ? workflow.policy.requireApprovalFor.join(", ") : "none"
  const strategy = workflow.spec.strategy
  const reserve = strategy?.reserveTurns ?? 0
  const remaining = remainingBudget(workflow)
  const reserveNote =
    typeof remaining === "number" && reserve > 0 && remaining <= reserve
      ? "You are in reserved validation/recovery budget. Prioritize proving completion, cleanup, blockers, and concise closure over expanding scope."
      : "Use the minimum useful number of iterations; do not stretch work to fill the maximum."
  return [
    `Loop workflow iteration ${turn}/${maxTurns}: ${workflow.name}`,
    "",
    `Objective: ${workflow.objective}`,
    `Budget mode: ${budgetSemantics(workflow)}`,
    `Remaining iteration budget after this run starts: ${remaining}`,
    strategy?.targetTurns ? `Target completion window: aim to complete by about ${strategy.targetTurns} iterations if possible.` : undefined,
    reserve ? `Reserved verification/recovery turns: ${reserve}` : undefined,
    `Current phase: ${workflow.phase}`,
    `Next scheduled wakeup: ${next}`,
    "",
    "Completion criteria:",
    numberedList(workflow.spec.completionCriteria, "Use the objective, stop conditions, and explicit user constraints as completion criteria."),
    "",
    "Success checks:",
    numberedList(workflow.spec.successChecks, "Run the most relevant available validation and explain any unavailable checks."),
    "",
    `Gates: ${gates}`,
    `Stop conditions: ${stopWhen}`,
    `Approval required for: ${approval}`,
    "",
    reserveNote,
    "Work autonomously toward completing the objective, not toward consuming every iteration. If the goal is already complete, verify it and report status: complete instead of making more changes.",
    "Do not push, merge, publish releases, send external messages, or perform destructive shell actions unless the user has explicitly approved that action in this session.",
    "",
    "End your final message with this exact machine-readable block:",
    "LOOP_CHECKPOINT:",
    "status: complete | continue | needs_input | blocked",
    "summary: one concise sentence",
    "evidence:",
    "- validation, file, or observation",
    "next_action: next useful action, or stop if complete",
    "confidence: high | medium | low",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n")
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

const reportOnlyApprovalGates = ["edit", "write", "apply_patch", "shell", "subagent"]
const editAllowedApprovalGates = ["push", "merge", "release", "version-bump", "external-send", "destructive-shell", "broad-refactor"]

function workflowIsReportOnly(workflow: LoopWorkflow.Info) {
  const gates = workflow.spec.gates ?? []
  if (gates.some((gate) => /report-only|do not edit/i.test(gate))) return true
  const approvals = new Set(workflow.policy.requireApprovalFor ?? [])
  return reportOnlyApprovalGates.every((gate) => approvals.has(gate))
}

function workflowExplicitlyAllowsEdits(workflow: LoopWorkflow.Info) {
  const approvals = new Set(workflow.policy.requireApprovalFor ?? [])
  if (workflowIsReportOnly(workflow)) return false
  return editAllowedApprovalGates.some((gate) => approvals.has(gate))
}

function promptModel(workflow: LoopWorkflow.Info) {
  const model = workflow.spec.model
  if (!model) return undefined
  return {
    providerID: ProviderID.make(model.providerID),
    modelID: ModelID.make(model.modelID),
  }
}

function assistantText(message: MessageV2.WithParts) {
  return message.parts
    .filter((part): part is MessageV2.TextPart => part.type === "text" && !part.synthetic && !part.ignored)
    .map((part) => part.text)
    .join("\n")
}

function parseCheckpoint(text: string): LoopCheckpoint {
  const marker = text.match(/LOOP_CHECKPOINT:\s*([\s\S]*)$/i)
  if (!marker) return {}
  const block = marker[1]
  const lineValue = (key: string) => {
    const match = block.match(new RegExp(`^${key}:\\s*(.+)$`, "im"))
    return match?.[1]?.trim()
  }
  const statusRaw = lineValue("status")?.toLowerCase()
  const status =
    statusRaw === "complete" || statusRaw === "continue" || statusRaw === "needs_input" || statusRaw === "blocked"
      ? statusRaw
      : undefined
  const evidence: string[] = []
  const evidenceMatch = block.match(/^evidence:\s*([\s\S]*?)(?:^\w[\w_]*:|\s*$)/im)
  if (evidenceMatch?.[1]) {
    for (const line of evidenceMatch[1].split(/\r?\n/)) {
      const item = line.replace(/^\s*[-*]\s*/, "").trim()
      if (item) evidence.push(item)
    }
  }
  return {
    status,
    summary: lineValue("summary"),
    evidence,
    nextAction: lineValue("next_action"),
    confidence: lineValue("confidence"),
  }
}

function parentCompletionPrompt(workflow: LoopWorkflow.Info, checkpoint: LoopCheckpoint, runID: LoopWorkflow.RunID) {
  return [
    `Loop workflow completed: ${workflow.name}`,
    "",
    `Workflow: ${workflow.id}`,
    `Loop chat: ${workflow.rootSessionID ?? "none"}`,
    `Run: ${runID}`,
    `Iterations used: ${workflow.metrics.turns ?? 0}/${workflow.policy.maxTurns ?? "unlimited"}`,
    `Goal: ${workflow.objective}`,
    "",
    `Summary: ${checkpoint.summary ?? workflow.evaluatorReason ?? "Loop reported completion."}`,
    checkpoint.evidence?.length ? ["Evidence:", ...checkpoint.evidence.map((item) => `- ${item}`)].join("\n") : undefined,
    checkpoint.nextAction ? `Next action from loop: ${checkpoint.nextAction}` : undefined,
    "",
    "Review this loop result and decide the next useful step for the user. Do not create a new loop, push, merge, release, or run broad changes unless the user explicitly asks.",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n")
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
      const reportOnly = workflowIsReportOnly(current) || (input.reportOnly === true && !workflowExplicitlyAllowsEdits(current))
      const result = yield* prompt
        .prompt({
          sessionID: current.rootSessionID,
          agent: current.spec.agent,
          model: promptModel(current),
          variant: current.spec.model?.variant,
          tools: reportOnly ? reportOnlyTools() : undefined,
          parts: [{ type: "text", text: reportOnly ? reportOnlyPrompt(current) : iterationPrompt(current) }],
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
      const checkpoint = parseCheckpoint(assistantText(result.value))
      const completed = yield* workflow.completeRun({
        id,
        runID: run.id,
        reason: checkpoint.summary ?? "Iteration completed by session runner.",
        goalStatus: checkpoint.status,
        checkpoint,
      })
      const after = yield* workflow.get(id)
      if (
        after.state === "completed" &&
        after.spec.strategy?.notifyOwnerOnComplete === true &&
        after.ownerSessionID &&
        after.ownerSessionID !== after.rootSessionID
      ) {
        yield* prompt
          .prompt({
            sessionID: after.ownerSessionID,
            agent: after.spec.agent,
            model: promptModel(after),
            variant: after.spec.model?.variant,
            parts: [{ type: "text", text: parentCompletionPrompt(after, checkpoint, completed.id) }],
          })
          .pipe(Effect.ignore)
      }
      return {
        workflowID: id,
        runID: completed.id,
        state: "completed",
        summary: checkpoint.summary ?? completed.evaluatorReason ?? "Loop run completed.",
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
