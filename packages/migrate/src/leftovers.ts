import { existsSync, lstatSync, readdirSync } from "node:fs"
import path from "node:path"
import type { NotMigrated } from "./report"
import { MAX_WALK_ENTRIES, NOT_MIGRATED_DIRS, OTHER_DB_REASON, V1_CREDENTIAL_FILES, V1_DB_FILE } from "./settings"

/** Bytes under `root` by a stat walk that never follows links and stops after `limit` entries (then it is a lower bound). */
export function measureTree(root: string, limit = MAX_WALK_ENTRIES) {
  let bytes = 0
  let visited = 0
  const pending = [root]
  while (pending.length > 0) {
    const current = pending.pop()!
    let stat
    try {
      stat = lstatSync(current)
    } catch {
      continue
    }
    if (++visited > limit) return { bytes, approximate: true }
    if (stat.isDirectory()) {
      try {
        for (const name of readdirSync(current)) pending.push(path.join(current, name))
      } catch {}
    } else bytes += stat.size
  }
  return { bytes, approximate: false }
}

/** The v1 directories and databases the import leaves behind, with their sizes; absent ones are not listed. */
export function measureLeftovers(from: string): NotMigrated[] {
  const found: NotMigrated[] = []
  for (const { name, reason } of NOT_MIGRATED_DIRS) {
    const full = path.join(from, name)
    if (existsSync(full)) found.push({ name, reason, ...measureTree(full) })
  }
  for (const name of readdirSync(from).sort()) {
    const main = name === V1_DB_FILE || name.startsWith(`${V1_DB_FILE}-`)
    if (name.endsWith(".db") && !main) found.push({ name, reason: OTHER_DB_REASON, ...measureTree(path.join(from, name)) })
  }
  return found
}

/** Credential files that exist in v1. Only their presence is checked; their content is never opened. */
export function credentialFilesPresent(from: string) {
  return V1_CREDENTIAL_FILES.filter((name) => existsSync(path.join(from, name)))
}
