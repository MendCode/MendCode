import { createHash } from "node:crypto"
import { readFileSync, realpathSync, statSync } from "node:fs"
import path from "node:path"

/** Literal dotenv values: no shell execution, variable expansion, or file contents in an error. */
export function parseEnvironmentFile(text: string): Record<string, string> {
  const out: Record<string, string> = Object.create(null)
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trim()
    if (!line || line.startsWith("#")) continue
    const assignment = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!assignment) throw new Error("[ENV]: invalid dotenv assignment")
    const name = assignment[1]!
    let value = assignment[2]!
    const quote = value[0]
    if (quote === '"' || quote === "'" || quote === "`") {
      let end = -1
      for (;;) {
        for (let at = 1; at < value.length; at++) {
          if (quote === '"' && value[at] === "\\") { at++; continue }
          if (value[at] === quote) { end = at; break }
        }
        if (end >= 0) break
        if (++index >= lines.length) throw new Error("[ENV]: unterminated dotenv value")
        value += `\n${lines[index]}`
      }
      if (!/^\s*(?:#.*)?$/.test(value.slice(end + 1))) throw new Error("[ENV]: invalid text after quoted value")
      value = value.slice(1, end)
      if (quote === '"') value = value.replace(/\\([nr"\\])/g, (_, char: string) => char === "n" ? "\n" : char === "r" ? "\r" : char)
    } else value = value.split("#", 1)[0]!.trim()
    if (value) out[name] = value
  }
  return out
}

export function readEnvironmentImport(directory: string, file: string) {
  const root = realpathSync(directory)
  const target = realpathSync(path.resolve(root, file))
  const relative = path.relative(root, target)
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("[ENV]: choose a dotenv file inside this project")
  const stat = statSync(target)
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("[ENV]: dotenv file must be at most 1 MiB")
  const bytes = readFileSync(target)
  if (bytes.length > 1024 * 1024) throw new Error("[ENV]: dotenv file exceeds 1 MiB")
  return { values: parseEnvironmentFile(bytes.toString("utf8")), digest: createHash("sha256").update(bytes).digest("hex") }
}
