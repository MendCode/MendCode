import type { ExtensionVirtualModel } from "@mendcode/extension-api"
import type { ModelChoice, ModelInfo } from "@mendcode/protocol"
import type { ExtensionRecord } from "./types"

export const VIRTUAL_PREFIX = "virtual:"
const VIRTUAL_ID = /^[a-z][a-z0-9._-]{0,47}$/
const MAX_TARGETS = 20
/** A route slower than this is reported (it runs before every model call); its answer is still used. */
const SLOW_ROUTE_MS = 50

/** Why `registerVirtualModel` refuses this model, or undefined. */
export function virtualModelProblem(value: unknown): string | undefined {
  const model = value as Partial<ExtensionVirtualModel> | null
  if (!model || typeof model !== "object" || typeof model.id !== "string" || !VIRTUAL_ID.test(model.id)) return "registerVirtualModel: id is lowercase letters, digits, . _ - (max 48); it is listed as virtual:<id>"
  if (model.name !== undefined && (typeof model.name !== "string" || !model.name.trim() || model.name.length > 100)) return `registerVirtualModel: ${model.id}: name is a short string`
  if (!Array.isArray(model.models) || model.models.length === 0 || model.models.length > MAX_TARGETS || model.models.some((id) => typeof id !== "string" || !id || id.length > 100 || id.startsWith(VIRTUAL_PREFIX))) return `registerVirtualModel: ${model.id}: models lists 1 to ${MAX_TARGETS} real model ids from /model`
  if (model.route !== undefined && typeof model.route !== "function") return `registerVirtualModel: ${model.id}: route is a function`
  return undefined
}

type Registered = { record: ExtensionRecord; model: ExtensionVirtualModel }

/** The virtual models of loaded user extensions, a later one winning an id. */
export function registeredVirtualModels(records: Iterable<ExtensionRecord>): Map<string, Registered> {
  const found = new Map<string, Registered>()
  for (const record of records) {
    if (record.disabled || record.layer !== "user") continue
    for (const model of record.virtualModels ?? []) found.set(`${VIRTUAL_PREFIX}${model.id}`, { record, model })
  }
  return found
}

/** The real models a virtual one may use: in the catalog and run by the native engine (another engine runs whole sessions, not calls). */
const targetsOf = (model: ExtensionVirtualModel, catalog: readonly ModelInfo[]) => model.models.flatMap((id) => { const info = catalog.find((entry) => entry.id === id); return info && !info.engine ? [info] : [] })

/** Catalog entries for the virtual models: listed only while one of their models exists; the smallest window and the first model's efforts. */
export function virtualCatalog(registered: ReadonlyMap<string, Registered>, catalog: readonly ModelInfo[]): ModelInfo[] {
  return [...registered].flatMap(([id, { model }]) => {
    const targets = targetsOf(model, catalog)
    if (!targets.length) return []
    const windows = targets.map((target) => target.contextWindow).filter((value): value is number => value !== undefined)
    const first = targets[0]!
    return [{ id, name: model.name ?? model.id, provider: "virtual", efforts: [...first.efforts], ...(first.defaultEffort ? { defaultEffort: first.defaultEffort } : {}), ...(windows.length === targets.length ? { contextWindow: Math.min(...windows) } : {}) }]
  })
}

/**
 * The real model one call of a virtual model goes to: what `route` answers when it is one of `models` and exists, otherwise the first
 * model that exists. A route that throws is recorded and the first model is used. A choice that is not virtual is returned as is.
 */
export function routeVirtual(input: { choice: ModelChoice; registered: ReadonlyMap<string, Registered>; catalog: readonly ModelInfo[]; context: { sessionId: string; cwd: string; role: string }; fail(record: ExtensionRecord, message: string): void; now?(): number }): ModelChoice {
  const entry = input.registered.get(input.choice.model)
  if (!entry) return input.choice
  const targets = targetsOf(entry.model, input.catalog)
  if (!targets.length) return input.choice
  let picked = targets[0]!.id
  if (entry.model.route) {
    const now = input.now ?? Date.now
    const started = now()
    try {
      const answer = entry.model.route({ ...input.context })
      if (typeof answer === "string" && targets.some((target) => target.id === answer)) picked = answer
      else if (answer !== undefined) input.fail(entry.record, `virtual model ${entry.model.id}: route answered ${JSON.stringify(answer).slice(0, 80)}, which is not one of its models; used ${picked}`)
    } catch (error) {
      input.fail(entry.record, `virtual model ${entry.model.id}: route failed (${error instanceof Error ? error.message.slice(0, 200) : "error"}); used ${picked}`)
    }
    if (now() - started > SLOW_ROUTE_MS) input.fail(entry.record, `virtual model ${entry.model.id}: route took ${now() - started} ms; it runs before every model call`)
  }
  const { model: _virtual, ...rest } = input.choice
  return { ...rest, model: picked }
}
