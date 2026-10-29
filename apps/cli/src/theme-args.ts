import { THEME_NAME } from "@mendcode/protocol/wire"
import type { Common, ParseResult } from "./automation"
import { COMPAT } from "./compat"
import { PROGRAM_NAME } from "@mendcode/program"

export type ThemeAutomation =
  | { kind: "theme.validate"; file: string }
  | { kind: "theme.install"; file: string; name?: string; scope: "user" | "project" }
  | { kind: "theme.select"; name: string; scope: "user" | "project" }

export const THEME_USAGE = `usage: ${PROGRAM_NAME} theme validate <file>\n  theme install <file> [--name NAME] [--scope project|user|global]\n  theme select <name> [--scope project|user|global]\n  --dir D | --data-dir D  --json | --format json`
const VALUES = new Set(["dir", "data-dir", "engine", "name", "scope", "format", "compat"])

export function parseTheme(argv: string[]): ParseResult | undefined {
  let root: string | undefined
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!
    if (token.startsWith("--")) {
      if (!token.includes("=") && VALUES.has(token.slice(2))) index++
    } else { root = token; break }
  }
  if (root !== "theme") return undefined
  const bad = (message: string): ParseResult => ({ ok: false, topic: "theme", message })
  const words: string[] = []
  const flags = new Map<string, string | true>()
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!
    if (token === "--") { words.push(...argv.slice(index + 1)); break }
    if (!token.startsWith("-")) { words.push(token); continue }
    const [name, inline] = token.slice(2).split(/=(.*)/s, 2)
    if (["json", "help"].includes(name!)) {
      if (inline !== undefined && !["true", "false"].includes(inline)) return bad(`--${name} needs true|false`)
      if (inline !== "false") flags.set(name!, true)
    } else if (VALUES.has(name!)) {
      const value = inline ?? argv[++index]
      if (!value || value.startsWith("--")) return bad(`--${name} needs a value`)
      flags.set(name!, value)
    } else return bad(`unknown flag ${token}`)
  }
  if (flags.has("help")) return { ok: true, command: { kind: "help", topic: "theme", json: false } }
  const str = (name: string) => typeof flags.get(name) === "string" ? String(flags.get(name)) : undefined
  if (str("format") && !["text", "json", "table"].includes(str("format")!)) return bad("--format needs text|json|table")
  if (str("compat") && str("compat") !== COMPAT) return bad(`--compat must be ${COMPAT}`)
  const common: Common = { json: flags.has("json") || str("format") === "json" || !!str("compat"), ...(str("data-dir") ?? str("dir") ? { dir: str("data-dir") ?? str("dir")! } : {}), ...(str("compat") ? { compat: COMPAT } : {}) }
  const [command, argument, extra] = words.slice(1)
  if (!argument || extra || !["validate", "install", "select"].includes(command!)) return bad(THEME_USAGE)
  const rawScope = str("scope") ?? "project"
  if (!["user", "project", "global"].includes(rawScope)) return bad("--scope needs user|project|global")
  const scope = rawScope === "global" ? "user" : rawScope as "user" | "project"
  if (command !== "install" && flags.has("name")) return bad("--name only applies to theme install")
  if (command === "validate" && flags.has("scope")) return bad("theme validate has no scope")
  const name = (command === "select" ? argument : str("name"))?.trim()
  if (name !== undefined && !THEME_NAME.test(name)) return bad("Theme name must use letters, numbers, dot, underscore or hyphen (max 40)")
  if (command === "validate") return { ok: true, command: { ...common, kind: "theme.validate", file: argument } }
  if (command === "install") return { ok: true, command: { ...common, kind: "theme.install", file: argument, ...(name ? { name } : {}), scope } }
  return { ok: true, command: { ...common, kind: "theme.select", name: name!, scope } }
}
