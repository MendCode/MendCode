import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { PrFinding, PrJobSummary, PrReviewResult, PrStopReason, PrTokenUsage, PR_JOB_STATES, PR_JOB_TRIGGERS, PR_REVIEW_COVERAGES, PR_REVIEW_PROVIDERS, PR_REVIEWER_SCOPES } from "@mendcode/protocol"
import { z } from "zod"
import { JOB_TRANSITIONS, jobKey, type JobCheckpoint, type JobLedger, type JobState, type ReviewJob } from "./contracts"

/**
 * The durable job ledger (docs/pr-review.md, R03): every review a watch, a command or a router asks for is a job in
 * `<dataDir>/pr-review/jobs.json`, written atomically (temp + rename, 0600) on every change, so a daemon restart finds what was
 * queued, what ran and what it had found. A job is one reviewer's work on one head: `upsert` returns the open job of the same
 * `jobKey` instead of a second one, `transition` refuses a move `JOB_TRANSITIONS` does not list, and `recover` puts the jobs a
 * stopped daemon left running back in line, counting the interrupted attempt. A damaged file is kept aside (`.corrupt-<time>`)
 * and the ledger starts empty: a lost queue is re-read from the provider at the next poll, a crash loop on a bad file is not.
 *
 * Bounded: the newest `retainTerminal` finished jobs are kept (done, failed, cancelled, stale) and at most `maxActive` open ones;
 * one more open job is refused rather than growing the file without end.
 */

export const TERMINAL_JOB_STATES: readonly JobState[] = ["done", "failed", "cancelled", "stale"]
export const isTerminal = (state: JobState) => TERMINAL_JOB_STATES.includes(state)
/** Running states: a daemon that stopped while a job was in one of them was interrupted, not finished. */
const IN_FLIGHT: readonly JobState[] = ["running", "fixing", "validating"]

/** Retry backoff: the first retry waits up to 30 s, doubling per attempt, never more than 30 minutes (full jitter). */
export const BACKOFF_BASE_MS = 30_000
export const BACKOFF_CAP_MS = 30 * 60_000
/** A job that failed (or was interrupted) this many times is `failed` for good; a new head or `/pr review` starts a new one. */
export const MAX_JOB_ATTEMPTS = 5
export const DEFAULT_RETAIN_TERMINAL = 500
export const DEFAULT_MAX_ACTIVE = 1000

/**
 * When a job that ended unsuccessfully `attempts` times may run again: exponential backoff with full jitter (a uniform delay in
 * `[0, min(cap, base * 2^(attempts-1)))`), so many jobs failing together (GitHub down, a quota) do not retry in lockstep.
 */
export function nextAttemptAt(attempts: number, now: number, random: () => number = Math.random) {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, Math.min(30, attempts - 1)))
  const draw = Math.min(Math.max(random(), 0), 1 - Number.EPSILON)
  return now + Math.floor(draw * ceiling)
}

/**
 * A job that fails on a transient error (the network, the forge's servers, a sleep during its attempt) waits and runs again without
 * spending an attempt for this long after its first such failure; past it, its failures count as usual.
 */
export const TRANSIENT_RETRY_WINDOW_MS = 24 * 3_600_000
/** The longest wait between such retries: a machine that wakes up with its network back is not left idle for long. */
export const TRANSIENT_BACKOFF_CAP_MS = 15 * 60_000

/**
 * When a job that failed transiently `waits` times in a row runs again: up to 30 s at first, doubling, at most 15 minutes, with
 * equal jitter (half fixed, half random), so a job never retries at once in a loop and many jobs do not retry in lockstep.
 */
export function transientRetryAt(waits: number, now: number, random: () => number = Math.random) {
  const ceiling = Math.min(TRANSIENT_BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, Math.min(30, waits - 1)))
  const draw = Math.min(Math.max(random(), 0), 1 - Number.EPSILON)
  return now + Math.floor(ceiling / 2 + draw * ceiling / 2)
}

/** Built on first use: the protocol's schemas are lazy and the daemon imports this module whether or not a review ever runs. */
let built: ReturnType<typeof buildSchemas> | undefined
const schemas = () => built ??= buildSchemas()
function buildSchemas() {
  const Checkpoint = z.object({
    phase: z.string().max(60).optional(),
    completedPhases: z.array(z.string().max(60)).max(50),
    candidates: z.array(PrFinding).max(1000),
    verified: z.array(PrFinding).max(1000),
    result: PrReviewResult.optional(),
    rounds: z.array(z.object({ at: z.number(), open: z.array(z.string().max(80)).max(1000), commit: z.string().max(64).optional(), interrupted: z.literal(true).optional(), kept: z.string().max(200).optional() })).max(100),
    decisions: z.array(z.object({ phase: z.string().max(60), action: z.enum(["added", "skipped", "kept"]), reason: z.string().max(600) })).max(100),
    sections: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), z.string().max(8000)).refine((value) => Object.keys(value).length <= 20, "at most 20 sections").optional(),
    readers: z.array(z.object({ id: z.string().max(20), paths: z.array(z.string().max(4096)).max(2000), text: z.string().max(2000), by: z.string().max(200), code: z.array(z.object({ path: z.string().max(4096), changed: z.string().max(600), risks: z.array(z.object({ start: z.number().int().positive(), end: z.number().int().positive(), kind: z.string().max(40), why: z.string().max(400) })).max(12), nothingRisky: z.boolean() })).max(40).optional() })).max(500).optional(),
  })
  const Job = z.object({
    id: z.string().min(1).max(80),
    provider: z.enum(PR_REVIEW_PROVIDERS),
    repo: z.string().min(1).max(4096),
    directory: z.string().max(4096),
    number: z.number().int().positive(),
    sessionId: z.string().max(120),
    reviewer: z.string().min(1).max(120),
    scope: z.enum(PR_REVIEWER_SCOPES),
    assignment: z.string().max(400).optional(),
    trigger: z.enum(PR_JOB_TRIGGERS),
    state: z.enum(PR_JOB_STATES),
    coverage: z.enum(PR_REVIEW_COVERAGES),
    base: z.string().max(64),
    head: z.string().max(64),
    configKey: z.string().max(200),
    attempts: z.number().int().nonnegative(),
    createdAt: z.number(),
    updatedAt: z.number(),
    notBefore: z.number().optional(),
    owner: z.string().max(120).optional(),
    reviewSessionId: z.string().max(120).optional(),
    fixSessionId: z.string().max(120).optional(),
    control: z.enum(["reviewer", "user"]).optional(),
    checkpoint: Checkpoint,
    tokens: PrTokenUsage,
    readTokens: PrTokenUsage.optional(),
    stop: PrStopReason.optional(),
    error: z.string().max(2000).optional(),
    transient: z.object({ since: z.number(), waits: z.number().int().nonnegative() }).optional(),
    title: z.string().max(300).optional(),
    url: z.string().max(500).optional(),
    stack: z.object({ parent: z.number().int().positive().optional(), children: z.array(z.number().int().positive()).max(50), depth: z.number().int().nonnegative() }).optional(),
    covers: z.array(z.string().min(1).max(120)).min(1).max(10).optional(),
  })
  const File = z.object({ version: z.literal(1), jobs: z.array(z.unknown()) })
  return { Job, File }
}

const emptyCheckpoint = (): JobCheckpoint => ({ completedPhases: [], candidates: [], verified: [], rounds: [], decisions: [] })

export type JobLedgerOptions = {
  /** `<dataDir>/pr-review/jobs.json`. */
  file: string
  now?: () => number
  /** For job ids; tests make them reproducible. */
  random?: () => number
  retainTerminal?: number
  maxActive?: number
}
export type JobLedgerService = JobLedger & {
  readonly file: string
  /** Every job, open and finished, in the order they were created (copies). */
  all(): ReviewJob[]
}

export function createJobLedger({ file, now = Date.now, random, retainTerminal = DEFAULT_RETAIN_TERMINAL, maxActive = DEFAULT_MAX_ACTIVE }: JobLedgerOptions): JobLedgerService {
  let jobs: ReviewJob[] = load()

  function load(): ReviewJob[] {
    let text: string
    try { text = readFileSync(file, "utf8") } catch { return [] }
    let envelope: { jobs: unknown[] } | undefined
    try {
      const parsed = schemas().File.safeParse(JSON.parse(text))
      if (parsed.success) envelope = parsed.data
    } catch { /* not JSON: kept aside below */ }
    if (!envelope) { keepAside(true); return [] }
    const valid = envelope.jobs.flatMap((item) => { const job = schemas().Job.safeParse(item); return job.success ? [job.data as ReviewJob] : [] })
    // A file with some unreadable jobs still serves the rest; the original is copied aside so nothing is lost without a trace.
    if (valid.length !== envelope.jobs.length) keepAside(false)
    return valid
  }
  function keepAside(move: boolean) {
    const aside = `${file}.corrupt-${now()}`
    try { if (move) renameSync(file, aside); else copyFileSync(file, aside) } catch { /* nothing to keep */ }
  }

  /** Oldest finished jobs beyond `retainTerminal` are dropped; open jobs are never dropped here (`maxActive` refuses new ones). */
  function prune() {
    const finished = jobs.filter((job) => isTerminal(job.state))
    if (finished.length <= retainTerminal) return
    const keep = new Set(finished.toSorted((a, b) => b.updatedAt - a.updatedAt).slice(0, retainTerminal))
    jobs = jobs.filter((job) => !isTerminal(job.state) || keep.has(job))
  }
  function save() {
    prune()
    try {
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      const temp = `${file}.${crypto.randomUUID()}.tmp`
      writeFileSync(temp, JSON.stringify({ version: 1, jobs }), { mode: 0o600, flag: "wx" })
      renameSync(temp, file)
    } catch { /* an unsaved change still holds until the daemon stops, as watches.json does */ }
  }
  /** Every write goes through the schema, so the file never holds a job the next start would drop. */
  function validate(job: ReviewJob): ReviewJob {
    const parsed = schemas().Job.safeParse(job)
    if (!parsed.success) throw new RangeError(`[PR_REVIEW]: invalid job ${job.id}: ${parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`)
    return parsed.data as ReviewJob
  }
  // A job is JSON data (validated, and saved as JSON), so a JSON round trip is a full copy, about three times cheaper than
  // structuredClone: the run queue reads every open job per scheduling step, and it may hold hundreds.
  const copy = (job: ReviewJob): ReviewJob => JSON.parse(JSON.stringify(job)) as ReviewJob
  const indexOf = (id: string) => {
    const index = jobs.findIndex((job) => job.id === id)
    if (index < 0) throw new RangeError(`[PR_REVIEW]: no job ${id}`)
    return index
  }
  function replace(index: number, next: ReviewJob) {
    const stored = validate(next)
    jobs[index] = stored
    save()
    return copy(stored)
  }
  const newId = () => {
    const suffix = random ? Math.floor(random() * 0xffff_ffff).toString(16).padStart(8, "0") : crypto.randomUUID().replaceAll("-", "").slice(0, 12)
    return `prj_${now().toString(36)}${suffix}`
  }

  return {
    file,
    upsert(input) {
      const key = jobKey(input)
      const open = jobs.find((job) => !isTerminal(job.state) && jobKey(job) === key)
      if (open) return copy(open)
      if (jobs.filter((job) => !isTerminal(job.state)).length >= maxActive) throw new RangeError(`[PR_REVIEW]: the job ledger holds ${maxActive} open jobs; no more are queued until some finish`)
      const at = now()
      let id = newId()
      while (jobs.some((job) => job.id === id)) id = newId()
      const job = validate({ ...input, id, state: input.state ?? "pending", attempts: 0, createdAt: at, updatedAt: at, checkpoint: emptyCheckpoint(), tokens: { input: 0, output: 0 } })
      jobs.push(job)
      save()
      return copy(job)
    },
    get(id) {
      const job = jobs.find((item) => item.id === id)
      return job && copy(job)
    },
    /**
     * Moves a job and applies `patch`. The same state again is not a move: it only applies the patch (marking a running job
     * `superseded`, recording its review session), so it needs no row in `JOB_TRANSITIONS`.
     */
    transition(id, state, patch = {}) {
      const index = indexOf(id)
      const job = jobs[index]!
      if (state !== job.state && !JOB_TRANSITIONS[job.state].includes(state)) throw new RangeError(`[PR_REVIEW]: job ${id} cannot go from ${job.state} to ${state}`)
      return replace(index, { ...job, ...patch, id: job.id, state, updatedAt: now() } as ReviewJob)
    },
    checkpoint(id, patch) {
      const index = indexOf(id)
      const job = jobs[index]!
      return replace(index, { ...job, checkpoint: { ...job.checkpoint, ...patch }, updatedAt: now() })
    },
    addTokens(id, tokens, read) {
      const index = indexOf(id)
      const job = jobs[index]!
      const sum = (a: number | undefined, b: number | undefined) => a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0)
      const add = (before: PrTokenUsage) => {
        const cached = sum(before.cached, tokens.cached), unreported = sum(before.unreported, tokens.unreported)
        return { input: before.input + tokens.input, output: before.output + tokens.output, ...(cached === undefined ? {} : { cached }), ...(unreported === undefined ? {} : { unreported }) }
      }
      return replace(index, { ...job, tokens: add(job.tokens), ...(read ? { readTokens: add(job.readTokens ?? { input: 0, output: 0 }) } : {}), updatedAt: now() })
    },
    list(filter = {}) {
      return jobs.filter((job) => (filter.repo === undefined || job.repo === filter.repo) && (filter.number === undefined || job.number === filter.number) && (filter.reviewer === undefined || job.reviewer === filter.reviewer) && (!filter.states || filter.states.includes(job.state))).map(copy)
    },
    recover() {
      const at = now()
      const recovered: ReviewJob[] = []
      jobs = jobs.map((job) => {
        if (!IN_FLIGHT.includes(job.state)) return job
        const next: ReviewJob = { ...job, state: "pending", attempts: job.attempts + 1, updatedAt: at }
        delete next.notBefore
        recovered.push(next)
        return next
      })
      if (recovered.length) save()
      return recovered.map(copy)
    },
    /**
     * A `pending` job is due once its `notBefore` (if any) passed. A `waiting` job is due only with a `notBefore` that passed:
     * one waiting without a time (an offline owner, a missing consent) waits for whoever holds it to move it.
     */
    due(at) {
      return jobs
        .filter((job) => job.state === "pending" ? (job.notBefore ?? -Infinity) <= at : job.state === "waiting" && job.notBefore !== undefined && job.notBefore <= at)
        .toSorted((a, b) => a.createdAt - b.createdAt)
        .map(copy)
    },
    all: () => jobs.map(copy),
  }
}

const clip = (text: string | undefined, max: number) => text === undefined ? undefined : text.length > max ? `${text.slice(0, max - 1)}…` : text

/** A job as the TUI page and `pr.review status` show it: no checkpoint payload, only counts; validated with the protocol schema. */
export function toSummary(job: ReviewJob): PrJobSummary {
  const verdict = (name: string) => job.checkpoint.verified.filter((finding) => finding.verdict === name).length
  return PrJobSummary.parse({
    id: clip(job.id, 80),
    provider: job.provider,
    repo: clip(job.repo, 200),
    number: job.number,
    title: clip(job.title, 300),
    url: job.url && job.url.length <= 500 ? job.url : undefined,
    reviewer: clip(job.reviewer, 120),
    scope: job.scope,
    assignment: clip(job.assignment, 400),
    trigger: job.trigger,
    state: job.state,
    phase: clip(job.checkpoint.phase, 60),
    coverage: job.coverage,
    base: job.base.slice(0, 64),
    head: job.head.slice(0, 64),
    attempts: job.attempts,
    createdAt: Math.trunc(job.createdAt),
    updatedAt: Math.trunc(job.updatedAt),
    owner: clip(job.owner, 120),
    sessionId: clip(job.reviewSessionId, 120),
    fixSessionId: clip(job.fixSessionId, 120),
    control: job.control,
    // `resolved` needs the PR's thread state, which the ledger does not keep: the page reads it from the review state.
    findings: { confirmed: verdict("confirmed"), plausible: verdict("plausible"), candidates: job.checkpoint.candidates.length, resolved: 0 },
    tokens: job.tokens,
    ...(job.readTokens ? { readTokens: job.readTokens } : {}),
    stop: job.stop,
    error: clip(job.error, 600),
    stack: job.stack,
  })
}
