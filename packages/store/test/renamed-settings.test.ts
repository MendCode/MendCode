import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { openStore } from "../src"

const OLD = [{ name: "work", directories: ["/w"] }]
const NEW = [{ name: "home", directories: ["/h"] }]

function openWith(dir: string, payload: Record<string, unknown>) {
  openStore({ dir }).close()
  const db = new Database(path.join(dir, "mendd.db"))
  try { db.query("INSERT INTO settings(id, payload) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload").run(JSON.stringify(payload)) } finally { db.close() }
  return openStore({ dir })
}

test("the older `profiles` setting (folders) reads as `areas`, is written as `areas`, and the new name wins when both are saved", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-renamed-settings-"))
  try {
    const store = openWith(dir, { theme: "amber", profiles: OLD })
    expect(store.settings.get()).toEqual({ theme: "amber", areas: OLD })
    expect(store.settings.invalid()).toEqual([])
    store.settings.set({ profiles: NEW })
    expect(store.settings.get().areas).toEqual(NEW)
    const raw = () => { const db = new Database(path.join(dir, "mendd.db")); try { return JSON.parse(db.query<{ payload: string }, []>("SELECT payload FROM settings WHERE id = 1").get()!.payload) as Record<string, unknown> } finally { db.close() } }
    expect(raw()).toEqual({ theme: "amber", areas: NEW })
    store.settings.set({ areas: null })
    expect(raw()).toEqual({ theme: "amber" })
    store.close()
    const both = openWith(dir, { profiles: OLD, areas: NEW })
    expect(both.settings.get().areas).toEqual(NEW)
    both.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("saved `disabledPackages`, `disabledPackageResources` and the older feature ids read as the profile names", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-renamed-profiles-"))
  try {
    const store = openWith(dir, { disabledPackages: ["user:a"], disabledPackageResources: ["user:a/skills/b"], features: { packages: false, package_tools: true }, tools: { packages: false } })
    expect(store.settings.get()).toEqual({ disabledProfiles: ["user:a"], disabledProfileResources: ["user:a/skills/b"], features: { profiles: false, profile_tools: true }, tools: { profiles: false } })
    expect(store.settings.invalid()).toEqual([])
    store.settings.set({ disabledPackages: null })
    expect(store.settings.get().disabledProfiles).toBeUndefined()
    expect(store.settings.get().disabledProfileResources).toEqual(["user:a/skills/b"])
    store.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
