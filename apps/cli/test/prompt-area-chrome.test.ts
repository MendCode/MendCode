import { describe, expect, test } from "bun:test"
import { createIdFactory, type ModelsReport, type SessionEvent } from "@mendcode/protocol"
import { createApp } from "../src/ui/app"
import { createToasts } from "../src/ui/toasts"
import { nextEffortChoice, nextModelChoice } from "../src/ui/model-cycle"
import { glyphs, type Line } from "../src/ui/theme"
import { createModelPageState, MODEL_PAGE_ROWS, modelPageKey, renderModelPage } from "../src/view/model-page"
import type { PresentationMode } from "../src/view/transcript"

const ids = createIdFactory()
const NOW = 1_800_000_000_000
const plain = (line: Line) => line.map((span) => span.text).join("")

const REPORT: ModelsReport = {
  engine: "codex",
  selectable: true,
  models: [
    { id: "gpt-6-luna", efforts: ["low", "high"], defaultEffort: "low" },
    { id: "gpt-6-sol", efforts: ["high", "xhigh"], defaultEffort: "high" },
  ],
  defaults: { model: "gpt-6-luna" },
  roles: {},
  effective: { model: "gpt-6-luna", effort: "high" },
}

function harness(options: { mode?: PresentationMode; width?: number; height?: number; send?: (command: Record<string, unknown>) => unknown; now?: () => number } = {}) {
  const frames: Line[][] = []
  const titles: string[] = []
  const sent: Array<Record<string, unknown>> = []
  const screen = {
    size: { width: options.width ?? 100, height: options.height ?? 40 },
    draw: (rows: Line[]) => void frames.push(rows),
    setTitle: (title: string) => void titles.push(title),
  } as unknown as Parameters<typeof createApp>[0]["screen"]
  const sessionId = ids("session")
  const turnId = ids("turn")
  const app = createApp({
    sessionId,
    screen,
    directory: "/Users/dev/work/app",
    home: "/Users/dev",
    exit() {},
    schedule: (fn) => fn(),
    glyphs: glyphs({}),
    now: options.now ?? (() => NOW),
    random: () => 0,
    mode: options.mode ?? "balanced",
    subscribe: async () => ({ ok: true }),
    send: (async (command: Record<string, unknown>) => {
      sent.push(command)
      return (await options.send?.(command)) ?? { ok: true }
    }) as never,
  })
  let seq = 0
  const ev = (patch: Record<string, unknown>, at = NOW) => app.onEvent({ sessionId, seq: ++seq, at, ...patch } as SessionEvent)
  const message = (text = "hello") => {
    const itemId = ids("item")
    ev({ type: "item.started", turnId, itemId, kind: "agent_message" })
    ev({ type: "item.completed", itemId, status: "ok", text })
  }
  const text = () => frames.at(-1)!.map(plain)
  return { app, sent, ev, message, text, frames, titles, sessionId, turnId }
}

const daemon = (command: Record<string, unknown>) => {
  if (command.type === "git.branch") return { ok: true, result: { branch: "feature/x" } }
  if (command.type === "changes.query") return { ok: true, result: { files: [{ path: "a.ts", status: "modified", additions: 12, deletions: 3 }, { path: "b.ts", status: "added", additions: 30, deletions: 0 }] } }
  if (command.type === "models.list") return { ok: true, result: REPORT }
  if (command.type === "session.model.set") return { ok: true, result: { ...REPORT, effective: command.choice } }
  if (command.type === "session.list") return { ok: true, result: { sessions: [] } }
  return undefined
}

describe("top bar", () => {
  test("a session shows branch, ~path, title, +A -R and the context bar as row 0; the home does not", async () => {
    const h = harness({ send: daemon })
    h.app.applySettings({})
    h.app.render()
    expect(h.text().some((row) => row.includes("feature/x"))).toBe(false)
    h.message()
    await Bun.sleep(10)
    h.app.onGlobal({ type: "session.activity", gseq: 1, at: NOW, sessionId: h.sessionId, directory: "/Users/dev/work/app", title: "Fix the flaky reconnect", state: "idle", updatedAt: NOW } as never)
    h.ev({ type: "usage.recorded", turnId: h.turnId, provider: "p", model: "m", input: 50_000, output: 1_000, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
    const row = h.text()[0]!
    expect(row).toContain("feature/x ~/work/app")
    expect(row).toContain("Fix the flaky reconnect")
    expect(row).toContain("+42 -3")
    expect(row).toMatch(/\d+%$/)
  })

  test("minimal has none, and the diff is fetched at start and after each turn only", async () => {
    const minimal = harness({ mode: "minimal", send: daemon })
    minimal.app.applySettings({})
    minimal.message()
    expect(minimal.text()[0]).not.toContain("~/work/app")
    expect(minimal.sent.some((command) => command.type === "changes.query")).toBe(false)
    const h = harness({ send: daemon })
    h.app.applySettings({})
    await Bun.sleep(10)
    expect(h.sent.filter((command) => command.type === "changes.query")).toHaveLength(1)
    h.message()
    h.app.render()
    expect(h.sent.filter((command) => command.type === "changes.query")).toHaveLength(1)
    h.ev({ type: "turn.completed", turnId: h.turnId })
    expect(h.sent.filter((command) => command.type === "changes.query")).toHaveLength(2)
  })

  test("its title scrolls on a timer that exists only while the title overflows", async () => {
    const h = harness({ send: daemon, width: 60 })
    h.message()
    h.app.onGlobal({ type: "session.activity", gseq: 1, at: NOW, sessionId: h.sessionId, directory: "/x", title: "A very long session title that cannot fit in its box", state: "idle", updatedAt: NOW } as never)
    h.app.render()
    const before = h.text()[0]
    await Bun.sleep(400)
    expect(h.text()[0]).not.toBe(before)
    h.app.onGlobal({ type: "session.activity", gseq: 2, at: NOW, sessionId: h.sessionId, directory: "/x", title: "short", state: "idle", updatedAt: NOW } as never)
    h.app.render()
    const still = h.text()[0]
    await Bun.sleep(400)
    expect(h.text()[0]).toBe(still)
  })

  test("the terminal title follows the session title", () => {
    const h = harness()
    h.app.render()
    expect(h.titles.at(-1)).toBe("MendCode")
    h.app.onGlobal({ type: "session.activity", gseq: 1, at: NOW, sessionId: h.sessionId, directory: "/x", title: "Fix tests", state: "idle", updatedAt: NOW } as never)
    h.app.render()
    expect(h.titles.at(-1)).toBe("MendCode | Fix tests")
  })
})

describe("toasts", () => {
  test("one at a time, replaced by the next, with a single timer that ends with the toast", () => {
    const timers: Array<{ fn: () => void; cleared: boolean }> = []
    let changes = 0
    const toasts = createToasts(() => changes++, { set: (fn) => (timers.push({ fn, cleared: false }), timers.at(-1)), clear: (handle) => void ((handle as { cleared: boolean }).cleared = true) })
    expect(toasts.pending).toBe(false)
    toasts.show({ variant: "info", message: "one" })
    toasts.show({ variant: "error", message: "two" })
    expect(toasts.current?.message).toBe("two")
    expect(timers.map((timer) => timer.cleared)).toEqual([true, false])
    timers[1]!.fn()
    expect(toasts.current).toBeUndefined()
    expect(toasts.pending).toBe(false)
    expect(changes).toBe(3)
  })

  test("a short error result lies over the prompt's top rule: no box and no row of its own", async () => {
    const h = harness({ send: (command) => (command.type === "session.fork" ? { ok: false, error: { code: "unknown_session", message: "[DAEMON]: unknown session" } } : daemon(command)) })
    h.message()
    await h.app.onKey("\x10")
    await Bun.sleep(5)
    for (const key of "Fork session") await h.app.onKey(key)
    await h.app.onKey("\r")
    await Bun.sleep(5)
    const rows = h.text()
    const at = rows.findIndex((row) => row.includes("unknown session"))
    expect(at).toBeGreaterThan(1)
    expect(rows[at]).not.toContain("┃")
    expect(rows[at]).toContain("─")
    expect(rows[at + 1]).not.toContain("─")
  })

  test("dream results and a saved memory are toasts", () => {
    const h = harness()
    h.app.onGlobal({ type: "memory.changed", gseq: 1, at: NOW, memoryId: "m1", change: "added" } as never)
    h.app.render()
    expect(h.text().some((row) => row.includes("Memory saved"))).toBe(false)
    h.app.onGlobal({ type: "memory.changed", gseq: 1, at: NOW, memoryId: "m1", change: "added", scope: "project", status: "saved", text: "Use bun" } as never)
    h.app.render()
    expect(h.text().some((row) => row.includes("Memory saved"))).toBe(true)
    expect(h.text().some((row) => row.includes("project") && row.includes("Use bun"))).toBe(true)
    h.app.onGlobal({ type: "dream.changed", gseq: 2, at: NOW, run: { directory: "/Users/dev/work/app", status: "done", proposed: 2 } } as never)
    expect(h.text().some((row) => row.includes("dream: 2 proposals"))).toBe(true)
  })

  test("a finished background task is a toast", () => {
    const h = harness()
    h.ev({ type: "queue.added", queueId: ids("queue"), text: "Background task finished: bun test\nexit 0", attachments: [], notice: true })
    expect(h.text().some((row) => row.includes("Background task finished: bun test"))).toBe(true)
  })
})

describe("keymap", () => {
  test("ctrl+x arms the leader and shows the chords where the working row goes; a chord runs its command", async () => {
    const h = harness({ send: daemon })
    h.message()
    await h.app.onKey("\x18")
    expect(h.text().some((row) => row.includes("ctrl+x · n new session"))).toBe(true)
    await h.app.onKey("n")
    expect(h.sent.some((command) => command.type === "session.create")).toBe(true)
    expect(h.text().some((row) => row.includes("ctrl+x ·"))).toBe(false)
  })

  test("any other key cancels the leader and is not typed", async () => {
    const h = harness()
    await h.app.onKey("\x18")
    await h.app.onKey("k")
    expect(h.app.editor.text).toBe("")
    expect(h.text().some((row) => row.includes("ctrl+x ·"))).toBe(false)
  })

  test("a chord keeps the draft in the prompt", async () => {
    const h = harness()
    for (const key of "half") await h.app.onKey(key)
    await h.app.onKey("\x18")
    await h.app.onKey("q")
    expect(h.app.editor.text).toBe("half")
  })

  test("the leader disarms itself after two seconds", async () => {
    let now = NOW
    const h = harness({ now: () => now })
    h.message()
    await h.app.onKey("\x18")
    now += 2_500
    h.app.render()
    expect(h.text().some((row) => row.includes("ctrl+x ·"))).toBe(false)
  })

  test("F2 leaves an empty recent list alone; F3 still cycles this model's effort", async () => {
    const h = harness({ send: daemon })
    await h.app.onKey("\x1bOQ")
    expect(h.sent.find((command) => command.type === "session.model.set")).toBeUndefined()
    expect(h.text().some((row) => row.includes("no other model to cycle to"))).toBe(true)
    await h.app.onKey("\x1bOR")
    expect(h.sent.filter((command) => command.type === "session.model.set").at(-1)).toMatchObject({ choice: { model: "gpt-6-luna", effort: "low" } })
  })

  test("model cycling is pure and skips engines that choose their own model", () => {
    expect(nextModelChoice(REPORT)).toEqual({ model: "gpt-6-sol", effort: "high" })
    expect(nextModelChoice({ ...REPORT, effective: { model: "gpt-6-sol", effort: "xhigh" } })).toEqual({ model: "gpt-6-luna", effort: "low" })
    expect(nextEffortChoice(REPORT)).toEqual({ model: "gpt-6-luna", effort: "low" })
    expect(nextModelChoice({ ...REPORT, selectable: false })).toBeUndefined()
    expect(nextEffortChoice({ ...REPORT, selectable: false })).toBeUndefined()
  })

  test("the help page lists the chords", async () => {
    const h = harness()
    for (const key of "/help") await h.app.onKey(key)
    await h.app.onKey("\r")
    expect(h.text().some((row) => row.includes("ctrl+x n"))).toBe(true)
  })

  test("the keymap does not take keys while a popup or a request owns them", async () => {
    const h = harness()
    await h.app.onKey("/")
    await h.app.onKey("\x14")
    h.app.render()
    expect(h.text().some((row) => row.includes("open") && row.includes("Info"))).toBe(false)
  })
})

describe("session widgets dock", () => {
  test("ctrl+t opens the dock above the prompt with todos, subagents and info; ctrl+t closes it", async () => {
    const h = harness({ send: daemon })
    h.app.applySettings({})
    await Bun.sleep(10)
    const todo = ids("item")
    h.ev({ type: "item.started", turnId: h.turnId, itemId: todo, kind: "tool_call", meta: { tool: "todo" } })
    h.ev({ type: "item.completed", itemId: todo, status: "ok", text: "[x] write the test\n[~] wire the app\n[ ] ship it" })
    const task = ids("item")
    h.ev({ type: "item.started", turnId: h.turnId, itemId: task, kind: "tool_call", meta: { tool: "task: explore the repo" } })
    await h.app.onKey("\x14")
    const rows = h.text()
    expect(rows.some((row) => row.includes("Todos") && row.includes("2 open"))).toBe(true)
    expect(rows.some((row) => row.includes("✓ write the test"))).toBe(true)
    expect(rows.some((row) => row.includes("▸ wire the app"))).toBe(true)
    expect(rows.some((row) => row.includes("Subagents"))).toBe(true)
    expect(rows.some((row) => row.includes("Info"))).toBe(true)
    expect(rows.some((row) => row.includes("GPT-6-Luna · high"))).toBe(true)
    await h.app.onKey("\x14")
    expect(h.text().some((row) => row.includes("2 open"))).toBe(false)
  })

  test("minimal has no dock", async () => {
    const h = harness({ mode: "minimal" })
    h.message()
    await h.app.onKey("\x14")
    expect(h.text().some((row) => row.includes("open") && row.includes("Info"))).toBe(false)
  })
})

describe("exit summary", () => {
  test("names the session, its tokens, turns and how long it ran; empty when nothing happened", () => {
    let now = NOW
    const h = harness({ now: () => now })
    expect(h.app.exitSummary()).toBe("")
    h.ev({ type: "turn.started", turnId: h.turnId, queueId: ids("queue") })
    h.ev({ type: "usage.recorded", turnId: h.turnId, provider: "p", model: "gpt-6-luna", input: 1_000, output: 200, reasoning: 50, cacheRead: 30_000, cacheWrite: 0 })
    h.ev({ type: "turn.completed", turnId: h.turnId })
    h.app.onGlobal({ type: "session.activity", gseq: 1, at: NOW, sessionId: h.sessionId, directory: "/x", title: "Fix tests", state: "idle", updatedAt: NOW } as never)
    now += 125_000
    const summary = h.app.exitSummary()
    expect(summary).toContain("MendCode · Fix tests")
    expect(summary).toContain("GPT-6-Luna · ↑31K ↓250 · 1 turn · 2m 5s")
    expect(summary).toContain(`--session ${h.sessionId}`)
  })
})

describe("recipes on /model", () => {
  const recipes = {
    recipes: [
      { name: "fast", file: "/r/fast.json", source: "user", description: "cheap and quick", roles: { main: { model: "gpt-6-luna" } } },
      { name: "deep", file: "/r/deep.json", source: "project", description: "slow and careful", roles: { main: { model: "gpt-6-sol", effort: "xhigh" } } },
    ],
    active: "deep",
  } as never

  test("the recipe row shows the active recipe and its description; ←→ cycle and Enter applies", () => {
    const recipeRow = MODEL_PAGE_ROWS.length
    const at = { row: recipeRow }
    const lines = renderModelPage({ state: at, report: REPORT, recipes, width: 110, height: 40 }).map(plain)
    expect(lines.some((row) => row.includes("recipe") && row.includes("‹ deep › active"))).toBe(true)
    expect(lines.some((row) => row.includes("slow and careful"))).toBe(true)
    const next = modelPageKey(at, "\x1b[C", REPORT, recipes)
    expect(next.state).toEqual({ row: recipeRow, recipe: 0 })
    expect(next.action).toEqual({ type: "none" })
    expect(modelPageKey(next.state, "\r", REPORT, recipes).action).toEqual({ type: "recipe", name: "fast" })
    expect(modelPageKey({ row: recipeRow }, "\x1b[D", REPORT, recipes).state).toEqual({ row: recipeRow, recipe: 0 })
  })

  test("Enter on another row still closes, and without recipes there is no recipe row", () => {
    const lastRole = MODEL_PAGE_ROWS.length - 1
    expect(modelPageKey(createModelPageState(), "\r", REPORT, recipes).action).toEqual({ type: "close" })
    expect(modelPageKey({ row: lastRole }, "\x1b[B", REPORT).state.row).toBe(lastRole)
    expect(modelPageKey({ row: lastRole }, "\x1b[B", REPORT, recipes).state.row).toBe(MODEL_PAGE_ROWS.length)
  })

  test("no recipes says how to add one, and Enter does nothing there", () => {
    const none = { recipes: [] } as never
    const lines = renderModelPage({ state: { row: MODEL_PAGE_ROWS.length }, report: REPORT, recipes: none, width: 110, height: 40 }).map(plain)
    expect(lines.some((row) => row.includes("no recipes · add recipes/<name>.json"))).toBe(true)
    expect(modelPageKey({ row: MODEL_PAGE_ROWS.length }, "\r", REPORT, none).action).toEqual({ type: "none" })
  })

  test("in the app: /model loads the recipes, Enter applies through recipes.apply and toasts", async () => {
    const h = harness({ send: (command) => (command.type === "recipes.list" || command.type === "recipes.apply" ? { ok: true, result: recipes } : daemon(command)) })
    for (const key of "/model roles") await h.app.onKey(key)
    await h.app.onKey("\r")
    await Bun.sleep(10)
    expect(h.sent.find((command) => command.type === "recipes.list")).toMatchObject({ directory: "/Users/dev/work/app" })
    for (let i = 0; i < MODEL_PAGE_ROWS.length; i++) await h.app.onKey("\x1b[B")
    await h.app.onKey("\r")
    await Bun.sleep(10)
    expect(h.sent.find((command) => command.type === "recipes.apply")).toMatchObject({ name: "deep" })
    expect(h.text().some((row) => row.includes("recipe: deep"))).toBe(true)
  })
})

describe("fork", () => {
  test("the palette has Fork session and Side chat; each forks and switches to the new session", async () => {
    const h = harness({ send: (command) => (command.type === "session.fork" ? { ok: true, result: { sessionId: "forked-1", copied: 3 } } : daemon(command)) })
    await h.app.onKey("\x10")
    await Bun.sleep(5)
    for (const key of "Side chat") await h.app.onKey(key)
    await h.app.onKey("\r")
    await Bun.sleep(5)
    expect(h.sent.find((command) => command.type === "session.fork")).toMatchObject({ sessionId: h.sessionId, readOnly: true })
    expect(h.app.sessionId).toBe("forked-1")
    await h.app.onKey("\x10")
    await Bun.sleep(5)
    for (const key of "Fork session") await h.app.onKey(key)
    await h.app.onKey("\r")
    await Bun.sleep(5)
    const forks = h.sent.filter((command) => command.type === "session.fork")
    expect(forks).toHaveLength(2)
    expect(forks[1]).not.toHaveProperty("readOnly")
  })
})
