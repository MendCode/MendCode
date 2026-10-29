import type { ModelChoice, ModelInfo, ModelsReport } from "@mendcode/protocol"
import type { Line } from "../ui/theme"
import { panelGrid, clip } from "./deck"
import { pickerFrame } from "./picker-frame"
import { groupModels, type ModelPageRow } from "./model-page"
import type { ModelPrefs } from "./model-prefs"
import { fuzzyScore } from "./fuzzy"
import { modelLabel, modelParts } from "./model-label"
import { wrap } from "./wrap"

export type ModelPickerState = { query: string; selected: number; provider?: string; providers: boolean; row: ModelPageRow; returnPage?: "chat" | "model" }
export const createModelPickerState = (row: ModelPageRow = "session"): ModelPickerState => ({ query: "", selected: 0, providers: false, row })
export type ModelOption = { model: ModelInfo; category: string }
/** The list the pickers show, favorites then recents then the catalog by provider (a typed query replaces that with a ranked match). The quick picker (`model-quick.ts`) reads it too, so there is one search. */
export function modelOptions(report: ModelsReport | undefined, prefs: ModelPrefs, state: Pick<ModelPickerState, "query" | "provider">): ModelOption[] {
  const groups = groupModels(report?.models ?? [])
  const models = groups.filter((group) => !state.provider || group.key === state.provider).flatMap((group) => group.models.map((model) => ({ model, category: group.title })))
  if (state.query) return models.flatMap((entry) => {
    const score = fuzzyScore(state.query, `${modelParts(entry.model.id, report).label} ${entry.model.name} ${entry.model.id} ${entry.category}`)
    return score === undefined ? [] : [{ entry, score }]
  }).sort((a, b) => b.score - a.score).map((match) => match.entry)
  const byId = (ids: string[], category: string) => ids.flatMap((id) => models.find((entry) => entry.model.id === id) ? [{ model: models.find((entry) => entry.model.id === id)!.model, category }] : [])
  const first = [...byId(prefs.favorites, "Favorites"), ...byId(prefs.recents.filter((id) => !prefs.favorites.includes(id)), "Recent")]
  const listed = new Set(first.map((entry) => entry.model.id))
  return [...first, ...models.filter((entry) => !listed.has(entry.model.id))]
}
export function renderModelPicker(input: { state: ModelPickerState; report: ModelsReport | undefined; prefs: ModelPrefs; width: number; height: number; error: string }): Line[] {
  const { state, report, width, height } = input
  const groups = groupModels(report?.models ?? [])
  const entries = modelOptions(report, input.prefs, state)
  const selected = entries[state.selected]
  const room = Math.max(0, height - 2)
  const providers = state.providers
  const list = providers ? groups.map((group, i): Line => [{ text: `${i === state.selected ? "› " : "  "}${group.title} · ${group.models.length}`, fg: i === state.selected ? "primary" : "text" }]) : entries.map((entry, i): Line => {
    const { label } = modelParts(entry.model.id, report)
    const on = i === state.selected
    // The exact id stays visible next to the label: a namespace (`xai:`, `local/`) is what tells two routes to one model apart.
    return [{ text: `${on ? "› " : "  "}${input.prefs.favorites.includes(entry.model.id) ? "* " : ""}${label}`, fg: on ? "primary" : "text", bold: on }, ...(entry.model.id !== label ? [{ text: `  ${entry.model.id}`, fg: "muted" as const }] : []), { text: ` · ${entry.category}`, fg: "muted" as const }]
  })
  if (!list.length) list.push([{ text: input.error || (report ? "No matching models" : "Loading models…"), fg: input.error ? "error" : "muted" }])
  if (providers) list.push([{ text: `${state.selected === groups.length ? "› " : "  "}Connect provider`, fg: state.selected === groups.length ? "primary" : "text" }])
  const details = (w: number): Line[] => selected ? [[{ text: modelParts(selected.model.id, report).label, fg: "primary", bold: true }], ...wrap(selected.model.id, w).map((text): Line => [{ text, fg: "muted" }]), [],[{ text: `Effort ${selected.model.efforts.join(" · ") || "none"}`, fg: "text" }], ...(selected.model.contextWindow ? [[{ text: `Context ${selected.model.contextWindow.toLocaleString()} tokens`, fg: "text" }]] as Line[] : []), ...Object.keys(selected.model.variants ?? {}).map((name): Line => [{ text: `Variant ${name}`, fg: "text" }])] : []
  return pickerFrame(providers ? "Model / Providers" : "Select model", width < 70 ? "↑↓ · enter select · esc back" : "↑↓ · enter select · ctrl+a providers · ctrl+f favorite · esc back", width, height, panelGrid({ width, compact: false, padding: true, ...(width < 70 ? { maxColumns: 1 } : {}), heights: [room], rows: [[{ title: providers ? "Providers" : "Models", body: (w) => list.map((row) => clip(row, w)), weight: 3, scroll: Math.max(0, state.selected - room + 6), active: true }, ...(width >= 110 && !providers ? [{ title: "Model", body: details, weight: 2 }] : [])]] }), input.error || (providers ? `${groups.length} providers` : `Search / ${state.query}`))
}
export type VariantState = { selected: number }
export function variantOptions(report: ModelsReport | undefined): Array<{ name: string; choice: ModelChoice }> {
  if (!report?.selectable) return []
  const current = report.effective ?? report.roles.main ?? report.defaults
  const model = report.models.find((entry) => entry.id === current.model)
  const choices: Array<{ name: string; choice: ModelChoice }> = [{ name: "Default", choice: { model: current.model } }]
  if (model?.variants) for (const name of Object.keys(model.variants)) choices.push({ name, choice: { model: current.model, variant: name } })
  else for (const effort of model?.efforts ?? []) choices.push({ name: effort, choice: { model: current.model, effort } })
  return choices
}
export function renderVariantPicker(input: { report: ModelsReport | undefined; state: VariantState; error: string; width: number; height: number; prefs?: ModelPrefs }): Line[] {
  const { report, state, width, height } = input
  const options = variantOptions(report)
  const current = report?.session ?? report?.roles.main ?? report?.defaults
  const info = report?.models.find((model) => model.id === current?.model)
  const optionsModel = (report?.effective ?? report?.roles.main ?? report?.defaults)?.model
  const saved = optionsModel ? input.prefs?.defaults?.[optionsModel] : undefined
  const isSaved = (choice: ModelChoice) => saved !== undefined && choice.effort === saved.effort && choice.variant === saved.variant
  const body = (w: number): Line[] => [...(options.length ? options.map((option, i): Line => clip([{ text: `${i === state.selected ? "› " : "  "}${option.name}${option.choice.variant === current?.variant && option.choice.effort === current?.effort ? " · selected" : ""}${isSaved(option.choice) ? " · model default" : ""}`, fg: i === state.selected ? "primary" : "text" }], w)) :[[{ text: input.error || (!report ? "Loading variants…" : `${report.engine} engine chooses its own model`), fg: input.error ? "error" : "muted" }]] as Line[])]
  const variant = options[state.selected]?.choice.variant
  const params = variant ? info?.variants?.[variant] : undefined
  return pickerFrame("Select variant", width < 70 ? "enter · d default · s startup · esc" : "↑↓ · enter select · d default for this model · s save as startup default · esc back", width, height, panelGrid({ width, compact: false, padding: true, ...(width < 70 ? { maxColumns: 1 } : {}), heights: [Math.max(0, height - 2)], rows: [[{ title: "Variants", body, active: true, scroll: Math.max(0, state.selected - height + 8) }, ...(width >= 110 ? [{ title: "Parameters", body: (w: number): Line[] => params ? [...wrap(JSON.stringify(params, null, 2), w).map((text): Line => [{ text, fg: "text" }])] : [] }] : [])]] }), input.error || (current?.model ? modelLabel(current.model, report) : ""))
}
