import type { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"

/** Lives in the same private/encrypted database; a snapshot and its settings mutation commit together. */
export function createSettingsHistory(db: Database, now: () => number) {
  db.run("CREATE TABLE IF NOT EXISTS settings_history (id TEXT PRIMARY KEY, at INTEGER NOT NULL, payload TEXT NOT NULL)")
  db.run("CREATE INDEX IF NOT EXISTS settings_history_at ON settings_history(at DESC)")
  const list = () => db.query<{ id: string; at: number; payload: string }, []>("SELECT id, at, payload FROM settings_history ORDER BY at DESC, rowid DESC").all()
  function snapshot(payload: string) {
    const rows = list()
    if (rows[0]?.payload === payload) return rows[0].id
    const at = now()
    const id = randomUUID()
    db.query("INSERT INTO settings_history (id, at, payload) VALUES (?, ?, ?)").run(id, at, payload)
    const all = [{ id, at, payload }, ...rows]
    const days = new Set<string>()
    for (let i = 0; i < all.length; i++) {
      const row = all[i]!
      const day = new Date(row.at).toISOString().slice(0, 10)
      const daily = row.at >= Math.floor(at / 86400000) * 86400000 - 29 * 86400000 && !days.has(day)
      days.add(day)
      if (i >= 30 && !daily) db.query("DELETE FROM settings_history WHERE id = ?").run(row.id)
    }
    return id
  }
  const initial = db.query<{ payload: string }, []>("SELECT payload FROM settings WHERE id = 1").get()
  if (initial) db.transaction(() => snapshot(initial.payload))()
  return { list, snapshot }
}
