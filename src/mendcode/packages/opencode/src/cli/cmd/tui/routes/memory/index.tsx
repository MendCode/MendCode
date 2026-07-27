import { createEffect, createMemo, createResource, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { BoxRenderable, MouseButton, MouseEvent } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { asciiGraphNearestNode, asciiGraphRuns, layoutAsciiGraph, renderAsciiGraph, type AsciiGraphCell } from "@mendcode/plugin/tui"
import { memoryGraphOverview, memoryOverview } from "@/mend/memory/overview"
import { applyMemoryProposal, rejectMemoryProposal, updateMemoryProposal, type MemoryProposal } from "@/mend/memory/proposals"
import { deleteMemoryEntry, readMemoryEntries, updateMemoryEntry, type MemoryEntry } from "@/mend/memory/store"
import { registerMemoryWorkspace, type MemoryWorkspace } from "@/mend/memory/workspaces"
import { resetMemoryCategoryPolicy, writeMemoryCategoryPolicy, type MemoryCategoryPolicy, type MemoryPolicyScope, type MemoryWritePolicy } from "@/mend/memory/categories"
import { applyDreamGraphProposal, rejectDreamGraphProposal } from "@/mend/memory/dream"
import { readDreamScheduleState, type DreamScheduleState, type DreamScheduleWindow } from "@/mend/memory/dream-scheduler"
import { Locale } from "@/util/locale"
import { useProject } from "@tui/context/project"
import { routeReturnTarget, useRoute } from "@tui/context/route"
import { useSDK } from "@tui/context/sdk"
import { useTheme } from "@tui/context/theme"
import { useCommandDialog } from "@tui/component/dialog-command"
import { CommandDeck, commandDeckLayout } from "@tui/component/command-deck"
import { useKV } from "@tui/context/kv"
import { DialogConfirm } from "@tui/ui/dialog-confirm"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { useToast } from "@tui/ui/toast"

type MemoryOverview = Awaited<ReturnType<typeof memoryOverview>>
type MemoryGraphOverview = Awaited<ReturnType<typeof memoryGraphOverview>>
type MemoryGraphFactView = MemoryOverview["facts"][number]
type DreamRunDetailView = MemoryOverview["dreamRunDetails"][number]
type MemoryTab = "memories" | "graph" | "dream" | "rules"
type MemoryScopeFilter = "current" | "global" | "all"
type MemoryListEntry = {
  entry: MemoryEntry
  root: string
  projectLabel: string
}
type Selection =
  | { kind: "entry"; entry: MemoryEntry; root: string; projectLabel: string }
  | { kind: "proposal"; proposal: MemoryProposal }
  | { kind: "policy"; category: MemoryOverview["categories"][number]; policy: MemoryCategoryPolicy; layer: NonNullable<MemoryOverview["policyLayers"]>[string] | null }
  | { kind: "dream"; detail: DreamRunDetailView | null }
  | { kind: "overview" }

const TABS: Array<{ id: MemoryTab; label: string; compactLabel: string }> = [
  { id: "memories", label: "Memories", compactLabel: "Memories" },
  { id: "graph", label: "Graph", compactLabel: "Graph" },
  { id: "dream", label: "Dream", compactLabel: "Dream" },
  { id: "rules", label: "Rules", compactLabel: "Rules" },
]

const WRITE_POLICIES: MemoryWritePolicy[] = ["disabled", "pending", "auto-apply-safe", "manual-only"]
const ENTRY_ROW_LIMIT = 11
const POLICY_ROW_LIMIT = 12
const DREAM_RUN_ROW_LIMIT = 8

export function memoryListWindow<T>(items: T[], selectedIndex: number, limit: number) {
  const size = Math.max(1, limit)
  const selected = Math.max(0, Math.min(selectedIndex, Math.max(0, items.length - 1)))
  const start = Math.max(0, Math.min(selected - Math.floor(size / 2), Math.max(0, items.length - size)))
  return items.slice(start, start + size).map((item, offset) => ({ item, index: start + offset }))
}

export function memoryLayoutForDimensions(input: { width: number; height: number }) {
  return {
    tiny: input.width < 88 || input.height < 24,
    medium: input.width >= 112 && input.height >= 28,
    wide: input.width >= 132 && input.height >= 28,
    contentWidth: Math.max(40, input.width - 6),
  }
}

export function memoryGraphExplorerLayout(input: { width: number; height: number }) {
  const roomy = input.width >= 96
  const inspectorWidth = roomy ? Math.min(62, Math.max(46, Math.floor(input.width * 0.3))) : input.width
  return {
    roomy,
    inspectorWidth,
    canvasWidth: Math.max(30, Math.min(180, roomy ? input.width - inspectorWidth - 4 : input.width - 2)),
    canvasHeight: Math.max(8, Math.min(72, roomy ? input.height - 12 : Math.floor((input.height - 9) * 0.42))),
  }
}

function short(value: string | null | undefined, width: number) {
  const text = value ?? ""
  if (width <= 0) return ""
  return Locale.truncate(text, Math.max(1, width))
}

export function memoryPreviewText(value: string | null | undefined, max = 96) {
  const compact = (value ?? "").replace(/\s+/g, " ").trim()
  const redacted = compact
    .replace(/\b[A-Z0-9_]{3,}=(?:[^\s,;]+)/g, (match) => `${match.split("=")[0]}=<redacted>`)
    .replace(/\b(sk|pk|ghp|gho|github_pat)_[A-Za-z0-9_=-]{12,}/gi, "<redacted-token>")
    .replace(/\b(?:password|passwd|token|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, (match) => `${match.split(/[:=]/)[0].trim()}=<redacted>`)
  return short(redacted, max)
}

export function shouldMemoryRouteHandleKey(input: {
  dialogOpen: boolean
  defaultPrevented?: boolean
  textInputActive?: boolean
  emergency?: boolean
}) {
  return !input.dialogOpen && (input.emergency === true || (input.defaultPrevented !== true && input.textInputActive !== true))
}

export function memoryTabCellWidths(input: { width: number; labels?: string[]; count?: number; gap?: number }) {
  const count = Math.max(1, input.labels?.length ?? input.count ?? TABS.length)
  const gap = Math.max(0, input.gap ?? 1)
  const available = Math.max(count * 2, Math.floor(input.width) - Math.max(0, count - 1) * gap)
  const desired = Array.from({ length: count }, (_, index) => Math.max(2, input.labels?.[index]?.length ?? 8))
  const minimum = available < count * 6 ? 2 : 4
  const widths = desired.map((value) => Math.max(minimum, value))
  while (widths.reduce((sum, value) => sum + value, 0) > available) {
    const index = widths.reduce((largest, value, current) => value > widths[largest]! ? current : largest, 0)
    if (widths[index]! <= minimum) break
    widths[index]!--
  }
  return widths
}

export function memoryTabPresentation(input: { width: number; active: MemoryTab }) {
  const labels = (compact: boolean) => TABS.map((tab, index) => `${input.active === tab.id ? "●" : " "} ${index + 1} ${compact ? tab.compactLabel : tab.label}`)
  const full = labels(false)
  const compact = labels(true)
  const fits = (items: string[], gap: number) => items.reduce((sum, item) => sum + item.length, 0) + Math.max(0, items.length - 1) * gap <= input.width
  if (fits(full, 2)) return { labels: full, gap: 2, mode: "full" as const }
  if (fits(compact, 1)) return { labels: compact, gap: 1, mode: "compact" as const }
  return { labels: TABS.map((tab, index) => `${input.active === tab.id ? "●" : " "}${index + 1}`), gap: 1, mode: "numeric" as const }
}

export function memoryGraphCommandHints(width: number) {
  const hints = [
    { key: "arrows", label: "move map" },
    { key: "HJKL", label: "select memory" },
    { key: "drag/trackpad", label: "pan" },
    { key: "+/-", label: "zoom" },
    { key: "Esc", label: "done" },
  ]
  if (width < 72) return [hints[0]!, hints[1]!, hints[3]!, hints[4]!]
  return hints
}

export function memoryGraphNavigationDirection(input: { name: string; shift?: boolean }) {
  if (input.name === "h") return { x: -1, y: 0 } as const
  if (input.name === "l") return { x: 1, y: 0 } as const
  if (input.name === "k") return { x: 0, y: -1 } as const
  if (input.name === "j") return { x: 0, y: 1 } as const
  return null
}

export function memoryGraphPanDirection(name: string) {
  if (name === "left") return { x: -1, y: 0 } as const
  if (name === "right") return { x: 1, y: 0 } as const
  if (name === "up") return { x: 0, y: -1 } as const
  if (name === "down") return { x: 0, y: 1 } as const
  return null
}

export function memoryGraphPanViewport(input: {
  viewport: { x?: number; y?: number; zoom: number }
  transform: { centerX: number; centerY: number; scaleX: number; scaleY: number; dotsX: number; dotsY: number }
  cells: { x: number; y: number }
}) {
  return {
    ...input.viewport,
    x: (input.viewport.x ?? input.transform.centerX) + (input.cells.x * input.transform.dotsX) / input.transform.scaleX,
    y: (input.viewport.y ?? input.transform.centerY) + (input.cells.y * input.transform.dotsY) / input.transform.scaleY,
  }
}

const MEMORY_GRAPH_NODE_TONES = ["accent", "success", "warning", "error", "syntaxString", "syntaxNumber", "syntaxKeyword"] as const

export function memoryGraphNodeTone(index: number) {
  return MEMORY_GRAPH_NODE_TONES[Math.abs(Math.floor(index)) % MEMORY_GRAPH_NODE_TONES.length]!
}

function memoryGraphNodeColor(theme: ReturnType<typeof useTheme>["theme"], index: number) {
  const palette = MEMORY_GRAPH_NODE_TONES
    .map((tone) => theme[tone])
    .filter((color) => Math.hypot(color.r - theme.primary.r, color.g - theme.primary.g, color.b - theme.primary.b) >= 0.22)
  return palette[Math.abs(Math.floor(index)) % palette.length] ?? theme.text
}

function comparableRoot(root: string) {
  return root.replace(/\/+$/, "")
}

export type MemoryGraphViewPreference = {
  version: 2
  scope: "all" | "project"
  projectRoot: string | null
  showIsolates: boolean
}

export function normalizeMemoryGraphViewPreference(value: unknown, projectRoots: string[], defaultProjectRoot?: string): MemoryGraphViewPreference {
  const candidate = value && typeof value === "object" ? value as Partial<MemoryGraphViewPreference> : {}
  const projectRoot = typeof candidate.projectRoot === "string"
    ? projectRoots.find((root) => comparableRoot(root) === comparableRoot(candidate.projectRoot!)) ?? null
    : projectRoots.find((root) => comparableRoot(root) === comparableRoot(defaultProjectRoot ?? "")) ?? null
  const migrated = candidate.version !== 2
  return {
    version: 2,
    scope: migrated ? (projectRoot ? "project" : "all") : candidate.scope === "project" && projectRoot ? "project" : "all",
    projectRoot: migrated && projectRoot ? projectRoot : candidate.scope === "project" ? projectRoot : null,
    showIsolates: migrated ? false : candidate.showIsolates === true,
  }
}

export function memorySidebarProjectWorkspaces(input: { currentRoot: string; workspaces: MemoryWorkspace[] }) {
  const current = comparableRoot(input.currentRoot)
  return input.workspaces
    .filter((workspace) => comparableRoot(workspace.root) !== current)
    .toSorted((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt) || a.displayName.localeCompare(b.displayName))
}

function formatDate(value: string | null | undefined) {
  if (!value) return "none"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return short(value, 16)
  return date.toLocaleDateString([], { month: "short", day: "numeric" })
}

function formatTime(value: string | null | undefined) {
  if (!value) return ""
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return short(value, 8)
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
}

function nextWritePolicy(value: MemoryWritePolicy) {
  const index = WRITE_POLICIES.indexOf(value)
  return WRITE_POLICIES[(index + 1) % WRITE_POLICIES.length] ?? "pending"
}

function stat(label: string, value: string, detail?: string) {
  return { label, value, detail }
}

type MemoryGraphMiniFact = {
  id: string
  text: string
  scope: string
  categoryIDs: string[]
  ownerWorkspaceIDs?: string[]
  retrievalPriority?: number
  materialized?: boolean
  stale?: boolean
}

type MemoryGraphMiniLink = {
  from: string
  to: string
  kind: string
}

type MemoryGraphMiniCategory = {
  id: string
  label: string
  count: number
}

export function memoryGraphMiniMap(input: {
  facts: MemoryGraphMiniFact[]
  links: MemoryGraphMiniLink[]
  categories: MemoryGraphMiniCategory[]
  width: number
  height?: number
  connectedOnly?: boolean
  selectedID?: string
  zoom?: number
  viewport?: { x?: number; y?: number; zoom?: number }
  maxNodes?: number
}) {
  const width = Math.max(20, Math.min(180, Math.floor(input.width)))
  const height = Math.max(6, Math.min(72, Math.floor(input.height ?? 10)))
  const graphEligibleFacts = input.facts.filter((fact) => !fact.stale && !fact.categoryIDs.includes("volatile.reject"))
  const materializedFacts = graphEligibleFacts.filter((fact) => fact.materialized !== false)
  const legacyDerivedFacts = graphEligibleFacts.length - materializedFacts.length
  const filteredFacts = input.facts.length - graphEligibleFacts.length
  const graphFactIDs = new Set(materializedFacts.map((fact) => fact.id))
  const graphLinks = input.links.filter((link) => graphFactIDs.has(link.from) && graphFactIDs.has(link.to))
  const filteredLinks = input.links.length - graphLinks.length
  const linkedIDs = new Set(graphLinks.flatMap((link) => [link.from, link.to]))
  const isolatedFacts = materializedFacts.filter((fact) => !linkedIDs.has(fact.id))
  const graphFacts = input.connectedOnly ? materializedFacts.filter((fact) => linkedIDs.has(fact.id)) : materializedFacts
  const maxNodes = Math.max(1, input.maxNodes ?? (width < 44 ? 10 : width < 64 ? 16 : 24))
  const rank = (facts: MemoryGraphMiniFact[]) => facts.toSorted((a, b) => (a.retrievalPriority ?? 99) - (b.retrievalPriority ?? 99) || a.id.localeCompare(b.id))
  const connectedFacts = rank(graphFacts.filter((fact) => linkedIDs.has(fact.id)))
  const disconnectedFacts = rank(graphFacts.filter((fact) => !linkedIDs.has(fact.id)))
  const isolateSlots = input.connectedOnly ? 0 : Math.min(disconnectedFacts.length, Math.max(1, Math.floor(maxNodes / 2)))
  const reservedConnected = connectedFacts.slice(0, maxNodes - isolateSlots)
  const reservedDisconnected = disconnectedFacts.slice(0, isolateSlots)
  const reservedIDs = new Set([...reservedConnected, ...reservedDisconnected].map((fact) => fact.id))
  const sampledFacts = graphFacts.length <= maxNodes
    ? graphFacts
    : [...reservedConnected, ...reservedDisconnected, ...[...connectedFacts, ...disconnectedFacts].filter((fact) => !reservedIDs.has(fact.id)).slice(0, maxNodes - reservedIDs.size)]
  const selectedFact = graphFacts.find((fact) => fact.id === input.selectedID)
  const visibleFacts = selectedFact && !sampledFacts.some((fact) => fact.id === selectedFact.id)
    ? [...sampledFacts.slice(0, -1), selectedFact]
    : sampledFacts
  const scene = layoutAsciiGraph({
    nodes: visibleFacts.map((fact) => ({
      id: fact.id,
      label: memoryPreviewText(fact.text, width < 44 ? 18 : 26),
      group: fact.categoryIDs[0] ?? "uncategorized",
      layoutGroup: fact.scope === "global" ? "global" : `project:${fact.ownerWorkspaceIDs?.[0] ?? "current"}`,
      weight: Math.max(0, 10 - (fact.retrievalPriority ?? 10)),
    })),
    edges: graphLinks,
    maxNodes: visibleFacts.length || 1,
    selectedID: input.selectedID,
    centerGroups: ["global"],
  })
  if (!scene.nodes.length) {
    return {
      rows: [],
      cells: [] as AsciiGraphCell[][],
      nodeCells: {} as Record<string, { x: number; y: number }>,
      scene,
      selectedID: undefined,
      legend: [],
      labels: [],
      minimap: [],
      edgeLabels: [],
      focusLines: [],
      relationRows: [],
      isolatedRows: isolatedFacts.slice(0, width < 44 ? 3 : 5).map((fact) => `○ ${memoryPreviewText(fact.text, 34)}`),
      emptyState: materializedFacts.length ? "disconnected" : legacyDerivedFacts > 0 ? "legacy-only" : "empty",
      stats: `connected 0 · ${input.connectedOnly ? "hidden isolates" : "isolated"} ${isolatedFacts.length} · visible 0/${materializedFacts.length}`,
      status: `${materializedFacts.length}/${graphEligibleFacts.length} materialized · ${legacyDerivedFacts} legacy-derived · ${filteredFacts} filtered · ${filteredLinks} links filtered · 0/${graphLinks.length} links`,
      transform: null,
    }
  }
  const visibleIDs = new Set(scene.nodes.map((node) => node.id))
  const facts = materializedFacts.filter((fact) => visibleIDs.has(fact.id))
  const factByID = new Map(facts.map((fact) => [fact.id, fact]))
  const explicitLinks = scene.edges
  const connectedIDs = new Set(explicitLinks.flatMap((link) => [link.from, link.to]))
  const focus = scene.nodes.find((node) => node.id === input.selectedID)
    ?? scene.nodes.toSorted((a, b) => b.degree - a.degree || (factByID.get(a.id)?.retrievalPriority ?? 99) - (factByID.get(b.id)?.retrievalPriority ?? 99) || a.id.localeCompare(b.id))[0]
  const frame = renderAsciiGraph(scene, {
    width,
    height,
    marker: "braille",
    selectedID: focus?.id,
    labelMode: "none",
    labelMaxLength: width < 44 ? 16 : 22,
    viewport: {
      x: input.viewport?.x,
      y: input.viewport?.y,
      zoom: Math.max(0.4, Math.min(4, input.viewport?.zoom ?? input.zoom ?? 1)),
    },
  })
  const minimap = renderAsciiGraph(scene, {
    width: width < 44 ? 10 : 16,
    height: width < 44 ? 3 : 4,
    marker: "braille",
    selectedID: focus?.id,
    labelMode: "none",
  })
  const visibleCategoryIDs = new Set(facts.flatMap((fact) => fact.categoryIDs))
  const categories = input.categories.filter((category) => category.count > 0 && visibleCategoryIDs.has(category.id))
  const visibleCategoryCounts = new Map(categories.map((category) => [category.id, facts.filter((fact) => fact.categoryIDs.includes(category.id)).length]))
  const factLabel = (id: string, max = 26) => memoryPreviewText(factByID.get(id)?.text ?? id, max)
  return {
    rows: frame.rows,
    cells: frame.cells,
    nodeCells: frame.nodeCells,
    scene,
    selectedID: focus?.id,
    legend: categories.slice(0, width < 44 ? 3 : 5).map((category) => `● ${category.label} ${visibleCategoryCounts.get(category.id) ?? 0}`),
    labels: facts.slice(0, width < 44 ? 3 : 5).map((fact) => `● ${connectedIDs.has(fact.id) ? "connected" : "isolated"} · ${memoryGraphMiniMapLabel(fact, 36)}`),
    minimap: minimap.rows,
    edgeLabels: explicitLinks.slice(0, width < 44 ? 2 : 4).map((link) => `● --${link.kind}--> ●`),
    focusLines: focus ? [
      `focus ● degree ${focus.degree} · ${factByID.get(focus.id)?.scope ?? "project"}`,
      memoryPreviewText(factByID.get(focus.id)?.text, width < 44 ? 36 : 48),
    ] : [],
    relationRows: explicitLinks.length
      ? explicitLinks.slice(0, width < 44 ? 3 : 5).map((link) => `● ${factLabel(link.from, 18)} --${link.kind}--> ● ${factLabel(link.to, 18)}`)
      : [],
    isolatedRows: isolatedFacts.slice(0, width < 44 ? 3 : 5).map((fact) => `○ ${memoryPreviewText(fact.text, 34)}`),
    emptyState: "materialized",
    stats: `connected ${connectedIDs.size} · ${input.connectedOnly ? "hidden isolates" : "isolated"} ${isolatedFacts.length} · visible ${facts.length}/${materializedFacts.length}`,
    status: `${materializedFacts.length}/${graphEligibleFacts.length} materialized · ${legacyDerivedFacts} legacy-derived · ${filteredFacts} filtered · ${filteredLinks} links filtered · ${facts.length}/${materializedFacts.length} visible · ${explicitLinks.length}/${graphLinks.length} links · ${categories.length} categories`,
    transform: frame.transform,
  }
}

function memoryGraphMiniMapLabel(fact: MemoryGraphMiniFact, max: number) {
  return memoryPreviewText(fact.text, max)
}

type MemoryGraphWorkspaceRef = Pick<MemoryWorkspace, "id" | "root" | "displayName">

export function memoryGraphFactProjectLabels(input: {
  fact: Pick<MemoryGraphFactView, "scope" | "ownerWorkspaceIDs">
  workspaces: MemoryGraphWorkspaceRef[]
  activeRoot: string
  activeLabel: string
}) {
  if (input.fact.scope === "global") return ["Global memory"]
  const owners = input.fact.ownerWorkspaceIDs ?? []
  const labels = owners.flatMap((owner) => {
    const normalized = comparableRoot(owner)
    const workspace = input.workspaces.find((item) => item.id === owner || comparableRoot(item.root) === normalized)
    if (workspace) return [workspace.displayName]
    if (normalized === comparableRoot(input.activeRoot)) return [input.activeLabel]
    const label = normalized.split(/[\\/]/).filter(Boolean).at(-1)
    return label ? [label] : []
  })
  if (labels.length) return [...new Set(labels)]
  if (input.fact.scope === "workspace") return [input.activeLabel]
  return [input.activeLabel]
}

export function memoryGraphSearchMatches(input: {
  facts: MemoryGraphFactView[]
  query: string
  projectLabel: (fact: MemoryGraphFactView) => string
  limit?: number
}) {
  const terms = input.query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return []
  return input.facts
    .filter((fact) => {
      const searchable = [fact.text, fact.normalizedSummary, fact.scope, fact.categoryIDs.join(" "), input.projectLabel(fact)].join(" ").toLowerCase()
      return terms.every((term) => searchable.includes(term))
    })
    .toSorted((a, b) => Number(b.materialized) - Number(a.materialized) || b.confidence - a.confidence || b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, input.limit ?? 8)
}

export function MemoryGraphCanvasRows(props: {
  cells: AsciiGraphCell[][]
  categories: MemoryGraphMiniCategory[]
}) {
  const { theme } = useTheme()
  const categoryIndex = createMemo(() => new Map(props.categories.map((category, index) => [category.id, index])))
  const color = (cell: Omit<AsciiGraphCell, "char">) => {
    if (cell.kind === "selected") return theme.primary
    if (cell.kind === "conflict") return theme.warning
    if (cell.kind === "edge") return theme.borderActive
    if (cell.kind === "label") return theme.text
    if (cell.kind === "node") return memoryGraphNodeColor(theme, categoryIndex().get(cell.group ?? "") ?? 0)
    return theme.textMuted
  }
  return (
    <For each={props.cells}>
      {(row) => (
        <text wrapMode="none" selectable={false}>
          <For each={asciiGraphRuns(row)}>
            {(run) => <span style={{ fg: color(run) }}>{run.text}</span>}
          </For>
        </text>
      )}
    </For>
  )
}

function toastInput(variant: "info" | "success" | "warning" | "error", message: string) {
  return { variant, message, duration: 2200 }
}

function Panel(props: {
  title?: string
  children: any
  width?: number | `${number}%` | "auto"
  height?: number | `${number}%`
  grow?: boolean
}) {
  const { theme } = useTheme()
  return (
    <box
      flexDirection="column"
      width={props.width}
      height={props.height}
      flexGrow={props.grow ? 1 : 0}
      minWidth={0}
      minHeight={0}
      overflow="hidden"
      borderStyle="single"
      borderColor={theme.border}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={1}
      paddingBottom={1}
      gap={1}
    >
      <Show when={props.title}>
        <text fg={theme.primary} wrapMode="none">
          {props.title}
        </text>
      </Show>
      {props.children}
    </box>
  )
}

function Header(props: { root: string; tab: MemoryTab; narrow: boolean; live: boolean; pending: number; onReview: () => void }) {
  const { theme } = useTheme()
  const tab = () => TABS.find((item) => item.id === props.tab)?.label ?? "Memory"
  const status = () => `MendCode · ${tab()} · SSE ${props.live ? "live" : "waiting"}`
  const shortcuts = props.tab === "graph"
    ? "1-4 tabs · Enter map · ←→ tabs · V review · esc"
    : "1-4 tabs · ←→/hl tabs · ↑↓/jk select · V review · esc"
  return (
    <Switch>
      <Match when={props.narrow}>
        <box flexDirection="column" height={3} overflow="hidden">
          <text fg={theme.text} wrapMode="none">
            Memory
          </text>
          <text fg={theme.textMuted} wrapMode="none">
            {short(status(), 72)}
          </text>
          <text fg={theme.textMuted} wrapMode="none">
            {short(`${shortcuts} · Review pending (${props.pending})`, 72)}
          </text>
        </box>
      </Match>
      <Match when={!props.narrow}>
        <box flexDirection="row" justifyContent="space-between" height={2} overflow="hidden">
          <box flexDirection="column" height={2} overflow="hidden">
            <text fg={theme.text} wrapMode="none">
              Memory
            </text>
            <text fg={theme.textMuted} wrapMode="none">
              {status()} · {shortcuts}
            </text>
          </box>
          <box flexDirection="column" alignItems="flex-end" height={2} overflow="hidden">
            <text fg={theme.textMuted} wrapMode="none">
              {short(props.root, 52)}
            </text>
            <text fg={props.pending ? theme.warning : theme.textMuted} wrapMode="none" onMouseUp={props.onReview}>
              Review pending ({props.pending}) · events refresh automatically
            </text>
          </box>
        </box>
      </Match>
    </Switch>
  )
}

function MetricRows(props: { items: Array<{ label: string; value: string; detail?: string }>; width: number; dense?: boolean }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="column" gap={props.dense ? 0 : 1}>
      <For each={props.items}>
        {(item) => {
          const line = props.dense
            ? `${item.value} ${item.label}${item.detail ? ` · ${item.detail}` : ""}`
            : `${item.label}: ${item.value}${item.detail ? ` · ${item.detail}` : ""}`
          return (
            <box height={1} overflow="hidden">
              <text fg={theme.text} wrapMode="none">
                {short(line, props.width)}
              </text>
            </box>
          )
        }}
      </For>
    </box>
  )
}

function TabBar(props: { tab: MemoryTab; width: number; onSelect: (tab: MemoryTab) => void }) {
  const { theme } = useTheme()
  const presentation = createMemo(() => memoryTabPresentation({ width: props.width, active: props.tab }))
  const cellWidths = createMemo(() => memoryTabCellWidths({ width: props.width, labels: presentation().labels, gap: presentation().gap }))
  return (
    <box flexDirection="row" height={1} overflow="hidden" gap={presentation().gap}>
      <For each={TABS}>
        {(tab, index) => (
          <box width={cellWidths()[index()] ?? 8} overflow="hidden" onMouseUp={() => props.onSelect(tab.id)}>
            <text
              fg={props.tab === tab.id ? theme.success : theme.textMuted}
              wrapMode="none"
            >
              {short(presentation().labels[index()] ?? `${index() + 1}`, cellWidths()[index()] ?? 8)}
            </text>
          </box>
        )}
      </For>
    </box>
  )
}

function GraphCommandBar(props: { width: number; focused: boolean }) {
  const { theme } = useTheme()
  const hints = createMemo(() => memoryGraphCommandHints(props.width))
  return (
    <box height={1} flexShrink={0} overflow="hidden">
      <Show when={props.focused} fallback={<text wrapMode="none"><span style={{ fg: theme.primary }}>Enter/Click</span><span style={{ fg: theme.textMuted }}> explore map · </span><span style={{ fg: theme.primary }}>←→</span><span style={{ fg: theme.textMuted }}> tabs · </span><span style={{ fg: theme.primary }}>P</span><span style={{ fg: theme.textMuted }}> scope · </span><span style={{ fg: theme.primary }}>/</span><span style={{ fg: theme.textMuted }}> find</span></text>}>
        <text wrapMode="none">
          <For each={hints()}>
            {(hint, index) => (
              <>
                <Show when={index() > 0}><span style={{ fg: theme.textMuted }}> · </span></Show>
                <span style={{ fg: theme.primary }}>{hint.key}</span>
                <span style={{ fg: theme.textMuted }}> {hint.label}</span>
              </>
            )}
          </For>
        </text>
      </Show>
    </box>
  )
}

function Sidebar(props: {
  data: MemoryOverview
  currentRoot: string
  activeRoot: string
  selectedWorkspaceID: string | null
  scope: MemoryScopeFilter
  width: number
  height?: number | `${number}%`
  onSelectWorkspace: (id: string | null) => void
  onScope: (scope: MemoryScopeFilter) => void
}) {
  const { theme } = useTheme()
  const workspaces = () => memorySidebarProjectWorkspaces({
    currentRoot: props.currentRoot,
    workspaces: props.data.workspaces?.activeWorkspaces ?? [],
  })
  const pathLabel = (root: string) => Locale.truncateMiddle(root, Math.max(12, props.width - 4))
  const scopeMark = (scope: MemoryScopeFilter) => props.scope === scope ? "[x]" : "[ ]"
  return (
    <Panel title="Browse memories" width={props.width} height={props.height}>
      <box flexDirection="column" minHeight={0} flexGrow={1} overflow="hidden" gap={1}>
        <box height={2} overflow="hidden" onMouseUp={() => {
          props.onSelectWorkspace(null)
          props.onScope("current")
        }}>
          <text fg={props.scope === "current" ? theme.success : theme.text} wrapMode="none">
            {scopeMark("current")} This project
          </text>
          <text fg={theme.textMuted} wrapMode="none">
            {short(`${props.data.projectEntries.length} memories · ${pathLabel(props.currentRoot)}`, props.width - 4)}
          </text>
        </box>

        <box height={2} overflow="hidden" onMouseUp={() => props.onScope("global")}>
          <text fg={props.scope === "global" ? theme.success : theme.text} wrapMode="none">
            {scopeMark("global")} Shared memory
          </text>
          <text fg={theme.textMuted} wrapMode="none">
            {short(`${props.data.globalEntries.length} memories · available everywhere`, props.width - 4)}
          </text>
        </box>

        <box height={2} overflow="hidden" onMouseUp={() => props.onScope("all")}>
          <text fg={props.scope === "all" ? theme.success : theme.text} wrapMode="none">
            {scopeMark("all")} All projects
          </text>
          <text fg={theme.textMuted} wrapMode="none">
            Search memories across every project
          </text>
        </box>

        <text fg={theme.primary} wrapMode="none">
          Projects
        </text>
        <text fg={theme.textMuted} wrapMode="none">
          Click a project to focus its memories
        </text>
        <Show
          when={workspaces().length > 0}
          fallback={<text fg={theme.textMuted}>No other project memories yet.</text>}
        >
          <scrollbox
            flexGrow={1}
            minHeight={0}
            horizontalScrollbarOptions={{ visible: false }}
            verticalScrollbarOptions={{
              visible: workspaces().length > 5,
              trackOptions: {
                backgroundColor: theme.backgroundPanel,
                foregroundColor: theme.border,
              },
            }}
          >
            <box flexDirection="column" gap={1} overflow="hidden">
              <For each={workspaces()}>
                {(workspace) => (
                  <box height={2} overflow="hidden" onMouseUp={() => {
                    props.onSelectWorkspace(workspace.id)
                    props.onScope("current")
                  }}>
                    <text fg={props.selectedWorkspaceID === workspace.id ? theme.success : theme.text} wrapMode="none">
                      {props.selectedWorkspaceID === workspace.id ? ">" : " "} {short(workspace.displayName, props.width - 6)}
                    </text>
                    <text fg={theme.textMuted} wrapMode="none">
                      {short(pathLabel(workspace.root), props.width - 4)}
                    </text>
                  </box>
                )}
              </For>
            </box>
          </scrollbox>
        </Show>
      </box>
    </Panel>
  )
}

type MemoryGraphFrame = ReturnType<typeof memoryGraphMiniMap>

function MemoryGraphExplorer(props: {
  data: MemoryGraphOverview
  frame: MemoryGraphFrame
  width: number
  height: number
  canvasWidth: number
  selectedID?: string
  activeRoot: string
  activeLabel: string
  projectPosition: string
  workspaces: MemoryGraphWorkspaceRef[]
  showAll: boolean
  zoom: number
  focused: boolean
  searching: boolean
  query: string
  searchMatches: MemoryGraphFactView[]
  onSelect: (id: string) => void
  onFocus: () => void
  onEmergencyExit: (interrupt: boolean) => void
  onPan: (cells: { x: number; y: number }) => void
  onPreviousProject: () => void
  onNextProject: () => void
  onChooseProject: () => void
  onToggleAll: () => void
  onBeginSearch: () => void
  onRefresh: () => void
}) {
  const { theme } = useTheme()
  const layout = createMemo(() => memoryGraphExplorerLayout({ width: props.width, height: props.height }))
  const roomy = () => layout().roomy
  const inspectorWidth = () => layout().inspectorWidth
  const health = createMemo(() => props.data.graphHealth)
  const healthTone = createMemo(() => health().graphHealth === "connected" ? theme.success : health().graphHealth === "empty" ? theme.textMuted : theme.warning)
  const healthLine = createMemo(() => `${health().graphHealth} · ${props.frame.stats} · ${props.data.links.length} persisted links`)
  const selectedFact = createMemo(() => props.data.facts.find((fact) => fact.id === props.selectedID))
  const selectedLinks = createMemo(() => props.data.links.flatMap((link) => {
    if (link.from !== props.selectedID && link.to !== props.selectedID) return []
    const outbound = link.from === props.selectedID
    const otherID = outbound ? link.to : link.from
    const fact = props.data.facts.find((candidate) => candidate.id === otherID)
    return fact ? [{ link, fact, outbound }] : []
  }))
  const categoryLabel = (id: string) => props.data.categories.find((category) => category.id === id)?.label ?? id
  const projectLabels = (fact: MemoryGraphFactView) => memoryGraphFactProjectLabels({
    fact,
    workspaces: props.workspaces,
    activeRoot: props.activeRoot,
    activeLabel: props.activeLabel,
  })
  let canvasBox: BoxRenderable | undefined
  let dragPoint: { x: number; y: number } | undefined

  function mouse(event: MouseEvent) {
    if (!canvasBox) return
    if (event.type === "scroll" && event.scroll) {
      props.onFocus()
      const direction = memoryGraphPanDirection(event.scroll.direction)
      if (!direction) return
      const delta = Math.max(1, Math.min(4, Math.abs(event.scroll.delta || 1)))
      props.onPan({ x: direction.x * delta * 3, y: direction.y * delta * 2 })
      event.preventDefault()
      event.stopPropagation()
      return
    }
    if (event.button !== MouseButton.LEFT) return
    if (event.type === "drag") {
      props.onFocus()
      const previous = dragPoint ?? { x: event.x, y: event.y }
      const delta = { x: event.x - previous.x, y: event.y - previous.y }
      dragPoint = { x: event.x, y: event.y }
      if (delta.x || delta.y) props.onPan({ x: -delta.x, y: -delta.y })
      event.preventDefault()
      event.stopPropagation()
      return
    }
    if (event.type === "up" || event.type === "drag-end") {
      dragPoint = undefined
      return
    }
    if (event.type !== "down") return
    canvasBox.focus()
    props.onFocus()
    dragPoint = { x: event.x, y: event.y }
    const x = event.x - canvasBox.x
    const y = event.y - canvasBox.y
    const hit = Object.entries(props.frame.nodeCells)
      .map(([id, point]) => ({ id, distance: Math.hypot(point.x - x, point.y - y) }))
      .filter((item) => item.distance <= 2)
      .toSorted((a, b) => a.distance - b.distance)[0]
    if (hit) props.onSelect(hit.id)
    event.preventDefault()
    event.stopPropagation()
  }

  createEffect(() => {
    const focused = props.focused
    if (!canvasBox || canvasBox.isDestroyed) return
    if (focused && !canvasBox.focused) canvasBox.focus()
    if (!focused && canvasBox.focused) canvasBox.blur()
  })

  const Inspector = () => (
    <box flexDirection="column" width={inspectorWidth()} minWidth={0} minHeight={0} overflow="hidden" gap={1}>
      <Show
        when={!props.searching}
        fallback={
          <box flexDirection="column" minHeight={0} overflow="hidden" gap={1}>
            <text fg={theme.primary} wrapMode="none">Find graph memories</text>
            <text fg={theme.success} wrapMode="none">{props.query || "Type to search…"}</text>
            <text fg={theme.textMuted} wrapMode="none">{props.searchMatches.length} matches · enter select · esc close</text>
            <Show when={props.searchMatches.length} fallback={<text fg={theme.textMuted}>No materialized memories match this query.</text>}>
              <For each={props.searchMatches.slice(0, roomy() ? 8 : 4)}>
                {(fact, index) => (
                  <box flexDirection="column" height={2} overflow="hidden" onMouseUp={() => props.onSelect(fact.id)}>
                    <text fg={index() === 0 ? theme.success : theme.text} wrapMode="none">
                      {short(`${index() === 0 ? "›" : " "} ${memoryPreviewText(fact.text, inspectorWidth() - 4)}`, inspectorWidth())}
                    </text>
                    <text fg={theme.textMuted} wrapMode="none">
                      {short(`${projectLabels(fact).join(", ")} · ${fact.categoryIDs.map(categoryLabel).join(", ") || "Uncategorized"}`, inspectorWidth())}
                    </text>
                  </box>
                )}
              </For>
            </Show>
          </box>
        }
      >
        <Show when={selectedFact()} fallback={<text fg={theme.textMuted}>Select a node to inspect its memory.</text>}>
          {(fact) => (
            <scrollbox
              minHeight={0}
              flexGrow={1}
              horizontalScrollbarOptions={{ visible: false }}
              verticalScrollbarOptions={{ visible: true, trackOptions: { backgroundColor: theme.backgroundPanel, foregroundColor: theme.border } }}
            >
              <box flexDirection="column" minHeight={0} gap={1} paddingRight={1}>
                <box flexDirection="column">
                  <text fg={theme.primary} wrapMode="none">Selected memory</text>
                  <text fg={theme.text} wrapMode="word">{fact().text}</text>
                </box>
                <box flexDirection="column">
                  <text fg={theme.textMuted} wrapMode="none">Project</text>
                  <text fg={theme.success} wrapMode="none">{short(projectLabels(fact()).join(", "), inspectorWidth() - 2)}</text>
                  <text fg={theme.textMuted} wrapMode="none">
                    {short(fact().scope === "global" ? "Shared across project roots" : `graph root · ${props.activeRoot}`, inspectorWidth() - 2)}
                  </text>
                </box>
                <box flexDirection="column">
                  <text fg={theme.textMuted} wrapMode="none">Metadata</text>
                  <text fg={theme.text} wrapMode="none">
                    {short(`${fact().scope} · ${fact().materialized ? "materialized" : "legacy"} · ${fact().sensitivity} sensitivity`, inspectorWidth() - 2)}
                  </text>
                  <text fg={theme.textMuted} wrapMode="none">
                    {short(`${Math.round(fact().confidence * 100)}% confidence · ${Math.round(fact().changeRisk * 100)}% change risk · priority ${fact().retrievalPriority}`, inspectorWidth() - 2)}
                  </text>
                  <text fg={theme.textMuted} wrapMode="none">{short(fact().categoryIDs.map(categoryLabel).join(" · ") || "Uncategorized", inspectorWidth() - 2)}</text>
                </box>
                <box flexDirection="column">
                  <text fg={theme.primary} wrapMode="none">Relationships · {selectedLinks().length}</text>
                  <Show when={selectedLinks().length} fallback={<text fg={theme.textMuted}>This memory has no persisted relationships.</text>}>
                    <For each={selectedLinks().slice(0, 8)}>
                      {(item) => (
                        <box flexDirection="column" height={2} overflow="hidden" onMouseUp={() => props.onSelect(item.fact.id)}>
                          <text fg={item.link.kind === "conflicts" ? theme.warning : theme.text} wrapMode="none">
                            {short(`${item.outbound ? "→" : "←"} ${item.link.kind} · ${memoryPreviewText(item.fact.text, inspectorWidth() - 16)}`, inspectorWidth() - 2)}
                          </text>
                          <text fg={theme.textMuted} wrapMode="none">
                            {short(projectLabels(item.fact).join(", "), inspectorWidth() - 2)}
                          </text>
                        </box>
                      )}
                    </For>
                  </Show>
                </box>
                <Show when={fact().provenance.length}>
                  <box flexDirection="column">
                    <text fg={theme.textMuted} wrapMode="none">Provenance</text>
                    <For each={fact().provenance.slice(0, 3)}>
                      {(source) => <text fg={theme.textMuted} wrapMode="none">{short(source, inspectorWidth() - 2)}</text>}
                    </For>
                  </box>
                </Show>
              </box>
            </scrollbox>
          )}
        </Show>
      </Show>
    </box>
  )

  return (
    <box flexDirection="column" height={props.height} minHeight={0} overflow="hidden" gap={1}>
      <box flexDirection="row" height={2} flexShrink={0} justifyContent="space-between" overflow="hidden">
        <box flexDirection="column" overflow="hidden">
          <box flexDirection="row" overflow="hidden">
            <text fg={theme.textMuted}>Scope </text>
            <text fg={theme.primary} onMouseUp={props.onPreviousProject}>‹ </text>
            <text fg={theme.success} wrapMode="none" onMouseUp={props.onChooseProject}>{short(props.activeLabel, 28)}</text>
            <text fg={theme.primary} onMouseUp={props.onNextProject}> ›</text>
            <text fg={theme.textMuted} wrapMode="none"> · {props.projectPosition}</text>
          </box>
          <text fg={theme.textMuted} wrapMode="none">{short(props.activeLabel === "All projects" ? `${props.data.workspaces.length} registered projects · union view` : props.activeRoot, Math.max(24, props.width - 74))}</text>
        </box>
        <box flexDirection="column" alignItems="flex-end" overflow="hidden">
          <text fg={props.showAll ? theme.success : theme.text} wrapMode="none" onMouseUp={props.onToggleAll}>
            {props.showAll ? "Including isolates" : "Connected network"} · {props.frame.scene.nodes.length}/{props.data.materializedFactCount} sampled
          </text>
          <box flexDirection="row" overflow="hidden">
            <text fg={theme.textMuted} wrapMode="none">zoom {props.zoom.toFixed(1)}x · {props.data.legacyDerivedFactCount} legacy outside graph · </text>
            <text fg={theme.primary} wrapMode="none" onMouseUp={props.onBeginSearch}>find</text>
            <text fg={theme.textMuted}> · </text>
            <text fg={theme.primary} wrapMode="none" onMouseUp={props.onRefresh}>refresh</text>
          </box>
        </box>
      </box>

      <Show when={props.searching}>
        <box height={1} flexShrink={0} overflow="hidden">
          <text fg={theme.success} wrapMode="none">find: {props.query || "▎"}</text>
          <text fg={theme.textMuted} wrapMode="none"> · search text, project, scope, or category</text>
        </box>
      </Show>

      <box flexDirection={roomy() ? "row" : "column"} minHeight={0} flexGrow={1} overflow="hidden" gap={1}>
        <box flexDirection="column" minWidth={0} minHeight={0} flexGrow={1} overflow="hidden">
          <Show
            when={props.frame.rows.length}
            fallback={
              <box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center" overflow="hidden" gap={1}>
                <text fg={healthTone()} wrapMode="none">
                  {props.frame.emptyState === "legacy-only" ? "Legacy-derived memories exist, but no graph facts are materialized." : "No persisted relationships in this scope yet."}
                </text>
                <text fg={theme.primary} wrapMode="none">Press i to include isolates, or use memory_graph link to connect facts.</text>
              </box>
            }
          >
            <box
              ref={(value: BoxRenderable) => (canvasBox = value)}
              flexDirection="column"
              width={props.canvasWidth + 2}
              height={props.frame.rows.length + 2}
              minWidth={0}
              flexShrink={0}
              borderStyle="single"
              borderColor={props.focused ? theme.primary : theme.border}
              focusable={true}
              overflow="hidden"
              onMouse={mouse}
              onKeyDown={(event) => {
                if (props.searching) return
                if (event.name !== "escape" && !(event.ctrl && event.name === "c")) return
                event.preventDefault()
                event.stopPropagation()
                props.onEmergencyExit(event.ctrl && event.name === "c")
              }}
            >
              <MemoryGraphCanvasRows cells={props.frame.cells} categories={props.data.categories} />
            </box>
          </Show>
          <text fg={healthTone()} wrapMode="none">{short(healthLine(), props.canvasWidth)}</text>
          <Show when={roomy()}>
            <Show when={props.frame.legend.length} fallback={<text fg={theme.textMuted} wrapMode="none">No active graph categories</text>}>
              <text wrapMode="none">
                <For each={props.frame.legend}>
                  {(label, index) => (
                    <>
                      <Show when={index() > 0}><span style={{ fg: theme.textMuted }}> · </span></Show>
                      <span style={{ fg: memoryGraphNodeColor(theme, index()) }}>{label}</span>
                    </>
                  )}
                </For>
              </text>
            </Show>
          </Show>
          <Show when={selectedFact()}>
            {(fact) => (
              <text fg={theme.textMuted} wrapMode="none">
                {short(`● ${projectLabels(fact()).join(", ")} · ${fact().categoryIDs.map(categoryLabel).join(", ") || "Uncategorized"} · ${memoryPreviewText(fact().text, props.canvasWidth - 20)}`, props.canvasWidth)}
              </text>
            )}
          </Show>
        </box>

        <Show when={roomy()} fallback={<box height={Math.max(10, Math.floor(props.height * 0.38))}><Inspector /></box>}>
          <box width={inspectorWidth()} minHeight={0} paddingLeft={1} border={["left"]} borderColor={theme.border}>
            <Inspector />
          </box>
        </Show>
      </box>

      <GraphCommandBar width={props.width} focused={props.focused} />
    </box>
  )
}

function memoryScopeTitle(scope: MemoryScopeFilter, currentProject: string) {
  if (scope === "global") return "Global memories"
  if (scope === "all") return "All project memories"
  return `${currentProject} memories`
}

function EntryRows(props: {
  entries: MemoryListEntry[]
  selectedIndex: number
  width: number
  limit?: number
  onSelect: (index: number) => void
  showProject?: boolean
}) {
  const { theme } = useTheme()
  return (
    <Show
      when={props.entries.length > 0}
      fallback={<text fg={theme.textMuted}>No saved memory in this scope.</text>}
    >
      <box flexDirection="column" gap={1} overflow="hidden">
        <For each={memoryListWindow(props.entries, props.selectedIndex, props.limit ?? ENTRY_ROW_LIMIT)}>
          {(row) => {
            const item = () => row.item
            const entry = () => item().entry
            const selected = () => props.selectedIndex === row.index
            return (
              <box height={2} overflow="hidden" onMouseUp={() => props.onSelect(row.index)}>
                <box flexDirection="row" justifyContent="space-between" height={1} overflow="hidden">
                  <text fg={selected() ? theme.success : entry().scope === "global" ? theme.primary : theme.text} wrapMode="none">
                    {short(`${props.showProject ? `${item().projectLabel} · ` : ""}${entry().scope} · ${memoryOriginLabel(entry().source)} · ${(entry().categoryIDs ?? ["uncategorized"])[0] ?? "uncategorized"}`, Math.max(16, props.width - 18))}
                  </text>
                  <text fg={theme.textMuted} wrapMode="none">
                    {formatDate(entry().updatedAt)}
                  </text>
                </box>
                <text fg={selected() ? theme.text : theme.textMuted} wrapMode="none">
                  {memoryPreviewText(entry().text, props.width)}
                </text>
              </box>
            )
          }}
        </For>
      </box>
    </Show>
  )
}

function PolicyRows(props: {
  data: MemoryOverview
  selectedIndex: number
  width: number
  policyScope: MemoryPolicyScope
  limit?: number
  onSelect: (index: number) => void
}) {
  const { theme } = useTheme()
  const rows = () => props.data.categories.map((category) => ({ category, policy: props.data.policies[category.id]! }))
  return (
    <box flexDirection="column" gap={1} overflow="hidden">
      <box height={1} overflow="hidden">
        <text fg={theme.textMuted} wrapMode="none">
          {short(`editing ${props.policyScope} overrides · p write · o prompt · s scope · x reset`, props.width)}
        </text>
      </box>
      <For each={memoryListWindow(rows(), props.selectedIndex, props.limit ?? POLICY_ROW_LIMIT)}>
        {(windowRow) => {
          const row = () => windowRow.item
          const selected = () => props.selectedIndex === windowRow.index
          const layer = () => props.data.policyLayers?.[row().category.id]
          return (
            <box height={3} overflow="hidden" onMouseUp={() => props.onSelect(windowRow.index)}>
              <box flexDirection="row" justifyContent="space-between" height={1} overflow="hidden">
                <text fg={selected() ? theme.success : theme.text} wrapMode="none">
                  {short(row().category.label, Math.max(14, props.width - 30))}
                </text>
                <text fg={row().policy.promptEnabled ? theme.primary : theme.textMuted} wrapMode="none">
                  {row().policy.promptEnabled ? "prompt:on" : "prompt:off"}
                </text>
              </box>
              <text fg={theme.textMuted} wrapMode="none">
                {short(`effective ${row().policy.writePolicy} · priority ${row().policy.promptPriority} · ${row().category.description}`, props.width)}
              </text>
              <text fg={theme.textMuted} wrapMode="none">
                {short(layer() ? `default ${layer()!.default.writePolicy} · global ${layer()!.global.writePolicy}${layer()!.globalOverridden ? "*" : ""} · project ${layer()!.project.writePolicy}${layer()!.projectOverridden ? "*" : ""}` : "policy inheritance unavailable", props.width)}
              </text>
            </box>
          )
        }}
      </For>
    </box>
  )
}

function dreamWindowLabel(window: DreamScheduleWindow | null | undefined) {
  if (!window || !window.enabled) return "not scheduled"
  const zone = window.timezone ? ` ${window.timezone}` : ""
  if (window.start === window.end) return `fixed ${window.start}${zone}`
  return `window ${window.start}-${window.end}${zone}`
}

function dreamConsolidationLabel(policy: MemoryOverview["config"]["dreamConsolidationPolicy"]) {
  if (policy === "auto-consolidate") return "auto-consolidate · safe decisions only"
  if (policy === "preview") return "preview · proposals remain pending"
  return "disabled · pending proposals stay in the review queue"
}

function dreamRoleLabel(role: MemoryOverview["dreamRole"]) {
  if (role.ok) return `${role.roleName} · ${role.providerID}/${role.modelID}`
  return `${role.reason} · local fallback available`
}

function memoryOriginLabel(source: string | null | undefined) {
  return source === "memory-dream" ? "Dream" : source || "manual"
}

function dreamRunStatusLabel(status: DreamRunDetailView["run"]["status"]) {
  if (status === "completed") return "completed"
  if (status === "running") return "running"
  if (status === "failed") return "failed"
  if (status === "canceled") return "canceled"
  if (status === "missed") return "missed"
  return status
}

function dreamRunStatusTone(status: DreamRunDetailView["run"]["status"], theme: ReturnType<typeof useTheme>["theme"]) {
  if (status === "completed") return theme.success
  if (status === "running") return theme.primary
  if (status === "failed") return theme.error
  if (status === "canceled" || status === "missed") return theme.warning
  return theme.text
}

function durationLabel(start: string | null | undefined, end: string | null | undefined) {
  if (!start || !end) return ""
  const startDate = new Date(start)
  const endDate = new Date(end)
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return ""
  return Locale.duration(endDate.getTime() - startDate.getTime())
}

function dreamRunProposalCount(detail: DreamRunDetailView) {
  return detail.run.proposals.length || detail.proposals.length
}

function dreamSkippedDecisionCount(detail: Pick<DreamRunDetailView, "decisions">) {
  return detail.decisions.filter((decision) => decision.status === "skipped-policy" || decision.status === "skipped-duplicate").length
}

function dreamDetailSummary(detail: DreamRunDetailView | null | undefined) {
  if (!detail) return "No Dream run selected"
  const event = detail.events.at(-1)?.message
  const evidence = detail.evidence.length ? `${detail.evidence.length} evidence refs` : "no evidence"
  const proposals = `${dreamRunProposalCount(detail)} proposals`
  const graph = detail.graphProposals.length ? `${detail.graphProposals.length} graph links` : "no graph links"
  return [event, evidence, proposals, graph].filter(Boolean).join(" · ")
}

type DreamTranscriptDetail = Readonly<{
  run: { status: string; startedAt: string; completedAt: string | null; failureReason: string | null }
  events: ReadonlyArray<{ at: string; status: string; message: string }>
  evidence: ReadonlyArray<{ id: string; sourceType: string; sourcePath: string | null; redacted: boolean }>
  proposals: ReadonlyArray<{ id: string; operation?: string; scope?: string; text?: string }>
  graphProposals: ReadonlyArray<{ id: string; createdAt: string; kind: string; status?: string; confidence: number; reason: string; fromSummary: string; toSummary: string; reviewedAt?: string; linkID?: string; rejectionReason?: string }>
  decisions: ReadonlyArray<{ at: string; status: string; reason: string }>
  safety: { reads: ReadonlyArray<unknown>; skippedSources: ReadonlyArray<string>; failures: ReadonlyArray<string>; redactions: number } | null
}>

export type DreamTranscriptRow = {
  at: string
  tone: "info" | "success" | "warning" | "error"
  label: string
  detail: string
}

export function dreamEvidenceLabel(evidence: { id: string; sourceType: string; sourcePath: string | null; redacted: boolean }) {
  const basename = evidence.sourcePath?.split(/[\\/]+/).filter(Boolean).at(-1)
  const label = evidence.sourceType === "file"
    ? basename ?? "file"
    : evidence.sourceType === "memory"
      ? "saved memory"
      : evidence.sourceType === "proposal"
        ? "pending proposal"
        : basename ?? evidence.sourceType
  return `${evidence.sourceType} · ${label}${evidence.redacted ? " · redacted" : ""}`
}

export function dreamGraphProposalLabel(proposal: { kind: string; status?: string; reason: string; fromSummary: string; toSummary: string }) {
  const status = proposal.status ? `${proposal.status} · ` : ""
  return `${status}${proposal.kind} · ${proposal.reason} · ${memoryPreviewText(proposal.fromSummary, 72)} ↔ ${memoryPreviewText(proposal.toSummary, 72)}`
}

function dreamTranscriptTone(status: string): DreamTranscriptRow["tone"] {
  if (status === "completed" || status === "created-proposal" || status === "auto-applied-proposal" || status === "applied") return "success"
  if (status === "failed") return "error"
  if (status === "skipped-policy" || status === "skipped-duplicate" || status === "canceled" || status === "missed" || status === "rejected") return "warning"
  return "info"
}

export function dreamTranscriptRows(detail: DreamTranscriptDetail | null | undefined): DreamTranscriptRow[] {
  if (!detail) return []
  const syntheticAt = detail.run.completedAt ?? detail.events.at(-1)?.at ?? detail.run.startedAt
  const rows: DreamTranscriptRow[] = [
    ...detail.events.map((event) => ({
      at: event.at,
      tone: dreamTranscriptTone(event.status),
      label: event.status,
      detail: event.message,
    } satisfies DreamTranscriptRow)),
  ]
  if (!rows.length) {
    rows.push({ at: detail.run.startedAt, tone: dreamTranscriptTone(detail.run.status), label: detail.run.status, detail: "Dream run has no event log yet" })
  }
  if (detail.proposals.length) {
    rows.push({
      at: syntheticAt,
      tone: "success",
      label: "memory proposals",
      detail: `${detail.proposals.length} reviewable proposals · ${detail.proposals.slice(0, 2).map((proposal) => proposal.text ?? proposal.id).join(" · ")}`,
    })
  }
  if (detail.graphProposals.length) {
    const pending = detail.graphProposals.filter((proposal) => (proposal.status ?? "pending") === "pending").length
    const applied = detail.graphProposals.filter((proposal) => proposal.status === "applied").length
    const rejected = detail.graphProposals.filter((proposal) => proposal.status === "rejected").length
    rows.push({
      at: syntheticAt,
      tone: "info",
      label: "graph proposals",
      detail: `${pending} pending · ${applied} applied · ${rejected} rejected · ${detail.graphProposals.slice(0, 2).map((proposal) => `${proposal.kind}: ${proposal.reason}`).join(" · ")}`,
    })
    rows.push(...detail.graphProposals.flatMap((proposal) => {
      if (!proposal.reviewedAt || !proposal.status || proposal.status === "pending") return []
      return [{
        at: proposal.reviewedAt,
        tone: dreamTranscriptTone(proposal.status),
        label: proposal.status,
        detail: `graph ${proposal.kind} · ${proposal.reason}${proposal.status === "rejected" && proposal.rejectionReason ? ` · ${proposal.rejectionReason}` : ""}`,
      } satisfies DreamTranscriptRow]
    }))
  }
  if (detail.decisions.length) {
    rows.push(...detail.decisions.map((decision) => ({
      at: decision.at,
      tone: dreamTranscriptTone(decision.status),
      label: decision.status,
      detail: decision.reason,
    } satisfies DreamTranscriptRow)))
  }
  rows.push({
    at: syntheticAt,
    tone: detail.safety?.failures.length ? "error" : detail.safety?.redactions || detail.safety?.skippedSources.length ? "warning" : "info",
    label: "safety",
    detail: `${detail.evidence.length} evidence refs · ${detail.safety?.reads.length ?? detail.evidence.length} reads · ${detail.safety?.redactions ?? 0} redactions · ${detail.safety?.skippedSources.length ?? 0} skipped sources`,
  })
  if (detail.run.failureReason || detail.safety?.failures.length) {
    rows.push({
      at: syntheticAt,
      tone: "error",
      label: "failure",
      detail: detail.safety?.failures.join("; ") || detail.run.failureReason || "Dream failed",
    })
  }
  return rows.toSorted((a, b) => a.at.localeCompare(b.at))
}

function dreamActivityPriority(label: string) {
  if (label === "completed" || label === "failed" || label === "failure") return 4
  if (label === "memory proposals" || label === "graph proposals" || label === "applied" || label === "rejected") return 3
  if (label.startsWith("skipped") || label === "created-proposal") return 2
  if (label === "safety") return 0
  return 1
}

export function dreamLatestActivity(detail: DreamTranscriptDetail | null | undefined) {
  return dreamTranscriptRows(detail)
    .toSorted((a, b) => b.at.localeCompare(a.at) || dreamActivityPriority(b.label) - dreamActivityPriority(a.label))[0] ?? null
}

function dreamTranscriptColor(tone: DreamTranscriptRow["tone"], theme: ReturnType<typeof useTheme>["theme"]) {
  if (tone === "success") return theme.success
  if (tone === "warning") return theme.warning
  if (tone === "error") return theme.error
  return theme.primary
}

function fallbackDreamRunDetail(run: MemoryOverview["dreamRuns"][number]) {
  return {
    run,
    events: [],
    evidence: [],
    proposals: [],
    graphProposals: [],
    decisions: [],
    consolidation: null,
    safety: null,
  } satisfies DreamRunDetailView
}

function dreamToneGlyph(tone: DreamTranscriptRow["tone"]) {
  if (tone === "success") return "✓"
  if (tone === "warning") return "!"
  if (tone === "error") return "×"
  return "•"
}

function dreamItemTone(status: string | null | undefined, theme: ReturnType<typeof useTheme>["theme"]) {
  if (status === "applied" || status === "completed" || status === "created-proposal" || status === "auto-applied-proposal") return theme.success
  if (status === "failed") return theme.error
  if (status === "pending" || status === "rejected" || status?.startsWith("skipped")) return theme.warning
  return theme.text
}

function DreamSection(props: { title: string; count?: number; children: any }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="column" gap={1} minWidth={0}>
      <box flexDirection="row" gap={1} height={1} overflow="hidden">
        <text fg={theme.accent} wrapMode="none">{props.title}</text>
        <Show when={props.count !== undefined}><text fg={theme.textMuted} wrapMode="none">{props.count}</text></Show>
      </box>
      {props.children}
    </box>
  )
}

function DreamRunDetailContent(props: {
  detail: DreamRunDetailView
  width: number
  onApplyGraphProposal?: (runID: string, proposalID: string) => void
  onRejectGraphProposal?: (runID: string, proposalID: string) => void
}) {
  const { theme } = useTheme()
  const detail = () => props.detail
  const activity = createMemo(() => dreamLatestActivity(detail()))
  const timeline = createMemo(() => dreamTranscriptRows(detail()))
  const roomy = () => props.width >= 104
  const primaryWidth = () => roomy() ? Math.max(54, Math.floor(props.width * 0.6)) : props.width - 2
  const secondaryWidth = () => roomy() ? Math.max(36, props.width - primaryWidth() - 4) : props.width - 2
  const proposalCount = () => dreamRunProposalCount(detail())
  const pendingGraph = () => detail().graphProposals.filter((proposal) => (proposal.status ?? "pending") === "pending").length
  const statusTone = () => dreamRunStatusTone(detail().run.status, theme)
  const sourcePermissions = () => detail().run.permissionSnapshot
  const outcome = () => detail().run.failureReason
    ?? (detail().consolidation ? `Consolidated ${detail().consolidation!.pendingBefore} pending items to ${detail().consolidation!.pendingAfter}.` : activity()?.detail)
    ?? "Run completed without a recorded outcome."

  return (
    <scrollbox
      flexGrow={1}
      minHeight={0}
      horizontalScrollbarOptions={{ visible: false }}
      verticalScrollbarOptions={{ visible: true, trackOptions: { backgroundColor: theme.backgroundPanel, foregroundColor: theme.border } }}
    >
      <box flexDirection="column" gap={2} minWidth={0} paddingRight={1}>
        <box flexDirection={props.width >= 72 ? "row" : "column"} justifyContent="space-between" minWidth={0} gap={1}>
          <box flexDirection="column" minWidth={0} flexGrow={1}>
            <text fg={statusTone()} wrapMode="none">
              {dreamToneGlyph(detail().run.status === "completed" ? "success" : detail().run.status === "failed" ? "error" : detail().run.status === "running" ? "info" : "warning")} {dreamRunStatusLabel(detail().run.status)}
            </text>
            <text fg={theme.text} wrapMode="word">{memoryPreviewText(outcome(), Math.max(80, props.width * 3))}</text>
          </box>
          <box flexDirection="column" alignItems={props.width >= 72 ? "flex-end" : "flex-start"} minWidth={0}>
            <text fg={theme.textMuted} wrapMode="none">{formatDate(detail().run.completedAt ?? detail().run.startedAt)} {formatTime(detail().run.completedAt ?? detail().run.startedAt)}{durationLabel(detail().run.startedAt, detail().run.completedAt) ? ` · ${durationLabel(detail().run.startedAt, detail().run.completedAt)}` : ""}</text>
            <text fg={theme.textMuted} wrapMode="none">{short(`${detail().run.source} · ${detail().run.workspaceID ?? "global"}`, 36)}</text>
          </box>
        </box>

        <text wrapMode="none">
          <span style={{ fg: proposalCount() ? theme.success : theme.textMuted }}>{proposalCount()} memory changes</span>
          <span style={{ fg: theme.textMuted }}> · </span>
          <span style={{ fg: pendingGraph() ? theme.warning : detail().graphProposals.length ? theme.success : theme.textMuted }}>{detail().graphProposals.length} graph links</span>
          <span style={{ fg: theme.textMuted }}> · </span>
          <span style={{ fg: detail().evidence.length ? theme.info : theme.textMuted }}>{detail().evidence.length} evidence</span>
          <span style={{ fg: theme.textMuted }}> · </span>
          <span style={{ fg: detail().safety?.failures.length ? theme.error : detail().safety?.redactions ? theme.warning : theme.textMuted }}>{detail().safety?.redactions ?? 0} redactions</span>
        </text>

        <box flexDirection={roomy() ? "row" : "column"} gap={2} minWidth={0} alignItems="flex-start">
          <box flexDirection="column" gap={2} width={primaryWidth()} minWidth={0}>
            <DreamSection title="Timeline" count={timeline().length}>
              <For each={timeline()}>
                {(row) => (
                  <box flexDirection="row" gap={1} minWidth={0}>
                    <text width={9} flexShrink={0} fg={dreamTranscriptColor(row.tone, theme)} wrapMode="none">{dreamToneGlyph(row.tone)} {formatTime(row.at)}</text>
                    <box flexDirection="column" minWidth={0} flexGrow={1}>
                      <text fg={dreamTranscriptColor(row.tone, theme)} wrapMode="none">{short(row.label, Math.max(18, primaryWidth() - 12))}</text>
                      <text fg={theme.textMuted} wrapMode="word">{memoryPreviewText(row.detail, primaryWidth() * 4)}</text>
                    </box>
                  </box>
                )}
              </For>
            </DreamSection>

            <DreamSection title="Memory changes" count={detail().proposals.length}>
              <Show when={detail().proposals.length} fallback={<text fg={theme.textMuted}>No memory proposals were created by this run.</text>}>
                <For each={detail().proposals}>
                  {(proposal) => (
                    <box flexDirection="column" minWidth={0}>
                      <text fg={dreamItemTone(proposal.status, theme)} wrapMode="none">
                        {proposal.status === "applied" ? "✓" : proposal.status === "rejected" ? "×" : "•"} {proposal.status ?? "historical"} · {proposal.operation ?? "create"} · {proposal.scope ?? "memory"}
                      </text>
                      <text fg={theme.text} wrapMode="word">{memoryPreviewText(proposal.text ?? "No proposal text stored.", primaryWidth() * 4)}</text>
                      <text fg={theme.textMuted} wrapMode="word">{memoryPreviewText(`${proposal.id}${proposal.appliedEntryID ? ` · entry ${proposal.appliedEntryID}` : ""}${proposal.resolution || proposal.reason ? ` · ${proposal.resolution ?? proposal.reason}` : ""}`, primaryWidth() * 3)}</text>
                    </box>
                  )}
                </For>
              </Show>
            </DreamSection>

            <DreamSection title="Graph changes" count={detail().graphProposals.length}>
              <Show when={detail().graphProposals.length} fallback={<text fg={theme.textMuted}>No graph relationships were proposed.</text>}>
                <For each={detail().graphProposals}>
                  {(proposal) => (
                    <box flexDirection="column" gap={0} minWidth={0}>
                      <text fg={dreamItemTone(proposal.status ?? "pending", theme)} wrapMode="none">
                        {(proposal.status ?? "pending") === "applied" ? "✓" : proposal.status === "rejected" ? "×" : "!"} {proposal.status ?? "pending"} · {proposal.kind} · {Math.round(proposal.confidence * 100)}%
                      </text>
                      <text fg={theme.text} wrapMode="word">from  {memoryPreviewText(proposal.fromSummary, primaryWidth() * 2)}</text>
                      <text fg={theme.text} wrapMode="word">to    {memoryPreviewText(proposal.toSummary, primaryWidth() * 2)}</text>
                      <text fg={theme.textMuted} wrapMode="word">{memoryPreviewText(`${proposal.reason} · ${proposal.linkID ? `link ${proposal.linkID}` : proposal.id}`, primaryWidth() * 3)}</text>
                      <Show when={(proposal.status ?? "pending") === "pending"}>
                        <box flexDirection="row" gap={2} height={1} overflow="hidden">
                          <text fg={theme.success} wrapMode="none" onMouseUp={() => props.onApplyGraphProposal?.(detail().run.id, proposal.id)}>[apply]</text>
                          <text fg={theme.error} wrapMode="none" onMouseUp={() => props.onRejectGraphProposal?.(detail().run.id, proposal.id)}>[reject]</text>
                        </box>
                      </Show>
                    </box>
                  )}
                </For>
              </Show>
            </DreamSection>
          </box>

          <box flexDirection="column" gap={2} width={secondaryWidth()} minWidth={0}>
            <DreamSection title="Consolidation">
              <Show when={detail().consolidation} fallback={<text fg={theme.textMuted}>No consolidation pass was recorded.</text>}>
                {(consolidation) => (
                  <box flexDirection="column" gap={1} minWidth={0}>
                    <text fg={dreamItemTone(consolidation().status, theme)} wrapMode="none">{consolidation().status === "failed" ? "×" : "✓"} {consolidation().status} · {consolidation().policy}</text>
                    <text fg={theme.text} wrapMode="none">queue  {consolidation().pendingBefore} → {consolidation().pendingAfter}</text>
                    <text fg={theme.textMuted} wrapMode="word">{consolidation().applied} applied · {consolidation().archived} archived · {consolidation().rejected} rejected · {consolidation().superseded} superseded</text>
                    <For each={consolidation().decisions}>
                      {(decision) => <text fg={dreamItemTone(decision.status, theme)} wrapMode="word">{memoryPreviewText(`${decision.status}/${decision.resolution} · ${decision.reason}`, secondaryWidth() * 3)}</text>}
                    </For>
                  </box>
                )}
              </Show>
            </DreamSection>

            <DreamSection title="Evidence" count={detail().evidence.length}>
              <Show when={detail().evidence.length} fallback={<text fg={theme.textMuted}>No evidence snapshot was stored.</text>}>
                <For each={detail().evidence}>
                  {(evidence, index) => (
                    <box flexDirection="column" minWidth={0}>
                      <text fg={evidence.redacted ? theme.warning : theme.info} wrapMode="none">{evidence.redacted ? "!" : "◆"} {dreamEvidenceLabel(evidence)}</text>
                      <text fg={theme.text} wrapMode="word">{memoryPreviewText(evidence.excerpt || "No excerpt stored.", secondaryWidth() * 3)}</text>
                      <text fg={theme.textMuted} wrapMode="none">ref {index() + 1}/{detail().evidence.length}{evidence.hash ? ` · hash ${evidence.hash.slice(0, 10)}` : ""}</text>
                    </box>
                  )}
                </For>
              </Show>
            </DreamSection>

            <DreamSection title="Safety">
              <box flexDirection="column" gap={1} minWidth={0}>
                <text fg={detail().safety?.failures.length ? theme.error : theme.success} wrapMode="word">{detail().safety?.failures.length ? `× ${detail().safety!.failures.length} failures` : "✓ No safety failures recorded"}</text>
                <text fg={theme.textMuted} wrapMode="word">{detail().safety?.reads.length ?? detail().evidence.length} reads · {detail().safety?.redactions ?? 0} redactions · {detail().safety?.skippedSources.length ?? 0} skipped sources</text>
                <For each={detail().safety?.failures ?? []}>{(failure) => <text fg={theme.error} wrapMode="word">{memoryPreviewText(failure, secondaryWidth() * 3)}</text>}</For>
                <For each={detail().safety?.skippedSources ?? []}>{(source) => <text fg={theme.warning} wrapMode="word">! skipped · {memoryPreviewText(source, secondaryWidth() * 2)}</text>}</For>
              </box>
            </DreamSection>

            <DreamSection title="Run input">
              <box flexDirection="column" minWidth={0}>
                <text fg={theme.text} wrapMode="word">{detail().run.writePolicySnapshot} writes · {detail().run.workspaceID ?? "global workspace"} · {detail().run.groupID ?? "no group"}</text>
                <text fg={theme.textMuted} wrapMode="word">files {sourcePermissions().files ? "on" : "off"} · sessions {sourcePermissions().sessions ? "on" : "off"} · git {sourcePermissions().git ? "on" : "off"} · raw diff {sourcePermissions().allowRawDiff ? "on" : "off"}</text>
                <text fg={theme.textMuted} wrapMode="word">{sourcePermissions().roots?.length ?? 0} allowed roots · max {sourcePermissions().maxFiles ?? "default"} files · {sourcePermissions().maxBytes ? `${Locale.number(sourcePermissions().maxBytes!)} bytes` : "default byte limit"}</text>
                <text fg={theme.textMuted} wrapMode="none">{short(detail().run.id, secondaryWidth())}</text>
              </box>
            </DreamSection>
          </box>
        </box>
      </box>
    </scrollbox>
  )
}

function DreamContent(props: {
  data: MemoryOverview
  schedule: DreamScheduleState | null | undefined
  width: number
  selectedIndex: number
  limit?: number
  onSelectRun: (index: number) => void
}) {
  const { theme } = useTheme()
  const dream = () => props.data.dream
  const details = () => props.data.dreamRunDetails ?? []
  const runs = () => details().length ? details() : (props.data.dreamRuns ?? []).map(fallbackDreamRunDetail)
  const schedule = () => props.schedule
  const pendingCount = () => props.data.proposals.filter((proposal) => proposal.status === "pending").length
  return (
    <box flexDirection="column" gap={1} minHeight={0} flexGrow={1}>
      <Panel title="Dream overview" height={props.width < 88 ? 8 : 12}>
        <box flexDirection="row" gap={2} height={props.width < 88 ? 3 : 4} overflow="hidden">
          <box flexDirection="column" width="32%" overflow="hidden">
            <text fg={dream()?.status === "failed" ? theme.error : dream()?.status === "completed" ? theme.success : theme.primary} wrapMode="none">
              {short(dream()?.status ?? "idle", Math.max(10, props.width * 0.32))}
            </text>
            <text fg={theme.textMuted} wrapMode="none">
              last status
            </text>
          </box>
          <box flexDirection="column" flexGrow={1} overflow="hidden">
            <text fg={theme.text} wrapMode="none">
              {short(dreamWindowLabel(schedule()?.window), Math.max(16, props.width * 0.42))}
            </text>
            <text fg={theme.textMuted} wrapMode="none">
              {short(schedule()?.status ?? "not scheduled", Math.max(16, props.width * 0.42))}
            </text>
          </box>
          <box flexDirection="column" width="20%" overflow="hidden">
            <text fg={theme.primary} wrapMode="none">
              {String(dream()?.proposals.length ?? 0)}
            </text>
            <text fg={theme.textMuted} wrapMode="none">
              latest run
            </text>
          </box>
        </box>
        <Show when={props.width >= 88}>
          <text fg={theme.primary} wrapMode="none">
            {short(`Dream write: ${props.data.config.dreamWritePolicy} · consolidation: ${dreamConsolidationLabel(props.data.config.dreamConsolidationPolicy)}`, props.width)}
          </text>
        </Show>
        <text fg={pendingCount() > 0 ? theme.warning : theme.textMuted} wrapMode="none">
          {short(`pending queue: ${pendingCount()} · ${props.data.dreamRole.ok ? "model" : "status"}: ${dreamRoleLabel(props.data.dreamRole)}`, props.width)}
        </text>
        <text fg={theme.textMuted} wrapMode="none">
          {memoryPreviewText(`latest activity: ${props.data.dreamLatestActivity ? `${props.data.dreamLatestActivity.kind} · ${props.data.dreamLatestActivity.summary}` : "none"}`, props.width)}
        </text>
        <Show when={props.width >= 88}>
          <text fg={theme.textMuted} wrapMode="none">
            {short(`source ${dream()?.source ?? schedule()?.reason ?? "not scheduled"} · ${schedule()?.manualTriggerRequired ? "manual trigger required" : schedule()?.status ?? "not scheduled"} · last ${dream() ? formatDate(dream()!.startedAt) : "none"}`, props.width)}
          </text>
        </Show>
      </Panel>
      <Panel title="Dream runs" grow>
        <Show when={runs().length > 0} fallback={
          <box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center" overflow="hidden" gap={1}>
            <text fg={theme.textMuted} wrapMode="none">
              Dream scans safe project files, current memories, and pending proposals during the configured window.
            </text>
            <text fg={theme.primary} wrapMode="none">
              No runs logged yet.
            </text>
          </box>
        }>
          <box flexDirection="column" gap={1} minHeight={0} flexGrow={1} overflow="hidden">
            <text fg={theme.textMuted} wrapMode="none">
              {short("Select a run to inspect events, proposals, evidence, and safety details below.", props.width)}
            </text>
            <For each={memoryListWindow(runs(), props.selectedIndex, props.limit ?? DREAM_RUN_ROW_LIMIT)}>
              {(row) => {
                const detail = () => row.item
                const run = () => detail().run
                const selectedRun = () => props.selectedIndex === row.index
                const color = () => dreamRunStatusTone(run().status, theme)
                const reads = () => detail().safety?.reads.length ?? detail().evidence.length
                const redactions = () => detail().safety?.redactions ?? 0
                const duration = () => durationLabel(run().startedAt, run().completedAt)
                const skipped = () => dreamSkippedDecisionCount(detail())
                const consolidation = () => detail().consolidation
                return (
                  <box height={4} overflow="hidden" onMouseUp={() => props.onSelectRun(row.index)}>
                    <box flexDirection="row" justifyContent="space-between" height={1} overflow="hidden">
                      <text fg={selectedRun() ? theme.success : color()} wrapMode="none">
                        {short(`${selectedRun() ? "› " : "  "}${dreamRunStatusLabel(run().status)} · ${run().workspaceID ?? "global"}`, Math.max(18, props.width - 24))}
                      </text>
                      <text fg={theme.textMuted} wrapMode="none">
                        {short(`${formatDate(run().completedAt ?? run().startedAt)} ${formatTime(run().completedAt ?? run().startedAt)}`, 18)}
                      </text>
                    </box>
                    <text fg={selectedRun() ? theme.text : theme.textMuted} wrapMode="none">
                      {short(`${dreamRunProposalCount(detail())} latest proposals · ${detail().graphProposals.length} graph · ${skipped()} skipped · ${detail().evidence.length} evidence · ${reads()} reads · ${redactions()} redactions${duration() ? ` · ${duration()}` : ""}`, props.width)}
                    </text>
                    <text fg={theme.textMuted} wrapMode="none">
                      {memoryPreviewText(consolidation() ? `queue ${consolidation()!.pendingBefore} → ${consolidation()!.pendingAfter} · ${consolidation()!.policy}` : detail().events.at(-1)?.message ?? run().failureReason ?? run().id, props.width)}
                    </text>
                    <Show when={selectedRun()}>
                      <text fg={theme.primary} wrapMode="none">
                        {short(`Enter open · ${run().id}`, props.width)}
                      </text>
                    </Show>
                  </box>
                )
              }}
            </For>
          </box>
        </Show>
      </Panel>
    </box>
  )
}

function Inspector(props: {
  selection: Selection
  width: number
  policyScope: MemoryPolicyScope
  onApplyProposal?: () => void
  onRejectProposal?: () => void
  onApplyGraphProposal?: (runID: string, proposalID: string) => void
  onRejectGraphProposal?: (runID: string, proposalID: string) => void
  onEditSelection?: () => void
}) {
  const { theme } = useTheme()
  return (
    <Panel title="Details" grow>
      <scrollbox
        flexGrow={1}
        minHeight={0}
        horizontalScrollbarOptions={{ visible: false }}
        verticalScrollbarOptions={{
          visible: true,
          trackOptions: {
            backgroundColor: theme.backgroundPanel,
            foregroundColor: theme.border,
          },
        }}
      >
        <Switch>
          <Match when={props.selection.kind === "entry" ? props.selection : undefined}>
            {(selection) => {
              const entry = () => selection().entry
              return (
                <box flexDirection="column" gap={1} overflow="hidden">
                  <text fg={theme.primary} wrapMode="none">
                    {short(`${selection().projectLabel} · ${entry().scope} · ${(entry().categoryIDs ?? ["uncategorized"]).join(", ")}`, props.width)}
                  </text>
                  <text fg={theme.text} wrapMode="word">
                    {memoryPreviewText(entry().text, props.width * 8)}
                  </text>
                  <text fg={theme.textMuted} wrapMode="none">
                    {short(`${memoryOriginLabel(entry().source)} · ${Math.round(entry().confidence * 100)}% confidence · updated ${formatDate(entry().updatedAt)}`, props.width)}
                  </text>
                  <text fg={theme.textMuted} wrapMode="none">
                    e edit · delete type DELETE
                  </text>
                </box>
              )
            }}
        </Match>
        <Match when={props.selection.kind === "proposal" ? props.selection.proposal : undefined}>
          {(proposal) => (
            <box flexDirection="column" gap={1} overflow="hidden">
              <box flexDirection="row" justifyContent="space-between" height={1} overflow="hidden">
                <text fg={theme.warning} wrapMode="none">
                  {short(`${proposal().operation} · ${proposal().scope}`, Math.max(14, props.width - 18))}
                </text>
                <text fg={theme.textMuted} wrapMode="none">
                  {`${Math.round(proposal().confidence * 100)}% · risk ${Math.round(proposal().changeRisk * 100)}%`}
                </text>
              </box>
              <text fg={theme.primary} wrapMode="none">
                {short(`category: ${proposal().categoryIDs.join(", ") || "uncategorized"}`, props.width)}
              </text>
              <text fg={proposal().source === "memory-dream" ? theme.primary : theme.textMuted} wrapMode="none">
                {short(`source: ${memoryOriginLabel(proposal().source)}${proposal().evidence ? ` · ${proposal().evidence}` : ""}${proposal().evidenceRefs.length ? ` · refs ${proposal().evidenceRefs.length}` : ""}`, props.width)}
              </text>
              <text fg={theme.text} wrapMode="word">
                {memoryPreviewText(proposal().text, props.width * 8)}
              </text>
              <text fg={theme.textMuted} wrapMode="none">
                a apply · x reject · e edit
              </text>
              <box flexDirection="row" gap={1} height={1} overflow="hidden">
                <text fg={theme.success} wrapMode="none" onMouseUp={() => props.onApplyProposal?.()}>
                  [apply]
                </text>
                <text fg={theme.error} wrapMode="none" onMouseUp={() => props.onRejectProposal?.()}>
                  [reject]
                </text>
                <text fg={theme.primary} wrapMode="none" onMouseUp={() => props.onEditSelection?.()}>
                  [edit]
                </text>
              </box>
            </box>
          )}
        </Match>
        <Match when={props.selection.kind === "policy" ? props.selection : undefined}>
          {(selection) => (
            <box flexDirection="column" gap={1} overflow="hidden">
              <MetricRows
                width={props.width}
                items={[
                  stat("category", selection().category.label),
                  stat("effective", selection().policy.writePolicy, `prompt ${selection().policy.promptEnabled ? "on" : "off"} · priority ${selection().policy.promptPriority}`),
                  stat("default", selection().layer?.default.writePolicy ?? "unknown", `prompt ${selection().layer?.default.promptEnabled ? "on" : "off"}`),
                  stat("global", selection().layer?.global.writePolicy ?? "unknown", selection().layer?.globalOverridden ? "explicit override" : "inherits default"),
                  stat("project", selection().layer?.project.writePolicy ?? "unknown", selection().layer?.projectOverridden ? "explicit override" : "inherits global"),
                  stat("editing", props.policyScope, "p write · o prompt · s scope · x reset"),
                ]}
              />
              <text fg={theme.text} wrapMode="word">
                {short(selection().category.description, props.width * 20)}
              </text>
              <text fg={theme.textMuted} wrapMode="none">
                Effective priority is project override, then global override, then default.
              </text>
            </box>
          )}
        </Match>
        <Match when={props.selection.kind === "dream" ? props.selection.detail : undefined}>
          {(detail) => {
            const pendingGraphProposal = () => detail().graphProposals.find((proposal) => (proposal.status ?? "pending") === "pending")
            return (
              <box flexDirection="column" gap={1} overflow="hidden">
              <Show when={dreamLatestActivity(detail())}>
                {(activity) => (
                  <text fg={dreamTranscriptColor(activity().tone, theme)} wrapMode="word">
                    {memoryPreviewText(`latest: ${activity().label} · ${activity().detail}`, props.width * 3)}
                  </text>
                )}
              </Show>
              <MetricRows
                width={props.width}
                items={[
                  stat("run", detail().run.id),
                  stat("status", dreamRunStatusLabel(detail().run.status), durationLabel(detail().run.startedAt, detail().run.completedAt)),
                  stat("source", detail().run.source, detail().run.workspaceID ?? "global"),
                  stat("policy", detail().run.writePolicySnapshot, `${dreamSkippedDecisionCount(detail())} skipped`),
                  stat("proposals", String(dreamRunProposalCount(detail())), `${detail().proposals.filter((proposal) => proposal.status === "applied").length} applied`),
                  stat("graph", String(detail().graphProposals.filter((proposal) => (proposal.status ?? "pending") === "pending").length), `${detail().graphProposals.length} link proposals`),
                  stat("consolidation", detail().consolidation?.status ?? "not run", detail().consolidation ? `${detail().consolidation!.pendingBefore} → ${detail().consolidation!.pendingAfter} pending` : undefined),
                  stat("evidence", String(detail().evidence.length), `${detail().safety?.reads.length ?? detail().evidence.length} reads`),
                  stat("safety", `${detail().safety?.redactions ?? 0} redactions`, `${detail().safety?.skippedSources.length ?? 0} skipped`),
                ]}
              />
              <box flexDirection="column" gap={0}>
                <text fg={theme.primary} wrapMode="none">Inputs</text>
                <text fg={theme.textMuted} wrapMode="word">
                  {memoryPreviewText(`workspace ${detail().run.workspaceID ?? "none"} · group ${detail().run.groupID ?? "none"} · root ${detail().run.projectRoot ?? "none"} · files ${detail().run.permissionSnapshot?.files ? "allowed" : "off"} · roots ${detail().run.permissionSnapshot?.roots?.join(", ") || "none"} · max ${detail().run.permissionSnapshot?.maxFiles ?? "unknown"} files / ${detail().run.permissionSnapshot?.maxBytes ?? "unknown"} bytes`, props.width * 5)}
                </text>
              </box>
              <Show when={dreamTranscriptRows(detail()).length > 0}>
                <box flexDirection="column" gap={0}>
                  <text fg={theme.primary} wrapMode="none">Dream timeline</text>
                  <For each={dreamTranscriptRows(detail())}>
                    {(row) => (
                      <text fg={dreamTranscriptColor(row.tone, theme)} wrapMode="word">
                        {memoryPreviewText(`${formatTime(row.at)} · ${row.label} · ${row.detail}`, props.width * 3)}
                      </text>
                    )}
                  </For>
                </box>
              </Show>
              <Show when={detail().events.at(-1)?.message}>
                {(message) => (
                  <box flexDirection="column" gap={0}>
                    <text fg={theme.primary} wrapMode="none">Last event</text>
                    <text fg={theme.text} wrapMode="word">{memoryPreviewText(message(), props.width * 5)}</text>
                  </box>
                )}
              </Show>
              <Show when={detail().proposals.length > 0}>
                <box flexDirection="column" gap={0}>
                  <text fg={theme.primary} wrapMode="none">Proposals</text>
                  <For each={detail().proposals}>
                    {(proposal) => (
                      <text fg={theme.text} wrapMode="word">
                        {memoryPreviewText(`${proposal.id} · ${proposal.operation ?? "create"} · ${proposal.scope ?? "memory"} · ${proposal.status ?? "historical"}${proposal.appliedEntryID ? ` · entry ${proposal.appliedEntryID}` : ""} · ${proposal.resolution ?? proposal.reason ?? "no resolution"} · ${proposal.text ?? proposal.id}`, props.width * 5)}
                      </text>
                    )}
                  </For>
                </box>
              </Show>
              <Show when={detail().decisions.length > 0}>
                <box flexDirection="column" gap={0}>
                  <text fg={theme.primary} wrapMode="none">Dream decisions</text>
                  <For each={detail().decisions}>
                    {(decision) => (
                      <text fg={decision.status === "created-proposal" ? theme.text : theme.warning} wrapMode="word">
                        {memoryPreviewText(`${decision.status} · proposal ${decision.proposalID ?? "none"} · entry ${decision.entryID ?? "none"} · ${decision.reason}`, props.width * 4)}
                      </text>
                    )}
                  </For>
                </box>
              </Show>
              <Show when={detail().graphProposals.length > 0}>
                <box flexDirection="column" gap={0}>
                  <text fg={theme.primary} wrapMode="none">Graph proposals</text>
                  <For each={detail().graphProposals}>
                    {(proposal) => (
                      <box flexDirection="column" gap={0} overflow="hidden">
                        <text fg={proposal.status === "applied" ? theme.success : proposal.status === "rejected" ? theme.warning : theme.text} wrapMode="word">
                          {memoryPreviewText(dreamGraphProposalLabel(proposal), props.width * 3)}
                        </text>
                        <text fg={theme.textMuted} wrapMode="word">
                          {memoryPreviewText(`${proposal.id} · ${proposal.from} → ${proposal.to} · link ${proposal.linkID ?? "not applied"} · evidence ${proposal.evidenceRefs.join(", ") || "none"}`, props.width * 4)}
                        </text>
                        <Show when={(proposal.status ?? "pending") === "pending"}>
                          <box flexDirection="row" gap={1} height={1} overflow="hidden">
                            <text fg={theme.success} wrapMode="none" onMouseUp={() => props.onApplyGraphProposal?.(detail().run.id, proposal.id)}>
                              [apply graph]
                            </text>
                            <text fg={theme.error} wrapMode="none" onMouseUp={() => props.onRejectGraphProposal?.(detail().run.id, proposal.id)}>
                              [reject graph]
                            </text>
                          </box>
                        </Show>
                      </box>
                    )}
                  </For>
                </box>
              </Show>
              <Show when={detail().consolidation}>
                {(consolidation) => (
                  <box flexDirection="column" gap={0}>
                    <text fg={theme.primary} wrapMode="none">Consolidation</text>
                    <text fg={consolidation().status === "failed" ? theme.error : theme.text} wrapMode="word">
                      {memoryPreviewText(`${consolidation().id} · ${consolidation().policy} · queue ${consolidation().pendingBefore} → ${consolidation().pendingAfter} · ${consolidation().applied} applied · ${consolidation().archived} archived · ${consolidation().rejected} rejected · ${consolidation().superseded} superseded`, props.width * 4)}
                    </text>
                    <For each={consolidation().decisions}>
                      {(decision) => (
                        <text fg={decision.status === "applied" ? theme.success : decision.status === "failed" ? theme.error : theme.warning} wrapMode="word">
                          {memoryPreviewText(`${decision.status}/${decision.resolution} · proposal ${decision.proposalID ?? "none"} · entry ${decision.entryID ?? "none"} · ${decision.reason}`, props.width * 4)}
                        </text>
                      )}
                    </For>
                  </box>
                )}
              </Show>
              <Show when={pendingGraphProposal()}>
                {(proposal) => (
                  <box flexDirection="column" gap={0} overflow="hidden">
                    <text fg={theme.warning} wrapMode="word">
                      {memoryPreviewText(`keyboard apply/reject targets first pending graph action · ${dreamGraphProposalLabel(proposal())}`, props.width * 3)}
                    </text>
                  </box>
                )}
              </Show>
              <Show when={detail().evidence.length > 0}>
                <box flexDirection="column" gap={0}>
                  <text fg={theme.primary} wrapMode="none">Evidence</text>
                  <For each={detail().evidence}>
                    {(evidence) => (
                      <text fg={theme.textMuted} wrapMode="none">
                        {short(dreamEvidenceLabel(evidence), props.width)}
                      </text>
                    )}
                  </For>
                </box>
              </Show>
              <Show when={detail().safety?.failures.length}>
                <text fg={theme.error} wrapMode="word">
                  {memoryPreviewText(`failures: ${detail().safety?.failures.join("; ")}`, props.width * 3)}
                </text>
              </Show>
              <Show when={detail().safety?.skippedSources.length}>
                <text fg={theme.warning} wrapMode="word">
                  {memoryPreviewText(`skipped: ${detail().safety?.skippedSources.join(", ")}`, props.width * 3)}
                </text>
              </Show>
              </box>
            )
          }}
        </Match>
        <Match when={props.selection.kind === "dream"}>
          <MetricRows width={props.width} items={[stat("view", "Dream"), stat("events", "SSE live"), stat("updates", "reviewable proposals")]} />
        </Match>
        <Match when={true}>
          <MetricRows width={props.width} items={[stat("select", "memory/proposal/category"), stat("actions", "shown here"), stat("SSE", "automatic")]} />
        </Match>
        </Switch>
      </scrollbox>
    </Panel>
  )
}

function LoadingMemory(props: { tiny: boolean }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="column" minHeight={0} flexGrow={1} gap={1}>
      <Panel title="Memory" height={props.tiny ? 8 : 7}>
        <box flexDirection="column" flexGrow={1} justifyContent="center" overflow="hidden" gap={1}>
          <text fg={theme.text} wrapMode="none">
            Loading persisted memory state...
          </text>
          <text fg={theme.textMuted} wrapMode="none">
            Reading global, project, policy, and workspace graph files.
          </text>
        </box>
      </Panel>
    </box>
  )
}


export function Memory() {
  const route = useRoute()
  const project = useProject()
  const sdk = useSDK()
  const dialog = useDialog()
  const command = useCommandDialog()
  const kv = useKV()
  const toast = useToast()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const currentRoot = createMemo(() => project.instance.directory() || process.cwd())
  const [selectedWorkspaceID, setSelectedWorkspaceID] = createSignal<string | null>(null)
  const [tab, setTab] = createSignal<MemoryTab>(route.data.type === "memory" && route.data.view === "graph" ? "graph" : "memories")
  const [memoryScope, setMemoryScope] = createSignal<MemoryScopeFilter>("current")
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  const [policyScope, setPolicyScope] = createSignal<MemoryPolicyScope>("project")
  const [live, setLive] = createSignal(true)
  const [graphSelectedID, setGraphSelectedID] = createSignal<string>()
  const [graphFocused, setGraphFocused] = createSignal(false)
  const [graphViewport, setGraphViewport] = createSignal({ x: undefined as number | undefined, y: undefined as number | undefined, zoom: 1 })
  const [storedGraphView, setStoredGraphView] = kv.signal<MemoryGraphViewPreference>("memory.graph.view.v1", { version: 2, scope: "project", projectRoot: null, showIsolates: false })
  const [graphSearching, setGraphSearching] = createSignal(false)
  const [graphQuery, setGraphQuery] = createSignal("")
  const [dreamDetailOpen, setDreamDetailOpen] = createSignal(false)
  const [baseOverview, { refetch: refetchBase }] = createResource(currentRoot, memoryOverview)
  const selectedWorkspace = createMemo(() => baseOverview()?.workspaces?.activeWorkspaces.find((workspace) => workspace.id === selectedWorkspaceID()) ?? null)
  const activeRoot = createMemo(() => selectedWorkspace()?.root ?? currentRoot())
  const [dreamSchedule, { refetch: refetchDreamSchedule }] = createResource(() => readDreamScheduleState())
  const [overview, { refetch }] = createResource(activeRoot, memoryOverview)
  const layout = createMemo(() => memoryLayoutForDimensions(dimensions()))
  const deck = createMemo(() => commandDeckLayout({ ...dimensions(), hasRail: true, hasContext: false }))
  const width = createMemo(() => dimensions().width)
  const tiny = createMemo(() => layout().tiny)
  const medium = createMemo(() => layout().medium)
  const wide = createMemo(() => layout().wide)
  const contentWidth = createMemo(() => layout().contentWidth)
  const memoryRowLimit = createMemo(() => Math.max(2, Math.min(ENTRY_ROW_LIMIT, Math.floor((dimensions().height - 17) / 3))))
  const policyRowLimit = createMemo(() => Math.max(3, Math.min(POLICY_ROW_LIMIT, Math.floor((dimensions().height - 10) / 4))))
  const dreamRunRowLimit = createMemo(() => Math.max(2, Math.min(DREAM_RUN_ROW_LIMIT, Math.floor((dimensions().height - 21) / 5))))
  const sidebarWidth = createMemo(() => wide() ? 32 : 30)
  const mainContentWidth = createMemo(() => Math.max(44, contentWidth() - sidebarWidth() - 2))
  const inspectorHeight = createMemo(() => tab() === "dream" ? (wide() ? 15 : 13) : 10)
  const data = createMemo(() => overview())
  const pending = createMemo(() => data()?.proposals.filter((proposal) => proposal.status === "pending") ?? [])
  const projectEntries = createMemo(() => data()?.projectEntries ?? [])
  const globalEntries = createMemo(() => data()?.globalEntries ?? [])
  const graphWorkspaces = createMemo(() => baseOverview()?.workspaces?.activeWorkspaces ?? [])
  const projectLabelForRoot = (root: string) => {
    const workspace = graphWorkspaces().find((item) => comparableRoot(item.root) === comparableRoot(root))
    return workspace?.displayName ?? root.split(/[\\/]/).filter(Boolean).at(-1) ?? root
  }
  const projectRoots = createMemo(() => [...new Set([currentRoot(), ...graphWorkspaces().map((workspace) => workspace.root)])])
  const [allProjectEntries, { refetch: refetchAllProjectEntries }] = createResource(
    () => memoryScope() === "all" ? projectRoots().join("\u0000") : "",
    async (key) => {
      if (!key) return [] as MemoryListEntry[]
      const roots = key.split("\u0000").filter(Boolean)
      const groups = await Promise.all(roots.map(async (root) => {
        const entries = await readMemoryEntries("project", root).catch(() => [])
        return entries.map((entry) => ({ entry, root, projectLabel: projectLabelForRoot(root) }))
      }))
      return groups.flat()
    },
  )
  const memoryEntries = createMemo<MemoryListEntry[]>(() => {
    const current = data()
    if (!current) return []
    if (memoryScope() === "global") return globalEntries().map((entry) => ({ entry, root: activeRoot(), projectLabel: "Global" }))
    if (memoryScope() === "all") return [
      ...globalEntries().map((entry) => ({ entry, root: activeRoot(), projectLabel: "Global" })),
      ...(allProjectEntries() ?? []),
    ]
    return projectEntries().map((entry) => ({ entry, root: activeRoot(), projectLabel: projectLabelForRoot(activeRoot()) }))
  })
  const graphProjectOptions = createMemo(() => {
    const current = comparableRoot(currentRoot())
    const currentWorkspace = graphWorkspaces().find((workspace) => comparableRoot(workspace.root) === current)
    return [
      { id: currentWorkspace?.id ?? `root:${current}`, root: currentRoot(), label: currentWorkspace?.displayName ?? current.split(/[\\/]/).filter(Boolean).at(-1) ?? currentRoot() },
      ...memorySidebarProjectWorkspaces({ currentRoot: currentRoot(), workspaces: graphWorkspaces() })
        .map((workspace) => ({ id: workspace.id, root: workspace.root, label: workspace.displayName })),
    ]
  })
  const graphView = createMemo(() => normalizeMemoryGraphViewPreference(storedGraphView(), graphProjectOptions().map((option) => option.root), currentRoot()))
  const graphSelectedProject = createMemo(() => graphView().scope === "project"
    ? graphProjectOptions().find((option) => comparableRoot(option.root) === comparableRoot(graphView().projectRoot ?? "")) ?? null
    : null)
  const graphActiveRoot = createMemo(() => graphSelectedProject()?.root ?? currentRoot())
  const graphActiveLabel = createMemo(() => graphView().scope === "all" ? "All projects" : graphSelectedProject()?.label ?? "All projects")
  const graphProjectPosition = createMemo(() => {
    const index = graphSelectedProject() ? graphProjectOptions().findIndex((option) => option.id === graphSelectedProject()!.id) + 1 : 0
    return `${index + 1}/${graphProjectOptions().length + 1}`
  })
  const graphWorkspaceSelection = createMemo(() => (graphView().scope === "all" ? graphProjectOptions() : graphSelectedProject() ? [graphSelectedProject()!] : graphProjectOptions()).map((option) => ({
    id: option.id,
    root: option.root,
    displayName: option.label,
  })))
  const [graphOverview, { refetch: refetchGraph }] = createResource(graphWorkspaceSelection, memoryGraphOverview)
  const graphLayout = createMemo(() => memoryGraphExplorerLayout({ width: deck().wide ? deck().contentWidth : contentWidth(), height: Math.max(12, dimensions().height - 8) }))
  const graphFrame = createMemo(() => {
    const current = graphOverview()
    if (!current) return
    return memoryGraphMiniMap({
      facts: current.facts,
      links: current.links,
      categories: current.categories,
      width: graphLayout().canvasWidth,
      height: graphLayout().canvasHeight,
      connectedOnly: !graphView().showIsolates,
      selectedID: graphSelectedID(),
      viewport: graphViewport(),
      maxNodes: 64,
    })
  })
  const graphSearchMatches = createMemo(() => {
    const current = graphOverview()
    if (!current) return []
    return memoryGraphSearchMatches({
      facts: current.facts.filter((fact) => fact.materialized),
      query: graphQuery(),
      projectLabel: (fact) => memoryGraphFactProjectLabels({
        fact,
        workspaces: graphWorkspaces(),
        activeRoot: graphActiveRoot(),
        activeLabel: graphActiveLabel(),
      }).join(" "),
    })
  })
  const visibleCount = createMemo(() => {
    const current = data()
    if (!current) return 1
    if (tab() === "memories") return Math.max(1, memoryEntries().length)
    if (tab() === "rules") return Math.max(1, current.categories.length)
    if (tab() === "dream") return Math.max(1, current.dreamRunDetails.length || current.dreamRuns.length)
    return 1
  })
  const selection = createMemo<Selection>(() => {
    const current = data()
    if (!current) return { kind: "overview" }
    const index = Math.max(0, Math.min(selectedIndex(), visibleCount() - 1))
    if (tab() === "memories") {
      const item = memoryEntries()[index]
      return item ? { kind: "entry", ...item } : { kind: "overview" }
    }
    if (tab() === "rules") {
      const category = current.categories[index] ?? current.categories[0]
      const policy = category ? current.policies[category.id] : undefined
      return category && policy ? { kind: "policy", category, policy, layer: current.policyLayers?.[category.id] ?? null } : { kind: "overview" }
    }
    if (tab() === "dream") {
      const details = current.dreamRunDetails.length ? current.dreamRunDetails : current.dreamRuns.map(fallbackDreamRunDetail)
      return { kind: "dream", detail: details[index] ?? null }
    }
    return { kind: "overview" }
  })
  const selectedDreamDetail = createMemo(() => {
    const item = selection()
    return item.kind === "dream" ? item.detail : null
  })
  const activeContext = createMemo(() => {
    const item = selection()
    const focus = selectedWorkspace() ? `focus ${selectedWorkspace()!.displayName}` : "current project"
    if (item.kind === "entry") return `${item.projectLabel} · ${item.entry.scope} · ${(item.entry.categoryIDs ?? []).join(", ")}`
    if (item.kind === "proposal") return `${focus} · ${item.proposal.operation} proposal`
    if (item.kind === "policy") return `${focus} · ${policyScope()} policy · ${item.category.label}`
    if (item.kind === "dream") return `${focus} · Dream${item.detail ? ` · ${item.detail.run.status}` : ""}`
    return focus
  })

  createEffect(() => {
    if (selectedIndex() >= visibleCount()) setSelectedIndex(Math.max(0, visibleCount() - 1))
  })

  createEffect(() => {
    if (route.data.type === "memory" && route.data.view === "graph") setTab("graph")
  })

  createEffect(() => {
    `${graphView().scope}:${graphView().projectRoot ?? "all"}`
    setGraphSelectedID(undefined)
    setGraphQuery("")
    setGraphSearching(false)
    setGraphFocused(false)
    setGraphViewport({ x: undefined, y: undefined, zoom: 1 })
  })

  createEffect(() => {
    if (!baseOverview()) return
    const normalized = graphView()
    const stored = storedGraphView()
    if (stored?.version === normalized.version && stored.scope === normalized.scope && stored.projectRoot === normalized.projectRoot && stored.showIsolates === normalized.showIsolates) return
    setStoredGraphView(() => normalized)
  })

  createEffect(() => {
    const frame = graphFrame()
    if (!frame?.scene.nodes.length) {
      setGraphSelectedID(undefined)
      return
    }
    if (frame.scene.nodes.some((node) => node.id === graphSelectedID())) return
    setGraphSelectedID(frame.selectedID)
  })

  async function reload(message = "Memory refreshed") {
    await Promise.allSettled([refetchBase(), refetch(), refetchGraph(), refetchDreamSchedule(), refetchAllProjectEntries()])
    toast.show(toastInput("success", message))
  }

  function updateGraphView(patch: Partial<Omit<MemoryGraphViewPreference, "version">>) {
    setStoredGraphView((value) => ({
       ...normalizeMemoryGraphViewPreference(value, graphProjectOptions().map((option) => option.root), currentRoot()),
      ...patch,
       version: 2,
    }))
  }

  function selectGraphFact(id: string) {
    const current = graphOverview()?.facts.find((fact) => fact.id === id)
    if (!current?.materialized) return
    if (!graphFrame()?.scene.nodes.some((node) => node.id === id)) updateGraphView({ showIsolates: true })
    setGraphSelectedID(id)
    const node = graphFrame()?.scene.nodes.find((item) => item.id === id)
    if (node) setGraphViewport((value) => ({ ...value, x: node.x, y: node.y }))
    setGraphSearching(false)
    setGraphFocused(true)
  }

  function panGraph(cells: { x: number; y: number }) {
    const transform = graphFrame()?.transform
    if (!transform) return
    setGraphViewport((viewport) => memoryGraphPanViewport({ viewport, transform, cells }))
  }

  function leaveGraph(interrupt: boolean) {
    setGraphSearching(false)
    setGraphFocused(false)
    if (interrupt) route.navigate(routeReturnTarget(route.data))
  }

  function cycleGraphProject(direction: 1 | -1) {
    const options = [null, ...graphProjectOptions()]
    if (!options.length) return
    const current = graphView().scope === "all" ? 0 : Math.max(1, options.findIndex((option) => option?.id === graphSelectedProject()?.id))
    const next = options[(current + direction + options.length) % options.length] ?? null
    updateGraphView(next ? { scope: "project", projectRoot: next.root } : { scope: "all" })
  }

  function showGraphProjectPicker() {
    dialog.replace(() => (
      <DialogSelect
        title="Graph project"
        placeholder="Search project roots"
        options={[
          {
            title: "All projects",
            value: "__all__",
            category: graphView().scope === "all" ? "Active" : "Scope",
            description: `Union of ${graphProjectOptions().length} registered projects`,
            onSelect: () => {
              dialog.clear()
              updateGraphView({ scope: "all" })
            },
          },
          ...graphProjectOptions().map((option) => ({
            title: option.label,
            value: option.id,
            category: graphSelectedProject()?.id === option.id ? "Active" : "Projects",
            description: option.root,
            searchText: `${option.label} ${option.root}`,
            onSelect: () => {
              dialog.clear()
              updateGraphView({ scope: "project", projectRoot: option.root })
            },
          })),
        ]}
      />
    ))
  }

  async function editSelection() {
    const item = selection()
    if (item.kind === "entry") {
      const next = await DialogPrompt.show(dialog, "Edit memory", {
        value: item.entry.text,
        placeholder: "Memory text",
      })
      dialog.clear()
      if (!next?.trim() || next.trim() === item.entry.text) return
      await updateMemoryEntry(item.entry.scope, item.entry.id, { text: next.trim() }, item.root)
      await reload("Memory entry updated")
      return
    }
    if (item.kind === "proposal") {
      const confirmed = await confirmProposalAction("edit", item.proposal)
      if (!confirmed) return
      const next = await DialogPrompt.show(dialog, "Edit proposal", {
        value: item.proposal.text,
        placeholder: "Proposal text",
      })
      dialog.clear()
      if (!next?.trim() || next.trim() === item.proposal.text) return
      await updateMemoryProposal(item.proposal.id, { text: next.trim() }, activeRoot())
      await reload("Memory proposal updated")
    }
  }

  async function deleteSelectedEntry() {
    const item = selection()
    if (item.kind !== "entry") return
    const confirm = await DialogPrompt.show(dialog, "Delete memory", {
      placeholder: "Type DELETE to delete this memory",
    })
    dialog.clear()
    if (confirm !== "DELETE") return
    await deleteMemoryEntry(item.entry.scope, item.entry.id, item.root)
    await reload("Memory entry deleted")
  }

  function proposalConfirmText(proposal: MemoryProposal) {
    return [
      `Operation: ${proposal.operation}`,
      `Scope: ${proposal.scope}`,
      `Category: ${proposal.categoryIDs.join(", ") || "uncategorized"}`,
      `Confidence: ${Math.round(proposal.confidence * 100)}%`,
      `Risk: ${Math.round(proposal.changeRisk * 100)}%`,
      "",
      memoryPreviewText(proposal.text, 900),
    ].join("\n")
  }

  function selectedPendingDreamGraphProposal() {
    const item = selection()
    if (item.kind !== "dream" || !item.detail) return null
    const proposal = item.detail.graphProposals.find((candidate) => (candidate.status ?? "pending") === "pending")
    return proposal ? { runID: item.detail.run.id, proposal } : null
  }

  function graphProposalConfirmText(proposal: NonNullable<ReturnType<typeof selectedPendingDreamGraphProposal>>["proposal"]) {
    return [
      `Kind: ${proposal.kind}`,
      `Confidence: ${Math.round(proposal.confidence * 100)}%`,
      `Reason: ${proposal.reason}`,
      `From: ${memoryPreviewText(proposal.fromSummary, 420)}`,
      `To: ${memoryPreviewText(proposal.toSummary, 420)}`,
    ].join("\n")
  }

  async function confirmProposalAction(action: "apply" | "reject" | "edit", proposal: MemoryProposal) {
    const confirmed = await DialogConfirm.show(
      dialog,
      `${Locale.titlecase(action)} memory proposal`,
      proposalConfirmText(proposal),
      "cancel",
    )
    dialog.clear()
    return confirmed === true
  }

  async function confirmGraphProposalAction(action: "apply" | "reject", proposal: NonNullable<ReturnType<typeof selectedPendingDreamGraphProposal>>["proposal"]) {
    const confirmed = await DialogConfirm.show(
      dialog,
      `${Locale.titlecase(action)} Dream graph proposal`,
      graphProposalConfirmText(proposal),
      "cancel",
    )
    dialog.clear()
    return confirmed === true
  }

  async function applySelectedProposal() {
    const item = selection()
    if (item.kind === "dream") {
      await applySelectedGraphProposal()
      return
    }
    if (item.kind !== "proposal") return
    const confirmed = await confirmProposalAction("apply", item.proposal)
    if (!confirmed) return
    await applyMemoryProposal(item.proposal.id, activeRoot())
    await reload("Proposal applied")
  }

  async function rejectSelectedProposal() {
    const item = selection()
    if (item.kind === "dream") {
      await rejectSelectedGraphProposal()
      return
    }
    if (item.kind !== "proposal") return
    const confirmed = await confirmProposalAction("reject", item.proposal)
    if (!confirmed) return
    await rejectMemoryProposal(item.proposal.id, activeRoot())
    await reload("Proposal rejected")
  }

  async function applySelectedGraphProposal(runID?: string, proposalID?: string) {
    const selected = selectedPendingDreamGraphProposal()
    const target = runID && proposalID
      ? { runID, proposal: data()?.dreamRunDetails.find((detail) => detail.run.id === runID)?.graphProposals.find((proposal) => proposal.id === proposalID) ?? null }
      : selected
    if (!target?.proposal) return
    const confirmed = await confirmGraphProposalAction("apply", target.proposal)
    if (!confirmed) return
    await applyDreamGraphProposal(target.runID, target.proposal.id, activeRoot())
    await reload("Dream graph proposal applied")
  }

  async function rejectSelectedGraphProposal(runID?: string, proposalID?: string) {
    const selected = selectedPendingDreamGraphProposal()
    const target = runID && proposalID
      ? { runID, proposal: data()?.dreamRunDetails.find((detail) => detail.run.id === runID)?.graphProposals.find((proposal) => proposal.id === proposalID) ?? null }
      : selected
    if (!target?.proposal) return
    const confirmed = await confirmGraphProposalAction("reject", target.proposal)
    if (!confirmed) return
    await rejectDreamGraphProposal(target.runID, target.proposal.id, activeRoot(), "Rejected from Memory Center")
    await reload("Dream graph proposal rejected")
  }

  async function cycleSelectedPolicy() {
    const item = selection()
    if (item.kind !== "policy") return
    const layer = data()?.policyLayers?.[item.category.id]
    const current = policyScope() === "global" ? layer?.global.writePolicy : layer?.project.writePolicy
    await writeMemoryCategoryPolicy(policyScope(), item.category.id, { writePolicy: nextWritePolicy(current ?? item.policy.writePolicy) }, activeRoot())
    await reload("Category write policy updated")
  }

  async function toggleSelectedPolicyPrompt() {
    const item = selection()
    if (item.kind !== "policy") return
    const layer = data()?.policyLayers?.[item.category.id]
    const current = policyScope() === "global" ? layer?.global.promptEnabled : layer?.project.promptEnabled
    await writeMemoryCategoryPolicy(policyScope(), item.category.id, { promptEnabled: !(current ?? item.policy.promptEnabled) }, activeRoot())
    await reload("Category prompt policy updated")
  }

  async function resetSelectedPolicy() {
    const item = selection()
    if (item.kind !== "policy") return
    const result = await resetMemoryCategoryPolicy(policyScope(), item.category.id, activeRoot())
    await reload(result.reset ? "Category override reset" : "Category already inherited")
  }

  function moveTab(direction: 1 | -1) {
    const index = TABS.findIndex((item) => item.id === tab())
    const next = TABS[(index + direction + TABS.length) % TABS.length]
    if (next) {
      setTab(next.id)
      setSelectedIndex(0)
      setDreamDetailOpen(false)
      setGraphFocused(false)
    }
  }

  function selectMemoryScope(scope: MemoryScopeFilter) {
    setMemoryScope(scope)
    setSelectedIndex(0)
    setTab("memories")
  }

  useKeyboard((evt) => {
    const graphEmergency = tab() === "graph" && (evt.name === "escape" || (evt.ctrl && evt.name === "c"))
    if (!shouldMemoryRouteHandleKey({
      dialogOpen: dialog.stack.length > 0,
      defaultPrevented: evt.defaultPrevented,
      emergency: graphEmergency,
    })) return
    if (tab() === "graph") {
      if (evt.ctrl && evt.name === "c") {
        evt.preventDefault()
        evt.stopPropagation()
        setGraphSearching(false)
        setGraphFocused(false)
        route.navigate(routeReturnTarget(route.data))
        return
      }
      if (graphSearching()) {
        if (evt.name === "escape") {
          evt.preventDefault()
          setGraphSearching(false)
          return
        }
        if (evt.name === "return") {
          evt.preventDefault()
          const match = graphSearchMatches()[0]
          if (match) selectGraphFact(match.id)
          return
        }
        if (evt.name === "backspace") {
          evt.preventDefault()
          setGraphQuery((value) => value.slice(0, -1))
          return
        }
        if (!evt.ctrl && !evt.meta && (evt.name.length === 1 || evt.name === "space")) {
          evt.preventDefault()
          setGraphQuery((value) => `${value}${evt.name === "space" ? " " : evt.name}`)
        }
        return
      }
      if (evt.name === "f" || evt.name === "/") {
        evt.preventDefault()
        setGraphQuery("")
        setGraphSearching(true)
        return
      }
      if (evt.name === "p") {
        evt.preventDefault()
        showGraphProjectPicker()
        return
      }
      if (evt.name === "a") {
        evt.preventDefault()
        updateGraphView({ scope: "all" })
        return
      }
      if (evt.name === "i") {
        evt.preventDefault()
        updateGraphView({ showIsolates: !graphView().showIsolates })
        return
      }
      if (evt.name === "+" || evt.name === "=") {
        evt.preventDefault()
        setGraphViewport((value) => ({ ...value, zoom: Math.min(4, Number((value.zoom * 1.25).toFixed(2))) }))
        return
      }
      if (evt.name === "-") {
        evt.preventDefault()
        setGraphViewport((value) => ({ ...value, zoom: Math.max(0.4, Number((value.zoom / 1.25).toFixed(2))) }))
        return
      }
      if (evt.name === "[") {
        evt.preventDefault()
        cycleGraphProject(-1)
        return
      }
      if (evt.name === "]") {
        evt.preventDefault()
        cycleGraphProject(1)
        return
      }
      if (evt.name === "r") {
        evt.preventDefault()
        void reload("Memory graph refreshed").catch((err) => toast.error(err))
        return
      }
      if (evt.name === "return" && !graphFocused()) {
        evt.preventDefault()
        setGraphFocused(true)
        return
      }
      if (evt.name === "escape" && graphFocused()) {
        evt.preventDefault()
        setGraphFocused(false)
        return
      }
      const panDirection = memoryGraphPanDirection(evt.name)
      if (panDirection && graphFocused()) {
        evt.preventDefault()
        panGraph({ x: panDirection.x * 4, y: panDirection.y * 2 })
        return
      }
      const direction = memoryGraphNavigationDirection({ name: evt.name })
      if (direction && graphFocused()) {
        evt.preventDefault()
        const frame = graphFrame()
        const next = frame ? asciiGraphNearestNode(frame.scene, graphSelectedID(), direction) : undefined
        if (next) selectGraphFact(next)
        return
      }
    }
    if (tab() === "dream" && dreamDetailOpen() && (evt.name === "escape" || evt.name === "q")) {
      evt.preventDefault()
      setDreamDetailOpen(false)
      return
    }
    if (evt.name === "escape" || evt.name === "q") {
      evt.preventDefault()
      route.navigate(routeReturnTarget(route.data))
      return
    }
    if (evt.name === "right" || evt.name === "l") {
      evt.preventDefault()
      moveTab(1)
      return
    }
    if (evt.name === "left" || evt.name === "h") {
      evt.preventDefault()
      moveTab(-1)
      return
    }
    if (evt.name === "down" || evt.name === "j") {
      evt.preventDefault()
      setSelectedIndex(Math.min(visibleCount() - 1, selectedIndex() + 1))
      return
    }
    if (evt.name === "up" || evt.name === "k") {
      evt.preventDefault()
      setSelectedIndex(Math.max(0, selectedIndex() - 1))
      return
    }
    const selected = selection()
    if (evt.name === "return" && tab() === "dream" && selected.kind === "dream" && selected.detail) {
      evt.preventDefault()
      setDreamDetailOpen(true)
      return
    }
    const tabNumber = Number(evt.name)
    if (Number.isInteger(tabNumber) && tabNumber >= 1 && tabNumber <= TABS.length) {
      evt.preventDefault()
      setTab(TABS[tabNumber - 1]!.id)
      setSelectedIndex(0)
      return
    }
    if (evt.name === "e") {
      evt.preventDefault()
      void editSelection().catch((err) => toast.error(err))
      return
    }
    if (evt.name === "v") {
      evt.preventDefault()
      command.trigger("mendcode.memory.status")
      return
    }
    if (evt.name === "delete" || evt.name === "backspace") {
      evt.preventDefault()
      void deleteSelectedEntry().catch((err) => toast.error(err))
      return
    }
    if (evt.name === "a") {
      evt.preventDefault()
      void applySelectedProposal().catch((err) => toast.error(err))
      return
    }
    if (evt.name === "x") {
      evt.preventDefault()
      if (tab() === "rules") {
        void resetSelectedPolicy().catch((err) => toast.error(err))
        return
      }
      void rejectSelectedProposal().catch((err) => toast.error(err))
      return
    }
    if (evt.name === "p") {
      evt.preventDefault()
      void cycleSelectedPolicy().catch((err) => toast.error(err))
      return
    }
    if (evt.name === "o") {
      evt.preventDefault()
      void toggleSelectedPolicyPrompt().catch((err) => toast.error(err))
      return
    }
    if (evt.name === "s" && tab() === "rules") {
      evt.preventDefault()
      setPolicyScope(policyScope() === "project" ? "global" : "project")
      return
    }
  })

  onMount(() => {
    void registerMemoryWorkspace({
      root: currentRoot(),
      source: "current-session",
    }, currentRoot()).then(() => Promise.allSettled([refetchBase(), refetch()])).catch((err) => toast.error(err))
    const unsubscribe = sdk.event.on("event", (event) => {
      const type = String(event.payload.type)
      if (type !== "memory.workspace" && type !== "memory.dream") return
      if (event.directory && graphView().scope !== "all" && event.directory !== activeRoot() && event.directory !== currentRoot() && event.directory !== graphActiveRoot()) return
      setLive(true)
      void Promise.allSettled([refetchBase(), refetch(), refetchGraph(), refetchDreamSchedule()])
    })
    onCleanup(() => {
      void unsubscribe?.()
    })
  })

  const renderMain = (current: MemoryOverview, availableWidth = contentWidth()) => (
    <Switch>
      <Match when={tab() === "memories"}>
        <Panel title={memoryScopeTitle(memoryScope(), projectLabelForRoot(activeRoot()))} grow>
          <EntryRows entries={memoryEntries()} selectedIndex={selectedIndex()} width={Math.max(30, availableWidth - 4)} limit={memoryRowLimit()} showProject={memoryScope() === "all"} onSelect={setSelectedIndex} />
        </Panel>
      </Match>
      <Match when={tab() === "graph"}>
        <Show when={graphFrame() && graphOverview()} fallback={<LoadingMemory tiny={tiny()} />}>
          <MemoryGraphExplorer
            data={graphOverview()!}
            frame={graphFrame()!}
            width={availableWidth}
            height={Math.max(12, dimensions().height - 10)}
            canvasWidth={graphLayout().canvasWidth}
            selectedID={graphSelectedID()}
            activeRoot={graphActiveRoot()}
            activeLabel={graphActiveLabel()}
            projectPosition={graphProjectPosition()}
            workspaces={graphWorkspaceSelection()}
            showAll={graphView().showIsolates}
            zoom={graphViewport().zoom}
            focused={graphFocused()}
            searching={graphSearching()}
            query={graphQuery()}
            searchMatches={graphSearchMatches()}
            onSelect={selectGraphFact}
            onFocus={() => setGraphFocused(true)}
            onEmergencyExit={leaveGraph}
            onPan={panGraph}
            onPreviousProject={() => cycleGraphProject(-1)}
            onNextProject={() => cycleGraphProject(1)}
            onChooseProject={showGraphProjectPicker}
            onToggleAll={() => updateGraphView({ showIsolates: !graphView().showIsolates })}
            onBeginSearch={() => {
              setGraphQuery("")
              setGraphSearching(true)
            }}
            onRefresh={() => void reload("Memory graph refreshed").catch((err) => toast.error(err))}
          />
        </Show>
      </Match>
      <Match when={tab() === "rules"}>
        <box flexDirection="column" minHeight={0} flexGrow={1} gap={1}>
          <Panel title="Rules & categories" grow>
            <PolicyRows data={current} selectedIndex={selectedIndex()} width={Math.max(30, availableWidth - 4)} policyScope={policyScope()} limit={policyRowLimit()} onSelect={setSelectedIndex} />
          </Panel>
          <box height={inspectorHeight()} minHeight={0}>
            <Inspector selection={selection()} width={Math.max(30, availableWidth - 4)} policyScope={policyScope()} />
          </box>
        </box>
      </Match>
      <Match when={tab() === "dream"}>
        <Show
          when={dreamDetailOpen() && selectedDreamDetail()}
          fallback={<DreamContent data={current} schedule={dreamSchedule()} width={availableWidth} selectedIndex={selectedIndex()} limit={dreamRunRowLimit()} onSelectRun={setSelectedIndex} />}
        >
          <box flexDirection="column" minHeight={0} flexGrow={1} gap={1}>
            <box height={1} overflow="hidden">
              <text fg={theme.primary} wrapMode="none" onMouseUp={() => setDreamDetailOpen(false)}>Dream runs / {selectedDreamDetail()?.run.id ?? "run"} · Esc back</text>
            </box>
            <Panel title={`Dream run · ${dreamRunStatusLabel(selectedDreamDetail()!.run.status)}`} grow>
            <DreamRunDetailContent
                detail={selectedDreamDetail()!}
                width={availableWidth - 4}
                onApplyGraphProposal={(runID, proposalID) => void applySelectedGraphProposal(runID, proposalID).catch((err) => toast.error(err))}
                onRejectGraphProposal={(runID, proposalID) => void rejectSelectedGraphProposal(runID, proposalID).catch((err) => toast.error(err))}
              />
            </Panel>
          </box>
        </Show>
      </Match>
    </Switch>
  )

  return (
    <box flexDirection="column" width="100%" height="100%" paddingLeft={deck().wide ? 0 : 2} paddingRight={deck().wide ? 0 : 2} paddingTop={1} paddingBottom={1} gap={deck().wide ? 0 : 1}>
      <Show when={deck().wide}>
        <Show when={data()} fallback={<LoadingMemory tiny={false} />}>
          {(current) => (
            <CommandDeck
              page="memory"
              subtitle={() => `${tab()} · ${activeContext()}`}
              status={() => overview.error ? "ERROR" : live() ? "LIVE" : "PAUSED"}
               summary={() => `${current().facts.length} facts · ${pending().length} pending · ${graphOverview()?.links.length ?? 0} edges`}
                footer={() => {
                  const compact = width() < 120
                  if (tab() === "graph") {
                    return compact
                      ? "Arrows Pan · HJKL Select · P Project · / Find · +/- Zoom · R Refresh · Esc/Q Back"
                      : "Arrows Pan · HJKL Select · Enter Focus · P Project · [/] Cycle · +/- Zoom · / Find · I Isolates · V Review · R Refresh · Esc/Q Back"
                  }
                  return compact
                    ? "↑↓/JK Select · ←→/HL Tabs · 1-4 Tabs · P Policy · V Review · R Refresh · Q Back"
                    : "↑↓/JK Select · ←→/HL Tabs · 1-4 Tabs · Enter Open · E Edit · A Apply · X Reject · P Policy · O Prompt · V Review · R Refresh · Q Back"
                }}
               rail={

                <Sidebar
                  data={baseOverview() ?? current()}
                  currentRoot={currentRoot()}
                  activeRoot={activeRoot()}
                  selectedWorkspaceID={selectedWorkspaceID()}
                  scope={memoryScope()}
                  width={Math.max(22, deck().railWidth - 2)}
                  height="100%"
                  onSelectWorkspace={(id) => {
                    setSelectedWorkspaceID(id)
                    setSelectedIndex(0)
                    selectMemoryScope("current")
                  }}
                  onScope={selectMemoryScope}
                />
               }

            >
              <box flexDirection="column" minHeight={0} flexGrow={1} gap={1}>
                <TabBar tab={tab()} width={deck().contentWidth} onSelect={(next) => {
                  setTab(next)
                  setSelectedIndex(0)
                  setDreamDetailOpen(false)
                  setGraphFocused(false)
                }} />
                <box flexGrow={1} minHeight={0}>
                  {renderMain(current(), deck().contentWidth)}
                </box>
                <Show when={tab() === "memories"}>
                  <box height={inspectorHeight()} minHeight={0}>
                    <Inspector
                      selection={selection()}
                      width={Math.max(32, deck().contentWidth - 4)}
                      policyScope={policyScope()}
                      onApplyProposal={() => void applySelectedProposal().catch((err) => toast.error(err))}
                      onRejectProposal={() => void rejectSelectedProposal().catch((err) => toast.error(err))}
                      onApplyGraphProposal={(runID, proposalID) => void applySelectedGraphProposal(runID, proposalID).catch((err) => toast.error(err))}
                      onRejectGraphProposal={(runID, proposalID) => void rejectSelectedGraphProposal(runID, proposalID).catch((err) => toast.error(err))}
                      onEditSelection={() => void editSelection().catch((err) => toast.error(err))}
                    />
                  </box>
                </Show>
              </box>
            </CommandDeck>
          )}
        </Show>
      </Show>
      <Show when={!deck().wide}>
      <Header root={tab() === "graph" ? graphActiveRoot() : activeRoot()} tab={tab()} narrow={width() < 118} live={live()} pending={pending().length} onReview={() => command.trigger("mendcode.memory.status")} />
      <Show when={data()} fallback={<LoadingMemory tiny={tiny()} />}>
        {(current) => (
          <box flexDirection="column" minHeight={0} flexGrow={1} gap={1}>
            <TabBar tab={tab()} width={contentWidth()} onSelect={(next) => {
              setTab(next)
              setSelectedIndex(0)
              setDreamDetailOpen(false)
              setGraphFocused(false)
            }} />
            <Switch>
              <Match when={tab() === "graph" || tab() === "dream" || tab() === "rules"}>
                {renderMain(current())}
              </Match>
              <Match when={wide()}>
                <box flexDirection="row" minHeight={0} flexGrow={1} gap={1}>
                  <Sidebar
                    data={baseOverview() ?? current()}
                    currentRoot={currentRoot()}
                    activeRoot={activeRoot()}
                    selectedWorkspaceID={selectedWorkspaceID()}
                    scope={memoryScope()}
                    width={sidebarWidth()}
                    onSelectWorkspace={(id) => {
                      setSelectedWorkspaceID(id)
                      setSelectedIndex(0)
                      selectMemoryScope("current")
                    }}
                    onScope={selectMemoryScope}
                  />
                  <box flexDirection="column" minWidth={0} minHeight={0} flexGrow={1} gap={1}>
                    <box flexGrow={1} minHeight={0}>
                      {renderMain(current())}
                    </box>
                    <box height={inspectorHeight()} minHeight={0}>
                      <Inspector
                        selection={selection()}
                        width={mainContentWidth()}
                        policyScope={policyScope()}
                        onApplyProposal={() => void applySelectedProposal().catch((err) => toast.error(err))}
                        onRejectProposal={() => void rejectSelectedProposal().catch((err) => toast.error(err))}
                        onApplyGraphProposal={(runID, proposalID) => void applySelectedGraphProposal(runID, proposalID).catch((err) => toast.error(err))}
                        onRejectGraphProposal={(runID, proposalID) => void rejectSelectedGraphProposal(runID, proposalID).catch((err) => toast.error(err))}
                        onEditSelection={() => void editSelection().catch((err) => toast.error(err))}
                      />
                    </box>
                  </box>
                 </box>
              </Match>
              <Match when={medium()}>
                <box flexDirection="row" minHeight={0} flexGrow={1} gap={1}>
                  <Sidebar
                    data={baseOverview() ?? current()}
                    currentRoot={currentRoot()}
                    activeRoot={activeRoot()}
                    selectedWorkspaceID={selectedWorkspaceID()}
                    scope={memoryScope()}
                    width={sidebarWidth()}
                    onSelectWorkspace={(id) => {
                      setSelectedWorkspaceID(id)
                      setSelectedIndex(0)
                      selectMemoryScope("current")
                    }}
                    onScope={selectMemoryScope}
                  />
                  <box flexDirection="column" minWidth={0} minHeight={0} flexGrow={1} gap={1}>
                    {renderMain(current())}
                    <box height={inspectorHeight()} minHeight={0}>
                      <Inspector
                        selection={selection()}
                        width={Math.max(40, contentWidth() - 36)}
                        policyScope={policyScope()}
                        onApplyProposal={() => void applySelectedProposal().catch((err) => toast.error(err))}
                        onRejectProposal={() => void rejectSelectedProposal().catch((err) => toast.error(err))}
                        onApplyGraphProposal={(runID, proposalID) => void applySelectedGraphProposal(runID, proposalID).catch((err) => toast.error(err))}
                        onRejectGraphProposal={(runID, proposalID) => void rejectSelectedGraphProposal(runID, proposalID).catch((err) => toast.error(err))}
                        onEditSelection={() => void editSelection().catch((err) => toast.error(err))}
                      />
                    </box>
                  </box>
                </box>
              </Match>
              <Match when={true}>
                <scrollbox
                  flexGrow={1}
                  minHeight={0}
                  horizontalScrollbarOptions={{ visible: false }}
                  verticalScrollbarOptions={{
                    visible: true,
                    trackOptions: {
                      backgroundColor: theme.backgroundPanel,
                      foregroundColor: theme.border,
                    },
                  }}
                >
                  <box flexDirection="column" minHeight={0} gap={1}>
                    <Sidebar
                      data={baseOverview() ?? current()}
                      currentRoot={currentRoot()}
                      activeRoot={activeRoot()}
                      selectedWorkspaceID={selectedWorkspaceID()}
                      scope={memoryScope()}
                      width={contentWidth()}
                      height={tiny() ? 7 : 9}
                      onSelectWorkspace={(id) => {
                        setSelectedWorkspaceID(id)
                        setSelectedIndex(0)
                        selectMemoryScope("current")
                      }}
                      onScope={selectMemoryScope}
                    />
                    <box height={tiny() ? 22 : 26} minHeight={0}>
                      {renderMain(current())}
                    </box>
                    <box height={inspectorHeight()} minHeight={0}>
                      <Inspector
                        selection={selection()}
                        width={contentWidth()}
                        policyScope={policyScope()}
                        onApplyProposal={() => void applySelectedProposal().catch((err) => toast.error(err))}
                        onRejectProposal={() => void rejectSelectedProposal().catch((err) => toast.error(err))}
                        onApplyGraphProposal={(runID, proposalID) => void applySelectedGraphProposal(runID, proposalID).catch((err) => toast.error(err))}
                        onRejectGraphProposal={(runID, proposalID) => void rejectSelectedGraphProposal(runID, proposalID).catch((err) => toast.error(err))}
                        onEditSelection={() => void editSelection().catch((err) => toast.error(err))}
                      />
                    </box>
                  </box>
                </scrollbox>
              </Match>
            </Switch>
          </box>
        )}
      </Show>
      </Show>
      <Show when={overview.error}>
        <text fg={theme.error} wrapMode="none">
          {short(String(overview.error), contentWidth())}
        </text>
      </Show>
    </box>
  )
}
