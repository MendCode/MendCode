import { createHash } from "node:crypto"
import { lstatSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"

/** Compare resource bytes without executing modules. Bounded and fail-closed for links/large trees. */
export function packageFingerprint(directory: string): string | undefined {
  const hash = createHash("sha256")
  let files = 0, bytes = 0
  const walk = (dir: string, depth: number): boolean => {
    if (depth > 8) return false
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (["mendcode-package.json", ".mendcode-install.json", "node_modules", ".git"].includes(entry.name)) continue
      const file = path.join(dir, entry.name)
      const info = lstatSync(file)
      if (info.isSymbolicLink()) return false
      if (info.isDirectory()) { if (!walk(file, depth + 1)) return false }
      else if (info.isFile()) {
        if (++files > 128 || (bytes += info.size) > 1024 * 1024) return false
        hash.update(JSON.stringify(path.relative(directory, file)))
        hash.update(String(info.size))
        hash.update(readFileSync(file))
      } else return false
    }
    return true
  }
  try { return walk(directory, 0) && files ? hash.digest("hex") : undefined } catch { return undefined }
}
