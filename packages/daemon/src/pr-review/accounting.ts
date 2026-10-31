import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { PrTokenUsage } from "@mendcode/protocol"
import { z } from "zod"
import { addUsage, countedTokens } from "./budget"

/**
 * The review platform's token accounting (docs/pr-review.md, budgets; locked decision 2): every model call a review job makes,
 * kept in `<dataDir>/pr-review/accounting.json` so the totals of a pull request head survive restarts, retries and resumes. A
 * total is per (repository, PR number, head, reviewer), the unit `tokens_per_pr` caps; each call is one entry with its job,
 * purpose, attempt and, for a child session (a verifier, a fix child), the session it ran in.
 *
 * Only what the provider reported is kept, as it reported it: `input` (including the cached part, as the review sessions add
 * it), `output`, `cached`, and `unreported` for a call with no report (unknown, never zero). Nothing is priced or converted; cached
 * and counted tokens stay separate figures. The file is bounded (`RETENTION_MS`, `MAX_RECORDS`, `MAX_ENTRIES`): totals keep
 * every call even after its entry is trimmed. A damaged file is set aside as `accounting.json.damaged` and starts empty.
 */

export const ACCOUNTING_PURPOSES = ["review", "verify", "fix", "explain", "resume"] as const
export type AccountingPurpose = (typeof ACCOUNTING_PURPOSES)[number]
/** One pull request head as one reviewer sees it: what `tokens_per_pr` counts against. */
export type AccountingKey = { repo: string; number: number; head: string; reviewer: string }

/** A record not touched for this long is dropped (the PR head is long reviewed or gone). */
export const RETENTION_MS = 30 * 86_400_000
/** At most this many PR heads, the most recently updated kept. */
export const MAX_RECORDS = 1_000
/** At most this many call entries across every record, the oldest trimmed first (their record's totals stay). */
export const MAX_ENTRIES = 5_000
const DAY_MS = 86_400_000

const count = z.number().int().nonnegative()
const Usage = z.object({ input: count, output: count, cached: count.optional(), unreported: count.optional() })
const Entry = z.object({
  at: z.number().int(),
  jobId: z.string().min(1).max(80),
  purpose: z.enum(ACCOUNTING_PURPOSES),
  /** The job's attempt the call belongs to (1 for the first run, +1 for each recovery or retry). */
  attempt: z.number().int().positive(),
  input: count, output: count, cached: count, unreported: count,
  /** The child session the call ran in, and the session it is a child of, when the caller knows them. */
  sessionId: z.string().max(120).optional(),
  parentSessionId: z.string().max(120).optional(),
})
export type AccountingEntry = z.infer<typeof Entry>
/**
 * `attempts` sums each job's highest attempt (a job retried once is 2; a second job on the same head adds its own); `jobs` keeps
 * the newest 50 jobs with their highest attempt, so the sum stays right after entries are trimmed.
 */
const Totals = z.object({ tokens: Usage, calls: count, byPurpose: z.partialRecord(z.enum(ACCOUNTING_PURPOSES), Usage), attempts: count, jobs: z.array(z.object({ id: z.string().max(80), attempts: z.number().int().positive() })).max(50) })
const HeadRecord = z.object({ repo: z.string().min(1).max(200), number: z.number().int().positive(), head: z.string().min(1).max(64), reviewer: z.string().min(1).max(120), updatedAt: z.number().int(), totals: Totals, entries: z.array(Entry) })
type AccountRecord = z.infer<typeof HeadRecord>
const File = z.object({ version: z.literal(1), records: z.array(HeadRecord) })

/** What a PR head cost: the provider's figures summed, `counted` (what `tokens_per_pr` sees), calls and the attempts they spanned. */
export type AccountTotals = { tokens: PrTokenUsage; counted: number; calls: number; byPurpose: Partial<Record<AccountingPurpose, PrTokenUsage>>; attempts: number; jobs: Array<{ id: string; attempts: number }> }
export type AccountingCall = AccountingKey & {
  jobId: string
  purpose: AccountingPurpose
  attempt: number
  input: number
  output: number
  cached?: number | undefined
  /** Calls in this report that had no provider usage (their tokens are unknown); usually 0 or 1. */
  unreported?: number | undefined
  sessionId?: string | undefined
  parentSessionId?: string | undefined
}

export const accountingFile = (dataDir: string) => path.join(dataDir, "pr-review", "accounting.json")
const keyOf = (key: AccountingKey) => [key.reviewer, key.repo, key.number, key.head].join("\u0000")
const usageOf = (entry: Pick<AccountingEntry, "input" | "output" | "cached" | "unreported">): PrTokenUsage => ({ input: entry.input, output: entry.output, cached: entry.cached, unreported: entry.unreported })
const emptyUsage = (): PrTokenUsage => ({ input: 0, output: 0, cached: 0, unreported: 0 })
const isCount = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0

export function createAccounting({ file, now = Date.now }: { file: string; now?: () => number }) {
  const records = new Map<string, AccountRecord>(load().map((record) => [keyOf(record), record]))

  function load(): AccountRecord[] {
    let text: string
    try { text = readFileSync(file, "utf8") } catch { return [] }
    try {
      const parsed = File.safeParse(JSON.parse(text))
      if (parsed.success) return parsed.data.records
    } catch { /* not JSON: set aside below */ }
    try { copyFileSync(file, `${file}.damaged`) } catch { /* the copy is a courtesy; starting empty is the rule */ }
    return []
  }
  function save() {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const temp = `${file}.${crypto.randomUUID()}.tmp`
    writeFileSync(temp, JSON.stringify({ version: 1, records: [...records.values()] }), { mode: 0o600, flag: "wx" })
    renameSync(temp, file)
  }

  /** Drops records past `RETENTION_MS`, keeps the newest `MAX_RECORDS`, then trims the oldest entries past `MAX_ENTRIES`. */
  function prune() {
    const cutoff = now() - RETENTION_MS
    for (const [key, record] of records) if (record.updatedAt < cutoff) records.delete(key)
    if (records.size > MAX_RECORDS) for (const [key] of [...records].toSorted(([, a], [, b]) => a.updatedAt - b.updatedAt).slice(0, records.size - MAX_RECORDS)) records.delete(key)
    let total = 0
    for (const record of records.values()) total += record.entries.length
    if (total <= MAX_ENTRIES) return
    const all = [...records.values()].flatMap((record) => record.entries.map((entry) => ({ record, at: entry.at }))).toSorted((a, b) => a.at - b.at)
    const drop = new Map<AccountRecord, number>()
    for (const { record } of all.slice(0, total - MAX_ENTRIES)) drop.set(record, (drop.get(record) ?? 0) + 1)
    for (const [record, n] of drop) record.entries = record.entries.toSorted((a, b) => a.at - b.at).slice(n)
  }

  function totalsOf(record: AccountRecord): AccountTotals {
    const tokens = usageOf({ input: record.totals.tokens.input, output: record.totals.tokens.output, cached: record.totals.tokens.cached ?? 0, unreported: record.totals.tokens.unreported ?? 0 })
    return { tokens, counted: countedTokens(tokens), calls: record.totals.calls, byPurpose: structuredClone(record.totals.byPurpose), attempts: record.totals.attempts, jobs: record.totals.jobs.map((job) => ({ ...job })) }
  }

  /**
   * Records one model call (or one report covering several calls of a turn) and returns the PR head's new totals. Throws
   * `TypeError` for a negative or fractional token count or an unknown purpose, so a bad report never corrupts the totals.
   */
  function record(call: AccountingCall): AccountTotals {
    for (const field of ["input", "output"] as const) if (!isCount(call[field])) throw new TypeError(`[PR_REVIEW]: accounting ${field} must be a non-negative integer, got ${String(call[field])}`)
    for (const field of ["cached", "unreported"] as const) if (call[field] !== undefined && !isCount(call[field])) throw new TypeError(`[PR_REVIEW]: accounting ${field} must be a non-negative integer, got ${String(call[field])}`)
    if ((call.cached ?? 0) > call.input) throw new RangeError(`[PR_REVIEW]: accounting cached (${call.cached}) is more than input (${call.input}); input includes the cached part`)
    if (!ACCOUNTING_PURPOSES.includes(call.purpose)) throw new TypeError(`[PR_REVIEW]: accounting purpose ${String(call.purpose)} is not one of ${ACCOUNTING_PURPOSES.join(", ")}`)
    if (!Number.isSafeInteger(call.attempt) || call.attempt < 1) throw new TypeError(`[PR_REVIEW]: accounting attempt must be a positive integer, got ${String(call.attempt)}`)
    const entry = Entry.parse({
      at: now(), jobId: call.jobId, purpose: call.purpose, attempt: call.attempt, input: call.input, output: call.output, cached: call.cached ?? 0, unreported: call.unreported ?? 0,
      ...(call.sessionId ? { sessionId: call.sessionId } : {}), ...(call.parentSessionId ? { parentSessionId: call.parentSessionId } : {}),
    })
    const key = keyOf(call)
    const current = records.get(key) ?? { repo: call.repo, number: call.number, head: call.head, reviewer: call.reviewer, updatedAt: entry.at, entries: [], totals: { tokens: emptyUsage(), calls: 0, byPurpose: {}, attempts: 0, jobs: [] } }
    const usage = usageOf(entry)
    current.totals.tokens = addUsage(current.totals.tokens, usage)
    current.totals.byPurpose[entry.purpose] = addUsage(current.totals.byPurpose[entry.purpose] ?? emptyUsage(), usage)
    current.totals.calls += 1
    // Attempts are counted per job: a retried job's second attempt is one more, a second job on the same head adds its own.
    const known = current.totals.jobs.find((job) => job.id === entry.jobId)
    const before = known?.attempts ?? 0
    if (entry.attempt > before) current.totals.attempts += entry.attempt - before
    current.totals.jobs = [...current.totals.jobs.filter((job) => job.id !== entry.jobId), { id: entry.jobId, attempts: Math.max(before, entry.attempt) }].slice(-50)
    current.entries.push(entry)
    current.updatedAt = entry.at
    records.delete(key)
    records.set(key, current)
    prune()
    save()
    return totalsOf(current)
  }

  return {
    record,
    /** The PR head's totals; undefined when no call of it is recorded (or it aged out). */
    totals(key: AccountingKey): AccountTotals | undefined {
      const found = records.get(keyOf(key))
      return found ? totalsOf(found) : undefined
    },
    /** The calls kept for a PR head, oldest first (older ones may be trimmed; `totals` still counts them). */
    entries(key: AccountingKey): AccountingEntry[] {
      return (records.get(keyOf(key))?.entries ?? []).map((entry) => ({ ...entry }))
    },
    /** One job's calls summed across its attempts and child sessions, from the entries still kept. */
    job(jobId: string): { tokens: PrTokenUsage; counted: number; calls: number; attempts: number } {
      let tokens = emptyUsage()
      let calls = 0
      let attempts = 0
      for (const record of records.values()) for (const entry of record.entries) if (entry.jobId === jobId) { tokens = addUsage(tokens, usageOf(entry)); calls++; attempts = Math.max(attempts, entry.attempt) }
      return { tokens, counted: countedTokens(tokens), calls, attempts }
    },
    /** Every call of the last 24 hours, for the dashboard's `tokens24h`: summed from the kept entries. */
    last24h(): { tokens: PrTokenUsage; counted: number; calls: number } {
      const since = now() - DAY_MS
      let tokens = emptyUsage()
      let calls = 0
      for (const record of records.values()) for (const entry of record.entries) if (entry.at > since) { tokens = addUsage(tokens, usageOf(entry)); calls++ }
      return { tokens, counted: countedTokens(tokens), calls }
    },
    /** How many PR heads and entries are kept now (for the bounds' tests and the doctor). */
    size: () => ({ records: records.size, entries: [...records.values()].reduce((sum, record) => sum + record.entries.length, 0) }),
  }
}
export type Accounting = ReturnType<typeof createAccounting>
