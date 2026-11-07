import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory, type ExtractionJob } from "@mendcode/protocol"
import { openStore } from "@mendcode/store"
import { createMemoryExtraction, type ExtractedMemory } from "../src/memory-extraction"

const ids = createIdFactory()
const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
async function until(predicate: () => boolean) {
  for (let count = 0; count < 300; count++) { if (predicate()) return; await Bun.sleep(2) }
  throw new Error("worker did not settle")
}
type Timers = Array<{ ms: number; run: () => void; cancelled: boolean }>
function fixture(extract?: (job: ExtractionJob, signal: AbortSignal) => Promise<ExtractedMemory[]>, extra: Partial<Parameters<typeof createMemoryExtraction>[0]> = {}, settings: Record<string, unknown> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "memory-extraction-"))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const store = openStore({ dir })
  cleanup.push(() => store.close())
  const sessionId = ids("session")
  store.createSession({ id: sessionId, directory: "/project", title: "Extraction" })
  const proposals: ExtractedMemory[] = []
  store.settings.set({ memoryGenerate: true, memoryReviewEveryTurns: 2, ...settings })
  const timers: Timers = []
  const worker = createMemoryExtraction({ store, settings: () => store.settings.get(), now: Date.now, extract, retryMs: 1, timeoutMs: 20, eligibleDirectory: () => true, setTimer: (ms, run) => { const timer = { ms, run, cancelled: false }; timers.push(timer); return { cancel: () => { timer.cancelled = true } } }, commit: (_job, memories) => { proposals.push(...memories); return memories.length }, ...extra })
  cleanup.push(() => worker.stop())
  const turn = (text = "Always use pnpm for this repository") => {
    const turnId = ids("turn")
    const itemId = ids("item")
    store.sessionSink.append({ type: "turn.started", sessionId, turnId, queueId: ids("queue") })
    store.sessionSink.append({ type: "item.started", sessionId, turnId, itemId, kind: "user_message" })
    store.sessionSink.append({ type: "item.completed", sessionId, itemId, status: "ok", text })
    const event = store.sessionSink.append({ type: "turn.completed", sessionId, turnId })
    worker.observe(event)
    return event
  }
  const live = () => timers.filter((timer) => !timer.cancelled)
  const compaction = () => worker.observe(store.sessionSink.append({ type: "compaction.updated", sessionId, turnId: ids("turn"), reason: "auto", state: "writing", followUp: "" }))
  return { dir, store, sessionId, proposals, worker, turn, timers, live, compaction }
}

test("completed turns enqueue once; worker persists attempts and proposals without tool or secret output", async () => {
  const h = fixture(async (job) => {
    expect(job.text).toContain("Always use pnpm")
    expect(job.text).not.toContain("sk_live_")
    return [{ scope: "project", category: "commands", text: "Use pnpm" }]
  })
  h.turn()
  const event = h.turn("Never use npm here")
  h.worker.observe(event)
  await until(() => h.proposals.length === 1 && h.store.extraction.list().length === 0)
  expect(h.proposals).toHaveLength(1)
  expect(h.store.extraction.list()).toEqual([])
  expect(h.worker.status().lastRun).toBe("completed")
})

test("use and generation are independent; disabling generation or memory prevents enqueue", async () => {
  const h = fixture(async () => [])
  h.store.settings.set({ memoryUse: false })
  h.turn()
  h.turn()
  await until(() => h.worker.status().lastRun === "completed")
  h.store.settings.set({ memoryGenerate: false })
  h.turn()
  h.turn()
  h.turn()
  h.store.settings.set({ memoryEnabled: false, memoryGenerate: true })
  h.turn()
  h.turn()
  expect(h.store.extraction.list()).toHaveLength(0)
})

test("unconfigured extractor leaves a durable queued job with an explicit reason", async () => {
  const h = fixture()
  h.turn()
  h.turn()
  expect(h.worker.configured).toBe(false)
  expect(h.store.extraction.list()[0]).toMatchObject({ state: "queued", attempts: 0, reason: "Extractor not configured" })
})

test("errors retry twice then fail; explicit retry starts a new bounded attempt series", async () => {
  let fail = true
  const h = fixture(async () => { if (fail) throw new Error("bad extraction"); return [] })
  h.turn()
  h.turn()
  await until(() => h.store.extraction.list()[0]?.state === "failed")
  const job = h.store.extraction.list()[0]!
  expect(job.attempts).toBe(3)
  fail = false
  h.worker.retry(job.jobId)
  await until(() => h.store.extraction.list().length === 0)
  expect(() => h.worker.retry(job.jobId)).toThrow("Only failed")
})

test("worker times out an extractor that ignores abort, without accepting late results", async () => {
  let finish!: (value: ExtractedMemory[]) => void
  const h = fixture(() => new Promise((resolve) => { finish = resolve }))
  h.turn()
  h.turn()
  await until(() => h.store.extraction.list()[0]?.state === "failed")
  finish([{ scope: "project", category: "commands", text: "late" }])
  await Bun.sleep(3)
  expect(h.proposals).toEqual([])
  expect(h.store.extraction.list()[0]!.attempts).toBe(3)
})

test("shutdown pauses a live extraction and a new worker recovers the durable job", async () => {
  const h = fixture(() => new Promise(() => {}))
  h.turn()
  h.turn()
  await until(() => h.store.extraction.list()[0]?.state === "running")
  await h.worker.stop()
  expect(h.store.extraction.list()[0]).toMatchObject({ state: "queued", attempts: 0, reason: "Paused for shutdown" })
  const next = createMemoryExtraction({ store: h.store, settings: () => h.store.settings.get(), now: Date.now, eligibleDirectory: () => true, extract: async () => [], commit: () => 0 })
  cleanup.push(() => next.stop())
  next.wake()
  await until(() => h.store.extraction.list().length === 0)
})

test("settlement is transactional; failed writes roll back both proposals and completion", () => {
  const h = fixture()
  h.turn()
  h.turn()
  const job = h.store.extraction.list()[0]!
  expect(() => h.store.extraction.settle(job, () => {
    h.store.memories.add({ memoryId: ids("memory"), scope: "project", directory: "/project", text: "Should roll back", category: "commands", status: "pending", source: "agent" })
    throw new Error("commit failed")
  })).toThrow("commit failed")
  expect(h.store.memories.list({ directory: "/project" })).toEqual([])
  expect(h.store.extraction.list()[0]!.state).toBe("queued")
})

test("disabling generation while an extraction is in flight skips the result", async () => {
  let finish!: (value: ExtractedMemory[]) => void
  const h = fixture(() => new Promise((resolve) => { finish = resolve }))
  h.turn()
  h.turn()
  await until(() => h.store.extraction.list()[0]?.state === "running")
  h.store.settings.set({ memoryGenerate: false })
  finish([{ scope: "user", category: "preferences", text: "Discard me" }])
  await until(() => h.store.extraction.list()[0]?.state === "skipped")
  expect(h.proposals).toEqual([])
})

test("memory/model graph calls still count as substantive turns; the commit deduplicates written facts", () => {
  const h = fixture()
  for (const tool of ["memory", "memory_graph"]) {
    const turnId = ids("turn")
    const itemId = ids("item")
    h.store.sessionSink.append({ type: "turn.started", sessionId: h.sessionId, turnId, queueId: ids("queue") })
    h.store.sessionSink.append({ type: "item.started", sessionId: h.sessionId, turnId, itemId, kind: "user_message" })
    h.store.sessionSink.append({ type: "item.completed", sessionId: h.sessionId, itemId, status: "ok", text: "Remember this rule" })
    h.store.sessionSink.append({ type: "item.started", sessionId: h.sessionId, turnId, itemId: ids("item"), kind: "tool_call", meta: { tool } })
    h.worker.observe(h.store.sessionSink.append({ type: "turn.completed", sessionId: h.sessionId, turnId }))
  }
  expect(h.store.extraction.list()).toHaveLength(1)
})

test("a hundred turns of one session queue one job, not a hundred", () => {
  const h = fixture(undefined, {}, { memoryReviewEveryTurns: 10 })
  for (let index = 0; index < 100; index++) h.turn(`Rule ${index}`)
  expect(h.worker.list()).toHaveLength(1)
  expect(h.worker.status()).toMatchObject({ queue: 1, lastRun: "never", lastError: "Extractor not configured" })
})

test("a greeting with no tool call counts for nothing; real preferences still make a review", async () => {
  const h = fixture(async () => [])
  h.turn("hi")
  h.turn("thanks")
  h.turn("Always use pnpm for this repository")
  expect(h.store.extraction.list()).toEqual([])
  h.turn("Never commit to main")
  await until(() => h.store.extraction.list().length === 0 && h.worker.status("/project").lastRun === "completed")
  expect(h.worker.status("/project").lastRun).toBe("completed")
})

test("a digest cut through a surrogate pair is sent well formed", async () => {
  const { wellFormed } = await import("../src/well-formed")
  expect(wellFormed("ok \uD83D")).toBe("ok �")
  expect(wellFormed("\uDE00 ok")).toBe("� ok")
  expect(wellFormed("fine 😀")).toBe("fine 😀")
  const { isTrivialTurn } = await import("../src/memory-extraction")
  expect(isTrivialTurn([])).toBe(false)
})

test("only greetings and acknowledgements without a tool call are trivial; a short rule is not", async () => {
  const { isTrivialTurn } = await import("../src/memory-extraction")
  const events = (text: string, ...extra: string[]) => [
    { type: "item.started", itemId: "u", kind: "user_message" },
    { type: "item.completed", itemId: "u", text },
    ...extra.map((kind, index) => ({ type: "item.started", itemId: `x${index}`, kind })),
  ] as never
  expect(isTrivialTurn(events("Thanks!"))).toBe(true)
  expect(isTrivialTurn(events("ok"))).toBe(true)
  expect(isTrivialTurn(events("use bun"))).toBe(false)
  expect(isTrivialTurn(events("remember: Use pnpm"))).toBe(false)
  expect(isTrivialTurn(events("ok", "tool_call"))).toBe(false)
})

test("a review fires every N substantive turns and its digest covers only the turns since the last one", async () => {
  const seen: string[] = []
  const h = fixture(async (job) => { seen.push(job.text); return [] }, {}, { memoryReviewEveryTurns: 3 })
  h.turn("Rule one is alpha"); h.turn("Rule two is beta")
  expect(h.store.extraction.list()).toEqual([])
  h.turn("Rule three is gamma")
  await until(() => seen.length === 1)
  await until(() => h.store.extraction.list().length === 0)
  h.turn("Rule four is delta"); h.turn("Rule five is epsilon"); h.turn("Rule six is zeta")
  await until(() => seen.length === 2)
  expect(seen[0]).toContain("alpha")
  expect(seen[0]).toContain("gamma")
  expect(seen[1]).toContain("delta")
  expect(seen[1]).not.toContain("alpha")
  expect(h.store.memoryReviews.list().map((row) => [row.trigger, row.turns, row.outcome])).toEqual([["turns", 3, "ran"], ["turns", 3, "ran"]])
})

test("an idle session is reviewed once after the idle time, only with at least two unreviewed turns", async () => {
  const seen: string[] = []
  const h = fixture(async (job) => { seen.push(job.text); return [{ scope: "project", category: "commands", text: "Use pnpm" }] }, {}, { memoryReviewEveryTurns: 10, memoryReviewIdleMinutes: 5 })
  h.turn("Use pnpm in this repository")
  expect(h.live()).toHaveLength(0)
  h.turn("Never use npm")
  expect(h.live()).toHaveLength(1)
  expect(h.live()[0]!.ms).toBe(5 * 60_000)
  h.turn("Prefer small commits")
  expect(h.timers.filter((timer) => timer.cancelled)).toHaveLength(1)
  h.live()[0]!.run()
  await until(() => seen.length === 1)
  await until(() => h.store.extraction.list().length === 0)
  expect(seen[0]).toContain("small commits")
  expect(h.store.memoryReviews.list()[0]).toMatchObject({ trigger: "idle", turns: 3, proposed: 1, calls: 1, outcome: "ran" })
  expect(h.timers).toHaveLength(2)
})

test("a compaction reviews what was said before it; one unreviewed turn sends and records nothing", async () => {
  const seen: string[] = []
  const h = fixture(async (job) => { seen.push(job.text); return [] }, {}, { memoryReviewEveryTurns: 10 })
  h.turn("Only one real turn")
  h.compaction()
  expect(h.store.extraction.list()).toEqual([])
  expect(h.store.memoryReviews.list()).toEqual([])
  h.turn("A second real turn")
  h.compaction()
  await until(() => seen.length === 1)
  await until(() => h.store.memoryReviews.list().some((row) => row.outcome === "ran"))
  expect(h.store.memoryReviews.list()[0]).toMatchObject({ trigger: "compaction", turns: 2, outcome: "ran" })
  // Nothing new since that review: another compaction neither reviews nor records.
  h.compaction()
  expect(h.store.memoryReviews.list()).toHaveLength(1)
})

test("a newer snapshot replaces a waiting review and covers its turns; a request during a run is made again after it", async () => {
  let release!: () => void
  const seen: string[] = []
  const h = fixture(async (job) => { seen.push(job.text); if (seen.length === 1) await new Promise<void>((resolve) => { release = resolve }); return [] }, { timeoutMs: 5_000 }, { memoryReviewEveryTurns: 2 })
  h.turn("First batch alpha"); h.turn("First batch beta")
  await until(() => h.store.extraction.list()[0]?.state === "running")
  h.turn("Second batch gamma"); h.turn("Second batch delta")
  expect(h.store.extraction.list()).toHaveLength(1)
  release()
  await until(() => seen.length === 2)
  expect(seen[1]).toContain("gamma")
  expect(seen[1]).not.toContain("alpha")
  await until(() => h.store.extraction.list().length === 0)
  expect(h.store.memoryReviews.list().filter((row) => row.outcome === "ran")).toHaveLength(2)
})

test("a waiting review is replaced by the newest snapshot, which also covers the older turns", () => {
  const h = fixture(undefined, {}, { memoryReviewEveryTurns: 2 })
  h.turn("Alpha rule"); h.turn("Beta rule")
  const first = h.store.extraction.list()
  expect(first).toHaveLength(1)
  h.turn("Gamma rule"); h.turn("Delta rule")
  const jobs = h.store.extraction.list()
  expect(jobs).toHaveLength(1)
  expect(jobs[0]!.jobId).not.toBe(first[0]!.jobId)
  expect(jobs[0]!.text).toContain("Alpha")
  expect(jobs[0]!.text).toContain("Delta")
})

test("ineligible sessions are never reviewed and are counted once with the reason, in memory and not on disk", () => {
  const h = fixture(undefined, { eligibleDirectory: () => false })
  h.turn(); h.turn(); h.turn()
  expect(h.store.extraction.list()).toEqual([])
  expect(h.live()).toHaveLength(0)
  expect(h.store.memoryReviews.list()).toEqual([])
  expect(h.worker.ineligible()).toEqual({ "ineligible: temporary, missing or linked-worktree folder": 1 })
})

test("the real folder filter refuses temp folders, missing folders and linked worktrees; a plain project passes", () => {
  const root = mkdtempSync(path.join(process.cwd(), ".review-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  // A full checkout of its own, so the verdicts do not depend on whether the suite runs in a linked worktree.
  mkdirSync(path.join(root, ".git"))
  const plain = path.join(root, "plain"); mkdirSync(plain)
  const linked = path.join(root, "linked"); mkdirSync(linked); writeFileSync(path.join(linked, ".git"), "gitdir: elsewhere")
  const linkedSub = path.join(linked, "packages", "web"); mkdirSync(linkedSub, { recursive: true })
  const verdicts: Record<string, string | undefined> = {}
  for (const [name, directory] of [["plain", plain], ["linked", linked], ["linkedSub", linkedSub], ["missing", path.join(root, "gone")], ["temp", mkdtempSync(path.join(tmpdir(), "review-"))]] as const) {
    const dir = mkdtempSync(path.join(tmpdir(), "memory-extraction-"))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const store = openStore({ dir })
    cleanup.push(() => store.close())
    const sessionId = ids("session")
    store.createSession({ id: sessionId, directory, title: "Work" })
    store.settings.set({ memoryGenerate: true, memoryReviewEveryTurns: 2 })
    const worker = createMemoryExtraction({ store, settings: () => store.settings.get(), now: Date.now, commit: () => 0 })
    for (const text of ["Use bun here", "Never use npm"]) {
      const turnId = ids("turn"), itemId = ids("item")
      store.sessionSink.append({ type: "turn.started", sessionId, turnId, queueId: ids("queue") })
      store.sessionSink.append({ type: "item.started", sessionId, turnId, itemId, kind: "user_message" })
      store.sessionSink.append({ type: "item.completed", sessionId, itemId, status: "ok", text })
      worker.observe(store.sessionSink.append({ type: "turn.completed", sessionId, turnId }))
    }
    verdicts[name] = store.extraction.list().length ? "reviewed" : Object.keys(worker.ineligible())[0]
    cleanup.push(() => worker.stop())
  }
  expect(verdicts).toEqual({ plain: "reviewed", linked: "ineligible: temporary, missing or linked-worktree folder", linkedSub: "ineligible: temporary, missing or linked-worktree folder", missing: "ineligible: temporary, missing or linked-worktree folder", temp: "ineligible: temporary, missing or linked-worktree folder" })
})

test("child sessions, loop and review sessions and scripted runs are skipped", () => {
  const scripted = new Set<string>()
  const h = fixture(undefined, { ineligible: (id) => scripted.has(id) ? "scripted run" : undefined })
  scripted.add(h.sessionId)
  h.turn(); h.turn()
  expect(Object.keys(h.worker.ineligible())).toEqual(["ineligible: scripted run"])
  const make = (title: string, parentId?: typeof h.sessionId) => {
    const id = ids("session")
    h.store.createSession({ id, directory: "/project", title, ...(parentId ? { parentId } : {}) })
    return id
  }
  const loop = make("loop · nightly")
  const child = make("Sub work", h.sessionId)
  for (const sessionId of [loop, child]) for (const text of ["One rule here", "Another rule here"]) {
    const turnId = ids("turn"), itemId = ids("item")
    h.store.sessionSink.append({ type: "turn.started", sessionId, turnId, queueId: ids("queue") })
    h.store.sessionSink.append({ type: "item.started", sessionId, turnId, itemId, kind: "user_message" })
    h.store.sessionSink.append({ type: "item.completed", sessionId, itemId, status: "ok", text })
    h.worker.observe(h.store.sessionSink.append({ type: "turn.completed", sessionId, turnId }))
  }
  expect(h.store.extraction.list()).toEqual([])
  expect(Object.keys(h.worker.ineligible()).sort()).toEqual(["ineligible: child session", "ineligible: loop, workflow or review session", "ineligible: scripted run"])
  expect(h.store.memoryReviews.list()).toEqual([])
})

test("the daily cap stops extractor calls, records the skip, and a cap of 0 stops them all", async () => {
  let calls = 0
  const h = fixture(async () => { calls++; return [] }, {}, { memoryReviewDailyCap: 2 })
  for (let batch = 0; batch < 3; batch++) {
    h.turn(`Batch ${batch} rule one`); h.turn(`Batch ${batch} rule two`)
    await until(() => h.store.extraction.list().every((job) => job.state !== "queued" && job.state !== "running"))
  }
  expect(calls).toBe(2)
  expect(h.store.memoryReviews.list().map((row) => `${row.outcome}:${row.reason}`)).toEqual(["skipped:daily cap", "ran:", "ran:"])
  expect(h.store.extraction.list()[0]).toMatchObject({ state: "skipped", reason: "Daily review cap reached" })
  h.store.settings.set({ memoryReviewDailyCap: 0 })
  h.turn("Cap zero rule one"); h.turn("Cap zero rule two")
  await until(() => h.store.extraction.list().every((job) => job.state !== "queued" && job.state !== "running"))
  expect(calls).toBe(2)
  // One cap row a day: further skips are not written, so they can never push the counted calls out of the kept log.
  expect(h.store.memoryReviews.list()).toHaveLength(3)
})

test("the daily cap counts every folder's reviews and survives a restart: a new worker on the same store still refuses", async () => {
  let calls = 0
  const extract = async () => { calls++; return [] }
  const h = fixture(extract, {}, { memoryReviewDailyCap: 2 })
  h.turn("First rule here"); h.turn("Second rule here")
  await until(() => calls === 1)
  // Another project's session spends the second call of the same day.
  const other = ids("session")
  h.store.createSession({ id: other, directory: "/other-project", title: "Other work" })
  const drive = (worker: { observe(event: never): void }, sessionId: typeof other, text: string) => {
    const turnId = ids("turn"), itemId = ids("item")
    h.store.sessionSink.append({ type: "turn.started", sessionId, turnId, queueId: ids("queue") })
    h.store.sessionSink.append({ type: "item.started", sessionId, turnId, itemId, kind: "user_message" })
    h.store.sessionSink.append({ type: "item.completed", sessionId, itemId, status: "ok", text })
    worker.observe(h.store.sessionSink.append({ type: "turn.completed", sessionId, turnId }) as never)
  }
  drive(h.worker, other, "Other rule one"); drive(h.worker, other, "Other rule two")
  await until(() => calls === 2)
  await until(() => h.store.extraction.list().every((job) => job.state !== "queued" && job.state !== "running"))
  // The daemon restarts: a fresh worker on the same database, no memory of what ran.
  await h.worker.stop()
  const restarted = createMemoryExtraction({ store: h.store, settings: () => h.store.settings.get(), now: Date.now, extract, retryMs: 1, timeoutMs: 20, eligibleDirectory: () => true, commit: () => 0 })
  cleanup.push(() => restarted.stop())
  drive(restarted, other, "After restart one"); drive(restarted, other, "After restart two")
  await until(() => h.store.extraction.list().every((job) => job.state !== "queued" && job.state !== "running"))
  expect(calls).toBe(2)
  expect(h.store.memoryReviews.callsSince(Date.now() - 86_400_000)).toBe(2)
  expect(h.store.memoryReviews.list()[0]).toMatchObject({ outcome: "skipped", reason: "daily cap" })
})

test("the review record stays bounded", () => {
  const h = fixture()
  const hour = 3_600_000
  for (let index = 0; index < 340; index++) h.store.memoryReviews.add({ at: index * hour, sessionId: h.sessionId, directory: "/project", trigger: "idle", turns: 2, calls: 1, proposed: 0, outcome: "ran", reason: "" })
  expect(h.store.memoryReviews.list(1000)).toHaveLength(300)
  expect(h.store.memoryReviews.list(1)[0]!.at).toBe(339 * hour)
  expect(h.store.memoryReviews.callsSince(335 * hour)).toBe(5)
})

test("a daily cap above the kept record still counts every call of the day: 500 reviews in a day stop at 500", () => {
  const h = fixture()
  const start = Date.now()
  for (let index = 0; index < 500; index++) h.store.memoryReviews.add({ at: start + index, sessionId: h.sessionId, directory: "/project", trigger: "idle", turns: 2, calls: 1, proposed: 0, outcome: "ran", reason: "" })
  expect(h.store.memoryReviews.callsSince(start)).toBe(500)
  // Skips without calls are still pruned to the kept count, and a day later the old calls go too.
  for (let index = 0; index < 400; index++) h.store.memoryReviews.add({ at: start + 1_000 + index, sessionId: h.sessionId, directory: "/project", trigger: "idle", turns: 2, calls: 0, proposed: 0, outcome: "skipped", reason: "empty digest" })
  expect(h.store.memoryReviews.callsSince(start)).toBe(500)
  expect(h.store.memoryReviews.list(10_000)).toHaveLength(800)
  h.store.memoryReviews.add({ at: start + 86_400_000 + 1_000, sessionId: h.sessionId, directory: "/project", trigger: "idle", turns: 2, calls: 1, proposed: 0, outcome: "ran", reason: "" })
  expect(h.store.memoryReviews.list(10_000)).toHaveLength(300)
})

test("retries count against the daily cap: a failing review under a cap of 1 makes one call and records it", async () => {
  let calls = 0
  const h = fixture(async () => { calls++; throw new Error("provider down") }, {}, { memoryReviewDailyCap: 1 })
  h.turn("First rule here"); h.turn("Second rule here")
  await until(() => h.store.extraction.list().every((job) => job.state !== "queued" && job.state !== "running"))
  expect(calls).toBe(1)
  expect(h.store.extraction.list()[0]).toMatchObject({ state: "skipped", reason: "Daily review cap reached", attempts: 1 })
  expect(h.store.memoryReviews.callsSince(Date.now() - 86_400_000)).toBe(1)
})

test("review progress survives a restart: unreviewed turns are not forgotten and reviewed ones are not sent again", async () => {
  const texts: string[] = []
  const extract = async (job: ExtractionJob) => { texts.push(job.text); return [] }
  const h = fixture(extract, {}, { memoryReviewEveryTurns: 3 })
  const drive = (worker: { observe(event: never): void }, text: string) => {
    const turnId = ids("turn"), itemId = ids("item")
    h.store.sessionSink.append({ type: "turn.started", sessionId: h.sessionId, turnId, queueId: ids("queue") })
    h.store.sessionSink.append({ type: "item.started", sessionId: h.sessionId, turnId, itemId, kind: "user_message" })
    h.store.sessionSink.append({ type: "item.completed", sessionId: h.sessionId, itemId, status: "ok", text })
    worker.observe(h.store.sessionSink.append({ type: "turn.completed", sessionId: h.sessionId, turnId }) as never)
  }
  const restart = async (previous: { stop(): Promise<void> }) => {
    await previous.stop()
    const worker = createMemoryExtraction({ store: h.store, settings: () => h.store.settings.get(), now: Date.now, extract, retryMs: 1, timeoutMs: 20, eligibleDirectory: () => true, setTimer: () => ({ cancel() {} }), commit: () => 0 })
    cleanup.push(() => worker.stop())
    return worker
  }
  h.turn("Rule one before the restart"); h.turn("Rule two before the restart")
  expect(texts).toHaveLength(0)
  // One small row for the session, nothing per turn.
  expect(h.store.meta.list("memory.review:")).toHaveLength(1)
  expect(h.store.meta.list("memory.review:")[0]!.value.length).toBeLessThan(160)
  let worker = await restart(h.worker)
  drive(worker, "Rule three after the restart")
  await until(() => texts.length === 1 && h.store.extraction.list().length === 0)
  expect(texts[0]).toContain("Rule one before the restart")
  expect(texts[0]).toContain("Rule three after the restart")
  // Reviewed: the row is gone, and the next restart starts from the new turns only.
  expect(h.store.meta.list("memory.review:")).toHaveLength(0)
  worker = await restart(worker)
  drive(worker, "Rule four"); drive(worker, "Rule five")
  worker = await restart(worker)
  drive(worker, "Rule six")
  await until(() => texts.length === 2 && h.store.extraction.list().length === 0)
  expect(texts[1]).toContain("Rule four")
  expect(texts[1]).toContain("Rule six")
  expect(texts[1]).not.toContain("Rule three")
})

test("progress rows of sessions that went quiet long ago are dropped on the first use after a restart", () => {
  const h = fixture()
  const old = ids("session")
  h.store.meta.set(`memory.review:${old}`, JSON.stringify({ p: 1, f: 0, qf: null, qt: 0, s: 3, t: "turn_x", at: Date.now() - 30 * 86_400_000 }))
  h.turn("Fresh rule")
  expect(h.store.meta.get(`memory.review:${old}`)).toBeUndefined()
  expect(h.store.meta.list("memory.review:")).toHaveLength(1)
})

test("a PR review session (the run limits the reviewer gives it) is never reviewed for memory, and says why", async () => {
  const { createRunLimitsStore, reviewIneligible } = await import("../src/run-limits")
  const limits = createRunLimitsStore()
  let calls = 0
  // The daemon's own wiring: run limits decide, as for a review child created by the PR reviewer.
  const h = fixture(async () => { calls++; return [] }, { ineligible: (id) => reviewIneligible(limits, id as never) })
  limits.configure(h.sessionId, { noMemory: true, noContextFiles: true, untrustedCheckout: true })
  h.turn("Always check the null path"); h.turn("Never log the token")
  expect(h.store.extraction.list()).toEqual([])
  expect(h.worker.ineligible()).toEqual({ "ineligible: PR review or no-memory run": 1 })
  expect(h.store.meta.list("memory.review:")).toEqual([])
  expect(calls).toBe(0)
  // A session without limits is still reviewed.
  expect(reviewIneligible(limits, ids("session") as never)).toBeUndefined()
})
