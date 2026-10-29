import type { SharingResult, SharingScope, SharingStatusReport } from "@mendcode/protocol"
import type { Line } from "../ui/theme"
import { panelGrid } from "./deck"
import { wrap } from "./wrap"

export type SharingState = { scope: SharingScope; scroll: number; confirmation?: string; busy?: boolean }
export type SharingData = { status?: SharingStatusReport | undefined; result?: SharingResult | undefined; error?: string | undefined }
export type SharingAction = { type: "none" } | { type: "refreshSharing" } | { type: "sharing"; action: "enable" | "disable" | "export" | "import"; confirmation?: string } | { type: "close" }
export const SHARING_HINTS = "s scope · e enable · d disable · o export · i import · ↑↓ scroll · w projects · tab tabs · esc back"

export function sharingKey(state: SharingState, key: string): { state: SharingState; action: SharingAction } {
  const stay = (next: SharingState = state, action: SharingAction = { type: "none" }) => ({ state: next, action })
  if (state.busy) return stay()
  if (state.confirmation !== undefined) {
    const { confirmation: _confirmation, ...closed } = state
    if (key === "\x1b") return stay(closed)
    if (key === "\x15") return stay({ ...state, confirmation: "" })
    if (key === "\x7f" || key === "\b") return stay({ ...state, confirmation: state.confirmation.slice(0, -1) })
    if (key === "\r" || key === "\n") return state.confirmation === `ENABLE ${state.scope.toUpperCase()}` ? stay(closed, { type: "sharing", action: "enable", confirmation: state.confirmation }) : stay()
    if (/^[\x20-\x7e]+$/.test(key)) return stay({ ...state, confirmation: (state.confirmation + key).slice(0, 32) })
    return stay()
  }
  if (key === "\x1b") return stay(state, { type: "close" })
  if (key === "s") return stay({ scope: state.scope === "project" ? "user" : "project", scroll: 0 }, { type: "refreshSharing" })
  if (key === "e") return stay({ ...state, confirmation: "" })
  if (key === "d" || key === "o" || key === "i") return stay({ ...state, scroll: 0 }, { type: "sharing", action: key === "d" ? "disable" : key === "o" ? "export" : "import" })
  if (key === "r") return stay(state, { type: "refreshSharing" })
  const delta = key === "\x1b[B" || key === "j" ? 1 : key === "\x1b[A" || key === "k" ? -1 : key === "\x1b[6~" ? 10 : key === "\x1b[5~" ? -10 : 0
  return stay(delta ? { ...state, scroll: Math.max(0, state.scroll + delta) } : state)
}

const row = (text: string, fg: "text" | "muted" | "primary" | "error" | "warning" = "text"): Line => [{ text, fg }]
export function renderSharing(state: SharingState, data: SharingData, width: number, height: number): Line[] {
  const controls = (w: number): Line[] => [
    row(`${state.scope} · ${state.busy ? "Working…" : data.status ? data.status.enabled ? "Enabled" : "Disabled" : data.error ? "Unavailable" : "Loading…"}`, "primary"),
    row(`${data.status?.entries ?? 0} tracked files`), [],
    ...(state.confirmation !== undefined ? [row(`Type ENABLE ${state.scope.toUpperCase()}`, "warning"), ...wrap("Other local tools can read exported memories.", w).map((text) => row(text, "muted")), row(`${state.confirmation}▏`)] : [row("Import → Pending review", "muted"), row("Disable keeps exported files", "muted")]), [],
    ...wrap(data.status?.directory ?? "", w).map((text) => row(text, "muted")),
  ]
  const outcome = (w: number): Line[] => {
    if (data.error) return wrap(data.error, w).map((text) => row(text, "error"))
    if (!data.result) return []
    const result = data.result
    return [row(`${result.action === "export" ? "Export" : "Import"} · ${result.exported.length} exported · ${result.proposals.length} proposals`, "primary"), row(`${result.conflicts.length} conflicts · ${result.skipped.length} skipped`), [],
      ...result.exported.map((id) => row(`Exported ${id}`, "muted")),
      ...result.proposals.map((id) => row(`Review ${id}`)),
      ...result.conflicts.flatMap((issue) => [row(issue.id, "muted"), ...wrap(issue.reason, w).map((text) => row(text, "error"))]),
      ...result.skipped.flatMap((issue) => [row(issue.id, "muted"), ...wrap(issue.reason, w).map((text) => row(text, "warning"))]),
    ]
  }
  const split = width >= 70
  return panelGrid({ width, compact: false, padding: true, maxColumns: split ? 2 : 1, heights: [height], rows: [[
    { title: "Editable Markdown", body: (w) => split ? controls(w) : state.confirmation !== undefined || (!data.error && !data.result) ? controls(w) : [controls(w)[0]!, [], ...outcome(w), [], ...controls(w).slice(1)], active: state.confirmation !== undefined, scroll: split ? 0 : state.scroll },
    ...(split ? [{ title: "Results", body: outcome, weight: 2, scroll: state.scroll }] : []),
  ]] })
}
