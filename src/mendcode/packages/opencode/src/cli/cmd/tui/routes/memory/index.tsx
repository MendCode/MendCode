import { createEffect, createMemo, createResource, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { BoxRenderable, MouseButton, MouseEvent, type ScrollBoxRenderable, type TextareaRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { asciiGraphNearestNode, asciiGraphRuns, layoutAsciiGraph, renderAsciiGraph, type AsciiGraphCell } from "@mendcode/plugin/tui"
import { memoryOverview } from "@/mend/memory/overview"
import { applyMemoryProposal, rejectMemoryProposal, updateMemoryProposal, type MemoryProposal } from "@/mend/memory/proposals"
import { deleteMemoryEntry, updateMemoryEntry, type MemoryEntry } from "@/mend/memory/store"
import {
  listMemorySideChats,
  createMemorySideChatSession,
  readMemorySideChat,
  sendMemorySideChatMessage,
  startMemorySideChat,
  type MemorySideChatResponder,
  type MemorySideChatSession,
} from "@/mend/memory/side-chat"
import { registerMemoryWorkspace, type MemoryWorkspace } from "@/mend/memory/workspaces"
import { writeMemoryCategoryPolicy, type MemoryCategoryPolicy, type MemoryPolicyScope, type MemoryWritePolicy } from "@/mend/memory/categories"
import { applyDreamGraphProposal, rejectDreamGraphProposal } from "@/mend/memory/dream"
import { readDreamScheduleState, type DreamScheduleState, type DreamScheduleWindow } from "@/mend/memory/dream-scheduler"
import { Locale } from "@/util/locale"
import { useProject } from "@tui/context/project"
import { routeReturnTarget, useRoute } from "@tui/context/route"
import { useSDK } from "@tui/context/sdk"
import { useTheme } from "@tui/context/theme"
import { useTextareaKeybindings } from "@tui/component/textarea-keybindings"
import { DialogConfirm } from "@tui/ui/dialog-confirm"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { useToast } from "@tui/ui/toast"

type MemoryOverview = Awaited<ReturnType<typeof memoryOverview>>
type DreamRunDetailView = MemoryOverview["dreamRunDetails"][number]
type MemoryTab = "overview" | "project" | "global" | "graph" | "policy" | "dream"
type Selection =
  | { kind: "entry"; entry: MemoryEntry }
  | { kind: "proposal"; proposal: MemoryProposal }
  | { kind: "policy"; category: MemoryOverview["categories"][number]; policy: MemoryCategoryPolicy }
  | { kind: "dream"; detail: DreamRunDetailView | null }
  | { kind: "overview" }

const TABS: Array<{ id: MemoryTab; label: string; compactLabel: string }> = [
  { id: "overview", label: "Overview", compactLabel: "Overview" },
  { id: "project", label: "Project memories", compactLabel: "Project" },
  { id: "global", label: "Global memories", compactLabel: "Global" },
  { id: "graph", label: "Graph", compactLabel: "Graph" },
  { id: "policy", label: "Policy & categories", compactLabel: "Policy" },
  { id: "dream", label: "Dream", compactLabel: "Dream" },
]

const WRITE_POLICIES: MemoryWritePolicy[] = ["disabled", "pending", "auto-apply-safe", "manual-only"]
const ENTRY_ROW_LIMIT = 11
const PROPOSAL_ROW_LIMIT = 10
const POLICY_ROW_LIMIT = 12
const DREAM_RUN_ROW_LIMIT = 8

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

async function askMemorySideChat(
  sdk: ReturnType<typeof useSDK>,
  root: string,
  payload: Parameters<MemorySideChatResponder>[0],
) {
  const headers = new Headers(sdk.headers)
  headers.set("content-type", "application/json")
  const url = new URL("/memory/side-chat", sdk.url)
  if (sdk.directory) url.searchParams.set("directory", sdk.directory)
  const response = await sdk.fetch(url.toString(), {
    method: "POST",
    headers,
    body: JSON.stringify({
      root,
      message: payload.message,
      history: payload.history,
      context: payload.context,
    }),
    signal: payload.signal,
  })
  if (!response.ok) {
    return { text: `memory side chat failed: ${response.status} ${response.statusText}`, actions: [] }
  }
  const json = await response.json().catch(() => null) as Awaited<ReturnType<MemorySideChatResponder>> | null
  return {
    text: typeof json?.text === "string" && json.text.trim() ? json.text : "No memory assistant response.",
    actions: Array.isArray(json?.actions) ? json.actions : [],
  }
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
}) {
  return !input.dialogOpen && input.defaultPrevented !== true && input.textInputActive !== true
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
  const essentials = [
    { key: "↑↓←→", label: "select" },
    { key: "F", label: "find" },
    { key: "P", label: "projects" },
    { key: "I", label: "isolates" },
    { key: "Esc", label: "back" },
  ]
  if (width < 72) return essentials
  return [
    essentials[0]!,
    { key: "Click", label: "focus" },
    ...essentials.slice(1, 4),
    { key: "+/-", label: "zoom" },
    { key: "[ ]", label: "cycle" },
    { key: "R", label: "refresh" },
    essentials[4]!,
  ]
}

function comparableRoot(root: string) {
  return root.replace(/\/+$/, "")
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

export function sideChatInputArtifacts(value: string) {
  const text = value.trim()
  if (!text) return []
  const artifacts: string[] = []
  const markdownImageRefs = text.match(/!\[[^\]]*]\([^)]+\)/gi)?.length ?? 0
  const dataImageRefs = text.match(/data:image\/[a-z0-9.+-]+;base64,/gi)?.length ?? 0
  const imagePathRefs = text.match(/(?:^|\s)(?:\/[^\s]+|[A-Za-z0-9_.-]+\/[^\s]+)\.(?:png|jpe?g|gif|webp|heic|svg)(?=\s|$)/gi)?.length ?? 0
  const filePathRefs = text.match(/(?:^|\s)(?:\/[^\s]+|[A-Za-z0-9_.-]+\/[^\s]+)\.(?:pdf|txt|md|json|csv|log|tsx?|jsx?|py|rs|go|yaml|yml)(?=\s|$)/gi)?.length ?? 0
  const imageRefs = Math.max(markdownImageRefs, dataImageRefs) + imagePathRefs
  if (imageRefs > 0) artifacts.push(`pasted image ref${imageRefs === 1 ? "" : "s"} · ${imageRefs}`)
  if (filePathRefs > 0) artifacts.push(`pasted file ref${filePathRefs === 1 ? "" : "s"} · ${filePathRefs}`)
  const lineCount = text.split(/\r?\n/).length
  if (lineCount >= 3 || text.length >= 400) artifacts.push(`pasted text · ${lineCount} lines · ${Locale.number(text.length)} chars`)
  return artifacts
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
  retrievalPriority?: number
  materialized?: boolean
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
}) {
  const width = Math.max(20, Math.min(180, Math.floor(input.width)))
  const height = Math.max(6, Math.min(72, Math.floor(input.height ?? 10)))
  const materializedFacts = input.facts.filter((fact) => fact.materialized !== false)
  const legacyDerivedFacts = input.facts.length - materializedFacts.length
  const linkedIDs = new Set(input.links.flatMap((link) => [link.from, link.to]))
  const isolatedFacts = materializedFacts.filter((fact) => !linkedIDs.has(fact.id))
  const graphFacts = input.connectedOnly ? materializedFacts.filter((fact) => linkedIDs.has(fact.id)) : materializedFacts
  const scene = layoutAsciiGraph({
    nodes: graphFacts.map((fact) => ({
      id: fact.id,
      label: memoryPreviewText(fact.text, width < 44 ? 18 : 26),
      group: fact.categoryIDs[0] ?? "uncategorized",
      weight: Math.max(0, 10 - (fact.retrievalPriority ?? 10)),
    })),
    edges: input.links,
    maxNodes: width < 44 ? 10 : width < 64 ? 16 : 24,
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
      stats: `connected 0 · isolated ${isolatedFacts.length} · visible 0/${materializedFacts.length}`,
      status: `${materializedFacts.length}/${input.facts.length} materialized · ${legacyDerivedFacts} legacy-derived · 0/${input.links.length} links`,
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
    viewport: { zoom: Math.max(0.4, Math.min(4, input.zoom ?? 1)) },
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
    stats: `connected ${connectedIDs.size} · isolated ${isolatedFacts.length} · visible ${facts.length}/${materializedFacts.length}`,
    status: `${materializedFacts.length}/${input.facts.length} materialized · ${legacyDerivedFacts} legacy-derived · ${facts.length}/${materializedFacts.length} visible · ${explicitLinks.length}/${input.links.length} links · ${categories.length} categories`,
  }
}

function memoryGraphMiniMapLabel(fact: MemoryGraphMiniFact, max: number) {
  return memoryPreviewText(fact.text, max)
}

type MemoryGraphWorkspaceRef = Pick<MemoryWorkspace, "id" | "root" | "displayName">

export function memoryGraphFactProjectLabels(input: {
  fact: Pick<MemoryOverview["facts"][number], "scope" | "ownerWorkspaceIDs">
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
  facts: MemoryOverview["facts"]
  query: string
  projectLabel: (fact: MemoryOverview["facts"][number]) => string
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
  const palette = () => [theme.primary, theme.secondary, theme.accent, theme.success, theme.info, theme.warning]
  const color = (cell: Omit<AsciiGraphCell, "char">) => {
    if (cell.kind === "selected") return theme.primary
    if (cell.kind === "conflict") return theme.warning
    if (cell.kind === "edge") return theme.borderActive
    if (cell.kind === "label") return theme.text
    if (cell.kind === "node") return palette()[(categoryIndex().get(cell.group ?? "") ?? 0) % palette().length] ?? theme.primary
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

function Header(props: { root: string; tab: MemoryTab; narrow: boolean; live: boolean }) {
  const { theme } = useTheme()
  const tab = () => TABS.find((item) => item.id === props.tab)?.label ?? "Memory"
  const status = () => `MendCode · ${tab()} · SSE ${props.live ? "live" : "waiting"}`
  const shortcuts = props.tab === "graph"
    ? "/memory-graph"
    : "1-6 tabs · ↑↓ select · e edit · c side chat · esc"
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
            {short(shortcuts, 72)}
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
            <text fg={theme.textMuted} wrapMode="none">
              events refresh automatically
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

function GraphCommandBar(props: { width: number }) {
  const { theme } = useTheme()
  const hints = createMemo(() => memoryGraphCommandHints(props.width))
  return (
    <box height={1} flexShrink={0} overflow="hidden">
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
    </box>
  )
}

function Sidebar(props: {
  data: MemoryOverview
  currentRoot: string
  activeRoot: string
  selectedWorkspaceID: string | null
  width: number
  height?: number | `${number}%`
  onSelectWorkspace: (id: string | null) => void
  onTab: (tab: MemoryTab) => void
}) {
  const { theme } = useTheme()
  const workspaces = () => memorySidebarProjectWorkspaces({
    currentRoot: props.currentRoot,
    workspaces: props.data.workspaces?.activeWorkspaces ?? [],
  })
  const groups = () => props.data.workspaces?.activeGroups ?? []
  return (
    <Panel title="Projects" width={props.width} height={props.height}>
      <box flexDirection="column" minHeight={0} flexGrow={1} overflow="hidden" gap={1}>
        <box height={2} overflow="hidden" onMouseUp={() => props.onSelectWorkspace(null)}>
          <text fg={props.selectedWorkspaceID === null ? theme.success : theme.text} wrapMode="none">
            {short("Current project", props.width - 4)}
          </text>
          <text fg={theme.textMuted} wrapMode="none">
            {short(props.currentRoot, props.width - 4)}
          </text>
        </box>

        <box height={1} overflow="hidden" onMouseUp={() => props.onTab("global")}>
          <text fg={theme.primary} wrapMode="none">
            {short(`Global memories · ${props.data.globalEntries.length}`, props.width - 4)}
          </text>
        </box>

        <Show when={groups().length > 0}>
          <text fg={theme.textMuted} wrapMode="none">
            Groups
          </text>
          <For each={groups().slice(0, 4)}>
            {(group) => (
              <text fg={theme.textMuted} wrapMode="none">
                {short(`${group.label} · ${group.workspaceIDs.length}`, props.width - 4)}
              </text>
            )}
          </For>
        </Show>

        <text fg={theme.textMuted} wrapMode="none">
          Other project memories
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
                  <box height={2} overflow="hidden" onMouseUp={() => props.onSelectWorkspace(workspace.id)}>
                    <text fg={props.selectedWorkspaceID === workspace.id ? theme.success : theme.text} wrapMode="none">
                      {short(workspace.displayName, props.width - 4)}
                    </text>
                    <text fg={theme.textMuted} wrapMode="none">
                      {short(workspace.root, props.width - 4)}
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

function KpiStrip(props: { data: MemoryOverview; pending: MemoryProposal[]; width: number; stacked?: boolean }) {
  const { theme } = useTheme()
  const cards = () => [
    stat("saved", String(props.data.globalEntries.length + props.data.projectEntries.length), `${props.data.globalEntries.length} global · ${props.data.projectEntries.length} project`),
    stat("pending", String(props.pending.length), `${props.data.proposals.length} proposals`),
    stat("projects", String(props.data.workspaces?.activeWorkspaces.length ?? 0), `${props.data.workspaces?.activeGroups.length ?? 0} groups`),
    stat("dream", props.data.dream?.status ?? "none", props.data.dream ? `${props.data.dream.proposals.length} proposals` : "idle"),
  ]
  if (props.stacked) {
    return (
      <Panel title="Memory activity" height={8}>
        <MetricRows width={props.width - 4} items={cards()} />
      </Panel>
    )
  }
  return (
    <box flexDirection="row" height={5} overflow="hidden" gap={1}>
      <For each={cards()}>
        {(item, index) => (
          <box flexDirection="column" flexGrow={1} minWidth={0} overflow="hidden" borderStyle="single" borderColor={theme.border} paddingLeft={1} paddingRight={1}>
            <text fg={theme.primary} wrapMode="none">
              {item.label}
            </text>
            <text fg={index() === 0 ? theme.success : theme.text} wrapMode="none">
              {short(item.value, Math.max(6, props.width / 4 - 4))}
            </text>
            <text fg={theme.textMuted} wrapMode="none">
              {short(item.detail, Math.max(6, props.width / 4 - 4))}
            </text>
          </box>
        )}
      </For>
    </box>
  )
}

type MemoryGraphFrame = ReturnType<typeof memoryGraphMiniMap>

function MemoryGraphExplorer(props: {
  data: MemoryOverview
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
  searching: boolean
  query: string
  searchMatches: MemoryOverview["facts"]
  onSelect: (id: string) => void
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
  const healthLine = createMemo(() => `${health().graphHealth} · ${props.frame.stats} · ${props.frame.scene.edges.length} persisted links`)
  const selectedFact = createMemo(() => props.data.facts.find((fact) => fact.id === props.selectedID))
  const selectedLinks = createMemo(() => props.data.links.flatMap((link) => {
    if (link.from !== props.selectedID && link.to !== props.selectedID) return []
    const outbound = link.from === props.selectedID
    const otherID = outbound ? link.to : link.from
    const fact = props.data.facts.find((candidate) => candidate.id === otherID)
    return fact ? [{ link, fact, outbound }] : []
  }))
  const categoryLabel = (id: string) => props.data.categories.find((category) => category.id === id)?.label ?? id
  const projectLabels = (fact: MemoryOverview["facts"][number]) => memoryGraphFactProjectLabels({
    fact,
    workspaces: props.workspaces,
    activeRoot: props.activeRoot,
    activeLabel: props.activeLabel,
  })
  let canvasBox: BoxRenderable | undefined

  function mouse(event: MouseEvent) {
    if (!canvasBox || event.button !== MouseButton.LEFT || event.type !== "down") return
    const x = event.x - canvasBox.x
    const y = event.y - canvasBox.y
    const hit = Object.entries(props.frame.nodeCells)
      .map(([id, point]) => ({ id, distance: Math.hypot(point.x - x, point.y - y) }))
      .filter((item) => item.distance <= 2)
      .toSorted((a, b) => a.distance - b.distance)[0]
    if (!hit) return
    props.onSelect(hit.id)
    event.preventDefault()
    event.stopPropagation()
  }

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
            <text fg={theme.textMuted}>Project </text>
            <text fg={theme.primary} onMouseUp={props.onPreviousProject}>‹ </text>
            <text fg={theme.success} wrapMode="none" onMouseUp={props.onChooseProject}>{short(props.activeLabel, 28)}</text>
            <text fg={theme.primary} onMouseUp={props.onNextProject}> ›</text>
            <text fg={theme.textMuted} wrapMode="none"> · {props.projectPosition}</text>
          </box>
          <text fg={theme.textMuted} wrapMode="none">{short(props.activeRoot, Math.max(24, props.width - 74))}</text>
        </box>
        <box flexDirection="column" alignItems="flex-end" overflow="hidden">
          <text fg={props.showAll ? theme.success : theme.text} wrapMode="none" onMouseUp={props.onToggleAll}>
            {props.showAll ? "Including isolates" : "Connected network"} · {props.frame.scene.nodes.length}/{props.data.materializedFactCount}
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
                  {props.frame.emptyState === "legacy-only" ? "Legacy-derived memories exist, but no graph facts are materialized." : "No persisted relationships for this project yet."}
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
              borderColor={theme.border}
              overflow="hidden"
              onMouse={mouse}
            >
              <MemoryGraphCanvasRows cells={props.frame.cells} categories={props.data.categories} />
            </box>
          </Show>
          <text fg={healthTone()} wrapMode="none">{short(healthLine(), props.canvasWidth)}</text>
          <Show when={roomy()}>
            <text fg={theme.textMuted} wrapMode="none">{short(props.frame.legend.join(" · ") || "No active graph categories", props.canvasWidth)}</text>
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

      <GraphCommandBar width={props.width} />
    </box>
  )
}

function EntryRows(props: {
  entries: MemoryEntry[]
  selectedIndex: number
  width: number
  onSelect: (index: number) => void
}) {
  const { theme } = useTheme()
  return (
    <Show
      when={props.entries.length > 0}
      fallback={<text fg={theme.textMuted}>No saved memory in this scope.</text>}
    >
      <box flexDirection="column" gap={1} overflow="hidden">
        <For each={props.entries.slice(0, ENTRY_ROW_LIMIT)}>
          {(entry, index) => {
            const selected = () => props.selectedIndex === index()
            return (
              <box height={2} overflow="hidden" onMouseUp={() => props.onSelect(index())}>
                <box flexDirection="row" justifyContent="space-between" height={1} overflow="hidden">
                  <text fg={selected() ? theme.success : entry.scope === "global" ? theme.primary : theme.text} wrapMode="none">
                    {short(`${entry.scope} · ${memoryOriginLabel(entry.source)} · ${(entry.categoryIDs ?? ["uncategorized"])[0] ?? "uncategorized"}`, Math.max(16, props.width - 18))}
                  </text>
                  <text fg={theme.textMuted} wrapMode="none">
                    {formatDate(entry.updatedAt)}
                  </text>
                </box>
                <text fg={selected() ? theme.text : theme.textMuted} wrapMode="none">
                  {memoryPreviewText(entry.text, props.width)}
                </text>
              </box>
            )
          }}
        </For>
      </box>
    </Show>
  )
}

function ProposalRows(props: {
  proposals: MemoryProposal[]
  selectedIndex: number
  width: number
  onSelect: (index: number) => void
}) {
  const { theme } = useTheme()
  return (
    <Show
      when={props.proposals.length > 0}
      fallback={
        <box flexDirection="column" flexGrow={1} justifyContent="center" overflow="hidden" gap={1}>
          <text fg={theme.textMuted} wrapMode="none">
            No pending generated memories.
          </text>
          <text fg={theme.primary} wrapMode="none">
            Side chat and Dream proposals land here.
          </text>
        </box>
      }
    >
      <box flexDirection="column" gap={1} overflow="hidden">
        <For each={props.proposals.slice(0, PROPOSAL_ROW_LIMIT)}>
          {(proposal, index) => {
            const selected = () => props.selectedIndex === index()
            return (
              <box
                height={selected() ? 3 : 2}
                overflow="hidden"
                onMouseDown={() => props.onSelect(index())}
                onMouseUp={() => props.onSelect(index())}
              >
                <box flexDirection="row" justifyContent="space-between" height={1} overflow="hidden">
                  <text fg={selected() ? theme.success : theme.warning} wrapMode="none">
                    {short(`${proposal.operation} · ${proposal.scope} · ${memoryOriginLabel(proposal.source)} · ${proposal.categoryIDs[0] ?? "uncategorized"}`, Math.max(18, props.width - 18))}
                  </text>
                  <text fg={theme.textMuted} wrapMode="none">
                    {Math.round(proposal.confidence * 100)}%
                  </text>
                </box>
                <text fg={selected() ? theme.text : theme.textMuted} wrapMode="none">
                  {memoryPreviewText(proposal.text, props.width)}
                </text>
                <Show when={selected()}>
                  <text fg={theme.primary} wrapMode="none">
                    {short("a apply · x reject · e edit · details below", props.width)}
                  </text>
                </Show>
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
  onSelect: (index: number) => void
}) {
  const { theme } = useTheme()
  const rows = () => props.data.categories.map((category) => ({ category, policy: props.data.policies[category.id]! }))
  return (
    <box flexDirection="column" gap={1} overflow="hidden">
      <box height={1} overflow="hidden">
        <text fg={theme.textMuted} wrapMode="none">
          {short(`editing ${props.policyScope} policies · p cycle write mode · o prompt on/off`, props.width)}
        </text>
      </box>
      <For each={rows().slice(0, POLICY_ROW_LIMIT)}>
        {(row, index) => {
          const selected = () => props.selectedIndex === index()
          return (
            <box height={2} overflow="hidden" onMouseUp={() => props.onSelect(index())}>
              <box flexDirection="row" justifyContent="space-between" height={1} overflow="hidden">
                <text fg={selected() ? theme.success : theme.text} wrapMode="none">
                  {short(row.category.label, Math.max(14, props.width - 30))}
                </text>
                <text fg={row.policy.promptEnabled ? theme.primary : theme.textMuted} wrapMode="none">
                  {row.policy.promptEnabled ? "prompt:on" : "prompt:off"}
                </text>
              </box>
              <text fg={theme.textMuted} wrapMode="none">
                {short(`${row.policy.writePolicy} · priority ${row.policy.promptPriority} · ${row.category.description}`, props.width)}
              </text>
            </box>
          )
        }}
      </For>
    </box>
  )
}

function OverviewContent(props: {
  data: MemoryOverview
  pending: MemoryProposal[]
  selectedIndex: number
  width: number
  stacked?: boolean
  onSelectProposal: (index: number) => void
}) {
  return (
    <box flexDirection="column" gap={1} minHeight={0} flexGrow={1}>
      <KpiStrip data={props.data} pending={props.pending} width={props.width} stacked={props.stacked} />
      <box flexDirection="column" gap={1} minHeight={0} flexGrow={1}>
        <Panel title="Pending Queue" grow>
          <ProposalRows proposals={props.pending} selectedIndex={props.selectedIndex} width={Math.max(30, props.width - 6)} onSelect={props.onSelectProposal} />
        </Panel>
      </box>
    </box>
  )
}

function dreamWindowLabel(window: DreamScheduleWindow | null | undefined) {
  if (!window || !window.enabled) return "not scheduled"
  const zone = window.timezone ? ` ${window.timezone}` : ""
  if (window.start === window.end) return `fixed ${window.start}${zone}`
  return `window ${window.start}-${window.end}${zone}`
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
    }).slice(-3))
  }
  if (detail.decisions.length) {
    rows.push(...detail.decisions.slice(-3).map((decision) => ({
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
  return rows.toSorted((a, b) => a.at.localeCompare(b.at)).slice(-10)
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
    safety: null,
  } satisfies DreamRunDetailView
}

function DreamContent(props: {
  data: MemoryOverview
  schedule: DreamScheduleState | null | undefined
  width: number
  selectedIndex: number
  onSelectRun: (index: number) => void
}) {
  const { theme } = useTheme()
  const dream = () => props.data.dream
  const details = () => props.data.dreamRunDetails ?? []
  const runs = () => details().length ? details() : (props.data.dreamRuns ?? []).map(fallbackDreamRunDetail)
  const schedule = () => props.schedule
  return (
    <box flexDirection="column" gap={1} minHeight={0} flexGrow={1}>
      <Panel title="Dream overview" height={10}>
        <box flexDirection="row" gap={2} height={4} overflow="hidden">
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
              proposals
            </text>
          </box>
        </box>
        <text fg={theme.primary} wrapMode="none">
          {short(`Dream write policy: ${props.data.config.dreamWritePolicy} · default is reviewable proposals.`, props.width)}
        </text>
        <text fg={theme.textMuted} wrapMode="none">
          {memoryPreviewText(`latest activity: ${props.data.dreamLatestActivity ? `${props.data.dreamLatestActivity.kind} · ${props.data.dreamLatestActivity.summary}` : "none"}`, props.width)}
        </text>
        <text fg={theme.textMuted} wrapMode="none">
          {short(`source ${dream()?.source ?? schedule()?.reason ?? "not scheduled"} · last ${dream() ? formatDate(dream()!.startedAt) : "none"}`, props.width)}
        </text>
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
            <For each={runs().slice(0, DREAM_RUN_ROW_LIMIT)}>
              {(detail, index) => {
                const run = () => detail.run
                const selectedRun = () => props.selectedIndex === index()
                const color = () => dreamRunStatusTone(run().status, theme)
                const reads = () => detail.safety?.reads.length ?? detail.evidence.length
                const redactions = () => detail.safety?.redactions ?? 0
                const duration = () => durationLabel(run().startedAt, run().completedAt)
                const skipped = () => dreamSkippedDecisionCount(detail)
                return (
                  <box height={4} overflow="hidden" onMouseUp={() => props.onSelectRun(index())}>
                    <box flexDirection="row" justifyContent="space-between" height={1} overflow="hidden">
                      <text fg={selectedRun() ? theme.success : color()} wrapMode="none">
                        {short(`${selectedRun() ? "› " : "  "}${dreamRunStatusLabel(run().status)} · ${run().workspaceID ?? "global"}`, Math.max(18, props.width - 24))}
                      </text>
                      <text fg={theme.textMuted} wrapMode="none">
                        {short(`${formatDate(run().completedAt ?? run().startedAt)} ${formatTime(run().completedAt ?? run().startedAt)}`, 18)}
                      </text>
                    </box>
                    <text fg={selectedRun() ? theme.text : theme.textMuted} wrapMode="none">
                      {short(`${dreamRunProposalCount(detail)} proposals · ${detail.graphProposals.length} graph · ${skipped()} skipped · ${detail.evidence.length} evidence · ${reads()} reads · ${redactions()} redactions${duration() ? ` · ${duration()}` : ""}`, props.width)}
                    </text>
                    <text fg={theme.textMuted} wrapMode="none">
                      {memoryPreviewText(detail.events.at(-1)?.message ?? run().failureReason ?? run().id, props.width)}
                    </text>
                    <Show when={selectedRun()}>
                      <text fg={theme.primary} wrapMode="none">
                        {short(`inspecting ${run().id}`, props.width)}
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
    <Panel title="Inspector" grow>
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
          <Match when={props.selection.kind === "entry" ? props.selection.entry : undefined}>
            {(entry) => (
              <box flexDirection="column" gap={1} overflow="hidden">
              <MetricRows
                width={props.width}
                items={[
                  stat("scope", entry().scope),
                  stat("category", (entry().categoryIDs ?? ["uncategorized"]).join(", ")),
                  stat("confidence", `${Math.round(entry().confidence * 100)}%`),
                  stat("sensitivity", entry().sensitivity),
                  stat("source", entry().source),
                  stat("updated", formatDate(entry().updatedAt)),
                ]}
              />
              <text fg={theme.text} wrapMode="word">
                {memoryPreviewText(entry().text, props.width * 20)}
              </text>
              <text fg={theme.textMuted} wrapMode="none">
                e edit · delete type DELETE
              </text>
            </box>
          )}
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
                  stat("write", selection().policy.writePolicy),
                  stat("prompt", selection().policy.promptEnabled ? "enabled" : "disabled"),
                  stat("priority", String(selection().policy.promptPriority)),
                  stat("scope", props.policyScope),
                ]}
              />
              <text fg={theme.text} wrapMode="word">
                {short(selection().category.description, props.width * 20)}
              </text>
              <text fg={theme.textMuted} wrapMode="none">
                p cycle write mode · o prompt on/off
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
                  stat("proposals", String(dreamRunProposalCount(detail())), "pending review"),
                  stat("graph", String(detail().graphProposals.filter((proposal) => (proposal.status ?? "pending") === "pending").length), `${detail().graphProposals.length} link proposals`),
                  stat("evidence", String(detail().evidence.length), `${detail().safety?.reads.length ?? detail().evidence.length} reads`),
                  stat("safety", `${detail().safety?.redactions ?? 0} redactions`, `${detail().safety?.skippedSources.length ?? 0} skipped`),
                ]}
              />
              <Show when={dreamTranscriptRows(detail()).length > 0}>
                <box flexDirection="column" gap={0}>
                  <text fg={theme.primary} wrapMode="none">Dream timeline</text>
                  <For each={dreamTranscriptRows(detail()).slice(-6)}>
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
                  <For each={detail().proposals.slice(0, 3)}>
                    {(proposal) => (
                      <text fg={theme.text} wrapMode="word">
                        {memoryPreviewText(`${proposal.operation ?? "create"} · ${proposal.scope ?? "memory"} · ${proposal.text ?? proposal.id}`, props.width * 3)}
                      </text>
                    )}
                  </For>
                </box>
              </Show>
              <Show when={detail().decisions.length > 0}>
                <box flexDirection="column" gap={0}>
                  <text fg={theme.primary} wrapMode="none">Dream decisions</text>
                  <For each={detail().decisions.slice(0, 3)}>
                    {(decision) => (
                      <text fg={decision.status === "created-proposal" ? theme.text : theme.warning} wrapMode="word">
                        {memoryPreviewText(`${decision.status} · ${decision.reason}`, props.width * 3)}
                      </text>
                    )}
                  </For>
                </box>
              </Show>
              <Show when={detail().graphProposals.length > 0}>
                <box flexDirection="column" gap={0}>
                  <text fg={theme.primary} wrapMode="none">Graph proposals</text>
                  <For each={detail().graphProposals.slice(0, 3)}>
                    {(proposal) => (
                      <box flexDirection="column" gap={0} overflow="hidden">
                        <text fg={proposal.status === "applied" ? theme.success : proposal.status === "rejected" ? theme.warning : theme.text} wrapMode="word">
                          {memoryPreviewText(dreamGraphProposalLabel(proposal), props.width * 3)}
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
                  <For each={detail().evidence.slice(0, 3)}>
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

function SideChatPanel(props: {
  chat: MemorySideChatSession | null
  width: number
  activeContext: string
  input: string
  inputActive: boolean
  busy: boolean
  scrollToken: number
  chatCount: number
  onNewChat: () => void
  onHistory: () => void
  onInput: (value: string) => void
  onInputActive: (active: boolean) => void
  onSubmit: () => void
}) {
  const { theme } = useTheme()
  const textareaKeybindings = useTextareaKeybindings()
  const history = () => props.chat?.history ?? []
  const artifacts = createMemo(() => sideChatInputArtifacts(props.input))
  const inputHeight = createMemo(() => artifacts().length || props.input.includes("\n") ? 5 : 4)
  const historyTextSize = createMemo(() => history().reduce((total, message) => total + message.text.length, 0))
  const showScrollbar = createMemo(() => history().length > 4 || historyTextSize() > props.width * 9)
  let textarea: TextareaRenderable | undefined
  let historyScroll: ScrollBoxRenderable | undefined

  function scrollHistoryToBottom() {
    const scroll = historyScroll
    if (!scroll || scroll.isDestroyed) return
    scroll.scrollTo(scroll.scrollHeight)
  }

  createEffect(() => {
    if (!textarea || textarea.isDestroyed) return
    if (props.inputActive) textarea.focus()
    else textarea.blur()
  })

  createEffect(() => {
    if (!textarea || textarea.isDestroyed) return
    if (textarea.plainText === props.input) return
    textarea.setText(props.input)
  })

  createEffect(() => {
    if (!textarea || textarea.isDestroyed) return
    textarea.traits = props.busy ? { suspend: true, status: "BUSY" } : { status: "MEMORY" }
  })

  createEffect(() => {
    `${history().length}:${historyTextSize()}:${props.busy ? "busy" : "idle"}:${props.scrollToken}`
    if (!historyScroll || historyScroll.isDestroyed) return
    queueMicrotask(() => {
      scrollHistoryToBottom()
      setTimeout(scrollHistoryToBottom, 0)
      setTimeout(scrollHistoryToBottom, 40)
    })
  })

  return (
    <Panel width={props.width} grow>
      <box flexDirection="column" gap={1} overflow="hidden" minHeight={0} flexGrow={1}>
        <box flexDirection="column" height={2} overflow="hidden">
          <box flexDirection="row" justifyContent="space-between" height={1} overflow="hidden">
            <box flexDirection="row" gap={1} overflow="hidden">
              <text fg={theme.success} wrapMode="none" onMouseUp={props.onNewChat}>
                [new]
              </text>
              <text fg={theme.primary} wrapMode="none" onMouseUp={props.onHistory}>
                {short(`[history ${props.chatCount}]`, 13)}
              </text>
            </box>
          </box>
          <text fg={theme.textMuted} wrapMode="none">
            {Locale.truncateMiddle(props.activeContext, Math.max(16, props.width - 4))}
          </text>
        </box>
        <Show
          when={history().length > 0}
          fallback={
            <box flexDirection="column" flexGrow={1} justifyContent="center" gap={1} overflow="hidden">
              <text fg={theme.textMuted} wrapMode="word">
                Ask memory questions and manage proposals.
              </text>
              <text fg={theme.primary} wrapMode="word">
                Can inspect categories, saved memories, and pending changes.
              </text>
              <text fg={theme.textMuted} wrapMode="word">
                Draft create/edit/delete/move memory actions for review.
              </text>
              <text fg={theme.textMuted} wrapMode="word">
                Draft reviewable category policy and Dream schedule proposals.
              </text>
            </box>
          }
        >
          <scrollbox
            ref={(value: ScrollBoxRenderable) => {
              historyScroll = value
            }}
            flexGrow={1}
            minHeight={0}
            width="100%"
            horizontalScrollbarOptions={{ visible: false }}
            verticalScrollbarOptions={{
              visible: showScrollbar(),
              trackOptions: {
                backgroundColor: theme.backgroundPanel,
                foregroundColor: theme.border,
              },
            }}
          >
            <box flexDirection="column" gap={1} width="100%">
              <For each={history()}>
                {(message) => {
                  const user = () => message.role === "user"
                  return (
                    <box flexDirection="column" alignItems={user() ? "flex-end" : "flex-start"}>
                      <box
                        flexDirection="column"
                        width={Math.max(20, Math.floor(props.width * 0.82))}
                        borderStyle="single"
                        borderColor={user() ? theme.success : theme.border}
                        paddingLeft={1}
                        paddingRight={1}
                      >
                        <box flexDirection="row" justifyContent="space-between" height={1} overflow="hidden">
                          <text fg={user() ? theme.success : theme.primary} wrapMode="none">
                            {user() ? "you" : "assistant"}
                          </text>
                          <text fg={theme.textMuted} wrapMode="none">
                            {formatTime(message.createdAt)}
                          </text>
                        </box>
                        <text fg={theme.text} wrapMode="word">
                          {message.text}
                        </text>
                      </box>
                    </box>
                  )
                }}
              </For>
              <Show when={props.busy}>
                <box flexDirection="column" alignItems="flex-start">
                  <box
                    flexDirection="column"
                    width={Math.max(22, Math.floor(props.width * 0.72))}
                    borderStyle="single"
                    borderColor={theme.primary}
                    paddingLeft={1}
                    paddingRight={1}
                  >
                    <box flexDirection="row" justifyContent="space-between" height={1} overflow="hidden">
                      <text fg={theme.primary} wrapMode="none">
                        assistant
                      </text>
                      <text fg={theme.textMuted} wrapMode="none">
                        working
                      </text>
                    </box>
                    <text fg={theme.textMuted} wrapMode="word">
                      thinking...
                    </text>
                  </box>
                </box>
              </Show>
            </box>
          </scrollbox>
        </Show>
        <box
          flexDirection="column"
          height={inputHeight()}
          borderStyle="single"
          borderColor={theme.primary}
          paddingLeft={1}
          paddingRight={1}
          overflow="hidden"
          onMouseDown={() => {
            props.onInputActive(true)
            textarea?.focus()
          }}
        >
          <textarea
            height={2}
            width="100%"
            initialValue={props.input}
            placeholder="Ask memory side chat..."
            placeholderColor={theme.textMuted}
            textColor={props.busy ? theme.textMuted : theme.text}
            focusedTextColor={props.busy ? theme.textMuted : theme.text}
            cursorColor={props.busy ? theme.backgroundElement : theme.primary}
            keyBindings={props.busy ? [] : textareaKeybindings()}
            onSubmit={() => {
              if (props.busy) return
              props.onSubmit()
            }}
            onContentChange={() => props.onInput(textarea?.plainText ?? "")}
            onKeyDown={(event) => {
              props.onInputActive(true)
              if (event.name !== "escape") return
              event.preventDefault()
              event.stopPropagation()
              textarea?.blur()
              props.onInputActive(false)
            }}
            ref={(value: TextareaRenderable) => {
              textarea = value
              textarea.traits = props.busy ? { suspend: true, status: "BUSY" } : { status: "MEMORY" }
            }}
          />
          <Show
            when={artifacts().length > 0}
            fallback={
              <text fg={theme.textMuted} wrapMode="none">
                {props.busy ? "thinking..." : props.inputActive ? "enter send · paste image/file path · esc blur" : "c focus · paste text/image path"}
              </text>
            }
          >
            <text fg={theme.primary} wrapMode="none">
              {short(artifacts().join(" · "), props.width)}
            </text>
          </Show>
        </box>
      </box>
    </Panel>
  )
}

function memorySideChatPageContext(input: {
  data: MemoryOverview
  baseData?: MemoryOverview | null
  selection: Selection
  activeRoot: string
  currentRoot: string
  selectedWorkspace: MemoryWorkspace | null
  activeContext: string
  policyScope: MemoryPolicyScope
}) {
  const memoryIndex = (label: string, entries: MemoryEntry[], limit: number) => entries.slice(0, limit).map((entry) => [
    `- id=${entry.id}`,
    `scope=${entry.scope}`,
    `source=${label}`,
    `categories=${(entry.categoryIDs ?? ["uncategorized"]).join(", ")}`,
    `updated=${formatDate(entry.updatedAt)}`,
    `text=${memoryPreviewText(entry.text, 260)}`,
  ].join(" · "))
  const selected = input.selection
  const lines = [
    `activeRoot: ${input.activeRoot}`,
    `currentRoot: ${input.currentRoot}`,
    `focus: ${input.selectedWorkspace ? `${input.selectedWorkspace.displayName} (${input.selectedWorkspace.root})` : "none"}`,
    `visibleContext: ${input.activeContext}`,
    `visibleSaved: ${input.data.globalEntries.length} global, ${input.data.projectEntries.length} project`,
    `allMemoryContext: global plus current project memories are always included; focus only narrows answer priority`,
    `pending: ${input.data.proposals.filter((proposal) => proposal.status === "pending").length}`,
  ]
  const base = input.baseData
  lines.push(
    "<category_graph>",
    ...input.data.categories.map((category) => {
      const policy = input.data.policies[category.id]
      return [
        `- id=${category.id}`,
        `label=${category.label}`,
        `count=${category.count}`,
        `description=${category.description}`,
        `writePolicy=${policy?.writePolicy ?? "unknown"}`,
        `prompt=${policy?.promptEnabled ? "on" : "off"}`,
      ].join(" · ")
    }),
    "</category_graph>",
  )
  lines.push(
    "<memory_control_actions>",
    "- create-memory: draft a new global/project memory proposal",
    "- edit-memory/delete-memory: draft a reviewable change for an existing memory id",
    "- move-memory: draft a reviewable category/scope move for an existing memory id",
    "- create-category/edit-category/delete-category: draft reviewable category/policy changes",
    "- propose-policy: draft extraction, write policy, prompt, or save-behavior changes",
    "- dream-dry-run: draft Dream schedule/source/dry-run changes",
    "</memory_control_actions>",
  )
  if (base) {
    const currentProject = base.projectEntries.slice(0, 5).map((entry) => `- [current project] ${memoryPreviewText(entry.text, 260)}`)
    const global = base.globalEntries.slice(0, 5).map((entry) => `- [global] ${memoryPreviewText(entry.text, 260)}`)
    lines.push(
      "<all_memory_context_sample>",
      ...(global.length || currentProject.length ? [...global, ...currentProject] : ["- none"]),
      "</all_memory_context_sample>",
    )
    lines.push(
      "<memory_index>",
      ...memoryIndex("global", base.globalEntries, 18),
      ...memoryIndex("current-project", base.projectEntries, 18),
      "</memory_index>",
    )
  }
  if (input.selectedWorkspace) {
    const focused = input.data.projectEntries.slice(0, 6).map((entry) => `- [focused project] ${memoryPreviewText(entry.text, 260)}`)
    lines.push(
      "<focused_workspace_context_sample>",
      ...(focused.length ? focused : ["- no focused project memory entries"]),
      "</focused_workspace_context_sample>",
    )
    lines.push(
      "<focused_workspace_memory_index>",
      ...memoryIndex("focused-project", input.data.projectEntries, 24),
      "</focused_workspace_memory_index>",
    )
  }
  if (selected.kind === "entry") {
    lines.push(
      "<selected_memory>",
      `id: ${selected.entry.id}`,
      `scope: ${selected.entry.scope}`,
      `categories: ${(selected.entry.categoryIDs ?? ["uncategorized"]).join(", ")}`,
      `text: ${memoryPreviewText(selected.entry.text, 720)}`,
      "</selected_memory>",
    )
  } else if (selected.kind === "proposal") {
    lines.push(
      "<selected_proposal>",
      `id: ${selected.proposal.id}`,
      `operation: ${selected.proposal.operation}`,
      `scope: ${selected.proposal.scope}`,
      `categories: ${selected.proposal.categoryIDs.join(", ") || "uncategorized"}`,
      `text: ${memoryPreviewText(selected.proposal.text, 720)}`,
      "</selected_proposal>",
    )
  } else if (selected.kind === "policy") {
    lines.push(
      "<selected_policy>",
      `scope: ${input.policyScope}`,
      `category: ${selected.category.id} (${selected.category.label})`,
      `description: ${selected.category.description}`,
      `writePolicy: ${selected.policy.writePolicy}`,
      `promptEnabled: ${selected.policy.promptEnabled}`,
      "</selected_policy>",
    )
  } else if (selected.kind === "dream") {
    const detail = selected.detail
    lines.push(
      "<dream>",
      `status: ${input.data.dream?.status ?? "none"}`,
      `source: ${input.data.dream?.source ?? "not scheduled"}`,
      `proposals: ${input.data.dream?.proposals.length ?? 0}`,
      `selectedRun: ${detail?.run.id ?? "none"}`,
      `selectedRunStatus: ${detail?.run.status ?? "none"}`,
      `latestActivity: ${input.data.dreamLatestActivity ? `${input.data.dreamLatestActivity.kind}:${input.data.dreamLatestActivity.summary}` : "none"}`,
      `selectedRunTimeline: ${detail ? dreamTranscriptRows(detail).slice(-6).map((row) => `${row.label}:${row.detail}`).join(" | ") : "none"}`,
      `selectedRunEvents: ${detail?.events.map((event) => `${event.status}:${event.message}`).slice(-6).join(" | ") ?? "none"}`,
      `selectedRunGraphProposals: ${detail?.graphProposals.slice(0, 6).map((proposal) => dreamGraphProposalLabel(proposal)).join(" | ") ?? "none"}`,
      `selectedRunEvidence: ${detail?.evidence.slice(0, 8).map((item) => dreamEvidenceLabel(item)).join(" | ") ?? "none"}`,
      `selectedRunSafety: reads=${detail?.safety?.reads.length ?? 0} redactions=${detail?.safety?.redactions ?? 0} skipped=${detail?.safety?.skippedSources.length ?? 0}`,
      "schedule guidance: prefer a flexible Dream window/range such as 18:00-23:00 over a fixed time like 21:00",
      "</dream>",
    )
  } else {
    const project = input.data.projectEntries.slice(0, 4).map((entry) => `- [project] ${memoryPreviewText(entry.text, 220)}`)
    const global = input.data.globalEntries.slice(0, 4).map((entry) => `- [global] ${memoryPreviewText(entry.text, 220)}`)
    lines.push("<visible_memory_sample>", ...(project.length || global.length ? [...project, ...global] : ["- none"]), "</visible_memory_sample>")
  }
  return lines.join("\n")
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
  const toast = useToast()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const currentRoot = createMemo(() => project.instance.directory() || process.cwd())
  const [selectedWorkspaceID, setSelectedWorkspaceID] = createSignal<string | null>(null)
  const [tab, setTab] = createSignal<MemoryTab>(route.data.type === "memory" && route.data.view === "graph" ? "graph" : "overview")
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  const [policyScope, setPolicyScope] = createSignal<MemoryPolicyScope>("project")
  const [live, setLive] = createSignal(true)
  const [chat, setChat] = createSignal<MemorySideChatSession | null>(null)
  const [sideChatInput, setSideChatInput] = createSignal("")
  const [sideChatInputActive, setSideChatInputActive] = createSignal(false)
  const [sideChatBusy, setSideChatBusy] = createSignal(false)
  const [sideChatScrollToken, setSideChatScrollToken] = createSignal(0)
  const [graphSelectedID, setGraphSelectedID] = createSignal<string>()
  const [graphShowAll, setGraphShowAll] = createSignal(false)
  const [graphZoom, setGraphZoom] = createSignal(1)
  const [graphSearching, setGraphSearching] = createSignal(false)
  const [graphQuery, setGraphQuery] = createSignal("")
  const [chatSessions, { refetch: refetchChatSessions }] = createResource(currentRoot, (root) => listMemorySideChats(root))
  const [baseOverview, { refetch: refetchBase }] = createResource(currentRoot, memoryOverview)
  const selectedWorkspace = createMemo(() => baseOverview()?.workspaces?.activeWorkspaces.find((workspace) => workspace.id === selectedWorkspaceID()) ?? null)
  const activeRoot = createMemo(() => selectedWorkspace()?.root ?? currentRoot())
  const [dreamSchedule, { refetch: refetchDreamSchedule }] = createResource(() => readDreamScheduleState())
  const [overview, { refetch }] = createResource(activeRoot, memoryOverview)
  const layout = createMemo(() => memoryLayoutForDimensions(dimensions()))
  const width = createMemo(() => dimensions().width)
  const tiny = createMemo(() => layout().tiny)
  const medium = createMemo(() => layout().medium)
  const wide = createMemo(() => layout().wide)
  const contentWidth = createMemo(() => layout().contentWidth)
  const sidebarWidth = createMemo(() => wide() ? 32 : 30)
  const sideChatWidth = createMemo(() => Math.min(64, Math.max(48, Math.floor(width() * 0.28))))
  const mainContentWidth = createMemo(() => Math.max(44, contentWidth() - sidebarWidth() - sideChatWidth() - 2))
  const inspectorHeight = createMemo(() => tab() === "dream" ? (wide() ? 15 : 13) : (wide() ? 7 : 8))
  const data = createMemo(() => overview())
  const pending = createMemo(() => data()?.proposals.filter((proposal) => proposal.status === "pending") ?? [])
  const projectEntries = createMemo(() => data()?.projectEntries ?? [])
  const globalEntries = createMemo(() => data()?.globalEntries ?? [])
  const graphWorkspaces = createMemo(() => baseOverview()?.workspaces?.activeWorkspaces ?? [])
  const graphProjectOptions = createMemo(() => {
    const current = comparableRoot(currentRoot())
    const currentWorkspace = graphWorkspaces().find((workspace) => comparableRoot(workspace.root) === current)
    return [
      { id: null as string | null, root: currentRoot(), label: currentWorkspace?.displayName ?? current.split(/[\\/]/).filter(Boolean).at(-1) ?? currentRoot() },
      ...memorySidebarProjectWorkspaces({ currentRoot: currentRoot(), workspaces: graphWorkspaces() })
        .map((workspace) => ({ id: workspace.id as string | null, root: workspace.root, label: workspace.displayName })),
    ]
  })
  const graphActiveLabel = createMemo(() => selectedWorkspace()?.displayName ?? graphProjectOptions()[0]?.label ?? activeRoot())
  const graphProjectPosition = createMemo(() => {
    const index = graphProjectOptions().findIndex((option) => option.id === selectedWorkspaceID())
    return `${Math.max(0, index) + 1}/${graphProjectOptions().length}`
  })
  const graphLayout = createMemo(() => memoryGraphExplorerLayout({ width: contentWidth(), height: Math.max(12, dimensions().height - 8) }))
  const graphFrame = createMemo(() => {
    const current = data()
    if (!current) return
    return memoryGraphMiniMap({
      facts: current.facts,
      links: current.links,
      categories: current.categories,
      width: graphLayout().canvasWidth,
      height: graphLayout().canvasHeight,
      connectedOnly: !graphShowAll(),
      selectedID: graphSelectedID(),
      zoom: graphZoom(),
    })
  })
  const graphSearchMatches = createMemo(() => {
    const current = data()
    if (!current) return []
    return memoryGraphSearchMatches({
      facts: current.facts.filter((fact) => fact.materialized),
      query: graphQuery(),
      projectLabel: (fact) => memoryGraphFactProjectLabels({
        fact,
        workspaces: graphWorkspaces(),
        activeRoot: activeRoot(),
        activeLabel: graphActiveLabel(),
      }).join(" "),
    })
  })
  const visibleCount = createMemo(() => {
    const current = data()
    if (!current) return 1
    if (tab() === "project") return Math.max(1, Math.min(projectEntries().length, ENTRY_ROW_LIMIT))
    if (tab() === "global") return Math.max(1, Math.min(globalEntries().length, ENTRY_ROW_LIMIT))
    if (tab() === "policy") return Math.max(1, Math.min(current.categories.length, POLICY_ROW_LIMIT))
    if (tab() === "overview") return Math.max(1, Math.min(pending().length, PROPOSAL_ROW_LIMIT))
    if (tab() === "dream") return Math.max(1, Math.min(current.dreamRunDetails.length || current.dreamRuns.length, DREAM_RUN_ROW_LIMIT))
    return 1
  })
  const selection = createMemo<Selection>(() => {
    const current = data()
    if (!current) return { kind: "overview" }
    const index = Math.max(0, Math.min(selectedIndex(), visibleCount() - 1))
    if (tab() === "project") return projectEntries()[index] ? { kind: "entry", entry: projectEntries()[index]! } : { kind: "overview" }
    if (tab() === "global") return globalEntries()[index] ? { kind: "entry", entry: globalEntries()[index]! } : { kind: "overview" }
    if (tab() === "policy") {
      const category = current.categories[index] ?? current.categories[0]
      const policy = category ? current.policies[category.id] : undefined
      return category && policy ? { kind: "policy", category, policy } : { kind: "overview" }
    }
    if (tab() === "dream") {
      const details = current.dreamRunDetails.length ? current.dreamRunDetails : current.dreamRuns.map(fallbackDreamRunDetail)
      return { kind: "dream", detail: details[index] ?? null }
    }
    return pending()[index] ? { kind: "proposal", proposal: pending()[index]! } : { kind: "overview" }
  })
  const activeContext = createMemo(() => {
    const item = selection()
    const focus = selectedWorkspace() ? `focus ${selectedWorkspace()!.displayName}` : "all memories"
    if (item.kind === "entry") return `${focus} · ${item.entry.scope} · ${(item.entry.categoryIDs ?? []).join(", ")}`
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
    activeRoot()
    setGraphSelectedID(undefined)
    setGraphQuery("")
    setGraphSearching(false)
    setGraphZoom(1)
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

  createEffect(() => {
    const session = chat()
    if (session && session.root !== currentRoot()) setChat(null)
  })

  async function reload(message = "Memory refreshed") {
    await Promise.allSettled([refetchBase(), refetch(), refetchDreamSchedule()])
    toast.show(toastInput("success", message))
  }

  function selectGraphFact(id: string) {
    const current = data()?.facts.find((fact) => fact.id === id)
    if (!current?.materialized) return
    if (!graphFrame()?.scene.nodes.some((node) => node.id === id)) setGraphShowAll(true)
    setGraphSelectedID(id)
    setGraphSearching(false)
  }

  function cycleGraphProject(direction: 1 | -1) {
    const options = graphProjectOptions()
    if (!options.length) return
    const current = Math.max(0, options.findIndex((option) => option.id === selectedWorkspaceID()))
    setSelectedWorkspaceID(options[(current + direction + options.length) % options.length]?.id ?? null)
  }

  function showGraphProjectPicker() {
    dialog.replace(() => (
      <DialogSelect
        title="Graph project"
        placeholder="Search project roots"
        options={graphProjectOptions().map((option) => ({
          title: option.label,
          value: option.id ?? "__current__",
          category: option.id === selectedWorkspaceID() ? "Active" : "Projects",
          description: option.root,
          searchText: `${option.label} ${option.root}`,
          onSelect: () => {
            dialog.clear()
            setSelectedWorkspaceID(option.id)
          },
        }))}
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
      await updateMemoryEntry(item.entry.scope, item.entry.id, { text: next.trim() }, activeRoot())
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
    await deleteMemoryEntry(item.entry.scope, item.entry.id, activeRoot())
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
    await writeMemoryCategoryPolicy(policyScope(), item.category.id, { writePolicy: nextWritePolicy(item.policy.writePolicy) }, activeRoot())
    await reload("Category write policy updated")
  }

  async function toggleSelectedPolicyPrompt() {
    const item = selection()
    if (item.kind !== "policy") return
    await writeMemoryCategoryPolicy(policyScope(), item.category.id, { promptEnabled: !item.policy.promptEnabled }, activeRoot())
    await reload("Category prompt policy updated")
  }

  async function submitSideChatMessage() {
    const message = sideChatInput().trim()
    if (!message || sideChatBusy()) {
      setSideChatInputActive(true)
      return
    }
    setSideChatBusy(true)
    const item = selection()
    const nextCategoryID = item.kind === "policy" ? item.category.id : item.kind === "entry" ? item.entry.categoryIDs[0] ?? null : null
    const sessionRoot = currentRoot()
    const existingSession = chat()
    const session = existingSession?.root === sessionRoot
      ? {
        ...existingSession,
        selectedWorkspaceID: selectedWorkspaceID(),
        selectedCategoryID: nextCategoryID,
      }
      : await startMemorySideChat({
        root: sessionRoot,
        selectedWorkspaceID: selectedWorkspaceID(),
        selectedCategoryID: nextCategoryID,
      })
    const now = new Date().toISOString()
    setChat({
      ...session,
      status: "running",
      history: [
        ...session.history,
        {
          id: `ui_${Date.now()}`,
          role: "user",
          text: message,
          createdAt: now,
        },
      ],
    })
    setSideChatScrollToken((value) => value + 1)
    setSideChatInput("")
    try {
      const result = await sendMemorySideChatMessage({
        session,
        message,
        pageContext: data()
          ? memorySideChatPageContext({
            data: data()!,
            baseData: baseOverview(),
            selection: item,
            activeRoot: activeRoot(),
            currentRoot: currentRoot(),
            selectedWorkspace: selectedWorkspace(),
            activeContext: activeContext(),
            policyScope: policyScope(),
          })
          : activeContext(),
        responder: (payload) => askMemorySideChat(sdk, sessionRoot, payload),
      })
      setChat(result.session)
      setSideChatScrollToken((value) => value + 1)
      void refetchChatSessions()
      await reload(result.proposals.length ? "Side chat created proposal" : "Side chat updated")
    } finally {
      setSideChatBusy(false)
      setSideChatInputActive(true)
    }
  }

  function selectPendingProposal(index: number) {
    setSideChatInputActive(false)
    setSelectedIndex(index)
  }

  async function newSideChat() {
    const item = selection()
    const session = createMemorySideChatSession({
      root: currentRoot(),
      selectedWorkspaceID: selectedWorkspaceID(),
      selectedCategoryID: item.kind === "policy"
        ? item.category.id
        : item.kind === "entry"
          ? item.entry.categoryIDs[0] ?? null
          : null,
    })
    setChat(session)
    setSideChatInput("")
    setSideChatInputActive(true)
    setSideChatScrollToken((value) => value + 1)
  }

  function sessionTitle(session: MemorySideChatSession) {
    const firstUser = session.history.find((message) => message.role === "user")?.text
    return firstUser ? memoryPreviewText(firstUser, 42) : "Empty memory chat"
  }

  function sessionDescription(session: MemorySideChatSession) {
    const last = session.history.at(-1)
    const pieces = [
      `${session.history.length} messages`,
      session.proposals.length ? `${session.proposals.length} proposals` : "",
      last ? `${last.role}: ${memoryPreviewText(last.text, 72)}` : "",
    ].filter(Boolean)
    return pieces.join(" · ")
  }

  function showSideChatHistory() {
    const sessions = chatSessions() ?? []
    const options: DialogSelectOption<string>[] = sessions.length
      ? sessions.map((session) => ({
        title: sessionTitle(session),
        value: session.id,
        category: formatDate(session.updatedAt),
        description: sessionDescription(session),
        searchText: `${session.id} ${session.root} ${session.history.map((message) => message.text).join(" ")}`,
        onSelect: () => {
          dialog.clear()
          void readMemorySideChat(session.id, currentRoot()).then((loaded) => {
            if (!loaded) {
              toast.error("Memory chat history entry no longer exists")
              return
            }
            setChat(loaded)
            setSideChatInput("")
            setSideChatInputActive(true)
            setSideChatScrollToken((value) => value + 1)
          }).catch((err) => toast.error(err))
        },
      }))
      : [{
        title: "No memory chats yet",
        value: "",
        description: "Start a new side chat, then it will appear here.",
        disabled: true,
      }]
    dialog.replace(() => (
      <DialogSelect
        title="Memory chat history"
        placeholder="Search memory chats"
        options={[
          {
            title: "[new] Start new memory chat",
            value: "__new__",
            category: "Actions",
            description: "Create a fresh side chat for this memory root.",
            onSelect: () => {
              dialog.clear()
              void newSideChat().catch((err) => toast.error(err))
            },
          },
          ...options,
        ]}
      />
    ))
  }

  function moveTab(direction: 1 | -1) {
    const index = TABS.findIndex((item) => item.id === tab())
    const next = TABS[(index + direction + TABS.length) % TABS.length]
    if (next) {
      setTab(next.id)
      setSelectedIndex(0)
    }
  }

  useKeyboard((evt) => {
    if (!shouldMemoryRouteHandleKey({
      dialogOpen: dialog.stack.length > 0,
      defaultPrevented: evt.defaultPrevented,
      textInputActive: sideChatInputActive(),
    })) return
    if (tab() === "graph") {
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
      if (evt.name === "i") {
        evt.preventDefault()
        setGraphShowAll((value) => !value)
        return
      }
      if (evt.name === "+" || evt.name === "=") {
        evt.preventDefault()
        setGraphZoom((value) => Math.min(4, Number((value * 1.25).toFixed(2))))
        return
      }
      if (evt.name === "-") {
        evt.preventDefault()
        setGraphZoom((value) => Math.max(0.4, Number((value / 1.25).toFixed(2))))
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
      const direction = evt.name === "left" || evt.name === "h"
        ? { x: -1, y: 0 }
        : evt.name === "right" || evt.name === "l"
          ? { x: 1, y: 0 }
          : evt.name === "up" || evt.name === "k"
            ? { x: 0, y: -1 }
            : evt.name === "down" || evt.name === "j"
              ? { x: 0, y: 1 }
              : null
      if (direction) {
        evt.preventDefault()
        const frame = graphFrame()
        if (frame) setGraphSelectedID(asciiGraphNearestNode(frame.scene, graphSelectedID(), direction))
        return
      }
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
    if (evt.name === "g") {
      evt.preventDefault()
      setPolicyScope(policyScope() === "project" ? "global" : "project")
      return
    }
    if (evt.name === "c") {
      evt.preventDefault()
      setSideChatInputActive(true)
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
      if (event.directory && event.directory !== activeRoot() && event.directory !== currentRoot()) return
      setLive(true)
      void Promise.allSettled([refetchBase(), refetch(), refetchDreamSchedule()])
    })
    onCleanup(() => {
      void unsubscribe?.()
    })
  })

  const renderMain = (current: MemoryOverview) => (
    <Switch>
      <Match when={tab() === "overview"}>
        <OverviewContent
          data={current}
          pending={pending()}
          selectedIndex={selectedIndex()}
          width={contentWidth()}
          stacked={!medium()}
          onSelectProposal={selectPendingProposal}
        />
      </Match>
      <Match when={tab() === "project"}>
        <Panel title="Project memories" grow>
          <EntryRows entries={projectEntries()} selectedIndex={selectedIndex()} width={contentWidth()} onSelect={setSelectedIndex} />
        </Panel>
      </Match>
      <Match when={tab() === "global"}>
        <Panel title="Global memories" grow>
          <EntryRows entries={globalEntries()} selectedIndex={selectedIndex()} width={contentWidth()} onSelect={setSelectedIndex} />
        </Panel>
      </Match>
      <Match when={tab() === "graph"}>
        <Show when={graphFrame()}>
          {(frame) => (
            <MemoryGraphExplorer
              data={current}
              frame={frame()}
              width={contentWidth()}
              height={Math.max(12, dimensions().height - 8)}
              canvasWidth={graphLayout().canvasWidth}
              selectedID={graphSelectedID()}
              activeRoot={activeRoot()}
              activeLabel={graphActiveLabel()}
              projectPosition={graphProjectPosition()}
              workspaces={graphWorkspaces()}
              showAll={graphShowAll()}
              zoom={graphZoom()}
              searching={graphSearching()}
              query={graphQuery()}
              searchMatches={graphSearchMatches()}
              onSelect={selectGraphFact}
              onPreviousProject={() => cycleGraphProject(-1)}
              onNextProject={() => cycleGraphProject(1)}
              onChooseProject={showGraphProjectPicker}
              onToggleAll={() => setGraphShowAll((value) => !value)}
              onBeginSearch={() => {
                setGraphQuery("")
                setGraphSearching(true)
              }}
              onRefresh={() => void reload("Memory graph refreshed").catch((err) => toast.error(err))}
            />
          )}
        </Show>
      </Match>
      <Match when={tab() === "policy"}>
        <Panel title="Policy & categories" grow>
          <PolicyRows data={current} selectedIndex={selectedIndex()} width={contentWidth()} policyScope={policyScope()} onSelect={setSelectedIndex} />
        </Panel>
      </Match>
      <Match when={tab() === "dream"}>
        <DreamContent data={current} schedule={dreamSchedule()} width={contentWidth()} selectedIndex={selectedIndex()} onSelectRun={setSelectedIndex} />
      </Match>
    </Switch>
  )

  return (
    <box flexDirection="column" width="100%" height="100%" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1} gap={1}>
      <Header root={activeRoot()} tab={tab()} narrow={width() < 118} live={live()} />
      <Show when={data()} fallback={<LoadingMemory tiny={tiny()} />}>
        {(current) => (
          <box flexDirection="column" minHeight={0} flexGrow={1} gap={1}>
            <TabBar tab={tab()} width={contentWidth()} onSelect={(next) => {
              setTab(next)
              setSelectedIndex(0)
            }} />
            <Switch>
              <Match when={tab() === "graph"}>
                {renderMain(current())}
              </Match>
              <Match when={wide()}>
                <box flexDirection="row" minHeight={0} flexGrow={1} gap={1}>
                  <Sidebar
                    data={baseOverview() ?? current()}
                    currentRoot={currentRoot()}
                    activeRoot={activeRoot()}
                    selectedWorkspaceID={selectedWorkspaceID()}
                    width={sidebarWidth()}
                    onSelectWorkspace={(id) => {
                      setSelectedWorkspaceID(id)
                      setSelectedIndex(0)
                      setTab("project")
                    }}
                    onTab={(next) => {
                      setTab(next)
                      setSelectedIndex(0)
                    }}
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
                  <SideChatPanel
                    chat={chat()}
                    width={sideChatWidth()}
                    activeContext={activeContext()}
                    input={sideChatInput()}
                    inputActive={sideChatInputActive()}
                    busy={sideChatBusy()}
                    scrollToken={sideChatScrollToken()}
                    chatCount={chatSessions()?.length ?? 0}
                    onNewChat={() => void newSideChat().catch((err) => toast.error(err))}
                    onHistory={showSideChatHistory}
                    onInput={setSideChatInput}
                    onInputActive={setSideChatInputActive}
                    onSubmit={() => void submitSideChatMessage().catch((err) => {
                        setSideChatBusy(false)
                        toast.error(err)
                      })}
                  />
                </box>
              </Match>
              <Match when={medium()}>
                <box flexDirection="row" minHeight={0} flexGrow={1} gap={1}>
                  <Sidebar
                    data={baseOverview() ?? current()}
                    currentRoot={currentRoot()}
                    activeRoot={activeRoot()}
                    selectedWorkspaceID={selectedWorkspaceID()}
                    width={sidebarWidth()}
                    onSelectWorkspace={(id) => {
                      setSelectedWorkspaceID(id)
                      setSelectedIndex(0)
                      setTab("project")
                    }}
                    onTab={(next) => {
                      setTab(next)
                      setSelectedIndex(0)
                    }}
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
                      width={contentWidth()}
                      height={tiny() ? 7 : 9}
                      onSelectWorkspace={(id) => {
                        setSelectedWorkspaceID(id)
                        setSelectedIndex(0)
                        setTab("project")
                      }}
                      onTab={(next) => {
                        setTab(next)
                        setSelectedIndex(0)
                      }}
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
                    <box height={tiny() ? 24 : 28} minHeight={0}>
                      <SideChatPanel
                        chat={chat()}
                        width={contentWidth()}
                        activeContext={activeContext()}
                        input={sideChatInput()}
                        inputActive={sideChatInputActive()}
                        busy={sideChatBusy()}
                        scrollToken={sideChatScrollToken()}
                        chatCount={chatSessions()?.length ?? 0}
                        onNewChat={() => void newSideChat().catch((err) => toast.error(err))}
                        onHistory={showSideChatHistory}
                        onInput={setSideChatInput}
                        onInputActive={setSideChatInputActive}
                        onSubmit={() => void submitSideChatMessage().catch((err) => {
                          setSideChatBusy(false)
                          toast.error(err)
                        })}
                      />
                    </box>
                  </box>
                </scrollbox>
              </Match>
            </Switch>
          </box>
        )}
      </Show>
      <Show when={overview.error}>
        <text fg={theme.error} wrapMode="none">
          {short(String(overview.error), contentWidth())}
        </text>
      </Show>
    </box>
  )
}
