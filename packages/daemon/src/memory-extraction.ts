import type { ExtractionJob, MemoryEntry, SessionEvent, SessionId, Settings, TurnId } from "@mendcode/protocol"
import type { Store } from "@mendcode/store"
import { buildDigest } from "../../dream/src/digest"
import { dreamEligibleDirectory, dreamMachinery } from "./dream-projects"
import { reviewPolicy } from "./memory-config"
import { wellFormed } from "./well-formed"

export type ExtractedMemory = { scope: "project" | "user"; text: string; category: string; details?: MemoryEntry["details"] }

/** A message that is only a greeting or an acknowledgement. */
const ACKNOWLEDGEMENT = /^(hi|hello|hey|hola|ok|okay|k|thanks?|thank you|thx|gracias|yes|yep|no|nope|si|sí|sure|great|cool|nice|perfect|done|got it|continue|go on|go ahead|continúa|continua)[\s.!?¡¿,]*$/i

/** A turn whose user messages are all greetings or acknowledgements and that called no tool: a model call over it would find nothing. */
export function isTrivialTurn(turn: readonly SessionEvent[]) {
  if (turn.some((entry) => entry.type === "item.started" && entry.kind !== "user_message" && entry.kind !== "agent_message" && entry.kind !== "reasoning")) return false
  const kinds = new Map<string, string>()
  const said: string[] = []
  for (const entry of turn) {
    if (entry.type === "item.started") kinds.set(entry.itemId, entry.kind)
    else if (entry.type === "item.completed" && kinds.get(entry.itemId) === "user_message") said.push(entry.text ?? "")
  }
  return said.length > 0 && said.every((text) => ACKNOWLEDGEMENT.test(text.trim()))
}

type Timer = { cancel(): void }
/** What asked for a review. */
export type ReviewTrigger = "turns" | "idle" | "compaction" | "retry"
/** Substantive user turns a session needs unreviewed before a review is worth a model call. */
export const MIN_REVIEW_TURNS = 2
const DAY_MS = 86_400_000
const MAX_TRACKED = 256

type Track = {
  /** Substantive user turns since the last review request. */
  pending: number
  /** Last event seq before the first unreviewed turn. */
  from: number | undefined
  /** A review job already queued for this session, not started yet: its range and turns, so the newest snapshot covers it too. */
  queuedFrom: number | undefined
  queuedTurns: number
  seenSeq: number
  lastTurnId: string
  idle: Timer | undefined
  /** A request that arrived while the session's review ran; made again when it ends. */
  again: ReviewTrigger | undefined
  touched: number
}
/** One row per session with unreviewed turns, in the store's `meta` table, so a restart neither forgets nor repeats them. */
const PROGRESS_KEY = "memory.review:"
const MAX_PROGRESS_ROWS = 512
const PROGRESS_KEEP_MS = 14 * 86_400_000
type ProgressRow = { p: number; f: number | null; qf: number | null; qt: number; s: number; t: string; at: number }

/**
 * Memory review: one job per session at checkpoints (every N substantive user turns, idle, before compaction), never one per turn.
 * Jobs and retry deadlines survive daemon shutdown; one worker runs them; a daily cap bounds the calls; every job and skip is
 * recorded in a bounded table. It works from the stored events, so it is the same for every engine.
 */
export function createMemoryExtraction(options: {
  store: Store
  settings(directory?: string): Settings
  now(): number
  extract?: ((job: ExtractionJob, signal: AbortSignal) => Promise<ExtractedMemory[]>) | undefined
  commit(job: ExtractionJob, memories: ExtractedMemory[]): number
  settled?(job: ExtractionJob): void
  /** Extra reasons a session is not reviewed (a scripted or headless run); returns the reason. */
  ineligible?(sessionId: string): string | undefined
  /** Replaces the Dream folder filter (tests). */
  eligibleDirectory?(directory: string): boolean
  dataDir?: string
  setTimer?(ms: number, run: () => void): Timer
  timeoutMs?: number
  retryMs?: number
}) {
  const { store, now } = options
  let stopped = false
  let active: AbortController | undefined
  let draining: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let completedAt = 0
  /** When the daily-cap skip was last written: one row per day, so skips can never push the calls that count out of the kept log. */
  let capLoggedAt = Number.NEGATIVE_INFINITY
  const tracks = new Map<string, Track>()
  const meta = new Map<string, { turns: number; trigger: ReviewTrigger }>()
  const reportedIneligible = new Set<string>()
  const setTimer = options.setTimer ?? ((ms: number, run: () => void) => { const handle = setTimeout(run, ms); handle.unref?.(); return { cancel: () => clearTimeout(handle) } })
  const put = (job: ExtractionJob, patch: Partial<ExtractionJob>) => {
    const next = { ...job, ...patch, updatedAt: now() }
    store.extraction.put(next)
    return next
  }
  const log = (row: { sessionId: string; directory: string; trigger: string; turns?: number; calls?: number; proposed?: number; outcome: "ran" | "failed" | "skipped"; reason?: string }) =>
    store.memoryReviews.add({ turns: 0, calls: 0, proposed: 0, reason: "", ...row, at: now() })
  for (const job of store.extraction.list()) if (job.state === "running") put(job, { state: "queued", reason: "Recovered after restart" })
  const enabled = (directory?: string) => options.settings(directory).memoryEnabled !== false && options.settings(directory).memoryGenerate === true
  /** Why a session is not reviewed, or undefined: temp folders, missing folders, linked worktrees, the data directory, child, task, loop, workflow and review sessions. */
  function skipReason(sessionId: string): string | undefined {
    const directory = store.sessionDirectory(sessionId as SessionId)
    if (!directory) return "no folder"
    const info = store.sessionInfo(sessionId as SessionId)
    if (info?.parentId) return "child session"
    if (store.tasks.list().some((task) => task.taskId === sessionId)) return "task session"
    if (info && dreamMachinery(info.title)) return "loop, workflow or review session"
    if (!(options.eligibleDirectory ? options.eligibleDirectory(directory) : dreamEligibleDirectory(directory, options.dataDir ? { dataDir: options.dataDir } : {}))) return "temporary, missing or linked-worktree folder"
    return options.ineligible?.(sessionId)
  }
  /** Sessions skipped as ineligible, counted per reason in memory only: a throwaway folder must not add a row to the disk. */
  const ineligibleCounts = new Map<string, number>()
  function reportIneligible(sessionId: string, why: string) {
    if (reportedIneligible.has(sessionId) || reportedIneligible.size >= 512) return
    reportedIneligible.add(sessionId)
    const reason = `ineligible: ${why}`
    ineligibleCounts.set(reason, (ineligibleCounts.get(reason) ?? 0) + 1)
  }
  function schedule(ms = 0) {
    if (stopped || timer || !options.extract) return
    timer = setTimeout(() => { timer = undefined; void drain() }, ms)
  }
  function remember(sessionId: string, entry: Track) {
    if (tracks.size >= MAX_TRACKED) {
      const oldest = [...tracks.entries()].sort((a, b) => a[1].touched - b[1].touched)[0]!
      oldest[1].idle?.cancel()
      tracks.delete(oldest[0])
    }
    tracks.set(sessionId, entry)
    return entry
  }
  /** Old progress rows go once per daemon run: a session that stopped with one unreviewed turn keeps no row for ever. */
  let progressPruned = false
  function pruneProgress() {
    if (progressPruned) return
    progressPruned = true
    const rows = store.meta.list(PROGRESS_KEY, MAX_PROGRESS_ROWS * 4).map((row) => ({ key: row.key, at: Number((JSON.parse(row.value) as { at?: number }).at ?? 0) })).sort((a, b) => b.at - a.at)
    rows.forEach((row, index) => {
      if (index >= MAX_PROGRESS_ROWS || row.at < now() - PROGRESS_KEEP_MS) { store.meta.delete(row.key); return }
      // Turns left unreviewed by the last run get their idle review again, as if the session had just gone quiet.
      const sessionId = row.key.slice(PROGRESS_KEY.length)
      const entry = index < MAX_TRACKED ? restored(sessionId) : undefined
      if (entry) armIdle(sessionId, entry)
    })
  }
  /** The progress a previous daemon run saved for this session, or undefined. */
  function restored(sessionId: string): Track | undefined {
    const tracked = tracks.get(sessionId)
    if (tracked) return tracked
    pruneProgress()
    const saved = store.meta.get(PROGRESS_KEY + sessionId)
    if (!saved) return undefined
    const row = JSON.parse(saved) as ProgressRow
    return remember(sessionId, { pending: row.p, from: row.f ?? undefined, queuedFrom: row.qf ?? undefined, queuedTurns: row.qt, seenSeq: row.s, lastTurnId: row.t, idle: undefined, again: undefined, touched: now() })
  }
  /** Saves what a restart must not lose: unreviewed turns and the range of a waiting job. One small row per session with unreviewed turns, rewritten in place, deleted once nothing is pending. */
  function save(sessionId: string, entry: Track) {
    if (entry.pending === 0 && entry.queuedFrom === undefined) { store.meta.delete(PROGRESS_KEY + sessionId); return }
    const row: ProgressRow = { p: entry.pending, f: entry.from ?? null, qf: entry.queuedFrom ?? null, qt: entry.queuedTurns, s: entry.seenSeq, t: entry.lastTurnId, at: now() }
    store.meta.set(PROGRESS_KEY + sessionId, JSON.stringify(row))
  }
  function track(sessionId: string): Track {
    const entry = restored(sessionId) ?? remember(sessionId, { pending: 0, from: undefined, queuedFrom: undefined, queuedTurns: 0, seenSeq: 0, lastTurnId: "", idle: undefined, again: undefined, touched: 0 })
    entry.touched = now()
    return entry
  }
  /** A waiting job left the queue (it started or was skipped): its range is no longer pending, also on disk. */
  function dequeued(sessionId: string) {
    const entry = restored(sessionId)
    if (!entry) return
    entry.queuedFrom = undefined
    entry.queuedTurns = 0
    save(sessionId, entry)
  }
  const reviewRunning = (sessionId: string) => store.extraction.list().some((job) => job.sessionId === sessionId && job.state === "running")
  /** Queues the session's one review job with the newest snapshot: a job still waiting is replaced, and the digest covers its turns too. */
  function request(sessionId: string, trigger: ReviewTrigger) {
    const entry = restored(sessionId)
    if (!entry || stopped) return
    entry.idle?.cancel()
    entry.idle = undefined
    if (entry.pending === 0) return
    const directory = store.sessionDirectory(sessionId as SessionId) ?? ""
    const turns = entry.pending + entry.queuedTurns
    // Too little to review is the common case: it is not recorded, so a short session (or a tier without memory) writes nothing.
    if (turns < MIN_REVIEW_TURNS) return
    if (!enabled(directory || undefined)) return
    const why = skipReason(sessionId)
    if (why) { tracks.delete(sessionId); store.meta.delete(PROGRESS_KEY + sessionId); reportIneligible(sessionId, why); return }
    if (reviewRunning(sessionId)) { entry.again = trigger; return }
    const from = entry.queuedFrom ?? entry.from ?? 0
    const events = store.readAfter(sessionId as SessionId, from, 2_000)
    // A cut may split a surrogate pair; a lone half is invalid in a JSON request body and the provider answers 400.
    const text = wellFormed(buildDigest(events).lines.join("\n").slice(0, 64_000))
    if (!text.trim()) { entry.pending = 0; entry.from = undefined; save(sessionId, entry); log({ sessionId, directory, trigger, turns, outcome: "skipped", reason: "empty digest" }); return }
    // Only the job this range already covers is replaced; one recovered mid-run after a restart covers older turns and stays.
    if (entry.queuedFrom !== undefined) for (const queued of store.extraction.list()) if (queued.sessionId === sessionId && queued.state === "queued") { store.extraction.remove(queued.jobId); meta.delete(queued.jobId) }
    const jobId = `review_${entry.lastTurnId}`
    store.extraction.put({ jobId, sessionId: sessionId as SessionId, turnId: entry.lastTurnId as TurnId, directory, text, state: "queued", attempts: 0, nextAttemptAt: now(), reason: options.extract ? "" : "Extractor not configured", proposed: 0, createdAt: now(), updatedAt: now() })
    meta.set(jobId, { turns, trigger })
    entry.queuedFrom = from
    entry.queuedTurns = turns
    entry.pending = 0
    entry.from = undefined
    save(sessionId, entry)
    schedule()
  }
  function armIdle(sessionId: string, entry: Track) {
    entry.idle?.cancel()
    entry.idle = undefined
    if (entry.pending + entry.queuedTurns < MIN_REVIEW_TURNS) return
    entry.idle = setTimer(reviewPolicy(options.settings(store.sessionDirectory(sessionId as SessionId))).idleMs, () => { entry.idle = undefined; request(sessionId, "idle") })
  }
  /** A job ended for good: forget its record and review again what piled up while it ran. */
  function release(job: ExtractionJob) {
    meta.delete(job.jobId)
    const entry = tracks.get(job.sessionId)
    const again = entry?.again
    if (entry) entry.again = undefined
    if (again && entry && entry.pending >= MIN_REVIEW_TURNS) request(job.sessionId, again)
  }
  async function drain() {
    if (stopped || draining || !options.extract) return
    draining = (async () => {
      while (!stopped) {
        const waiting = store.extraction.list().filter((job) => job.state === "queued")
        const queued = waiting.filter((job) => enabled(job.directory)).sort((a, b) => a.nextAttemptAt - b.nextAttemptAt)
        const first = queued[0]
        if (!first) break
        if (first.nextAttemptAt > now()) { schedule(first.nextAttemptAt - now()); break }
        const info = meta.get(first.jobId) ?? { turns: 0, trigger: "retry" as ReviewTrigger }
        // Every attempt is checked, retries too: calls a waiting job made in the last day are not in the record yet, so they count here.
        const unrecorded = waiting.reduce((sum, job) => sum + (job.updatedAt >= now() - DAY_MS ? job.attempts : 0), 0)
        if (store.memoryReviews.callsSince(now() - DAY_MS) + unrecorded >= reviewPolicy(options.settings(first.directory)).dailyCap) {
          put(first, { state: "skipped", reason: "Daily review cap reached" })
          if (first.attempts > 0) log({ sessionId: first.sessionId, directory: first.directory, trigger: info.trigger, turns: info.turns, calls: first.attempts, outcome: "skipped", reason: "daily cap" })
          else if (now() - capLoggedAt >= DAY_MS) {
            capLoggedAt = now()
            log({ sessionId: first.sessionId, directory: first.directory, trigger: info.trigger, turns: info.turns, outcome: "skipped", reason: "daily cap" })
          }
          dequeued(first.sessionId)
          release(first)
          continue
        }
        const job = put(first, { state: "running", attempts: first.attempts + 1, reason: "" })
        dequeued(job.sessionId)
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
          if (!enabled(job.directory)) {
            put(job, { state: "skipped", reason: "Generation disabled" })
            log({ sessionId: job.sessionId, directory: job.directory, trigger: info.trigger, turns: info.turns, calls: job.attempts, outcome: "skipped", reason: "generation disabled" })
            release(job)
            continue
          }
          const proposed = store.extraction.settle(job, () => options.commit(job, memories))
          log({ sessionId: job.sessionId, directory: job.directory, trigger: info.trigger, turns: info.turns, calls: job.attempts, proposed, outcome: "ran" })
          completedAt = now()
          options.settled?.(job)
          release(job)
        } catch (error) {
          if (stopped) put(job, { state: "queued", attempts: job.attempts - 1, reason: "Paused for shutdown" })
          else {
            const next = put(job, { state: job.attempts <= 2 ? "queued" : "failed", reason: String(error).slice(0, 500), nextAttemptAt: now() + (options.retryMs ?? 500 * 2 ** job.attempts) })
            if (next.state === "failed") {
              log({ sessionId: job.sessionId, directory: job.directory, trigger: info.trigger, turns: info.turns, calls: job.attempts, outcome: "failed", reason: next.reason })
              release(job)
            }
          }
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
      return { queue: jobs.filter((job) => job.state === "queued" || job.state === "running").length, lastRun: jobs.find((job) => job.attempts > 0 && job.updatedAt >= completedAt)?.state ?? (completedAt ? "completed" : jobs.find((job) => job.attempts > 0)?.state ?? "never"), lastError: jobs.find((job) => job.state === "failed" || job.state === "queued" && !!job.reason)?.reason ?? "none" }
    },
    list(directory?: string) {
      return store.extraction.list().filter((job) => !directory || job.directory === directory).slice(-80).map(({ text: _text, ...job }) => job)
    },
    /** The newest review records: jobs with the proposals they made, and skips with their reasons. */
    reviews(limit = 50) { return store.memoryReviews.list(limit) },
    /** Ineligible sessions seen since the daemon started, per reason (kept in memory, not on disk). */
    ineligible(): Record<string, number> { return Object.fromEntries(ineligibleCounts) },
    retry(jobId: string) {
      const job = store.extraction.list().find((candidate) => candidate.jobId === jobId)
      if (!job || !["failed", "skipped"].includes(job.state)) throw new Error("Only failed or skipped extractions can be retried")
      put(job, { state: "queued", attempts: 0, nextAttemptAt: now(), reason: "" })
      schedule()
    },
    observe(event: SessionEvent) {
      if (event.type === "compaction.updated") {
        // Before the history is packed: review what was said so far (the first milestone of a compaction only).
        if (event.state === "writing" && restored(event.sessionId)) request(event.sessionId, "compaction")
        return
      }
      if (event.type !== "turn.completed") return
      const directory = store.sessionDirectory(event.sessionId)
      if (!directory || !enabled(directory)) return
      const existing = restored(event.sessionId)
      if (existing && event.seq <= existing.seenSeq) return
      if (!existing) {
        const why = skipReason(event.sessionId)
        if (why) { reportIneligible(event.sessionId, why); return }
      }
      const events = store.readBefore(event.sessionId, event.seq + 1, 1_000)
      const start = events.findLastIndex((entry) => entry.type === "turn.started" && entry.turnId === event.turnId)
      if (start < 0) return
      const turn = events.slice(start)
      const entry = track(event.sessionId)
      entry.seenSeq = event.seq
      // Notices and extraction results never feed the extractor recursively.
      if (!turn.some((item) => item.type === "item.started" && item.kind === "user_message") || isTrivialTurn(turn)) return
      if (entry.pending === 0 && entry.queuedFrom === undefined) entry.from = turn[0]!.seq - 1
      entry.pending++
      entry.lastTurnId = event.turnId
      save(event.sessionId, entry)
      if (entry.pending + entry.queuedTurns >= reviewPolicy(options.settings(directory)).everyTurns) request(event.sessionId, "turns")
      else armIdle(event.sessionId, entry)
    },
    async stop() {
      stopped = true
      clearTimeout(timer)
      for (const entry of tracks.values()) entry.idle?.cancel()
      active?.abort("Extraction stopped")
      await draining
    },
  }
}
