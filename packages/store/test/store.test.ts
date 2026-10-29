import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory, MAX_INLINE_TEXT, type SessionId } from "@mendcode/protocol"
import { createResourceRegistry, createScope, createSessionActor, createVirtualClock, type EnginePort } from "@mendcode/kernel"
import { checkSessionLog } from "@mendcode/testkit"
import { openStore } from "../src"
import { budgetMs } from "../../../scripts/test-budget"

const dirs: string[] = []
function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-store-"))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const ids = createIdFactory()
const DAY = 86_400_000
const T0 = Date.UTC(2026, 0, 1, 12)

function usage(sessionId: SessionId, turnId = ids("turn"), costMicros?: number) {
  return {
    type: "usage.recorded" as const,
    sessionId,
    turnId,
    provider: "anthropic",
    model: "sonnet",
    input: 100,
    output: 10,
    reasoning: 5,
    cacheRead: 50,
    cacheWrite: 0,
    ...(costMicros === undefined ? {} : { costMicros }),
  }
}

describe("event log", () => {
  test("read-only plan permission survives closing and reopening the store", () => {
    const dir = tempDir()
    const store = openStore({ dir })
    const sessionId = ids("session")
    store.createSession({ id: sessionId, directory: "/repo", title: "Planning only" })
    store.sessionSink.append({ type: "session.permission", sessionId, mode: "plan" })
    expect(store.permissionModeOf(sessionId)).toBe("plan")
    store.close()
    const reopened = openStore({ dir })
    expect(reopened.permissionModeOf(sessionId)).toBe("plan")
    reopened.close()
  })

  test("appends get contiguous seq and replay after a cursor is exact (I4)", () => {
    const store = openStore({ dir: tempDir() })
    const sessionId = ids("session")
    store.createSession({ id: sessionId, directory: "/repo", title: "t" })
    const turnId = ids("turn")
    for (let i = 0; i < 20; i++) store.sessionSink.append({ type: "turn.completed", sessionId, turnId })
    expect(store.lastSeq(sessionId)).toBe(21)
    const after = store.readAfter(sessionId, 15)
    expect(after.map((e) => e.seq)).toEqual([16, 17, 18, 19, 20, 21])
    store.close()
  })

  test("the persisted queue keeps each entry's kind (message, notice, shell) for a restart", () => {
    const dir = tempDir()
    const store = openStore({ dir })
    const sessionId = ids("session")
    store.createSession({ id: sessionId, directory: "/repo", title: "t" })
    const [a, b, c, d] = [ids("queue"), ids("queue"), ids("queue"), ids("queue")]
    store.sessionSink.append({ type: "queue.added", sessionId, queueId: a, text: "hola", attachments: [] })
    store.sessionSink.append({ type: "queue.added", sessionId, queueId: b, text: "git status", attachments: [], shell: true })
    store.sessionSink.append({ type: "queue.added", sessionId, queueId: c, text: "task done", attachments: [], notice: true })
    store.sessionSink.append({ type: "queue.added", sessionId, queueId: d, text: "cat notes", attachments: [], shell: true, local: true })
    store.close()
    const reopened = openStore({ dir })
    expect(reopened.queueOf(sessionId)).toEqual([
      { queueId: a, text: "hola", attachments: [] },
      { queueId: b, text: "git status", attachments: [], shell: true },
      { queueId: c, text: "task done", attachments: [], notice: true },
      { queueId: d, text: "cat notes", attachments: [], shell: true, local: true },
    ])
    reopened.close()
  })

  test("R7 a queued compaction keeps its instructions and model, and a queued prompt its message id, for a restart", () => {
    const dir = tempDir()
    const store = openStore({ dir })
    const sessionId = ids("session")
    store.createSession({ id: sessionId, directory: "/repo", title: "t" })
    const [a, b] = [ids("queue"), ids("queue")]
    const messageId = ids("item")
    store.sessionSink.append({ type: "queue.added", sessionId, queueId: a, text: "", attachments: [], compact: true, instructions: "keep names", selection: { model: { model: "m2" } } })
    const turnOptions = { noReply: true as const, excludeTools: ["shell"], format: { schema: { type: "object" } } }
    store.sessionSink.append({ type: "queue.added", sessionId, queueId: b, text: "later", attachments: [], messageId, turnOptions })
    store.close()
    const reopened = openStore({ dir })
    expect(reopened.queueOf(sessionId)).toEqual([
      { queueId: a, text: "", attachments: [], compact: true, instructions: "keep names", selection: { model: { model: "m2" } } },
      { queueId: b, text: "later", attachments: [], messageId, turnOptions },
    ])
    reopened.close()
  })

  test("events for unknown sessions and invalid events are rejected without writing", () => {
    const store = openStore({ dir: tempDir() })
    const sessionId = ids("session")
    expect(() => store.sessionSink.append({ type: "turn.completed", sessionId, turnId: ids("turn") })).toThrow(RangeError)
    store.createSession({ id: sessionId, directory: "/repo", title: "t" })
    expect(() => store.sessionSink.append({ type: "item.delta", sessionId, itemId: ids("item"), text: "x".repeat(MAX_INLINE_TEXT + 1) })).toThrow()
    expect(store.lastSeq(sessionId)).toBe(1)
    store.close()
  })

  test("state survives a restart and replay reproduces the actor's log", async () => {
    const dir = tempDir()
    const store = openStore({ dir })
    const clock = createVirtualClock(T0)
    const registry = createResourceRegistry()
    const root = createScope({ name: "r", clock, registry })
    const engine: EnginePort = {
      async runTurn(input) {
        const itemId = input.newItemId()
        input.emit({ type: "item.started", itemId, kind: "agent_message" })
        input.emit({ type: "item.delta", itemId, text: "hola" })
        input.emit({ type: "item.completed", itemId, status: "ok", text: "hola" })
        return { status: "ok" }
      },
      needsCompaction: () => false,
      compact: async () => ({ status: "ok" }),
    }
    const sessionId = ids("session")
    store.createSession({ id: sessionId, directory: "/repo", title: "t" })
    const actor = createSessionActor({ sessionId, clock, scope: root, engine, sink: store.sessionSink, ids })
    const clientId = ids("client")
    await actor.handle({ id: ids("command"), clientId, type: "user.submit", sessionId, text: "uno", attachments: [] })
    await actor.handle({ id: ids("command"), clientId, type: "user.submit", sessionId, text: "dos", attachments: [] })
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
    const live = store.readAfter(sessionId, 0)
    root.dispose()
    store.close()
    const reopened = openStore({ dir })
    const replayed = reopened.readAfter(sessionId, 0)
    expect(replayed).toEqual(live)
    expect(checkSessionLog(replayed, { final: true })).toEqual([])
    expect(replayed.filter((e) => e.type === "turn.completed").length).toBe(2)
    reopened.close()
  })
})

describe("activity projection", () => {
  const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10)
  const RANGE = { from: "2026-01-01", to: "2026-12-31" }

  function open() {
    let clock = T0
    const store = openStore({ dir: tempDir(), now: () => clock, dayOf })
    const sessionId = ids("session")
    store.createSession({ id: sessionId, directory: "/repo", title: "" })
    return { store, sessionId, at: (value: number) => void (clock = value) }
  }

  const queued = (sessionId: SessionId, text: string) => ({ type: "queue.added" as const, sessionId, queueId: ids("queue"), text, attachments: [] })

  test("response peaks are maxima per completion day, survive reopen and omit days without responses", () => {
    const dir = tempDir()
    let clock = T0
    const store = openStore({ dir, now: () => clock, dayOf })
    const sessionId = ids("session")
    store.createSession({ id: sessionId, directory: "/repo", title: "" })
    const run = (duration: number, day: number) => {
      const itemId = ids("item")
      clock = T0 + day * DAY
      store.sessionSink.append({ type: "item.started", sessionId, turnId: ids("turn"), itemId, kind: "agent_message" })
      clock += duration
      store.sessionSink.append({ type: "item.completed", sessionId, itemId, status: "ok" })
    }
    run(9000, 0)
    run(1000, 0)
    run(4000, 1)
    clock = T0 + 2 * DAY
    store.sessionSink.append(queued(sessionId, "Prompt only"))
    store.close()
    const reopened = openStore({ dir, now: () => clock, dayOf })
    expect(reopened.usageActivity(RANGE)).toEqual([
      { day: "2026-01-01", prompts: 0, words: 0, aiMs: 10_000, toolMs: 0, longestAiMs: 9000 },
      { day: "2026-01-02", prompts: 0, words: 0, aiMs: 4000, toolMs: 0, longestAiMs: 4000 },
      { day: "2026-01-03", prompts: 1, words: 2, aiMs: 0, toolMs: 0 },
    ])
    reopened.close()
  })

  test("model pricing coverage distinguishes free priced calls from missing prices", () => {
    const { store, sessionId } = open()
    store.sessionSink.append(usage(sessionId))
    store.sessionSink.append(usage(sessionId, ids("turn"), 0))
    store.sessionSink.append(usage(sessionId, ids("turn"), 100))
    expect(store.usageByModel(RANGE)).toMatchObject([{ calls: 3, costMicros: 100, costUnknownCalls: 1 }])
    store.close()
  })

  test("prompts and words are counted per day of the queue.added event", () => {
    const { store, sessionId, at } = open()
    store.sessionSink.append(queued(sessionId, "fix the  flaky\n test"))
    store.sessionSink.append(queued(sessionId, "   "))
    at(T0 + DAY)
    store.sessionSink.append(queued(sessionId, "one two three"))
    expect(store.usageActivity(RANGE)).toEqual([
      { day: "2026-01-01", prompts: 2, words: 4, aiMs: 0, toolMs: 0 },
      { day: "2026-01-02", prompts: 1, words: 3, aiMs: 0, toolMs: 0 },
    ])
    expect(store.usageActivity({ from: "2026-01-02", to: "2026-01-02" }).length).toBe(1)
    store.close()
  })

  test("AI time sums agent_message and reasoning durations and tool time is separate", () => {
    const { store, sessionId, at } = open()
    const turnId = ids("turn")
    const run = (kind: "reasoning" | "agent_message" | "tool_call", from: number, to: number, meta?: Record<string, string>, status: "ok" | "error" = "ok") => {
      const itemId = ids("item")
      at(from)
      store.sessionSink.append({ type: "item.started", sessionId, turnId, itemId, kind, ...(meta ? { meta } : {}) })
      at(to)
      store.sessionSink.append({ type: "item.completed", sessionId, itemId, status })
    }
    run("reasoning", T0, T0 + 2_000)
    run("tool_call", T0 + 2_000, T0 + 5_000, { tool: "shell: bun test" })
    run("agent_message", T0 + 5_000, T0 + 6_500)
    expect(store.usageActivity(RANGE)).toEqual([{ day: "2026-01-01", prompts: 0, words: 0, aiMs: 3_500, toolMs: 3_000, longestAiMs: 2_000 }])
    store.close()
  })

  test("tools are bucketed by name, raw commands and edits are normalized, errors counted, top ordered by calls", () => {
    const { store, sessionId, at } = open()
    const turnId = ids("turn")
    const tool = (name: string, ms: number, status: "ok" | "error" = "ok") => {
      const itemId = ids("item")
      store.sessionSink.append({ type: "item.started", sessionId, turnId, itemId, kind: "tool_call", meta: { tool: name } })
      at(T0 + ms)
      store.sessionSink.append({ type: "item.completed", sessionId, itemId, status })
      at(T0)
    }
    tool("shell: bun test", 100)
    tool("bun test packages/kernel", 200, "error")
    tool("git status --short", 300)
    tool("editar a.ts, b.ts", 50)
    tool("read: src/x.ts", 10)
    tool("read: src/y.ts", 30)
    tool("server.search", 5)
    expect(store.usageTools(RANGE)).toEqual([
      { tool: "shell", calls: 3, ms: 600, errors: 1 },
      { tool: "read", calls: 2, ms: 40, errors: 0 },
      { tool: "edit", calls: 1, ms: 50, errors: 0 },
      { tool: "server.search", calls: 1, ms: 5, errors: 0 },
    ])
    expect(store.usageTools(RANGE, 2).length).toBe(2)
    store.close()
  })

  test("a completion without a tracked start is ignored and the ended turn forgets open items", () => {
    const { store, sessionId } = open()
    const turnId = ids("turn")
    const itemId = ids("item")
    store.sessionSink.append({ type: "item.completed", sessionId, itemId: ids("item"), status: "ok" })
    store.sessionSink.append({ type: "item.started", sessionId, turnId, itemId, kind: "tool_call", meta: { tool: "shell" } })
    store.sessionSink.append({ type: "turn.interrupted", sessionId, turnId, reason: "restart" } as never)
    store.sessionSink.append({ type: "item.completed", sessionId, itemId, status: "interrupted" })
    expect(store.usageTools(RANGE)).toEqual([])
    expect(store.usageActivity(RANGE)).toEqual([])
    store.close()
  })

  test("range reads only include days inside the range", () => {
    const { store, sessionId, at } = open()
    store.sessionSink.append(queued(sessionId, "a b"))
    at(T0 + 40 * DAY)
    store.sessionSink.append(queued(sessionId, "c"))
    expect(store.usageActivity({ from: "2026-02-01", to: "2026-12-31" }).map((d) => d.day)).toEqual(["2026-02-10"])
    store.close()
  })

  test("usage queries stay under 50 ms with 50k synthetic events", () => {
    let clock = T0
    const store = openStore({ dir: tempDir(), now: () => clock, dayOf })
    const sessions = Array.from({ length: 50 }, () => ids("session"))
    for (const id of sessions) store.createSession({ id, directory: "/repo", title: "" })
    const turnId = ids("turn")
    // Every append is its own durable transaction (synchronous = NORMAL: no fsync per commit, one per WAL checkpoint), so the setup
    // is disk-bound: ~8 s on a developer laptop, far more on a shared runner's disk. It is measured apart from the query budget.
    let commits = 0
    const append: typeof store.sessionSink.append = (draft) => {
      commits++
      return store.sessionSink.append(draft)
    }
    const setupStarted = performance.now()
    for (let i = 0; i < 50_000; i++) {
      const sessionId = sessions[i % sessions.length]!
      clock = T0 - (i % 365) * DAY + i
      if (i % 5 === 0) append(queued(sessionId, "some words in a prompt"))
      else if (i % 5 === 1) append(usage(sessionId, turnId, 10))
      else {
        const itemId = ids("item")
        append({ type: "item.started", sessionId, turnId, itemId, kind: i % 5 === 2 ? "tool_call" : "agent_message", meta: { tool: `tool${i % 12}: x` } })
        append({ type: "item.completed", sessionId, itemId, status: "ok" })
      }
    }
    const setupMs = Math.round(performance.now() - setupStarted)
    console.log(`store usage perf setup: ${commits} commits in ${setupMs} ms (${((setupMs / commits) * 1000).toFixed(0)} us per commit)`)
    const range = { from: "2025-01-01", to: "2026-12-31" }
    store.usageActivity(range)
    const started = performance.now()
    store.usageDaily(range)
    store.usageByModel(range)
    store.usageSessions(range)
    const activity = store.usageActivity(range)
    const tools = store.usageTools(range)
    const queryMs = performance.now() - started
    if (queryMs >= budgetMs(50)) throw new Error(`usage queries took ${queryMs.toFixed(1)} ms, budget ${budgetMs(50)} ms (setup: ${commits} commits in ${setupMs} ms)`)
    expect(activity.length).toBeGreaterThan(200)
    expect(tools.length).toBe(10)
    store.close()
  }, budgetMs(60_000))
})

describe("usage projection", () => {
  test("totals cover every session in range, not just the most recent 100 (FC-24)", () => {
    let clockNow = T0
    const store = openStore({ dir: tempDir(), now: () => clockNow, dayOf: (at) => new Date(at).toISOString().slice(0, 10) })
    const sessions: SessionId[] = []
    for (let i = 0; i < 1_200; i++) {
      const id = ids("session")
      sessions.push(id)
      store.createSession({ id, directory: "/repo", title: `s${i}` })
    }
    sessions.forEach((sessionId, i) => {
      clockNow = T0 + (i % 30) * DAY
      store.sessionSink.append(usage(sessionId, ids("turn"), i % 2 === 0 ? 1_000 : undefined))
    })
    const days = store.usageDaily({ from: "2026-01-01", to: "2026-12-31" })
    expect(days.length).toBe(30)
    expect(days.reduce((sum, d) => sum + d.sessions, 0)).toBe(1_200)
    expect(days.reduce((sum, d) => sum + d.input, 0)).toBe(120_000)
    expect(days.reduce((sum, d) => sum + d.costMicros, 0)).toBe(600_000)
    expect(days.reduce((sum, d) => sum + d.costUnknownCalls, 0)).toBe(600)
    store.close()
  })

  test("memories: scoped listing, status changes, ranked search over saved entries only, delete", () => {
    const store = openStore({ dir: tempDir() })
    const add = (scope: "user" | "project", text: string, status: "saved" | "pending", directory?: string) => {
      const memoryId = ids("memory")
      store.memories.add({ memoryId, scope, ...(directory ? { directory } : {}), text, category: "commands", status, source: status === "pending" ? "agent" : "user" })
      return memoryId
    }
    const pref = add("user", "Use pnpm, never npm install", "saved")
    const projA = add("project", "Run bun test packages before commits", "saved", "/a")
    add("project", "Deploy with fly deploy", "saved", "/b")
    const proposal = add("project", "Prefer bun test --watch in /a", "pending", "/a")
    expect(store.memories.list({ directory: "/a" }).map((m) => m.memoryId).sort()).toEqual([pref, projA, proposal].sort())
    expect(store.memories.list({ directory: "/a", status: "pending" }).map((m) => m.memoryId)).toEqual([proposal])
    expect(store.memories.search({ query: "bun test", directory: "/a" }).map((m) => m.memoryId)).toEqual([projA])
    expect(store.memories.search({ query: "npm", directory: "/b" }).map((m) => m.memoryId)).toEqual([pref])
    expect(store.memories.search({ query: 'deploy" OR *', directory: "/a" })).toEqual([])
    expect(store.memories.update(proposal, { status: "saved", text: "Prefer bun test --watch" })).toBe(true)
    expect(store.memories.search({ query: "watch", directory: "/a" }).map((m) => m.text)).toEqual(["Prefer bun test --watch"])
    expect(store.memories.delete(projA)).toBe(true)
    expect(store.memories.search({ query: "commits", directory: "/a" })).toEqual([])
    expect(store.memories.get(projA)).toBeUndefined()
    store.close()
  })

  test("settings merge patches, null resets a key, invalid values are rejected and survive reopening", () => {
    const dir = tempDir()
    const store = openStore({ dir })
    expect(store.settings.get()).toEqual({})
    expect(store.settings.set({ theme: "amber", view: "full" })).toEqual({ theme: "amber", view: "full" })
    expect(store.settings.set({ view: null, defaultPermission: "edits" })).toEqual({ theme: "amber", defaultPermission: "edits" })
    expect(() => store.settings.set({ view: "huge" })).toThrow()
    expect(() => store.settings.set({ compactAtTokens: 5 })).toThrow()
    store.close()
    expect(openStore({ dir }).settings.get()).toEqual({ theme: "amber", defaultPermission: "edits" })
  })

  test("settings that no longer validate are dropped by get and named by invalid, without their values", () => {
    const dir = tempDir()
    const store = openStore({ dir })
    store.settings.set({ theme: "amber" })
    expect(store.settings.invalid()).toEqual([])
    store.close()
    const db = new Database(path.join(dir, "mendd.db"))
    db.query("UPDATE settings SET payload = ? WHERE id = 1").run(JSON.stringify({ theme: "amber", view: "SECRET-VALUE", loginShell: "yes", nonsense: 1, proxy: { url: "ftp://x" } }))
    db.close()
    const reopened = openStore({ dir })
    expect(reopened.settings.get()).toEqual({ theme: "amber" })
    const lines = reopened.settings.invalid()
    expect(lines).toHaveLength(4)
    expect(lines.join("\n")).toContain("unknown setting nonsense")
    expect(lines.join("\n")).toContain("setting loginShell")
    expect(lines.join("\n")).not.toContain("SECRET-VALUE")
    reopened.close()
  })

  test("prompt history is per directory, distinct, newest first and bounded to 500", () => {
    const store = openStore({ dir: tempDir() })
    const a = ids("session")
    const b = ids("session")
    store.createSession({ id: a, directory: "/a", title: "" })
    store.createSession({ id: b, directory: "/b", title: "" })
    const submit = (sessionId: SessionId, text: string) => store.sessionSink.append({ type: "queue.added", sessionId, queueId: ids("queue"), text, attachments: [] })
    submit(a, "fix tests")
    submit(a, "add docs")
    submit(a, "fix tests")
    submit(b, "other project")
    expect(store.promptHistory("/a")).toEqual(["fix tests", "add docs"])
    expect(store.promptHistory("/b")).toEqual(["other project"])
    for (let i = 0; i < 510; i++) submit(a, `p${i}`)
    const all = store.promptHistory("/a", 500)
    expect(all).toHaveLength(500)
    expect(all[0]).toBe("p509")
    expect(all).not.toContain("add docs")
    store.close()
  })

  test("a prompt over 16k chars stays in recall as a capped entry that says how long it was", () => {
    const store = openStore({ dir: tempDir() })
    const session = ids("session")
    store.createSession({ id: session, directory: "/a", title: "" })
    const submit = (text: string) => store.sessionSink.append({ type: "queue.added", sessionId: session, queueId: ids("queue"), text, attachments: [] })
    const exact = "x".repeat(16_000)
    const long = `${"head ".repeat(4_000)}tail`
    const emoji = "😀".repeat(9_000)
    submit(exact)
    submit(long)
    submit(emoji)
    const [capped, wide, whole] = store.promptHistory("/a").reverse() as [string, string, string]
    expect(capped).toBe(exact)
    expect(wide.length).toBeLessThanOrEqual(16_000)
    expect(wide.startsWith("head head head")).toBe(true)
    expect(wide).toMatch(/\n… \[truncated: 20004 chars, first \d+ kept\]$/)
    expect(wide).not.toContain("tail")
    expect(whole.length).toBeLessThanOrEqual(16_000)
    expect(whole).toMatch(/truncated: 18000 chars/)
    expect(whole).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/)
    // Submitting the same long prompt again stays one entry.
    submit(long)
    expect(store.promptHistory("/a")).toHaveLength(3)
    store.close()
  })

  test("engine messages are appended past what is stored and survive reopening", () => {
    const dir = tempDir()
    const store = openStore({ dir })
    const sessionId = ids("session")
    store.createSession({ id: sessionId, directory: "/repo", title: "t" })
    store.engineMessages.save(sessionId, "native", [{ role: "user", content: "a" }])
    store.engineMessages.save(sessionId, "native", [{ role: "user", content: "a" }, { role: "assistant", content: "b", toolCalls: [] }])
    expect(store.engineMessages.load(sessionId, "other")).toEqual([])
    store.close()
    const reopened = openStore({ dir })
    expect(reopened.engineMessages.load(sessionId, "native")).toEqual([{ role: "user", content: "a" }, { role: "assistant", content: "b", toolCalls: [] }])
    reopened.close()
  })

  test("a session active on several days counts once in the range total", () => {
    let clockNow = T0
    const store = openStore({ dir: tempDir(), now: () => clockNow, dayOf: (at) => new Date(at).toISOString().slice(0, 10) })
    const sessionId = ids("session")
    store.createSession({ id: sessionId, directory: "/repo", title: "long" })
    for (let day = 0; day < 3; day++) {
      clockNow = T0 + day * DAY
      store.sessionSink.append(usage(sessionId, ids("turn"), 10))
    }
    const range = { from: "2026-01-01", to: "2026-12-31" }
    expect(store.usageDaily(range).reduce((sum, d) => sum + d.sessions, 0)).toBe(3)
    expect(store.usageSessions(range)).toBe(1)
    store.close()
  })

  test("the newest quota snapshot per provider wins even if an older one arrives later", () => {
    const store = openStore({ dir: tempDir() })
    const snap = (fetchedAt: number, usedPercent: number) =>
      store.globalSink.append({ type: "quota.snapshot", provider: "codex", windows: [{ id: "primary", label: "5h", usedPercent }], fetchedAt, source: "test" })
    snap(2_000, 40)
    snap(1_000, 10)
    expect(store.latestQuota()[0]?.windows[0]?.usedPercent).toBe(40)
    store.close()
  })
})

describe("blob store and disk hygiene", () => {
  test("the same attachment stored 100 times occupies one file (A9)", () => {
    const dir = tempDir()
    const store = openStore({ dir })
    const bytes = new Uint8Array(1024 * 1024).fill(7)
    const refs = Array.from({ length: 100 }, () => store.putBlob(bytes, "image/png"))
    expect(new Set(refs.map((r) => r.sha256)).size).toBe(1)
    expect(store.storageReport().blobBytes).toBe(1024 * 1024)
    store.close()
  })

  test("deleting a session frees blobs only it referenced; shared blobs survive", () => {
    const store = openStore({ dir: tempDir() })
    const [a, b] = [ids("session"), ids("session")]
    for (const id of [a, b]) store.createSession({ id, directory: "/repo", title: "t" })
    const shared = store.putBlob(new Uint8Array([1, 2, 3]), "text/plain")
    const onlyA = store.putBlob(new Uint8Array(4096).fill(9), "image/png")
    const complete = (sessionId: SessionId, attachments: typeof shared[]) =>
      store.sessionSink.append({ type: "item.completed", sessionId, itemId: ids("item"), status: "ok", text: "m", attachments })
    complete(a, [shared, onlyA])
    complete(b, [shared])
    store.deleteSession(a)
    expect(store.collectBlobs()).toEqual({ removed: 1, freedBytes: 4096 })
    expect(store.storageReport().blobs).toBe(1)
    expect(store.readAfter(a, 0)).toEqual([])
    store.close()
  })
})

describe("sessions list and migrations", () => {
  test("a database from an earlier build gains new columns without losing sessions", async () => {
    const dir = tempDir()
    const { Database } = await import("bun:sqlite")
    const old = new Database(path.join(dir, "mendd.db"), { create: true })
    old.run("CREATE TABLE sessions (id TEXT PRIMARY KEY, directory TEXT NOT NULL, title TEXT NOT NULL, parent_id TEXT, created_at INTEGER NOT NULL, last_seq INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID")
    old.run("INSERT INTO sessions VALUES ('ses_OLD', '/repo', 'old one', NULL, 1000, 0)")
    old.close()
    const store = openStore({ dir })
    const [row] = store.listSessions()
    expect(row).toMatchObject({ sessionId: "ses_OLD", title: "old one", updatedAt: 1000 })
    store.close()
  })

  test("the first queued message titles an untitled session and activity orders the list", () => {
    let clock = 1_000
    const store = openStore({ dir: tempDir(), now: () => clock })
    const [a, b] = [ids("session"), ids("session")]
    store.createSession({ id: a, directory: "/repo", title: "" })
    clock = 2_000
    store.createSession({ id: b, directory: "/repo", title: "" })
    clock = 3_000
    store.sessionSink.append({ type: "queue.added", sessionId: a, queueId: ids("queue"), text: "  fix the flaky\nlogin test please", attachments: [] })
    store.sessionSink.append({ type: "queue.added", sessionId: a, queueId: ids("queue"), text: "second message", attachments: [] })
    const list = store.listSessions()
    expect(list.map((s) => s.sessionId)).toEqual([a, b])
    expect(list[0]).toMatchObject({ title: "fix the flaky", updatedAt: 3_000, queued: 2 })
    expect(store.listSessions({ directory: "/other" })).toEqual([])
    store.close()
  })
})

describe("single writer (A11)", () => {
  test("a second store on the same directory fails fast; after close it can open", () => {
    const dir = tempDir()
    const first = openStore({ dir })
    expect(() => openStore({ dir })).toThrow(/owned by running process/)
    first.close()
    const second = openStore({ dir })
    second.close()
  })

  test("a lock left by a dead process is replaced instead of blocking forever", () => {
    const dir = tempDir()
    writeFileSync(path.join(dir, "mendd.lock"), "999999")
    const store = openStore({ dir })
    store.close()
    expect(readdirSync(dir).includes("mendd.lock")).toBe(false)
  })
})
