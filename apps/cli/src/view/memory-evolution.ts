import type { EvolutionMode, EvolutionSuggestion } from "@mendcode/protocol"
import type { ColorName, Line } from "../ui/theme"
import { clip, columns, panelGrid } from "./deck"
import { relativeTime, truncateEnd } from "./session-list"
import { wrap } from "./wrap"

/**
 * The Evolution tab of /memory (docs/evolution.md): the mode (`evolution` setting), what Evolution has seen in this
 * project and its reviewed skill, workflow and instruction candidates. Memory proposals it makes go to the
 * Pending tab. Pure.
 */
export type EvolutionData = {
  mode: EvolutionMode
  suggestions: EvolutionSuggestion[]
  observed: { corrections: number; preferences: number; recurring: number }
  workflows?: boolean
  policyRevision?: string
  error?: string
}
export type EvolutionTabState = { selected: number; scroll?: number }
export type EvolutionAction =
  | { type: "none" }
  | { type: "close" }
  | { type: "mode"; mode: EvolutionMode }
  | { type: "suggestion"; suggestionId: number; decision: "accept" | "reject"; expectedHash?: string }
  | { type: "evolutionWorkflows"; enabled: boolean }
  | { type: "evolutionPromote"; suggestionId: number; expectedHash: string; policyRevision: string }
  | { type: "evolutionRollback"; suggestionId: number; expectedHash: string; expectedRevision: number }

export const EVOLUTION_HINTS = "a promote · r rollback · ↑↓ candidate · x reject · o workflows · ←→ mode · pgup/pgdn review · esc back"

export const EVOLUTION_MODE_ORDER = ["off", "observe", "suggest", "auto-safe"] as const satisfies readonly EvolutionMode[]
const MODE_NOTE: Record<EvolutionMode, string> = {
  off: "Evolution is off · nothing is recorded and no model is called",
  observe: "notes which corrections recur; keeps no text, calls no model",
  suggest: "proposes memories (to review) and skill or instruction suggestions",
  "auto-safe": "allowed memories auto-apply; artifacts wait for review",
}
const STATUS_TONE: Record<EvolutionSuggestion["status"], ColorName> = { pending: "warning", accepted: "success", rejected: "muted", blocked: "error", rolled_back: "muted" }
const NONE: EvolutionAction = { type: "none" }
const UP = new Set(["\x1b[A", "\x1bOA", "k"])
const DOWN = new Set(["\x1b[B", "\x1bOB", "j"])
const LEFT = new Set(["\x1b[D", "\x1bOD", "h"])
const RIGHT = new Set(["\x1b[C", "\x1bOC", "l", "m"])

export function createEvolutionState(): EvolutionTabState {
  return { selected: 0 }
}

export function evolutionKey(state: EvolutionTabState, key: string, input: { mode: EvolutionMode; suggestions: readonly EvolutionSuggestion[] | undefined; workflows?: boolean | undefined; policyRevision?: string | undefined; size?: { width: number; height: number } | undefined; error?: string | undefined }): { state: EvolutionTabState; action: EvolutionAction } {
  if (key === "\x1b") return { state, action: { type: "close" } }
  const list = input.suggestions ?? []
  const selected = Math.max(0, Math.min(state.selected, list.length - 1))
  const active = list[selected]
  const go = (to: number) => {
    const next = Math.max(0, Math.min(to, list.length - 1))
    return next === state.selected ? { state, action: NONE } : { state: { selected: next }, action: NONE }
  }
  const at = EVOLUTION_MODE_ORDER.indexOf(input.mode)
  if (LEFT.has(key)) return { state, action: { type: "mode", mode: EVOLUTION_MODE_ORDER[(at + EVOLUTION_MODE_ORDER.length - 1) % EVOLUTION_MODE_ORDER.length]! } }
  if (RIGHT.has(key)) return { state, action: { type: "mode", mode: EVOLUTION_MODE_ORDER[(at + 1) % EVOLUTION_MODE_ORDER.length]! } }
  if (UP.has(key)) return go(selected - 1)
  if (DOWN.has(key)) return go(selected + 1)
  if (key === "o") return { state, action: { type: "evolutionWorkflows", enabled: !input.workflows } }
  if (key === "\x1b[5~" || key === "\x1b[6~") {
    const size = input.size ?? { width: 100, height: 26 }
    const layout = evolutionReviewLayout(size.width, size.height)
    const max = Math.max(0, reviewRows(active, layout.width, 0, input.error).length - layout.room)
    return { state: { ...state, scroll: Math.max(0, Math.min(max, (state.scroll ?? 0) + (key === "\x1b[5~" ? -5 : 5))) }, action: NONE }
  }
  if (key === "r" && active?.receipt && active.hash && ["accepted", "blocked"].includes(active.status)) return { state, action: { type: "evolutionRollback", suggestionId: active.suggestionId, expectedHash: active.hash, expectedRevision: active.receipt.revision } }
  if (key === "a" && active?.status === "pending" && active.kind !== "instruction" && active.hash && input.policyRevision) {
    if (input.mode === "off" || input.mode === "observe" || active.kind === "workflow" && !input.workflows) return { state, action: NONE }
    return { state, action: { type: "evolutionPromote", suggestionId: active.suggestionId, expectedHash: active.hash, policyRevision: input.policyRevision } }
  }
  if ((key === "a" || key === "x") && active?.status === "pending") return { state, action: { type: "suggestion", suggestionId: active.suggestionId, decision: key === "a" ? "accept" : "reject", ...(active.hash ? { expectedHash: active.hash } : {}) } }
  return { state, action: NONE }
}

function evolutionReviewLayout(width: number, height: number) {
  const compact = width < 70
  const remaining = Math.max(0, height - (compact ? 6 : 8) - 1)
  const listHeight = compact ? Math.min(5, Math.max(2, Math.floor(remaining / 3))) : remaining
  return { width: compact ? width : Math.max(1, columns(width, [2, 3])[1]! - 4), room: Math.max(1, compact ? remaining - listHeight - 3 : remaining - 4) }
}

function reviewRows(active: EvolutionSuggestion | undefined, width: number, now: number, error?: string): Line[] {
  const row = (text: string, fg: ColorName = "text"): Line => [{ text, fg }]
  if (!active) return [row("No candidate selected", "muted")]
  const lines: Line[] = [row(`${active.kind} · ${active.name}`, "primary"), row(`${active.evidence} evidence · ${active.status} · ${relativeTime(now, active.createdAt)}`, "muted"), ...wrap(active.description, width).map((text) => row(text)), []]
  if (error) lines.unshift(...wrap(error, width).map((text) => row(text, "error")), [])
  const receipt = active.receipt
  if (receipt) {
    lines.push(row(`Receipt · revision ${receipt.revision} · ${active.status}`, STATUS_TONE[active.status]), ...wrap(receipt.target, width).map((text) => row(text, "muted")), ...wrap(`SHA-256 ${receipt.hash}`, width).map((text) => row(text, "muted")))
    if (receipt.archive) lines.push(...wrap(`Retired · ${receipt.archive}`, width).map((text) => row(text, "muted")))
    lines.push([])
  } else lines.push(...wrap(active.kind === "workflow" ? `.mendcode/workflows/evo-${active.name.slice(0, 16)}-${active.suggestionId}.json` : active.kind === "skill" ? `.mendcode/skills/${active.name}/SKILL.md once accepted` : "Instruction text", width).map((text) => row(text, "muted")))
  if (active.hash) lines.push(...wrap(`Candidate SHA-256 ${active.hash}`, width).map((text) => row(text, "muted")))
  lines.push([], row("Content", "primary"))
  for (const text of active.content.split("\n")) {
    const indent = text.match(/^ */)?.[0].slice(0, Math.max(0, width - 1)) ?? ""
    lines.push(...wrap(text.trimStart(), Math.max(1, width - indent.length)).map((part) => row(indent + part, "body")))
  }
  return lines
}

/** Renders at most `height` rows of at most `width` cells. */
export function renderEvolutionTab(input: { mode: EvolutionMode; data: EvolutionData | undefined; state: EvolutionTabState; width: number; height: number; now: number }): Line[] {
  const { mode, data, state, width, now } = input
  const height = Math.max(0, input.height)
  const list = data?.suggestions ?? []
  const selected = Math.max(0, Math.min(state.selected, list.length - 1))
  const active = list[selected]
  const compact = width < 70
  const row = (text: string, fg: ColorName = "text"): Line => [{ text, fg }]
  const policy = (w: number): Line[] => [
    ...wrap(`mode     ‹ ${mode} ›  ${MODE_NOTE[mode]}`, w).map((text) => row(text, "primary")),
    ...(data ? [row(`seen     ${data.observed.corrections} corrections · ${data.observed.preferences} preferences · ${data.observed.recurring} recurring`), row(`suggestions  ${list.filter((item) => item.status === "pending").length} pending · ${list.length} shown · workflows ${data.workflows ? "on" : "off"}`)] : [row("loading suggestions", "muted")]),
    ...(mode === "off" ? [row("not recording", "muted")] : !list.length ? [row(!data ? "" : mode === "observe" ? "observe keeps no text" : "no suggestions yet", "muted")] : []),
  ]
  const compactPolicy = (w: number): Line[] => [
    row(`mode ‹ ${mode} › · workflows ${data?.workflows ? "on" : "off"}`, "primary"),
    ...wrap(MODE_NOTE[mode], w).map((text) => row(text, "muted")),
    row(data ? `${data.observed.corrections} corrections · ${data.observed.preferences} preferences · ${data.observed.recurring} recurring` : "loading suggestions", "muted"),
  ]
  const topHeight = compact ? 6 : 8
  const remaining = Math.max(0, height - topHeight - 1)
  const listHeight = compact ? Math.min(5, Math.max(2, Math.floor(remaining / 3))) : remaining
  const candidates = (w: number): Line[] => {
    if (!data) return [row("Loading candidates", "muted")]
    if (!list.length) return [row("No candidates", "muted")]
    const room = Math.max(1, listHeight - (compact ? 2 : 4))
    const start = Math.max(0, Math.min(selected - room + 1, list.length - room))
    return list.slice(start, start + room).map((item, offset) => clip([{ text: start + offset === selected ? "› " : "  ", fg: "primary" }, { text: `${item.kind === "instruction" ? "instr" : item.kind} ${truncateEnd(item.name, Math.max(1, w - 13))}`, fg: "text", bold: start + offset === selected }, { text: ` · ${item.status}`, fg: STATUS_TONE[item.status] }], w))
  }
  const review = (w: number) => reviewRows(active, w, now, data?.error)
  const top = panelGrid({ width, compact: false, padding: !compact, heights: [topHeight], rows: [[{ title: "Policy · Evidence", body: compact ? compactPolicy : policy }]] })
  const layout = evolutionReviewLayout(width, height)
  const total = review(layout.width).length
  const scroll = Math.max(0, Math.min(state.scroll ?? 0, total - layout.room))
  const reviewPanel = { title: `Review / receipt${total > layout.room ? ` · ${scroll + 1}/${total}` : ""}`, body: review, weight: 3, scroll }
  const bottom = compact ? [
    ...panelGrid({ width, compact, heights: [listHeight], rows: [[{ title: `Candidates · ${list.length}`, body: candidates }]] }), [],
    ...panelGrid({ width, compact, heights: [Math.max(0, remaining - listHeight - 1)], rows: [[reviewPanel]] }),
  ] : panelGrid({ width, compact, padding: true, heights: [remaining], rows: [[{ title: `Candidates · ${list.length}`, body: candidates, weight: 2, active: true }, reviewPanel]] })
  return [...top, [], ...bottom].slice(0, height).map((line) => clip(line, width))
}
