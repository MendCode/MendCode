import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { openStore } from "../src"

test("retired engine overrides preserve other saved security settings without exposing values", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-retired-settings-"))
  let store: ReturnType<typeof openStore> | undefined
  try {
    store = openStore({ dir })
    store.settings.set({ theme: "amber", tier: "full" })
    store.close()
    store = undefined
    const db = new Database(path.join(dir, "mendd.db"))
    try {
      db.query("UPDATE settings SET payload = ? WHERE id = 1").run(JSON.stringify({ theme: "amber", tier: "full", features: { opencode: "private fixture value", cursor: true, mcp: false, pi: false } }))
    } finally { db.close() }
    store = openStore({ dir })
    expect(store.settings.get()).toEqual({ theme: "amber", tier: "full", features: { mcp: false, pi: false } })
    expect(store.settings.invalid()).toEqual(["unknown feature opencode: ignored", "unknown feature cursor: ignored"])
    expect(() => store!.settings.set({ features: { cursor: true } })).toThrow()
    expect(store.settings.get().features).toEqual({ mcp: false, pi: false })
    store.settings.set({ theme: "teal" })
    expect(store.settings.invalid()).toEqual([])
    store.close()
    store = openStore({ dir })
    expect(store.settings.get()).toEqual({ theme: "teal", tier: "full", features: { mcp: false, pi: false } })
  } finally {
    store?.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
