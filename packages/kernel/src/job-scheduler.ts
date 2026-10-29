import type { JobId, JobState, JobType, Priority, ResourceMode } from "@mendcode/protocol"
import type { createIdFactory } from "@mendcode/protocol"
import type { Clock, TimerHandle } from "./clock"
import type { GlobalEventSink } from "./ports"
import type { Scope } from "./scope"

type IdFactory = ReturnType<typeof createIdFactory>

export type JobContext = {
  jobId: JobId
  signal: AbortSignal
  /** Cooperative yield point: waits while the job is paused, rejects once the job is cancelled. */
  checkpoint(): Promise<void>
}

export type JobSpec = {
  jobType: JobType
  priority: Extract<Priority, "P3" | "P4" | "P5" | "P6">
  runAt?: number
  run(context: JobContext): Promise<void>
}

type Job = {
  jobId: JobId
  spec: JobSpec
  state: JobState
  abort: AbortController
  resumeWaiters: Array<() => void>
}

export const CONCURRENCY: Record<ResourceMode, number> = { low: 1, normal: 2, high: 4 }
const YIELDING: ReadonlySet<Priority> = new Set(["P5", "P6"])

/**
 * The single owner of background jobs (Dream, loops, workflows, maintenance).
 * It has no reference to any SessionActor: it can only observe foreground *pressure*, never change
 * foreground state (I3). One timer at most, armed for the earliest scheduled job (P12).
 */
export function createJobScheduler(options: { clock: Clock; scope: Scope; sink: GlobalEventSink; ids: IdFactory; mode?: ResourceMode }) {
  const { clock, scope, sink, ids } = options
  const jobs = new Map<JobId, Job>()
  const busySessions = new Set<string>()
  let mode: ResourceMode = options.mode ?? "normal"
  let wake: TimerHandle | undefined

  function setState(job: Job, state: JobState, detail?: string) {
    if (job.state === state && detail === undefined) return
    job.state = state
    sink.append({ type: "job.state", jobId: job.jobId, jobType: job.spec.jobType, state, ...(detail ? { detail } : {}) })
  }

  function foregroundBusy() {
    return busySessions.size > 0
  }

  function mayRun(job: Job) {
    return !(foregroundBusy() && YIELDING.has(job.spec.priority))
  }

  function running() {
    let count = 0
    for (const job of jobs.values()) if (job.state === "running" || job.state === "paused") count++
    return count
  }

  function pump() {
    wake?.cancel()
    wake = undefined
    if (scope.disposed) return
    const now = clock.now()
    for (const job of jobs.values()) {
      if (job.state === "paused" && mayRun(job)) {
        setState(job, "running")
        for (const resume of job.resumeWaiters.splice(0)) resume()
      } else if (job.state === "running" && !mayRun(job)) {
        setState(job, "paused", "yielding to foreground")
      }
    }
    const due = [...jobs.values()]
      .filter((job) => job.state === "scheduled" && (job.spec.runAt ?? 0) <= now && mayRun(job))
      .sort((a, b) => a.spec.priority.localeCompare(b.spec.priority) || (a.spec.runAt ?? 0) - (b.spec.runAt ?? 0))
    for (const job of due) {
      if (running() >= CONCURRENCY[mode]) break
      launch(job)
    }
    let next: number | undefined
    for (const job of jobs.values()) {
      if (job.state !== "scheduled" || job.spec.runAt === undefined || job.spec.runAt <= now) continue
      next = next === undefined ? job.spec.runAt : Math.min(next, job.spec.runAt)
    }
    if (next !== undefined) wake = scope.timer(next - now, pump)
  }

  function launch(job: Job) {
    setState(job, "running")
    const context: JobContext = {
      jobId: job.jobId,
      signal: job.abort.signal,
      checkpoint() {
        if (job.abort.signal.aborted) return Promise.reject(new Error("[JOB]: cancelled"))
        if (job.state !== "paused") return Promise.resolve()
        return new Promise((resolve, reject) => {
          // Each wait removes its own abort listener when it resumes: a job paused and resumed many times keeps none.
          const cancelled = () => reject(new Error("[JOB]: cancelled"))
          job.resumeWaiters.push(() => (job.abort.signal.removeEventListener("abort", cancelled), resolve()))
          job.abort.signal.addEventListener("abort", cancelled, { once: true })
        })
      },
    }
    job.spec
      .run(context)
      .then(
        () => setState(job, "done", job.abort.signal.aborted ? "cancelled" : undefined),
        (error: unknown) =>
          job.abort.signal.aborted
            ? setState(job, "done", "cancelled")
            : setState(job, "error", error instanceof Error ? error.message.slice(0, 500) : "job failed"),
      )
      .finally(() => {
        jobs.delete(job.jobId)
        pump()
      })
  }

  scope.onDispose(() => {
    wake?.cancel()
    for (const job of jobs.values()) job.abort.abort()
  })

  return {
    schedule(spec: JobSpec) {
      const job: Job = { jobId: ids("job"), spec, state: "scheduled", abort: new AbortController(), resumeWaiters: [] }
      jobs.set(job.jobId, job)
      sink.append({ type: "job.state", jobId: job.jobId, jobType: spec.jobType, state: "scheduled" })
      pump()
      return job.jobId
    },
    cancel(jobId: JobId) {
      const job = jobs.get(jobId)
      if (!job) return false
      job.abort.abort()
      if (job.state === "scheduled") {
        jobs.delete(jobId)
        setState(job, "done", "cancelled")
        pump()
      }
      return true
    },
    /** Called by the daemon when a session's foreground becomes busy/idle. Pressure only; no state access. */
    setForegroundBusy(sessionId: string, busy: boolean) {
      const had = busySessions.has(sessionId)
      if (busy === had) return
      if (busy) busySessions.add(sessionId)
      else busySessions.delete(sessionId)
      pump()
    },
    setMode(next: ResourceMode) {
      mode = next
      pump()
    },
    snapshot() {
      return [...jobs.values()].map((job) => ({ jobId: job.jobId, jobType: job.spec.jobType, priority: job.spec.priority, state: job.state }))
    },
  }
}
export type JobScheduler = ReturnType<typeof createJobScheduler>
