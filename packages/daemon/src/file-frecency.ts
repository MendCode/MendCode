import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"

type Entry = { file: string; frequency: number; lastOpen: number }
export function createFileFrecency(dir: string) {
  const file = path.join(dir, "file-frecency.json")
  const entries = new Map<string, Entry>()
  let loaded = false
  const load = () => {
    if (loaded) return
    loaded = true
    try {
      if (statSync(file).size > 512_000) return
      const values: unknown = JSON.parse(readFileSync(file, "utf8"))
      if (!Array.isArray(values)) return
      for (const value of values.slice(0, 1000)) if (value && typeof value.file === "string" && value.file.length <= 8192 && Number.isFinite(value.frequency) && value.frequency > 0 && Number.isFinite(value.lastOpen)) entries.set(value.file, value)
    } catch {}
  }
  return {
    score(root: string, target: string) {
      load()
      if (target.endsWith("/")) return 0
      const entry = entries.get(path.resolve(root, target))
      return entry ? entry.frequency / (1 + Math.max(0, Date.now() - entry.lastOpen) / 86400000) : 0
    },
    opened(root: string, target: string) {
      load()
      const key = path.resolve(root, target)
      entries.set(key, { file: key, frequency: (entries.get(key)?.frequency ?? 0) + 1, lastOpen: Date.now() })
      const values = [...entries.values()].sort((a, b) => b.lastOpen - a.lastOpen).slice(0, 1000)
      entries.clear()
      for (const entry of values) entries.set(entry.file, entry)
      try {
        const temp = `${file}.${process.pid}.tmp`
        writeFileSync(temp, JSON.stringify(values), { mode: 0o600 })
        renameSync(temp, file)
      } catch {}
    },
  }
}
