import type { DreamControlInput, MemoryControlInput, MemoryConfigPatch } from "@mendcode/protocol"

export type MemoryAutomation = { kind: "memory.control"; input: MemoryControlInput } | { kind: "dream.control"; input: DreamControlInput }

export const MEMORY_USAGE = `memory [status]
  memory preview [query] [--mode request|after-compaction|manual] [--provider P] [--model M]
  memory edit <id> "text" [--scope global|project]
  memory delete|apply|reject <id> [--scope global|project]
  memory propose "text" [--scope global|project] [--tags a,b] [--category C]
  memory propose --from-file PATH [--max-proposals N]
  memory import-codex [--from PATH] [--apply] [--max-proposals N]
  memory import-v1 --from PATH [--apply] [--max-proposals N]
  memory index
  memory config [--project] [--enable|--disable] [--use|--no-use] [--generate|--no-generate]
    [--max-prompt-tokens N] [--max-entries N] [--project-max-entries N] [--global-compaction-max-entries N]
    [--dream-consolidation-policy disabled|preview|auto-consolidate]
  memory dream [status|tick|run|consolidate] [--preview|--auto] [--deterministic]`

/** CLI syntax only; protocol validation stays in the daemon's module graph. */
export function parseMemoryAutomation(words: string[], flags: Map<string, string | true>): MemoryAutomation | { error: string } | undefined {
  const [operation = "status", ...args] = words
  if (["add", "list", "search"].includes(operation)) return undefined
  const value = (key: string) => typeof flags.get(key) === "string" ? String(flags.get(key)) : undefined
  if (operation === "dream") {
    const action = args[0] ?? "status"
    if (!["status", "tick", "run", "consolidate"].includes(action) || args.length > 1) return { error: "memory dream needs status|tick|run|consolidate" }
    if (flags.has("preview") && flags.has("auto")) return { error: "--preview and --auto are exclusive" }
    if (flags.has("deterministic") && !["run", "consolidate"].includes(action)) return { error: "--deterministic only applies to run|consolidate" }
    return { kind: "dream.control", input: { operation: action as DreamControlInput["operation"], ...(flags.has("preview") ? { policy: "preview" } : flags.has("auto") ? { policy: "auto-consolidate" } : {}), ...(flags.has("deterministic") ? { deterministic: true } : {}) } }
  }
  if (!["status", "preview", "edit", "delete", "propose", "apply", "reject", "import-codex", "import-v1", "index", "config"].includes(operation)) return { error: `unknown memory command "${operation}"` }
  const rawScope = value("scope")
  if (rawScope && !["global", "user", "project"].includes(rawScope)) return { error: "--scope needs global|project|user" }
  const scope = rawScope === "global" || rawScope === "user" || flags.has("user") ? "user" : "project"
  const input: MemoryControlInput = { operation: operation as MemoryControlInput["operation"] }
  const maxProposals = value("max-proposals")
  if (maxProposals !== undefined) {
    const n = Number(maxProposals)
    if (!Number.isInteger(n) || n < 1 || n > 50) return { error: "--max-proposals needs a whole number from 1 to 50" }
    input.maxProposals = n
  }
  if (["edit", "delete", "apply", "reject"].includes(operation)) {
    if (!args[0]) return { error: `memory ${operation} needs <id>` }
    if (operation !== "edit" && args.length > 1) return { error: `memory ${operation} takes one id` }
    input.memoryId = args[0] as MemoryControlInput["memoryId"]
    if (rawScope || flags.has("user") || operation === "edit" || operation === "delete") input.scope = scope
    if (operation === "edit") {
      if (!args.slice(1).join(" ").trim()) return { error: 'memory edit needs <id> "text"' }
      input.text = args.slice(1).join(" ").trim()
    }
  } else if (operation === "propose") {
    const text = args.join(" ").trim()
    if (text && value("from-file")) return { error: "text and --from-file are exclusive" }
    if (!text && !value("from-file")) return { error: 'memory propose needs "text" or --from-file PATH' }
    Object.assign(input, { scope, ...(text ? { text } : { fromFile: value("from-file") }), ...(value("category") ? { category: value("category") } : {}), ...(value("tags") ? { tags: value("tags")!.split(",").map((tag) => tag.trim()).filter(Boolean) } : {}) })
  } else if (operation === "preview") {
    const mode = value("mode") ?? "request"
    if (!["request", "after-compaction", "manual"].includes(mode)) return { error: "--mode needs request|after-compaction|manual" }
    Object.assign(input, { query: args.join(" ").trim(), mode, ...(value("provider") ? { provider: value("provider") } : {}), ...(value("model") ? { model: value("model") } : {}) })
  } else if (operation === "import-codex") Object.assign(input, { ...(value("from") ? { from: value("from") } : {}), apply: flags.has("apply") })
  else if (operation === "import-v1") {
    if (!value("from")) return { error: "memory import-v1 needs --from PATH (a v1 memory sharing folder)" }
    Object.assign(input, { from: value("from"), apply: flags.has("apply") })
  }
  else if (operation === "config") {
    const patch: MemoryConfigPatch = {}
    for (const [on, off, key] of [["enable", "disable", "memoryEnabled"], ["use", "no-use", "memoryUse"], ["input", "no-input", "memoryUse"], ["generate", "no-generate", "memoryGenerate"], ["output", "no-output", "memoryGenerate"]] as const) {
      if (flags.has(on) && flags.has(off)) return { error: `--${on} and --${off} are exclusive` }
      if (flags.has(on)) patch[key] = true
      if (flags.has(off)) patch[key] = false
    }
    if (flags.has("disable")) Object.assign(patch, { memoryEnabled: false, memoryUse: false, memoryGenerate: false })
    for (const [flag, key, max] of [["max-prompt-tokens", "memoryMaxPromptTokens", 32_000], ["max-entries", "memoryMaxEntries", 10_000], ["project-max-entries", "memoryProjectMaxEntries", 10_000], ["global-compaction-max-entries", "memoryGlobalCompactionMaxEntries", 10_000]] as const) {
      const raw = value(flag)
      if (raw === undefined) continue
      const n = Number(raw)
      if (!Number.isInteger(n) || n < 1 || n > max) return { error: `--${flag} needs a whole number from 1 to ${max}` }
      patch[key] = n
    }
    const policy = value("dream-consolidation-policy")
    if (policy && !["disabled", "preview", "auto-consolidate"].includes(policy)) return { error: "--dream-consolidation-policy needs disabled|preview|auto-consolidate" }
    if (policy) patch.dreamConsolidationPolicy = policy as MemoryConfigPatch["dreamConsolidationPolicy"]
    Object.assign(input, { project: flags.has("project"), patch })
  }
  if (!["edit", "delete", "apply", "reject", "preview", "propose"].includes(operation) && args.length) return { error: `memory ${operation} takes no positional arguments` }
  return { kind: "memory.control", input }
}
