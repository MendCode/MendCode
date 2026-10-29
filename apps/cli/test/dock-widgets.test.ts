import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import type { CommandReply } from "@mendcode/client"
import { readScratch, SCRATCH_MAX_CHARS, scratchPath, writeScratch } from "../src/ui/scratchpad"
import { DOCK_HEIGHT, dockPanels, parseTodoText, renderDock, type DockInfo, type DockJob } from "../src/view/dock"
import { createEditor } from "../src/view/editor"
import { textWidth } from "../src/view/wrap"
import { appHarness, cleanTemps, conversation, ids, NOW, plain, tempDir } from "./session-ui-harness"

afterAll(cleanTemps)

const asReply = (reply: unknown) => reply as CommandReply
const info: DockInfo = { branch: "main", cwd: "~/Code/app", context: "42%", permission: "ask", model: "gpt-6-luna · low", activity: "idle" }
const todos = parseTodoText("[~] fix the reconnect\n[ ] ship it")
const job = (over: Partial<DockJob> = {}): DockJob => ({ command: "bun run dev", status: "running", startedAt: NOW - 125_000, ...over })
const render = (width: number, extra: Partial<Parameters<typeof renderDock>[0]> = {}) => renderDock({ width, todos, subagents: [], info, ...extra })
const joined = (rows: ReturnType<typeof renderDock>) => rows.map(plain).join("\n")

describe("dock panels", () => {
  test("Questions, Jobs and the scratch note show only when there is something for them", () => {
    const base = { width: 200, todos, subagents: [], info }
    expect(dockPanels(base)).toEqual(["todos", "info"])
    expect(dockPanels({ ...base, scratch: { lines: [""], editing: false } })).toEqual(["todos", "scratch", "info"])
    expect(dockPanels({ ...base, questions: [{ kind: "question", title: "Which file?" }], jobs: [job()], scratch: { lines: ["note"], editing: false }, subagents: [{ label: "x", status: "working", tone: "warning" }] })).toEqual(["todos", "questions", "subagents", "jobs", "scratch", "info"])
    expect(dockPanels({ ...base, scratch: { lines: [""], editing: true } })).toEqual(["todos", "scratch", "info"])
  })

  test("a narrow dock drops panels in order; compact mode keeps one full-width panel", () => {
    const all = { todos, subagents: [{ label: "x", status: "working", tone: "warning" as const }], info, questions: [{ kind: "approval" as const, title: "Run command" }], jobs: [job()], scratch: { lines: ["note"], editing: false } }
    const at = (width: number) => dockPanels({ width, ...all })
    expect(at(200)).toEqual(["todos", "questions", "subagents", "jobs", "scratch", "info"])
    expect(at(150)).toEqual(["todos", "questions", "subagents", "jobs", "info"])
    expect(at(120)).toEqual(["todos", "questions", "subagents", "info"])
    expect(at(90)).toEqual(["todos", "questions", "info"])
    expect(at(60)).toEqual(["todos"])
    expect(at(30)).toEqual(["info"])
  })

  test("Questions lists approvals with ! and questions with ?, with the count on the right", () => {
    const text = joined(render(120, { questions: [{ kind: "approval", title: "Run command" }, { kind: "question", title: "Which file should I edit?" }] }))
    expect(text).toContain("Questions")
    expect(text).toMatch(/Questions\s+2/)
    expect(text).toContain("! Run command")
    expect(text).toContain("? Which file should I edit?")
  })

  test("Jobs shows this session's shell tasks: running ones with their elapsed time, finished ones with their exit status", () => {
    const text = joined(render(140, { now: NOW, jobs: [job(), job({ command: "bun test", status: "exited", exitCode: 0, endedAt: NOW - 1_000 }), job({ command: "make", status: "exited", exitCode: 2 }), job({ command: "sleep 99", status: "killed" })] }))
    expect(text).toContain("Jobs")
    expect(text).toContain("1 running")
    expect(text).toMatch(/• bun run dev\s+2m 5s/)
    expect(text).toMatch(/✓ bun test\s+exit 0/)
    expect(text).toMatch(/× make\s+exit 2/)
    expect(text).toMatch(/× sleep 99\s+killed/)
  })

  test("Scratchpad shows the note and, while it is edited, the cursor and the keys", () => {
    const note = joined(render(120, { scratch: { lines: ["remember the flaky test", "call back"], editing: false } }))
    expect(note).toContain("Scratchpad")
    expect(note).toContain("/scratch")
    expect(note).toContain("remember the flaky test")
    const editing = joined(render(120, { scratch: { lines: ["half a thou"], editing: true } }))
    expect(editing).toContain("half a thou")
    expect(editing).toContain("esc prompt")
    expect(editing).not.toContain("enter saves")
  })

  test("while editing a long note the end of it, where the cursor is, stays visible", () => {
    const lines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`)
    const editor = createEditor()
    editor.replaceAll(lines.join("\n"))
    const text = joined(render(120, { scratch: { lines, editing: true, editor } }))
    expect(text).toContain("line 12")
    expect(text).not.toContain("line 1\n")
  })

  test("every combination is exactly DOCK_HEIGHT rows by the width, on the panel fill", () => {
    const everything = { questions: [{ kind: "approval" as const, title: "Run command" }], jobs: [job()], scratch: { lines: ["note"], editing: false }, subagents: [{ label: "x", status: "working", tone: "warning" as const }], now: NOW }
    for (const width of [30, 60, 90, 120, 160, 200]) {
      const rows = render(width, everything)
      expect(rows).toHaveLength(DOCK_HEIGHT)
      for (const row of rows) expect(textWidth(plain(row))).toBe(width)
      expect(rows.flat().some((span) => span.fg === "border")).toBe(true)
    }
  })
})

describe("scratchpad files", () => {
  test("a note lives in <dataDir>/tui/scratch/<sessionId>.md and reads back whole", () => {
    const dataDir = tempDir()
    expect(scratchPath(dataDir, "ses_abc")).toBe(path.join(dataDir, "tui", "scratch", "ses_abc.md"))
    expect(readScratch(dataDir, "ses_abc")).toBe("")
    expect(writeScratch(dataDir, "ses_abc", "first\nsecond")).toEqual({ ok: true })
    expect(readFileSync(scratchPath(dataDir, "ses_abc"), "utf8")).toBe("first\nsecond")
    expect(readScratch(dataDir, "ses_abc")).toBe("first\nsecond")
    expect(readdirSync(path.join(dataDir, "tui", "scratch"))).toEqual(["ses_abc.md"])
  })

  test("an empty note removes the file; a session id that is not a plain id is refused", () => {
    const dataDir = tempDir()
    writeScratch(dataDir, "ses_abc", "x")
    expect(writeScratch(dataDir, "ses_abc", "  \n ")).toEqual({ ok: true })
    expect(existsSync(scratchPath(dataDir, "ses_abc"))).toBe(false)
    for (const bad of ["../escape", "a/b", "", ".hidden"]) {
      expect(writeScratch(dataDir, bad, "x")).toMatchObject({ ok: false })
      expect(readScratch(dataDir, bad)).toBe("")
    }
    expect(readdirSync(path.join(dataDir, "tui", "scratch"))).toEqual([])
  })

  test("a note is cut to its limit and line endings are unified", () => {
    const dataDir = tempDir()
    writeScratch(dataDir, "ses_long", `a\r\nb${"x".repeat(SCRATCH_MAX_CHARS)}`)
    const back = readScratch(dataDir, "ses_long")
    expect(back).toHaveLength(SCRATCH_MAX_CHARS)
    expect(back.startsWith("a\nb")).toBe(true)
  })
})

describe("the dock in the app", () => {
  test("Questions follows the session's pending approvals and questions", async () => {
    const h = appHarness()
    const chat = conversation(h.sessionId, (event) => h.app.onEvent(event))
    chat.exchange("hello", "hi")
    await h.type("\x14")
    expect(h.text().join("\n")).toContain("Scratchpad")
    expect(h.text().join("\n")).not.toContain("Questions")
    const turnId = ids("turn")
    chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
    const requestId = ids("request")
    chat.emit({ type: "server.request", requestId, turnId, kind: "approval", title: "Run command", detail: "ls -la" })
    const asking = h.text().join("\n")
    expect(asking).toContain("Questions")
    expect(asking).toMatch(/! Run command/)
    chat.emit({ type: "server.request.resolved", requestId, resolution: "approved" })
    expect(h.text().join("\n")).not.toContain("Questions")
  })

  test("Jobs asks for the background tasks when the dock opens and shows only this session's", async () => {
    const other = ids("session")
    let tasks: unknown[] = []
    const h = appHarness({ reply: (command) => (command.type === "background.list" ? asReply({ ok: true, result: { tasks } }) : undefined) })
    conversation(h.sessionId, (event) => h.app.onEvent(event)).exchange("hello", "hi")
    tasks = [
      { id: "bg1", sessionId: h.sessionId, command: "bun run dev", cwd: "/w", status: "running", startedAt: NOW - 65_000 },
      { id: "bg2", sessionId: other, command: "someone else's server", cwd: "/w", status: "running", startedAt: NOW - 5_000 },
      { id: "bg3", sessionId: h.sessionId, command: "bun test", cwd: "/w", status: "exited", exitCode: 1, startedAt: NOW - 90_000, endedAt: NOW - 60_000 },
    ]
    expect(h.sentOf("background.list")).toHaveLength(0)
    await h.type("\x14")
    expect(h.sentOf("background.list")).toHaveLength(1)
    const text = h.text().join("\n")
    expect(text).toContain("Jobs")
    expect(text).toMatch(/• bun run dev\s+1m 5s/)
    expect(text).toMatch(/× bun test\s+exit 1/)
    expect(text).not.toContain("someone else's server")
  })

  const notes = new Map<string, string>()
  function scratchApp(dataDir: string, directory = "/work/app", height = 30) {
    const h = appHarness({ dataDir, directory, height, reply(command) {
      if (command.type === "scratchpad.get") return asReply({ ok: true, result: { text: notes.get(dataDir + command.directory) ?? "" } })
      if (command.type === "scratchpad.set") { notes.set(dataDir + command.directory, command.text); return { ok: true } }
      return undefined
    } })
    conversation(h.sessionId, (event) => h.app.onEvent(event)).exchange("hello", "hi")
    return h
  }

  test("/scratch types inside the tray, Enter adds a line and changes autosave after 500 ms", async () => {
    const h = scratchApp(tempDir())
    await h.type("/scratch\r")
    await h.type("remember the flaky test\rcall back")
    expect(h.app.editor.text).toBe("")
    expect(h.sentOf("scratchpad.set")).toHaveLength(0)
    expect(joined(h.frames.at(-1)!)).not.toContain("enter saves")
    await Bun.sleep(550)
    expect(h.sentOf("scratchpad.set")).toEqual([{ type: "scratchpad.set", directory: "/work/app", text: "remember the flaky test\ncall back" }])
    const cursor = h.cursors.at(-1)!
    expect(h.text()[cursor.row]).toContain("call back")
    expect(h.text()[cursor.row]![cursor.col - 1]).toBe("k")
    expect(h.sentOf("user.submit")).toHaveLength(0)
  })

  test("same project survives another session; projects are isolated; Esc flushes and restores prompt focus", async () => {
    const dataDir = tempDir()
    const first = scratchApp(dataDir)
    await first.type("half a prompt\x18s")
    expect(first.app.editor.text).toBe("half a prompt")
    await first.type("project note\x1b")
    expect(first.app.editor.text).toBe("half a prompt")
    expect(notes.get(dataDir + "/work/app")).toBe("project note")
    await first.type("!")
    expect(first.app.editor.text).toBe("half a prompt!")
    const second = scratchApp(dataDir)
    await second.type("\x14")
    expect(second.text().join("\n")).toContain("project note")
    const other = scratchApp(dataDir, "/work/other")
    await other.type("\x14")
    expect(other.text().join("\n")).not.toContain("project note")
  })

  test("tray editor supports arrows, Home/End, word motion, selection replacement and multiline paste", async () => {
    const h = scratchApp(tempDir())
    await h.type("/scratch\ralpha beta\rgamma")
    await h.app.onKey("\x1b[H")
    await h.app.onKey("\x1bf")
    await h.type("!")
    await h.app.onKey("\x1b[F")
    await h.app.onKey("\x1b[1;2D")
    expect(h.frames.at(-1)!.flat().some((span) => span.bg === "primary")).toBe(true)
    await h.type("X")
    await h.type("\x1b[200~\none\ntwo\x1b[201~")
    await h.app.onKey("\x1b[A")
    await h.app.onKey("\x01")
    await h.type(">")
    await h.type("\x1b")
    expect(h.sentOf("scratchpad.set").at(-1)).toMatchObject({ text: "alpha !beta\ngammX\n>one\ntwo" })
    expect(h.app.editor.text).toBe("")
    expect(h.sentOf("draft.set")).toHaveLength(0)
  })

  test("long note scrolls around a real cursor, shows a mini scrollbar and leaves a padded gap above prompt", async () => {
    const h = scratchApp(tempDir())
    await h.type("/scratch\r")
    await h.type(`\x1b[200~${Array.from({ length: 20 }, (_, i) => `row ${i} ${"long text ".repeat(6)}`).join("\n")}\x1b[201~`)
    const rows = h.text()
    expect(rows.some((row) => row.includes("row 19"))).toBe(true)
    expect(rows.some((row) => row.includes("┃"))).toBe(true)
    const cursor = h.cursors.at(-1)!
    expect(rows[cursor.row]).toContain("│")
    const promptTop = rows.findLastIndex((row) => /─{10}/.test(row)) - 2
    expect(cursor.row).toBeLessThan(promptTop)
    expect(rows[promptTop - 1]!.replace(/│/g, "").trim()).toBe("")
    await h.type("\x1b")
  })

  test("empty scratch panel accepts a click on wide terminals, with sidebar coordinates accounted for", async () => {
    const h = scratchApp(tempDir())
    h.size.width = 180
    await h.type("draft\x14")
    const row = h.text().findIndex((row) => row.includes("Scratchpad"))
    const col = h.text()[row]!.indexOf("Scratchpad")
    await h.type(`\x1b[<0;${col + 1};${row + 2}M`)
    await h.type("clicked note\x1b")
    expect(h.app.editor.text).toBe("draft")
    expect(h.sentOf("scratchpad.set").at(-1)).toMatchObject({ text: "clicked note" })
  })

  test("short and minimal views report that editing needs the tray", async () => {
    const short = scratchApp(tempDir(), "/work/app", 16)
    await short.type("/scratch\r")
    expect(short.text().join("\n")).toContain("scratchpad needs a taller terminal")
    const minimal = appHarness({ dataDir: tempDir(), mode: "minimal" })
    conversation(minimal.sessionId, minimal.app.onEvent).exchange("hello", "hi")
    await minimal.type("/scratch\r")
    expect(minimal.text().join("\n")).toContain("scratchpad needs a taller terminal")
  })
})

test("a failed scratchpad read never overwrites the stored note and can be retried", async () => {
  let failRead = true
  const h = appHarness({ dataDir: tempDir(), directory: "/work/app", reply(command) {
    if (command.type === "scratchpad.get") return failRead ? { ok: false, error: { code: "internal", message: "note unavailable" } } : asReply({ ok: true, result: { text: "kept note" } })
    return undefined
  } })
  conversation(h.sessionId, h.app.onEvent).exchange("hello", "hi")
  await h.type("/scratch\r")
  expect(h.text().join("\n")).toContain("note unavailable")
  await h.type("prompt")
  expect(h.app.editor.text).toBe("prompt")
  expect(h.sentOf("scratchpad.set")).toHaveLength(0)
  h.app.editor.clear()
  failRead = false
  await h.type("/scratch\r")
  expect(h.text().join("\n")).toContain("kept note")
  await h.type("!\x1b")
  expect(h.sentOf("scratchpad.set").at(-1)).toMatchObject({ text: "kept note!" })
})
