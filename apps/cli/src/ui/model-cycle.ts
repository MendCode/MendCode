import type { ModelChoice, ModelsReport, ReasoningEffort } from "@mendcode/protocol"

/**
 * F2 / F3: the next model, and the next effort of the current model, for the session (v1's `f2` model cycle and
 * `f3` variant cycle). Undefined when the engine picks its own model or there is nothing to cycle to.
 */
export function nextModelChoice(report: ModelsReport, ids?: readonly string[], direction = 1): ModelChoice | undefined {
  if (!report.selectable || report.models.length === 0) return undefined
  const models = ids ? ids.flatMap((id) => report.models.filter((model) => model.id === id)) : report.models
  if (models.length === 0) return undefined
  const current = report.effective ?? report.roles.main ?? report.defaults
  const at = models.findIndex((model) => model.id === current.model)
  const next = models[at < 0 ? direction > 0 ? 0 : models.length - 1 : (at + direction + models.length) % models.length]!
  if (next.id === current.model && models.length === 1) return undefined
  const effort = current.effort && next.efforts.includes(current.effort) ? current.effort : next.defaultEffort
  return { model: next.id, ...(effort ? { effort } : {}) }
}

export function nextEffortChoice(report: ModelsReport, direction = 1): ModelChoice | undefined {
  if (!report.selectable) return undefined
  const current = report.effective ?? report.roles.main ?? report.defaults
  const info = report.models.find((model) => model.id === current.model)
  if (!info || info.efforts.length === 0) return undefined
  const options: Array<ReasoningEffort | undefined> = [...info.efforts]
  const at = options.indexOf(current.effort ?? info.defaultEffort)
  const effort = options[(at + direction + options.length) % options.length]
  return effort ? { model: current.model, effort } : undefined
}

/** Named variants include the model default; effort-only models keep their existing F3 cycle. */
export function nextVariantChoice(report: ModelsReport, direction = 1): ModelChoice | undefined {
  const current = report.session ?? report.effective ?? report.roles.main ?? report.defaults
  const info = report.models.find((model) => model.id === current.model)
  if (!report.selectable || !info?.variants || !Object.keys(info.variants).length) return nextEffortChoice(report, direction)
  const options: Array<string | undefined> = [undefined, ...Object.keys(info.variants)]
  const next = options[(Math.max(0, options.indexOf(current.variant)) + direction + options.length) % options.length]
  return { model: current.model, ...(next ? { variant: next } : {}) }
}
