import { lstatSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { createSkillLoader } from "@mendcode/engine-native"
import { estimateTokens } from "@mendcode/protocol/wire"
import type { PackageInfo } from "@mendcode/protocol"
import type { ExtensionLayer } from "@mendcode/packages"

/** Data-only packages have a measurable skill index and text loaded on demand. Code/config costs stay unknown. */
export function packageContextCost(pkg: PackageInfo, layer?: ExtensionLayer): PackageInfo["contextCost"] {
  try {
    if (pkg.problem || lstatSync(pkg.dir).isSymbolicLink()) return undefined
    const allowed = new Set(["mendcode-package.json", ".mendcode-install.json", "commands", "skills"])
    if (readdirSync(pkg.dir).some((name) => !allowed.has(name))) return undefined
    let files = 0, bytes = 0, chars = 0
    function visit(dir: string, depth: number) {
      if (depth > 6) throw new Error("depth budget")
      const entries = readdirSync(dir, { withFileTypes: true })
      if (entries.length > 500) throw new Error("entry budget")
      for (const entry of entries) {
        if (++files > 500 || entry.isSymbolicLink()) throw new Error("scan budget")
        const file = path.join(dir, entry.name)
        if (entry.isDirectory()) visit(file, depth + 1)
        else if (entry.isFile() && entry.name.endsWith(".md")) {
          const size = lstatSync(file).size
          bytes += size
          if (size > 160_000 || bytes > 512_000) throw new Error("text budget")
          chars += readFileSync(file, "utf8").trim().length
        } else throw new Error("non-text resource")
      }
    }
    for (const kind of ["commands", "skills"]) {
      const dir = path.join(pkg.dir, kind)
      const info = lstatSync(dir, { throwIfNoEntry: false })
      if (!info) continue
      if (!info.isDirectory() || info.isSymbolicLink()) return undefined
      visit(dir, 0)
    }
    const skills = createSkillLoader({ userDir: pkg.dir, layers: () => pkg.enabled ? [layer ?? { dir: pkg.dir, source: pkg.source, pkg: pkg.name }] : [] })
    return { idleTokens: estimateTokens(skills.block(pkg.dir).length), onDemandTokens: estimateTokens(chars), method: "chars/4" }
  } catch {
    return undefined
  }
}
