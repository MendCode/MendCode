import { PROJECT_OPERATIONS, PROMPT_FOCUS_CHOICES, type ProjectControlInput, type ProjectPackagePatch, type PromptFocusChoice } from "@mendcode/protocol/wire"
import { PROGRAM_NAME } from "@mendcode/program"

export const PROJECT_USAGE = `usage: ${PROGRAM_NAME} control-plane project <init|config-show|context-status|context-refresh|context-show|focus-status|focus-list|focus-show [ID]|focus-use ID|package-show|package-set> [--dir DATA] [--json]`
export type ProjectAutomation = { kind: "project"; input: ProjectControlInput }
const packageFlags = { id: "id", title: "title", description: "description", version: "version", kind: "kind", channel: "channel", "source-type": "sourceType", "source-url": "sourceURL", "compat-mendcode": "compatMendcode", "compat-runtime-pack": "compatRuntimePack" } as const

export function parseProjectAutomation(args: string[], flags: Map<string, string | true>): ProjectAutomation | { error: string } {
  const [operation = "config-show", argument, ...extra] = args
  if (!PROJECT_OPERATIONS.includes(operation as never)) return { error: PROJECT_USAGE }
  const allowed = new Set(["dir", "data-dir", "json", "format", "compat", "help", ...(operation === "package-set" ? Object.keys(packageFlags) : [])])
  for (const key of flags.keys()) if (!allowed.has(key)) return { error: `--${key} is not valid for project ${operation}` }
  if (extra.length || argument !== undefined && operation !== "focus-show" && operation !== "focus-use") return { error: `Unexpected argument for project ${operation}` }
  if (operation === "focus-show" || operation === "focus-use") {
    if (argument !== undefined && !PROMPT_FOCUS_CHOICES.includes(argument as PromptFocusChoice)) return { error: "Unknown focus profile" }
    if (operation === "focus-use" && argument === undefined) return { error: "project focus-use needs a focus ID" }
    return { kind: "project", input: operation === "focus-use" ? { operation, focusID: argument as PromptFocusChoice } : { operation, ...(argument ? { focusID: argument as PromptFocusChoice } : {}) } }
  }
  if (operation === "package-set") {
    const patch: ProjectPackagePatch = {}
    for (const [flag, key] of Object.entries(packageFlags)) if (flags.has(flag)) {
      const value = flags.get(flag)
      if (typeof value !== "string" || value.length > (key === "description" ? 2000 : key === "sourceURL" ? 4096 : 500)) return { error: `Invalid --${flag}` }
      patch[key as keyof ProjectPackagePatch] = value
    }
    if (!Object.keys(patch).length) return { error: "project package-set needs metadata flags" }
    return { kind: "project", input: { operation, patch } }
  }
  return { kind: "project", input: { operation: operation as Extract<ProjectControlInput, { operation: "init" | "config-show" | "context-status" | "context-refresh" | "context-show" | "focus-status" | "focus-list" | "package-show" }>["operation"] } }
}

export function projectOutput(input: ProjectControlInput, data: Record<string, unknown>) {
  if (input.operation === "init") return `initialized ${data.initialized}\n`
  if (input.operation === "context-refresh") return `refreshed ${data.summary} (${data.present}/${data.total} inputs)\n`
  if (input.operation === "context-show") return String(data.text)
  if (input.operation === "focus-use") return `active focus: ${data.active}\n`
  if (input.operation === "focus-list") return (data.profiles as Array<{ id: string; publicName: string }>).map((entry) => `${entry.id}\t${entry.publicName}`).join("\n") + "\n"
  return JSON.stringify(data, null, 2) + "\n"
}
