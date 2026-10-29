import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory } from "@mendcode/protocol"
import { openStore } from "../src"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const ids = createIdFactory()

describe("refBlob", () => {
  test("a blob only engine history points to survives cleaning while its session exists, and goes with the session", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mend-refblob-"))
    dirs.push(dir)
    const store = openStore({ dir })
    const session = ids("session")
    store.createSession({ id: session, directory: "/repo", title: "t" })
    const kept = store.putBlob(new Uint8Array(2048).fill(3), "image/png")
    const unreferenced = store.putBlob(new Uint8Array(1024).fill(4), "image/png")
    store.refBlob(kept, session)
    // A file written this millisecond can carry an mtime just past Date.now(); age it so it is a stray regardless.
    const past = new Date(Date.now() - 60_000)
    utimesSync(store.blobPath(unreferenced.sha256), past, past)
    expect(store.collectBlobs()).toEqual({ removed: 0, freedBytes: 0 })
    expect(store.cleanStorage({ olderThanDays: 3650, strayGraceMs: 0 }).blobsRemoved).toBe(1)
    expect(Bun.file(store.blobPath(kept.sha256)).size).toBe(2048)
    expect(await Bun.file(store.blobPath(unreferenced.sha256)).exists()).toBe(false)
    store.refBlob(kept, session)
    store.deleteSession(session)
    expect(store.collectBlobs()).toEqual({ removed: 1, freedBytes: 2048 })
    store.close()
  })
})
