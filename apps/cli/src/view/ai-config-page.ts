import type { AIConfigApplied, AIConfigInspection, AIConfigPlan, AIConfigValidation } from "@mendcode/protocol"
import type { Line } from "../ui/theme"
import { appearancePage } from "./appearance-layout"
import { panelGrid, type GridPanel } from "./deck"
import { wrapSpans } from "./markdown"

export type AIConfigPageState = {
  inspection?: AIConfigInspection | undefined
  plan?: AIConfigPlan | undefined
  validation?: AIConfigValidation | undefined
  applied?: AIConfigApplied | undefined
  error?: string | undefined
  selected: number
  tab: number
  scroll: number
  confirming: boolean
  busy: boolean
}

export function renderAIConfigPage(input: { state: AIConfigPageState; readOnly: boolean; width: number; height: number }): Line[] {
  const { state, width, height } = input
  const compact = width < 70
  const inner = Math.max(4, width - 4)
  const room = Math.max(4, height - 2)
  const line = (text: string, fg: "text" | "muted" | "primary" | "error" | "success" = "text"): Line => [{ text, fg }]
  const rows = (text: string[], w: number, fg: "text" | "muted" | "primary" | "error" | "success" = "text") => text.flatMap((text) => wrapSpans(line(text, fg), w))
  const inventory: GridPanel = { title: `Models · ${state.inspection?.models.length ?? 0}`, body: (w) => state.inspection ? state.inspection.models.flatMap((model, index) => [
    ...rows([`${index === state.selected ? "›" : " "} ${model.id}${model.configured ? "" : " · unavailable"}`], w, index === state.selected ? "primary" : "text"),
    ...rows([`  ${model.provider} · ${model.pricing ? `$${model.pricing.input}/$${model.pricing.output} per 1M` : "cost unknown"}${model.contextWindow ? ` · ${model.contextWindow.toLocaleString("en-US")} context` : ""}`], w, "muted"),
  ]) : rows([state.busy ? "Loading inventory…" : "Inventory unavailable"], w, "muted"), scroll: state.scroll }
  const roles: GridPanel = { title: "Configuration", body: (w) => [
    ...rows(Object.entries(state.inspection?.roles ?? {}).map(([role, choice]) => `${role}: ${choice?.model}${choice?.effort ? ` · ${choice.effort}` : ""}`), w),
    ...(!Object.keys(state.inspection?.roles ?? {}).length ? rows(["No role overrides"], w, "muted") : []),
    ...rows([`Recipes: ${state.inspection?.configSources.length ?? 0}`, `Advisor: ${state.inspection?.advisor ?? "off"}`, `Autocompact: ${state.inspection?.effective.compactAtTokens ?? "engine default"}`], w, "muted"),
  ], scroll: state.scroll }
  const proposal: GridPanel = { title: state.plan ? `Preview · ${state.plan.target.scope}` : "Preview", weight: 2, body: (w) => state.plan ? [
    ...rows(state.plan.alternatives.map((item) => `${item.id === state.plan!.selectedAlternative ? "›" : " "} ${item.id} · ${item.primary.model} · ${item.feasibility === "blocked" ? `blocked: ${item.reason}` : item.estimatedMaxCostUsd === null ? "cost unknown" : `$${item.estimatedMaxCostUsd.toFixed(4)} / 32K estimate`}`), w),
    [], ...rows([state.plan.target.path], w, "muted"), [],
    ...state.plan.diff.flatMap((text) => rows([text], w, text.startsWith("+") ? "success" : "error")),
  ] : rows(["No proposal"], w, "muted"), scroll: state.scroll }
  const validation: GridPanel = { title: "Validation", active: state.confirming, body: (w) => [
    ...(state.error ? rows([state.error], w, "error") : []),
    ...(state.busy ? rows(["Checking…"], w, "muted") : []),
    ...(state.confirming ? rows(["Save this exact recipe?", "Enter saves · esc cancels"], w, "primary") : []),
    ...(state.applied ? rows([state.applied.changed ? "Recipe saved" : "Recipe unchanged", ...(state.applied.backupPath ? [`Backup: ${state.applied.backupPath}`] : []), "Session model unchanged"], w, "success") : []),
    ...(state.validation ? rows([state.validation.valid ? "Valid" : "Invalid", ...state.validation.issues.map((issue) => `${issue.path}: ${issue.message}`)], w, state.validation.valid ? "success" : "error") : !state.applied ? rows(["Not validated"], w, "muted") : []),
    ...rows(state.plan?.warnings ?? state.inspection?.missingInformation ?? [], w, "muted"),
    ...(input.readOnly ? rows(["Read-only connection"], w, "muted") : []),
  ], scroll: state.scroll }
  const content = (panel: GridPanel, w: number) => typeof panel.body === "function" ? panel.body(w) : panel.body
  const panels = [{ ...inventory, title: "Inventory", body: (w: number) => [...content(inventory, w), [], ...content(roles, w)] }, proposal, validation]
  const top = Math.max(8, Math.floor((room - 1) * .4))
  const body = compact ? panelGrid({ rows: [[panels[state.tab] ?? inventory]], width: inner, heights: [room], padding: true, maxColumns: 1, compact: false }) : panelGrid({ rows: [[inventory, roles], [proposal, validation]], width: inner, heights: [top, room - top - 1], padding: true, compact: false })
  const hints = state.confirming ? "enter save · esc cancel" : compact ? "1–3 · p plan · a save · esc" : width < 110 ? "↑↓ model · [ ] alt · p plan · v check · a save · pgup/dn · esc" : "↑↓ model · [ ] alternative · p plan · v validate · a save · r refresh · pgup/dn · esc back"
  return appearancePage({ title: "AI config", hints, body, width, height })
}
