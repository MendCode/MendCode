import type { ExtensionFlag } from "@mendcode/extension-api"
import type { ExtensionRecord } from "./types"

/** `--name` on the command line: lowercase letters, digits and hyphens, starting with a letter. */
export const FLAG_NAME = /^[a-z][a-z0-9-]{0,39}$/
export type FlagValues = Readonly<Record<string, string | boolean>>

/** Why `registerFlag` refuses this declaration, or undefined. */
export function flagProblem(name: unknown, flag: unknown): string | undefined {
  if (typeof name !== "string" || !FLAG_NAME.test(name)) return "registerFlag: a name of lowercase letters, digits and - (max 40), used as --name"
  const value = flag as Partial<ExtensionFlag> | null
  if (!value || typeof value !== "object" || (value.type !== "boolean" && value.type !== "string")) return `registerFlag: --${name} needs { type: "boolean" | "string", description }`
  if (typeof value.description !== "string" || !value.description.trim() || value.description.length > 200) return `registerFlag: --${name} needs a description (at most 200 characters)`
  if (value.default !== undefined && typeof value.default !== value.type) return `registerFlag: --${name}'s default is a ${value.type}`
  return undefined
}

/** Every flag the loaded extensions of a directory declare, the first declaration of a name winning. */
export function declaredFlags(records: readonly ExtensionRecord[]): Map<string, { record: ExtensionRecord; flag: ExtensionFlag }> {
  const flags = new Map<string, { record: ExtensionRecord; flag: ExtensionFlag }>()
  for (const record of records) {
    if (record.disabled) continue
    for (const [name, flag] of record.flags ?? []) if (!flags.has(name)) flags.set(name, { record, flag })
  }
  return flags
}

/**
 * The values a CLI invocation passed, checked against what the directory's extensions declare: an unknown name or a value of the
 * wrong type is refused as a whole, with the same words the CLI uses for its own flags.
 */
export function checkFlagValues(records: readonly ExtensionRecord[], values: Record<string, string | boolean>): { ok: true; values: FlagValues } | { ok: false; error: string } {
  const declared = declaredFlags(records)
  const checked: Record<string, string | boolean> = {}
  for (const [name, value] of Object.entries(values)) {
    const entry = declared.get(name)
    if (!entry) return { ok: false, error: `unknown flag --${name}${declared.size ? `; extension flags: ${[...declared.keys()].map((flag) => `--${flag}`).join(", ")}` : ""}` }
    if (entry.flag.type === "boolean" && typeof value !== "boolean") return { ok: false, error: `--${name} does not take a value` }
    if (entry.flag.type === "string" && (typeof value !== "string" || !value)) return { ok: false, error: `--${name} needs a value: --${name}=value` }
    checked[name] = value
  }
  return { ok: true, values: checked }
}
