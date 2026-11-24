import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { remoteTokens } from "../src/remote"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); Date.now = realNow })
const realNow = Date.now
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "mendcode-token-expiry-")); dirs.push(dir); return dir }

test("a token with an expiry authenticates until then and is then dropped like a revoked one", () => {
  const store = remoteTokens(temp())
  const dayMs = 86_400_000
  const timed = store.create({ name: "phone", expiresInMs: dayMs })
  const forever = store.create({ name: "laptop" })
  const peer = store.authenticate(timed.token)!
  expect(peer.expiresAt).toBe(timed.expiresAt)
  expect(store.active({ name: peer.name, hash: peer.hash, readOnly: peer.readOnly })).toBe(true)
  const start = Date.now()
  Date.now = () => start + dayMs + 1
  expect(store.authenticate(timed.token)).toBeUndefined()
  expect(store.active({ name: peer.name, hash: peer.hash, readOnly: peer.readOnly })).toBe(false)
  expect(store.authenticate(forever.token)).toBeDefined()
  expect(store.list().find((entry) => entry.name === "phone")?.expiresAt).toBe(timed.expiresAt)
  expect(store.list().find((entry) => entry.name === "laptop")?.expiresAt).toBeUndefined()
})

test("a store written before expiry existed still loads", () => {
  const dir = temp()
  const store = remoteTokens(dir)
  const created = store.create({ name: "old" })
  expect(created.expiresAt).toBeUndefined()
  expect(store.authenticate(created.token)).toBeDefined()
})
