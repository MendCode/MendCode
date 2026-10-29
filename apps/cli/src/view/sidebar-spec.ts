import type { SidebarWidget } from "@mendcode/protocol"

export const WIDGET_TYPES = ["context", "usage", "todos", "changes", "jobs", "loops", "workflows", "agents", "mcp", "git", "session", "clock", "text", "sidechat", "agent", "activity", "workspace", "tokens", "tools", "alerts", "pace", "savings", "queue", "lineage", "files", "limits", "rent", "orbit", "models", "stats", "atom", "backlog"] as const
export const WIDGET_PRIORITIES = ["high", "normal", "low"] as const

/** Startup validation without protocol runtime schemas. The daemon validates every tool/command write. */
export function sidebarSpec(value: unknown): SidebarWidget[] {
  if (!Array.isArray(value) || value.length > 32) return []
  const widgets: SidebarWidget[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || typeof raw.type !== "string") return []
    if (Object.keys(raw).some((key) => !["type", "title", "options"].includes(key))) return []
    if (!WIDGET_TYPES.includes(raw.type) && !/^extension:[a-zA-Z0-9_-]+$/.test(raw.type)) return []
    if (raw.title !== undefined && (typeof raw.title !== "string" || raw.title.length > 100)) return []
    const options = raw.options ?? {}
    if (!options || typeof options !== "object" || Array.isArray(options)) return []
    if (Object.keys(options).some((key) => !["maxRows", "text", "priority"].includes(key))) return []
    if (options.maxRows !== undefined && (!Number.isInteger(options.maxRows) || options.maxRows < 1 || options.maxRows > 100)) return []
    if (options.text !== undefined && (!["text", "stats"].includes(raw.type) || typeof options.text !== "string" || options.text.length > 8_000)) return []
    if (options.priority !== undefined && !WIDGET_PRIORITIES.includes(options.priority)) return []
    widgets.push({ type: raw.type, ...(raw.title === undefined ? {} : { title: raw.title }), options: { ...options } })
  }
  return widgets
}

export const PANEL_PRESETS = ["pulse", "crew", "ledger", "focus", "full", "galaxy"] as const
export type PanelPreset = (typeof PANEL_PRESETS)[number]
const cards = (...types: SidebarWidget["type"][]): SidebarWidget[] => types.map((type, index) => ({ type, options: { priority: index < 2 ? "high" : "normal" } }))

/** Full includes every data card; the spatial view, side chat and user content remain explicit choices. */
export const SIDEBAR_PRESETS: Readonly<Record<PanelPreset, readonly SidebarWidget[]>> = {
  pulse: cards("agent", "context", "pace", "workspace", "tokens", "limits"),
  crew: cards("agents", "lineage", "queue", "jobs", "loops"),
  ledger: cards("tokens", "savings", "limits", "models", "rent"),
  focus: cards("context", "todos", "files"),
  full: cards("agent", "context", "pace", "workspace", "tokens", "limits", ...WIDGET_TYPES.filter((type) => !["agent", "context", "pace", "workspace", "tokens", "limits", "usage", "orbit", "atom", "backlog", "sidechat", "text"].includes(type))).map((widget) => ({ ...widget, options: {} })),
  // The card's type keeps its first name (`orbit`): saved panel specs name it.
  galaxy: cards("orbit"),
}

/** Legacy preset names are accepted only at the command boundary, never advertised. */
export const panelPreset = (name: string): PanelPreset | undefined => name === "atelier" ? "pulse" : name === "orbit" ? "galaxy" : PANEL_PRESETS.find((preset) => preset === name)
/** What makes a card the same card: its type, title and row cap. Priority is only a hint for short bars and key order never matters. */
const identity = (widget: SidebarWidget) => `${widget.type}\u0000${widget.title ?? ""}\u0000${widget.options?.maxRows ?? ""}\u0000${widget.options?.text ?? ""}`
const sameCards = (a: readonly SidebarWidget[], b: readonly SidebarWidget[]) => a.length === b.length && a.every((widget, index) => identity(widget) === identity(b[index]!))

/** The preset a spec equals, or `custom` for a genuinely edited list (an empty list is not a preset). */
export const presetOf = (widgets: readonly SidebarWidget[]): PanelPreset | "custom" => (widgets.length ? PANEL_PRESETS.find((preset) => sameCards(widgets, SIDEBAR_PRESETS[preset])) : undefined) ?? "custom"

/** The preset after `current` among `available`, wrapping; a custom or empty spec starts the cycle at its first preset. */
export function nextPreset(current: PanelPreset | "custom", available: readonly PanelPreset[]): PanelPreset {
  const from = current === "custom" ? -1 : PANEL_PRESETS.indexOf(current)
  for (let step = 1; step <= PANEL_PRESETS.length; step++) {
    const candidate = PANEL_PRESETS[(from + step) % PANEL_PRESETS.length]!
    if (available.includes(candidate)) return candidate
  }
  return available[0] ?? "pulse"
}

/** The closest preset that needs less than the one refused (galaxy shows the agent tree, so crew). */
export const NEAREST_PRESET: Readonly<Partial<Record<PanelPreset, PanelPreset>>> = { galaxy: "crew" }
