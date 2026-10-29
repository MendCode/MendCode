import type { McpCatalogReport, McpResourceContent } from "@mendcode/protocol"
import type { Line } from "../ui/theme"
import { fit, panelGrid, spread, type GridPanel } from "./deck"
import { wrap } from "./wrap"

export type McpCatalogState = {
  catalogOpen?: boolean
  catalogTab?: "resources" | "prompts" | "templates"
  catalogSelected?: number
  catalog?: McpCatalogReport
  catalogLoading?: boolean
  catalogError?: string
  catalogPreview?: { id: string; contents: McpResourceContent[] }
  catalogScroll?: number
}

export const catalogTabs = ["resources", "prompts", "templates"] as const
export const catalogEntries = (state: McpCatalogState) => state.catalog?.[state.catalogTab ?? "resources"] ?? []

export function renderMcpCatalog(state: McpCatalogState, width: number, height: number): Line[] {
  const tab = state.catalogTab ?? "resources"
  const entries = catalogEntries(state)
  const selected = Math.max(0, Math.min(state.catalogSelected ?? 0, entries.length - 1))
  const target = entries[selected]
  const compact = width < 70
  const actions = `${tab !== "templates" ? "enter use · " : ""}${tab === "resources" ? "r read · " : ""}`
  const hints = compact ? `↑↓ · tab · ${tab !== "templates" ? "↵ · " : ""}${tab === "resources" ? "r read · " : ""}l · esc` : `↑↓ select · tab section · ${actions}l reload · esc back`
  const rows: Line[] = [
    spread([{ text: "MCP catalog", fg: "primary", bold: true }], [{ text: hints, fg: "muted" }], width),
    fit(catalogTabs.flatMap((name): Line => [{ text: `${name} ${state.catalog?.[name].length ?? 0}   `, fg: name === tab ? "primary" : "muted", bold: name === tab }]), width),
    [],
  ]
  const room = Math.max(0, height - rows.length)
  const listHeight = compact ? Math.min(8, Math.max(5, Math.floor(room / 2))) : room
  const list: GridPanel = {
    title: tab[0]!.toUpperCase() + tab.slice(1),
    active: true,
    body: (inner) => {
      if (state.catalogLoading) return [[{ text: "Loading catalog…", fg: "muted" }]]
      if (!entries.length) return [[{ text: state.catalogError || `0 ${tab}`, fg: state.catalogError ? "error" : "muted" }]]
      const count = Math.max(1, listHeight - 4)
      const start = Math.max(0, selected - count + 1)
      return entries.slice(start, start + count).map((entry, offset) => fit([{ text: start + offset === selected ? "› " : "  ", fg: "primary" }, { text: entry.id, fg: start + offset === selected ? "primary" : "text", bold: start + offset === selected }], inner))
    },
  }
  const detail: GridPanel = {
    title: target && state.catalogPreview?.id === target.id && tab === "resources" ? "Resource content" : "Details",
    scroll: state.catalogScroll ?? 0,
    body: (inner) => {
      const body: Line[] = []
      const text = (value: string, fg: "text" | "muted" | "primary" | "error" = "text") => body.push(...wrap(value, inner).map((line): Line => [{ text: line, fg }]))
      if (state.catalogError) text(state.catalogError, "error")
      if (target) {
        text(target.name, "primary")
        text(target.server, "muted")
        if (target.description) text(target.description)
        if ("uri" in target) text(target.uri, "muted")
        if ("uriTemplate" in target) text(target.uriTemplate, "muted")
        if ("arguments" in target) for (const arg of target.arguments ?? []) text(`${arg.required ? `<${arg.name}>` : `[${arg.name}]`}${arg.description ? `  ${arg.description}` : ""}`)
        const preview = state.catalogPreview
        if (preview?.id === target.id && tab === "resources") {
          body.push([])
          for (const content of preview.contents) {
            text(content.text?.slice(0, 32_000) ?? `[binary: ${content.mimeType ?? "application/octet-stream"}]`)
            if (content.text && content.text.length > 32_000) text("[preview truncated at 32000 characters]", "muted")
          }
        }
      }
      for (const issue of state.catalog?.issues ?? []) text(`${issue.server ?? issue.source}: ${issue.message}`, "error")
      return body
    },
  }
  if (compact) {
    rows.push(...panelGrid({ rows: [[list], [detail]], width, heights: [listHeight, Math.max(0, room - listHeight - 1)], compact: false, maxColumns: 1, padding: true }))
  } else rows.push(...panelGrid({ rows: [[{ ...list, weight: 2 }, { ...detail, weight: 3 }]], width, heights: [room], compact: false, padding: true }))
  return [...rows, ...Array.from({ length: Math.max(0, height - rows.length) }, (): Line => [])].slice(0, height).map((row) => fit(row, width))
}
