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

function openWithSavedSettings(dir: string, payload: Record<string, unknown>) {
  openStore({ dir }).close()
  const db = new Database(path.join(dir, "mendd.db"))
  try {
    db.query("INSERT INTO settings(id, payload) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload").run(JSON.stringify(payload))
    db.query("DELETE FROM meta WHERE key = 'recipe-compaction-role-cleared'").run()
  } finally { db.close() }
  const store = openStore({ dir })
  const models = store.settings.get().models
  return { store, models }
}

test("a saved compaction role equal to the old built-in recipe binding is cleared once; any other value stays", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-recipe-compaction-"))
  try {
    for (const effort of ["low", "medium"] as const) {
      const { store, models } = openWithSavedSettings(dir, { models: { main: { model: "gpt-6-sol", effort: "high" }, compaction: { model: "gpt-6-luna", effort } } })
      expect(models).toEqual({ main: { model: "gpt-6-sol", effort: "high" } })
      // Chosen again on purpose after the migration ran, it is kept.
      store.settings.set({ models: { main: { model: "gpt-6-sol", effort: "high" }, compaction: { model: "gpt-6-luna", effort } } })
      store.close()
      const again = openStore({ dir })
      expect(again.settings.get().models?.compaction).toEqual({ model: "gpt-6-luna", effort })
      again.close()
    }
    for (const own of [{ model: "gpt-6-luna", effort: "high" }, { model: "gpt-6-sol", effort: "low" }, { model: "gpt-6-luna" }, { model: "gpt-6-luna", effort: "low", variant: "fast" }]) {
      const { store, models } = openWithSavedSettings(dir, { models: { compaction: own } })
      expect(models as unknown).toEqual({ compaction: own })
      store.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
