import { describe, expect, test } from "bun:test"
import type { EventsWindow, SessionEvent, SessionId } from "@mendcode/protocol"
import type { WindowReply } from "@mendcode/client"
import { createTranscript } from "../src/view/transcript"
import { appHarness, conversation, ids, NOW } from "./session-ui-harness"

function log(sessionId = ids("session"), count = 100) {
  const events: SessionEvent[] = []
  const chat = conversation(sessionId, (event) => events.push(event))
  for (let n = 1; n <= count; n++) chat.exchange(`question ${n}`, `answer ${n}`)
  return { sessionId, events, chat }
}

function window(events: SessionEvent[], more: boolean, bounds: Partial<EventsWindow> = {}): WindowReply {
  return { ok: true, window: { events, firstSeq: events[0]?.seq ?? 0, lastSeq: events.at(-1)?.seq ?? 0, sessionLastSeq: events.at(-1)?.seq ?? 0, more, ...bounds } }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function paged() {
  const source = log()
  const before: Array<{ sessionId: SessionId; seq: number }> = []
  const opened: SessionId[] = []
  const pending: Array<ReturnType<typeof deferred<WindowReply>>> = []
  const h = appHarness({
    sessionId: source.sessionId,
    height: 24,
    mode: "minimal",
    events: {
      loadWindow: async (id) => { opened.push(id); return window(source.events.slice(-200), true) },
      loadBefore: (sessionId, seq) => {
        before.push({ sessionId, seq })
        const page = deferred<WindowReply>()
        pending.push(page)
        return page.promise
      },
    },
  })
  return { ...h, source, before, opened, pending }
}

const pageUp = "\x1b[5~"
const home = "\x1b[H"
const end = "\x1b[F"
const wheelUp = "\x1b[<64;10;5M"
const settle = () => Bun.sleep(2)
const content = (h: ReturnType<typeof paged>) => h.text().map((row) => row.replace(/\s*(?:↑ earlier · scroll up|loading earlier…|start of session|↓ (?:latest|\d+ new)(?: · End)?).*$/, "").trimEnd())

describe("event paging in the terminal app", () => {
  test("opening a long session reads one default window before subscribing from its raw lastSeq", async () => {
    const h = paged()
    expect(h.subscriptions).toEqual([])
    await h.app.start()
    expect(h.opened).toEqual([h.sessionId])
    expect(h.subscriptions).toEqual([{ sessionId: h.sessionId, afterSeq: 600 }])
    expect(h.app.transcript.visibleCount).toBeLessThan(100)
    expect(h.app.transcript.blocks().some((block) => block.text === "question 1")).toBe(false)
    expect(h.text().join("\n")).toContain("answer 100")
    const next = h.source.events.length
    h.source.chat.exchange("live question", "live answer")
    for (const event of h.source.events.slice(next)) h.app.onEvent(event)
    expect(h.text().join("\n")).toContain("live answer")
    expect(h.before).toEqual([])
  })

  test("PageUp within a screen of the oldest loaded line fetches once, before the top; wheel and Home cannot duplicate it; prepend keeps the same screen lines", async () => {
    const h = paged()
    await h.app.start()
    for (let page = 0; page < 30 && h.before.length === 0; page++) await h.app.onKey(pageUp)
    expect(h.before).toEqual([{ sessionId: h.sessionId, seq: 401 }])
    // The page was asked for a screen ahead: the oldest loaded lines are still above, so nothing says it is loading yet.
    expect(h.text().join("\n")).not.toContain("loading earlier…")
    // A reader faster than the page reaches the top while it is on its way: only then does the label show.
    for (let page = 0; page < 3; page++) await h.app.onKey(pageUp)
    const anchored = content(h)
    expect(h.text().join("\n")).toContain("loading earlier…")
    await h.app.onKey(wheelUp)
    await h.app.onKey(home)
    expect(h.before).toHaveLength(1)
    h.pending[0]!.resolve(window(h.source.events.slice(200, 400), true))
    await settle()
    expect(content(h)).toEqual(anchored)
    expect(h.app.transcript.blocks().some((block) => block.text === "question 35")).toBe(true)
    const loadedCount = h.app.transcript.visibleCount
    await h.app.onKey(end)
    await h.app.onKey(home)
    expect(h.before.map((call) => call.seq)).toEqual([401, 201])
    expect(h.app.transcript.visibleCount).toBe(loadedCount)
    h.pending[1]!.resolve(window(h.source.events.slice(0, 200), false))
    await settle()
    await h.app.onKey(home)
    expect(h.text().join("\n")).toContain("start of session")
    expect(h.text().join("\n")).toContain("question 1")
    await h.app.onKey(pageUp)
    await h.app.onKey(wheelUp)
    expect(h.before).toHaveLength(2)
  })

  test("live growth and a reader moving down while a page waits keep the current viewport anchored", async () => {
    const h = paged()
    await h.app.start()
    await h.app.onKey(home)
    expect(h.before).toHaveLength(1)
    const next = h.source.events.length
    h.source.chat.exchange("live question", "live answer")
    for (const event of h.source.events.slice(next)) h.app.onEvent(event)
    await h.app.onKey("\x1b[6~")
    const anchored = content(h)
    h.pending[0]!.resolve(window(h.source.events.slice(200, 400), true))
    await settle()
    expect(content(h)).toEqual(anchored)
    expect(h.app.transcript.lastSeq).toBe(606)
    await h.app.onKey(end)
    expect(h.text().join("\n")).toContain("live answer")
  })

  test("a session whose newest windows draw nothing is not opened blank: reading goes back until the chat shows", async () => {
    const source = log(ids("session"), 3)
    const first = source.events[0]!.seq
    // Twenty windows of records with nothing to draw sit after the conversation.
    const silent = 20
    const cursors: number[] = []
    const h = appHarness({
      sessionId: source.sessionId, height: 24, mode: "minimal",
      events: {
        loadWindow: async () => window([], true, { firstSeq: first + source.events.length + silent * 10, lastSeq: first + source.events.length + silent * 10 + 9, sessionLastSeq: first + source.events.length + silent * 10 + 9 }),
        loadBefore: async (_id, seq) => {
          cursors.push(seq)
          const left = Math.round((seq - first - source.events.length) / 10)
          return left > 0 ? window([], true, { firstSeq: seq - 10, lastSeq: seq - 1 }) : window(source.events, false)
        },
      },
    })
    await h.app.start()
    await settle()
    h.app.render()
    expect(cursors.length).toBe(silent + 1)
    expect(h.text().join("\n")).toContain("answer 3")
  })

  test("a session whose pages draw a few rows each (sub-agent and streaming records) is read back until the screen is full, not left at the top over an empty band", async () => {
    const source = log(ids("session"), 40)
    const bySeq = (from: number, to: number) => source.events.filter((event) => event.seq >= from && event.seq < to)
    const last = source.events.at(-1)!.seq
    // Pages of two records: an exchange takes several pages, more than the few a screen usually needs.
    const h = appHarness({
      sessionId: source.sessionId, height: 24, mode: "minimal",
      events: {
        loadWindow: async () => window(bySeq(last - 1, last + 1), true),
        loadBefore: async (_id, seq) => {
          const page = bySeq(seq - 2, seq)
          return window(page, seq - 2 > source.events[0]!.seq, { firstSeq: seq - 2, lastSeq: seq - 1 })
        },
      },
    })
    await h.app.start()
    await settle()
    h.app.render()
    const rows = h.text()
    const lastAnswer = rows.findIndex((row) => row.includes("answer 40"))
    expect(lastAnswer).toBeGreaterThan(-1)
    // The newest answer sits at the bottom of the chat: older exchanges fill the rows above it.
    expect(rows.slice(0, lastAnswer).filter((row) => /question \d+/.test(row)).length).toBeGreaterThanOrEqual(3)
  })

  test("while older pages are on their way, a chat shorter than the screen sits at the bottom over the prompt, not at the top over an empty band", async () => {
    const source = log(ids("session"), 40)
    const last = source.events.at(-1)!.seq
    const pages: Array<ReturnType<typeof deferred<WindowReply>>> = []
    const h = appHarness({
      sessionId: source.sessionId, height: 24, mode: "minimal",
      events: {
        // The newest exchange alone: a few rows on a 24-row screen.
        loadWindow: async () => window(source.events.slice(-source.events.length / 40), true),
        loadBefore: () => { const page = deferred<WindowReply>(); pages.push(page); return page.promise },
      },
    })
    // Opening waits for the screen to fill; the page it waits for is held.
    const started = h.app.start()
    await settle()
    h.app.render()
    expect(pages.length).toBe(1)
    const rows = h.text()
    const answer = rows.findIndex((row) => row.includes("answer 40"))
    const prompt = rows.findIndex((row, at) => at > answer && /^\s*[❯›>]/.test(row))
    expect(answer).toBeGreaterThan(-1)
    // Only blank rows above the answer, none of the empty band between it and the prompt.
    expect(rows.slice(0, answer).filter((row) => row.trim()).length).toBeLessThanOrEqual(2)
    expect(prompt === -1 || prompt - answer <= 3).toBe(true)
    pages[0]!.resolve(window([], false, { firstSeq: 1, lastSeq: last - 2 }))
    await started
  })

  test("empty hidden pages advance their raw cursor, and an exhausted empty page shows start of session", async () => {
    const h = paged()
    await h.app.start()
    await h.app.onKey(home)
    h.pending[0]!.resolve(window([], true, { firstSeq: 201, lastSeq: 400, sessionLastSeq: 600 }))
    await settle()
    await h.app.onKey(wheelUp)
    expect(h.before.map((call) => call.seq)).toEqual([401, 201])
    h.pending[1]!.resolve(window([], false, { firstSeq: 1, lastSeq: 200, sessionLastSeq: 600 }))
    await settle()
    expect(h.text().join("\n")).toContain("start of session")
    await h.app.onKey(home)
    expect(h.before).toHaveLength(2)
  })

  test("a failed earlier page preserves content and cursor and permits retry", async () => {
    const h = paged()
    await h.app.start()
    await h.app.onKey(home)
    const blocks = h.app.transcript.blocks().map((block) => block.text)
    h.pending[0]!.reject(new Error("history disconnected"))
    await settle()
    expect(h.text().join("\n")).not.toContain("loading earlier…")
    expect(h.app.transcript.blocks().map((block) => block.text)).toEqual(blocks)
    await h.app.onKey(pageUp)
    expect(h.before.map((call) => call.seq)).toEqual([401, 401])
    h.pending[1]!.resolve(window([], false, { firstSeq: 1 }))
    await settle()
  })

  test("switching resets the window, cursor and viewport and ignores an earlier reply from the previous session", async () => {
    const first = log()
    const second = log(ids("session"), 2)
    const pending = deferred<WindowReply>()
    const opened: SessionId[] = []
    const before: number[] = []
    const h = appHarness({
      sessionId: first.sessionId,
      height: 24,
      mode: "minimal",
      reply: (command) => command.type === "session.create" ? { ok: true, result: { sessionId: second.sessionId } } : undefined,
      events: {
        loadWindow: async (id) => {
          opened.push(id)
          return id === first.sessionId ? window(first.events.slice(-200), true) : window(second.events, false)
        },
        loadBefore: (_id, seq) => { before.push(seq); return pending.promise },
      },
    })
    await h.app.start()
    await h.app.onKey(home)
    await h.type("/new\r")
    expect(h.app.sessionId).toBe(second.sessionId)
    expect(opened).toEqual([first.sessionId, second.sessionId])
    expect(h.subscriptions).toEqual([{ sessionId: first.sessionId, afterSeq: 600 }, { sessionId: second.sessionId, afterSeq: 12 }])
    expect(h.sentOf("client.unsubscribe")).toEqual([{ type: "client.unsubscribe", sessionId: first.sessionId }])
    pending.resolve(window(first.events.slice(200, 400), true))
    await settle()
    expect(h.app.transcript.blocks().some((block) => block.text === "answer 100")).toBe(false)
    expect(h.app.transcript.lastSeq).toBe(12)
    await h.app.onKey(home)
    expect(h.text().join("\n")).not.toContain("start of session")
    expect(before).toEqual([401])
  })

  test("raw lastSeq includes hidden events; a failed initial read never falls back to replaying the whole log", async () => {
    const sessionId = ids("session")
    let refused = true
    const h = appHarness({ sessionId, events: {
      loadWindow: async () => refused ? { ok: false, error: { code: "unknown_session", message: "session unavailable" } } : window([], false, { firstSeq: 9, lastSeq: 208 }),
      loadBefore: async () => window([], false),
    } })
    await h.app.start()
    expect(h.subscriptions).toEqual([])
    refused = false
    await h.app.start()
    expect(h.subscriptions).toEqual([{ sessionId, afterSeq: 208 }])
  })

  test("older embedders still subscribe from zero without event hooks", async () => {
    const h = appHarness()
    await h.app.start()
    expect(h.subscriptions).toEqual([{ sessionId: h.sessionId, afterSeq: 0 }])
  })
})

describe("transcript prepend at event boundaries", () => {
  test("every cut inside turns/items reconstructs the same projection; overlapping pages and replayed live events are ignored", () => {
    const source = log(ids("session"), 3)
    const turnId = ids("turn")
    const itemId = ids("item")
    source.chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
    source.chat.emit({ type: "item.started", turnId, itemId, kind: "tool_call", meta: { tool: "shell" } })
    source.chat.emit({ type: "item.delta", itemId, text: "one\n" })
    source.chat.emit({ type: "item.delta", itemId, text: "two\n" })
    source.chat.emit({ type: "item.completed", itemId, text: "", status: "ok" })
    source.chat.emit({ type: "turn.completed", turnId })
    const full = createTranscript({ now: () => NOW })
    source.events.forEach(full.apply)
    for (let cut = 1; cut < source.events.length; cut++) {
      const t = createTranscript({ now: () => NOW })
      source.events.slice(cut).forEach(t.apply)
      // Laid out before the older page arrives: rows kept across the prepend must be the rows a full replay draws.
      t.viewport(90, 200)
      t.prepend(source.events.slice(0, cut))
      expect(t.blocks()).toEqual(full.blocks())
      expect(t.viewport(90, 200)).toEqual(full.viewport(90, 200))
      const lastSeq = t.lastSeq
      t.prepend(source.events)
      source.events.forEach(t.apply)
      expect(t.blocks()).toEqual(full.blocks())
      expect(t.lastSeq).toBe(lastSeq)
    }
  })

  /**
   * A session with what reaches across a page cut: tools streaming over several events, model calls whose cache notes read the call
   * before, sub-agent threads running beside the turn, approvals, a goal, a compaction, an undo and a redo, a deleted message.
   */
  function richLog() {
    const source = log(ids("session"), 2)
    const { chat } = source
    const usage = (turnId: string, fields: Record<string, number> = {}) => chat.emit({ type: "usage.recorded", turnId, provider: "p", model: "m", input: 3_000, output: 200, reasoning: 0, cacheRead: 0, cacheWrite: 0, ...fields })
    const item = (turnId: string, kind: string, text: string, meta?: Record<string, unknown>) => {
      const itemId = ids("item")
      chat.emit({ type: "item.started", turnId, itemId, kind, ...(meta ? { meta } : {}) })
      for (const part of text.split(" ")) chat.emit({ type: "item.delta", itemId, text: `${part} ` })
      chat.emit({ type: "item.completed", itemId, status: "ok", ...(kind === "tool_call" ? { text: "" } : {}) })
      return itemId
    }
    // A turn of tools whose second call misses the cache the first one wrote.
    const tools = ids("turn")
    chat.emit({ type: "turn.started", turnId: tools, queueId: ids("queue") })
    item(tools, "user_message", "run the tests please")
    item(tools, "reasoning", "the tests live in test so run them")
    usage(tools, { cacheWrite: 5_000 })
    const shell = item(tools, "tool_call", "pass pass pass fail", { tool: "shell: bun test" })
    usage(tools, { input: 6_000, cacheRead: 10 })
    chat.emit({ type: "server.request", requestId: ids("request"), turnId: tools, kind: "approval", title: "Run tests", detail: "bun test", itemId: shell })
    chat.emit({ type: "foreground.state", state: "busy" })
    item(tools, "agent_message", "one test fails in the parser")
    chat.emit({ type: "turn.completed", turnId: tools })
    chat.emit({ type: "queue.changed", queue: [] })
    // Two sub-agents whose items interleave with the turn's own.
    const agents = ids("turn")
    chat.emit({ type: "turn.started", turnId: agents, queueId: ids("queue") })
    item(agents, "user_message", "ask two agents")
    const first = ids("item"), second = ids("item")
    chat.emit({ type: "item.started", turnId: agents, itemId: first, kind: "tool_call", meta: { tool: "agent Read a", subagent: true, agent: "general-purpose", background: false } })
    chat.emit({ type: "item.started", turnId: agents, itemId: second, kind: "tool_call", meta: { tool: "agent Read b", subagent: true, agent: "general-purpose", background: false } })
    item(agents, "user_message", "find a", { agentParent: first, agentModel: "model-a" })
    // A sub-agent's tool still runs while its next item starts: a cut between them hands the tool's end to the thread.
    const slow = ids("item")
    chat.emit({ type: "item.started", turnId: agents, itemId: slow, kind: "tool_call", meta: { agentParent: first, tool: "grep a" } })
    chat.emit({ type: "item.delta", itemId: slow, text: "a.txt:1 " })
    item(agents, "reasoning", "the grep is slow", { agentParent: first })
    chat.emit({ type: "item.delta", itemId: slow, text: "a.txt:2" })
    chat.emit({ type: "item.completed", itemId: slow, status: "ok", text: "" })
    item(agents, "tool_call", "read a.txt now", { agentParent: first, tool: "read /work/a.txt" })
    item(agents, "user_message", "find b", { agentParent: second })
    usage(agents, { cacheRead: 4_000 })
    item(agents, "tool_call", "find b.txt here", { agentParent: second, tool: "$ find /work -name b.txt" })
    item(agents, "agent_message", "a is here", { agentParent: first })
    chat.emit({ type: "item.completed", itemId: first, status: "ok", text: "a found", meta: { tool: "agent Read a", subagent: true, agentParent: first, agentEnd: true, toolCalls: 1, tokens: 900, durationMs: 4000 } })
    item(agents, "agent_message", "b is there", { agentParent: second })
    chat.emit({ type: "item.completed", itemId: second, status: "ok", text: "b found" })
    item(agents, "agent_message", "both found")
    chat.emit({ type: "turn.completed", turnId: agents })
    // A goal, a turn the user stopped, a request the user answered.
    const stopped = ids("turn")
    const asked = ids("request")
    chat.emit({ type: "goal.changed", change: "set", goal: { text: "fix the parser", status: "active", setAt: NOW, updatedAt: NOW } })
    chat.emit({ type: "turn.started", turnId: stopped, queueId: ids("queue") })
    item(stopped, "user_message", "fix the parser")
    chat.emit({ type: "server.request", requestId: asked, turnId: stopped, kind: "question", title: "Which?", detail: "a or b" })
    usage(stopped, { cacheRead: 3_000, input: 3_000 })
    chat.emit({ type: "server.request.resolved", requestId: asked, resolution: "answered" })
    item(stopped, "tool_call", "edit parser ts", { tool: "edit parser.ts" })
    chat.emit({ type: "turn.interrupted", turnId: stopped, reason: "user" })
    // A compaction: its own calls count as its cost, and the next call's miss is expected.
    const packed = ids("turn")
    chat.emit({ type: "turn.started", turnId: packed, queueId: ids("queue") })
    chat.emit({ type: "compaction.updated", turnId: packed, reason: "manual", state: "writing", followUp: "" })
    usage(packed, { input: 8_000 })
    item(packed, "compaction", "summary of the work so far", { compactionMethod: "legacy" })
    chat.emit({ type: "compaction.updated", turnId: packed, reason: "manual", state: "packed", followUp: "" })
    chat.emit({ type: "turn.completed", turnId: packed })
    usage(ids("turn"), { input: 2_500 })
    // An undone turn, put back, and undone again; a message deleted later.
    const undone = chat.exchange("try another way", "tried")
    chat.undo(undone.turnId)
    chat.redo(undone.turnId)
    const kept = chat.exchange("and now", "done")
    chat.undo(undone.turnId)
    chat.emit({ type: "message.revised", itemId: kept.itemId, turnId: kept.turnId, revision: 1, deleted: true, snapshot: { status: "ok", text: "" } })
    const last = ids("turn")
    chat.emit({ type: "turn.started", turnId: last, queueId: ids("queue") })
    item(last, "user_message", "last question")
    usage(last, { cacheRead: 2_900, input: 100 })
    item(last, "agent_message", "last answer with several words")
    chat.emit({ type: "turn.completed", turnId: last })
    return { events: source.events, threads: [first, second] }
  }

  /** What a reader of the projection sees: its blocks, rows, threads and every summary the app reads from it. */
  function seen(t: ReturnType<typeof createTranscript>, threads: readonly string[]) {
    const thread = (itemId: string) => (t.agentTranscript(itemId as never) as ReturnType<typeof createTranscript> | undefined)?.blocks()
    return {
      blocks: t.blocks(), rows: t.viewport(90, 600), lastSeq: t.lastSeq, agents: t.agentThreads(), threads: threads.map(thread),
      activeTurn: t.activeTurn, turnClock: t.turnClock, lastUsage: t.lastUsage, usage: t.sessionUsage, models: t.modelUsage, calls: t.recentCalls,
      lastCall: t.lastCall, cost: t.sessionCost, turnTimes: t.recentTurnTimes, contexts: t.recentContexts, goal: t.goal, limit: t.usageLimit,
      queue: t.queue, foreground: t.foreground, stop: t.lastStop, permission: t.permissionMode, requests: t.pendingRequests, compactions: t.compactions(),
    }
  }

  test("a rich session cut anywhere, joined in one page or in pages of any size, reads exactly as its full replay", () => {
    const { events, threads } = richLog()
    const replayOf = (from: number) => {
      const t = createTranscript({ now: () => NOW })
      events.slice(from).forEach(t.apply)
      return seen(t, threads)
    }
    const full = replayOf(0)
    // Notes exist (a cache miss after the cache was written), and the compaction's cost replaced its own.
    expect(full.blocks.some((block) => block.note?.kind === "cache")).toBe(true)
    expect(full.blocks.some((block) => block.note?.kind === "compaction")).toBe(true)
    expect(full.agents.map((agent) => agent.tools)).toEqual([2, 1])
    expect(full.threads[0]!.find((block) => block.title === "grep a")?.text).toBe("a.txt:1 a.txt:2")
    for (let cut = 1; cut < events.length; cut++) {
      const t = createTranscript({ now: () => NOW })
      events.slice(cut).forEach(t.apply)
      t.viewport(90, 600)
      t.prepend(events.slice(0, cut))
      expect(seen(t, threads)).toEqual(full)
    }
    for (const size of [1, 2, 3, 5, 8, 13]) {
      const t = createTranscript({ now: () => NOW })
      let from = events.length - size
      events.slice(from).forEach(t.apply)
      while (from > 0) {
        t.viewport(90, 600)
        const next = Math.max(0, from - size)
        // Pages overlap the loaded history the way a reply racing a live event can: only the older events join.
        t.prepend(events.slice(next, from + 1))
        from = next
        expect(seen(t, threads)).toEqual(replayOf(from))
      }
    }
  })
})
