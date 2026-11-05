import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory, type SessionId } from "@mendcode/protocol"
import { openStore } from "../src"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const ids = createIdFactory()
const DAY_MS = 86_400_000

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-stray-")); dirs.push(dir)
  const store = openStore({ dir })
  const session = ids("session") as SessionId
  store.createSession({ id: session, directory: "/repo", title: "t" })
  return { dir, store, session }
}
const age = (file: string, days: number) => { const at = new Date(Date.now() - days * DAY_MS); utimesSync(file, at, at) }
const image = (fill: number, size = 4096) => new Uint8Array(size).fill(fill)

test("the idle sweep removes a pasted image never sent once it is a week old, and keeps a newer one", () => {
  const { store } = setup()
  const old = store.putBlob(image(1), "image/png")
  const recent = store.putBlob(image(2, 2048), "image/png")
  age(store.blobPath(old.sha256), 8)
  age(store.blobPath(recent.sha256), 2)
  expect(store.removeStrayBlobs()).toEqual({ removed: 1, freedBytes: 4096 })
  expect(existsSync(store.blobPath(old.sha256))).toBe(false)
  expect(existsSync(store.blobPath(recent.sha256))).toBe(true)
  store.close()
})

const send = (store: ReturnType<typeof openStore>, sessionId: SessionId, attachments: { sha256: string; bytes: number; mime: string }[]) =>
  store.sessionSink.append({ type: "item.completed", sessionId, itemId: ids("item"), status: "ok", text: "look", attachments } as never)

test("the idle sweep never touches a sent image, a queued one, a tool image or one held by a draft, however old", () => {
  const { store, session } = setup()
  const sent = store.putBlob(image(3), "image/png")
  send(store, session, [sent])
  const queued = store.putBlob(image(9), "image/png")
  store.sessionSink.append({ type: "queue.added", sessionId: session, queueId: ids("queue"), text: "later", attachments: [queued] })
  const tool = store.putBlob(image(4), "image/png")
  store.refBlob(tool, session)
  const drafted = store.putBlob(image(5), "image/png")
  store.drafts.set(session, "[Image #1] ", [{ ...drafted, name: "shot.png", label: "[Image #1]" }])
  const kept = [sent, queued, tool, drafted]
  for (const ref of kept) age(store.blobPath(ref.sha256), 30)
  expect(store.removeStrayBlobs()).toEqual({ removed: 0, freedBytes: 0 })
  for (const ref of kept) expect(store.readBlob(ref.sha256).length).toBe(4096)
  store.close()
})

test("an image pasted twice is stored once and both sessions read the same bytes after a reopen", () => {
  const { dir, store, session } = setup()
  const other = ids("session") as SessionId
  store.createSession({ id: other, directory: "/repo", title: "u" })
  const bytes = image(6, 8192)
  const first = store.putBlob(bytes, "image/png")
  const second = store.putBlob(bytes, "image/png")
  expect(second.sha256).toBe(first.sha256)
  send(store, session, [first])
  send(store, other, [second])
  store.close()
  const reopened = openStore({ dir })
  expect(new Uint8Array(reopened.readBlob(first.sha256))).toEqual(bytes)
  expect(reopened.storageReport()).toMatchObject({ blobs: 1, blobBytes: 8192 })
  reopened.deleteSession(session)
  expect(reopened.collectBlobs()).toEqual({ removed: 0, freedBytes: 0 })
  reopened.deleteSession(other)
  expect(reopened.collectBlobs()).toEqual({ removed: 1, freedBytes: 8192 })
  reopened.close()
})

test("with encryption on, the sweep removes only the sealed stray and sent images still read back", () => {
  const { store, session } = setup()
  store.privacy.set(true)
  const sent = store.putBlob(image(7), "image/png")
  send(store, session, [sent])
  const stray = store.putBlob(image(8), "image/png")
  for (const ref of [sent, stray]) age(store.blobPath(ref.sha256), 10)
  expect(store.removeStrayBlobs().removed).toBe(1)
  expect(existsSync(store.blobPath(stray.sha256))).toBe(false)
  expect(new Uint8Array(store.readBlob(sent.sha256))).toEqual(image(7))
  store.close()
})
