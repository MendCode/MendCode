import { afterAll, expect, test } from "bun:test"
import { b55Harness } from "./b55-fixtures"
import { appHarness, cleanTemps, conversation, ids } from "./session-ui-harness"
import { textWidth } from "../src/view/wrap"

afterAll(cleanTemps)

test("B55 v1 undo restores the submitted draft; redo clears it; worktree limits and external history stay explicit", async () => {
  const h = b55Harness(180, 50, { external: true })
  await h.type("\x18u")
  expect(h.sentOf("session.undo")).toHaveLength(1)
  expect(h.app.editor.text).toBe("Update runner and save changes")
  const text = h.text().join("\n")
  expect(text).toContain("worktree files captured; other shell effects remain")
  expect(text).toContain("the engine still remembers this turn")
  expect(text).toContain("┌─ Files & history")
  await h.type("\x18r")
  expect(h.app.editor.text).toBe("")
  expect(h.text().join("\n")).toContain("redone · 1 turn")
})

test("B55 historical changes select session/message, refresh the same source and never request live file diffs", async () => {
  const h = b55Harness()
  await h.type("/changes session\r")
  expect(h.sentOf("session.changes").at(-1)).toEqual({ type: "session.changes", sessionId: h.sessionId })
  expect(h.text()[0]).toContain("Changes · session changes")
  const before = h.sentOf("session.changes").length
  await h.type("r")
  expect(h.sentOf("session.changes")).toHaveLength(before + 1)
  await h.app.onKey("\x1b")
  await h.type("/changes message 2\r")
  expect(h.sentOf("session.changes").at(-1)).toHaveProperty("atItemId")
  expect(h.text()[0]).toContain("Changes · message changes")
  await h.type("cCsLeXd")
  expect(h.sentOf("review.update")).toHaveLength(0)
  expect(h.sentOf("user.submit")).toHaveLength(0)
  expect(h.sentOf("changes.file")).toHaveLength(0)
  await h.app.onKey("\x1b")
  await h.type("/changes\r")
  expect(h.text()[0]).toContain("Changes · working tree")
})

test("B55 repeated undo replaces a typed draft; intermediate redo keeps it and final redo clears it", async () => {
  const h = b55Harness()
  await h.type("unsent draft")
  await h.type("\x18u")
  expect(h.app.editor.text).toBe("Update runner and save changes")
  await h.type("\x18u")
  expect(h.app.editor.text).toBe("Inspect the runner")
  await h.type("\x18r")
  expect(h.app.editor.text).toBe("Inspect the runner")
  expect(h.text().join("\n")).toContain("/redo restore")
  await h.type("\x18r")
  expect(h.app.editor.text).toBe("")
})

test("B55 active undo requests cancellation and restores image/document attachments into the prompt", async () => {
  const attachments = [
    { sha256: "a".repeat(64), bytes: 3, mime: "image/png", name: "shot.png" },
    { sha256: "b".repeat(64), bytes: 4, mime: "application/pdf", name: "notes.pdf" },
  ]
  const turnId = ids("turn")
  const h = appHarness({ reply: (command) => command.type === "session.undo" ? { ok: true, result: { turnIds: [turnId], files: { restored: [], removed: [], skipped: [] }, history: { messages: 1, tracked: true }, shellUntracked: false, notes: [], prompt: { text: "Inspect attachments", attachments } } } : undefined })
  const chat = conversation(h.sessionId, (event) => h.app.onEvent(event))
  chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
  await h.type("\x18u")
  expect(h.sentOf("session.undo").at(-1)).toHaveProperty("cancelRunning", true)
  expect(h.app.editor.text).toBe("Inspect attachments")
  await h.type("\r")
  expect(h.sentOf("user.submit").at(-1)).toMatchObject({ text: "Inspect attachments", attachments })
})

test("B55 /changes replay opens the last message's changes in replay and esc leaves replay before the page", async () => {
  const h = b55Harness()
  await h.type("/changes replay\r")
  expect(h.sentOf("session.changes").at(-1)).toHaveProperty("atItemId")
  expect(h.text().join("\n")).toContain("replay step 1/")
  expect(h.text()[0]).toContain("Changes · message changes")
  await h.app.onKey("\x1b")
  expect(h.text().join("\n")).not.toContain("replay step")
  expect(h.text()[0]).toContain("Changes · message changes")
  expect(h.sentOf("review.update")).toHaveLength(0)
  await h.app.onKey("\x1b")
  await h.type("/changes replay 9\r")
  expect(h.text().join("\n")).toContain("Message number is outside the timeline")
})

test("B55 invalid message selection stays in chat and reports the error", async () => {
  const h = b55Harness()
  await h.type("/changes message 9\r")
  expect(h.sentOf("session.changes")).toHaveLength(0)
  expect(h.text().join("\n")).toContain("Message number is outside the timeline")
})

test("B55 a delayed historical response cannot replace a newer worktree view", async () => {
  let resolve!: (reply: import("@mendcode/client").CommandReply) => void
  const file = { path: "live.ts", status: "modified", additions: 1, deletions: 0, binary: false, truncated: false, diff: "@@ -0,0 +1 @@\n+live\n" }
  const h = appHarness({ reply: (command) => {
    if (command.type === "session.changes") return new Promise((done) => { resolve = done })
    if (command.type === "changes.query") return { ok: true, result: { root: "/repo", files: [file], omittedFiles: 0 } }
    return undefined
  } })
  const pending = h.type("/changes session\r")
  for (let i = 0; i < 100 && !resolve; i++) await Promise.resolve()
  expect(resolve).toBeDefined()
  await h.app.onKey("\x1b")
  await h.type("/changes\r")
  resolve({ ok: true, result: { root: "/repo", scope: "session", files: [{ ...file, path: "old.ts" }], omittedFiles: 0 } })
  await pending
  expect(h.text()[0]).toContain("working tree")
  expect(h.text().join("\n")).toContain("live.ts")
  expect(h.text().join("\n")).not.toContain("old.ts")
})

test.each([[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]])("B55 panels fit %ix%i in done, conflict and historical partial states", async (width, height) => {
  for (const conflict of [false, true]) {
    const h = b55Harness(width, height, { conflict, partial: true })
    await h.type("/undo\r")
    expect(h.text()).toHaveLength(height)
    expect(h.text().every((row) => textWidth(row) <= width)).toBe(true)
    expect(h.text().join("\n")).toContain("┌─ Files & history")
    await h.app.onKey("\x1b")
    await h.app.onKey("\x03")
    await h.type("/changes session\r")
    expect(h.text().join("\n")).toContain("Partial")
    expect(h.text().every((row) => textWidth(row) <= width)).toBe(true)
    expect(h.text()[0]).toContain("esc back")
  }
})
