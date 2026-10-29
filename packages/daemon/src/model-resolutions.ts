import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { ModelInfo } from "@mendcode/protocol"

const MAX_BYTES = 64_000
const MAX_ENTRIES = 64
const MAX_ID = 128
/** A model id as an engine reports it: `claude-opus-5-5`, `claude-opus-4-1-20250805`, `claude-opus-5-5[1m]`. */
const RESOLVED_ID = /^[A-Za-z0-9][A-Za-z0-9._:\-/]*(?:\[[A-Za-z0-9]+\])?$/

export type ModelResolutions = ReturnType<typeof createModelResolutions>

/**
 * What an engine's model alias last resolved to on this machine (`claude` + `claude-opus` -> `claude-opus-5-5`), kept in the
 * data dir so the next launch names the model right away. Claude Code's aliases always mean the newest of a family and only
 * the first answer says which version that is; this remembers it. The value is a display hint, never a routing input: nothing
 * sends a request with it, and an alias that never resolved here has no entry. The same answer states the model's context
 * window, which is remembered the same way: the catalog's own figure for an engine model is a guess until then.
 */
export function createModelResolutions(dir: string) {
  const file = path.join(dir, "model-resolutions.json")
  let table: Record<string, string> | undefined
  const load = (): Record<string, string> => {
    if (table) return table
    table = {}
    try {
      if (statSync(file).size > MAX_BYTES) return table
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return table
      for (const [key, value] of Object.entries(parsed).slice(0, MAX_ENTRIES)) if (typeof value === "string" && value.length <= MAX_ID && RESOLVED_ID.test(value)) table[key] = value
    } catch {}
    return table
  }
  const keyOf = (engine: string, alias: string) => `${engine}:${alias}`
  /** The context window an engine stated for a model id it reported, kept beside the aliases as digits. */
  const windowKey = (engine: string, model: string) => `${engine}:${model}#window`
  const write = (next: Record<string, string>): boolean => {
    try {
      mkdirSync(dir, { recursive: true })
      const temporary = `${file}.${process.pid}.tmp`
      writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 })
      renameSync(temporary, file)
    } catch {
      return false
    }
    table = next
    return true
  }
  return {
    get: (engine: string, alias: string): string | undefined => load()[keyOf(engine, alias)],
    /** Records the window an engine stated for a model it reported; true when that changed the table (and was written). */
    noteWindow(engine: string, model: string, tokens: number): boolean {
      if (!Number.isInteger(tokens) || tokens <= 0 || model.length > MAX_ID || !RESOLVED_ID.test(model)) return false
      const current = load()
      const key = windowKey(engine, model)
      if (current[key] === String(tokens)) return false
      if (!(key in current) && Object.keys(current).length >= MAX_ENTRIES) return false
      return write({ ...current, [key]: String(tokens) })
    },
    /** Records what `alias` resolved to; true when that changed the table (and was written). */
    note(engine: string, alias: string, resolved: string): boolean {
      if (resolved === alias || resolved.length > MAX_ID || !RESOLVED_ID.test(resolved) || !resolved.startsWith(`${alias}-`)) return false
      const current = load()
      const key = keyOf(engine, alias)
      if (current[key] === resolved) return false
      if (!(key in current) && Object.keys(current).length >= MAX_ENTRIES) return false
      return write({ ...current, [key]: resolved })
    },
    /**
     * The catalog with `resolved` set on each engine alias that has been resolved here, and `contextWindow` replaced by the
     * window the engine itself stated for that model (the alias's resolved id, or a pinned id) once it has.
     */
    apply(models: ModelInfo[]): ModelInfo[] {
      const known = load()
      return models.map((model) => {
        if (!model.engine) return model
        const resolved = known[keyOf(model.engine, model.id)]
        const stated = Number(known[windowKey(model.engine, resolved ?? model.id)])
        const contextWindow = Number.isInteger(stated) && stated > 0 ? stated : undefined
        return resolved || contextWindow ? { ...model, ...(resolved ? { resolved } : {}), ...(contextWindow ? { contextWindow } : {}) } : model
      })
    },
    /** The alias of `catalog` an engine's reported model id belongs to (the longest alias that prefixes it), or undefined. */
    aliasOf(engine: string, reported: string, catalog: readonly ModelInfo[]): string | undefined {
      let best: string | undefined
      for (const model of catalog) if (model.engine === engine && reported.startsWith(`${model.id}-`) && (!best || model.id.length > best.length)) best = model.id
      return best
    },
  }
}
