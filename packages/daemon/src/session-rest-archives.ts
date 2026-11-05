import { readFileSync } from "node:fs"
import path from "node:path"

/** Preserve startup validation and the archive snapshot without loading REST projections. */
export function readRestArchives(dir: string): Record<string, number> {
  try {
    const value = JSON.parse(readFileSync(path.join(dir, "session-rest.json"), "utf8"))
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.values(value).some((entry) => typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < 0)) throw new Error("invalid session-rest.json")
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    return {}
  }
}
