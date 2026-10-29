import type { ModelChoice, ModelRole, ReasoningEffort, ReasoningPolicy, ReasoningReceipt, ReasoningReport, SessionId } from "@mendcode/protocol"
import type { ModelMessage } from "./provider"

export type ReasoningContext = { goal: string; progress: string; tools: { name: string; result: string }[] }
export type ReasoningDecision = { effort: ReasoningEffort; leaseSteps: 1 | 2 | 5; inputTokens?: number; outputTokens?: number; costMicros?: number }
export type ReasoningSnapshot = { report: ReasoningReport; binding: string; choice: ModelChoice; efforts: ReasoningEffort[]; manual: boolean }
export type ReasoningEvaluation = { context: ReasoningContext; policy: ReasoningPolicy; efforts: ReasoningEffort[]; signal: AbortSignal; current(): boolean; admit(): boolean }
export type ReasoningEvaluator = (input: ReasoningEvaluation) => Promise<ReasoningDecision>
export type ReasoningGeneration = { sessionId: SessionId; turnId: string; generationId?: string; role: ModelRole; choice: ModelChoice; messages: ModelMessage[]; signal: AbortSignal; manual: boolean; publicGoal?: string }
export type PreparedReasoning = { effort: ReasoningEffort | undefined; dispatch(): void }
export type ReasoningPort = ReturnType<typeof createReasoningController>

type Entry = {
  turn: string
  role: ModelRole
  binding: string
  revision: string
  decisions: number
  attempts: number
  remaining: number
  manual: boolean
  failed: boolean
  escalated: boolean
  requested?: ReasoningEffort
  decision?: ReasoningDecision
  receipt: ReasoningReceipt
  pending?: AbortController
}

export class ReasoningError extends Error {
  constructor(readonly code: "cancelled" | "stale" | "budget" | "response" | "context" | "credential" | "timeout" | "network" | "http" | "capability") {
    super(`Reasoning evaluation: ${code}`)
  }
}

const eligibleEfforts = new Set<ReasoningEffort>(["low", "medium", "high"])
const bounded = (text: string, bytes: number) => Buffer.from(text).subarray(0, bytes).toString("utf8").replace(/\uFFFD$/, "")
export const redactReasoning = (text: string) => text
  .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
  .replace(/\b(?:sk-[\w-]{8,}|gh[pousr]_[\w]{8,}|github_pat_[\w]{8,})\b/g, "[REDACTED TOKEN]")
  .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [REDACTED]")
  .replace(/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[=:]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi, "[REDACTED CREDENTIAL]")

export function reasoningContext(messages: readonly ModelMessage[], publicGoal?: string): ReasoningContext {
  const last = messages.findLastIndex((message) => message.role === "user" && !message.content.startsWith("[image from "))
  const goal = messages[last]
  const text = publicGoal ?? (goal?.role === "user" ? goal.content : "")
  if (!goal || !text.trim() || Buffer.byteLength(text) > 8192) throw new ReasoningError("context")
  const context: ReasoningContext = { goal: redactReasoning(text), progress: "", tools: [] }
  const paired = new Set(messages.slice(last + 1).flatMap((message) => message.role === "assistant" ? message.toolCalls.map((call) => JSON.stringify([call.callId, call.name])) : []))
  for (let index = messages.length - 1; index > last; index--) {
    const message = messages[index]!
    if (message.role === "assistant" && !context.progress) context.progress = bounded(redactReasoning(message.content), 4096)
    if (message.role === "tool" && context.tools.length < 4 && paired.has(JSON.stringify([message.callId, message.name]))) context.tools.unshift({ name: bounded(redactReasoning(message.name), 128), result: bounded(redactReasoning(message.output), 2048) })
  }
  if (Buffer.byteLength(JSON.stringify(context)) > 24576) throw new ReasoningError("context")
  return context
}

export async function abortableReasoning<Value>(operation: Promise<Value>, signal: AbortSignal): Promise<Value> {
  signal.throwIfAborted()
  let abort: () => void = () => {}
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(new ReasoningError("cancelled"))
    signal.addEventListener("abort", abort, { once: true })
  })
  try { return await Promise.race([operation, cancelled]) }
  finally { signal.removeEventListener("abort", abort) }
}

export function createReasoningController(options: { snapshot(sessionId: SessionId, role: ModelRole): ReasoningSnapshot; evaluate?: ReasoningEvaluator; record?(sessionId: SessionId, decision: ReasoningDecision): void }) {
  const entries = new Map<SessionId, Entry>()
  const completed = new Map<SessionId, ReasoningReceipt>()
  const preparations = new Map<SessionId, { key: string; result: Promise<PreparedReasoning> }>()
  const release = (sessionId: SessionId) => {
    preparations.delete(sessionId)
    const entry = entries.get(sessionId)
    entry?.pending?.abort()
    if (entry) {
      completed.delete(sessionId)
      completed.set(sessionId, { ...entry.receipt, leaseRemaining: 0 })
      if (completed.size > 64) completed.delete(completed.keys().next().value!)
    }
    entries.delete(sessionId)
  }
  const manual = (sessionId: SessionId) => {
    preparations.delete(sessionId)
    const entry = entries.get(sessionId)
    if (entry) {
      entry.pending?.abort()
      entry.manual = true
      entry.remaining = 0
      delete entry.decision
      delete entry.requested
    }
  }
  const invalidate = (sessionId?: SessionId) => {
    for (const [id, entry] of entries) if (!sessionId || id === sessionId) {
      preparations.delete(id)
      entry.pending?.abort()
      entry.remaining = 0
      delete entry.decision
      entry.revision = "invalidated"
    }
  }
  const port = {
    release,
    manual,
    invalidate,
    receipt: (sessionId: SessionId) => entries.get(sessionId) ? { ...entries.get(sessionId)!.receipt } : completed.get(sessionId),
    async prepare(input: ReasoningGeneration): Promise<PreparedReasoning> {
      if (input.signal.aborted) {
        release(input.sessionId)
        throw new ReasoningError("cancelled")
      }
      let snapshot = options.snapshot(input.sessionId, input.role)
      const config = snapshot.report.config
      let entry = entries.get(input.sessionId)
      if (entry?.turn !== input.turnId) {
        release(input.sessionId)
        entry = undefined
      }
      if (!entry) {
        if (entries.size >= 64) {
          if (snapshot.report.valid && snapshot.report.evaluatorReady && options.evaluate && config.mode === "adaptive" && config.remoteProcessing && config.failureMode === "pause" && !input.manual && !snapshot.manual && snapshot.efforts.some((value) => eligibleEfforts.has(value))) throw new ReasoningError("capability")
          return { effort: input.choice.effort, dispatch() {
            const next = options.snapshot(input.sessionId, input.role)
            if (input.signal.aborted || next.binding !== snapshot.binding || next.report.revision !== snapshot.report.revision) throw new ReasoningError("stale")
          } }
        }
        entry = { turn: input.turnId, role: input.role, binding: snapshot.binding, revision: snapshot.report.revision, decisions: 0, attempts: 0, remaining: 0, manual: false, failed: false, escalated: false, receipt: { status: "off", leaseRemaining: 0, decisions: 0 } }
        entries.set(input.sessionId, entry)
      }
      const owner = entry
      if (owner.binding !== snapshot.binding) manual(input.sessionId)
      if (owner.revision !== snapshot.report.revision) {
        owner.pending?.abort()
        owner.remaining = 0
        delete owner.decision
        delete owner.requested
        owner.revision = snapshot.report.revision
      }
      const balanced = snapshot.efforts.includes("medium") ? "medium" : ["low", "high"].find((value) => snapshot.efforts.includes(value as ReasoningEffort)) as ReasoningEffort | undefined
      let effort = snapshot.report.valid && snapshot.report.reasoningAuto ? balanced ?? input.choice.effort : input.choice.effort
      const receipt = (status: ReasoningReceipt["status"], value = effort, reason?: string) => {
        owner.receipt = { status, ...(value ? { effort: value } : {}), ...(owner.decision ? { suggestedEffort: owner.decision.effort } : {}), leaseRemaining: owner.remaining, decisions: owner.decisions, ...(reason ? { reason } : {}) }
        return value
      }
      const current = () => {
        const next = options.snapshot(input.sessionId, input.role)
        return !input.signal.aborted && entries.get(input.sessionId) === owner && !owner.pending?.signal.aborted && next.report.revision === snapshot.report.revision && next.binding === snapshot.binding && !owner.manual
      }
      if (input.manual || snapshot.manual || owner.manual || input.choice.model !== snapshot.choice.model) {
        manual(input.sessionId)
        effort = input.choice.effort
        receipt("manual", effort, "Manual effort wins for this turn")
      } else if (owner.requested && snapshot.report.reasoningAuto && snapshot.report.valid) {
        effort = receipt(config.mode === "shadow" ? "proposed" : "requested", config.mode === "shadow" ? effort : owner.requested)
        owner.receipt.suggestedEffort = owner.requested
      } else if (!snapshot.report.valid || config.mode === "off" || !config.remoteProcessing) {
        receipt("off", effort, snapshot.report.valid ? undefined : "Invalid policy")
      } else if (!snapshot.report.evaluatorReady || !options.evaluate || !snapshot.efforts.some((value) => eligibleEfforts.has(value))) {
        receipt("unsupported", effort, "Evaluator or reasoning binding unavailable")
      } else {
        if (!owner.remaining && !owner.failed && owner.decisions < config.maxDecisionsPerTurn) {
          if (owner.pending) throw new ReasoningError("stale")
          const abort = new AbortController()
          owner.pending = abort
          owner.decisions++
          try {
            const signal = AbortSignal.any([input.signal, abort.signal, AbortSignal.timeout(5000)])
            const decision = await abortableReasoning(options.evaluate({ context: reasoningContext(input.messages, input.publicGoal), policy: config, efforts: snapshot.efforts.filter((value) => eligibleEfforts.has(value)), signal, current, admit: () => current() && ++owner.attempts <= config.maxDecisionsPerTurn * 2 }), signal)
            if (!current()) throw new ReasoningError("stale")
            if (!eligibleEfforts.has(decision.effort) || !snapshot.efforts.includes(decision.effort) || ![1, 2, 5].includes(decision.leaseSteps) || decision.leaseSteps > config.maxLeaseSteps) throw new ReasoningError("response")
            options.record?.(input.sessionId, decision)
            owner.decision = { ...decision }
            owner.remaining = decision.leaseSteps
          } catch (error) {
            if (!current()) throw new ReasoningError(input.signal.aborted ? "cancelled" : "stale")
            owner.failed = true
          } finally { if (owner.pending === abort) delete owner.pending }
          snapshot = options.snapshot(input.sessionId, input.role)
        }
        if (owner.failed || !owner.remaining) {
          if (config.mode === "adaptive" && config.failureMode === "pause") {
            receipt("paused", effort, "Evaluator failed or decision limit reached")
            throw new ReasoningError(owner.failed ? "response" : "budget")
          }
          receipt("fallback", effort, "Baseline until the next turn")
        } else {
          effort = config.mode === "adaptive" ? owner.decision!.effort : effort
          receipt(config.mode === "shadow" ? "proposed" : owner.remaining === owner.decision!.leaseSteps ? "prepared" : "reused", effort)
        }
      }
      let dispatched = false
      const revision = snapshot.report.revision
      const binding = snapshot.binding
      return { effort, dispatch() {
        if (dispatched) return
        const next = options.snapshot(input.sessionId, input.role)
        if (input.signal.aborted || entries.get(input.sessionId) !== owner || owner.revision !== revision || next.report.revision !== revision || next.binding !== binding || owner.manual && owner.receipt.status !== "manual") throw new ReasoningError("stale")
        dispatched = true
        owner.remaining = Math.max(0, owner.remaining - 1)
        owner.receipt.leaseRemaining = owner.remaining
      } }
    },
    requestIncrease(sessionId: SessionId, reason: string, evidence: string) {
      const entry = entries.get(sessionId)
      const snapshot = options.snapshot(sessionId, entry?.role ?? "main")
      const unchanged = (why: string) => ({ status: "unchanged", reason: why })
      if (!["verification_failed", "technical_block"].includes(reason) || !evidence.trim() || evidence.length > 1000) return unchanged("Concrete verification or technical evidence required")
      if (!snapshot.report.valid || !snapshot.report.reasoningAuto) return unchanged("Reasoning Auto is disabled")
      if (!entry || snapshot.manual || entry.manual) return unchanged("Manual effort wins")
      if (entry.escalated) return unchanged("One increase per turn")
      const values = ["low", "medium", "high"] as const
      const baseline = entry.receipt.effort ?? snapshot.choice.effort
      const at = values.indexOf(baseline as typeof values[number])
      const next = at < 0 ? undefined : values.slice(at + 1).find((value) => snapshot.efforts.includes(value))
      if (!next) return unchanged("No supported increase below high")
      entry.escalated = true
      preparations.delete(sessionId)
      entry.requested = next
      entry.remaining = 0
      delete entry.decision
      return { status: "requested", effort: next }
    },
    dispose() {
      for (const sessionId of entries.keys()) release(sessionId)
      completed.clear()
      preparations.clear()
    },
  }
  return { ...port, prepare(input: ReasoningGeneration): Promise<PreparedReasoning> {
    if (!input.generationId) return port.prepare(input)
    const snapshot = options.snapshot(input.sessionId, input.role)
    const key = JSON.stringify([input.turnId, input.generationId, snapshot.binding, snapshot.report.revision, snapshot.manual, input.manual])
    const existing = preparations.get(input.sessionId)
    if (existing?.key === key) return existing.result
    const result = port.prepare(input)
    if (entries.has(input.sessionId)) preparations.set(input.sessionId, { key, result })
    void result.catch(() => { if (preparations.get(input.sessionId)?.result === result) preparations.delete(input.sessionId) })
    return result
  } }
}
