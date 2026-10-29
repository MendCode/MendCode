import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { layerAllows, type ExtensionLayer, type ExtensionSource } from "./layers"

export const MAX_THEME_FILES = 100
const MAX_THEME_BYTES = 16 * 1024
const THEME_NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/i

/**
 * A theme file as found: `themes/<name>.json` in any layer. The daemon only reads and parses it; the client
 * validates the palette (it owns the color roles), so a bad file shows up as a problem, never as a crash.
 */
export type ThemeFile = { name: string; file: string; source: ExtensionSource; pkg?: string; json?: unknown; problem?: string }

/** Every layer's theme files, lowest precedence first; a later layer's file replaces one of the same name. */
export function readLayerThemes(layers: readonly ExtensionLayer[]): ThemeFile[] {
  const byName = new Map<string, ThemeFile>()
  for (const layer of layers) {
    const dir = path.join(layer.dir, "themes")
    let entries: string[]
    try {
      entries = readdirSync(dir).filter((entry) => entry.endsWith(".json")).sort()
    } catch {
      continue
    }
    for (const entry of entries) {
      if (byName.size >= MAX_THEME_FILES) break
      const name = entry.slice(0, -".json".length)
      if (!layerAllows(layer, "themes", name)) continue
      const file = path.join(dir, entry)
      const base = { name, file, source: layer.source, ...(layer.pkg ? { pkg: layer.pkg } : {}) }
      byName.delete(name)
      byName.set(name, { ...base, ...parseThemeFile(file, name) })
    }
  }
  return [...byName.values()]
}

function parseThemeFile(file: string, name: string): { json: unknown } | { problem: string } {
  if (!THEME_NAME.test(name)) return { problem: "theme file names use letters, digits, dot, underscore and hyphen (max 40)" }
  const size = statSync(file, { throwIfNoEntry: false })?.size
  if (size === undefined) return { problem: "not readable" }
  if (size > MAX_THEME_BYTES) return { problem: `larger than ${MAX_THEME_BYTES / 1024} KB` }
  try {
    return { json: JSON.parse(readFileSync(file, "utf8")) as unknown }
  } catch (error) {
    return { problem: `invalid JSON: ${(error as Error).message}` }
  }
}
