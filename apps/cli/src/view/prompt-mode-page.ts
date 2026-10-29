import { PROMPT_FOCUS_CHOICES, promptCostLine, promptCostOf, promptCostWarning, promptFocusLabel, type PromptMode, type PromptStatus } from "@mendcode/protocol/wire"
import type { Line } from "../ui/theme"
import { panelGrid } from "./deck"
import { pickerFrame } from "./picker-frame"
import { focusedWindow } from "./appearance-layout"
import { wrap } from "./wrap"

export type PromptModeState = { tab: "mode" | "focus"; selected: number }
export const createPromptModeState = (): PromptModeState => ({ tab: "mode", selected: 0 })
const DETAILS: Record<PromptMode, string> = {
  minimal: "Boundary + your AGENTS.md + memory. Skills through the skill tool.",
  focus: "Native harness + your AGENTS.md + skill catalog + a one-line family note + memory. The lean default.",
  guide: "Focus + the provider guide: working basics and how this model family uses MendCode's tools.",
  full: "Guide + the operator guide to MendCode itself, family context files and prompt overrides.",
  custom: "Project prompt + boundary + your AGENTS.md + memory. No inherited focus.",
}
const FAMILY: Record<string, string> = { auto: "Follows the session's model on every call", neutral: "No vendor guidance for this model", codex: "Patches · executable verification", claude: "Read before write · planning", gemini: "Large context · checkpoints", kimi: "Shell workflow · command evidence", deepseek: "Runtime context · verified outputs", mistral: "Agent configuration · tool policy", glm: "Long-horizon iteration · tool results", minimax: "Agentic coding · verified outputs", grok: "Fast tool loops · explicit verification", local: "Small models · one strict tool call at a time" }
export function renderPromptModePage(input: { state: PromptModeState; report?: PromptStatus; error: string; width: number; height: number }): Line[] {
  const { state, report, width, height, error } = input
  const room = Math.max(0, height - 2)
  const compact = width < 70
  const sourceHeight = Math.min(7, Math.max(5, Math.floor(room / 4)))
  const mainHeight = Math.max(0, room - sourceHeight - 1)
  const modes = report?.available ?? []
  const choice = state.tab === "mode" ? modes[state.selected] : undefined
  const family = state.tab === "focus" ? PROMPT_FOCUS_CHOICES[state.selected] : report?.focusID
  // `auto` shows the family it resolves to for the session's model: `auto → claude`.
  const familyLabel = (id: string | undefined) => id === "auto" && report ? `auto → ${report.resolvedFocus}` : id
  const lines = (text: string, w: number, fg: "text" | "muted" | "error" = "text"): Line[] => wrap(text, w).map((text) => [{ text, fg }])
  /** The tokens a mode adds to every model call for this family, and for the bigger modes a warning that it is sent each time. */
  const costRows = (mode: PromptMode, w: number): Line[] => {
    const cost = report ? promptCostLine(promptCostOf(report, mode)) : ""
    const warning = promptCostWarning(mode)
    return [...(cost ? lines(cost, w, "muted") : []), ...(warning ? lines(warning, w, "error") : [])]
  }
  const list = (w: number): Line[] => {
    if (!report) return lines(error || "Loading prompt context…", w, error ? "error" : "muted")
    const rows: Line[] = []
    let focus = 0
    if (!compact || state.tab === "mode") {
      rows.push([{ text: "1 Modes", fg: state.tab === "mode" ? "primary" : "muted", bold: state.tab === "mode" }])
      modes.forEach((mode, i) => {
        if (state.tab === "mode" && i === state.selected) focus = rows.length
        rows.push([{ text: `${state.tab === "mode" && i === state.selected ? "› " : "  "}${mode === "custom" ? report.customPrompt.name : mode[0]!.toUpperCase() + mode.slice(1)}${mode === report.mode ? " · active" : ""}`, fg: state.tab === "mode" && i === state.selected ? "primary" : "text" }])
        if (!compact) rows.push(...lines(DETAILS[mode], w - 2, "muted").slice(0, 2).map((row) => [{ text: "  " }, ...row]))
        const cost = promptCostLine(promptCostOf(report, mode))
        if (cost && !compact) rows.push([{ text: "  " }, { text: cost, fg: promptCostWarning(mode) ? "warning" : "muted" }])
      })
    }
    if (!compact || state.tab === "focus") {
      if (rows.length) rows.push([])
      rows.push([{ text: "2 Focus family", fg: state.tab === "focus" ? "primary" : "muted", bold: state.tab === "focus" }])
      PROMPT_FOCUS_CHOICES.forEach((id, i) => {
        if (state.tab === "focus" && i === state.selected) focus = rows.length
        rows.push([{ text: `${state.tab === "focus" && i === state.selected ? "› " : "  "}${familyLabel(id)}${id === report.focusID ? " · active" : ""}${compact ? " · " + FAMILY[id] : ""}`, fg: state.tab === "focus" && i === state.selected ? "primary" : "text" }])
      })
    }
    if (compact) rows.push([], ...lines(choice ? DETAILS[choice] : FAMILY[family ?? ""] ?? "", w, "muted"), ...(choice ? costRows(choice, w) : []))
    return focusedWindow(rows, focus, mainHeight - 4)
  }
  const detail = (w: number): Line[] => report ? [
    ...lines(`Mode: ${report.mode}`, w), ...lines(`Focus: ${familyLabel(family)}`, w), [],
    ...lines(choice ? DETAILS[choice] : FAMILY[family === "auto" ? "auto" : family ?? ""] ?? "", w), ...(choice ? costRows(choice, w) : []), [],
    ...lines(`Project: ${report.directory}`, w, "muted"), [],
    ...lines("Mode and family changes apply to the next native model call.", w, "muted"),
    ...(error ? [[], ...lines(error, w, "error")] : []),
  ] : []
  const source = (w: number): Line[] => report ? [
    ...(compact ? [] : lines(report.customPrompt.path, w, "muted")),
    ...lines(report.customPrompt.available ? `${report.customPrompt.name} · ${report.customPrompt.bytes} bytes` : report.customPrompt.fallbackReason ?? "Unavailable", w, report.customPrompt.available ? "text" : "muted"),
  ] : []
  const grid = panelGrid({ width, compact: false, padding: true, ...(compact ? { maxColumns: 1 } : {}), heights: [mainHeight, sourceHeight], rows: [
    [{ title: "Prompt context", body: list, weight: 3, active: true }, ...(compact ? [] : [{ title: "Selection", body: detail, weight: 2 }])],
    [{ title: compact ? report?.customPrompt.path ?? "Project prompt" : "Project prompt", body: source }],
  ] })
  return pickerFrame("Prompt Context", compact ? "↑↓ · tab · enter apply · esc back" : "↑↓ select · tab family · enter apply · c cycle · r refresh · esc back", width, height, grid, error || (report ? `${report.mode} · ${promptFocusLabel(report)}` : ""))
}
