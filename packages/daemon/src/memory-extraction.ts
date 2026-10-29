import type { ExtractionJob, SessionEvent, Settings } from "@mendcode/protocol"
import type { Store } from "@mendcode/store"
import { buildDigest } from "@mendcode/dream"

export type ExtractedMemory = { scope: "project" | "user"; text: string; category: string }

/** One bounded worker; jobs and retry deadlines survive daemon shutdown. */
export function createMemoryExtraction(options: {
  store: Store
  settings(directory?: string): Settings
  now(): number
  extract?: ((job: ExtractionJob, signal: AbortSignal) => Promise<ExtractedMemory[]>) | undefined
  commit(job: ExtractionJob, memories: ExtractedMemory[]): number
  settled?(job: ExtractionJob): void
  timeoutMs?: number
  retryMs?: number
}) {
  const { store, now } = options
  let stopped = false
  let active: AbortController | undefined
  let draining: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const put = (job: ExtractionJob, patch: Partial<ExtractionJob>) => {
    const next = { ...job, ...patch, updatedAt: now() }
    store.extraction.put(next)
    return next
  }
  for (const job of store.extraction.list()) if (job.state === "running") put(job, { state: "queued", reason: "Recovered after restart" })
  const enabled = (directory?: string) => options.settings(directory).memoryEnabled !== false && options.settings(directory).memoryGenerate === true
  function schedule(ms = 0) {
    if (stopped || timer || !options.extract) return
    timer = setTimeout(() => { timer = undefined; void drain() }, ms)
  }
  async function drain() {
    if (stopped || draining || !options.extract) return
    draining = (async () => {
      while (!stopped) {
        const queued = store.extraction.list().filter((job) => job.state === "queued" && enabled(job.directory)).sort((a, b) => a.nextAttemptAt - b.nextAttemptAt)
        const first = queued[0]
        if (!first) break
        if (first.nextAttemptAt > now()) { schedule(first.nextAttemptAt - now()); break }
        const job = put(first, { state: "running", attempts: first.attempts + 1, reason: "" })
        const controller = new AbortController()
        active = controller
        let timeout: ReturnType<typeof setTimeout> | undefined
        const aborted = new Promise<never>((_, reject) => {
          controller.signal.addEventListener("abort", () => reject(new Error(String(controller.signal.reason))), { once: true })
          timeout = setTimeout(() => controller.abort("Extraction timed out"), options.timeoutMs ?? 45_000)
        })
        try {
          const memories = await Promise.race([options.extract!(job, controller.signal), aborted])
          if (stopped || controller.signal.aborted) throw new Error("Extraction stopped")
          if (!enabled(job.directory)) { put(job, { state: "skipped", reason: "Generation disabled" }); continue }
          store.extraction.settle(job, () => options.commit(job, memories))
          options.settled?.(job)
        } catch (error) {
          if (stopped) put(job, { state: "queued", attempts: job.attempts - 1, reason: "Paused for shutdown" })
          else put(job, { state: job.attempts <= 2 ? "queued" : "failed", reason: String(error).slice(0, 500), nextAttemptAt: now() + (options.retryMs ?? 500 * 2 ** job.attempts) })
        } finally { clearTimeout(timeout); active = undefined }
      }
      store.extraction.prune()
    })().finally(() => { draining = undefined })
    await draining
  }
  return {
    configured: options.extract !== undefined,
    wake: () => schedule(),
    status(directory?: string) {
      const jobs = store.extraction.list().filter((job) => !directory || job.directory === directory).sort((a, b) => b.updatedAt - a.updatedAt)
      return { queue: jobs.filter((job) => job.state === "queued" || job.state === "running").length, lastRun: jobs.find((job) => job.attempts > 0)?.state ?? "never", lastError: jobs.find((job) => job.state === "failed" || job.state === "queued" && !!job.reason)?.reason ?? "none" }
    },
    list(directory?: string) {
      return store.extraction.list().filter((job) => !directory || job.directory === directory).slice(-80).map(({ text: _text, ...job }) => job)
    },
    retry(jobId: string) {
      const job = store.extraction.list().find((candidate) => candidate.jobId === jobId)
      if (!job || !["failed", "skipped"].includes(job.state)) throw new Error("Only failed or skipped extractions can be retried")
      put(job, { state: "queued", attempts: 0, nextAttemptAt: now(), reason: "" })
      schedule()
    },
    observe(event: SessionEvent) {
      if (event.type !== "turn.completed" || !enabled(store.sessionDirectory(event.sessionId)) || store.tasks.list().some((task) => task.taskId === event.sessionId) || store.sessionInfo(event.sessionId)?.parentId) return
      const jobs = store.extraction.list()
      if (jobs.some((job) => job.sessionId === event.sessionId && job.turnId === event.turnId)) return
      if (jobs.filter((job) => ["queued", "running"].includes(job.state)).length >= 128) return
      const events = store.readBefore(event.sessionId, event.seq + 1, 1_000)
      const start = events.findLastIndex((entry) => entry.type === "turn.started" && entry.turnId === event.turnId)
      if (start < 0) return
      const turn = events.slice(start)
      // Notices and extraction results never feed the extractor recursively.
      if (!turn.some((entry) => entry.type === "item.started" && entry.kind === "user_message")) return
      const text = buildDigest(turn).lines.join("\n").slice(0, 64_000)
      if (!text) return
      store.extraction.put({ jobId: `extract_${event.turnId}`, sessionId: event.sessionId, turnId: event.turnId, directory: store.sessionDirectory(event.sessionId)!, text, state: "queued", attempts: 0, nextAttemptAt: now(), reason: options.extract ? "" : "Extractor not configured", proposed: 0, createdAt: now(), updatedAt: now() })
      schedule()
    },
    async stop() {
      stopped = true
      clearTimeout(timer)
      active?.abort("Extraction stopped")
      await draining
    },
  }
}
