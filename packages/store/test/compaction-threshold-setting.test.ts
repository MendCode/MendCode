import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory, ProvidersSet, THRESHOLD_RULE } from "@mendcode/protocol"
import { openStore } from "../src"

function withStore(run: (store: ReturnType<typeof openStore>) => void) {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-compaction-threshold-"))
  try {
    const store = openStore({ dir })
    try { run(store) } finally { store.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

test("a new compaction.threshold is a percent of the window: 80 and 0.8 are saved, 150 and 0 are refused with the rule", () => {
  withStore((store) => {
    expect(store.settings.set({ compaction: { auto: true, threshold: 80 } }).compaction).toEqual({ auto: true, threshold: 80 })
    expect(store.settings.check({ compaction: { threshold: 0.8 } }).compaction).toEqual({ threshold: 0.8 })
    for (const threshold of [150, 0, -5]) {
      expect(() => store.settings.check({ compaction: { threshold } })).toThrow(THRESHOLD_RULE)
      expect(() => store.settings.set({ compaction: { threshold } })).toThrow(THRESHOLD_RULE)
    }
    expect(store.settings.get().compaction).toEqual({ auto: true, threshold: 80 })
    expect(store.settings.set({ compaction: null }).compaction).toBeUndefined()
  })
})

test("a saved threshold outside the range still reads, so the rest of the compaction setting is kept", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-compaction-threshold-"))
  try {
    openStore({ dir }).close()
    const db = new Database(path.join(dir, "mendd.db"))
    try { db.query("INSERT INTO settings(id, payload) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload").run(JSON.stringify({ compaction: { auto: false, threshold: 150 } })) } finally { db.close() }
    const store = openStore({ dir })
    try {
      expect(store.settings.get().compaction).toEqual({ auto: false, threshold: 150 })
      expect(store.settings.set({ theme: "amber" }).compaction).toEqual({ auto: false, threshold: 150 })
    } finally { store.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("providers.set refuses a provider threshold outside the range", () => {
  const ids = createIdFactory()
  const base = { id: ids("command"), clientId: ids("client"), type: "providers.set", provider: "openai" }
  expect(ProvidersSet.safeParse({ ...base, compaction: { threshold: 80 } }).success).toBe(true)
  const refused = ProvidersSet.safeParse({ ...base, compaction: { threshold: 150 } })
  expect(refused.success).toBe(false)
  expect(refused.error?.issues[0]?.message).toBe(THRESHOLD_RULE)
})
