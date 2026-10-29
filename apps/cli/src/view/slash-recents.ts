import fs from "node:fs"
import path from "node:path"
import { SLASH_LAYOUTS } from "@mendcode/protocol/wire"

export type SlashRecent = { name: string; count: number; last: number }
const MAX = 128
export const slashRecentsPath = (dir: string) => path.join(dir, "tui", "slash-recents.json")
export function hasSlashLayout(dir: string): boolean {
  try { return SLASH_LAYOUTS.includes(JSON.parse(fs.readFileSync(path.join(dir, "tui", "profile.json"), "utf8")).slashMenu) } catch { return false }
}
export function readSlashRecents(dir: string): SlashRecent[] {
  try {
    const file = slashRecentsPath(dir)
    if (fs.statSync(file).size > 32768) return []
    const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"))
    if (!Array.isArray(raw)) return []
    const seen = new Set<string>()
    return raw.slice(0, MAX).flatMap((entry) => {
      if (!entry || typeof entry.name !== "string" || !/^[a-z0-9][a-z0-9:_-]{0,127}$/i.test(entry.name) || seen.has(entry.name) || !Number.isSafeInteger(entry.count) || entry.count < 1 || !Number.isSafeInteger(entry.last) || entry.last < 0) return []
      seen.add(entry.name)
      return [{ name: entry.name, count: entry.count, last: entry.last }]
    })
  } catch { return [] }
}
export function noteSlashRecent(recents: readonly SlashRecent[], name: string, now: number): SlashRecent[] {
  if (!/^[a-z0-9][a-z0-9:_-]{0,127}$/i.test(name) || !Number.isSafeInteger(now) || now < 0) return [...recents]
  const old = recents.find((entry) => entry.name === name)
  return [{ name, count: Math.min(1000000, (old?.count ?? 0) + 1), last: now }, ...recents.filter((entry) => entry.name !== name)].slice(0, MAX)
}
export function saveSlashRecent(dir: string, name: string, now: number): SlashRecent[] {
  const recents = noteSlashRecent(readSlashRecents(dir), name, now)
  const file = slashRecentsPath(dir)
  const temporary = `${file}.${process.pid}.tmp`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(temporary, JSON.stringify(recents) + "\n", { mode: 0o600 })
  fs.renameSync(temporary, file)
  return recents
}
