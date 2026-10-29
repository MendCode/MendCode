import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { RewindReport, TimelineEntry } from "@mendcode/protocol"
import type { CommandReply } from "@mendcode/client"
import { defaultExportName, parseExportArgs, titleSlug, writeExport } from "../src/ui/export-file"
import { isRewindConflict, renderRewindCard, rewindRows } from "../src/view/rewind-card"
import { appHarness, cleanTemps, conversation, ids, NOW, plain, tempDir } from "./session-ui-harness"

afterAll(cleanTemps)

const asReply = (reply: unknown) => reply as CommandReply

const report = (over: Partial<RewindReport> = {}): RewindReport => ({
  turnIds: [ids("turn")],
  files: { restored: ["src/a.ts", "src/b.ts"], removed: ["new.ts"], skipped: [{ path: "big.bin", reason: "too_large" }] },
  history: { messages: 3, tracked: true },
  shellUntracked: true,
  notes: ["context stays compact"],
  ...over,
})

describe("/undo and /redo", () => {
  test("the report shows files restored and removed, skipped files, untracked shell changes and the history", async () => {
    const h = appHarness({ reply: (command) => (command.type === "session.undo" ? asReply({ ok: true, result: report() }) : undefined) })
    const chat = conversation(h.sessionId, (event) => h.app.onEvent(event))
    chat.exchange("first question", "first answer")
    chat.exchange("second question", "second answer")
    await h.type("/undo\r")
    expect(h.sentOf("session.undo")).toEqual([{ type: "session.undo", sessionId: h.sessionId }])
    const rows = h.text().join("\n")
    expect(rows).toContain("undone · 1 turn")
    expect(rows).toContain("restored  2 files: src/a.ts, src/b.ts")
    expect(rows).toContain("removed   1 file: new.ts")
    expect(rows).toContain("skipped   big.bin (too large)")
    expect(rows).toContain("the turn ran shell commands")
    expect(rows).toContain("3 model messages taken out")
    expect(rows).toContain("context stays compact")
    await h.type("\x1b")
    expect(h.text().join("\n")).not.toContain("undone · 1 turn")
  })

  test("with a prompt of several rows the card ends above the prompt and every prompt row stays visible", async () => {
    const h = appHarness({ width: 100, height: 40, reply: (command) => (command.type === "session.undo" ? asReply({ ok: true, result: report() }) : undefined) })
    const chat = conversation(h.sessionId, (event) => h.app.onEvent(event))
    chat.exchange("first question", "first answer")
    await h.type("/undo\r")
    await h.type("\x1b[200~line one of the draft\nline two of the draft\nline three of the draft\nline four of the draft\x1b[201~")
    const rows = h.text()
    const card = rows.findIndex((row) => row.includes("undone · 1 turn"))
    const first = rows.findIndex((row) => row.includes("line one of the draft"))
    expect(card).toBeGreaterThanOrEqual(0)
    for (const line of ["line one", "line two", "line three", "line four"]) expect(rows.some((row) => row.includes(`${line} of the draft`))).toBe(true)
    const cardEnd = rows.findIndex((row, index) => index > card && row.includes("╰"))
    expect(cardEnd).toBeLessThan(first - 1)
  })

  test("an engine that keeps its own history says so instead of counting messages", () => {
    const rows = rewindRows("undo", report({ history: { messages: 0, tracked: false }, shellUntracked: false, files: { restored: [], removed: [], skipped: [] } }))
    expect(rows.map((row) => `${row.label} ${row.text}`)).toEqual(["files none changed", "history the engine still remembers this turn", "note context stays compact"])
    const repeated = rewindRows("undo", report({ history: { messages: 0, tracked: false }, shellUntracked: false, files: { restored: [], removed: [], skipped: [] }, notes: ["The model's history lives in an external engine: it still remembers the turn."] }))
    expect(repeated.map((row) => row.label)).toEqual(["files", "history"])
  })

  test("redo words the same report the other way round", () => {
    const rows = rewindRows("redo", report())
    expect(rows[0]).toMatchObject({ label: "re-applied" })
    expect(rows.find((row) => row.label === "history")!.text).toContain("put back")
  })

  test("a reverted turn leaves the transcript and a thin undone marker; redo brings it back", async () => {
    const h = appHarness()
    const chat = conversation(h.sessionId, (event) => h.app.onEvent(event))
    chat.exchange("first question", "first answer")
    const second = chat.exchange("second question", "second answer")
    expect(h.text().join("\n")).toContain("second answer")
    chat.undo(second.turnId)
    const after = h.text().join("\n")
    expect(after).toContain("first answer")
    expect(after).not.toContain("second question")
    expect(after).not.toContain("second answer")
    expect(h.text().some((row) => row.includes("── undone · 1 message"))).toBe(true)
    chat.redo(second.turnId)
    const back = h.text().join("\n")
    expect(back).toContain("second answer")
    expect(back).not.toContain("undone ·")
  })

  test("files changed after the turn ask before being overwritten: y on an empty prompt sends force", async () => {
    const message = "undo would overwrite changes made after the turn to src/a.ts, notes.md; send force to do it anyway"
    const h = appHarness({
      reply: (command) => {
        if (command.type !== "session.undo") return undefined
        return asReply(command.force ? { ok: true, result: report() } : { ok: false, error: { code: "target_mismatch", message } })
      },
    })
    conversation(h.sessionId, (event) => h.app.onEvent(event)).exchange("first question", "first answer")
    await h.type("/undo\r")
    const asking = h.text().join("\n")
    expect(asking).toContain("undo: files changed since")
    expect(asking).toContain("src/a.ts, notes.md")
    expect(asking).toContain("y overwrite · esc cancel")
    // With text in the prompt, y is just a letter.
    await h.type("x")
    await h.type("y")
    expect(h.sentOf("session.undo")).toHaveLength(1)
    expect(h.app.editor.text).toBe("xy")
    await h.type("\x03")
    expect(h.app.editor.text).toBe("")
    await h.type("y")
    expect(h.sentOf("session.undo")).toHaveLength(2)
    expect(h.sentOf("session.undo")[1]).toMatchObject({ force: true })
    expect(h.text().join("\n")).toContain("undone · 1 turn")
  })

  test("esc cancels the overwrite question and nothing more is sent", async () => {
    const h = appHarness({ reply: (command) => (command.type === "session.redo" ? asReply({ ok: false, error: { code: "target_mismatch", message: "redo would overwrite changes made after the turn to a.ts; send force to do it anyway" } }) : undefined) })
    conversation(h.sessionId, (event) => h.app.onEvent(event)).exchange("q", "a")
    await h.type("/redo\r")
    expect(h.text().join("\n")).toContain("y overwrite · esc cancel")
    await h.type("\x1b")
    await h.type("y")
    expect(h.sentOf("session.redo")).toHaveLength(1)
  })

  test("any other refusal is a toast, not a card", async () => {
    const h = appHarness({ reply: (command) => (command.type === "session.undo" ? asReply({ ok: false, error: { code: "busy", message: "[DAEMON]: a turn is running" } }) : undefined) })
    conversation(h.sessionId, (event) => h.app.onEvent(event)).exchange("q", "a")
    await h.type("/undo\r")
    const rows = h.text().join("\n")
    expect(rows).toContain("a turn is running")
    expect(rows).not.toContain("files changed since")
  })

  test("only the daemon's overwrite refusal counts as a conflict", () => {
    expect(isRewindConflict({ code: "target_mismatch", message: "undo would overwrite changes made after the turn to a.ts; send force to do it anyway" })).toBe(true)
    expect(isRewindConflict({ code: "target_mismatch", message: "nothing to undo" })).toBe(false)
    expect(isRewindConflict({ code: "busy", message: "send force" })).toBe(false)
  })

  test("the card needs room: a short screen draws none", () => {
    expect(renderRewindCard({ card: { kind: "undo", state: "done", report: report() }, width: 100, bottom: 4 })).toBeUndefined()
    expect(renderRewindCard({ card: { kind: "undo", state: "done", report: report() }, width: 24, bottom: 30 })).toBeUndefined()
  })

  test("a new turn closes the undo card", async () => {
    const h = appHarness({ reply: (command) => (command.type === "session.undo" ? asReply({ ok: true, result: report() }) : undefined) })
    const chat = conversation(h.sessionId, (event) => h.app.onEvent(event))
    chat.exchange("first", "a")
    await h.type("/undo\r")
    expect(h.text().join("\n")).toContain("undone · 1 turn")
    chat.exchange("second", "b")
    expect(h.text().join("\n")).not.toContain("undone · 1 turn")
  })

  test("v1 ctrl+x u undoes, ctrl+x r redoes; z stays an undo alias", async () => {
    const h = appHarness({ reply: (command) => (command.type === "session.undo" || command.type === "session.redo" ? asReply({ ok: true, result: report() }) : undefined) })
    conversation(h.sessionId, (event) => h.app.onEvent(event)).exchange("q", "a")
    await h.type("\x18u")
    expect(h.sentOf("session.undo")).toHaveLength(1)
    await h.type("\x18r")
    expect(h.sentOf("session.redo")).toHaveLength(1)
    await h.type("\x18z")
    expect(h.sentOf("session.undo")).toHaveLength(2)
  })
})

const entriesFor = (exchanges: Array<{ turnId: string; itemId: string }>, reverted: number[] = []): TimelineEntry[] =>
  exchanges.map((exchange, index) => ({ turnId: exchange.turnId, itemId: exchange.itemId, at: NOW - (exchanges.length - index) * 60_000, preview: `question ${index + 1}`, reverted: reverted.includes(index) }) as TimelineEntry)

/** /timeline is the tree opened on its messages: the same page, filtered to the open session's own messages. */
describe("/timeline", () => {
  function timelineApp(count = 30, reverted: number[] = []) {
    let entries: TimelineEntry[] = []
    const forked = ids("session")
    const h = appHarness({
      height: 30,
      reply: (command) => {
        if (command.type === "session.timeline") return asReply({ ok: true, result: { entries } })
        if (command.type === "session.fork") return asReply({ ok: true, result: { sessionId: forked, copied: 2, events: 9 } })
        return undefined
      },
    })
    const chat = conversation(h.sessionId, (event) => h.app.onEvent(event))
    const exchanges = Array.from({ length: count }, (_, index) => chat.exchange(`question ${index + 1}`, `answer ${index + 1}`))
    entries = entriesFor(exchanges, reverted)
    return { h, exchanges, forked }
  }

  test("lists the messages with their time, selects the newest, and dims undone ones", async () => {
    const { h } = timelineApp(5, [1])
    await h.type("/timeline\r")
    expect(h.app.page).toBe("tree")
    const rows = h.text()
    expect(rows[0]).toContain("Tree")
    expect(rows.some((row) => row.includes("messages only") && row.includes("5 messages"))).toBe(true)
    expect(rows.some((row) => row.includes("❯") && row.includes("question 5"))).toBe(true)
    expect(rows.some((row) => row.includes("question 2") && row.includes("undone"))).toBe(true)
  })

  test("enter jumps the transcript to the selected message", async () => {
    const { h } = timelineApp()
    expect(h.text().join("\n")).toContain("answer 30")
    await h.type("/timeline\r")
    await h.type("\x1b[H")
    await h.type("\x1b[B")
    await h.type("\x1b[B")
    await h.type("\x1b[B")
    await h.type("\r")
    expect(h.app.page).toBe("chat")
    const rows = h.text()
    expect(rows.some((row) => /question 3\b/.test(row))).toBe(true)
    expect(rows.join("\n")).not.toContain("answer 30")
    // The first message row of the transcript is the chosen one.
    const firstMessage = rows.findIndex((row) => /question \d+/.test(row))
    expect(rows[firstMessage]).toContain("question 3")
  })

  test("an undone message cannot be jumped to", async () => {
    const { h } = timelineApp(4, [0])
    await h.type("/timeline\r")
    await h.type("\x1b[H")
    await h.type("\x1b[B")
    await h.type("\r")
    expect(h.text().join("\n")).toContain("that message was undone")
  })

  test("ctrl+f forks the session at the selected message and switches to the new session", async () => {
    const { h, exchanges, forked } = timelineApp()
    await h.type("/timeline\r")
    await h.type("\x1b[H")
    await h.type("\x1b[B")
    await h.type("\x1b[B")
    await h.type("\x06")
    expect(h.sentOf("session.fork")).toEqual([{ type: "session.fork", sessionId: h.sessionId, atItemId: exchanges[1]!.itemId }])
    expect(h.app.sessionId).toBe(forked)
    expect(h.app.page).toBe("chat")
    expect(h.text().join("\n")).toContain("forked at")
  })

  test("a fork is never sent for an undone message", async () => {
    const { h } = timelineApp(3, [0])
    await h.type("/timeline\r")
    await h.type("\x1b[H")
    await h.type("\x1b[B")
    await h.type("\x06")
    expect(h.sentOf("session.fork")).toHaveLength(0)
    expect(h.text().join("\n")).toContain("that message was undone")
  })

  test("/fork pick opens the same list where enter forks", async () => {
    const { h, exchanges, forked } = timelineApp(6)
    await h.type("/fork pick\r")
    expect(h.app.page).toBe("tree")
    expect(h.text().join("\n")).toContain("enter fork here")
    await h.type("\x1b[A")
    await h.type("\r")
    expect(h.sentOf("session.fork")).toEqual([{ type: "session.fork", sessionId: h.sessionId, atItemId: exchanges[4]!.itemId }])
    expect(h.app.sessionId).toBe(forked)
  })

  test("/fork 2 forks at the second message; a number past the end says how many there are", async () => {
    const { h, exchanges } = timelineApp(3)
    await h.type("/fork 9\r")
    expect(h.sentOf("session.fork")).toHaveLength(0)
    expect(h.text().join("\n")).toContain("this session has 3")
    await h.type("/fork 2\r")
    expect(h.sentOf("session.fork")).toEqual([{ type: "session.fork", sessionId: h.sessionId, atItemId: exchanges[1]!.itemId }])
  })

  test("/fork alone keeps copying the whole session, with no message", async () => {
    const { h } = timelineApp(2)
    await h.type("/fork\r")
    expect(h.sentOf("session.fork")).toEqual([{ type: "session.fork", sessionId: h.sessionId }])
  })
})

describe("/export", () => {
  const exported = (format: "markdown" | "json", text = "# Fix\n\n## User\nhello") => ({ ok: true, result: { format, text, turns: 1, truncated: false } })

  function exportApp(options: { text?: string } = {}) {
    const directory = tempDir("mendcode-export-")
    const h = appHarness({
      directory,
      reply: (command) => (command.type === "session.export" ? asReply(exported(command.format, options.text)) : undefined),
    })
    h.app.onGlobal({ gseq: 1, at: 0, type: "session.activity", sessionId: h.sessionId, directory, title: "Fix the flaky reconnect!", state: "idle", updatedAt: 1 } as never)
    return { h, directory }
  }

  test("writes <title-slug>.md in the project directory by default, then the next free name", async () => {
    const { h, directory } = exportApp()
    await h.type("/export markdown\r")
    expect(h.sentOf("session.export")).toEqual([{ type: "session.export", sessionId: h.sessionId, format: "markdown" }])
    expect(readFileSync(path.join(directory, "fix-the-flaky-reconnect.md"), "utf8")).toBe("# Fix\n\n## User\nhello\n")
    expect(h.text().join("\n")).toContain("exported 1 turn to fix-the-flaky-reconnect.md")
    await h.type("/export markdown\r")
    expect(readdirSync(directory).sort()).toEqual(["fix-the-flaky-reconnect-2.md", "fix-the-flaky-reconnect.md"])
  })

  test("json goes to the path given, creating folders inside the directory; an existing file needs --force", async () => {
    const { h, directory } = exportApp({ text: '{"format":"mendcode-session@1"}' })
    await h.type("/export json notes/run.json\r")
    const file = path.join(directory, "notes", "run.json")
    expect(readFileSync(file, "utf8")).toBe('{"format":"mendcode-session@1"}\n')
    expect(h.sentOf("session.export")[0]).toMatchObject({ format: "json" })
    writeFileSync(file, "keep me")
    await h.type("/export json notes/run.json\r")
    expect(readFileSync(file, "utf8")).toBe("keep me")
    expect(h.text().join("\n")).toContain("exists · add --force to overwrite it")
    await h.type("/export json notes/run.json --force\r")
    expect(readFileSync(file, "utf8")).toBe('{"format":"mendcode-session@1"}\n')
  })

  test("a path outside the directory is refused and nothing is written", async () => {
    const { h, directory } = exportApp()
    await h.type("/export ../escaped.md\r")
    expect(existsSync(path.join(directory, "..", "escaped.md"))).toBe(false)
    expect(h.text().join("\n")).toContain("must be inside the working directory")
    await h.type("/export /etc/mendcode-export-test.md\r")
    expect(existsSync("/etc/mendcode-export-test.md")).toBe(false)
  })

  test("--copy sends the text to the clipboard as an OSC 52 sequence and writes no file", async () => {
    const { h, directory } = exportApp({ text: "hello export" })
    await h.type("/export --copy\r")
    expect(h.written).toEqual([`\x1b]52;c;${Buffer.from("hello export").toString("base64")}\x07`])
    expect(readdirSync(directory)).toEqual([])
    expect(h.text().join("\n")).toContain("copied the markdown export")
  })

  test("--copy of an export too long for one sequence says so and copies nothing", async () => {
    const { h } = exportApp({ text: "x".repeat(80_000) })
    await h.type("/export --copy\r")
    expect(h.written).toEqual([])
    expect(h.text().join("\n")).toContain("too long to copy")
  })

  test("a daemon error is shown and nothing is written", async () => {
    const directory = tempDir("mendcode-export-")
    const h = appHarness({ directory, reply: (command) => (command.type === "session.export" ? asReply({ ok: false, error: { code: "unknown_session", message: "[DAEMON]: unknown session" } }) : undefined) })
    await h.type("/export markdown\r")
    expect(readdirSync(directory)).toEqual([])
    expect(h.text().join("\n")).toContain("unknown session")
  })

  test("a bad option is a usage notice", async () => {
    const { h } = exportApp()
    await h.type("/export --pdf\r")
    expect(h.sentOf("session.export")).toHaveLength(0)
    expect(h.text().join("\n")).toContain("unknown option --pdf")
  })
})

describe("export files", () => {
  test("arguments: format word, path, flags", () => {
    expect(parseExportArgs("")).toEqual({ format: "markdown", copy: false, force: false })
    expect(parseExportArgs("json")).toEqual({ format: "json", copy: false, force: false })
    expect(parseExportArgs("md out/a.md --force")).toEqual({ format: "markdown", copy: false, force: true, path: "out/a.md" })
    expect(parseExportArgs("--copy json")).toEqual({ format: "json", copy: true, force: false })
    expect(parseExportArgs("notes.md")).toEqual({ format: "markdown", copy: false, force: false, path: "notes.md" })
    expect(parseExportArgs("--copy a.md")).toHaveProperty("error")
    expect(parseExportArgs("--nope")).toHaveProperty("error")
  })

  test("the title becomes a file-safe slug", () => {
    expect(titleSlug("Fix the flaky reconnect!")).toBe("fix-the-flaky-reconnect")
    expect(titleSlug("  Añadir caché / más rápido  ")).toBe("anadir-cache-mas-rapido")
    expect(titleSlug("!!!")).toBe("session")
    expect(titleSlug("")).toBe("session")
    expect(titleSlug("x".repeat(200))).toHaveLength(60)
    expect(defaultExportName("Hello world", "json")).toBe("hello-world.json")
  })

  test("a symlink that leaves the directory is refused", () => {
    const root = tempDir("mendcode-export-")
    const outside = tempDir("mendcode-outside-")
    symlinkSync(outside, path.join(root, "link"))
    const result = writeExport({ cwd: root, text: "x", target: "link/out.md", explicit: true, force: false })
    expect(result).toMatchObject({ ok: false })
    expect(existsSync(path.join(outside, "out.md"))).toBe(false)
  })

  test("a directory is not overwritten and a folder inside the project is created", () => {
    const root = tempDir("mendcode-export-")
    mkdirSync(path.join(root, "taken"))
    expect(writeExport({ cwd: root, text: "x", target: "taken", explicit: true, force: true })).toMatchObject({ ok: false })
    expect(writeExport({ cwd: root, text: "x", target: "a/b/c.md", explicit: true, force: false })).toEqual({ ok: true, path: path.join("a", "b", "c.md") })
  })
})
