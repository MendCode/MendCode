import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory } from "@mendcode/protocol"
import { openStore, PENDING_CONTEXT_LIMIT } from "../src"

const ids = createIdFactory()
const dirs: string[] = []
const stores: ReturnType<typeof openStore>[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const open = (dir = mkdtempSync(path.join(tmpdir(), "mend-handoff-store-"))) => {
  if (!dirs.includes(dir)) dirs.push(dir)
  const store = openStore({ dir, now: () => 1_000 })
  stores.push(store)
  return { store, dir }
}
const session = (store: ReturnType<typeof openStore>, title: string) => {
  const id = ids("session")
  store.createSession({ id, directory: "/repo", title })
  return id
}

test("the last turn each engine took part in is kept per session, replaced as it moves and gone with the session", () => {
  const { store, dir } = open()
  const id = session(store, "s")
  expect(store.handoff.seen(id, "claude")).toBeUndefined()
  store.handoff.markSeen(id, "native", "turn_1")
  store.handoff.markSeen(id, "claude", "turn_2")
  store.handoff.markSeen(id, "native", "turn_3")
  expect(store.handoff.seenEngines(id)).toEqual([{ engine: "claude", turnId: "turn_2" }, { engine: "native", turnId: "turn_3" }])
  store.close()
  stores.pop()
  const reopened = open(dir).store
  expect(reopened.handoff.seen(id, "native")).toBe("turn_3")
  reopened.deleteSession(id)
  expect(reopened.handoff.seenEngines(id)).toEqual([])
})

test("a fork's branch point and last merge are separate, and an unknown fork says so", () => {
  const { store } = open()
  const fork = session(store, "fork")
  expect(store.handoff.base(fork)).toEqual({ known: false })
  store.handoff.setBase(fork, undefined)
  expect(store.handoff.base(fork)).toEqual({ known: true })
  store.handoff.setBase(fork, "turn_a")
  store.handoff.setMerged(fork, "turn_z")
  expect(store.handoff.base(fork)).toEqual({ known: true, baseTurnId: "turn_a", mergedTurnId: "turn_z" })
  store.handoff.setBase(fork, "turn_b")
  expect(store.handoff.base(fork)).toMatchObject({ baseTurnId: "turn_b", mergedTurnId: "turn_z" })
})

test("merged contexts wait for the next turn, the oldest go first when too many arrive, and clearing takes only the ones given", () => {
  const { store } = open()
  const parent = session(store, "parent")
  const fork = session(store, "fork")
  for (let index = 0; index < PENDING_CONTEXT_LIMIT + 2; index++) store.handoff.queueContext({ sessionId: parent, fromSessionId: fork, title: `fork ${index}`, text: `context ${index}` })
  const waiting = store.handoff.pendingContext(parent)
  expect(waiting.map((entry) => entry.text)).toEqual(Array.from({ length: PENDING_CONTEXT_LIMIT }, (_, index) => `context ${index + 2}`))
  store.handoff.clearContext(parent, [waiting[0]!.id, waiting[1]!.id])
  expect(store.handoff.pendingContext(parent).map((entry) => entry.text)).toEqual([`context 4`, `context 5`])
  store.deleteSession(parent)
  expect(store.handoff.pendingContext(parent)).toEqual([])
})
