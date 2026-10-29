import { afterEach, expect, test } from "bun:test"
import { b62Harness } from "./b62-fixtures"
import { cleanTemps, conversation, ids, NOW } from "./session-ui-harness"
import { textWidth } from "../src/view/wrap"
import { SETTINGS_GROUPS } from "../src/view/settings-page"
import { DEFAULT_BINDINGS, keymapHelp, resolveKey } from "../src/ui/keymap"

const all: ReturnType<typeof b62Harness>[] = []
afterEach(async () => { for (const h of all.splice(0)) { await h.app.onKey("\x03"); await h.app.onKey("\x03") }; cleanTemps() })
const start = (width = 100, height = 30) => { const h = b62Harness(width, height); all.push(h); return h }

test("inspector opens the durable transcript; empty prompt arrows navigate siblings and parent", async () => {
  const h = start()
  await h.type("/tasks\r")
  expect(h.text().join("\n")).toContain("stable queue id")
  await h.app.onKey("\r")
  expect(h.subscriptions.at(-1)?.sessionId).toBe(h.first)
  await h.app.onKey("\x1b[C")
  expect(h.subscriptions.at(-1)?.sessionId).toBe(h.second)
  await h.app.onKey("\x1b[D")
  expect(h.subscriptions.at(-1)?.sessionId).toBe(h.first)
  await h.app.onKey("\x1b[A")
  expect(h.subscriptions.at(-1)?.sessionId).toBe(h.parent)
  await h.app.onKey("\x18")
  await h.app.onKey("\x1b[B")
  expect(h.subscriptions.at(-1)?.sessionId).toBe(h.first)
})

test("arrows preserve a nonempty prompt, while a root keeps its normal history behavior", async () => {
  const h = start()
  await h.type("/tasks\r")
  await h.app.onKey("\r")
  await h.type("draft")
  const before = h.subscriptions.length
  await h.app.onKey("\x1b[C")
  await h.app.onKey("\x1b[A")
  expect(h.subscriptions).toHaveLength(before)
  await h.app.onKey("\x03")
  await h.app.onKey("\x1b[A")
  await h.app.onKey("\x1b[A")
  expect(h.subscriptions.at(-1)?.sessionId).toBe(h.parent)
  expect(h.sentOf("prompt.history").length).toBeGreaterThan(0)
})

test("three children follow v1 id ordering and the first-child chord uses the current sibling set", async () => {
  const h = start()
  const third = ids("session")
  h.sessions.push({ ...h.sessions[1]!, sessionId: third, title: "Third child", createdAt: NOW - 5000 })
  await h.type("/tasks\r")
  await h.app.onKey("\r")
  await h.app.onKey("\x1b[C")
  expect(h.subscriptions.at(-1)?.sessionId).toBe(third)
  await h.app.onKey("\x1b[D")
  expect(h.subscriptions.at(-1)?.sessionId).toBe(h.first)
  await h.app.onKey("\x1b[D")
  expect(h.subscriptions.at(-1)?.sessionId).toBe(h.second)
  await h.app.onKey("\x18")
  await h.app.onKey("\x1b[B")
  expect(h.subscriptions.at(-1)?.sessionId).toBe(h.first)
})

test("tasks use current selection for detach, wait and cancel, and refresh on child push", async () => {
  const h = start()
  h.setTasks(h.tasks.map((task) => ({ ...task, background: false })))
  await h.type("/tasks\r")
  await h.app.onKey("\x1b[B")
  await h.app.onKey("b")
  expect(h.sentOf("task.status").at(-1)).toMatchObject({ sessionId: h.parent, taskId: h.second, action: "detach" })
  await h.app.onKey("w")
  expect(h.sentOf("task.status").at(-1)).toMatchObject({ taskId: h.second, action: "wait", timeoutMs: 1000 })
  await h.app.onKey("x")
  expect(h.text().join("\n")).toContain("cancelled")
  h.setTasks(h.tasks.map((task) => ({ ...task, state: "completed", result: "Latest saved result" })))
  h.app.onGlobal({ type: "task.changed", gseq: 1, at: NOW, sessionId: h.second, parentId: h.parent })
  await Bun.sleep(5)
  expect(h.text().join("\n")).toContain("Latest saved result")
})

test("background tab includes completed sessions, metadata and retained navigation ids", async () => {
  const h = start(180, 50)
  await h.type("/agents\r")
  await h.app.onKey("3")
  expect(h.text().join("\n")).toContain("Wake reliability")
  expect(h.text().join("\n")).toContain("#daemon #review")
  expect(h.text().join("\n")).toContain("Priority high")
  h.setBackgrounds(h.backgrounds.map((entry) => ({ ...entry, metadata: { ...entry.metadata, sessionId: entry.sessionId, tags: ["updated"], title: "Updated audit" } })))
  h.app.onGlobal({ type: "agent-commands.changed", gseq: 2, at: NOW, sourceSessionId: h.first, targetSessionId: h.first })
  await Bun.sleep(5)
  expect(h.text().join("\n")).toContain("Updated audit")
  await h.app.onKey("\r")
  expect(h.subscriptions.at(-1)?.sessionId).toBe(h.first)
  await Bun.sleep(5)
  expect(h.sentOf("session.background.writer.acquire").at(-1)).toMatchObject({ sessionId: h.first })
  await h.app.onKey("\x1b[C")
  expect(h.sentOf("session.background.writer.release").at(-1)).toMatchObject({ sessionId: h.first })
})

test("child chat hints live in the header; prompt arrows remain configurable and leader help has no escape codes", async () => {
  const h = start()
  await h.type("/tasks\r")
  await h.app.onKey("\r")
  await Bun.sleep(5)
  conversation(h.first, h.app.onEvent).exchange("Inspect the outbox", "Queued notices survive restart.")
  h.app.render()
  expect(h.text().slice(0, 3).join("\n")).toContain("↑ parent")
  expect(DEFAULT_BINDINGS.inline.get("\x1b[C")).toBe("session.child.next")
  expect(resolveKey({ armedAt: NOW }, "\x1b[B", NOW)).toEqual({ kind: "action", action: "session.child.first" })
  expect(keymapHelp().some((row) => row.keys === "ctrl+x down")).toBe(true)
  expect(keymapHelp().some((row) => row.keys.includes("\x1b"))).toBe(false)
})

test("owner wake setting sends a persisted settings patch", async () => {
  const h = start()
  await h.type("/settings\r")
  const ownerWakeRow = SETTINGS_GROUPS.flatMap((group) => group.rows).findIndex((row) => row.id === "subagentOwnerWake")
  for (let row = 0; row < ownerWakeRow; row++) await h.app.onKey("\x1b[B")
  expect(h.text().join("\n")).toContain("owner wake")
  await h.app.onKey(" ")
  expect(h.sentOf("settings.set").at(-1)).toMatchObject({ patch: { subagentOwnerWake: false } })
})

test("quit releases child writer presence before exiting", async () => {
  const h = start()
  await h.type("/tasks\r")
  await h.app.onKey("\r")
  await Bun.sleep(5)
  await h.type("/quit\r")
  expect(h.sentOf("session.background.writer.release").at(-1)).toMatchObject({ sessionId: h.first })
})

test("background detail scroll reaches long saved results and resets for the next child", async () => {
  const h = start()
  h.setBackgrounds(h.backgrounds.map((entry) => ({ ...entry, summary: Array.from({ length: 30 }, (_, i) => `Evidence ${i + 1}`).join("\n") })))
  await h.type("/agents\r")
  await h.app.onKey("3")
  for (let i = 0; i < 10; i++) await h.app.onKey("\x1b[6~")
  h.app.render()
  expect(h.text().join("\n")).toContain("Evidence 30")
  await h.app.onKey("\x1b[B")
  h.app.render()
  expect(h.text().join("\n")).toContain(h.second)
})

test("task, background and child-chat screens fit all required terminal geometries", async () => {
  for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) {
    const h = start(width, height)
    for (const command of ["/tasks", "/agents"]) {
      await h.type(command + "\r")
      if (command === "/agents") await h.app.onKey("3")
      h.app.render()
      expect(h.frames.at(-1)).toHaveLength(height!)
      for (const row of h.text()) { expect(textWidth(row)).toBeLessThanOrEqual(width!); expect(row).not.toContain("\x1b") }
      expect(h.text().join("\n")).toContain("┌")
      await h.app.onKey("\x1b")
    }
  }
})
