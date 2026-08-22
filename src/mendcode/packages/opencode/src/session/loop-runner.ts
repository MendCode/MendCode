import { Cause, Context, Effect, Layer, Option, Schema, Types } from "effect"
import { errorMessage } from "@/util/error"
import { SessionPrompt } from "@/session/prompt"
import { LoopWorkflow } from "@/session/loop"
import * as MessageV2 from "@/session/message-v2"
import { Session } from "@/session/session"
import { ModelID, ProviderID } from "@/provider/schema"
import { InstanceState } from "@/effect/instance-state"
import { WorkflowRunner } from "@/session/workflow-runner"
import { WorkflowService } from "@/session/workflow-service"
import { fingerprintWorkspace } from "@/session/completion-auditor"
import {
  compileCompletionCriteria,
  type CompletionAuditReceipt,
  type CompletionProgress,
} from "@/session/completion-contract"
import { completionValidationCommandAllowed, runCompletionValidationCommand } from "@/session/completion-validation"

export const TickResult = Schema.Struct({
  workflowID: LoopWorkflow.LoopID,
  runID: Schema.optional(LoopWorkflow.RunID),
  state: Schema.Literals(["completed", "failed", "blocked", "needs_input", "stopped", "skipped"]),
  summary: Schema.String,
})
export type TickResult = Types.DeepMutable<Schema.Schema.Type<typeof TickResult>>

export interface Interface {
  readonly runOne: (
    input: RunOneInput,
  ) => Effect.Effect<TickResult, unknown, LoopWorkflow.Service | SessionPrompt.Service | Session.Service>
  readonly runDue: (input?: {
    now?: number
    limit?: number
    execute?: boolean
    reportOnly?: boolean
  }) => Effect.Effect<TickResult[], unknown, LoopWorkflow.Service | SessionPrompt.Service | Session.Service>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LoopRunner") {}

export type RunOneInput = {
  id: LoopWorkflow.LoopID
  execute?: boolean
  reportOnly?: boolean
  reason?: string
  trigger?: LoopWorkflow.RunTrigger
  now?: number
}

type LoopCheckpoint = {
  status?: LoopWorkflow.GoalStatus
  summary?: string
  evidence?: string[]
  nextAction?: string
  confidence?: string
}

type LoopJudgment = {
  status?: LoopWorkflow.JudgmentStatus
  summary?: string
  evidence?: string[]
  recommendedNextAction?: string
  confidence?: string
  failureClass?: LoopWorkflow.FailureClass
}

type LoopGateResult = NonNullable<LoopWorkflow.CompleteRunInput["gateResults"]>[number]

type ValidationExecution = {
  status: "pass" | "fail" | "blocked"
  summary: string
  output: string
  exitCode?: number
  durationMs: number
  timedOut: boolean
  failureClass: LoopWorkflow.FailureClass
}

type ParsedLoopBlock = {
  status?: string
  summary?: string
  evidence: string[]
  nextAction?: string
  recommendedNextAction?: string
  confidence?: string
}

function numberedList(items: string[] | undefined, fallback: string) {
  if (!items?.length) return fallback
  return items.map((item, index) => `${index + 1}. ${item}`).join("\n")
}

function loopMemoryPrompt(workflow: LoopWorkflow.Info) {
  const entries = workflow.memory?.entries ?? []
  if (!entries.length) return "Loop memory: none yet."
  const sections: Array<[LoopWorkflow.MemorySection, string]> = [
    ["tried", "Tried"],
    ["verified", "Verified"],
    ["open", "Open"],
    ["decisions", "Decisions"],
    ["rejected", "Rejected"],
  ]
  return [
    "Loop memory from previous runs:",
    ...sections.flatMap(([section, title]) => {
      const items = entries.filter((entry) => entry.section === section).slice(-6)
      if (!items.length) return []
      return [`${title}:`, ...items.map((entry) => `- ${entry.summary}`)]
    }),
  ].join("\n")
}

function budgetSemantics(workflow: LoopWorkflow.Info) {
  const mode = workflow.spec.budgetMode ?? "legacy"
  if (mode === "fixed") return "fixed: run exactly until the iteration cap unless blocked or stopped."
  if (mode === "unbounded-monitor")
    return "unbounded-monitor: continue monitoring until a stop condition, blocker, or user stop."
  if (mode === "max-goal")
    return "max-goal: maxTurns is a budget cap, not a work plan; finish as soon as the goal is complete and verified."
  return "legacy: preserve existing loop behavior; use stop conditions and budget carefully."
}

function remainingBudget(workflow: LoopWorkflow.Info) {
  if (typeof workflow.policy.maxTurns !== "number") return "unlimited"
  return Math.max(0, workflow.policy.maxTurns - (workflow.metrics.turns ?? 0))
}

function checkpointGuidance(workflow: LoopWorkflow.Info) {
  if (workflow.spec.budgetMode === "unbounded-monitor") {
    return [
      "This is an unbounded monitor. A successful check is an iteration checkpoint, not workflow completion.",
      "For normal healthy monitoring iterations, report status: continue and next_action: sleep_until_next_interval.",
      "Only report status: stop when an explicit stop condition is met or the user asked the loop to stop. Use blocked/needs_input for blockers.",
    ].join("\n")
  }
  return "Work autonomously toward completing the objective, not toward consuming every iteration. If the goal is already complete, verify it and report status: complete instead of making more changes."
}

function workspacePolicyPrompt(workflow: LoopWorkflow.Info) {
  const mode = workflow.spec.workspace?.mode ?? "in-place"
  if (mode === "read-only")
    return "Workspace policy: read-only. Inspect and report only; do not edit files or run mutating shell commands."
  if (mode === "per-loop-worktree")
    return "Workspace policy: per-loop-worktree. Use the assigned loop workspace metadata when available; do not create, promote, or clean worktrees yourself unless explicitly instructed."
  if (mode === "per-run-worktree")
    return "Workspace policy: per-run-worktree. Use the assigned run workspace metadata when available; do not create, promote, or clean worktrees yourself unless explicitly instructed."
  return "Workspace policy: in-place. Work in the current project workspace and keep changes minimal and auditable."
}

function iterationPrompt(workflow: LoopWorkflow.Info, reason?: string) {
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
    reason?.trim() ? `Operator-requested run reason: ${reason.trim()}` : undefined,
    workspacePolicyPrompt(workflow),
    `Budget mode: ${budgetSemantics(workflow)}`,
    `Remaining iteration budget after this run starts: ${remaining}`,
    strategy?.targetTurns
      ? `Target completion window: aim to complete by about ${strategy.targetTurns} iterations if possible.`
      : undefined,
    reserve ? `Reserved verification/recovery turns: ${reserve}` : undefined,
    `Current phase: ${workflow.phase}`,
    `Next scheduled wakeup: ${next}`,
    "",
    loopMemoryPrompt(workflow),
    "",
    "Completion criteria:",
    numberedList(
      workflow.spec.completionCriteria,
      "Use the objective, stop conditions, and explicit user constraints as completion criteria.",
    ),
    "",
    "Success checks:",
    numberedList(
      workflow.spec.successChecks,
      "Run the most relevant available validation and explain any unavailable checks.",
    ),
    workflow.spec.validationChecks?.length
      ? [
          "Executable validation checks:",
          ...workflow.spec.validationChecks.map((check) => `- ${check.id}: ${check.command}`),
        ].join("\n")
      : undefined,
    "",
    `Gates: ${gates}`,
    `Stop conditions: ${stopWhen}`,
    `Approval required for: ${approval}`,
    "",
    reserveNote,
    checkpointGuidance(workflow),
    "Do not call the loop tool from inside a loop iteration; execute this workflow objective directly, and use the checkpoint block to report loop state.",
    "Do not push, merge, publish releases, send external messages, or perform destructive shell actions unless the user has explicitly approved that action in this session.",
    "",
    "End your final message with this exact machine-readable block:",
    "LOOP_CHECKPOINT:",
    "status: complete | continue | needs_input | blocked | stop",
    "summary: one concise sentence",
    "evidence:",
    "- validation, file, or observation",
    workflow.spec.budgetMode === "unbounded-monitor"
      ? "next_action: sleep_until_next_interval, stop, unblock steps, or next monitoring action"
      : "next_action: next useful action, or stop if complete",
    "confidence: high | medium | low",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n")
}

function reportOnlyPrompt(workflow: LoopWorkflow.Info, reason?: string) {
  return [
    iterationPrompt(workflow, reason),
    "",
    "REPORT-ONLY MODE:",
    "- Do not edit files.",
    "- Do not run mutating shell commands.",
    "- Produce an inspection checkpoint and next-action recommendation only.",
  ].join("\n")
}

function loopIterationTools(reportOnly: boolean): Record<string, boolean> {
  if (!reportOnly) return { loop: false }
  return {
    loop: false,
    edit: false,
    write: false,
    apply_patch: false,
    bash: false,
    task: false,
    todowrite: false,
    memory: false,
    memory_graph: false,
  }
}

const reportOnlyApprovalGates = ["edit", "write", "apply_patch", "shell", "subagent"]
const editAllowedApprovalGates = [
  "push",
  "merge",
  "release",
  "version-bump",
  "external-send",
  "destructive-shell",
  "broad-refactor",
]

function workflowIsReportOnly(workflow: LoopWorkflow.Info) {
  if (workflow.spec.workspace?.mode === "read-only") return true
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

function runTriggerFor(workflow: LoopWorkflow.Info): LoopWorkflow.RunTrigger {
  const mode = workflow.spec.trigger?.mode
  if (
    mode === "interval" ||
    mode === "daily" ||
    mode === "adaptive" ||
    mode === "external-signal" ||
    mode === "self-paced"
  )
    return mode
  return "manual"
}

function readinessDecision(
  workflow: LoopWorkflow.Info,
): { ready: true } | { ready: false; reason: string; nextWakeup?: number } {
  if (workflow.state === "blocked" || workflow.state === "needs_input") {
    return {
      ready: false,
      reason: `Loop is ${workflow.state}; resolve the blocking condition before running it again.`,
    }
  }
  if (typeof workflow.policy.maxTurns === "number" && (workflow.metrics.turns ?? 0) >= workflow.policy.maxTurns) {
    return {
      ready: false,
      reason: `Loop has no remaining iteration budget (${workflow.metrics.turns ?? 0}/${workflow.policy.maxTurns}).`,
    }
  }
  if (workflow.spec.trigger?.mode === "external-signal" && workflow.phase !== "signal_received") {
    return { ready: false, reason: "External-signal loop has no pending normalized signal evidence to process." }
  }
  return { ready: true }
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

function usageFromMessage(
  message: MessageV2.WithParts | undefined,
  workflow: LoopWorkflow.Info,
  started: number,
): LoopWorkflow.Usage | undefined {
  if (!message || message.info.role !== "assistant") return undefined
  return {
    providerID: message.info.providerID ?? workflow.spec.model?.providerID,
    modelID: message.info.modelID ?? workflow.spec.model?.modelID,
    variant: workflow.spec.model?.variant,
    cost: message.info.cost,
    durationMs: Math.max(0, Date.now() - started),
    tokens: {
      input: message.info.tokens?.input,
      output: message.info.tokens?.output,
      reasoning: message.info.tokens?.reasoning,
      cacheRead: message.info.tokens?.cache?.read,
      cacheWrite: message.info.tokens?.cache?.write,
    },
  }
}

function incompleteWorkerFailure(message: MessageV2.WithParts): {
  reason: string
  failureClass: LoopWorkflow.FailureClass
} {
  if (message.info.role !== "assistant" || !message.info.finish) {
    const hasToolAttempt = message.parts.some((part) => part.type === "tool")
    if (hasToolAttempt) {
      return {
        reason:
          "Loop worker ended after a tool call without a terminal finish. Automatic retry paused because the tool may have changed the workspace; inspect the loop chat and resume explicitly.",
        failureClass: "user_input",
      }
    }
    return {
      reason: "Loop worker ended without a terminal finish; retrying the iteration.",
      failureClass: "transient",
    }
  }
  return {
    reason: "Loop worker finished without a parseable LOOP_CHECKPOINT; retrying the iteration.",
    failureClass: "transient",
  }
}

function mergeUsage(usages: Array<LoopWorkflow.Usage | undefined>): LoopWorkflow.Usage | undefined {
  const items = usages.filter((item): item is LoopWorkflow.Usage => Boolean(item))
  if (!items.length) return undefined
  return items.reduce<LoopWorkflow.Usage>(
    (total, item) => ({
      providerID: total.providerID ?? item.providerID,
      modelID: total.modelID ?? item.modelID,
      variant: total.variant ?? item.variant,
      cost: (total.cost ?? 0) + (item.cost ?? 0),
      durationMs: (total.durationMs ?? 0) + (item.durationMs ?? 0),
      tokens: {
        input: (total.tokens?.input ?? 0) + (item.tokens?.input ?? 0),
        output: (total.tokens?.output ?? 0) + (item.tokens?.output ?? 0),
        reasoning: (total.tokens?.reasoning ?? 0) + (item.tokens?.reasoning ?? 0),
        cacheRead: (total.tokens?.cacheRead ?? 0) + (item.tokens?.cacheRead ?? 0),
        cacheWrite: (total.tokens?.cacheWrite ?? 0) + (item.tokens?.cacheWrite ?? 0),
      },
    }),
    { tokens: {} },
  )
}

function parseLoopBlock(text: string, marker: "LOOP_CHECKPOINT" | "LOOP_JUDGMENT"): ParsedLoopBlock | undefined {
  const match = text.match(new RegExp(`${marker}:\\s*([\\s\\S]*)$`, "i"))
  if (!match) return
  const block = match[1]
    .trim()
    .replace(/^```[\w-]*\s*/i, "")
    .replace(/\s*```\s*$/i, "")
  const parsed: ParsedLoopBlock = { evidence: [] }
  let inEvidence = false
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    if (/^status\s*:/i.test(line)) {
      parsed.status = line
        .replace(/^status\s*:\s*/i, "")
        .trim()
        .toLowerCase()
      inEvidence = false
      continue
    }
    if (/^summary\s*:/i.test(line)) {
      parsed.summary = line.replace(/^summary\s*:\s*/i, "").trim()
      inEvidence = false
      continue
    }
    if (/^evidence\s*:/i.test(line)) {
      const inline = line.replace(/^evidence\s*:\s*/i, "").trim()
      if (inline) parsed.evidence.push(inline)
      inEvidence = true
      continue
    }
    if (/^next(?:_|\s+)action\s*:/i.test(line)) {
      parsed.nextAction = line.replace(/^next(?:_|\s+)action\s*:\s*/i, "").trim()
      inEvidence = false
      continue
    }
    if (/^recommended(?:_|\s+)next(?:_|\s+)action\s*:/i.test(line)) {
      parsed.recommendedNextAction = line.replace(/^recommended(?:_|\s+)next(?:_|\s+)action\s*:\s*/i, "").trim()
      inEvidence = false
      continue
    }
    if (/^confidence\s*:/i.test(line)) {
      parsed.confidence = line.replace(/^confidence\s*:\s*/i, "").trim()
      inEvidence = false
      continue
    }
    if (inEvidence && /^[-*]\s+/.test(line)) {
      parsed.evidence.push(line.replace(/^[-*]\s+/, "").trim())
      continue
    }
    if (/^[a-z][\w-]*\s*:/i.test(line)) inEvidence = false
  }
  return parsed
}

function parseCheckpoint(text: string): LoopCheckpoint {
  const block = parseLoopBlock(text, "LOOP_CHECKPOINT")
  if (!block) return {}
  const statusRaw = block.status
  const status =
    statusRaw === "complete" ||
    statusRaw === "continue" ||
    statusRaw === "needs_input" ||
    statusRaw === "blocked" ||
    statusRaw === "stop"
      ? statusRaw
      : undefined
  return {
    status,
    summary: block.summary,
    evidence: block.evidence,
    nextAction: block.nextAction,
    confidence: block.confidence,
  }
}

function parseJudgment(text: string): LoopJudgment {
  const block = parseLoopBlock(text, "LOOP_JUDGMENT")
  if (!block) return { status: "uncertain", summary: "Evaluator did not return a LOOP_JUDGMENT block." }
  const statusRaw = block.status
  const status =
    statusRaw === "pass" ||
    statusRaw === "fail" ||
    statusRaw === "uncertain" ||
    statusRaw === "blocked" ||
    statusRaw === "needs_human"
      ? statusRaw
      : "uncertain"
  return {
    status,
    summary: block.summary,
    evidence: block.evidence,
    recommendedNextAction: block.recommendedNextAction,
    confidence: block.confidence,
  }
}

function requiresIndependentCompletion(workflow: LoopWorkflow.Info, checkpoint: LoopCheckpoint) {
  if (workflow.spec.budgetMode !== "max-goal") return false
  if (checkpoint.status !== "complete" && checkpoint.status !== "blocked") return false
  if (workflow.spec.evaluation?.allowWorkerSelfComplete === true) return false
  if (workflow.spec.evaluation?.confirmation === "next-run") return false
  return (
    workflow.spec.evaluation?.mode === "independent" ||
    workflow.spec.evaluation?.requireIndependentForCompletion === true
  )
}

function checkpointGate(checkpoint: LoopCheckpoint): LoopGateResult {
  if (checkpoint.status) {
    return {
      id: "checkpoint-proposal",
      status: "pass",
      summary: checkpoint.summary ?? `Worker proposed ${checkpoint.status}.`,
      failureClass: "none",
    }
  }
  return {
    id: "checkpoint-proposal",
    status: "fail",
    summary: "Worker did not provide a parseable LOOP_CHECKPOINT status.",
    failureClass: "quality",
  }
}

const sensitiveActionPatterns: Array<[string, RegExp]> = [
  ["push", /\b(git\s+push|pushed?|force[- ]?push)\b/i],
  ["merge", /\b(git\s+merge|merged?|merge\s+commit)\b/i],
  ["release", /\b(release|released|publish(?:ed)?|npm\s+publish)\b/i],
  ["version-bump", /\b(version\s+bump|bump(?:ed)?\s+version|changelog)\b/i],
  ["external-send", /\b(sent\s+(?:email|slack|webhook|notification|external)|external[- ]send|webhook)\b/i],
  ["destructive-shell", /\b(rm\s+-rf|git\s+reset\s+--hard|drop\s+table|delete(?:d)?\s+database|destructive)\b/i],
  ["broad-refactor", /\b(broad\s+refactor|large\s+refactor|mass\s+rename|across\s+the\s+codebase)\b/i],
]

function approvalGate(workflow: LoopWorkflow.Info, checkpoint: LoopCheckpoint): LoopGateResult | undefined {
  const corpus = [checkpoint.summary, checkpoint.nextAction, ...(checkpoint.evidence ?? [])]
    .filter((item): item is string => Boolean(item))
    .join("\n")
  const required = new Set([
    ...(workflow.policy.requireApprovalFor ?? []),
    ...(workflow.spec.approvalPolicy?.requireApprovalFor ?? []),
  ])
  const approved = new Set([
    ...(workflow.policy.approvedActions ?? []),
    ...(workflow.spec.approvalPolicy?.approvedActions ?? []),
  ])
  const attempted = sensitiveActionPatterns.flatMap(([action, pattern]) =>
    required.has(action) && pattern.test(corpus) ? [action] : [],
  )
  if (!attempted.length) return
  const missing = attempted.filter((action) => !approved.has(action))
  if (missing.length) {
    return {
      id: "approval-policy",
      status: "awaiting_approval",
      summary: `Approval required before completing action(s): ${missing.join(", ")}.`,
      failureClass: "policy",
    }
  }
  return {
    id: "approval-policy",
    status: "pass",
    summary: attempted.length
      ? `Sensitive action approvals present: ${attempted.join(", ")}.`
      : "No approval-required sensitive action was reported.",
    failureClass: "none",
  }
}

function evidenceCorpus(checkpoint: LoopCheckpoint, judgment: LoopJudgment | undefined) {
  return [...(checkpoint.evidence ?? []), ...(judgment?.evidence ?? [])]
    .filter((item): item is string => Boolean(item))
    .map((item) => item.toLowerCase())
}

function trimmedNonEmptyStrings(items: readonly string[] | undefined) {
  return items?.map((item) => item.trim()).filter((item): item is string => item.length > 0) ?? []
}

function successChecksGate(
  workflow: LoopWorkflow.Info,
  checkpoint: LoopCheckpoint,
  judgment: LoopJudgment | undefined,
): LoopGateResult | undefined {
  const checks = trimmedNonEmptyStrings(workflow.spec.successChecks)
  if (!checks.length) return
  const shouldEvaluate =
    checkpoint.status === "complete" || (checkpoint.status === "blocked" && judgment?.status === "pass")
  if (!shouldEvaluate) {
    return {
      id: "success-checks",
      status: "skip",
      summary: "Success checks are evaluated only when completion is proposed or independently verified.",
      failureClass: "none",
    }
  }
  const corpus = evidenceCorpus(checkpoint, judgment)
  const missing = checks.filter((check) => {
    const normalized = check.trim().toLowerCase()
    return !corpus.some((item) => item.includes(normalized))
  })
  if (!missing.length) {
    return {
      id: "success-checks",
      status: "pass",
      summary: `All configured success checks are represented in the reported evidence (${checks.length}/${checks.length}).`,
      failureClass: "none",
    }
  }
  return {
    id: "success-checks",
    status: "fail",
    summary: `Missing reported evidence for success checks: ${missing.join(", ")}`,
    failureClass: "quality",
  }
}

export function loopValidationCommandAllowed(command: string) {
  return completionValidationCommandAllowed(command)
}

function executeValidationChecks(
  workflowService: LoopWorkflow.Interface,
  workflow: LoopWorkflow.Info,
  run: LoopWorkflow.RunInfo,
  checkpoint: LoopCheckpoint,
  directory: string,
) {
  const checks = workflow.spec.validationChecks ?? []
  if (!checks.length || (checkpoint.status !== "complete" && checkpoint.status !== "blocked"))
    return Effect.succeed([] as LoopGateResult[])
  return Effect.gen(function* () {
    return yield* Effect.forEach(
      checks,
      (check) =>
        Effect.gen(function* () {
          const command = check.command.trim()
          const result: ValidationExecution = yield* runCompletionValidationCommand(
            command,
            run.workspaceLease?.state === "active" ? run.workspaceLease.path : directory,
            Math.max(1_000, Math.min(check.timeoutMs ?? 120_000, 10 * 60_000)),
            !workflowIsReportOnly(workflow),
          )
          const artifact = yield* workflowService
            .recordValidation({
              id: workflow.id,
              runID: run.id,
              checkID: check.id,
              command,
              status: result.status,
              summary: result.summary,
              output: result.output,
              exitCode: result.exitCode,
              durationMs: result.durationMs,
              timedOut: result.timedOut,
            })
            .pipe(Effect.orElseSucceed(() => undefined))
          if (!artifact) {
            return {
              id: `validation:${check.id}`,
              status: "blocked",
              summary: "Validation result was discarded because the loop run is no longer active.",
              failureClass: "environment",
            } satisfies LoopGateResult
          }
          return {
            id: `validation:${check.id}`,
            status: result.status,
            summary: result.summary,
            failureClass: result.failureClass,
            evidenceArtifacts: [artifact.id],
          } satisfies LoopGateResult
        }),
      { concurrency: 1 },
    )
  })
}

function rubricRequirementMet(input: {
  requirement: string
  workflow: LoopWorkflow.Info
  checkpoint: LoopCheckpoint
  judgment?: LoopJudgment
  gates: LoopGateResult[]
}) {
  const requirement = input.requirement.trim().toLowerCase()
  const validation = input.gates.filter((gate) => gate.id.startsWith("validation:"))
  const success = input.gates.find((gate) => gate.id === "success-checks")
  const approval = input.gates.find((gate) => gate.id === "approval-policy")
  const validationRequired = input.workflow.spec.validationChecks?.length ?? 0
  const successRequired = trimmedNonEmptyStrings(input.workflow.spec.successChecks).length > 0
  const validationPassed =
    validationRequired === 0 ||
    (validation.length === validationRequired && validation.every((gate) => gate.status === "pass"))
  const successPassed = !successRequired || success?.status === "pass"
  if (requirement === "checkpoint evidence") return Boolean(input.checkpoint.evidence?.length)
  if (requirement === "success checks") {
    return validationPassed && successPassed
  }
  if (requirement === "success check output" || requirement === "validation output") {
    const validationOutputRecorded =
      validationRequired === 0 ||
      (validation.length === validationRequired &&
        validation.every((gate) => gate.status === "pass" && Boolean(gate.evidenceArtifacts?.length)))
    const successEvidenceRecorded =
      !successRequired ||
      (successPassed && Boolean(input.checkpoint.evidence?.length || input.judgment?.evidence?.length))
    return validationOutputRecorded && successEvidenceRecorded
  }
  if (requirement === "policy gate status") return !approval || approval.status === "pass"
  if (requirement.startsWith("gate:"))
    return input.gates.find((gate) => gate.id === requirement.slice(5))?.status === "pass"
  return [
    ...(input.checkpoint.evidence ?? []),
    ...(input.judgment?.evidence ?? []),
    ...input.gates.map((gate) => `${gate.id} ${gate.status} ${gate.summary ?? ""}`),
  ].some((item) => item.toLowerCase().includes(requirement))
}

function evaluateRubric(
  workflow: LoopWorkflow.Info,
  checkpoint: LoopCheckpoint,
  judgment: LoopJudgment | undefined,
  gates: LoopGateResult[],
): LoopWorkflow.RubricResult | undefined {
  const rubric = workflow.spec.rubric
  if (
    !rubric ||
    (checkpoint.status !== "complete" && !(checkpoint.status === "blocked" && judgment?.status === "pass"))
  )
    return undefined
  const criteria = (rubric.criteria ?? []).map((criterion) => {
    const requirements = trimmedNonEmptyStrings(criterion.evidenceRequired)
    const evidence = requirements.filter((requirement) =>
      rubricRequirementMet({ requirement, workflow, checkpoint, judgment, gates }),
    )
    const passed = requirements.length
      ? evidence.length === requirements.length
      : Boolean(checkpoint.evidence?.length || judgment?.evidence?.length)
    const maxScore = 5
    const score = passed ? maxScore : 0
    return {
      id: criterion.id,
      score,
      maxScore,
      passed: passed && score >= (criterion.minScore ?? 0),
      reason: passed
        ? "Required runtime evidence is present."
        : `Missing required evidence: ${requirements.filter((item) => !evidence.includes(item)).join(", ") || "concrete completion evidence"}.`,
      evidence,
      weight: Math.max(0, criterion.weight ?? 1),
    }
  })
  const gateCorpus = gates
    .map((gate) => `${gate.id} ${gate.status} ${gate.summary ?? ""}`)
    .join("\n")
    .toLowerCase()
  const proposalCorpus = [...(checkpoint.evidence ?? []), ...(judgment?.evidence ?? []), judgment?.summary ?? ""]
    .join("\n")
    .toLowerCase()
  const blockers = (rubric.mandatoryBlockers ?? []).map((blocker) => {
    const normalized = blocker.toLowerCase()
    const present = /configured validation failed/.test(normalized)
      ? gates.some((gate) => gate.id.startsWith("validation:") && gate.status !== "pass")
      : /self[- ]assertion/.test(normalized)
        ? !(checkpoint.evidence?.length || judgment?.evidence?.length) || /self[- ]assert/.test(proposalCorpus)
        : /approval-required action/.test(normalized)
          ? gates.some((gate) => gate.id === "approval-policy" && gate.status !== "pass")
          : /secrets? or credentials? exposed/.test(normalized)
            ? /(?:bearer\s+[a-z0-9._~+/=-]{8,}|sk-[a-z0-9_-]{8,}|password\s*[:=]\s*\S+)/i.test(proposalCorpus)
            : gateCorpus.includes(normalized) || proposalCorpus.includes(normalized)
    return {
      id: blocker,
      present,
      reason: present ? `Mandatory blocker detected: ${blocker}.` : `Mandatory blocker not detected: ${blocker}.`,
    }
  })
  const totalWeight = criteria.reduce((sum, criterion) => sum + criterion.weight, 0)
  const score =
    totalWeight > 0
      ? criteria.reduce((sum, criterion) => sum + (criterion.score / criterion.maxScore) * criterion.weight, 0) /
        totalWeight
      : blockers.some((blocker) => blocker.present)
        ? 0
        : 1
  const threshold = Math.max(0, Math.min(1, rubric.passThreshold ?? 0.85))
  const blocked = blockers.some((blocker) => blocker.present)
  return {
    status: blocked
      ? "blocked"
      : score >= threshold && criteria.every((criterion) => criterion.passed)
        ? "pass"
        : "fail",
    score,
    threshold,
    criteria: criteria.map((criterion) => ({
      id: criterion.id,
      score: criterion.score,
      maxScore: criterion.maxScore,
      passed: criterion.passed,
      reason: criterion.reason,
      evidence: criterion.evidence,
    })),
    blockers,
  }
}

function evaluatorGate(judgment: LoopJudgment | undefined): LoopGateResult | undefined {
  if (!judgment) return
  if (judgment.status === "pass") {
    return {
      id: "independent-evaluator",
      status: "pass",
      summary: judgment.summary ?? "Independent evaluator accepted the completion proposal.",
      failureClass: "none",
    }
  }
  if (judgment.status === "needs_human") {
    return {
      id: "independent-evaluator",
      status: "awaiting_approval",
      summary: judgment.summary ?? "Independent evaluator requested human input.",
      failureClass: "user_input",
    }
  }
  if (judgment.failureClass) {
    return {
      id: "independent-evaluator",
      status: "blocked",
      summary:
        judgment.summary ?? `Independent evaluator failed before producing a verdict (${judgment.failureClass}).`,
      failureClass: judgment.failureClass,
    }
  }
  return {
    id: "independent-evaluator",
    status: judgment.status === "blocked" ? "blocked" : "fail",
    summary: judgment.summary ?? `Independent evaluator returned ${judgment.status ?? "uncertain"}.`,
    failureClass: judgment.status === "blocked" ? "environment" : "quality",
  }
}

function classifyEvaluatorFailure(error: string): LoopWorkflow.FailureClass {
  if (
    /\b(timeout|timed out|rate limit|429|econnreset|etimedout|eai_again|network|overloaded|temporar|retry|503|502|504|500)\b/i.test(
      error,
    )
  ) {
    return "transient"
  }
  return "environment"
}

function judgmentPrompt(workflow: LoopWorkflow.Info, checkpoint: LoopCheckpoint, gates: LoopGateResult[]) {
  const criteria = compileCompletionCriteria(
    workflow.spec.completionCriteria?.length ? workflow.spec.completionCriteria : [workflow.objective],
  )
  const successChecks = numberedList(
    workflow.spec.successChecks,
    "No explicit success checks were configured; evaluate only the evidence provided.",
  )
  const rubric = workflow.spec.rubric
  return [
    `Independent loop evaluator: ${workflow.name}`,
    "",
    "You are the judge, not the worker. Do not continue the implementation. Do not edit files. Evaluate whether the worker's completion proposal is actually supported by the evidence.",
    "If evidence is missing, malformed, unverifiable, or merely self-asserted, do not pass it.",
    "",
    `Objective: ${workflow.objective}`,
    "",
    "Completion criteria:",
    criteria.map((criterion) => `- ${criterion.id}: ${criterion.description}`).join("\n"),
    "",
    "Success checks:",
    successChecks,
    "",
    rubric?.name ? `Rubric: ${rubric.name}` : undefined,
    rubric?.criteria?.length
      ? ["Rubric criteria:", ...rubric.criteria.map((item) => `- ${item.id}: ${item.description}`)].join("\n")
      : undefined,
    rubric?.mandatoryBlockers?.length
      ? ["Mandatory blockers:", ...rubric.mandatoryBlockers.map((item) => `- ${item}`)].join("\n")
      : undefined,
    "",
    "Deterministic gate results (authoritative; the judge cannot override failures):",
    gates.length
      ? gates
          .map(
            (gate) =>
              `- ${gate.id}: ${gate.status} · ${gate.summary ?? "no summary"}${gate.evidenceArtifacts?.length ? ` · artifacts ${gate.evidenceArtifacts.join(", ")}` : ""}`,
          )
          .join("\n")
      : "- no deterministic gate results were recorded",
    "",
    "Worker completion proposal (untrusted):",
    `status: ${checkpoint.status ?? "missing"}`,
    `summary: ${checkpoint.summary ?? "missing"}`,
    `confidence: ${checkpoint.confidence ?? "missing"}`,
    checkpoint.evidence?.length
      ? ["evidence:", ...checkpoint.evidence.map((item) => `- ${item}`)].join("\n")
      : "evidence: none",
    checkpoint.nextAction ? `next_action: ${checkpoint.nextAction}` : undefined,
    "",
    "End your final message with this exact machine-readable block:",
    "LOOP_JUDGMENT:",
    "status: pass | fail | uncertain | blocked | needs_human",
    "summary: one concise sentence explaining the verdict",
    "evidence:",
    "- criterion-1: concrete evidence inspected for that criterion",
    "Include at least one concrete evidence item prefixed with each criterion id. A passing verdict without per-criterion evidence will be rejected.",
    "recommended_next_action: complete, continue, retry, ask_user, or block",
    "confidence: high | medium | low",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n")
}

function workspaceFingerprintGate(result: Awaited<ReturnType<typeof fingerprintWorkspace>>): LoopGateResult {
  return {
    id: "workspace-fingerprint",
    status: result.status === "ok" ? "pass" : "blocked",
    summary: result.summary,
    failureClass: result.status === "ok" ? "none" : "environment",
  }
}

function auditInspectionGate(messages: readonly MessageV2.WithParts[]): LoopGateResult {
  const tools = new Map(
    messages.flatMap((message) =>
      message.parts.flatMap((part) =>
        part.type === "tool" &&
        part.state.status === "completed" &&
        (part.tool === "read" || part.tool === "grep" || part.tool === "glob")
          ? [[part.callID, part.tool] as const]
          : [],
      ),
    ),
  )
  return {
    id: "audit-inspection",
    status: tools.size ? "pass" : "fail",
    summary: tools.size
      ? `Fresh auditor completed ${tools.size} read-only workspace inspection(s).`
      : "Fresh auditor returned without completing a read, grep, or glob workspace inspection.",
    failureClass: tools.size ? "none" : "quality",
  }
}

function completionCandidate(input: {
  workflow: LoopWorkflow.Info
  run: LoopWorkflow.RunInfo
  checkpoint: LoopCheckpoint
  fingerprint?: string
  now: number
}): CompletionProgress {
  return {
    status: "candidate",
    generation: (input.workflow.metrics.turns ?? 0) + 1,
    sourceID: input.run.id,
    auditAttempts: 0,
    ...(input.fingerprint ? { candidateFingerprint: input.fingerprint } : {}),
    ...(input.checkpoint.summary ? { summary: input.checkpoint.summary } : {}),
    createdAt: input.now,
    updatedAt: input.now,
  }
}

function auditReceipt(input: {
  workflow: LoopWorkflow.Info
  candidate: CompletionProgress
  judgment: LoopJudgment | undefined
  fingerprintBefore?: string
  fingerprintAfter?: string
  now: number
}): CompletionAuditReceipt {
  const status = input.judgment?.status ?? "uncertain"
  const evidence = input.judgment?.evidence ?? []
  const criteria = compileCompletionCriteria(
    input.workflow.spec.completionCriteria?.length
      ? input.workflow.spec.completionCriteria
      : [input.workflow.objective],
  )
  return {
    generation: input.candidate.generation,
    status,
    summary: input.judgment?.summary ?? "Completion auditor did not return a parseable verdict.",
    criteria: criteria.map((criterion) => {
      const criterionEvidence = evidence.filter((item) => item.toLowerCase().includes(criterion.id.toLowerCase()))
      return {
        id: criterion.id,
        status: status === "pass" && criterionEvidence.length === 0 ? ("uncertain" as const) : status,
        summary: criterionEvidence.length
          ? (input.judgment?.summary ?? `${criterion.id} verified.`)
          : `No concrete audit evidence was recorded for ${criterion.id}.`,
        evidence: criterionEvidence.map((item, index) => ({
          id: `audit:${input.candidate.generation}:${criterion.id}:${index + 1}`,
          kind: "observation" as const,
          summary: item,
          source: "independent-evaluator",
        })),
      }
    }),
    ...(input.fingerprintBefore ? { fingerprintBefore: input.fingerprintBefore } : {}),
    ...(input.fingerprintAfter ? { fingerprintAfter: input.fingerprintAfter } : {}),
    recommendedNextAction: input.judgment?.recommendedNextAction ?? "retry",
    createdAt: input.now,
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
    checkpoint.evidence?.length
      ? ["Evidence:", ...checkpoint.evidence.map((item) => `- ${item}`)].join("\n")
      : undefined,
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
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const instance = yield* InstanceState.context
      const id = input.id
      const before = yield* workflow.get(id, input.now)
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
      const now = input.now ?? Date.now()
      const readiness = readinessDecision(before)
      if (!readiness.ready) {
        const skipped = yield* workflow.recordReadinessSkip({
          id,
          trigger: runTriggerFor(before),
          reason: readiness.reason,
          nextWakeup: readiness.nextWakeup,
          now,
        })
        return {
          workflowID: id,
          state: "skipped",
          summary: skipped.evaluatorReason ?? readiness.reason,
        } satisfies TickResult
      }
      const latestCompletionRun =
        before.spec.evaluation?.confirmation === "next-run"
          ? (yield* workflow.snapshot(id, 20)).runs.find((item) => item.completion !== undefined)
          : undefined
      const pendingCompletionRun =
        latestCompletionRun?.completion?.status === "candidate" ? latestCompletionRun : undefined
      const leaseHolder = `loop-runner:${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`
      const run = yield* workflow.startRun({ id, trigger: input.trigger ?? runTriggerFor(before), leaseHolder, now })
      if (run.lease?.holder !== leaseHolder) {
        return {
          workflowID: id,
          runID: run.id,
          state: "skipped",
          summary: `Loop already has an active run (${run.id}); skipping duplicate execution.`,
        } satisfies TickResult
      }
      const current = yield* workflow.get(id, now)
      if (!current.rootSessionID) {
        return yield* workflow
          .failRun({ id, runID: run.id, error: "Loop has no root session after activation.", now })
          .pipe(
            Effect.map((failed) => ({
              workflowID: id,
              runID: failed.id,
              state: "failed" as const,
              summary: failed.evaluatorReason ?? "Loop run failed.",
            })),
          )
      }
      if (pendingCompletionRun?.completion?.status === "candidate") {
        const candidate = {
          ...pendingCompletionRun.completion,
          status: "auditing" as const,
          auditAttempts: pendingCompletionRun.completion.auditAttempts + 1,
          updatedAt: now,
        }
        const checkpoint: LoopCheckpoint = pendingCompletionRun.checkpoint ?? {
          status: "complete",
          summary: pendingCompletionRun.evaluatorReason ?? "Previous loop run proposed completion.",
          evidence: [],
          nextAction: "audit",
          confidence: "medium",
        }
        const directory = pendingCompletionRun.workspaceLease?.path ?? instance.directory
        const fingerprintBeforeResult = yield* Effect.promise(() => fingerprintWorkspace(directory))
        const validationRun = pendingCompletionRun.workspaceLease
          ? { ...run, workspaceLease: pendingCompletionRun.workspaceLease }
          : run
        const validationGates = yield* executeValidationChecks(workflow, current, validationRun, checkpoint, directory)
        const priorGates = (pendingCompletionRun.gateResults ?? []).filter(
          (gate) => gate.id !== "independent-evaluator",
        )
        const preJudgeGates = Array.from(
          new Map(
            [...priorGates, ...validationGates, workspaceFingerprintGate(fingerprintBeforeResult)].map((gate) => [
              gate.id,
              gate,
            ]),
          ).values(),
        )
        let judgment: LoopJudgment
        let evaluatorUsage: LoopWorkflow.Usage | undefined
        let inspectionGate = auditInspectionGate([])
        if (fingerprintBeforeResult.status !== "ok") {
          judgment = {
            status: "blocked",
            summary: fingerprintBeforeResult.summary,
            evidence: [],
            recommendedNextAction: "block",
            confidence: "high",
            failureClass: "environment",
          }
        } else if (candidate.candidateFingerprint && fingerprintBeforeResult.value !== candidate.candidateFingerprint) {
          judgment = {
            status: "fail",
            summary: "Workspace changed after the completion candidate was recorded.",
            evidence: ["candidate and audit workspace fingerprints differ"],
            recommendedNextAction: "continue",
            confidence: "high",
            failureClass: "quality",
          }
        } else {
          const evaluatorSession = yield* sessions.create({
            parentID: current.rootSessionID,
            title: `Loop completion audit: ${current.name}`,
          })
          const evaluatorStarted = Date.now()
          const evaluatorResult = yield* prompt
            .prompt({
              sessionID: evaluatorSession.id,
              agent: current.spec.evaluation?.evaluatorAgent ?? current.spec.agent,
              model: promptModel(current),
              variant: current.spec.model?.variant,
              tools: loopIterationTools(true),
              parts: [
                {
                  type: "text",
                  text: [
                    judgmentPrompt(current, checkpoint, preJudgeGates),
                    "",
                    `This is a fresh terminal audit iteration for candidate generation ${candidate.generation}.`,
                    `Inspect the current workspace at ${directory}; do not rely only on the worker summary.`,
                    "Verify every completion criterion against current files and recorded deterministic gates.",
                  ].join("\n"),
                },
              ],
            })
            .pipe(
              Effect.map((message) => ({ message, judgment: parseJudgment(assistantText(message)) })),
              Effect.catchCause((cause) => {
                const error = errorMessage(Cause.squash(cause))
                return Effect.succeed({
                  judgment: {
                    status: "uncertain" as const,
                    summary: `Evaluator failed: ${error}`,
                    recommendedNextAction: "retry",
                    confidence: "low",
                    failureClass: classifyEvaluatorFailure(error),
                  },
                })
              }),
            )
          const evaluatorMessage = "message" in evaluatorResult ? evaluatorResult.message : undefined
          evaluatorUsage = usageFromMessage(evaluatorMessage, current, evaluatorStarted)
          judgment = evaluatorResult.judgment
          const auditMessages = yield* sessions
            .messages({ sessionID: evaluatorSession.id, view: "full" })
            .pipe(Effect.catchCause(() => Effect.succeed([])))
          inspectionGate = auditInspectionGate(evaluatorMessage ? [...auditMessages, evaluatorMessage] : auditMessages)
        }
        const fingerprintAfterResult = yield* Effect.promise(() => fingerprintWorkspace(directory))
        if (
          fingerprintBeforeResult.status === "ok" &&
          fingerprintAfterResult.status === "ok" &&
          fingerprintBeforeResult.value !== fingerprintAfterResult.value
        ) {
          judgment = {
            status: "fail",
            summary: "Workspace changed while the completion audit was running.",
            evidence: ["pre-audit and post-audit workspace fingerprints differ"],
            recommendedNextAction: "continue",
            confidence: "high",
            failureClass: "quality",
          }
        }
        const fingerprintsAvailable = fingerprintAfterResult.status === "ok" && fingerprintBeforeResult.status === "ok"
        const fingerprintStable =
          fingerprintsAvailable && fingerprintAfterResult.value === fingerprintBeforeResult.value
        const fingerprintMatchesCandidate =
          fingerprintsAvailable &&
          (!candidate.candidateFingerprint || fingerprintBeforeResult.value === candidate.candidateFingerprint)
        const fingerprintGate: LoopGateResult =
          fingerprintStable && fingerprintMatchesCandidate
            ? {
                id: "workspace-fingerprint",
                status: "pass",
                summary: "Workspace fingerprint matched the candidate and stayed stable throughout the audit.",
                failureClass: "none",
              }
            : fingerprintsAvailable
              ? {
                  id: "workspace-fingerprint",
                  status: "fail",
                  summary: "Workspace fingerprint changed after completion was proposed or during its audit.",
                  failureClass: "quality",
                }
              : {
                  id: "workspace-fingerprint",
                  status: "blocked",
                  summary: fingerprintAfterResult.summary,
                  failureClass: "environment",
                }
        const deterministicGates = Array.from(
          new Map(
            [
              ...preJudgeGates.filter((gate) => gate.id !== "workspace-fingerprint"),
              fingerprintGate,
              inspectionGate,
              successChecksGate(current, checkpoint, judgment),
            ]
              .filter((item): item is LoopGateResult => Boolean(item))
              .map((gate) => [gate.id, gate]),
          ).values(),
        )
        const gateResults = [...deterministicGates, evaluatorGate(judgment)].filter((item): item is LoopGateResult =>
          Boolean(item),
        )
        const receipt = auditReceipt({
          workflow: current,
          candidate,
          judgment,
          fingerprintBefore: fingerprintBeforeResult.status === "ok" ? fingerprintBeforeResult.value : undefined,
          fingerprintAfter: fingerprintAfterResult.status === "ok" ? fingerprintAfterResult.value : undefined,
          now,
        })
        const completed = yield* workflow.completeRun({
          id,
          runID: run.id,
          reason: judgment.summary,
          now,
          goalStatus: "complete",
          checkpoint,
          judgment,
          rubricResult: evaluateRubric(current, checkpoint, judgment, gateResults),
          gateResults,
          usage: evaluatorUsage,
          completion: { candidate, receipt },
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
              parts: [
                {
                  type: "text",
                  text: parentCompletionPrompt(after, { ...checkpoint, summary: receipt.summary }, completed.id),
                },
              ],
            })
            .pipe(Effect.ignore)
        }
        return {
          workflowID: id,
          runID: completed.id,
          state:
            after.state === "blocked" ||
            after.state === "needs_input" ||
            after.state === "stopped" ||
            after.state === "failed"
              ? after.state
              : "completed",
          summary: after.evaluatorReason ?? receipt.summary,
        } satisfies TickResult
      }
      if (current.spec.workflow) {
        const workflowService = Option.getOrUndefined(yield* Effect.serviceOption(WorkflowService.Service))
        const workflowRunner = Option.getOrUndefined(yield* Effect.serviceOption(WorkflowRunner.Service))
        if (!workflowService || !workflowRunner) {
          const error = "Loop workflow adapter services are unavailable."
          const failed = yield* workflow.failRun({ id, runID: run.id, error, failureClass: "environment", now })
          return {
            workflowID: id,
            runID: failed.id,
            state:
              failed.state === "blocked"
                ? "blocked"
                : failed.state === "needs_input"
                  ? "needs_input"
                  : failed.state === "stopped"
                    ? "stopped"
                    : "failed",
            summary: failed.evaluatorReason ?? error,
          } satisfies TickResult
        }
        const reference = current.spec.workflow
        const startedExit = yield* Effect.exit(
          workflowService.start({
            ...(reference.revisionID === undefined ? {} : { revisionID: reference.revisionID as never }),
            ...(reference.definitionID === undefined ? {} : { definitionID: reference.definitionID as never }),
            originSessionID: current.rootSessionID,
            loopID: current.id,
            loopRunID: run.id,
            overlapKey: reference.overlapKey ?? `${current.id}:${run.id}`,
          } as never),
        )
        if (startedExit._tag === "Failure") {
          const error = errorMessage(Cause.squash(startedExit.cause))
          const failed = yield* workflow.failRun({ id, runID: run.id, error, failureClass: "policy", now })
          return {
            workflowID: id,
            runID: failed.id,
            state:
              failed.state === "blocked"
                ? "blocked"
                : failed.state === "needs_input"
                  ? "needs_input"
                  : failed.state === "stopped"
                    ? "stopped"
                    : "failed",
            summary: failed.evaluatorReason ?? error,
          } satisfies TickResult
        }
        const startedWorkflow = startedExit.value
        if (startedWorkflow.run.loopRunID !== run.id) {
          const skipped = yield* workflow.completeRun({
            id,
            runID: run.id,
            reason: `Workflow overlap is already owned by loop run ${startedWorkflow.run.loopRunID ?? "another run"}.`,
            now,
            goalStatus: "continue",
            checkpoint: {
              status: "continue",
              summary: "Skipped overlapping workflow execution.",
              nextAction: "Wait for the existing workflow run to finish.",
            },
          })
          return {
            workflowID: id,
            runID: skipped.id,
            state: "skipped",
            summary: skipped.evaluatorReason ?? "Skipped overlapping workflow execution.",
          } satisfies TickResult
        }
        const workflowExit = yield* Effect.exit(workflowRunner.run(startedWorkflow.run.id))
        if (workflowExit._tag === "Failure") {
          const error = errorMessage(Cause.squash(workflowExit.cause))
          yield* workflowService
            .stop({ runID: startedWorkflow.run.id, reason: error, actor: "loop-adapter" })
            .pipe(Effect.catchCause(() => Effect.void))
          const failed = yield* workflow.failRun({ id, runID: run.id, error, failureClass: "environment", now })
          return {
            workflowID: id,
            runID: failed.id,
            state:
              failed.state === "blocked"
                ? "blocked"
                : failed.state === "needs_input"
                  ? "needs_input"
                  : failed.state === "stopped"
                    ? "stopped"
                    : "failed",
            summary: failed.evaluatorReason ?? error,
          } satisfies TickResult
        }
        const finishedWorkflow = yield* workflowService.show(startedWorkflow.run.id)
        if (finishedWorkflow.run.state === "failed") {
          const error = finishedWorkflow.tasks.find((task) => task.blocker)?.blocker ?? "Referenced workflow failed."
          const failed = yield* workflow.failRun({ id, runID: run.id, error, failureClass: "terminal", now })
          return {
            workflowID: id,
            runID: failed.id,
            state:
              failed.state === "blocked"
                ? "blocked"
                : failed.state === "needs_input"
                  ? "needs_input"
                  : failed.state === "stopped"
                    ? "stopped"
                    : "failed",
            summary: failed.evaluatorReason ?? error,
          } satisfies TickResult
        }
        const goalStatus =
          finishedWorkflow.run.state === "completed"
            ? ("complete" as const)
            : finishedWorkflow.run.state === "stopped"
              ? ("stop" as const)
              : finishedWorkflow.run.state === "needs_input"
                ? ("needs_input" as const)
                : ("blocked" as const)
        const usage = finishedWorkflow.usage
          ? {
              cost: finishedWorkflow.usage.cost,
              tokens: {
                input: finishedWorkflow.usage.inputTokens,
                output: finishedWorkflow.usage.outputTokens,
              },
            }
          : undefined
        const completed = yield* workflow.completeRun({
          id,
          runID: run.id,
          reason:
            finishedWorkflow.run.state === "completed"
              ? "Referenced workflow completed."
              : `Referenced workflow is ${finishedWorkflow.run.state}.`,
          now,
          goalStatus,
          checkpoint: {
            status: goalStatus,
            summary:
              finishedWorkflow.run.state === "completed"
                ? "Referenced workflow completed."
                : `Referenced workflow is ${finishedWorkflow.run.state}.`,
            evidence: finishedWorkflow.artifacts.slice(0, 8).map((artifact) => artifact.summary),
          },
          usage,
        })
        const after = yield* workflow.get(id)
        return {
          workflowID: id,
          runID: completed.id,
          state:
            after.state === "blocked" ||
            after.state === "needs_input" ||
            after.state === "stopped" ||
            after.state === "failed"
              ? after.state
              : "completed",
          summary: after.evaluatorReason ?? completed.evaluatorReason ?? "Referenced workflow run completed.",
        } satisfies TickResult
      }
      const reportOnly =
        workflowIsReportOnly(current) || (input.reportOnly === true && !workflowExplicitlyAllowsEdits(current))
      const runStarted = Date.now()
      const result = yield* prompt
        .prompt({
          sessionID: current.rootSessionID,
          agent: current.spec.agent,
          model: promptModel(current),
          variant: current.spec.model?.variant,
          tools: loopIterationTools(reportOnly),
          parts: [
            {
              type: "text",
              text: reportOnly ? reportOnlyPrompt(current, input.reason) : iterationPrompt(current, input.reason),
            },
          ],
        })
        .pipe(Effect.exit)
      if (result._tag === "Failure") {
        const message = errorMessage(Cause.squash(result.cause))
        const failed = yield* workflow.failRun({ id, runID: run.id, error: message, now })
        const after = yield* workflow.get(id)
        return {
          workflowID: id,
          runID: failed.id,
          state: "failed",
          summary: failed.retry
            ? `Loop run failed with ${failed.failureClass ?? "retryable"}; retry scheduled for ${new Date(failed.retry.nextWakeup ?? after.nextWakeup ?? Date.now()).toISOString()}. ${message}`
            : (failed.evaluatorReason ?? after.evaluatorReason ?? message),
        } satisfies TickResult
      }
      if (result.value.info.role !== "assistant" || !result.value.info.finish) {
        const incomplete = incompleteWorkerFailure(result.value)
        const failed = yield* workflow.failRun({
          id,
          runID: run.id,
          error: incomplete.reason,
          failureClass: incomplete.failureClass,
          now,
        })
        return {
          workflowID: id,
          runID: failed.id,
          state: failed.state === "needs_input" ? ("needs_input" as const) : ("failed" as const),
          summary: failed.retry
            ? `Loop run retry scheduled for ${new Date(failed.retry.nextWakeup ?? Date.now()).toISOString()}. ${incomplete.reason}`
            : (failed.evaluatorReason ?? incomplete.reason),
        } satisfies TickResult
      }
      const checkpoint = parseCheckpoint(assistantText(result.value))
      if (!checkpoint.status) {
        const incomplete = incompleteWorkerFailure(result.value)
        const failed = yield* workflow.failRun({
          id,
          runID: run.id,
          error: incomplete.reason,
          failureClass: incomplete.failureClass,
          now,
        })
        return {
          workflowID: id,
          runID: failed.id,
          state: "failed" as const,
          summary: failed.retry
            ? `Loop run retry scheduled for ${new Date(failed.retry.nextWakeup ?? Date.now()).toISOString()}. ${incomplete.reason}`
            : (failed.evaluatorReason ?? incomplete.reason),
        } satisfies TickResult
      }
      const validationGates = yield* executeValidationChecks(workflow, current, run, checkpoint, instance.directory)
      const preJudgeGates = [checkpointGate(checkpoint), approvalGate(current, checkpoint), ...validationGates].filter(
        (item): item is LoopGateResult => Boolean(item),
      )
      let judgment: LoopJudgment | undefined
      let evaluatorUsage: LoopWorkflow.Usage | undefined
      let evaluatorStarted: number | undefined
      if (requiresIndependentCompletion(current, checkpoint)) {
        const evaluatorSession = yield* sessions.create({
          parentID: current.rootSessionID,
          title: `Loop evaluator: ${current.name}`,
        })
        evaluatorStarted = Date.now()
        const evaluatorResult = yield* prompt
          .prompt({
            sessionID: evaluatorSession.id,
            agent: current.spec.evaluation?.evaluatorAgent ?? current.spec.agent,
            model: promptModel(current),
            variant: current.spec.model?.variant,
            tools: loopIterationTools(true),
            parts: [{ type: "text", text: judgmentPrompt(current, checkpoint, preJudgeGates) }],
          })
          .pipe(
            Effect.map((message) => ({
              message,
              judgment: parseJudgment(assistantText(message)),
            })),
            Effect.catchCause((cause) => {
              const error = errorMessage(Cause.squash(cause))
              return Effect.succeed({
                judgment: {
                  status: "uncertain" as const,
                  summary: `Evaluator failed: ${error}`,
                  recommendedNextAction: "retry",
                  confidence: "low",
                  failureClass: classifyEvaluatorFailure(error),
                },
              })
            }),
          )
        const evaluatorMessage = "message" in evaluatorResult ? evaluatorResult.message : undefined
        evaluatorUsage = evaluatorStarted ? usageFromMessage(evaluatorMessage, current, evaluatorStarted) : undefined
        judgment = evaluatorResult.judgment
      }
      const deterministicGates = [...preJudgeGates, successChecksGate(current, checkpoint, judgment)].filter(
        (item): item is LoopGateResult => Boolean(item),
      )
      const candidateFingerprintResult =
        current.spec.evaluation?.confirmation === "next-run" && checkpoint.status === "complete"
          ? yield* Effect.promise(() =>
              fingerprintWorkspace(
                run.workspaceLease?.state === "active" ? run.workspaceLease.path : instance.directory,
              ),
            )
          : undefined
      const gateResults = [
        ...deterministicGates,
        evaluatorGate(judgment),
        candidateFingerprintResult ? workspaceFingerprintGate(candidateFingerprintResult) : undefined,
      ].filter((item): item is LoopGateResult => Boolean(item))
      const candidate =
        candidateFingerprintResult?.status === "ok"
          ? completionCandidate({
              workflow: current,
              run,
              checkpoint,
              fingerprint: candidateFingerprintResult.value,
              now,
            })
          : undefined
      const completed = yield* workflow.completeRun({
        id,
        runID: run.id,
        reason: judgment?.summary ?? checkpoint.summary ?? "Iteration completed by session runner.",
        now,
        goalStatus: checkpoint.status,
        checkpoint,
        judgment,
        rubricResult: evaluateRubric(current, checkpoint, judgment, gateResults),
        gateResults,
        usage: mergeUsage([usageFromMessage(result.value, current, runStarted), evaluatorUsage]),
        ...(candidate ? { completion: { candidate } } : {}),
      })
      const after = yield* workflow.get(id)
      const summary =
        after.state === "blocked" ||
        after.state === "needs_input" ||
        after.state === "stopped" ||
        after.state === "failed"
          ? (completed.evaluatorReason ??
            after.evaluatorReason ??
            judgment?.summary ??
            checkpoint.summary ??
            "Loop run completed.")
          : (judgment?.summary ?? checkpoint.summary ?? completed.evaluatorReason ?? "Loop run completed.")
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
            parts: [
              {
                type: "text",
                text: parentCompletionPrompt(
                  after,
                  { ...checkpoint, summary: judgment?.summary ?? checkpoint.summary },
                  completed.id,
                ),
              },
            ],
          })
          .pipe(Effect.ignore)
      }
      return {
        workflowID: id,
        runID: completed.id,
        state: completed.state === "queued" || completed.state === "working" ? "completed" : completed.state,
        summary,
      } satisfies TickResult
    })

    const runDue = Effect.fn("LoopRunner.runDue")(function* (input?: {
      now?: number
      limit?: number
      execute?: boolean
      reportOnly?: boolean
    }) {
      const workflow = yield* LoopWorkflow.Service
      const now = input?.now ?? Date.now()
      const due = yield* workflow.due({ now, limit: input?.limit })
      return yield* Effect.forEach(
        due,
        (item) =>
          runOne({ id: item.id, execute: input?.execute, reportOnly: input?.reportOnly, now }).pipe(
            Effect.catchCause((cause) => {
              const error = errorMessage(Cause.squash(cause))
              return workflow.recordSchedulerFailure({ id: item.id, error, now }).pipe(
                Effect.map(
                  (failed) =>
                    ({
                      workflowID: item.id,
                      runID: failed.id,
                      state:
                        failed.state === "blocked"
                          ? "blocked"
                          : failed.state === "needs_input"
                            ? "needs_input"
                            : failed.state === "stopped"
                              ? "stopped"
                              : failed.state === "completed"
                                ? "completed"
                                : "failed",
                      summary: failed.evaluatorReason ?? `Loop scheduler failed: ${error}`,
                    }) satisfies TickResult,
                ),
                Effect.catchCause(() =>
                  Effect.succeed({
                    workflowID: item.id,
                    state: "failed" as const,
                    summary: `Loop scheduler failed: ${error}`,
                  } satisfies TickResult),
                ),
              )
            }),
          ),
        { concurrency: Math.max(1, due.length) },
      )
    })

    return Service.of({ runOne, runDue })
  }),
)

export const defaultLayer = Layer.suspend(() => layer)

export * as LoopRunner from "./loop-runner"
