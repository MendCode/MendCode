import { afterEach, expect, test } from "bun:test"
import type { CommandInput, CommandReply } from "@mendcode/client"
import { appHarness, cleanTemps, conversation, ids, NOW, tempDir } from "./session-ui-harness"

afterEach(cleanTemps)

const summary = (sessionId: string, directory: string) => ({ sessionId, title: "chat", directory, createdAt: NOW - 60_000, updatedAt: NOW - 30_000, state: "idle", queued: 0 })

/** A terminal started in `/home/me` whose agent opens the session `target`, which lives in `folder`. */
function openFrom(start: string, folder: string, target: string) {
  const here = ids("session")
  const reply = (command: CommandInput): CommandReply | undefined => {
    if (command.type === "session.get" && command.sessionId === target) return { ok: true, result: { session: summary(target, folder) } }
    if (command.type === "session.get") return { ok: true, result: { session: summary(here, start) } }
    return undefined
  }
  const h = appHarness({ sessionId: here, dataDir: tempDir(), directory: start, width: 120, height: 30, reply })
  h.app.applySettings({ onboarded: true })
  return h
}

async function openAfterTurn(h: ReturnType<typeof openFrom>, from: string, target: string) {
  const talk = conversation(from as never, h.app.onEvent)
  const turnId = ids("turn")
  const itemId = ids("item")
  talk.emit({ type: "turn.started", turnId, queueId: ids("queue") })
  talk.emit({ type: "item.started", turnId, itemId, kind: "tool_call", meta: { tool: "session_open" } })
  talk.emit({ type: "item.completed", itemId, status: "ok", text: "Opening", meta: { openSession: target } })
  talk.emit({ type: "turn.completed", turnId })
  await Bun.sleep(30)
}

test("opening a session of another folder moves the terminal's project to that folder: footer, lists and the new chat's folder", async () => {
  const target = ids("session")
  const h = openFrom("/home/me", "/work/api", target)
  await Bun.sleep(10)
  await openAfterTurn(h, h.sessionId, target)
  expect(h.app.sessionId).toBe(target)
  h.app.render()
  expect(h.text().join("\n")).toContain("/work/api")
  const listed = h.sentOf("session.list").at(-1)
  expect(listed).toMatchObject({ directory: "/work/api" })
  await h.type("/new\r")
  expect(h.sentOf("session.create").at(-1)).toMatchObject({ directory: "/work/api" })
})

test("going back to a chat of the home folder moves the terminal back to home", async () => {
  const target = ids("session")
  const h = openFrom("/home/me", "/work/api", target)
  await Bun.sleep(10)
  await openAfterTurn(h, h.sessionId, target)
  expect(h.app.sessionId).toBe(target)
  const home = ids("session")
  const home2 = h.sent.length
  await openAfterTurn(h, target, home)
  expect(h.app.sessionId).toBe(home)
  expect(h.sent.slice(home2).filter((c) => c.type === "session.list").at(-1)).toMatchObject({ directory: "/home/me" })
})
