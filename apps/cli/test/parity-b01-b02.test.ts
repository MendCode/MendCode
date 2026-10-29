import { afterEach, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import path from "node:path"
import { createBindings, resolveKey } from "../src/ui/keymap"
import { parseKeySpec, parseAction } from "../src/extensions/keybindings"
import { modelOptions, createModelPickerState } from "../src/view/model-picker"
import { textWidth } from "../src/view/wrap"
import { cleanTemps, conversation, tempDir } from "./session-ui-harness"
import { parityHarness, parityModels } from "./parity-b01-b02-harness"

afterEach(cleanTemps)
const text = (h: ReturnType<typeof parityHarness>) => h.text().join("\n")

test("history, older/newer pages, search in tool output, reader and live return", async () => {
  const h = parityHarness()
  await h.type("/history\r")
  expect(text(h)).toContain("History")
  expect(text(h)).toContain("Prompt 45")
  await h.type("\x1b[5~")
  expect(h.sentOf("session.history").at(-1)).toMatchObject({ before: 251 })
  expect(text(h)).toContain("Page 2")
  await h.type("\x1b[6~")
  expect(h.sentOf("session.history").at(-1)).toMatchObject({ after: 241 })
  await h.type("/Needle\r")
  expect(h.sentOf("session.history").at(-1)).toMatchObject({ before: 51 })
  expect(text(h)).toContain("Prompt 3")
  expect(text(h)).not.toContain("Prompt 45")
  await h.type("\r")
  expect(h.sentOf("session.history").at(-1)).toMatchObject({ turnId: h.turns[2]!.turnId })
  expect(text(h)).toContain("History / Turn")
  await h.type("G")
  expect(text(h)).toContain("Final evidence")
  const end = text(h)
  await h.type("\x1b[A")
  expect(text(h)).not.toBe(end)
  await h.type("\x1b")
  expect(text(h)).not.toContain("History / Turn")
  await h.type("l")
  expect(text(h)).not.toContain("Conversation")
  await h.type("/history\r")
  expect(text(h)).toContain("Prompt 3")
})

test("history views, split, tool tree, collapse, remembered state and cancelling Quick Jump", async () => {
  const h = parityHarness({ width: 180, height: 50 })
  await h.type("/history\r")
  expect(text(h)).toContain("Preview")
  await h.type("s")
  expect(text(h)).not.toContain("Preview")
  await h.type("v")
  expect(text(h)).toContain("· pages ·")
  await h.type("t")
  expect(text(h)).toContain("├─ task")
  await h.type("v")
  expect(text(h)).toContain("· timeline ·")
  await h.type("v")
  await h.type(" ")
  expect(text(h)).not.toContain("└─ ## Answer 45")
  await h.type("/absent\x1b")
  expect(text(h)).toContain("Prompt 45")
  await h.type("\x1b")
  await h.type("/history\r")
  expect(text(h)).not.toContain("Preview")
  expect(text(h)).toContain("tools tree")
})

test("model picker fuzzy matching, provider filtering, favorites and named variant selection", async () => {
  const h = parityHarness()
  await h.type("/model search\r")
  await h.type("atl")
  expect(text(h)).toContain("Atlas")
  expect(text(h)).not.toContain("Swift")
  await h.type("\x06")
  expect(text(h)).toContain("* Atlas")
  await h.type("\x01")
  expect(text(h)).toContain("Model / Providers")
  await h.type("\r")
  expect(text(h)).toContain("Atlas")
  expect(text(h)).not.toContain("Swift")
  await h.type("\r")
  expect(h.sentOf("session.model.set").at(-1)).toMatchObject({ choice: { model: "local:atlas" } })
  expect(text(h)).toContain("Select variant")
  await h.type("\x1b[B\r")
  expect(h.sentOf("session.model.set").at(-1)).toMatchObject({ choice: { model: "local:atlas", variant: "precise" } })
  await h.type("\x1bOR")
  expect(h.sentOf("session.model.set").at(-1)).toMatchObject({ choice: { model: "local:atlas", variant: "fast" } })
  await h.type("\x1b[13;2~")
  expect(text(h)).toContain("Select variant")
})

test("favorites and recent lead catalog without duplication; search includes provider names", () => {
  const prefs = { favorites: ["local:atlas"], recents: ["local:atlas", "second:swift"] }
  const state = createModelPickerState()
  expect(modelOptions(parityModels, prefs, state).map((o) => [o.model.id, o.category])).toEqual([["local:atlas", "Favorites"], ["second:swift", "Recent"]])
  state.query = "sec sw"
  expect(modelOptions(parityModels, prefs, state).map((o) => o.model.id)).toEqual(["second:swift"])
})

test("skills fuzzy picker toggles, loads, rejects disabled load and inserts into a preserved draft", async () => {
  const h = parityHarness()
  h.app.editor.insert("Draft: ")
  // Bind the command so opening a page preserves the actual prompt.
  await h.app.onKey("\x18")
  await h.app.onKey("m")
  await h.type("\x1b")
  h.app.editor.clear()
  await h.type("/skills\r")
  await h.type("rev")
  expect(text(h)).toContain("Review callers")
  expect(text(h)).not.toContain("release · user")
  await h.type("\r")
  expect(h.skills.skills[0]!.enabled).toBe(false)
  await h.type("\x0c")
  expect(text(h)).toContain("Skill disabled")
  await h.type("\r")
  await h.type("\x0c")
  expect(text(h)).toContain("Read callers before changes")
  await h.type("\x1b")
  h.app.editor.insert("Draft: ")
  await h.type("\t")
  expect(h.app.editor.text).toContain('Draft: Use the skill tool to load "review"')
  expect(h.sentOf("user.submit")).toHaveLength(0)
})

test("rename starts the existing rename editor and /editor uses the external editor handler", async () => {
  const h = parityHarness({ env: {} })
  await h.type("/rename\r")
  expect(text(h)).toContain("rename")
  expect(h.sentOf("session.rename")).toHaveLength(0)
  await h.type("\x15New title\r")
  expect(h.sentOf("session.rename").at(-1)).toMatchObject({ title: "New title" })
  await h.type("\x1b")
  await h.type("/editor\r")
  expect(text(h)).toContain("EDITOR")
  expect(h.sentOf("user.submit")).toHaveLength(0)
})

test("new key actions distinguish history from timeline and are configurable without default bindings", () => {
  const map = createBindings()
  expect(resolveKey({ armedAt: 0 }, "g", 0, map)).toEqual({ kind: "action", action: "session.timeline" })
  expect(resolveKey({ armedAt: 0 }, "G", 0, map)).toEqual({ kind: "action", action: "session.history" })
  expect(resolveKey({ armedAt: 0 }, "h", 0, map)).toEqual({ kind: "action", action: "tips.toggle" })
  for (const [key, action] of [["\x1b\x19", "scroll.line-up"], ["\x1b\x05", "scroll.line-down"], ["\x1b[117;7u", "scroll.half-up"], ["\x1b[100;7u", "scroll.half-down"], ["\x1b[13;2~", "variant.list"]]) expect(resolveKey({}, key!, 0, map)).toEqual({ kind: "action", action })
  for (const action of ["message.next", "message.previous", "message.last-user", "extensions.open"]) expect(parseAction(action)).toBe(action)
  expect(parseKeySpec("leader+shift+g")).toMatchObject({ ok: true, target: { key: "G" } })
  expect(parseKeySpec("ctrl+alt+y")).toMatchObject({ ok: true, target: { seqs: ["\x1b\x19", "\x1b[121;7u"] } })
})

test("message navigation crosses paged chat and concealment keeps the original source accessible", async () => {
  const dataDir = tempDir()
  writeFileSync(path.join(dataDir, "keybindings.json"), JSON.stringify({ "alt+n": "message.next", "alt+p": "message.previous", "alt+u": "message.last-user", "alt+x": "extensions.open", "alt+c": "messages.conceal" }))
  const timeline: Array<{ turnId: string; itemId: string; at: number; preview: string; reverted: boolean }> = []
  const h = parityHarness({ dataDir, reply: (command) => command.type === "session.timeline" ? { ok: true, result: { entries: timeline } } : undefined })
  const chat = conversation(h.sessionId, (event) => h.app.onEvent(event))
  for (let i = 0; i < 10; i++) timeline.push({ ...chat.exchange(`User ${i}`, `## Answer ${i}\n\n**bold ${i}**\n\n${"text\n".repeat(8)}`), at: i, preview: `User ${i}`, reverted: false })
  await h.type("\x1b[H")
  const first = text(h)
  await h.type("\x1bn")
  expect(text(h)).not.toBe(first)
  await h.type("\x1bp")
  expect(text(h)).toContain("User 0")
  await h.type("\x1bu")
  expect(text(h)).toContain("User 9")
  await h.type("\x1bc")
  expect(text(h)).toContain("**bold 9**")
  await h.type("\x1bc")
  expect(text(h)).not.toContain("**bold 9**")
  await h.type("\x1bx")
  expect(h.sentOf("extensions.list").length).toBeGreaterThan(0)
})

test("new pages fill the grid at all terminal breakpoints without ANSI or overflow", async () => {
  for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) {
    const h = parityHarness({ width, height })
    for (const command of ["/history", "/skills", "/model roles", "/model search", "/variants"]) {
      h.app.editor.clear()
      await h.type(`${command}\r`)
      const rows = h.text()
      expect(rows).toHaveLength(height!)
      expect(rows.every((row) => textWidth(row) <= width! && !row.includes("\x1b"))).toBe(true)
      expect(rows.some((row) => row.includes("┌"))).toBe(true)
      expect(rows[0]).toContain("esc")
      if (width! < 70) expect(rows.filter((row) => row.includes("┌"))).toHaveLength(1)
      await h.type("\x1b")
      await h.type("\x1b")
    }
  }
})

test("last-user navigation fetches the missing user message before placing the viewport", async () => {
  const dataDir = tempDir()
  writeFileSync(path.join(dataDir, "keybindings.json"), JSON.stringify({ "alt+u": "message.last-user" }))
  const sessionId = (await import("./session-ui-harness")).ids("session")
  const events: import("@mendcode/protocol").SessionEvent[] = []
  // Opening a chat pages back until it fills two screens, so the opening window must already be longer than that to miss the prompt.
  const point = conversation(sessionId, (event) => events.push(event)).exchange("Paged prompt", "Long answer\n\n".repeat(60))
  const loads: number[] = []
  const h = parityHarness({ sessionId, dataDir, reply: (command) => command.type === "session.timeline" ? { ok: true, result: { entries: [{ ...point, at: 1, preview: "Paged prompt", reverted: false }] } } : undefined, events: {
    loadWindow: async () => ({ ok: true, window: { events: events.slice(-4), firstSeq: 3, lastSeq: 6, sessionLastSeq: 6, more: true } }),
    loadBefore: async (_id, seq) => { loads.push(seq); return { ok: true, window: { events: events.slice(0, 2), firstSeq: 1, lastSeq: 2, sessionLastSeq: 6, more: false } } },
  } })
  await h.app.start()
  expect(h.app.transcript.blocks().some((b) => b.itemId === point.itemId)).toBe(false)
  await h.type("\x1bu")
  expect(loads).toEqual([3])
  expect(text(h)).toContain("Paged prompt")
})

test("bracketed paste filters skills and models, and history errors stay on their page", async () => {
  const h = parityHarness()
  await h.type("/skills\r")
  await h.type("\x1b[200~rev\x1b[201~")
  expect(text(h)).toContain("review · project")
  expect(text(h)).not.toContain("release · user")
  await h.type("\x1b")
  await h.type("/model search\r")
  await h.type("\x1b[200~swift\x1b[201~")
  expect(text(h)).toContain("second:swift")
  // The current model's name still reads in the chrome; its picker row, with its id, is filtered out.
  expect(text(h)).not.toContain("local:atlas")
  const failed = parityHarness({ reply: (command) => command.type === "session.history" ? { ok: false, error: { code: "unknown_session", message: "History session unavailable" } } : undefined })
  await failed.type("/history\r")
  expect(text(failed)).toContain("History session unavailable")
  await failed.type("\x1b")
  expect(text(failed)).not.toContain("History session unavailable")
})

test("rename targets the current session after grouping, preserves refused drafts, and cancels to chat", async () => {
  const { ids, NOW } = await import("./session-ui-harness")
  const sessionId = ids("session")
  const other = ids("session")
  let refuse = true
  const h = parityHarness({ sessionId, reply: (command) => command.type === "session.list" ? { ok: true, result: { sessions: [
    { sessionId: other, title: "Other", directory: "/different", createdAt: NOW, updatedAt: NOW, state: "idle" },
    { sessionId, title: "Current", directory: "/work/mendcode", createdAt: NOW - 100, updatedAt: NOW - 100, state: "idle" },
  ] } } : command.type === "session.rename" && refuse ? { ok: false, error: { code: "busy", message: "Rename refused" } } : undefined })
  await h.type("/rename\r")
  expect(text(h)).toContain("rename: Current▏")
  expect(text(h).split("\n")[0]).toContain("esc cancel")
  await h.type("\x15New name\r")
  expect(h.sentOf("session.rename").at(-1)).toMatchObject({ sessionId, title: "New name" })
  expect(text(h)).toContain("rename: New name▏")
  await h.type("\x1b")
  expect(h.app.page).toBe("chat")
  refuse = false
  await h.type("/rename Title\r")
  expect(h.sentOf("session.rename").at(-1)).toMatchObject({ sessionId, title: "Title" })
})
