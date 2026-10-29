import type { Store } from "@mendcode/store"
import type { ContinuityForSession } from "@mendcode/kernel"
import { redactSecrets, type ContinuityRecord, type SessionId, type RequestId, type Command } from "@mendcode/protocol"
import type { SessionEventDraft } from "@mendcode/kernel"

const ACTIVE = new Set(["queued", "running", "pending"])
const TOOLS = new Set(["read", "grep", "glob", "webfetch"])
type Work = { record: ContinuityRecord; abort: AbortController; run(signal: AbortSignal): Promise<{ output: string; isError: boolean; attachments?: unknown[]; images?: unknown[] }>; cleanup(): void }

export function createContinuity(options: {
  store: Store
  now(): number
  requestId(): RequestId
  emit(event: SessionEventDraft): void
  mask(sessionId: SessionId, text: string): string
  notify(record: ContinuityRecord, text: string): Promise<unknown>
}) {
  const { store } = options
  const records = store.continuity
  const queued: Work[] = []
  const running = new Map<string, Work>()
  const delivering = new Set<string>()
  const waiters = new Set<() => void>()
  let stopping = false
  const safe = (sessionId: SessionId, text: string) => redactSecrets(options.mask(sessionId, text)).text
  const enabled = (kind: "job" | "question") => store.settings.get().experimental?.[kind === "job" ? "async_tools" : "async_questions"] === true
  const marker = (record: ContinuityRecord) => `[Async ${record.kind} ${record.id}]`
  function publish(record: ContinuityRecord) {
    const { output, answers, questions, ...summary } = record
    options.emit({ type: "continuity.updated", sessionId: record.sessionId, record: summary })
    for (const wake of [...waiters]) wake()
  }
  function flush() {
    if (stopping) return
    for (const record of records.pending()) {
      if (delivering.has(record.id)) continue
      if (!enabled(record.kind) || record.generation !== records.generation(record.sessionId) || record.continuationCancelled) { records.cancelMail(record.id); continue }
      // A crash between queue insertion and acknowledgement must not insert the same notice twice.
      if (store.readAfter(record.sessionId, 0, Number.MAX_SAFE_INTEGER).some((event) => (event.type === "queue.added" || event.type === "item.completed") && event.text?.startsWith(marker(record)))) { records.acknowledge(record.id); continue }
      delivering.add(record.id)
      const result = record.output ?? (record.answers ? JSON.stringify(record.answers) : record.error ?? "")
      const text = `${marker(record)} ${record.status}\n${safe(record.sessionId, result).slice(0, 4096)}`
      void options.notify(record, text).then((accepted) => { if (!stopping && accepted !== undefined && store.hasSession(record.sessionId)) records.acknowledge(record.id) }, () => {}).finally(() => delivering.delete(record.id))
    }
  }
  function save(record: ContinuityRecord, complete = false) {
    record = { ...record, updatedAt: options.now() }
    if (complete) records.complete(record)
    else records.put(record)
    publish(record)
    if (complete) { records.prune(record.sessionId); queueMicrotask(flush) }
    return record
  }
  function get(sessionId: SessionId, id: string) {
    const record = records.get(sessionId, id)
    if (!record) throw new Error("Unknown record in this session")
    return record
  }
  function pump() {
    if (stopping) return
    for (const work of [...queued]) {
      if (running.size >= 16) break
      if ([...running.values()].filter((item) => item.record.sessionId === work.record.sessionId).length >= 4) continue
      queued.splice(queued.indexOf(work), 1)
      if (!enabled("job") || work.abort.signal.aborted || work.record.generation !== records.generation(work.record.sessionId)) { work.cleanup(); save({ ...work.record, status: "cancelled", continuationCancelled: true }, true); continue }
      work.record = save({ ...work.record, status: "running" })
      running.set(work.record.id, work)
      let abortListener: () => void
      const aborted = new Promise<undefined>((resolve) => {
        abortListener = () => resolve(undefined)
        work.abort.signal.addEventListener("abort", abortListener, { once: true })
      })
      const operation = Promise.resolve().then(() => work.run(work.abort.signal))
      // Late results remain inspectable, but never re-enable a cancelled continuation.
      void operation.then((result) => {
        if (stopping || !store.hasSession(work.record.sessionId)) return
        const current = records.get(work.record.sessionId, work.record.id)
        if (current?.status === "cancelled") save({ ...current, output: safe(current.sessionId, result.output).slice(0, 50_000) })
      }, () => {})
      void Promise.race([operation, aborted]).then((result) => {
        if (stopping || !store.hasSession(work.record.sessionId)) return
        const current = records.get(work.record.sessionId, work.record.id)
        if (!current || !ACTIVE.has(current.status)) return
        save({ ...current, status: !result || work.abort.signal.aborted ? "cancelled" : result.isError ? "failed" : "completed", ...(!result ? { continuationCancelled: true } : { output: safe(current.sessionId, result.output).slice(0, 50_000), ...(result.attachments?.length || result.images?.length ? { attachmentNotice: "Use synchronous read to retrieve media attachments." } : {}) }) }, true)
      }, (error) => {
        if (stopping || !store.hasSession(work.record.sessionId)) return
        const current = records.get(work.record.sessionId, work.record.id)
        if (current && ACTIVE.has(current.status)) save({ ...current, status: "failed", error: safe(current.sessionId, String(error)).slice(0, 4096) }, true)
      }).finally(() => {
        work.abort.signal.removeEventListener("abort", abortListener!)
        work.cleanup()
        running.delete(work.record.id)
        pump()
      })
    }
  }
  function cancel(sessionId: SessionId, id: string) {
    const record = get(sessionId, id)
    if (!ACTIVE.has(record.status)) return record
    const work = running.get(id) ?? queued.find((item) => item.record.id === id)
    if (work) { work.abort.abort(); work.cleanup(); const index = queued.indexOf(work); if (index >= 0) queued.splice(index, 1) }
    if (record.requestId) options.emit({ type: "server.request.resolved", sessionId, requestId: record.requestId, resolution: "abandoned" })
    const saved = save({ ...record, status: record.kind === "job" ? "cancelled" : "dismissed", continuationCancelled: true }, true)
    pump()
    return saved
  }
  const forSession: ContinuityForSession = (sessionId) => ({
    start(input, signal, run) {
      if (stopping || !enabled("job")) throw new Error("experimental.async_tools is disabled")
      if (!TOOLS.has(input.tool)) throw new Error("Tool is not eligible for async execution")
      const existing = records.get(sessionId, input.id)
      if (existing) return existing
      if (records.list(sessionId).filter((record) => record.kind === "job" && ACTIVE.has(record.status)).length >= 12 || queued.length + running.size >= 128 || records.pending().filter((record) => record.sessionId === sessionId).length >= 256) throw new Error("Async job capacity reached (4 active, 8 queued per session)")
      const abort = new AbortController()
      const onAbort = () => cancel(sessionId, input.id)
      const record = save({ ...input, sessionId, kind: "job", status: "queued", generation: records.generation(sessionId), createdAt: options.now(), updatedAt: options.now() })
      const work: Work = { record, abort, run, cleanup: () => signal.removeEventListener("abort", onAbort) }
      queued.push(work)
      if (signal.aborted) cancel(sessionId, input.id)
      else signal.addEventListener("abort", onAbort, { once: true })
      pump()
      return get(sessionId, input.id)
    },
    get(id, offset = 0, limit = 8000) {
      const record = get(sessionId, id)
      offset = Math.max(0, Math.floor(offset))
      limit = Math.max(1, Math.min(16000, Math.floor(limit)))
      const output = record.output ?? ""
      return { ...record, output: output.slice(offset, offset + limit), ...(offset + limit < output.length ? { nextOffset: offset + limit } : {}) }
    },
    cancel: (id) => cancel(sessionId, id),
    async wait(ids, timeoutMs, signal) {
      if (!ids.length || ids.length > 12) throw new Error("Provide 1 to 12 job IDs")
      const snapshot = () => ids.map((id) => { const record = get(sessionId, id); if (record.kind !== "job") throw new Error("Unknown job in this session"); return record })
      const terminal = () => snapshot().every((record) => !ACTIVE.has(record.status))
      if (!terminal() && !signal.aborted && !stopping && timeoutMs > 0) await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); waiters.delete(check); resolve() }
        const check = () => { if (stopping || terminal()) done() }
        const timer = setTimeout(done, Math.min(60000, timeoutMs))
        waiters.add(check)
        signal.addEventListener("abort", done, { once: true })
      })
      return snapshot()
    },
    question(input) {
      if (stopping || !enabled("question")) throw new Error("experimental.async_questions is disabled")
      const existing = records.get(sessionId, input.id)
      if (existing) return existing
      if (records.list(sessionId).filter((record) => record.kind === "question" && record.status === "pending").length >= 12 || records.pending().filter((record) => record.sessionId === sessionId).length >= 256) throw new Error("Async question capacity reached (12 pending)")
      const questions = input.questions.map((question) => ({ ...question, question: safe(sessionId, question.question), header: safe(sessionId, question.header), ...(question.context ? { context: safe(sessionId, question.context) } : {}), options: question.options.map((option) => ({ label: safe(sessionId, option.label), ...(option.description ? { description: safe(sessionId, option.description) } : {}) })) }))
      const record = save({ ...input, questions, sessionId, kind: "question", status: "pending", requestId: options.requestId(), generation: records.generation(sessionId), createdAt: options.now(), updatedAt: options.now() })
      options.emit({ type: "server.request", sessionId, turnId: input.turnId, requestId: record.requestId!, kind: "question", async: true, title: `Asked ${questions.length} question${questions.length === 1 ? "" : "s"}`, detail: "", questions })
      return record
    },
  })
  return {
    forSession,
    list: (sessionId: SessionId) => records.list(sessionId).sort((a, b) => b.createdAt - a.createdAt).slice(0, 256),
    resolve(command: Extract<Command, { type: "request.resolve" }>) {
      const record = records.list(command.sessionId).find((record) => record.requestId === command.requestId)
      if (!record) return undefined
      if (record.status !== "pending") return { ok: false as const, code: "request_already_resolved" as const, message: "Question is not pending" }
      const decision = command.decision
      if (decision.kind !== "deny" && (decision.kind !== "answer" || !decision.answers || decision.answers.length !== record.questions!.length || decision.answers.some((answers, i) => { const question = record.questions![i]!; return (!question.multiple && answers.length > 1) || new Set(answers).size !== answers.length || question.custom === false && answers.some((answer) => !question.options.some((option) => option.label === answer)) }))) return { ok: false as const, code: "invalid_command" as const, message: "Answers must match the questions in order" }
      save({ ...record, status: decision.kind === "answer" ? "answered" : "dismissed", ...(decision.kind === "answer" ? { answers: decision.answers!.map((answers) => answers.map((answer) => safe(command.sessionId, answer))) } : { error: safe(command.sessionId, decision.kind === "deny" ? decision.reason ?? "User dismissed the question" : "User dismissed the question") }) }, true)
      options.emit({ type: "server.request.resolved", sessionId: command.sessionId, requestId: command.requestId, resolution: decision.kind === "answer" ? "answered" : "denied", byClientId: command.clientId })
      return { ok: true as const }
    },
    cancelSession(sessionId: SessionId) {
      records.advance(sessionId)
      for (const record of records.list(sessionId)) if (ACTIVE.has(record.status)) cancel(sessionId, record.id)
    },
    configure() {
      for (const record of records.list()) if (!enabled(record.kind)) { records.cancelMail(record.id); if (ACTIVE.has(record.status)) cancel(record.sessionId, record.id) }
    },
    recover() {
      for (const record of records.list()) if (record.kind === "job" && ACTIVE.has(record.status)) save({ ...record, status: "interrupted", error: "Backend restarted; this job was not repeated." }, true)
      flush()
    },
    stop() {
      if (stopping) return
      stopping = true
      for (const work of [...queued, ...running.values()]) { work.cleanup(); work.abort.abort(); save({ ...get(work.record.sessionId, work.record.id), status: "interrupted", continuationCancelled: true, error: "Backend stopped; this job was not repeated." }, true) }
      queued.length = 0
      for (const wake of [...waiters]) wake()
    },
  }
}
