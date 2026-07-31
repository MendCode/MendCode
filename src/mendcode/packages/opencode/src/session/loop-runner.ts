import { Cause, Context, Effect, Layer, Schema, Types } from "effect"
import { errorMessage } from "@/util/error"
import { SessionPrompt } from "@/session/prompt"
import { LoopWorkflow } from "@/session/loop"
import * as MessageV2 from "@/session/message-v2"
import { Session } from "@/session/session"
import { ModelID, ProviderID } from "@/provider/schema"
import { InstanceState } from "@/effect/instance-state"

export const TickResult = Schema.Struct({
  workflowID: LoopWorkflow.LoopID,
  runID: Schema.optional(LoopWorkflow.RunID),
  state: Schema.Literals(["completed", "failed", "blocked", "needs_input", "stopped", "skipped"]),
  summary: Schema.String,
})
export type TickResult = Types.DeepMutable<Schema.Schema.Type<typeof TickResult>>

export interface Interface {
  readonly runOne: (input: RunOneInput) => Effect.Effect<TickResult, unknown, LoopWorkflow.Service | SessionPrompt.Service | Session.Service>
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
  if (mode === "unbounded-monitor") return "unbounded-monitor: continue monitoring until a stop condition, blocker, or user stop."
  if (mode === "max-goal") return "max-goal: maxTurns is a budget cap, not a work plan; finish as soon as the goal is complete and verified."
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
  if (mode === "read-only") return "Workspace policy: read-only. Inspect and report only; do not edit files or run mutating shell commands."
  if (mode === "per-loop-worktree") return "Workspace policy: per-loop-worktree. Use the assigned loop workspace metadata when available; do not create, promote, or clean worktrees yourself unless explicitly instructed."
  if (mode === "per-run-worktree") return "Workspace policy: per-run-worktree. Use the assigned run workspace metadata when available; do not create, promote, or clean worktrees yourself unless explicitly instructed."
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
    strategy?.targetTurns ? `Target completion window: aim to complete by about ${strategy.targetTurns} iterations if possible.` : undefined,
    reserve ? `Reserved verification/recovery turns: ${reserve}` : undefined,
    `Current phase: ${workflow.phase}`,
    `Next scheduled wakeup: ${next}`,
    "",
    loopMemoryPrompt(workflow),
    "",
    "Completion criteria:",
    numberedList(workflow.spec.completionCriteria, "Use the objective, stop conditions, and explicit user constraints as completion criteria."),
    "",
    "Success checks:",
    numberedList(workflow.spec.successChecks, "Run the most relevant available validation and explain any unavailable checks."),
    workflow.spec.validationChecks?.length
      ? ["Executable validation checks:", ...workflow.spec.validationChecks.map((check) => `- ${check.id}: ${check.command}`)].join("\n")
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
const editAllowedApprovalGates = ["push", "merge", "release", "version-bump", "external-send", "destructive-shell", "broad-refactor"]

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
  if (mode === "interval" || mode === "daily" || mode === "adaptive" || mode === "external-signal" || mode === "self-paced") return mode
  return "manual"
}

function readinessDecision(workflow: LoopWorkflow.Info): { ready: true } | { ready: false; reason: string; nextWakeup?: number } {
  if (workflow.state === "blocked" || workflow.state === "needs_input") {
    return { ready: false, reason: `Loop is ${workflow.state}; resolve the blocking condition before running it again.` }
  }
  if (typeof workflow.policy.maxTurns === "number" && (workflow.metrics.turns ?? 0) >= workflow.policy.maxTurns) {
    return { ready: false, reason: `Loop has no remaining iteration budget (${workflow.metrics.turns ?? 0}/${workflow.policy.maxTurns}).` }
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

function usageFromMessage(message: MessageV2.WithParts | undefined, workflow: LoopWorkflow.Info, started: number): LoopWorkflow.Usage | undefined {
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
      parsed.status = line.replace(/^status\s*:\s*/i, "").trim().toLowerCase()
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
    statusRaw === "complete" || statusRaw === "continue" || statusRaw === "needs_input" || statusRaw === "blocked" || statusRaw === "stop"
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
    statusRaw === "pass" || statusRaw === "fail" || statusRaw === "uncertain" || statusRaw === "blocked" || statusRaw === "needs_human"
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
  return workflow.spec.evaluation?.mode === "independent" || workflow.spec.evaluation?.requireIndependentForCompletion === true
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
  const corpus = [checkpoint.summary, checkpoint.nextAction, ...(checkpoint.evidence ?? [])].filter((item): item is string => Boolean(item)).join("\n")
  const required = new Set([...(workflow.policy.requireApprovalFor ?? []), ...(workflow.spec.approvalPolicy?.requireApprovalFor ?? [])])
  const approved = new Set([...(workflow.policy.approvedActions ?? []), ...(workflow.spec.approvalPolicy?.approvedActions ?? [])])
  const attempted = sensitiveActionPatterns.flatMap(([action, pattern]) => (required.has(action) && pattern.test(corpus) ? [action] : []))
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
    summary: attempted.length ? `Sensitive action approvals present: ${attempted.join(", ")}.` : "No approval-required sensitive action was reported.",
    failureClass: "none",
  }
}

function evidenceCorpus(checkpoint: LoopCheckpoint, judgment: LoopJudgment | undefined) {
  return [
    ...(checkpoint.evidence ?? []),
    ...(judgment?.evidence ?? []),
  ]
    .filter((item): item is string => Boolean(item))
    .map((item) => item.toLowerCase())
}

function trimmedNonEmptyStrings(items: readonly string[] | undefined) {
  return items?.map((item) => item.trim()).filter((item): item is string => item.length > 0) ?? []
}

function successChecksGate(workflow: LoopWorkflow.Info, checkpoint: LoopCheckpoint, judgment: LoopJudgment | undefined): LoopGateResult | undefined {
  const checks = trimmedNonEmptyStrings(workflow.spec.successChecks)
  if (!checks.length) return
  const shouldEvaluate = checkpoint.status === "complete" || (checkpoint.status === "blocked" && judgment?.status === "pass")
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

const validationCommandPatterns = [
  /^git\s+diff\s+--check(?:\s|$)/i,
  /^bun\s+(?:test|typecheck|run\s+(?:test|typecheck|lint|check|build))(?:\s|$)/i,
  /^(?:npm|pnpm|yarn)\s+(?:test|run\s+(?:test|typecheck|lint|check|build))(?:\s|$)/i,
  /^deno\s+(?:test|lint|check)(?:\s|$)/i,
  /^(?:pytest|python(?:3)?\s+-m\s+pytest)(?:\s|$)/i,
  /^go\s+test(?:\s|$)/i,
  /^cargo\s+(?:test|check|clippy)(?:\s|$)/i,
  /^make\s+(?:test|check|lint|build)(?:\s|$)/i,
]

const maxValidationOutputBytes = 128 * 1024

function validationCommandArgs(command: string) {
  const value = command.trim()
  if (!value || /[;&|><`$\\\r\n\0]/.test(value)) return
  if (!validationCommandPatterns.some((pattern) => pattern.test(value))) return
  const args = value.split(/\s+/)
  if (
    args[0] === "git" &&
    args[1] === "diff" &&
    args[2] === "--check" &&
    args.slice(3).some((argument) => argument.startsWith("-") && argument !== "--" && argument !== "--cached" && argument !== "--staged")
  ) return
  return args
}

export function loopValidationCommandAllowed(command: string) {
  return Boolean(validationCommandArgs(command))
}

async function readValidationOutput(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  let kept = new Uint8Array(0)
  let truncated = false
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    if (!chunk.value.byteLength) continue
    if (chunk.value.byteLength >= maxValidationOutputBytes) {
      kept = chunk.value.slice(-maxValidationOutputBytes)
      truncated = true
      continue
    }
    const overflow = kept.byteLength + chunk.value.byteLength - maxValidationOutputBytes
    if (overflow > 0) {
      kept = kept.slice(overflow)
      truncated = true
    }
    const combined = new Uint8Array(kept.byteLength + chunk.value.byteLength)
    combined.set(kept)
    combined.set(chunk.value, kept.byteLength)
    kept = combined
  }
  const output = new TextDecoder().decode(kept)
  return truncated ? `[validation output truncated to last ${maxValidationOutputBytes} bytes]\n${output}` : output
}

function validationEnvironment() {
  const inherited = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "TZ",
    "SYSTEMROOT",
    "WINDIR",
    "PATHEXT",
    "COMSPEC",
  ]
  return {
    ...Object.fromEntries(inherited.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]])),
    CI: process.env.CI ?? "1",
    NO_COLOR: "1",
    TERM: "dumb",
  }
}

function runValidationCommand(command: string, cwd: string, timeoutMs: number, executionAllowed: boolean) {
  const args = validationCommandArgs(command)
  if (!args) {
    return Effect.succeed({
      status: "blocked" as const,
      summary: "Validation command is outside the read-only validation allowlist.",
      output: `Blocked command: ${command}`,
      durationMs: 0,
      timedOut: false,
      failureClass: "policy" as const,
    })
  }
  if (!executionAllowed) {
    return Effect.succeed({
      status: "blocked" as const,
      summary: "Executable validation is disabled by the workflow's report-only/read-only contract.",
      output: `Blocked in report-only mode: ${command}`,
      durationMs: 0,
      timedOut: false,
      failureClass: "policy" as const,
    })
  }
  return Effect.tryPromise({
    try: async () => {
      const started = Date.now()
      const child = Bun.spawn(args, {
        cwd,
        env: validationEnvironment(),
        stdout: "pipe",
        stderr: "pipe",
      })
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        child.kill()
      }, timeoutMs)
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        readValidationOutput(child.stdout),
        readValidationOutput(child.stderr),
      ])
      clearTimeout(timer)
      const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n")
      if (timedOut) {
        return {
          status: "blocked" as const,
          summary: `Validation timed out after ${timeoutMs}ms: ${command}`,
          output,
          exitCode,
          durationMs: Date.now() - started,
          timedOut: true,
          failureClass: "environment" as const,
        }
      }
      return {
        status: exitCode === 0 ? "pass" as const : "fail" as const,
        summary: exitCode === 0 ? `Validation passed: ${command}` : `Validation failed with exit ${exitCode}: ${command}`,
        output,
        exitCode,
        durationMs: Date.now() - started,
        timedOut: false,
        failureClass: exitCode === 0 ? "none" as const : "quality" as const,
      }
    },
    catch: (error) => errorMessage(error),
  }).pipe(
    Effect.catch((error) => Effect.succeed({
      status: "blocked" as const,
      summary: `Validation could not run: ${command}`,
      output: error,
      durationMs: 0,
      timedOut: false,
      failureClass: "environment" as const,
    })),
  )
}

function executeValidationChecks(workflowService: LoopWorkflow.Interface, workflow: LoopWorkflow.Info, run: LoopWorkflow.RunInfo, checkpoint: LoopCheckpoint, directory: string) {
  const checks = workflow.spec.validationChecks ?? []
  if (!checks.length || (checkpoint.status !== "complete" && checkpoint.status !== "blocked")) return Effect.succeed([] as LoopGateResult[])
  return Effect.gen(function* () {
    return yield* Effect.forEach(checks, (check) =>
      Effect.gen(function* () {
        const command = check.command.trim()
        const result: ValidationExecution = yield* runValidationCommand(
          command,
          run.workspaceLease?.state === "active" ? run.workspaceLease.path : directory,
          Math.max(1_000, Math.min(check.timeoutMs ?? 120_000, 10 * 60_000)),
          !workflowIsReportOnly(workflow),
        )
        const artifact = yield* workflowService.recordValidation({
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
        }).pipe(Effect.orElseSucceed(() => undefined))
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
  const validationPassed = validationRequired === 0 || (
    validation.length === validationRequired &&
    validation.every((gate) => gate.status === "pass")
  )
  const successPassed = !successRequired || success?.status === "pass"
  if (requirement === "checkpoint evidence") return Boolean(input.checkpoint.evidence?.length)
  if (requirement === "success checks") {
    return validationPassed && successPassed
  }
  if (requirement === "success check output" || requirement === "validation output") {
    const validationOutputRecorded = validationRequired === 0 || (
      validation.length === validationRequired &&
      validation.every((gate) => gate.status === "pass" && Boolean(gate.evidenceArtifacts?.length))
    )
    const successEvidenceRecorded = !successRequired || (
      successPassed && Boolean(input.checkpoint.evidence?.length || input.judgment?.evidence?.length)
    )
    return validationOutputRecorded && successEvidenceRecorded
  }
  if (requirement === "policy gate status") return !approval || approval.status === "pass"
  if (requirement.startsWith("gate:")) return input.gates.find((gate) => gate.id === requirement.slice(5))?.status === "pass"
  return [
    ...(input.checkpoint.evidence ?? []),
    ...(input.judgment?.evidence ?? []),
    ...input.gates.map((gate) => `${gate.id} ${gate.status} ${gate.summary ?? ""}`),
  ].some((item) => item.toLowerCase().includes(requirement))
}

function evaluateRubric(workflow: LoopWorkflow.Info, checkpoint: LoopCheckpoint, judgment: LoopJudgment | undefined, gates: LoopGateResult[]): LoopWorkflow.RubricResult | undefined {
  const rubric = workflow.spec.rubric
  if (!rubric || (checkpoint.status !== "complete" && !(checkpoint.status === "blocked" && judgment?.status === "pass"))) return undefined
  const criteria = (rubric.criteria ?? []).map((criterion) => {
    const requirements = trimmedNonEmptyStrings(criterion.evidenceRequired)
    const evidence = requirements.filter((requirement) => rubricRequirementMet({ requirement, workflow, checkpoint, judgment, gates }))
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
      reason: passed ? "Required runtime evidence is present." : `Missing required evidence: ${requirements.filter((item) => !evidence.includes(item)).join(", ") || "concrete completion evidence"}.`,
      evidence,
      weight: Math.max(0, criterion.weight ?? 1),
    }
  })
  const gateCorpus = gates.map((gate) => `${gate.id} ${gate.status} ${gate.summary ?? ""}`).join("\n").toLowerCase()
  const proposalCorpus = [...(checkpoint.evidence ?? []), ...(judgment?.evidence ?? []), judgment?.summary ?? ""].join("\n").toLowerCase()
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
  const score = totalWeight > 0
    ? criteria.reduce((sum, criterion) => sum + (criterion.score / criterion.maxScore) * criterion.weight, 0) / totalWeight
    : blockers.some((blocker) => blocker.present) ? 0 : 1
  const threshold = Math.max(0, Math.min(1, rubric.passThreshold ?? 0.85))
  const blocked = blockers.some((blocker) => blocker.present)
  return {
    status: blocked ? "blocked" : score >= threshold && criteria.every((criterion) => criterion.passed) ? "pass" : "fail",
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
      summary: judgment.summary ?? `Independent evaluator failed before producing a verdict (${judgment.failureClass}).`,
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
  if (/\b(timeout|timed out|rate limit|429|econnreset|etimedout|eai_again|network|overloaded|temporar|retry|503|502|504|500)\b/i.test(error)) {
    return "transient"
  }
  return "environment"
}

function judgmentPrompt(workflow: LoopWorkflow.Info, checkpoint: LoopCheckpoint, gates: LoopGateResult[]) {
  const criteria = numberedList(workflow.spec.completionCriteria, "Use the objective as the completion criteria.")
  const successChecks = numberedList(workflow.spec.successChecks, "No explicit success checks were configured; evaluate only the evidence provided.")
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
    criteria,
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
      ? gates.map((gate) => `- ${gate.id}: ${gate.status} · ${gate.summary ?? "no summary"}${gate.evidenceArtifacts?.length ? ` · artifacts ${gate.evidenceArtifacts.join(", ")}` : ""}`).join("\n")
      : "- no deterministic gate results were recorded",
    "",
    "Worker completion proposal (untrusted):",
    `status: ${checkpoint.status ?? "missing"}`,
    `summary: ${checkpoint.summary ?? "missing"}`,
    `confidence: ${checkpoint.confidence ?? "missing"}`,
    checkpoint.evidence?.length ? ["evidence:", ...checkpoint.evidence.map((item) => `- ${item}`)].join("\n") : "evidence: none",
    checkpoint.nextAction ? `next_action: ${checkpoint.nextAction}` : undefined,
    "",
    "End your final message with this exact machine-readable block:",
    "LOOP_JUDGMENT:",
    "status: pass | fail | uncertain | blocked | needs_human",
    "summary: one concise sentence explaining the verdict",
    "evidence:",
    "- evidence item reviewed or missing evidence",
    "recommended_next_action: complete, continue, retry, ask_user, or block",
    "confidence: high | medium | low",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n")
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
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const instance = yield* InstanceState.context
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
      const current = yield* workflow.get(id)
      if (!current.rootSessionID) {
        return yield* workflow.failRun({ id, runID: run.id, error: "Loop has no root session after activation.", now }).pipe(
          Effect.map((failed) => ({
            workflowID: id,
            runID: failed.id,
            state: "failed" as const,
            summary: failed.evaluatorReason ?? "Loop run failed.",
          })),
        )
      }
      const reportOnly = workflowIsReportOnly(current) || (input.reportOnly === true && !workflowExplicitlyAllowsEdits(current))
      const runStarted = Date.now()
      const result = yield* prompt
        .prompt({
          sessionID: current.rootSessionID,
          agent: current.spec.agent,
          model: promptModel(current),
          variant: current.spec.model?.variant,
          tools: loopIterationTools(reportOnly),
          parts: [{ type: "text", text: reportOnly ? reportOnlyPrompt(current, input.reason) : iterationPrompt(current, input.reason) }],
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
      const checkpoint = parseCheckpoint(assistantText(result.value))
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
      const gateResults = [...deterministicGates, evaluatorGate(judgment)].filter((item): item is LoopGateResult => Boolean(item))
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
        usage: mergeUsage([
          usageFromMessage(result.value, current, runStarted),
          evaluatorUsage,
        ]),
      })
      const after = yield* workflow.get(id)
      const summary =
        after.state === "blocked" || after.state === "needs_input" || after.state === "stopped" || after.state === "failed"
          ? (completed.evaluatorReason ?? after.evaluatorReason ?? judgment?.summary ?? checkpoint.summary ?? "Loop run completed.")
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
            parts: [{ type: "text", text: parentCompletionPrompt(after, { ...checkpoint, summary: judgment?.summary ?? checkpoint.summary }, completed.id) }],
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
                Effect.map((failed) => ({
                  workflowID: item.id,
                  runID: failed.id,
                  state: failed.state === "blocked"
                    ? "blocked"
                    : failed.state === "needs_input"
                      ? "needs_input"
                      : failed.state === "stopped"
                        ? "stopped"
                        : failed.state === "completed"
                          ? "completed"
                          : "failed",
                  summary: failed.evaluatorReason ?? `Loop scheduler failed: ${error}`,
                }) satisfies TickResult),
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
        { concurrency: 1 },
      )
    })

    return Service.of({ runOne, runDue })
  }),
)

export const defaultLayer = Layer.suspend(() => layer)

export * as LoopRunner from "./loop-runner"
