import type { Common, ParseResult } from "./automation"
import { PROGRAM_NAME } from "@mendcode/program"

export type ConflictChoice = "keep" | "replace"

export type ConfigBundleAutomation =
  | { kind: "config-bundle.inventory" }
  | { kind: "config-bundle.export"; file: string; allowFlagged: string[]; overwrite: boolean }
  | { kind: "config-bundle.inspect"; file: string }
  | { kind: "config-bundle.import"; file: string; apply: boolean; plan?: string; onConflict: ConflictChoice; resolve: Record<string, ConflictChoice>; rewriteHome: boolean }
  | { kind: "config-bundle.imports" }
  | { kind: "config-bundle.rollback"; importId: string; force: boolean }

export const CONFIG_BUNDLE_USAGE = `usage: ${PROGRAM_NAME} config-bundle <command> [--dir D] [--json]
  inventory                                  what this data directory holds and where each part falls (read-only)
  export <file> [--allow-flagged PATH]... [--overwrite]
                                             one verifiable file: manifest, sha256 per file, exclusions listed
  inspect <file>                             check the hashes and list what the bundle carries (read-only)
  import <file> [--on-conflict keep|replace] [--resolve ITEM=keep|replace]... [--rewrite-home]
                                             preview only: nothing changes; prints the plan id
  import <file> --apply --plan ID [same options]
                                             applies exactly the previewed plan, with backups and a journal
  imports                                    earlier imports of this data directory
  rollback <import-id> [--force]             undoes one import; --force also undoes items changed since`

const VALUE_FLAGS = new Set(["dir", "data-dir", "format", "allow-flagged", "on-conflict", "resolve", "plan", "engine"])
const BOOLEAN_FLAGS = new Set(["json", "help", "overwrite", "apply", "rewrite-home", "force"])
const COMMANDS = ["inventory", "export", "inspect", "import", "imports", "rollback"]

/** `config-bundle …`: undefined when argv is another command. */
export function parseConfigBundle(argv: string[]): ParseResult | undefined {
  let root: string | undefined
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!
    if (token.startsWith("--")) { if (!token.includes("=") && VALUE_FLAGS.has(token.slice(2))) index++ }
    else { root = token; break }
  }
  if (root !== "config-bundle") return undefined
  const bad = (message: string): ParseResult => ({ ok: false, topic: "config-bundle", message })
  const words: string[] = []
  const values = new Map<string, string[]>()
  const flags = new Set<string>()
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!
    if (token === "--") { words.push(...argv.slice(index + 1)); break }
    if (!token.startsWith("--")) { words.push(token); continue }
    const [name, inline] = token.slice(2).split(/=(.*)/s, 2) as [string, string | undefined]
    if (BOOLEAN_FLAGS.has(name)) {
      if (inline !== undefined && !["true", "false"].includes(inline)) return bad(`--${name} needs true|false`)
      if (inline !== "false") flags.add(name)
    } else if (VALUE_FLAGS.has(name)) {
      const value = inline ?? argv[++index]
      if (!value || value.startsWith("--")) return bad(`--${name} needs a value`)
      values.set(name, [...values.get(name) ?? [], value])
    } else return bad(`unknown flag ${token}`)
  }
  if (flags.has("help")) return { ok: true, command: { kind: "help", topic: "config-bundle", json: false } }
  const one = (name: string) => values.get(name)?.at(-1)
  const format = one("format")
  if (format && !["text", "json"].includes(format)) return bad("--format needs text|json")
  const dir = one("data-dir") ?? one("dir")
  const common: Common = { json: flags.has("json") || format === "json", ...(dir ? { dir } : {}) }
  const [, command, argument, extra] = words
  if (!command || !COMMANDS.includes(command)) return bad(CONFIG_BUNDLE_USAGE)
  if (extra !== undefined) return bad(`unexpected argument ${extra}`)
  const allowedFlags: Record<string, string[]> = { inventory: [], imports: [], inspect: [], export: ["allow-flagged", "overwrite"], import: ["on-conflict", "resolve", "rewrite-home", "apply", "plan"], rollback: ["force"] }
  const misplaced = [...values.keys(), ...flags].filter((name) => !["dir", "data-dir", "format", "json", "engine"].includes(name) && !allowedFlags[command]!.includes(name))
  if (misplaced.length) return bad(`--${misplaced[0]} does not apply to config-bundle ${command}`)
  if (["inventory", "imports"].includes(command)) return argument ? bad(`config-bundle ${command} takes no argument`) : { ok: true, command: { ...common, kind: command === "inventory" ? "config-bundle.inventory" : "config-bundle.imports" } }
  if (!argument) return bad(`config-bundle ${command} needs ${command === "rollback" ? "<import-id>" : "<file>"}`)
  if (command === "export") return { ok: true, command: { ...common, kind: "config-bundle.export", file: argument, allowFlagged: values.get("allow-flagged") ?? [], overwrite: flags.has("overwrite") } }
  if (command === "inspect") return { ok: true, command: { ...common, kind: "config-bundle.inspect", file: argument } }
  if (command === "rollback") return { ok: true, command: { ...common, kind: "config-bundle.rollback", importId: argument, force: flags.has("force") } }
  const onConflict = one("on-conflict") ?? "keep"
  if (onConflict !== "keep" && onConflict !== "replace") return bad("--on-conflict needs keep|replace")
  const resolve: Record<string, ConflictChoice> = {}
  for (const entry of values.get("resolve") ?? []) {
    const at = entry.lastIndexOf("=")
    const item = entry.slice(0, at), choice = entry.slice(at + 1)
    if (at <= 0 || (choice !== "keep" && choice !== "replace")) return bad(`--resolve needs ITEM=keep|replace (got ${entry})`)
    resolve[item] = choice
  }
  const plan = one("plan")
  if (flags.has("apply") && !plan) return bad("import --apply needs --plan ID from the preview")
  if (plan && !flags.has("apply")) return bad("--plan only applies with --apply")
  if (plan && !/^[0-9a-f]{12,64}$/.test(plan)) return bad("--plan needs the plan id the preview printed")
  return { ok: true, command: { ...common, kind: "config-bundle.import", file: argument, apply: flags.has("apply"), ...(plan ? { plan } : {}), onConflict, resolve, rewriteHome: flags.has("rewrite-home") } }
}
