import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory } from "@mendcode/protocol"
import { openStore } from "../src"

const ids = createIdFactory()
const dirs: string[] = []
const stores: ReturnType<typeof openStore>[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const temp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-tree-store-"))
  dirs.push(dir)
  return dir
}
const open = (dir: string, now = () => 1_000) => {
  const store = openStore({ dir, now })
  stores.push(store)
  return store
}
const session = (store: ReturnType<typeof openStore>, title: string) => {
  const id = ids("session")
  store.createSession({ id, directory: "/repo", title })
  return id
}

test("the family of any member lists the root first and branches depth first, and survives a restart", () => {
  const dir = temp()
  let store = open(dir)
  const root = session(store, "root")
  const a = session(store, "a")
  const b = session(store, "b")
  const a1 = session(store, "a1")
  store.sessionTree.recordFork({ sessionId: a, parentId: root, atItemId: "itm_1", atPreview: "first" })
  store.sessionTree.recordFork({ sessionId: b, parentId: root })
  store.sessionTree.recordFork({ sessionId: a1, parentId: a, atPreview: "x".repeat(300) })
  const expected = [root, a, a1, b]
  for (const from of [root, a, a1, b]) expect(store.sessionTree.family(from).map((entry) => entry.sessionId)).toEqual(expected)
  expect(store.sessionTree.family(root)[1]).toMatchObject({ parentId: root, atItemId: "itm_1", atPreview: "first", title: "a" })
  expect(store.sessionTree.family(a1)[2]!.atPreview).toHaveLength(120)
  expect(store.sessionTree.family(root)[0]!.parentId).toBeUndefined()
  store.close()
  stores.pop()

  store = open(dir)
  expect(store.sessionTree.family(b).map((entry) => entry.sessionId)).toEqual(expected)
})

test("a session without forks is its own family; deleting a parent makes its branch a root", () => {
  const store = open(temp())
  const alone = session(store, "alone")
  expect(store.sessionTree.family(alone).map((entry) => entry.sessionId)).toEqual([alone])
  const parent = session(store, "parent")
  const child = session(store, "child")
  store.sessionTree.recordFork({ sessionId: child, parentId: parent })
  store.deleteSession(parent)
  expect(store.sessionTree.family(child).map((entry) => [entry.sessionId, entry.parentId])).toEqual([[child, undefined]])
})

test("labels are trimmed to one bounded line, replaced, cleared, persisted and removed with the session", () => {
  const dir = temp()
  let tick = 1_000
  let store = open(dir, () => ++tick)
  const id = session(store, "labelled")
  expect(store.sessionTree.setLabel(id, "itm_a", "  one\n two  ")).toBe("one two")
  expect(store.sessionTree.setLabel(id, "itm_b", "y".repeat(200))).toHaveLength(80)
  store.sessionTree.setLabel(id, "itm_a", "renamed")
  expect(store.sessionTree.labels(id).map((entry) => [entry.itemId, entry.label.slice(0, 7)])).toEqual([["itm_b", "yyyyyyy"], ["itm_a", "renamed"]])
  expect(store.sessionTree.setLabel(id, "itm_b", "   ")).toBeUndefined()
  store.close()
  stores.pop()

  store = open(dir)
  expect(store.sessionTree.labels(id)).toMatchObject([{ itemId: "itm_a", label: "renamed" }])
  const copy = session(store, "copy")
  store.sessionTree.copyLabels(id, copy, new Set(["itm_a", "itm_zzz"]))
  expect(store.sessionTree.labels(copy)).toMatchObject([{ itemId: "itm_a", label: "renamed" }])
  store.deleteSession(id)
  expect(store.sessionTree.labels(id)).toEqual([])
})

test("a recap is served only while the session has not grown", () => {
  const store = open(temp())
  const id = session(store, "recapped")
  expect(store.sessionTree.recap(id, 5)).toBeUndefined()
  store.sessionTree.putRecap(id, 5, "Goal: x")
  expect(store.sessionTree.recap(id, 5)).toMatchObject({ text: "Goal: x" })
  expect(store.sessionTree.recap(id, 6)).toBeUndefined()
  store.sessionTree.putRecap(id, 6, "Goal: y")
  expect(store.sessionTree.recap(id, 6)).toMatchObject({ text: "Goal: y" })
})
