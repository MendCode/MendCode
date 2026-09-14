import { existsSync } from "fs"
import { randomUUID } from "crypto"
import { Flock } from "@mendcode/core/util/flock"
import * as Log from "@mendcode/core/util/log"
import { mkdir, readFile, rename, writeFile } from "fs/promises"
import path from "path"
import { memoryPaths } from "./config"

export type MemoryExtractionState = "queued" | "running" | "completed" | "skipped" | "failed"

export type MemoryExtractionJob = {
  id: string
  identity: string
  projectRoot: string
  sessionID: string
  turnID: string
  messageID: string
  finishPartID?: string
  cwd: string
  text: string
  evidence: string
  createdAt: string
  updatedAt: string
  state: MemoryExtractionState
  attempts: number
  ownerPID?: number
  claimID?: string
  nextAttemptAt?: string
  reason?: string | null
  result?: unknown
}

type QueueFile = { version: 1; jobs: MemoryExtractionJob[] }

type Runner = (job: MemoryExtractionJob, signal: AbortSignal) => Promise<{ state?: "completed" | "skipped"; reason?: string | null; result?: unknown }>

const log = Log.create({ service: "memory.extraction-queue" })
const DEFAULT_CONCURRENCY = 2
const DEFAULT_TIMEOUT_MS = 45_000
const MAX_RETRIES = 2
const MAX_PENDING_JOBS = 128
const MAX_RETAINED_TERMINAL_JOBS = 256
const MAX_JOB_TEXT_BYTES = 64 * 1024

function positiveEnv(name: string, fallback: number) {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback
}

function ownerIsAlive(pid: number | undefined) {
  if (!Number.isSafeInteger(pid) || !pid || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // Permission denial still means an owner exists; do not steal its work.
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

function queuePath(root: string) {
  return memoryPaths(root).extractionQueue
}

function identity(input: Pick<MemoryExtractionJob, "projectRoot" | "sessionID" | "turnID">) {
  return `${path.resolve(input.projectRoot)}:${input.sessionID}:${input.turnID}`
}

function normalizeQueueFile(value: unknown): QueueFile {
  if (!value || typeof value !== "object") return { version: 1, jobs: [] }
  const jobs = Array.isArray((value as { jobs?: unknown }).jobs) ? (value as { jobs: unknown[] }).jobs : []
  return {
    version: 1,
    jobs: jobs.filter((job): job is MemoryExtractionJob => Boolean(job && typeof job === "object" && typeof (job as MemoryExtractionJob).id === "string" && typeof (job as MemoryExtractionJob).identity === "string")),
  }
}

async function readQueue(root: string) {
  const file = queuePath(root)
  if (!existsSync(file)) return { version: 1, jobs: [] } satisfies QueueFile
  return normalizeQueueFile(JSON.parse(await readFile(file, "utf8")))
}

export async function readMemoryExtractionQueue(root: string) {
  return (await readQueue(root)).jobs
}

async function writeQueue(root: string, queue: QueueFile) {
  const file = queuePath(root)
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(queue, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, file)
}

function timeout<T>(promise: Promise<T>, duration: number, signal: AbortSignal) {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("Aborted", "AbortError"))
    const cleanup = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
    }
    const fail = (error: unknown) => { cleanup(); reject(error) }
    const abort = () => fail(new DOMException("Aborted", "AbortError"))
    const timer = setTimeout(() => fail(new Error(`memory extraction timed out after ${duration}ms`)), duration)
    signal.addEventListener("abort", abort, { once: true })
    promise.then((value) => { cleanup(); resolve(value) }, fail)
  })
}

export class MemoryExtractionQueue {
  private readonly locks = new Map<string, Promise<void>>()
  private readonly runners = new Map<string, Runner>()
  private readonly active = new Set<string>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly scheduled = new Set<string>()
  private readonly retryTimers = new Map<string, { at: number; timer: ReturnType<typeof setTimeout> }>()
  private draining: Promise<void> = Promise.resolve()
  private readonly stopped = new Set<string>()
  private readonly stopping = new Map<string, Promise<void>>()
  private readonly inflight = new Map<string, { root: string; promise: Promise<void> }>()

  constructor(private readonly options: { concurrency?: number; timeoutMs?: number; maxRetries?: number; maxPendingJobs?: number; maxRetainedJobs?: number } = {}) {}

  private async write(root: string, queue: QueueFile) {
    const limit = Math.max(1, Math.min(MAX_RETAINED_TERMINAL_JOBS, this.options.maxRetainedJobs ?? MAX_RETAINED_TERMINAL_JOBS))
    const terminal = queue.jobs.filter((job) => job.state !== "queued" && job.state !== "running")
    const retained = new Set(terminal.slice(-limit).map((job) => job.id))
    queue.jobs = queue.jobs.filter((job) => job.state === "queued" || job.state === "running" || retained.has(job.id))
    await writeQueue(root, queue)
  }

  private withLock<T>(root: string, task: () => Promise<T>) {
    root = path.resolve(root)
    const file = queuePath(root)
    const operation = () => Flock.withLock(`memory-extraction:${file}`, task, {
      dir: path.join(path.dirname(file), ".locks"),
      timeoutMs: 5_000,
    })
    const previous = this.locks.get(root) ?? Promise.resolve()
    const next = previous.then(operation, operation)
    const settled = next.then(() => undefined, () => undefined)
    this.locks.set(root, settled)
    void settled.then(() => {
      if (this.locks.get(root) === settled) this.locks.delete(root)
    })
    return next
  }

  async enqueue(input: Omit<MemoryExtractionJob, "id" | "identity" | "createdAt" | "updatedAt" | "state" | "attempts"> & { turnID?: string }) {
    const turnID = input.turnID || input.messageID
    const now = new Date().toISOString()
    const jobIdentity = identity({ projectRoot: input.projectRoot, sessionID: input.sessionID, turnID })
    const job = await this.withLock(input.projectRoot, async () => {
      const queue = await readQueue(input.projectRoot)
      const existing = queue.jobs.find((item) => item.identity === jobIdentity)
      if (existing) return existing
      const limit = Math.max(1, Math.min(MAX_PENDING_JOBS, this.options.maxPendingJobs ?? MAX_PENDING_JOBS))
      if (queue.jobs.filter((job) => job.state === "queued" || job.state === "running").length >= limit) {
        throw new Error(`memory extraction queue full (${limit} pending jobs)`)
      }
      if (Buffer.byteLength(input.text, "utf8") > MAX_JOB_TEXT_BYTES) {
        throw new Error(`memory extraction input exceeds ${MAX_JOB_TEXT_BYTES} bytes`)
      }
      const next: MemoryExtractionJob = {
        ...input,
        turnID,
        id: `memory_extract_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        identity: jobIdentity,
        createdAt: now,
        updatedAt: now,
        state: "queued",
        attempts: 0,
        reason: null,
      }
      queue.jobs.push(next)
      await this.write(input.projectRoot, queue)
      return next
    })
    this.schedule(input.projectRoot)
    return job
  }

  async start(root: string, runner: Runner) {
    root = path.resolve(root)
    await this.stopping.get(root)
    this.stopped.delete(root)
    // A new processor is created for each turn. Only a new queue instance may
    // recover running jobs; resetting them on every turn duplicates live work.
    if (this.runners.has(root)) return
    this.runners.set(root, runner)
    await this.withLock(root, async () => {
      const queue = await readQueue(root)
      let changed = false
      for (const job of queue.jobs) {
        if (job.state !== "running" || ownerIsAlive(job.ownerPID)) continue
        job.ownerPID = undefined
        job.state = "queued"
        job.reason = "recovered after restart"
        job.updatedAt = new Date().toISOString()
        changed = true
      }
      if (changed) await writeQueue(root, queue)
      return undefined
    }).catch((error) => {
      if (this.runners.get(root) === runner) this.runners.delete(root)
      throw error
    })
    this.schedule(root)
  }

  async list(root: string) {
    return (await this.withLock(root, () => readQueue(root))).jobs
  }

  async stop(root: string) {
    root = path.resolve(root)
    const existing = this.stopping.get(root)
    if (existing) return existing
    this.stopped.add(root)
    this.runners.delete(root)
    const timer = this.retryTimers.get(root)
    if (timer) clearTimeout(timer.timer)
    this.retryTimers.delete(root)
    const stopping = (async () => {
      // Finish any in-flight claim before collecting its controller.
      await this.draining
      const runs = [...this.inflight.entries()].filter(([, run]) => run.root === root)
      for (const [id] of runs) this.controllers.get(id)?.abort("memory queue stopped")
      await Promise.all(runs.map(([, run]) => run.promise))
    })()
    this.stopping.set(root, stopping)
    try { await stopping } finally {
      this.stopping.delete(root)
      this.stopped.delete(root)
    }
  }

  async cancel(root: string, id: string, reason = "cancelled") {
    this.controllers.get(id)?.abort(reason)
    return this.withLock(root, async () => {
      const queue = await readQueue(root)
      const job = queue.jobs.find((item) => item.id === id)
      if (!job || ["completed", "skipped", "failed"].includes(job.state)) return job
      job.state = "skipped"
      job.reason = reason
      job.updatedAt = new Date().toISOString()
      await this.write(root, queue)
      return job
    })
  }

  private schedule(root: string) {
    const resolved = path.resolve(root)
    if (this.stopped.has(resolved) || this.scheduled.has(resolved)) return
    this.scheduled.add(resolved)
    queueMicrotask(() => {
      this.scheduled.delete(resolved)
      // Serialize claims across roots; checking active.size before an awaited
      // read otherwise allows overlapping drains to exceed the worker limit.
      this.draining = this.draining.then(() => this.drain(resolved)).catch((error) => {
        log.error("memory extraction claim failed", { root: resolved, error: error instanceof Error ? error.name : "UnknownError" })
      })
    })
  }

  private scheduleRetry(root: string, at: number) {
    if (this.stopped.has(root)) return
    const previous = this.retryTimers.get(root)
    if (previous && previous.at <= at) return
    if (previous) clearTimeout(previous.timer)
    const timer = setTimeout(() => {
      this.retryTimers.delete(root)
      this.schedule(root)
    }, Math.max(0, at - Date.now()))
    timer.unref?.()
    this.retryTimers.set(root, { at, timer })
  }

  private async drain(root: string) {
    const runner = this.runners.get(root)
    if (!runner) return
    const concurrency = Math.max(1, Math.min(8, this.options.concurrency ?? positiveEnv("MENDCODE_MEMORY_EXTRACTION_CONCURRENCY", DEFAULT_CONCURRENCY)))
    while (!this.stopped.has(root) && this.active.size < concurrency) {
      const job = await this.withLock(root, async () => {
        const queue = await readQueue(root)
        const candidate = queue.jobs.find((item) => item.state === "queued" && (!item.nextAttemptAt || Date.parse(item.nextAttemptAt) <= Date.now()))
        if (!candidate) {
          const next = queue.jobs.reduce((earliest, item) => {
            if (item.state !== "queued" || !item.nextAttemptAt) return earliest
            const at = Date.parse(item.nextAttemptAt)
            return Number.isFinite(at) ? Math.min(earliest, at) : earliest
          }, Infinity)
          if (Number.isFinite(next)) this.scheduleRetry(root, next)
          return undefined
        }
        candidate.state = "running"
        candidate.ownerPID = process.pid
        candidate.claimID = randomUUID()
        candidate.attempts += 1
        candidate.updatedAt = new Date().toISOString()
        await writeQueue(root, queue)
        return candidate
      })
      if (!job) return
      this.active.add(job.id)
      const promise = this.run(root, job, runner).catch((error) => {
        log.error("memory extraction settlement failed", { root, jobID: job.id, error: error instanceof Error ? error.name : "UnknownError" })
      }).finally(() => {
        this.active.delete(job.id)
        this.inflight.delete(job.id)
        for (const pendingRoot of this.runners.keys()) this.schedule(pendingRoot)
      })
      this.inflight.set(job.id, { root, promise })
    }
  }

  private async run(root: string, job: MemoryExtractionJob, runner: Runner) {
    const controller = new AbortController()
    this.controllers.set(job.id, controller)
    try {
      const result = await timeout(runner(job, controller.signal), this.options.timeoutMs ?? positiveEnv("MENDCODE_MEMORY_EXTRACTION_TIMEOUT_MS", DEFAULT_TIMEOUT_MS), controller.signal)
      await this.finish(root, job, result.state ?? "completed", result.reason ?? null, result.result)
    } catch (error) {
      if (controller.signal.reason === "memory queue stopped") {
        await this.withLock(root, async () => {
          const queue = await readQueue(root)
          const current = queue.jobs.find((item) => item.id === job.id)
          if (!current || current.state !== "running" || current.claimID !== job.claimID) return
          current.state = "queued"
          current.ownerPID = undefined
          current.claimID = undefined
          current.attempts = Math.max(0, current.attempts - 1)
          current.reason = "paused for shutdown"
          current.updatedAt = new Date().toISOString()
          await writeQueue(root, queue)
        })
        return
      }
      controller.abort()
      const reason = error instanceof Error ? error.message : String(error)
      const retries = this.options.maxRetries ?? MAX_RETRIES
      if (job.attempts <= retries && !/aborted/i.test(reason)) {
        const delay = Math.min(30_000, 500 * 2 ** job.attempts)
        await this.withLock(root, async () => {
          const queue = await readQueue(root)
          const current = queue.jobs.find((item) => item.id === job.id)
          if (!current || current.state !== "running" || current.claimID !== job.claimID) return
          current.state = "queued"
          current.reason = reason
          current.nextAttemptAt = new Date(Date.now() + delay).toISOString()
          current.updatedAt = new Date().toISOString()
          await writeQueue(root, queue)
        })
        this.scheduleRetry(root, Date.now() + delay)
        return
      }
      await this.finish(root, job, /aborted/i.test(reason) ? "skipped" : "failed", reason)
    } finally {
      this.controllers.delete(job.id)
    }
  }

  private async finish(root: string, claimed: MemoryExtractionJob, state: "completed" | "skipped" | "failed", reason: string | null, result?: unknown) {
    await this.withLock(root, async () => {
      const queue = await readQueue(root)
      const job = queue.jobs.find((item) => item.id === claimed.id)
      if (!job) return
      if (job.state !== "running" || job.claimID !== claimed.claimID) return
      job.state = state
      job.reason = reason
      job.result = result
      job.nextAttemptAt = undefined
      job.updatedAt = new Date().toISOString()
      await this.write(root, queue)
    })
  }
}

export * as MemoryExtraction from "./extraction-queue"
