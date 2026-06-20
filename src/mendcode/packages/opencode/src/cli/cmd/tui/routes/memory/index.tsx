import { createEffect, createMemo, createResource, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
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
type ThemeColorValue = ReturnType<typeof useTheme>["theme"]["text"]
type MemoryTab = "overview" | "project" | "global" | "policy" | "dream"
type Selection =
  | { kind: "entry"; entry: MemoryEntry }
  | { kind: "proposal"; proposal: MemoryProposal }
  | { kind: "policy"; category: MemoryOverview["categories"][number]; policy: MemoryCategoryPolicy }
  | { kind: "dream" }
  | { kind: "overview" }

const TABS: Array<{ id: MemoryTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "project", label: "Project memories" },
  { id: "global", label: "Global memories" },
  { id: "policy", label: "Policy & categories" },
  { id: "dream", label: "Dream" },
]

const WRITE_POLICIES: MemoryWritePolicy[] = ["disabled", "pending", "auto-apply-safe", "manual-only"]

export function memoryLayoutForDimensions(input: { width: number; height: number }) {
  return {
    tiny: input.width < 88 || input.height < 24,
    medium: input.width >= 112 && input.height >= 28,
    wide: input.width >= 132 && input.height >= 28,
    contentWidth: Math.max(40, input.width - 6),
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

export function shouldMemoryRouteHandleKey(input: { dialogOpen: boolean; defaultPrevented?: boolean }) {
  return !input.dialogOpen && input.defaultPrevented !== true
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
  const shortcuts = "1-5 tabs · ↑↓ select · e edit · c side chat · esc"
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

function ProgressBar(props: { value: number; width: number; color?: ThemeColorValue }) {
  const { theme } = useTheme()
  const safeWidth = Math.max(4, Math.floor(props.width))
  const filled = Math.max(0, Math.min(safeWidth, Math.round(safeWidth * props.value)))
  return (
    <box height={1} overflow="hidden">
      <text fg={props.color ?? theme.success} wrapMode="none">
        {"█".repeat(filled)}
      </text>
      <text fg={theme.border} wrapMode="none">
        {"░".repeat(safeWidth - filled)}
      </text>
    </box>
  )
}

function TabBar(props: { tab: MemoryTab; width: number; onSelect: (tab: MemoryTab) => void }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="row" height={1} overflow="hidden" gap={1}>
      <For each={TABS}>
        {(tab, index) => (
          <text
            fg={props.tab === tab.id ? theme.success : theme.textMuted}
            wrapMode="none"
            onMouseUp={() => props.onSelect(tab.id)}
          >
            {short(`${index() + 1} ${tab.label}`, Math.max(8, Math.floor(props.width / TABS.length) - 1))}
          </text>
        )}
      </For>
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

function CategoryMap(props: { data: MemoryOverview; width: number }) {
  const { theme } = useTheme()
  const rows = () => props.data.categories.filter((category) => category.count > 0).sort((a, b) => b.count - a.count)
  const peak = () => Math.max(1, ...rows().map((row) => row.count))
  return (
    <Panel title="Category graph" grow>
      <Show
        when={rows().length > 0}
        fallback={
          <box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center" overflow="hidden" gap={1}>
            <text fg={theme.textMuted} wrapMode="none">
              No materialized memory facts yet.
            </text>
            <text fg={theme.primary} wrapMode="none">
              Saved entries will appear as a graph here.
            </text>
          </box>
        }
      >
        <box flexDirection="column" gap={1} overflow="hidden">
          <For each={rows().slice(0, 10)}>
            {(row) => (
              <box flexDirection="row" height={1} overflow="hidden" gap={1}>
                <box width={24} overflow="hidden">
                  <text fg={theme.text} wrapMode="none">
                    {short(row.label, 24)}
                  </text>
                </box>
                <box flexGrow={1} overflow="hidden">
                  <ProgressBar value={row.count / peak()} width={Math.max(6, props.width - 38)} />
                </box>
                <text fg={theme.textMuted} wrapMode="none">
                  {row.count}
                </text>
              </box>
            )}
          </For>
        </box>
      </Show>
    </Panel>
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
        <For each={props.entries.slice(0, 11)}>
          {(entry, index) => {
            const selected = () => props.selectedIndex === index()
            return (
              <box height={2} overflow="hidden" onMouseUp={() => props.onSelect(index())}>
                <box flexDirection="row" justifyContent="space-between" height={1} overflow="hidden">
                  <text fg={selected() ? theme.success : entry.scope === "global" ? theme.primary : theme.text} wrapMode="none">
                    {short(`${entry.scope} · ${(entry.categoryIDs ?? ["uncategorized"])[0] ?? "uncategorized"}`, Math.max(16, props.width - 18))}
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
        <For each={props.proposals.slice(0, 10)}>
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
                    {short(`${proposal.operation} · ${proposal.scope} · ${proposal.categoryIDs[0] ?? "uncategorized"}`, Math.max(18, props.width - 18))}
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
      <For each={rows().slice(0, 12)}>
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
      <box flexDirection={props.stacked ? "column" : "row"} gap={1} minHeight={0} flexGrow={1}>
        <CategoryMap data={props.data} width={Math.max(40, props.width / 2)} />
        <Panel title="Pending Queue" grow>
          <ProposalRows proposals={props.pending} selectedIndex={props.selectedIndex} width={Math.max(30, props.width / 2 - 6)} onSelect={props.onSelectProposal} />
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

function DreamContent(props: { data: MemoryOverview; schedule: DreamScheduleState | null | undefined; width: number }) {
  const { theme } = useTheme()
  const dream = () => props.data.dream
  const schedule = () => props.schedule
  return (
    <box flexDirection="column" gap={1} minHeight={0} flexGrow={1}>
      <Panel title="Dream status" height={9}>
        <MetricRows
          width={props.width}
          items={[
            stat("status", dream()?.status ?? "none"),
            stat("schedule", dreamWindowLabel(schedule()?.window)),
            stat("state", schedule()?.status ?? "not scheduled"),
            stat("source", dream()?.source ?? schedule()?.reason ?? "not scheduled"),
            stat("started", dream() ? formatDate(dream()!.startedAt) : "none"),
            stat("proposals", String(dream()?.proposals.length ?? 0)),
          ]}
        />
        <text fg={theme.primary} wrapMode="none">
          {short("Recommend a flexible window, e.g. 18:00-23:00, instead of one fixed minute.", props.width)}
        </text>
      </Panel>
      <Panel title="Dream log" grow>
        <box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center" overflow="hidden" gap={1}>
          <text fg={theme.textMuted} wrapMode="none">
            Dream runs are logged under project memory.
          </text>
          <text fg={theme.primary} wrapMode="none">
            SSE updates this panel while Dream runs.
          </text>
        </box>
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
        <Match when={props.selection.kind === "dream"}>
          <MetricRows width={props.width} items={[stat("view", "Dream"), stat("events", "SSE live"), stat("updates", "automatic")]} />
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
                Configure category policies and Dream dry-runs.
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
    lines.push(
      "<dream>",
      `status: ${input.data.dream?.status ?? "none"}`,
      `source: ${input.data.dream?.source ?? "not scheduled"}`,
      `proposals: ${input.data.dream?.proposals.length ?? 0}`,
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
  const [tab, setTab] = createSignal<MemoryTab>("overview")
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  const [policyScope, setPolicyScope] = createSignal<MemoryPolicyScope>("project")
  const [live, setLive] = createSignal(true)
  const [chat, setChat] = createSignal<MemorySideChatSession | null>(null)
  const [sideChatInput, setSideChatInput] = createSignal("")
  const [sideChatInputActive, setSideChatInputActive] = createSignal(false)
  const [sideChatBusy, setSideChatBusy] = createSignal(false)
  const [sideChatScrollToken, setSideChatScrollToken] = createSignal(0)
  const [chatSessions, { refetch: refetchChatSessions }] = createResource(currentRoot, (root) => listMemorySideChats(root))
  const [baseOverview, { refetch: refetchBase }] = createResource(currentRoot, memoryOverview)
  const selectedWorkspace = createMemo(() => baseOverview()?.workspaces?.activeWorkspaces.find((workspace) => workspace.id === selectedWorkspaceID()) ?? null)
  const activeRoot = createMemo(() => selectedWorkspace()?.root ?? currentRoot())
  const [dreamSchedule, { refetch: refetchDreamSchedule }] = createResource(activeRoot, (root) => readDreamScheduleState(root))
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
  const data = createMemo(() => overview())
  const pending = createMemo(() => data()?.proposals.filter((proposal) => proposal.status === "pending") ?? [])
  const projectEntries = createMemo(() => data()?.projectEntries ?? [])
  const globalEntries = createMemo(() => data()?.globalEntries ?? [])
  const visibleCount = createMemo(() => {
    const current = data()
    if (!current) return 1
    if (tab() === "project") return Math.max(1, projectEntries().length)
    if (tab() === "global") return Math.max(1, globalEntries().length)
    if (tab() === "policy") return Math.max(1, current.categories.length)
    if (tab() === "overview") return Math.max(1, pending().length)
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
    if (tab() === "dream") return { kind: "dream" }
    return pending()[index] ? { kind: "proposal", proposal: pending()[index]! } : { kind: "overview" }
  })
  const activeContext = createMemo(() => {
    const item = selection()
    const focus = selectedWorkspace() ? `focus ${selectedWorkspace()!.displayName}` : "all memories"
    if (item.kind === "entry") return `${focus} · ${item.entry.scope} · ${(item.entry.categoryIDs ?? []).join(", ")}`
    if (item.kind === "proposal") return `${focus} · ${item.proposal.operation} proposal`
    if (item.kind === "policy") return `${focus} · ${policyScope()} policy · ${item.category.label}`
    if (item.kind === "dream") return `${focus} · Dream`
    return focus
  })

  createEffect(() => {
    if (selectedIndex() >= visibleCount()) setSelectedIndex(Math.max(0, visibleCount() - 1))
  })

  createEffect(() => {
    const session = chat()
    if (session && session.root !== currentRoot()) setChat(null)
  })

  async function reload(message = "Memory refreshed") {
    await Promise.allSettled([refetchBase(), refetch(), refetchDreamSchedule()])
    toast.show(toastInput("success", message))
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

  async function applySelectedProposal() {
    const item = selection()
    if (item.kind !== "proposal") return
    const confirmed = await confirmProposalAction("apply", item.proposal)
    if (!confirmed) return
    await applyMemoryProposal(item.proposal.id, activeRoot())
    await reload("Proposal applied")
  }

  async function rejectSelectedProposal() {
    const item = selection()
    if (item.kind !== "proposal") return
    const confirmed = await confirmProposalAction("reject", item.proposal)
    if (!confirmed) return
    await rejectMemoryProposal(item.proposal.id, activeRoot())
    await reload("Proposal rejected")
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
    const session = createMemorySideChatSession({
      root: currentRoot(),
      selectedWorkspaceID: selectedWorkspaceID(),
      selectedCategoryID: selection().kind === "policy"
        ? selection().category.id
        : selection().kind === "entry"
          ? selection().entry.categoryIDs[0] ?? null
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
    if (!shouldMemoryRouteHandleKey({ dialogOpen: dialog.stack.length > 0, defaultPrevented: evt.defaultPrevented })) return
    if (sideChatInputActive()) {
      if (evt.name === "escape") {
        evt.preventDefault()
        setSideChatInputActive(false)
        return
      }
      if (evt.name === "n" && !sideChatInput().trim()) {
        evt.preventDefault()
        void newSideChat().catch((err) => toast.error(err))
        return
      }
      if (evt.name === "h" && !sideChatInput().trim()) {
        evt.preventDefault()
        showSideChatHistory()
        return
      }
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
      if (event.payload.type !== "memory.workspace" && event.payload.type !== "memory.dream") return
      if (event.directory && event.directory !== activeRoot() && event.directory !== currentRoot()) return
      setLive(true)
      void Promise.allSettled([refetchBase(), refetch()])
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
      <Match when={tab() === "policy"}>
        <Panel title="Policy & categories" grow>
          <PolicyRows data={current} selectedIndex={selectedIndex()} width={contentWidth()} policyScope={policyScope()} onSelect={setSelectedIndex} />
        </Panel>
      </Match>
      <Match when={tab() === "dream"}>
        <DreamContent data={current} schedule={dreamSchedule()} width={contentWidth()} />
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
                    <box height={7} minHeight={0}>
                      <Inspector
                        selection={selection()}
                        width={mainContentWidth()}
                        policyScope={policyScope()}
                        onApplyProposal={() => void applySelectedProposal().catch((err) => toast.error(err))}
                        onRejectProposal={() => void rejectSelectedProposal().catch((err) => toast.error(err))}
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
                    <box height={8} minHeight={0}>
                      <Inspector
                        selection={selection()}
                        width={Math.max(40, contentWidth() - 36)}
                        policyScope={policyScope()}
                        onApplyProposal={() => void applySelectedProposal().catch((err) => toast.error(err))}
                        onRejectProposal={() => void rejectSelectedProposal().catch((err) => toast.error(err))}
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
                    <box height={8} minHeight={0}>
                      <Inspector
                        selection={selection()}
                        width={contentWidth()}
                        policyScope={policyScope()}
                        onApplyProposal={() => void applySelectedProposal().catch((err) => toast.error(err))}
                        onRejectProposal={() => void rejectSelectedProposal().catch((err) => toast.error(err))}
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
