import { afterEach, expect, test } from "bun:test"
import { b63Harness } from "./b63-fixtures"
import { cleanTemps, ids, NOW } from "./session-ui-harness"
import type { MemoryEntry } from "@mendcode/protocol"
import { textWidth } from "../src/view/wrap"

afterEach(cleanTemps)

test("B63 t opens scoped Memory assistant; typing, review, reopen and clear keep the main draft intact", async () => {
  const h = b63Harness()
  await h.type("/memory\r")
  await h.type("2")
  await h.type("t")
  expect(h.text().join("\n")).toContain("Memory assistant")
  expect(h.text().join("\n")).toContain("No messages")
  await h.type("Why these tools?\r")
  const send = h.sentOf("memory.assistant.send")[0]
  expect(send).toMatchObject({ directory: "/work/mendcode", text: "Why these tools?", selection: { tab: "saved", category: "commands" } })
  expect(h.text().join("\n")).toContain("pending your review")
  expect(h.sentOf("user.submit")).toEqual([])
  await h.app.onKey("\x12")
  await h.type("")
  expect(h.text().join("\n")).toContain("Connect the validation rules")
  await h.type("t")
  expect(h.text().join("\n")).toContain("Why these tools?")
  await h.app.onKey("\x0c")
  await h.type("")
  expect(h.text().join("\n")).toContain("No messages")
  expect(h.sentOf("memory.assistant.clear")).toHaveLength(1)
  await h.app.onKey("\x1b")
  await h.app.onKey("\x1b")
  await h.type("/memory\r")
  await h.type("t")
  await h.app.onKey("\x1b")
  await h.app.onKey("\x1b")
  await h.type("main draft")
  expect(h.text().join("\n")).toContain("main draft")
  expect(h.sentOf("user.submit")).toEqual([])
})

test("B63 assistant handles unavailable provider and cancel without submitting a main turn", async () => {
  const h = b63Harness()
  h.error("Memory assistant needs a configured native completion provider")
  await h.type("/memory\r")
  await h.type("t")
  await h.type("why?\r")
  expect(h.text().join("\n")).toContain("configured native completion")
  await h.app.onKey("\x18")
  await h.type("")
  expect(h.sentOf("memory.assistant.cancel")).toHaveLength(1)
  expect(h.sentOf("user.submit")).toEqual([])
})

test("B63 memory assistant fits compact, medium and wide frames", async () => {
  for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) {
    const h = b63Harness(width, height)
    await h.type("/memory\r")
    await h.type("2")
    await h.type("t")
    await h.type("Explain this rule\r")
    const rows = h.frames.at(-1)!
    expect(rows).toHaveLength(height!)
    expect(rows.every((row) => textWidth(row.map((span) => span.text).join("")) <= width!)).toBe(true)
    expect(h.text().join("\n")).toContain("pending your review")
    if (width! < 70) expect(h.text().join("\n")).not.toContain("Selection / Pending")
  }
})

test("R4 ^N sets the chat aside, ^O lists archived chats and restores or forgets one", async () => {
  for (const [width, height] of [[100, 30], [60, 20]]) {
    const h = b63Harness(width, height)
    await h.type("/memory\r")
    await h.type("2")
    await h.type("t")
    await h.app.onKey("\x0e")
    await h.type("")
    expect(h.sentOf("memory.assistant.archive")).toHaveLength(1)
    await h.type("First topic\r")
    await h.app.onKey("\x0e")
    await h.type("")
    expect(h.text().join("\n")).toContain("No messages")
    await h.type("Second topic\r")
    await h.app.onKey("\x0f")
    await h.type("")
    expect(h.text().join("\n")).toContain("Archived chats")
    expect(h.text().join("\n")).toContain("First topic")
    expect(h.sentOf("memory.assistant.send")).toHaveLength(2)
    await h.app.onKey("\r")
    await h.type("")
    expect(h.sentOf("memory.assistant.archive").at(-1)).toMatchObject({ action: "restore", archiveId: "chat-1" })
    expect(h.text().join("\n")).toContain("First topic")
    expect(h.text().join("\n")).not.toContain("Archived chats")
    await h.app.onKey("\x0f")
    await h.type("")
    expect(h.text().join("\n")).toContain("Second topic")
    await h.app.onKey("x")
    await h.type("")
    expect(h.text().join("\n")).toContain("No archived chats")
    expect(h.sentOf("memory.assistant.archive").at(-1)).toMatchObject({ action: "delete" })
    await h.app.onKey("\x1b")
    await h.type("")
    expect(h.text().join("\n")).not.toContain("Archived chats")
    expect(h.sentOf("user.submit")).toEqual([])
    const rows = h.frames.at(-1)!
    expect(rows).toHaveLength(height!)
    expect(rows.every((row) => textWidth(row.map((span) => span.text).join("")) <= width!)).toBe(true)
  }
})

test("B63 assistant uses the same sorted/filter selection as the Memory list", async () => {
  const h = b63Harness()
  const selected: MemoryEntry = { memoryId: ids("memory"), scope: "project", directory: "/work/mendcode", text: "Selected fact", category: "constraints", status: "saved", source: "user", pinned: true, createdAt: NOW, updatedAt: NOW }
  h.memories([{ ...selected, memoryId: ids("memory"), pinned: false, updatedAt: NOW + 1, text: "Unselected newer fact" }, selected])
  await h.type("/memory\r")
  await h.type("2")
  await h.type("/")
  await h.type("pinned")
  await h.type("\r")
  await h.type("t")
  await h.type("Explain this\r")
  expect(h.sentOf("memory.assistant.send")[0]).toMatchObject({ selection: { memoryId: selected.memoryId, category: "constraints" } })
})
