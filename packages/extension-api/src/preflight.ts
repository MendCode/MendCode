import { readFileSync, statSync } from "node:fs"
import path from "node:path"

/** Local files followed from one module: enough for an extension and its helpers, bounded so a huge tree costs nothing. */
const MAX_FILES = 64
const MAX_BYTES = 1_000_000
const SOURCE = /\.(?:ts|tsx|js|mjs|cjs|jsx)$/
const firstLine = (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 200)

/**
 * Checks a module and the local files it imports without importing any of them; returns why it cannot load, or undefined.
 *
 * Bun keeps a failed import (a syntax error, an import that cannot be resolved) in its module registry. After the user
 * fixes the file, a later import of the same path keeps failing or never settles until the process restarts, which is
 * exactly the edit-fix loop a reload is for. Parsing and resolving first leaves the registry clean, so the fix applies on
 * the next reload and a broken edit never poisons the working version.
 */
export function preflightModule(file: string): string | undefined {
  const seen = new Set<string>()
  const queue = [file]
  while (queue.length > 0 && seen.size < MAX_FILES) {
    const current = queue.shift()!
    if (seen.has(current)) continue
    seen.add(current)
    const label = current === file ? "" : `${path.basename(current)}: `
    let source: string
    try {
      if (statSync(current).size > MAX_BYTES) continue
      source = readFileSync(current, "utf8")
    } catch (error) {
      return `${label}cannot read ${path.basename(current)}: ${firstLine(error)}`
    }
    const transpiler = new Bun.Transpiler({ loader: /\.(?:ts|tsx)$/.test(current) ? "ts" : "js" })
    let imports: Array<{ path: string }>
    try {
      transpiler.transformSync(source)
      imports = transpiler.scanImports(source)
    } catch (error) {
      return `${label}${firstLine(error)}`
    }
    for (const { path: specifier } of imports) {
      if (/^(?:node|bun|data|https?):/.test(specifier)) continue
      let resolved: string
      try {
        resolved = Bun.resolveSync(specifier, path.dirname(current))
      } catch {
        return `${label}cannot resolve "${specifier}"`
      }
      // Only the user's own sibling files are followed; installed packages are not parsed again.
      if (path.isAbsolute(resolved) && SOURCE.test(resolved) && !resolved.includes(`${path.sep}node_modules${path.sep}`)) queue.push(resolved)
    }
  }
  return undefined
}
