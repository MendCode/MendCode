import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"

/** Daemon-wide quota, including project and user scopes. Only names/paths and expiry times are stored. */
export function mcpPendingBudget(dir: string, key: string, expiresAt: number | undefined, now: number, dryRun = false) {
  const file = path.join(dir, "mcp-pending-budget.json")
  let entries: Record<string, number> = {}
  try {
    const data: unknown = JSON.parse(readFileSync(file, "utf8"))
    if (!data || typeof data !== "object" || Array.isArray(data) || Object.values(data).some((value) => typeof value !== "number" || !Number.isFinite(value))) throw new Error("invalid pending budget")
    entries = data as Record<string, number>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("cannot read MCP pending approval budget")
  }
  entries = Object.fromEntries(Object.entries(entries).filter(([name, expiry]) => name !== key && expiry > now))
  if (expiresAt !== undefined) {
    if (Object.keys(entries).length >= 10) throw new Error("MCP pending approval limit (10) reached")
    entries[key] = expiresAt
  }
  if (dryRun) return
  mkdirSync(dir, { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(entries), { mode: 0o600 })
  chmodSync(temporary, 0o600)
  renameSync(temporary, file)
}
