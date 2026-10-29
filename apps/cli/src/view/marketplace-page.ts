import type { PackageAssetsReport, PackageCatalogEntry, PackageCatalogReport, PackagePreviewReport, PackageSourceInfo } from "@mendcode/protocol"
import type { Line } from "../ui/theme"
import { panelGrid, type GridPanel } from "./deck"
import { pickerFrame } from "./picker-frame"
import { describeContents } from "./packages-page"
import { wrap } from "./wrap"

export type MarketplaceState = {
  mode: "catalog" | "sources" | "assets"
  selected: number
  query: string
  sourceId?: string
  scope: "user" | "project"
  editing?: "query" | "id" | "location"
  input: string
  draftId: string
  confirm?: "install" | "remove-source"
  sourceDetail?: boolean
  scroll: number
}
export const createMarketplaceState = (): MarketplaceState => ({ mode: "catalog", selected: 0, query: "", scope: "user", input: "", draftId: "", scroll: 0 })
export const catalogMatches = (report: PackageCatalogReport | undefined, query: string) => (report?.entries ?? []).filter((entry) => [entry.name, entry.title ?? "", entry.description, entry.version, entry.sourceId, ...entry.tags].join(" ").toLowerCase().includes(query.trim().toLowerCase()))
const row = (text: string, fg: "text" | "muted" | "primary" | "error" | "warning" = "text"): Line => [{ text, fg }]

export function renderMarketplacePage(input: { state: MarketplaceState; report?: PackageCatalogReport | undefined; sources: PackageSourceInfo[]; preview?: PackagePreviewReport | undefined; assets?: PackageAssetsReport | undefined; error: string; width: number; height: number }): Line[] {
  const { state, width, height } = input
  const room = Math.max(0, height - 2)
  const split = width >= 110
  const entries = catalogMatches(input.report, state.query)
  const selected = entries[Math.min(state.selected, Math.max(0, entries.length - 1))]
  const hints = state.confirm ? "y confirm · esc cancel" : state.editing ? "enter save · esc cancel" : state.mode === "assets" ? "[] scroll · r reload · esc back" : state.mode === "sources" ? state.sourceDetail ? "enter list · e on/off · d remove · esc back" : "enter details · a add · e on/off · u fetch · d remove · c catalog · ↑↓ select · esc back" : input.preview ? "i install · p scope · [] scroll · esc back" : "↑↓ select · enter preview · / search · s sources · p scope · r reload · esc back"
  const title = state.mode === "assets" ? "MendCode Assets" : state.mode === "sources" ? "Marketplace / Sources" : input.preview ? "Marketplace / Preview" : "MendCode Marketplace"
  const summary = input.error || (state.editing ? `${state.editing === "query" ? "Search" : state.editing === "id" ? "Source ID" : `Folder or https catalog for ${state.draftId}`} / ${state.input}█` : state.confirm === "install" ? `Install ${input.preview?.entry.name} in ${state.scope}?` : state.confirm === "remove-source" ? `Remove source ${input.sources[state.selected]?.id}?` : state.mode === "assets" ? "" : state.mode === "sources" ? `${input.sources.length} source${input.sources.length === 1 ? "" : "s"}` : `${entries.length} package${entries.length === 1 ? "" : "s"} · ${state.scope}${state.sourceId ? ` · ${state.sourceId}` : ""}${state.query ? ` · ${state.query}` : ""}`)
  const grid = (panels: GridPanel[], focus = state.selected) => {
    if (split) return panelGrid({ width, rows: [panels], heights: [room], compact: false, padding: true })
    if (width < 70) {
      const panel = input.preview && state.mode === "catalog" || state.mode === "sources" && state.sourceDetail ? panels[1]! : panels[0]!
      return panelGrid({ width, rows: [[panel]], heights: [room], compact: false, padding: true, maxColumns: 1 })
    }
    const top = Math.max(6, Math.floor((room - 1) * 0.4))
    const first = { ...panels[0]!, scroll: Math.max(0, focus - top + 5) }
    return panelGrid({ width, rows: [[first], [panels[1]!]], heights: [top, Math.max(0, room - top - 1)], compact: false, padding: true, maxColumns: 1 })
  }
  if (state.mode === "assets") {
    const totals = input.assets?.totals
    const summaryRows = totals ? [row(`Skills: ${totals.skills}`), row(`Slash commands: ${totals.commands}`), row(`Agents: ${totals.agents ?? 0}`), row(`Prompt templates: ${totals.templates}`), row(`MCP files: ${input.assets!.layers.filter((layer) => layer.contents.mcp).length}`), row(`Prompt mode: ${input.assets!.promptMode}`), row(`Prompt files: ${totals.prompts}`), row(`Tools: ${totals.tools}`), row(`Themes: ${totals.themes}`), row(`Extensions: ${totals.extensions ?? 0}`)] : [row(input.error || "Loading assets…", input.error ? "error" : "muted")]
    const panels: GridPanel[] = [{ title: "Runtime assets", body: summaryRows, weight: 1 }, { title: "Active layers", body: (w) => input.assets?.layers.flatMap((layer) => [row(layer.source, "primary"), ...wrap(`${describeContents(layer.contents)}${layer.prompts ? ` · ${layer.prompts} prompt file${layer.prompts === 1 ? "" : "s"}` : ""}${layer.templates ? ` · ${layer.templates} template${layer.templates === 1 ? "" : "s"}` : ""}`, w).map((text) => row(text, "muted")), []]) ?? [], weight: 2, scroll: state.scroll }]
    if (width < 110) return pickerFrame(title, hints, width, height, panelGrid({ width, rows: [[{ ...panels[0]!, body: [...summaryRows, [], row("Active layers", "primary"), ...input.assets?.layers.map((layer) => row(`${layer.source} · ${describeContents(layer.contents)}`)) ?? []], scroll: state.scroll }]], heights: [room], compact: false, padding: true }), summary)
    return pickerFrame(title, hints, width, height, grid(panels), summary)
  }
  if (state.mode === "sources") {
    const source = input.sources[state.selected]
    return pickerFrame(title, hints, width, height, grid([
      { title: "Sources", body: input.sources.map((source, i) => row(`${i === state.selected ? "›" : " "} ${source.id} · ${source.enabled ? "on" : "off"}${source.remote ? " · remote" : ""}`, i === state.selected ? "primary" : "text")), active: true, scroll: Math.max(0, state.selected - room + 5), weight: 2 },
      { title: source?.remote ? "Remote catalog" : "Local catalog", body: (w) => source ? [row(source.id, "primary"), ...wrap(source.location, w).map((text) => row(text)), [], row(source.enabled ? "Enabled" : "Disabled", source.enabled ? "text" : "muted"), ...(source.remote ? [row(source.fetchedAt ? `Fetched ${new Date(source.fetchedAt).toISOString().slice(0, 16).replace("T", " ")}` : "Not fetched yet", "muted"), row(source.enabled ? "u fetch the index (network)" : "enable it, then u fetches the index", "muted")] : []), ...(source.builtin ? [] : [row("e enable/disable · d remove", "muted")])] : [row("No sources", "muted")], weight: 3, scroll: state.scroll },
    ]), summary)
  }
  const preview = input.preview
  const detail: GridPanel = { title: preview ? "Install preview" : "Package", weight: 3, scroll: state.scroll, body: (w) => {
    const entry = preview?.entry ?? selected
    if (!entry) return [row(input.error || (input.report ? "No packages match" : "Loading catalog…"), input.error ? "error" : "muted")]
    const rows = [row(entry.title ?? entry.name, "primary"), row(`${entry.name} · ${entry.version} · ${entry.state}`), ...wrap(entry.description, w).map((text) => row(text)), [], row(`Source: ${entry.sourceId}`), ...wrap(entry.location, w).map((text) => row(text, "muted")), ...wrap(describeContents(entry.contents), w).map((text) => row(text)), ...(entry.tags.length ? wrap(`Tags: ${entry.tags.join(", ")}`, w).map((text) => row(text, "muted")) : [])]
    if (entry.problem) rows.push(...wrap(entry.problem, w).map((text) => row(text, "error")))
    if (entry.remote) rows.push([], row("Fetched and audited on install", "muted"))
    if (preview?.trust) {
      const trust = preview.trust
      rows.push([], row("Trust · unsigned", "warning"), ...wrap(`Identity: ${trust.identity} · ${preview.scope}`, w).map((text) => row(text)), ...wrap("Capabilities do not grant permission", w).map((text) => row(text, "muted")), ...trust.duplicates.flatMap((key) => wrap(`Duplicate content: ${key}`, w).map((text) => row(text, "warning"))))
      if (!trust.comparisonComplete) rows.push(...wrap("Duplicate scan incomplete", w).map((text) => row(text, "muted")))
    }
    if (preview?.capabilities) {
      const caps = preview.capabilities
      rows.push([], row("Capabilities · static hints", "primary"), ...wrap(`Declared: ${caps.declared.join(", ") || "none"}`, w).map((text) => row(text)), ...wrap(`Observed: ${caps.observed.join(", ") || "none"}`, w).map((text) => row(text)), ...wrap(caps.complete ? "Code can do more than this scan detects" : "Partial scan · capabilities unknown", w).map((text) => row(text, "muted")))
      if (caps.declaredEnvironment?.length || caps.observedEnvironment?.length) rows.push(...wrap(`Env names: ${[...new Set([...(caps.declaredEnvironment ?? []), ...(caps.observedEnvironment ?? [])])].join(", ")}`, w).map((text) => row(text)))
    }
    if (preview) rows.push([], row(`${preview.action === "replace" ? `Replace ${preview.installedVersion ?? "installed"}` : "Install"} → ${preview.scope}`, "primary"), row(`${preview.problems.length} audit problems`, preview.problems.length ? "error" : "text"), ...preview.problems.flatMap((problem) => wrap(problem, w).map((text) => row(text, "error"))))
    return rows
  } }
  const list: GridPanel = { title: "Catalog", body: (w) => entries.length ? entries.map((entry, i) => row(`${i === state.selected ? "›" : " "} ${entry.name} · ${entry.version} · ${entry.state}`, i === state.selected ? "primary" : "text")) : [row(input.error || (input.report ? "No catalog packages" : "Loading catalog…"), input.error ? "error" : "muted"), ...input.report?.issues.flatMap((issue) => wrap(issue, w).map((text) => row(text, "error"))) ?? []], weight: 2, active: true, scroll: Math.max(0, state.selected - room + 5) }
  return pickerFrame(title, hints, width, height, grid([list, detail]), summary)
}
