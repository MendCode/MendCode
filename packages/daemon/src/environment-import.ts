import { createHash } from "node:crypto"
import { readFileSync, realpathSync, statSync } from "node:fs"
import path from "node:path"
import { isRefusedEnvironmentName } from "@mendcode/store"

export const MAX_ENVIRONMENT_PASTE = 1024 * 1024
export type PastedStatus = "new" | "replace" | "refused" | "empty"
export type PastedItem = { name: string; status: PastedStatus; reason?: string; duplicates?: number }

/** Every assignment in order, literal: no shell execution, variable expansion, or file contents in an error. */
function parseAssignments(text: string): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = []
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
    out.push({ name, value })
  }
  return out
}

/** Literal dotenv values; empty assignments are skipped and a later non-empty duplicate wins. */
export function parseEnvironmentFile(text: string): Record<string, string> {
  const out: Record<string, string> = Object.create(null)
  for (const { name, value } of parseAssignments(text)) if (value) out[name] = value
  return out
}

/**
 * Names found in pasted dotenv text, each with what saving it would do. The values stay in `values` (importable names only)
 * for the caller to save; the `items` are the part that may be sent back to the terminal.
 */
export function previewPastedEnvironment(text: string, existing: ReadonlySet<string>) {
  if (text.length > MAX_ENVIRONMENT_PASTE) throw new Error("[ENV]: pasted text must be at most 1 MiB")
  const assignments = parseAssignments(text)
  const seen = new Map<string, number>()
  for (const { name } of assignments) seen.set(name, (seen.get(name) ?? 0) + 1)
  const values = parseEnvironmentFile(text)
  const items: PastedItem[] = []
  const importable: Record<string, string> = Object.create(null)
  for (const [name, count] of seen) {
    const duplicates = count > 1 ? { duplicates: count - 1 } : {}
    const value = values[name]
    if (name.length > 128 || isRefusedEnvironmentName(name)) items.push({ name, status: "refused", reason: "runtime configuration name", ...duplicates })
    else if (value === undefined) items.push({ name, status: "empty", ...duplicates })
    else if (value.length > 16_384 || value.includes("\0")) items.push({ name, status: "refused", reason: "value too long or invalid", ...duplicates })
    else { importable[name] = value; items.push({ name, status: existing.has(name) ? "replace" : "new", ...duplicates }) }
  }
  return { items, values: importable, digest: createHash("sha256").update(text).digest("hex") }
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
