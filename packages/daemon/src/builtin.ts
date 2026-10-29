import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { computeBuildId } from "@mendcode/build-id"
import quick from "../builtin/recipes/quick.json"
import balanced from "../builtin/recipes/balanced.json"
import deep from "../builtin/recipes/deep.json"

const recipes = { quick, balanced, deep }

/** Bun 1.3's virtual filesystem paths (including the Windows spelling): the program runs from the compiled binary. */
const COMPILED = /^(\/\$bunfs\/|[A-Za-z]:[\\/]~BUN[\\/])/

/** Folder loaders need real directory entries. Materialize only packaged bytes (the model recipes; no skills, no MCP servers) under the selected data dir. */
export function builtinDir(dir: string) {
  if (!COMPILED.test(Bun.main)) return path.join(import.meta.dir, "..", "builtin")
  const root = path.join(dir, "builtin", computeBuildId())
  const files = Object.fromEntries(Object.entries(recipes).map(([name, recipe]) => [`recipes/${name}.json`, Buffer.from(JSON.stringify(recipe) + "\n")]))
  for (const [relative, bytes] of Object.entries(files)) {
    const file = path.join(root, relative)
    let current: Buffer | undefined
    try { current = readFileSync(file) } catch {}
    if (current?.equals(bytes)) continue
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, bytes)
  }
  return root
}
