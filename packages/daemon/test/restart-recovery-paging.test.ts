import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createIdFactory, type SessionEvent, type SessionId } from "@mendcode/protocol"
import { openStore } from "@mendcode/store"
import { startDaemon } from "../src"

const ids = createIdFactory()
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "mendd-recovery-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** A log the way a killed daemon leaves it: finished turns, then one still running whose events span more than one read page. */
function seedInterrupted(dir: string, input: { finishedTurns: number; openItems: number }) {
  const store = openStore({ dir })
  const sessionId = ids("session") as SessionId
  store.createSession({ id: sessionId, directory: "/repo", title: "long" })
  const append = (draft: Record<string, unknown>) => store.sessionSink.append({ sessionId, ...draft } as never)
  for (let turn = 0; turn < input.finishedTurns; turn++) {
    const turnId = ids("turn")
    append({ type: "turn.started", turnId, queueId: ids("queue") })
    const itemId = ids("item")
    append({ type: "item.started", turnId, itemId, kind: "user_message" })
    append({ type: "item.completed", itemId, status: "ok", text: `question ${turn}` })
    append({ type: "turn.completed", turnId })
  }
  const turnId = ids("turn")
  append({ type: "turn.started", turnId, queueId: ids("queue") })
  const requestId = ids("request")
  append({ type: "server.request", turnId, requestId, kind: "approval", title: "run it", detail: "" })
  const open: string[] = []
  for (let item = 0; item < input.openItems; item++) {
    const itemId = ids("item")
    append({ type: "item.started", turnId, itemId, kind: "tool_call" })
    // Every other item finished before the kill; the rest are still open.
    if (item % 2) append({ type: "item.completed", itemId, status: "ok", text: "done" })
    else open.push(itemId)
  }
  store.close()
  return { sessionId, turnId, requestId, open }
}

describe("a restart closes the turn a killed daemon left running", () => {
  test("a turn longer than one read page is closed whole: its open items, its open request and the turn itself", async () => {
    const dir = tempDir()
    const seeded = seedInterrupted(dir, { finishedTurns: 400, openItems: 1_300 })
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
    await daemon.stop()
    const store = openStore({ dir })
    cleanups.push(() => store.close())
    const lastSeq = store.lastSeq(seeded.sessionId)!
    const tail: SessionEvent[] = store.readBefore(seeded.sessionId, lastSeq + 1, seeded.open.length + 10)
    const interrupted = tail.filter((event) => event.type === "item.completed" && event.status === "interrupted").map((event) => (event as { itemId: string }).itemId)
    expect(interrupted.sort()).toEqual([...seeded.open].sort())
    expect(tail.filter((event) => event.type === "server.request.resolved")).toMatchObject([{ requestId: seeded.requestId, resolution: "abandoned" }])
    expect(tail.filter((event) => event.type === "turn.interrupted")).toMatchObject([{ turnId: seeded.turnId, reason: "restart" }])
    expect(store.sessionsWithActiveTurn()).toEqual([])
  })
})
