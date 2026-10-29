import { afterAll, describe, expect, test } from "bun:test"
import type { SessionEvent } from "@mendcode/protocol"
import { memoryToast } from "../src/view/memory-notice"
import { renderToast, renderToastRow, toastSpot } from "../src/view/toast"
import { createTranscript } from "../src/view/transcript"
import { DEFAULT_TUI_PROFILE, writeTuiProfile } from "../src/view/tui-profile"
import { SIDEBAR_PRESETS } from "../src/view/sidebar-spec"
import { textWidth } from "../src/view/wrap"
import type { Line } from "../src/ui/theme"
import { appHarness, cleanTemps, conversation, ids, NOW, plain, tempDir } from "./session-ui-harness"

afterAll(cleanTemps)

const REQUEST = "dame respuesta con una tabla, un bloque de código y una lista de tareas"
const SHORT = "Listo: tabla, bloque de código y lista de tareas."
const RICH = "| Preferencia | La aplicaré |\n|---|---|\n| Formato | Tabla, bloque de código y lista de tareas |\n\n```ts\nconst listo = true\n```\n\n- [x] Tabla\n- [ ] Lista de tareas"
/** Taller than any test screen: the message scrolls out of view and its pinned row takes the second row. */
const LONG = Array.from({ length: 90 }, (_, index) => `- [ ] tarea ${index + 1}`).join("\n")
const FACT = "Formato: Tabla, bloque de código y lista de tareas / Idioma: Español"
const saved = { type: "memory.changed", gseq: 1, at: NOW, memoryId: "mem_demo", change: "added", scope: "project", status: "saved", text: FACT } as never

function scene(width: number, height: number, options: { panel?: boolean; turns?: number; answer?: string } = {}) {
  const dataDir = tempDir(), directory = tempDir()
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, sidebarWidgets: options.panel ? structuredClone(SIDEBAR_PRESETS.focus) as never : [], rightSidebar: options.panel === true })
  const h = appHarness({ width, height, directory, dataDir, mode: "full", now: () => NOW })
  const chat = conversation(h.sessionId, (event) => h.app.onEvent(event))
  for (let turn = 0; turn < (options.turns ?? 0); turn++) chat.exchange(`earlier question ${turn + 1} about the project layout`, `Earlier answer ${turn + 1}: views live under apps/cli/src/view and every view has its own test file.`)
  chat.exchange(REQUEST, options.answer ?? SHORT)
  h.app.render()
  return h
}

/** The rows that carry the user's message (the pinned one included): the toast must leave each of them as it was. */
const messageRows = (rows: string[]) => rows.filter((row) => /›\s+dame respuesta/.test(row))

describe("memory toast text", () => {
  test("a save names the scope and the first 60 characters, with the undo; edits and removals say so too", () => {
    expect(memoryToast({ change: "added", scope: "project", status: "saved", text: FACT })).toEqual({ title: "Memory saved", message: `project · "${FACT.slice(0, 60)}…"`, variant: "success", hint: "/memory undo" })
    expect(memoryToast({ change: "updated", scope: "user", status: "saved", text: "Use bun" })).toMatchObject({ title: "Memory updated", message: `user · "Use bun"` })
    expect(memoryToast({ change: "deleted", scope: "user", status: "saved", text: "Use bun" })).toMatchObject({ title: "Memory removed", message: `user · "Use bun"` })
  })

  test("never a bare title: no text, a link, a proposal or an archived memory show nothing", () => {
    expect(memoryToast({ change: "added" })).toBeUndefined()
    expect(memoryToast({ change: "added", scope: "user", status: "saved", text: "  " })).toBeUndefined()
    expect(memoryToast({ change: "linked", scope: "user", status: "saved", text: "x" })).toBeUndefined()
    expect(memoryToast({ change: "added", scope: "user", status: "pending", text: "x" })).toBeUndefined()
    expect(memoryToast({ change: "updated", scope: "user", status: "archived", text: "x" })).toBeUndefined()
  })
})

describe("toast placement", () => {
  const body = (rows: string[]): Line[] => rows.map((row) => [{ text: row }])
  const box = renderToast({ variant: "success", title: "Memory saved", message: "project", hint: "/memory undo" }, 60)

  test("the hint is a muted row of its own; the one-line form keeps it whole when the message is cut", () => {
    expect(box.map((row) => row.map((span) => span.text).join("")).some((row) => row.includes("/memory undo"))).toBe(true)
    expect(box.flat().find((span) => span.text.includes("/memory undo"))).toMatchObject({ fg: "muted" })
    const row = renderToastRow({ variant: "success", title: "Memory saved", message: `project · "${"x".repeat(80)}"`, hint: "/memory undo" }, 40, 2)
    const text = row.map((span) => span.text).join("")
    expect(textWidth(text)).toBeLessThanOrEqual(40)
    expect(text).toEndWith(" · /memory undo")
    expect(text).toContain("…")
  })

  test("the toast takes the first empty place below the top rows and never text", () => {
    const rows = body(["top bar", "pinned prompt", "ab", "ab", "ab", "ab", "ab", "ab", "ab", "ab"])
    const spot = toastSpot({ rows, top: 2, bottom: 10, box, width: 60 })
    expect(spot).toEqual({ row: 2, col: 60 - 2 - textWidth(box[0]!.map((span) => span.text).join("")) })
    // Text across the width pushes it down; a fully written body leaves no place.
    const wide = "w".repeat(60)
    expect(toastSpot({ rows: body(["top", "pin", wide, ...Array(8).fill("ab")]), top: 2, bottom: 11, box, width: 60 })?.row).toBe(3)
    expect(toastSpot({ rows: body(Array(12).fill(wide)), top: 2, bottom: 12, box, width: 60 })).toBeUndefined()
    // Rows above `top` (the top bar and the pinned prompt) are never offered.
    expect(toastSpot({ rows, top: 8, bottom: 10, box, width: 60 })).toBeUndefined()
  })

  test("a filled row is not empty even where it has no text", () => {
    const tinted: Line[] = [[{ text: " ".repeat(60), bg: "promptBg" }]]
    const rows = [...tinted, ...tinted, ...tinted, ...tinted, ...tinted, ...tinted]
    expect(toastSpot({ rows, top: 0, bottom: 6, box, width: 60 })).toBeUndefined()
  })
})

describe("memory notice in the app", () => {
  const sizes = [[60, 20], [100, 30], [200, 60]] as const
  for (const [width, height] of sizes) for (const panel of width === 200 ? [false, true] : [false]) for (const [name, answer, turns] of [["short answer", SHORT, 0], ["rich answer", RICH, 0], ["long history", SHORT, 8], ["answer taller than the screen (pinned prompt)", LONG, 0]] as const) {
    test(`${width}x${height}${panel ? " with the right panel" : ""}, ${name}: it says what was saved and never covers the user's message`, () => {
      const h = scene(width, height, { panel, turns, answer })
      const before = h.text()
      h.app.onGlobal(saved)
      h.app.render()
      const rows = h.text()
      const shown = rows.join("\n")
      expect(shown).toContain("Memory saved")
      expect(shown).toContain("project")
      expect(shown).toContain("/memory undo")
      // The top bar and every row that carries the message (the pinned row too) are exactly as they were.
      expect(rows[0]).toBe(before[0]!)
      // A rich answer on a 60x20 screen scrolls the whole message out; the notice row then costs the transcript one row and the pinned row appears. The others show the message.
      if (!(width === 60 && name === "rich answer")) {
        expect(messageRows(before).length).toBeGreaterThan(0)
        expect(messageRows(rows)).toEqual(messageRows(before))
      }
      if (name.includes("pinned")) expect(rows[1]).toBe(before[1]!)
    })
  }

  for (const [width, height] of sizes) test(`${width}x${height}: a memory toast lies over the prompt's rule, never a box or a row of its own`, () => {
    const h = scene(width, height, { turns: 8, answer: RICH })
    h.app.onGlobal(saved)
    h.app.render()
    const rows = h.text()
    const at = rows.findIndex((row) => row.includes("Memory saved"))
    expect(at).toBeGreaterThan(0)
    expect(rows[at]).toContain(`Memory saved · project · "Formato`)
    expect(rows[at]!.replace(/[─\s]+$/, "")).toEndWith("/memory undo")
    expect(rows.filter((row) => row.includes("Memory saved"))).toHaveLength(1)
    expect(rows.some((row) => row.includes("┃") && row.includes("Memory"))).toBe(false)
    expect(rows[at]).toContain("─")
    // Nothing moved: the screen has the rows it had before the notice came.
    expect(rows.length).toBe(height)
  })

  test("a write the open transcript is about to show gets no toast: its row is the notice, and a toast already up gives way to it", () => {
    const h = scene(100, 30)
    const turnId = ids("turn"), itemId = ids("item")
    h.app.onEvent({ type: "item.started", sessionId: h.sessionId, seq: 900, at: NOW, turnId, itemId, kind: "tool_call", meta: { tool: "memory" } } as SessionEvent)
    h.app.onGlobal(saved)
    h.app.render()
    expect(h.text().join("\n")).not.toContain("Memory saved")
    // An extractor save for this session: the toast shows, then the row arrives and replaces it.
    const other = scene(100, 30)
    other.app.onGlobal(saved)
    other.app.render()
    expect(other.text().join("\n")).toContain("Memory saved")
    other.app.onEvent({ type: "item.started", sessionId: other.sessionId, seq: 900, at: NOW, turnId, itemId, kind: "artifact" } as SessionEvent)
    other.app.onEvent({ type: "item.completed", sessionId: other.sessionId, seq: 901, at: NOW, itemId, status: "ok", text: `Memory  saved · project · "${FACT.slice(0, 60)}…"`, meta: { memorySaved: true, memoryChange: "saved", memoryId: "mem_demo", memoryScope: "project", memoryText: FACT } } as SessionEvent)
    other.app.render()
    // One notice, not two: the row stands, the toast is gone.
    const notices = other.text().filter((row) => /Memory\s+saved/.test(row))
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatch(/^\s*Memory {2}saved · project · "Formato.*\/memory undo\s*$/)
    expect(notices[0]).not.toContain("Memory saved ·")
  })

  test("a toast with a page open is the same single row of text, not the memory transcript", async () => {
    const h = scene(100, 30)
    await h.type("/help\r")
    h.app.onGlobal(saved)
    h.app.render()
    expect(h.text().join("\n")).toContain("Memory saved")
  })

  test("short toasts are one row; only a message that needs more lines is boxed, and then covers nothing", () => {
    for (const [width, height] of sizes) {
      const h = scene(width, height, { turns: 3, answer: LONG })
      const before = h.text()
      h.app.onGlobal({ type: "release.available", gseq: 2, at: NOW, version: "9.9.9", channel: "stable", installed: false } as never)
      h.app.render()
      const short = h.text()
      expect(short.some((row) => row.includes("9.9.9") && !row.includes("┃"))).toBe(true)
      expect(short.some((row) => row.includes("9.9.9") && row.includes("┃ "))).toBe(false)
      const detail = `${"The extension could not load its module. ".repeat(4)}\nat load (module.ts:12)`
      h.app.onGlobal({ type: "extension.feedback", gseq: 3, at: NOW, extension: "demo", text: detail, level: "error" } as never)
      h.app.render()
      const rows = h.text()
      // A box where it covers nothing; on a screen with no such place (60 columns of list) the notice row, still not over text.
      expect(rows.some((row) => row.includes("demo"))).toBe(true)
      if (width > 60) expect(rows.some((row) => row.includes("┃") && row.includes("demo"))).toBe(true)
      expect(rows[0]).toBe(before[0]!)
      expect(messageRows(rows)).toEqual(messageRows(before))
    }
  })

  test("every toast shares one render path, so another one (a release notice) follows the same rule", () => {
    for (const [width, height] of sizes) for (const answer of [SHORT, LONG]) {
      const h = scene(width, height, { turns: 3, answer })
      const before = h.text()
      h.app.onGlobal({ type: "release.available", gseq: 2, at: NOW, version: "9.9.9", channel: "stable", installed: false } as never)
      h.app.render()
      const rows = h.text()
      expect(rows.join("\n")).toContain("9.9.9")
      expect(rows[0]).toBe(before[0]!)
      expect(messageRows(rows)).toEqual(messageRows(before))
    }
  })

  test("removing and updating say what changed", () => {
    const h = scene(100, 30)
    h.app.onGlobal({ ...(saved as object), change: "updated", memoryId: "mem_other", text: "Use bun" } as never)
    h.app.render()
    expect(h.text().join("\n")).toContain("Memory updated")
    h.app.onGlobal({ ...(saved as object), change: "deleted", memoryId: "mem_other", text: "Use bun" } as never)
    h.app.render()
    const shown = h.text().join("\n")
    expect(shown).toContain("Memory removed")
    expect(shown).toContain(`project · "Use bun"`)
  })

  test("a follow-up update right after a save is one toast", () => {
    const h = scene(100, 30)
    h.app.onGlobal(saved)
    h.app.onGlobal({ ...(saved as object), change: "updated" } as never)
    h.app.render()
    const shown = h.text().join("\n")
    expect(shown).toContain("Memory saved")
    expect(shown).not.toContain("Memory updated")
  })
})

describe("memory card and undo", () => {
  let next = 100
  const write = (h: ReturnType<typeof scene>, input: { change: string; id: string; text: string; scope?: string }) => {
    const turnId = ids("turn"), itemId = ids("item")
    const seq = (next += 2)
    h.app.onEvent({ type: "item.started", sessionId: h.sessionId, seq, at: NOW, turnId, itemId, kind: "tool_call", meta: { tool: "memory" } } as SessionEvent)
    h.app.onEvent({
      type: "item.completed", sessionId: h.sessionId, seq: seq + 1, at: NOW, itemId, status: "ok",
      text: `Memory  ${input.change} · ${input.scope ?? "project"} · "${input.text.slice(0, 60)}"`,
      meta: { memorySaved: true, memoryChange: input.change, memoryId: input.id, memoryScope: input.scope ?? "project", memoryText: input.text },
    } as SessionEvent)
    h.app.render()
    return itemId
  }

  test("the transcript gets one muted row per write; opened it shows the whole text", () => {
    const transcript = createTranscript({ now: () => NOW })
    const sessionId = ids("session"), turnId = ids("turn"), itemId = ids("item")
    const long = `${"Always answer with a table, a code block and a task list. ".repeat(3)}Done.`
    transcript.apply({ type: "item.started", sessionId, seq: 1, at: NOW, turnId, itemId, kind: "tool_call", meta: { tool: "memory" } } as SessionEvent)
    transcript.apply({ type: "item.completed", sessionId, seq: 2, at: NOW, itemId, status: "ok", text: `Memory  saved · project · "${long.slice(0, 60)}…"`, meta: { memorySaved: true, memoryChange: "saved", memoryId: "mem_a", memoryScope: "project", memoryText: long } } as SessionEvent)
    for (const mode of ["balanced", "full", "minimal"] as const) {
      transcript.setMode(mode)
      const rows = transcript.viewport(100, 20).filter((line) => line.text.trim())
      expect(rows).toHaveLength(1)
      expect(rows[0]!.text.trimStart()).toStartWith(`Memory  saved · project · "Always answer`)
      expect(rows[0]!.spans.find((span) => span.text.includes("Memory"))).toMatchObject({ fg: "muted", dim: true })
      expect(rows[0]!.fold).toBeDefined()
    }
    transcript.setMode("balanced")
    transcript.toggleDetails(itemId)
    const opened = transcript.viewport(100, 20).filter((line) => line.text.trim())
    expect(opened.length).toBeGreaterThan(1)
    expect(opened.map((line) => line.text.trim()).slice(1).join(" ")).toContain("Done.")
  })

  test("the undo hint sits muted at the right edge of a save's row, and only a save has one", () => {
    const transcript = createTranscript({ now: () => NOW })
    const sessionId = ids("session"), turnId = ids("turn")
    let seq = 0
    for (const change of ["saved", "updated", "removed"]) {
      const itemId = ids("item")
      transcript.apply({ type: "item.started", sessionId, seq: ++seq, at: NOW, turnId, itemId, kind: "tool_call", meta: { tool: "memory" } } as SessionEvent)
      transcript.apply({ type: "item.completed", sessionId, seq: ++seq, at: NOW, itemId, status: "ok", text: `Memory  ${change} · project · "Use bun"`, meta: { memorySaved: true, memoryChange: change, memoryId: `mem_${change}`, memoryScope: "project", memoryText: "Use bun" } } as SessionEvent)
    }
    const rows = transcript.viewport(80, 20).filter((line) => line.text.trim())
    expect(rows).toHaveLength(3)
    expect(rows[0]!.text).toMatch(/^\s*Memory {2}saved · project · "Use bun" {3,}\/memory undo$/)
    expect(rows[0]!.text.length).toBeGreaterThanOrEqual(78)
    expect(rows[0]!.spans.at(-1)).toMatchObject({ fg: "muted", dim: true })
    expect(rows[1]!.text).not.toContain("/memory undo")
    expect(rows[2]!.text).not.toContain("/memory undo")
    // Too narrow for both: the text is cut and the hint stays whole.
    const narrow = transcript.viewport(36, 20).filter((line) => line.text.trim())[0]!.text
    expect(narrow).toEndWith("/memory undo")
    expect(narrow).toContain("…")
  })

  const orientation = (injected: boolean) => {
    const transcript = createTranscript({ now: () => NOW })
    const sessionId = ids("session"), turnId = ids("turn"), itemId = ids("item")
    transcript.apply({ type: "item.started", sessionId, seq: 1, at: NOW, turnId, itemId, kind: "tool_call", meta: { tool: "graph_map", ...(injected ? { injected: true } : {}) } } as SessionEvent)
    transcript.apply({ type: "item.completed", sessionId, seq: 2, at: NOW, itemId, status: "ok", text: "2394 files, 9000 symbols\nDirectories (depth 1):\napps/  1200 files  ts 1200\nHub symbols (most callers):\nrender  src/a.ts:1  callers:40", meta: { files: 2394, symbols: 9000, directories: 7, hubs: 1, partial: false } } as SessionEvent)
    return { transcript, itemId }
  }

  test("the engine's injected code map is one muted row until opened (balanced; the full view opens it, see code-map-card.test.ts); a map the model asked for keeps its card", () => {
    for (const mode of ["balanced", "full"] as const) {
      const injected = orientation(true)
      injected.transcript.setMode(mode)
      // The full view's card starts open: a click folds it into the row, and from there the balanced steps follow.
      if (mode === "full") injected.transcript.toggleDetails(injected.itemId)
      const rows = injected.transcript.viewport(100, 30).filter((line) => line.text.trim())
      expect(rows).toHaveLength(1)
      expect(rows[0]!.text).toMatch(/^\s*Code map · 7 dirs · 2,394 files +click or ctrl\+o to open$/)
      expect(rows[0]!.fold).toBeDefined()
      expect(rows[0]!.spans.every((span) => !span.text.trim() || span.dim === true)).toBe(true)
      injected.transcript.toggleDetails(injected.itemId)
      const opened = injected.transcript.viewport(100, 30).filter((line) => line.text.trim())
      expect(opened.length).toBeGreaterThan(1)
      expect(opened.map((line) => line.text).join("\n")).toContain("callers")
      expect(opened.map((line) => line.text).join("\n")).not.toContain("click or ctrl+o to open")
      const asked = orientation(false)
      asked.transcript.setMode(mode)
      const card = asked.transcript.viewport(100, 30).filter((line) => line.text.trim())
      expect(card.map((line) => line.text).join("\n")).not.toContain("click or ctrl+o to open")
      asked.transcript.toggleDetails(asked.itemId)
      expect(asked.transcript.viewport(100, 30).filter((line) => line.text.trim()).length).toBeGreaterThan(1)
    }
  })

  test("/memory undo deletes the newest save of this session, then the one before it", async () => {
    const h = scene(100, 30)
    write(h, { change: "saved", id: "mem_first", text: "Use bun" })
    write(h, { change: "updated", id: "mem_first", text: "Use bun test" })
    write(h, { change: "saved", id: "mem_second", text: "Reply in Spanish" })
    await h.type("/memory undo\r")
    expect(h.sentOf("memory.delete").map((command) => (command as { memoryId: string }).memoryId)).toEqual(["mem_second"])
    await h.type("/memory undo\r")
    expect(h.sentOf("memory.delete").map((command) => (command as { memoryId: string }).memoryId)).toEqual(["mem_second", "mem_first"])
    await h.type("/memory undo\r")
    expect(h.sentOf("memory.delete")).toHaveLength(2)
    expect(h.text().join("\n")).toContain("No memory saved in this session to undo")
  })

  test("/memory undo with nothing saved says so and sends nothing", async () => {
    const h = scene(100, 30)
    await h.type("/memory undo\r")
    expect(h.sentOf("memory.delete")).toHaveLength(0)
    expect(h.text().join("\n")).toContain("No memory saved in this session to undo")
  })

  test("a card for an update or a removal is not offered to undo", async () => {
    const h = scene(100, 30)
    write(h, { change: "removed", id: "mem_gone", text: "Old fact" })
    write(h, { change: "updated", id: "mem_edit", text: "New fact" })
    await h.type("/memory undo\r")
    expect(h.sentOf("memory.delete")).toHaveLength(0)
    expect(plain(h.frames.at(-1)![0] ?? [])).not.toBe("")
  })
})
