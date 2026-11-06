import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { openStore } from "../src"

test("settings writes preserve future keys and invalid known values with transactional bounded history", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "settings-safety-"))
  let store: ReturnType<typeof openStore> | undefined
  try {
    openStore({ dir }).close()
    const db = new Database(path.join(dir, "mendd.db"))
    db.query("INSERT INTO settings(id,payload) VALUES(1,?)").run(JSON.stringify({ future: { a: 1 }, tier: "future-tier", theme: "old" }))
    db.close()
    store = openStore({ dir })
    expect(store.settings.get()).toEqual({ theme: "old" })
    store.settings.set({ theme: "new" })
    const id = store.settings.history()[0]!.id
    expect(store.settings.restore(id).theme).toBe("old")
    for (let n = 0; n < 80; n++) store.settings.set({ theme: `theme-${n}` })
    expect(store.settings.history().length).toBeLessThanOrEqual(60)
    store.close(); store = undefined
    const verify = new Database(path.join(dir, "mendd.db"))
    const raw = JSON.parse(verify.query<{ payload: string }, []>("SELECT payload FROM settings WHERE id=1").get()!.payload)
    expect(raw).toMatchObject({ future: { a: 1 }, tier: "future-tier", theme: "theme-79" })
    verify.close()
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }) }
})
