import { existsSync, readFileSync } from "node:fs"

/** Empty ledgers left by a prior stop are not work. Let the real reader handle every other shape. */
export function hasSavedPrWork(file: string, key: "watches" | "jobs" | "sessions"): boolean {
  if (!existsSync(file)) return false
  try {
    const data = JSON.parse(readFileSync(file, "utf8"))
    if (data?.version !== 1) return true
    const rows: unknown = data[key]
    if (key !== "sessions") return !Array.isArray(rows) || rows.length > 0
    return !rows || typeof rows !== "object" || Array.isArray(rows) || Object.keys(rows).length > 0
  } catch { return true }
}
