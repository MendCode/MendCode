import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { accountingFile, createAccounting, MAX_ENTRIES, MAX_RECORDS, RETENTION_MS, type AccountingCall } from "../src/pr-review/accounting"

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
const temp = () => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mc-accounting-"))); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir }

const HOUR = 3_600_000
const KEY = { repo: "acme/api", number: 42, head: "a".repeat(40), reviewer: "global" }
const clock = (start = Date.UTC(2026, 9, 30, 12)) => { const state = { at: start }; return { now: () => state.at, advance: (ms: number) => { state.at += ms } } }
const call = (patch: Partial<AccountingCall> = {}): AccountingCall => ({ ...KEY, jobId: "job_1", purpose: "review", attempt: 1, input: 100_000, output: 5_000, cached: 60_000, ...patch })

describe("accounting", () => {
  test("totals of a PR head sum review, verify children, a resumed attempt and a fix, with cached kept apart from counted", () => {
    const time = clock()
    const accounting = createAccounting({ file: accountingFile(temp()), now: time.now })
    accounting.record(call())
    accounting.record(call({ purpose: "verify", input: 40_000, output: 2_000, cached: 30_000, sessionId: "s_verify", parentSessionId: "s_owner" }))
    // The daemon restarted mid-verify: attempt 2 resumes from the checkpoint.
    accounting.record(call({ purpose: "resume", attempt: 2, input: 20_000, output: 1_000, cached: 0 }))
    const totals = accounting.record(call({ purpose: "fix", attempt: 2, input: 10_000, output: 3_000, cached: 5_000, sessionId: "s_fix" }))
    expect(totals.tokens).toEqual({ input: 170_000, output: 11_000, cached: 95_000, unreported: 0 })
    expect(totals.counted).toBe(170_000 - 95_000 + 11_000)
    expect(totals.calls).toBe(4)
    expect(totals.attempts).toBe(2)
    expect(totals.byPurpose.verify).toEqual({ input: 40_000, output: 2_000, cached: 30_000, unreported: 0 })
    expect(totals.byPurpose.resume).toEqual({ input: 20_000, output: 1_000, cached: 0, unreported: 0 })
    expect(accounting.entries(KEY).find((entry) => entry.purpose === "verify")).toMatchObject({ sessionId: "s_verify", parentSessionId: "s_owner" })
    expect(accounting.job("job_1")).toEqual({ tokens: totals.tokens, counted: totals.counted, calls: 4, attempts: 2 })
  })

  test("a second job on the same head adds its own attempts; another head or reviewer is a separate total", () => {
    const accounting = createAccounting({ file: accountingFile(temp()), now: clock().now })
    accounting.record(call({ attempt: 1 }))
    accounting.record(call({ attempt: 3 }))
    const totals = accounting.record(call({ jobId: "job_2", attempt: 1 }))
    expect(totals.attempts).toBe(4)
    expect(totals.jobs).toEqual([{ id: "job_1", attempts: 3 }, { id: "job_2", attempts: 1 }])
    accounting.record(call({ head: "b".repeat(40) }))
    accounting.record(call({ reviewer: "personal:ana" }))
    expect(accounting.totals(KEY)?.calls).toBe(3)
    expect(accounting.totals({ ...KEY, head: "b".repeat(40) })?.calls).toBe(1)
    expect(accounting.totals({ ...KEY, reviewer: "personal:ana" })?.calls).toBe(1)
    expect(accounting.totals({ ...KEY, number: 7 })).toBeUndefined()
  })

  test("a call with no provider report counts as unreported, not as zero tokens", () => {
    const accounting = createAccounting({ file: accountingFile(temp()), now: clock().now })
    const totals = accounting.record(call({ input: 0, output: 0, cached: 0, unreported: 1 }))
    expect(totals.tokens.unreported).toBe(1)
    expect(totals.calls).toBe(1)
  })

  test("totals survive a restart: a new instance reads the file, written 0600 without temp files left", () => {
    const dir = temp()
    const file = accountingFile(dir)
    const time = clock()
    createAccounting({ file, now: time.now }).record(call())
    const again = createAccounting({ file, now: time.now })
    expect(again.record(call({ attempt: 2, purpose: "resume" })).calls).toBe(2)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readFileSync(file, "utf8")).toContain("\"version\":1")
    expect(readdirSync(path.dirname(file)).filter((name) => name.endsWith(".tmp"))).toEqual([])
  })

  test("last24h sums only the calls of the last 24 hours across every PR head", () => {
    const time = clock()
    const accounting = createAccounting({ file: accountingFile(temp()), now: time.now })
    accounting.record(call({ input: 10, output: 1, cached: 0 }))
    time.advance(20 * HOUR)
    accounting.record(call({ number: 43, input: 20, output: 2, cached: 5 }))
    expect(accounting.last24h()).toEqual({ tokens: { input: 30, output: 3, cached: 5, unreported: 0 }, counted: 28, calls: 2 })
    time.advance(5 * HOUR)
    expect(accounting.last24h()).toEqual({ tokens: { input: 20, output: 2, cached: 5, unreported: 0 }, counted: 17, calls: 1 })
  })

  test("a damaged file loads empty and is set aside, not lost", () => {
    const dir = temp()
    const file = accountingFile(dir)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, "{ not json")
    const accounting = createAccounting({ file, now: clock().now })
    expect(accounting.size()).toEqual({ records: 0, entries: 0 })
    expect(readFileSync(`${file}.damaged`, "utf8")).toBe("{ not json")
    writeFileSync(file, JSON.stringify({ version: 1, records: [{ repo: "x" }] }))
    expect(createAccounting({ file, now: clock().now }).size().records).toBe(0)
  })

  test("a missing file is empty and nothing is written until a call is recorded", () => {
    const file = accountingFile(temp())
    expect(createAccounting({ file, now: clock().now }).last24h().calls).toBe(0)
    expect(existsSync(file)).toBe(false)
  })

  test("bad figures are refused before they reach the totals", () => {
    const accounting = createAccounting({ file: accountingFile(temp()), now: clock().now })
    expect(() => accounting.record(call({ input: -1 }))).toThrow(TypeError)
    expect(() => accounting.record(call({ output: 1.5 }))).toThrow(TypeError)
    expect(() => accounting.record(call({ cached: 200_000, input: 100_000 }))).toThrow(RangeError)
    expect(() => accounting.record(call({ attempt: 0 }))).toThrow(TypeError)
    expect(() => accounting.record(call({ purpose: "chat" as never }))).toThrow(TypeError)
    expect(accounting.size().records).toBe(0)
  })
})

describe("accounting retention", () => {
  test("a PR head untouched for longer than the retention is dropped on the next write", () => {
    const time = clock()
    const accounting = createAccounting({ file: accountingFile(temp()), now: time.now })
    accounting.record(call())
    time.advance(RETENTION_MS + 1)
    accounting.record(call({ number: 99 }))
    expect(accounting.totals(KEY)).toBeUndefined()
    expect(accounting.size().records).toBe(1)
  })

  test("at most MAX_RECORDS heads are kept, the least recently updated dropped first", () => {
    const time = clock()
    const accounting = createAccounting({ file: accountingFile(temp()), now: time.now })
    for (let number = 1; number <= MAX_RECORDS + 5; number++) { accounting.record(call({ number, input: 1, output: 1, cached: 0 })); time.advance(1) }
    expect(accounting.size().records).toBe(MAX_RECORDS)
    expect(accounting.totals({ ...KEY, number: 1 })).toBeUndefined()
    expect(accounting.totals({ ...KEY, number: MAX_RECORDS + 5 })?.calls).toBe(1)
  })

  test("past MAX_ENTRIES the oldest entries are trimmed while the head's totals keep every call", () => {
    const time = clock()
    const accounting = createAccounting({ file: accountingFile(temp()), now: time.now })
    for (let index = 0; index < MAX_ENTRIES + 10; index++) { accounting.record(call({ input: 2, output: 1, cached: 1 })); time.advance(1) }
    expect(accounting.size().entries).toBe(MAX_ENTRIES)
    expect(accounting.totals(KEY)).toMatchObject({ calls: MAX_ENTRIES + 10, counted: (MAX_ENTRIES + 10) * 2 })
  }, 30_000)
})
