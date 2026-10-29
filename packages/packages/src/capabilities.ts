import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs"
import path from "node:path"
import type { PackageCapabilities } from "@mendcode/protocol"
import { readManifest } from "./manifest"

/** Static hints only. Never import code, follow symlinks, or print source text (which may contain secrets). */
export function packageCapabilities(directory: string): PackageCapabilities {
  const manifest = readManifest(directory)
  const declared = "manifest" in manifest ? manifest.manifest.capabilities ?? [] : []
  const observed = new Set<string>()
  const environment = new Set<string>()
  let complete = true, files = 0, bytes = 0
  const root = realpathSync(directory)
  const patterns: Record<string, RegExp> = {
    hooks: /\b(?:registerHook|on)\s*\(\s*["'](?:tool\.|session\.|turn\.|compact\.|before_|after_)/,
    tools: /\b(?:registerTool|defineTool)\s*\(/,
    commands: /\bregisterCommand\s*\(/,
    network: /\bfetch\s*\(|(?:node:)?(?:https?|net|tls)["']|\bWebSocket\s*\(/,
    processes: /\bBun\.spawn|child_process|\b(?:exec|spawn)\s*\(/,
    filesystem: /(?:node:)?fs(?:\/promises)?["']/,
  }
  const walk = (dir: string, depth: number) => {
    if (depth > 8) {
      complete = false
      return
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (files >= 64 || bytes >= 512 * 1024) {
        complete = false
        return
      }
      const file = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        complete = false
        continue
      }
      if (["node_modules", ".git"].includes(entry.name)) continue
      if (entry.isDirectory()) {
        walk(file, depth + 1)
        continue
      }
      if (!entry.isFile() || !/\.(?:[cm]?[jt]s|json)$/.test(entry.name)) continue
      const info = lstatSync(file)
      if (info.size > 32 * 1024) {
        complete = false
        continue
      }
      // Refuse paths that changed to links while walking.
      if (info.isSymbolicLink() || path.relative(root, realpathSync(file)).startsWith("..")) {
        complete = false
        continue
      }
      files++
      bytes += info.size
      const text = readFileSync(file, "utf8")
      for (const [name, pattern] of Object.entries(patterns)) if (pattern.test(text)) observed.add(name)
      for (const match of text.matchAll(/\b(?:process|Bun)\.env(?:\.([A-Z_][A-Z0-9_]{0,63})\b|\[\s*["']([A-Z_][A-Z0-9_]{0,63})["']\s*\])/g)) {
        if (environment.size >= 32) { complete = false; break }
        environment.add(match[1] ?? match[2]!)
      }
    }
  }
  try { walk(root, 0) } catch { complete = false }
  return { declared, observed: [...observed].sort(), complete, declaredEnvironment: "manifest" in manifest ? manifest.manifest.environment ?? [] : [], observedEnvironment: [...environment].sort() }
}
