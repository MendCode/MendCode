import { afterAll, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import path from "node:path"
import type { BlobRef, HistoryReport, ModelsReport } from "@mendcode/protocol"
import type { CommandReply } from "@mendcode/client"
import { createEditor } from "../src/view/editor"
import { EDIT_KEYS } from "../src/view/editor-actions"
import { createPromptStash, readStash } from "../src/ui/prompt-stash"
import { buildBindings, parseKeybindings } from "../src/extensions/keybindings"
import { keyName, resolveKey } from "../src/ui/keymap"
import { DEFAULT_TUI_PROFILE, writeTuiProfile, readTuiProfile } from "../src/view/tui-profile"
import { firstPlainLine, historyReaderRows, createHistoryState } from "../src/view/history-page"
import { statusItems } from "../src/view/status-items"
import { renderStatusRow } from "../src/view/prompt-chrome"
import { writeModelPrefs } from "../src/view/model-prefs"
import { appHarness, cleanTemps, conversation, ids, NOW, tempDir } from "./session-ui-harness"

afterAll(cleanTemps)
const ok = (result: unknown) => ({ ok: true, result }) as CommandReply

describe("B04 grapheme editor", () => {
  test("shift selections replace text in one undo step and never split emoji", () => {
    const editor = createEditor()
    editor.insert("a👨‍👩‍👧‍👦é")
    editor.key("\x1b[1;2D")
    editor.key("\x1b[1;2D")
    expect(editor.selectedText).toBe("👨‍👩‍👧‍👦é")
    editor.key("Z")
    expect(editor.text).toBe("aZ")
    editor.undo()
    expect(editor.text).toBe("a👨‍👩‍👧‍👦é")
    editor.redo()
    expect(editor.text).toBe("aZ")
  })
  test("buffer and logical line selection cross newlines", () => {
    const editor = createEditor()
    editor.insert("first\nsecond\nthird")
    editor.key("\x1b[1;2H")
    expect(editor.selectedText).toBe("first\nsecond\nthird")
    editor.key("\x04")
    expect(editor.text).toBe("")
    editor.undo()
    editor.key("\x1b[H")
    editor.key("\x1b[101;6u")
    expect(editor.selectedText).toBe("first")
    editor.key("\x1b[1;2B")
    expect(editor.selectedText).toBe("first\nsecon")
  })
  test("visual line boundaries use terminal cells, including wide glyphs", () => {
    const editor = createEditor()
    editor.setVisualWidth(5)
    editor.insert("ab界cdef")
    expect(editor.visualLines().map((line) => line.text)).toEqual(["ab界c", "def"])
    editor.key("\x1ba")
    expect(editor.cursor.col).toBe(4)
    editor.key("\x1bE")
    expect(editor.selectedText).toBe("def")
  })
  test("word selection and deletion work in both directions", () => {
    const editor = createEditor()
    editor.insert("one two three")
    editor.key("\x1bB")
    expect(editor.selectedText).toBe("three")
    editor.key("\x04")
    expect(editor.text).toBe("one two ")
    editor.key("\x1bb")
    editor.key("\x1bd")
    expect(editor.text).toBe("one ")
    editor.key("\x02")
    editor.key("\x06")
    expect(editor.cursor.col).toBe(4)
  })
  test("modified Enter only inserts a newline; delete line, Ctrl-K and Shift-Delete edit", () => {
    const editor = createEditor()
    for (const key of ["\x1b[13;2u", "\x1b[13;5u", "\x1b\r", "\n"]) expect(editor.key(key)).toBe("changed")
    expect(editor.text).toBe("\n\n\n\n")
    editor.replaceAll("alpha\nbeta\ngamma")
    editor.key("\x1b[H")
    editor.key("\x1b[100;6u")
    expect(editor.text).toBe("beta\ngamma")
    editor.key("\x06")
    editor.key("\x0b")
    expect(editor.text).toBe("b\ngamma")
    editor.key("\x1b[3;2~")
    expect(editor.text).toBe("bgamma")
  })
  test("every modified encoding is safely named in help", () => {
    for (const key of Object.keys(EDIT_KEYS)) expect(keyName(key) ?? JSON.stringify(key)).not.toContain("\x1b")
  })
})

test("configurable leader, editing unbinds, and Tab completion take priority over primary cycling", async () => {
  const dir = tempDir()
  const file = { leader: "ctrl+g", "ctrl+b": null, "alt+x": "edit.buffer-home", tab: "agent.next", "shift+tab": "agent.picker", "leader+s": "command:status" }
  const parsed = parseKeybindings(JSON.stringify(file))
  expect(parsed.problems).toEqual([])
  const { bindings } = buildBindings({ file: parsed.entries })
  expect(resolveKey({}, "\x07", 0, bindings)).toEqual({ kind: "armed" })
  expect(bindings.disabled.has("\x02")).toBe(true)
  writeFileSync(path.join(dir, "keybindings.json"), JSON.stringify(file))
  const h = appHarness({ dataDir: dir, reply: (command) => command.type === "agents.list" ? ok({ current: "build", agents: [{ name: "build", trusted: true, mode: "primary" }, { name: "plan", trusted: true, mode: "primary" }, { name: "worker", trusted: true, mode: "subagent" }] }) : undefined })
  await h.type("/btw\t")
  expect(h.app.editor.text).toBe("/btw ")
  expect(h.sentOf("session.agent.set")).toHaveLength(0)
  h.app.editor.clear()
  await h.type("\t")
  expect(h.sentOf("session.agent.set")[0]).toMatchObject({ agent: "plan" })
  await h.type("xyz\x02")
  expect(h.app.editor.cursor.col).toBe(3)
  await h.type("\x1bx")
  expect(h.app.editor.cursor.col).toBe(0)
})

test("stash restores attachments across terminals, swaps a draft, and requires two Ctrl-D presses", async () => {
  const dir = tempDir()
  const blob: BlobRef = { sha256: "a".repeat(64), mime: "image/png", bytes: 32 }
  const h = appHarness({ dataDir: dir, reply: (command) => command.type === "attachment.clipboard" ? ok({ attachment: blob, name: "clipboard.png" }) : undefined })
  await h.type("draft\x16\x18p")
  expect(readStash(dir)[0]?.attachments?.[0]).toMatchObject({ ref: blob })
  const other = appHarness({ dataDir: dir })
  await other.type("/stash\r")
  expect(other.app.page).toBe("stash")
  expect(other.text().join("\n")).toContain("clipboard.png")
  await other.type("\r")
  expect(other.app.editor.text).toBe("draft [Image #1] ")
  await other.type("\r")
  expect(other.sentOf("user.submit")[0]).toMatchObject({ text: "draft [Image #1]", attachments: [{ ...blob, label: "[Image #1]", at: "draft [Image #1]".length }] })
  const stash = createPromptStash({ dataDir: dir })
  stash.push("one")
  stash.push("two")
  const picker = appHarness({ dataDir: dir })
  await picker.type("/stash\r\x04")
  expect(readStash(dir)).toHaveLength(2)
  await picker.type("\x04")
  expect(readStash(dir).map((entry) => entry.text)).toEqual(["one"])
})

test("F2/Shift-F2 cycle recent models without reordering their ring; favorites stay independent", async () => {
  const dir = tempDir()
  writeModelPrefs(dir, { recents: ["a", "b", "c"], favorites: ["a", "c"] })
  writeFileSync(path.join(dir, "keybindings.json"), JSON.stringify({ "alt+m": "model.favorite.next", "alt+M": "model.favorite.previous" }))
  let current = "a"
  const models = (): ModelsReport => ({ engine: "native", selectable: true, models: ["a", "b", "c", "d"].map((id) => ({ id, name: id, provider: "local", efforts: ["medium"] })), defaults: { model: "a" }, effective: { model: current }, roles: {} })
  const h = appHarness({ dataDir: dir, reply: (command) => {
    if (command.type === "session.model.set") current = command.choice?.model ?? current
    if (command.type === "models.list" || command.type === "session.model.set") return ok(models())
    return undefined
  } })
  await h.type("\x1bOQ\x1bOQ")
  expect(current).toBe("c")
  await h.type("\x1b[12;2~")
  expect(current).toBe("b")
  await h.type("\x1bm")
  expect(current).toBe("a")
  await h.type("\x1bM")
  expect(current).toBe("c")
})

test("Ctrl-Z invokes the terminal lifecycle hook without quitting", async () => {
  let suspended = 0
  const h = appHarness({ terminal: { suspend: async (run) => run(), suspendProcess: async () => { suspended++ } } })
  await h.type("\x1a")
  expect(suspended).toBe(process.platform === "win32" ? 0 : 1)
  expect(h.app.page).toBe("chat")
})

test("ordered colored status items retain script separators and prepend on both sides", () => {
  const left = statusItems("mode,model", '{"mode":"#70ffaf"}', { mode: "Build", model: "Atlas" }, " · ")
  expect(left[0]).toMatchObject({ text: "Build", fgHex: "#70ffaf" })
  const row = renderStatusRow({ width: 100, leftItems: left, loops: 1, scriptLeft: [{ text: "branch", prepend: true }, { text: "clean" }], scriptRight: [{ text: "checks", prepend: true }, { text: "done" }] })
  const text = row.map((span) => span.text).join("")
  expect(text).toContain("branch · Build · Atlas · clean")
  expect(text).toContain("checks  ↻ 1 loop  done")
})

test("daemon profile events update the native transcript without writing a profile", async () => {
  const h = appHarness()
  conversation(h.sessionId, h.app.onEvent).exchange("question", "## Heading\n\n**bold**")
  h.app.onGlobal({ type: "tui.changed", at: NOW, gseq: 1, profile: { ...DEFAULT_TUI_PROFILE, messageRenderer: "plain", username: "Developer", showUsername: true } } as Parameters<typeof h.app.onGlobal>[0])
  h.app.render()
  expect(h.text().join("\n")).toContain("**bold**")
  expect(h.text().join("\n")).toContain("› Developer")
})

describe("B03 presentation", () => {
  test("the commands select independent renderer, presentation, scroll and timestamps persist", async () => {
    const dir = tempDir()
    const h = appHarness({ dataDir: dir })
    const chat = conversation(h.sessionId, h.app.onEvent)
    chat.exchange("question", "## Heading\n\n**bold**\n- item\n\n```ts\nconst x = 1\n```")
    await h.type("/message-rendering plain\r")
    expect(h.text().join("\n")).toContain("**bold**")
    await h.type("/message-rendering markdown\r")
    expect(h.text().join("\n")).not.toContain("**bold**")
    expect(h.frames.at(-1)?.flat().some((span) => span.bold && span.text.includes("bold"))).toBe(true)
    await h.type("/presentation raw\r")
    expect(readTuiProfile(dir).messageRenderer).toBe("plain")
    await h.type("/submit-scroll clear\r/timestamps\r/username Nora\r")
    expect(readTuiProfile(dir)).toMatchObject({ submitScroll: "clear", timestamps: true, username: "Nora" })
    expect(h.text().join("\n")).toContain("› Nora")
    expect(h.text().join("\n")).toMatch(/\d:\d\d/)
  })
  test("clear-submit starts the new turn at the top and older turns remain scrollable", async () => {
    const dir = tempDir()
    writeTuiProfile(dir, { ...DEFAULT_TUI_PROFILE, submitScroll: "clear" })
    const h = appHarness({ dataDir: dir })
    const chat = conversation(h.sessionId, h.app.onEvent)
    chat.exchange("older question", "older answer")
    await h.type("new question\r")
    chat.exchange("new question", "new answer")
    const rows = h.text()
    expect(rows.join("\n")).not.toContain("older answer")
    expect(rows.findIndex((row) => row.includes("new question"))).toBeLessThan(5)
    await h.type("\x1b[5~")
    expect(h.text().join("\n")).toContain("older answer")
    expect(h.app.transcript.blocks().filter((block) => block.kind === "user_message")).toHaveLength(2)
  })
  test("a large paste is a label the user types around; the message, the draft and a second paste of the same size stay whole", async () => {
    const dir = tempDir()
    writeTuiProfile(dir, { ...DEFAULT_TUI_PROFILE, pasteSummaryMinChars: 10 })
    const h = appHarness({ dataDir: dir, reply: (command) => command.type === "attachment.clipboard" ? ok({ kind: "text", text: "clipboard content\nsecond line" }) : undefined })
    const text = "pasted content\nsecond line"
    await h.type("fix this: ")
    await h.type("\x1b[200~" + text + "\x1b[201~")
    expect(h.app.editor.text).toBe(`fix this: [Pasted Content ${text.length} chars]`)
    await h.type(" and that: ")
    await h.type("\x1b[200~" + text + "\x1b[201~")
    expect(h.app.editor.text).toBe(`fix this: [Pasted Content ${text.length} chars] and that: [Pasted Content ${text.length} chars #2]`)
    expect(h.text().join("\n")).toContain(`fix this: [Pasted Content ${text.length} chars]`)
    await h.type("\r")
    expect(h.sentOf("user.submit")[0]).toMatchObject({ text: `fix this: ${text} and that: ${text}` })
    await h.type("\x16")
    expect(h.app.editor.text).toBe("[Pasted Content 29 chars]")
    await h.type("\x1b[200~short\x1b[201~")
    expect(h.app.editor.text).toBe("[Pasted Content 29 chars]short")
  })

  test("a paste label the user deleted takes its text with it", async () => {
    const dir = tempDir()
    writeTuiProfile(dir, { ...DEFAULT_TUI_PROFILE, pasteSummaryMinChars: 10 })
    const h = appHarness({ dataDir: dir })
    await h.type("\x1b[200~0123456789abcdef\x1b[201~")
    expect(h.app.editor.text).toBe("[Pasted Content 16 chars]")
    h.app.editor.replaceAll("just this")
    await h.type("\r")
    expect(h.sentOf("user.submit")[0]).toMatchObject({ text: "just this" })
  })
  test("scrollbar and thinking toggles are independently bindable", async () => {
    const dir = tempDir()
    writeFileSync(path.join(dir, "keybindings.json"), JSON.stringify({ "alt+s": "scrollbar.toggle", "alt+t": "thinking.toggle" }))
    const h = appHarness({ dataDir: dir })
    const chat = conversation(h.sessionId, h.app.onEvent)
    for (let i = 0; i < 10; i++) chat.exchange("question " + i, "answer " + i)
    await h.type("\x1bs\x1bt")
    expect(h.app.accessibility.profile).toMatchObject({ scrollbar: "always", reasoning: "hidden" })
    // The keys toggle this session's screen, not the stored profile.
    expect(readTuiProfile(dir).reasoning).not.toBe("hidden")
    expect(h.frames.at(-1)?.flat().some((span) => span.text === "┃")).toBe(true)
  })
})

test("History renders headings, bold, lists and code; list previews contain only the first plain line", () => {
  expect(firstPlainLine("## Answer 45\n\n**complete turns**")).toBe("Answer 45")
  const report: HistoryReport = { sessionId: ids("session"), turns: [], total: 1, page: 0, pageSize: 20, hasMore: false } as unknown as HistoryReport
  const turn = { turnId: ids("turn"), at: NOW, preview: "## Answer 45\n\n**complete turns**", outcome: "completed", items: [{ itemId: ids("item"), kind: "agent_message", text: "## Answer 45\n\n**complete turns**\n- first\n\n```ts\nconst x = 1\n```", status: "ok", attachments: [] }] } as HistoryReport["turns"][number]
  report.turns.push(turn)
  const rows = historyReaderRows(turn, createHistoryState(), 80, NOW)
  expect(rows.flat().filter((span) => span.bold).map((span) => span.text).join("")).toContain("complete turns")
  expect(rows.flat().map((span) => span.text).join("")).not.toContain("## Answer")
  expect(rows.flat().map((span) => span.text).join("")).toContain("const x = 1")
})
