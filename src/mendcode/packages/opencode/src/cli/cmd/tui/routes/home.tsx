import { Prompt, type PromptRef } from "@tui/component/prompt"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, type Accessor, type JSX } from "solid-js"
import { useProject } from "../context/project"
import { useSync } from "../context/sync"
import { Toast } from "../ui/toast"
import { useArgs } from "../context/args"
import { useRoute, useRouteData } from "@tui/context/route"
import { usePromptRef } from "../context/prompt"
import { useLocal } from "../context/local"
import { useSDK } from "../context/sdk"
import { TuiPluginRuntime } from "@/cli/cmd/tui/plugin/runtime"
import { useEditorContext } from "@tui/context/editor"
import { useMendTuiProfile } from "../context/mend"
import { SplitBorder } from "../component/border"
import { Spinner } from "../component/spinner"
import { useDialog } from "../ui/dialog"
import { renderMendEditor } from "@/mend/tui/editor-host"
import { renderAsciiText, type HomeLogoFont } from "../component/ascii-text"
import { homeMascotText } from "@/mend/tui/mascot"
import { Locale } from "@/util/locale"
import { Global } from "@mendcode/core/global"
import { Installation } from "@/installation"
import type { GlobalEvent, PermissionRequest, PlanReviewRequest, QuestionRequest, Session, SessionStatus } from "@mendcode/sdk/v2"
import type { MendTuiProfile } from "@/mend/profile"
import {
  agentViewLoopRootSessionIDs,
  isAgentViewSessionFallbackVisible,
  isAgentViewCompletedLoop,
  isAgentViewLoopSession,
  isAgentViewSessionVisible,
  formatAgentViewDetailLabel,
  formatAgentViewPathLabel,
  formatAgentViewSessionTime,
  countAgentViewCommands,
  summarizeAgentViewOrchestration,
  type AgentViewBackgroundSession,
  type AgentViewCommand,
  type AgentViewOrchestrationSummary,
  type AgentViewSessionItem,
} from "../util/agent-view"

const HOME_LOGO_FIT_ORDER: HomeLogoFont[] = ["small", "classic", "mendcode", "opencode", "standard", "shadow"]

export function fittedHomeLogoText(input: { value: string; font: HomeLogoFont; maxWidth: number; maxHeight?: number }) {
  const fonts = [input.font, ...HOME_LOGO_FIT_ORDER].filter((font, index, list) => list.indexOf(font) === index)
  const maxWidth = Math.max(1, Math.floor(input.maxWidth))
  const maxHeight = Math.max(1, Math.floor(input.maxHeight ?? Number.MAX_SAFE_INTEGER))
  for (const font of fonts) {
    const text = renderAsciiText(input.value || "MendCode", font)
    if (maxLineWidth(text) <= maxWidth && countLines(text) <= maxHeight) return text
  }
  return Locale.truncate(input.value || "MendCode", maxWidth)
}

export function configuredHomeLogoText(input: { profile: MendTuiProfile; surfaceHomeAscii?: string; maxWidth?: number; maxHeight?: number }) {
  if (input.surfaceHomeAscii?.trimEnd()) return input.surfaceHomeAscii.trimEnd()
  if ((input.profile.identity.logoMode || "title") === "mascot") return homeMascotText(input.profile)
  if (input.maxWidth) {
    return fittedHomeLogoText({
      value: input.profile.identity.productName || "MendCode",
      font: input.profile.identity.logoFont || "classic",
      maxWidth: input.maxWidth,
      maxHeight: input.maxHeight,
    })
  }
  return renderAsciiText(input.profile.identity.productName || "MendCode", input.profile.identity.logoFont || "classic")
}

type BackgroundSessionInfo = AgentViewBackgroundSession & {
  pinned?: boolean | null
  writer?: {
    clientID: string
    acquired: number
    expires: number
  } | null
}

type AgentViewMetadataInfo = NonNullable<AgentViewBackgroundSession["metadata"]> & {
  sessionID: string
}

type AgentViewLoopWorkflow = {
  id: string
  rootSessionID?: string
  state: string
  phase?: string
  name?: string
  time?: {
    created?: number
    updated?: number
  }
}

type AgentViewActivity = "needsInput" | "looping" | "working" | "completed"

const activeLoopWorkflowStates = new Set(["active", "sleeping", "working", "needs_input", "blocked"])

export function resolveHomePromptTarget(input: { workspaceID?: string; selectedAgentViewSessionID?: string }) {
  return {
    historyScope: `project:${input.workspaceID ?? "local"}`,
    sessionID: undefined as string | undefined,
  }
}

export function shouldOpenSelectedAgentViewSession(input: {
  promptInput: string
  submitPending?: boolean
  selectedSessionID?: string
}) {
  return Boolean(input.selectedSessionID && input.promptInput.length === 0 && !input.submitPending)
}

export function homePromptPlaceholderText(input?: { selectedTitle?: string }) {
  if (!input?.selectedTitle) return placeholder.normal
  return [`New task here — Enter starts /new. Selected session: ${Locale.truncate(input.selectedTitle, 32)}`]
}

export function homeSplitIdentityWidth(input: {
  logoWidth: number
  titleWidth: number
  panelWidth: number
  agentMinWidth?: number
}) {
  const reservedAgentWidth = input.agentMinWidth ?? 42
  const maxIdentityWidth = Math.max(24, input.panelWidth - reservedAgentWidth - 4)
  return Math.max(24, Math.min(Math.max(input.logoWidth, input.titleWidth) + 2, maxIdentityWidth))
}

export function homeAgentViewPanelWidth(input: { available: number }) {
  return Math.min(54, Math.max(30, input.available))
}

export function homeAgentViewRowLayout(input: { width: number }) {
  const width = Math.max(24, Math.floor(input.width))
  const markerWidth = 2
  const compact = width < 62
  if (compact) {
    const timeWidth = width >= 52 ? 16 : width >= 44 ? 14 : width >= 36 ? 10 : 8
    return {
      compact,
      markerWidth,
      titleWidth: Math.max(8, width - markerWidth - timeWidth - 1),
      detailWidth: Math.max(8, width - markerWidth),
      timeWidth,
    }
  }

  const timeWidth = width >= 72 ? 16 : 14
  const titleWidth = Math.min(30, Math.max(18, Math.floor(width * 0.42)))
  return {
    compact,
    markerWidth,
    titleWidth,
    detailWidth: Math.max(10, width - markerWidth - titleWidth - timeWidth - 2),
    timeWidth,
  }
}

export function homeAgentViewSummaryVisible(input: { waiting: number; looping: number; working: number }) {
  return input.waiting + input.looping + input.working > 0
}

export function formatHomeAgentViewSummary(input: {
  waiting: number
  looping: number
  working: number
  width: number
}) {
  const full = `Agent View sessions · ${input.waiting} waiting · ${input.looping} looping · ${input.working} working`
  const compact = `Agent View · ${input.waiting} wait · ${input.looping} loop · ${input.working} work`
  const narrow = `${input.waiting} wait · ${input.looping} loop · ${input.working} work`
  return [full, compact, narrow].find((value) => Bun.stringWidth(value) <= input.width) ?? narrow
}

export function homeAgentViewSummaryLines(input: {
  waiting: number
  looping: number
  working: number
  width: number
}) {
  const formatted = formatHomeAgentViewSummary(input)
  if (formatted.startsWith("Agent View")) return [formatted]
  const active = `${input.waiting} wait · ${input.looping} loop · ${input.working} work`
  if (Bun.stringWidth(active) <= input.width) return ["Agent View sessions", active]
  return ["Agent View sessions", `${input.waiting} wait · ${input.looping} loop`, `${input.working} work`]
}

export function homeAgentInboxSummaryVisible(summary: AgentViewOrchestrationSummary) {
  return summary.pending + summary.active > 0
}

export function formatHomeAgentInboxSummary(input: { summary: AgentViewOrchestrationSummary; width: number }) {
  const capacity = ` · ${input.summary.pendingCapacity} slots`
  const bases = [
    { value: `Agent inbox · ${input.summary.pending} queued${capacity} · ${input.summary.active} active`, wide: true },
    { value: `Inbox · ${input.summary.pending} queued${capacity} · ${input.summary.active} active`, wide: false },
    { value: `${input.summary.pending} queued${capacity} · ${input.summary.active} active`, wide: false },
  ]
  const requiredExtra = input.summary.overLimitTargets > 0
    ? (wide: boolean) => ` · ${input.summary.overLimitTargets} over${wide ? " limit" : ""}`
    : () => input.summary.blocked > 0 ? ` · ${input.summary.blocked} blocked` : ""
  const selected = bases.find((item) => Bun.stringWidth(item.value + requiredExtra(item.wide)) <= input.width) ?? bases[2]
  const base = selected.value
  const extras = [
    input.summary.overLimitTargets > 0 ? ` · ${input.summary.overLimitTargets} over${selected.wide ? " limit" : ""}` : "",
    input.summary.blocked > 0 ? ` · ${input.summary.blocked} blocked` : "",
  ]
  return extras.reduce(
    (value, extra) => extra && Bun.stringWidth(value + extra) <= input.width ? value + extra : value,
    base,
  )
}

export function homeAgentInboxSummaryLines(input: { summary: AgentViewOrchestrationSummary; width: number }) {
  const formatted = formatHomeAgentInboxSummary(input)
  if (formatted.startsWith("Agent inbox") || formatted.startsWith("Inbox")) return [formatted]
  const queued = `${input.summary.pending} queued · ${input.summary.pendingCapacity} slots`
  const active = `${input.summary.active} active`
  const core = `${queued} · ${active}`
  const details = [
    input.summary.blocked > 0 ? `${input.summary.blocked} blocked` : "",
    input.summary.overLimitTargets > 0 ? `${input.summary.overLimitTargets} over` : "",
  ].filter(Boolean).join(" · ")
  return ["Agent inbox", ...(Bun.stringWidth(core) <= input.width ? [core] : [queued, active]), details].filter(Boolean)
}

export function homeAgentViewSectionGapVisible(input: {
  headlineVisible: boolean
  precedingSectionCounts: readonly number[]
}) {
  return input.headlineVisible || input.precedingSectionCounts.some((count) => count > 0)
}

export function homeSplitIdentityPaneWidth(input: { panelWidth: number; rightPanelWidth: number; twoColumn: boolean }) {
  if (!input.twoColumn) return Math.max(24, input.panelWidth - 4)
  return Math.max(24, input.panelWidth - input.rightPanelWidth - 4)
}

export function homeRightPanelContainerWidth(input: { rightPanelWidth: number; twoColumn: boolean; paddingRight?: number }) {
  return Math.max(1, Math.floor(input.rightPanelWidth) + (input.twoColumn ? (input.paddingRight ?? 1) : 0))
}

export function homeAgentViewElapsedLabel(input: { now: number; startedAt?: number }) {
  const seconds = Math.max(0, Math.floor((input.now - (input.startedAt ?? input.now)) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  const weeks = Math.floor(days / 7)
  if (days < 30) return `${weeks}w`
  const months = Math.floor(days / 30)
  if (days < 365) return `${months}mo`
  return `${Math.floor(days / 365)}y`
}

export function homeAgentViewRecentlyActive(input: { now: number; lastSeenAt?: number; graceMs: number }) {
  return input.lastSeenAt !== undefined && input.now - input.lastSeenAt <= input.graceMs
}

export function mergeAgentViewAggregateFallback<T extends { sessionID: string }>(primary: readonly T[], fallback: readonly T[]) {
  return [...primary, ...fallback.filter((item) => !primary.some((current) => current.sessionID === item.sessionID))]
}

export function homeSplitLogoMaxWidth(input: {
  terminalWidth: number
  split: boolean
  rightPanel?: string
}) {
  if (!input.split || (input.rightPanel ?? "agentManager") !== "agentManager") return Math.max(8, input.terminalWidth - 8)
  return Math.max(8, input.terminalWidth - homeAgentViewPanelWidth({ available: Math.max(24, input.terminalWidth - 10) }) - 16)
}

let once = false
const placeholder = {
  normal: ["Fix a TODO in the codebase", "What is the tech stack of this project?", "Fix broken tests"],
  shell: ["ls -la", "git status", "pwd"],
}

export function homeSurfaceTextLayout(text: string) {
  const lines = text.split("\n")
  return {
    lines,
    width: lines.reduce((max, line) => Math.max(max, Bun.stringWidth(line)), 0),
  }
}

function SurfaceLines(props: { text: string }) {
  const layout = createMemo(() => homeSurfaceTextLayout(props.text))
  return (
    <box flexDirection="column" width={layout().width}>
      <For each={layout().lines}>{(line) => <text wrapMode="none">{line}</text>}</For>
    </box>
  )
}

function countLines(text: string | undefined) {
  if (!text) return 0
  return text.split("\n").length
}

function maxLineWidth(text: string | undefined) {
  if (!text) return 0
  return text.split("\n").reduce((max, line) => Math.max(max, Bun.stringWidth(line)), 0)
}

export function HomeSurface(props: {
  bind?: (ref: PromptRef | undefined) => void
  disabled?: boolean
  showToast?: boolean
  revision?: number
  surface?: {
    homeAscii?: string
    homeBottom?: string
  }
}) {
  const project = useProject()
  const route = useRoute()
  const mend = useMendTuiProfile()
  const local = useLocal()
  const sdk = useSDK()
  const sync = useSync()
  const dialog = useDialog()
  const promptRef = usePromptRef()
  const dimensions = useTerminalDimensions()
  const logoFont = createMemo<HomeLogoFont>(() => mend.profile.identity.logoFont || "classic")
  const logoMode = createMemo(() => mend.profile.identity.logoMode || "title")
  const customProductAscii = createMemo(() => renderAsciiText(mend.profile.identity.productName, logoFont()))
  const activeHomeAscii = createMemo(() =>
    configuredHomeLogoText({
      profile: mend.profile,
      surfaceHomeAscii: props.surface?.homeAscii,
      maxWidth: homeSplitLogoMaxWidth({
        terminalWidth: dimensions().width,
        split: (mend.profile.surfaces.homeWelcome?.mode || "centered") === "split" && dimensions().height > 23 && dimensions().width >= 76,
        rightPanel: mend.profile.surfaces.homeWelcome?.rightPanel,
      }),
      maxHeight: Math.max(1, dimensions().height - 14),
    }),
  )
  const homeIdentityKey = createMemo(
    () =>
      `${props.revision ?? 0}:${mend.profile.identity.productName}:${logoFont()}:${logoMode()}:${activeHomeAscii()}`,
  )
  const homeDensity = createMemo<"full" | "compact" | "tiny">(() => {
    const height = dimensions().height
    if (height <= 17) return "tiny"
    if (height <= 23 || dimensions().width <= 64) return "compact"
    return "full"
  })
  const logoLines = createMemo(() => {
    const homeAscii = activeHomeAscii()
    return countLines(homeAscii)
  })
  const splitLogoWidth = createMemo(() => {
    const homeAscii = activeHomeAscii()
    return maxLineWidth(homeAscii)
  })
  const showLogo = createMemo(() => {
    if (homeDensity() === "tiny") return false
    return dimensions().height - logoLines() >= 13
  })
  const useCompactProductName = createMemo(() => {
    if (homeDensity() !== "full") return true
    return dimensions().width < maxLineWidth(activeHomeAscii()) + 12
  })
  const logoBottomPad = createMemo(() => (homeDensity() === "full" && logoFont() === "shadow" ? 1 : 0))
  const logoPromptGap = createMemo(() => (homeDensity() === "full" && logoFont() === "shadow" ? 0 : 0))
  const homeWelcomeMode = createMemo(() => mend.profile.surfaces.homeWelcome?.mode || "centered")
  const homeWelcomeRightPanel = createMemo(() => mend.profile.surfaces.homeWelcome?.rightPanel || "agentManager")
  const productVersionLabel = createMemo(() => {
    return `${mend.profile.identity.productName} ${Installation.labelVersion()}`
  })
  const splitWelcome = createMemo(() => homeWelcomeMode() === "split" && homeDensity() === "full" && dimensions().width >= 76)
  const promptPreset = createMemo(() => mend.profile.promptChrome.preset)
  const promptEdgeToEdge = createMemo(() => promptPreset() === "minimal" || promptPreset() === "top-bottom")
  const rootLabel = createMemo(() => {
    const value = project.instance.path().directory || project.instance.path().worktree || mend.root
    const label = value.replace(/^\/Users\/[^/]+/, "~")
    return Locale.truncateMiddle(label, Math.max(18, dimensions().width - 6))
  })
  const rootPaddingTop = createMemo(() => (homeDensity() === "tiny" ? 0 : 1))
  const sidePadding = createMemo(() => (homeDensity() === "tiny" ? 1 : 2))
  const launcherVisible = createMemo(() => homeDensity() !== "tiny")
  const agentViewHomeActive = createMemo(() => launcherVisible() && homeWelcomeRightPanel() === "agentManager")
  const launcherCompact = createMemo(() => homeDensity() === "compact")
  const launcherWidth = createMemo(() => Math.min(44, Math.max(28, dimensions().width - sidePadding() * 4)))
  const splitPanelInnerWidth = createMemo(() => Math.max(24, dimensions().width - sidePadding() * 2 - 6))
  const splitTitleRawWidth = createMemo(() => maxLineWidth(customProductAscii()))
  const splitAgentPanelMinWidth = 42
  const splitIdentityMinWidth = createMemo(() =>
    homeSplitIdentityWidth({
      logoWidth: showLogo() ? splitLogoWidth() : 0,
      titleWidth: logoMode() === "mascot" || !showLogo() ? splitTitleRawWidth() : 0,
      panelWidth: splitPanelInnerWidth(),
      agentMinWidth: splitAgentPanelMinWidth,
    }),
  )
  const splitTwoColumnWelcome = createMemo(
    () =>
      splitWelcome() &&
      launcherVisible() &&
      splitPanelInnerWidth() >= splitIdentityMinWidth() + splitAgentPanelMinWidth + 4,
  )
  const rightPanelWidth = createMemo(() => {
    if (homeWelcomeRightPanel() !== "agentManager") return launcherWidth()
    const available = splitTwoColumnWelcome()
      ? splitPanelInnerWidth() - splitIdentityMinWidth() - 4
      : splitPanelInnerWidth()
    return homeAgentViewPanelWidth({ available })
  })
  const splitRootLabel = createMemo(() => {
    const value = project.instance.path().directory || project.instance.path().worktree || mend.root
    const label = value.replace(/^\/Users\/[^/]+/, "~")
    const available = splitTwoColumnWelcome()
      ? splitPanelInnerWidth() - rightPanelWidth() - 6
      : splitPanelInnerWidth() - 4
    return Locale.truncateMiddle(label, Math.max(18, available))
  })
  const launcherTopPadding = createMemo(() => (launcherCompact() ? 1 : 2))
  const launcherLines = createMemo(() => [
    { label: "Resume session", hint: "ctrl-s" },
    { label: "Open commands", hint: "ctrl-p" },
    { label: "Quit", hint: "ctrl-c" },
  ])
  const visibleLauncherLines = createMemo(() => (launcherCompact() ? launcherLines().slice(0, 2) : launcherLines()))
  const launcherHintColor = "#a3a3a3"
  const launcherRuleColor = "#2f2f2f"
  const topPanelBorderColor = createMemo(() => {
    const agent = local.agent.current()
    return local.agent.color(agent?.name || "build")
  })
  const splitTitleAvailableWidth = createMemo(() =>
    homeSplitIdentityPaneWidth({
      panelWidth: splitPanelInnerWidth(),
      rightPanelWidth: rightPanelWidth(),
      twoColumn: splitTwoColumnWelcome(),
    }),
  )
  const splitRightPanelContainerWidth = createMemo(() =>
    homeRightPanelContainerWidth({
      rightPanelWidth: rightPanelWidth(),
      twoColumn: splitTwoColumnWelcome(),
      paddingRight: 1,
    }),
  )
  const splitProductAscii = createMemo(() =>
    fittedHomeLogoText({
      value: mend.profile.identity.productName || "MendCode",
      font: logoFont(),
      maxWidth: splitTitleAvailableWidth(),
      maxHeight: 6,
    }),
  )
  const splitTitleAsciiWidth = createMemo(() => maxLineWidth(splitProductAscii()))
  const showSplitAsciiTitle = createMemo(() => {
    if (homeDensity() !== "full") return false
    return splitTitleAsciiWidth() <= splitTitleAvailableWidth()
  })
  const splitProductText = createMemo(() =>
    Locale.truncate(mend.profile.identity.productName, Math.max(8, splitTitleAvailableWidth())),
  )
  const splitShowsSideTitle = createMemo(() => logoMode() === "mascot" || !showLogo())
  const agentViewSessionWindowMs = 30 * 24 * 60 * 60 * 1000
  const [globalBackgroundSessions, setGlobalBackgroundSessions] = createSignal<BackgroundSessionInfo[]>([])
  const [globalLoopWorkflows, setGlobalLoopWorkflows] = createSignal<AgentViewLoopWorkflow[]>([])
  const [globalAgentViewMetadata, setGlobalAgentViewMetadata] = createSignal<Record<string, AgentViewMetadataInfo>>({})
  const [globalAgentCommands, setGlobalAgentCommands] = createSignal<AgentViewCommand[]>([])
  const [globalSessions, setGlobalSessions] = createSignal<Session[]>([])
  const [globalStatuses, setGlobalStatuses] = createSignal<Record<string, SessionStatus>>({})
  const [globalPendingInput, setGlobalPendingInput] = createSignal<Record<string, number>>({})
  const [selectedAgentViewSessionID, setSelectedAgentViewSessionID] = createSignal<string | undefined>()
  const [hoveredAgentViewSessionID, setHoveredAgentViewSessionID] = createSignal<string | undefined>()
  const agentViewActiveSeenAt = new Map<string, number>()
  const agentViewActiveKind = new Map<string, "needsInput" | "looping" | "working">()
  const agentViewActiveGraceMs = 6_000
  let agentViewRefreshTimer: ReturnType<typeof setTimeout> | undefined
  let agentViewPollTimer: ReturnType<typeof setInterval> | undefined
  let agentViewRefreshInFlight: Promise<void> | undefined

  const groupPendingInput = (
    permissions: PermissionRequest[],
    questions: QuestionRequest[],
    planReviews: PlanReviewRequest[],
  ) => {
    const next: Record<string, number> = {}
    for (const request of permissions) next[request.sessionID] = (next[request.sessionID] ?? 0) + 1
    for (const request of questions) next[request.sessionID] = (next[request.sessionID] ?? 0) + 1
    for (const request of planReviews) next[request.sessionID] = (next[request.sessionID] ?? 0) + 1
    return next
  }

  function agentViewURL(path: string, query?: Record<string, string | number | boolean | undefined>) {
    const url = new URL(path, sdk.url)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    return url
  }

  const agentViewDirectory = createMemo(() => project.instance.path().directory || sdk.directory || "")
  const agentViewGlobalScope = createMemo(() => {
    const directory = agentViewDirectory()
    const home = project.instance.path().home || Global.Path.home
    return Boolean(directory && home && directory === home)
  })
  const agentViewScopeQuery = createMemo(() => ({
    directory: agentViewGlobalScope() ? undefined : agentViewDirectory() || undefined,
  }))
  const normalizeScopeDirectory = (value: string) => value.replace(/\/+$/, "")
  const isDirectoryInAgentViewScope = (directory: string | undefined, scope: string) => {
    if (!directory) return false
    const normalizedDirectory = normalizeScopeDirectory(directory)
    const normalizedScope = normalizeScopeDirectory(scope)
    return normalizedDirectory === normalizedScope || normalizedDirectory.startsWith(`${normalizedScope}/`)
  }
  const sessionDirectory = (item: AgentViewSessionItem) => item.background.session?.directory || item.session?.directory
  const isInAgentViewScope = (item: AgentViewSessionItem) => {
    if (agentViewGlobalScope()) return true
    const directory = agentViewDirectory()
    if (!directory) return true
    return isDirectoryInAgentViewScope(sessionDirectory(item), directory)
  }

  async function fetchAgentViewJSON<T>(path: string, query?: Record<string, string | number | boolean | undefined>) {
    const headers = new Headers(sdk.headers)
    if (sdk.directory) headers.set("x-mendcode-directory", encodeURIComponent(sdk.directory))
    const response = await sdk.fetch(agentViewURL(path, query), { headers })
    if (!response.ok) throw new Error(`${path} failed: ${response.status}`)
    return (await response.json()) as T
  }

  async function listAgentViewSessions() {
    const baseQuery = {
      roots: true as const,
      limit: 50,
      ...agentViewScopeQuery(),
    }
    const recent = await listAgentViewSessionsWithQuery({
      ...baseQuery,
      start: Date.now() - agentViewSessionWindowMs,
    })
    if (recent.length > 0) return recent
    const scoped = await listAgentViewSessionsWithQuery(baseQuery)
    if (scoped.length > 0) return scoped
    if (!baseQuery.directory) return scoped
    return listAgentViewSessionsWithQuery({
      roots: true,
      limit: baseQuery.limit,
    })
  }

  async function listAgentViewSessionsWithQuery(query: {
    directory?: string
    roots: true
    limit: number
    start?: number
  }) {
    const attempts = [
      () => fetchAgentViewJSON<Session[]>("/experimental/session", query),
      () =>
        sdk.client.experimental.session
          .list(query, { throwOnError: true })
          .then((result) => (result.data ?? []) as Session[]),
      () => sdk.client.session.list(query, { throwOnError: true }).then((result) => result.data ?? []),
    ]
    for (const attempt of attempts) {
      try {
        const sessions = await attempt()
        if (Array.isArray(sessions)) return sessions
      } catch {
        // Try the next data source; the Agent View should degrade to the normal session list.
      }
    }
    return []
  }

  async function listAgentViewAggregateSessions() {
    const baseQuery = {
      roots: true as const,
      limit: 50,
      ...agentViewScopeQuery(),
    }
    const recent = await fetchAgentViewJSON<BackgroundSessionInfo[]>("/session/agent-view", {
      ...baseQuery,
      start: Date.now() - agentViewSessionWindowMs,
    })
    if (recent.length > 0) return recent
    const scoped = await fetchAgentViewJSON<BackgroundSessionInfo[]>("/session/agent-view", baseQuery)
    if (scoped.length > 0) return scoped
    if (!baseQuery.directory) return scoped
    return fetchAgentViewJSON<BackgroundSessionInfo[]>("/session/agent-view", {
      roots: true,
      limit: baseQuery.limit,
    })
  }

  async function listAgentViewLoopWorkflows() {
    return fetchAgentViewJSON<AgentViewLoopWorkflow[]>(agentViewGlobalScope() ? "/loop/global" : "/loop")
  }

  async function refreshAgentViewGlobalState() {
    const [aggregate, background, metadata, commands, loops, sessions, statuses, permissions, questions, planReviews] = await Promise.allSettled([
      listAgentViewAggregateSessions(),
      fetchAgentViewJSON<BackgroundSessionInfo[]>("/session/background"),
      fetchAgentViewJSON<AgentViewMetadataInfo[]>("/session/agent-view/metadata"),
      fetchAgentViewJSON<AgentViewCommand[]>("/session/agent-command"),
      listAgentViewLoopWorkflows(),
      listAgentViewSessions(),
      sdk.client.session.status(),
      sdk.client.permission.list(),
      sdk.client.question.list(),
      sdk.client.planReview.list(),
    ])
    if (aggregate.status === "fulfilled") {
      setGlobalBackgroundSessions(
        background.status === "fulfilled"
          ? mergeAgentViewAggregateFallback(aggregate.value, background.value)
          : aggregate.value,
      )
    } else if (background.status === "fulfilled") setGlobalBackgroundSessions(background.value)
    if (metadata.status === "fulfilled") {
      setGlobalAgentViewMetadata(Object.fromEntries(metadata.value.map((info) => [info.sessionID, info])))
    }
    if (commands.status === "fulfilled") setGlobalAgentCommands(commands.value)
    if (loops.status === "fulfilled") setGlobalLoopWorkflows(loops.value)
    const pendingInputBySession = groupPendingInput(
      permissions.status === "fulfilled" ? (permissions.value.data ?? []) : [],
      questions.status === "fulfilled" ? (questions.value.data ?? []) : [],
      planReviews.status === "fulfilled" ? (planReviews.value.data ?? []) : [],
    )
    if (sessions.status === "fulfilled") {
      const byID = new Map(sessions.value.map((item) => [item.id, item]))
      const missingPendingSessions = await Promise.all(
        Object.keys(pendingInputBySession)
          .filter((sessionID) => !byID.has(sessionID))
          .map((sessionID) =>
            sdk.client.session
              .get({ sessionID }, { throwOnError: true })
              .then((result) => result.data)
              .catch(() => undefined),
          ),
      )
      for (const item of missingPendingSessions) {
        if (item) byID.set(item.id, item)
      }
      setGlobalSessions(Array.from(byID.values()))
    }
    if (statuses.status === "fulfilled") setGlobalStatuses(statuses.value.data ?? {})
    setGlobalPendingInput(pendingInputBySession)
  }

  function runAgentViewGlobalRefresh() {
    if (agentViewRefreshInFlight) return agentViewRefreshInFlight
    agentViewRefreshInFlight = refreshAgentViewGlobalState().finally(() => {
      agentViewRefreshInFlight = undefined
    })
    return agentViewRefreshInFlight
  }

  const scheduleAgentViewRefresh = () => {
    if (!agentViewHomeActive()) return
    if (agentViewRefreshTimer) clearTimeout(agentViewRefreshTimer)
    agentViewRefreshTimer = setTimeout(() => {
      agentViewRefreshTimer = undefined
      if (!agentViewHomeActive()) return
      void runAgentViewGlobalRefresh().catch(() => undefined)
    }, 25)
  }

  createEffect(() => {
    if (!agentViewHomeActive()) return
    scheduleAgentViewRefresh()
  })

  createEffect(() => {
    const active = agentViewHomeActive()
    if (!active) {
      if (agentViewRefreshTimer) {
        clearTimeout(agentViewRefreshTimer)
        agentViewRefreshTimer = undefined
      }
      if (agentViewPollTimer) {
        clearInterval(agentViewPollTimer)
        agentViewPollTimer = undefined
      }
      return
    }
    if (agentViewPollTimer) return
    agentViewPollTimer = setInterval(scheduleAgentViewRefresh, 2_000)
  })

  const shouldRefreshAgentViewForEvent = (event: GlobalEvent) => {
    const type = event.payload?.type as string | undefined
    return (
      type === "session.created" ||
      type === "session.updated" ||
      type === "session.deleted" ||
      type === "session.status" ||
      type === "session.idle" ||
      type === "session.error" ||
      type === "session.next.prompted" ||
      type === "session.next.step.started" ||
      type === "session.next.step.ended" ||
      type === "session.next.step.failed" ||
      type === "background_session.updated" ||
      type === "background_session.deleted" ||
      type === "agent_view.metadata.updated" ||
      type === "agent_view.metadata.deleted" ||
      type === "agent_command.created" ||
      type === "agent_command.updated" ||
      type === "permission.asked" ||
      type === "permission.replied" ||
      type === "question.asked" ||
      type === "question.replied" ||
      type === "question.rejected" ||
      type === "plan_review.asked" ||
      type === "plan_review.replied" ||
      Boolean(type?.startsWith("loop."))
    )
  }

  const unsubscribeAgentViewEvents = sdk.event.on("event", (event) => {
    if (shouldRefreshAgentViewForEvent(event)) scheduleAgentViewRefresh()
  })
  onCleanup(() => {
    unsubscribeAgentViewEvents()
    if (agentViewRefreshTimer) clearTimeout(agentViewRefreshTimer)
    if (agentViewPollTimer) clearInterval(agentViewPollTimer)
  })

  const pendingInputCount = (sessionID: string) => {
    const pendingCommands = countAgentViewCommands({ commands: globalAgentCommands(), sessionID, states: ["pending"] })
    const local =
      (sync.data.permission[sessionID]?.length ?? 0) +
      (sync.data.question[sessionID]?.length ?? 0) +
      (sync.data.plan_review[sessionID]?.length ?? 0)
    return Math.max(globalPendingInput()[sessionID] ?? 0, local) + pendingCommands
  }
  const activeForegroundState = (sessionID: string): BackgroundSessionInfo["state"] | undefined => {
    const status = globalStatuses()[sessionID] ?? sync.data.session_status[sessionID]
    if (pendingInputCount(sessionID) > 0 || status?.type === "retry") return "needs_input"
    if (status?.type === "busy") return "working"
    return undefined
  }
  const statusStartedAt = (status: SessionStatus | undefined) =>
    status?.type === "busy" ? status.startedAt : undefined
  const loopWorkflowByRootSessionID = createMemo(() => {
    const result = new Map<string, AgentViewLoopWorkflow>()
    for (const workflow of globalLoopWorkflows()) {
      if (workflow.rootSessionID) result.set(workflow.rootSessionID, workflow)
    }
    return result
  })
  const loopRootSessionIDs = createMemo(() => agentViewLoopRootSessionIDs(globalLoopWorkflows()))
  const loopWorkflowForSession = (sessionID: string) => loopWorkflowByRootSessionID().get(sessionID)
  const agentViewStartedAt = (item: AgentViewSessionItem) =>
    loopWorkflowForSession(item.background.sessionID)?.time?.created ??
    statusStartedAt(globalStatuses()[item.background.sessionID] ?? sync.data.session_status[item.background.sessionID]) ??
    item.background.process?.started ??
    item.background.time.created
  const isLoopSession = (item: AgentViewSessionItem) =>
    isAgentViewLoopSession({
      sessionID: item.background.sessionID,
      title: item.background.session?.title ?? item.session?.title,
      summary: item.background.summary,
      loopRootSessionIDs: loopRootSessionIDs(),
    })
  const isCompletedLoopSession = (item: AgentViewSessionItem) =>
    isAgentViewCompletedLoop({
      state: loopWorkflowForSession(item.background.sessionID)?.state,
      summary: item.background.summary,
    })
  const backgroundStateForLoopWorkflow = (workflow: AgentViewLoopWorkflow): BackgroundSessionInfo["state"] => {
    if (workflow.state === "working") return "working"
    if (workflow.state === "needs_input") return "needs_input"
    if (workflow.state === "failed") return "failed"
    if (workflow.state === "stopped" || workflow.state === "paused") return "stopped"
    if (!activeLoopWorkflowStates.has(workflow.state)) return "completed"
    return "queued"
  }
  const rawAgentViewActivity = (item: AgentViewSessionItem): AgentViewActivity => {
    const sessionID = item.background.sessionID
    const status = globalStatuses()[sessionID] ?? sync.data.session_status[sessionID]
    if (isLoopSession(item)) return "looping"
    if (item.background.state === "failed" || item.background.state === "stopped") return "completed"
    if (pendingInputCount(sessionID) > 0 || status?.type === "retry" || item.background.state === "needs_input") return "needsInput"
    if (status?.type === "busy" || item.background.state === "queued" || item.background.state === "working") return "working"
    return "completed"
  }
  const agentViewActivity = (item: AgentViewSessionItem, now: number): AgentViewActivity => {
    const sessionID = item.background.sessionID
    const raw = rawAgentViewActivity(item)
    if (raw !== "completed") {
      agentViewActiveSeenAt.set(sessionID, now)
      agentViewActiveKind.set(sessionID, raw)
      return raw
    }

    const status = globalStatuses()[sessionID] ?? sync.data.session_status[sessionID]
    if (status?.type === "idle") {
      agentViewActiveSeenAt.delete(sessionID)
      agentViewActiveKind.delete(sessionID)
      return raw
    }

    const lastSeenAt = agentViewActiveSeenAt.get(sessionID)
    const lastKind = agentViewActiveKind.get(sessionID)
    if (lastKind && homeAgentViewRecentlyActive({ now, lastSeenAt, graceMs: agentViewActiveGraceMs })) return lastKind
    agentViewActiveSeenAt.delete(sessionID)
    agentViewActiveKind.delete(sessionID)
    return raw
  }
  const agentViewSessions = createMemo(() => {
    const byID = new Map<string, Session>()
    for (const session of globalSessions()) byID.set(session.id, session)
    for (const session of sync.data.session) byID.set(session.id, session)
    const backgroundItems = globalBackgroundSessions()
      .map((background) => {
        const workflow = loopWorkflowForSession(background.sessionID)
        const session = byID.get(background.sessionID)
        const metadata = background.metadata ?? globalAgentViewMetadata()[background.sessionID]
        return {
          background: workflow
            ? {
                ...background,
                metadata,
                state: backgroundStateForLoopWorkflow(workflow),
                summary: `Loop ${workflow.state}: ${workflow.phase ?? "ready"}`,
                time: {
                  ...background.time,
                  updated: Math.max(background.time.updated, workflow.time?.updated ?? 0),
                },
                session: background.session ?? session,
              }
            : {
                ...background,
                metadata,
              },
          session,
        }
      })
      .filter(isInAgentViewScope)
      .filter((item) => !isCompletedLoopSession(item))
    const backgroundIDs = new Set(backgroundItems.map((item) => item.background.sessionID))
    const foregroundItems = Array.from(byID.values())
      .filter((session) => agentViewGlobalScope() || !agentViewDirectory() || isDirectoryInAgentViewScope(session.directory, agentViewDirectory()))
      .filter((session) => !backgroundIDs.has(session.id))
      .filter((session) => !(session as { parentID?: string | null }).parentID)
      .map((session): AgentViewSessionItem => {
        const workflow = loopWorkflowForSession(session.id)
        const state = activeForegroundState(session.id) ?? "completed"
        const status = globalStatuses()[session.id] ?? sync.data.session_status[session.id]
        const background: AgentViewBackgroundSession = {
          sessionID: session.id,
          state,
          summary: status?.type === "retry" ? status.message : session.path || session.directory || state,
          metadata: globalAgentViewMetadata()[session.id],
          time: session.time,
          session: {
            id: session.id,
            title: session.title,
            directory: session.directory,
            path: session.path,
            agent: session.agent,
            time: session.time,
          },
        }
        return {
          session,
          background: workflow
            ? {
                ...background,
                pinned: true,
                state: backgroundStateForLoopWorkflow(workflow),
                summary: `Loop ${workflow.state}: ${workflow.phase ?? "ready"}`,
                time: {
                  ...background.time,
                  updated: Math.max(background.time.updated, workflow.time?.updated ?? 0),
                },
              }
            : background,
        }
      })
      .filter((item) => !isCompletedLoopSession(item))
    const items = [...backgroundItems, ...foregroundItems]
    const now = Date.now()
    const visible = items.filter((item) =>
      homeAgentViewRecentlyActive({
        now,
        lastSeenAt: agentViewActiveSeenAt.get(item.background.sessionID),
        graceMs: agentViewActiveGraceMs,
      }) ||
      isAgentViewSessionVisible({
        item,
        status: globalStatuses()[item.background.sessionID] ?? sync.data.session_status[item.background.sessionID],
        pendingInput: pendingInputCount(item.background.sessionID),
        pendingCommands: countAgentViewCommands({
          commands: globalAgentCommands(),
          sessionID: item.background.sessionID,
          states: ["pending"],
        }),
        activeCommands: countAgentViewCommands({
          commands: globalAgentCommands(),
          sessionID: item.background.sessionID,
          states: ["accepted", "running"],
        }),
        blockedCommands: countAgentViewCommands({
          commands: globalAgentCommands(),
          sessionID: item.background.sessionID,
          states: ["rejected", "failed", "expired"],
        }),
        now,
      }),
    )
    const displayItems = visible.length > 0 ? visible : items.filter(isAgentViewSessionFallbackVisible)
    return displayItems
      .toSorted(
        (a, b) => b.background.time.updated - a.background.time.updated || b.background.sessionID.localeCompare(a.background.sessionID),
      )
  })
  const widthForHomeAgentViewSummary = () => rightPanelWidth()
  const agentViewState = createMemo(() => {
    const needsInput: ReturnType<typeof agentViewSessions> = []
    const looping: ReturnType<typeof agentViewSessions> = []
    const working: ReturnType<typeof agentViewSessions> = []
    const completed: ReturnType<typeof agentViewSessions> = []
    const visibleIDs = new Set<string>()
    const now = Date.now()
    for (const item of agentViewSessions()) {
      visibleIDs.add(item.background.sessionID)
      const activity = agentViewActivity(item, now)
      if (activity === "needsInput") needsInput.push(item)
      else if (activity === "looping") looping.push(item)
      else if (activity === "working") working.push(item)
      else completed.push(item)
    }
    for (const sessionID of agentViewActiveSeenAt.keys()) {
      if (visibleIDs.has(sessionID)) continue
      agentViewActiveSeenAt.delete(sessionID)
      agentViewActiveKind.delete(sessionID)
    }
    return { needsInput, looping, working, completed }
  })
  const agentViewSummaryVisible = createMemo(() => {
    const state = agentViewState()
    return homeAgentViewSummaryVisible({
      waiting: state.needsInput.length,
      looping: state.looping.length,
      working: state.working.length,
    })
  })
  const agentViewSummary = createMemo(() => {
    const state = agentViewState()
    return homeAgentViewSummaryLines({
      waiting: state.needsInput.length,
      looping: state.looping.length,
      working: state.working.length,
      width: widthForHomeAgentViewSummary(),
    })
  })
  const agentViewOrchestrationSummary = createMemo(() => {
    const visibleSessionIDs = agentViewSessions().map((item) => item.background.sessionID)
    return summarizeAgentViewOrchestration({
      commands: globalAgentCommands(),
      sessionIDs: visibleSessionIDs,
      pendingLimitPerTarget: 3,
    })
  })
  const agentViewInboxSummaryVisible = createMemo(() => {
    const summary = agentViewOrchestrationSummary()
    return homeAgentInboxSummaryVisible(summary)
  })
  const agentViewHeadlineVisible = createMemo(() => agentViewSummaryVisible() || agentViewInboxSummaryVisible())
  const agentViewInboxSummary = createMemo(() =>
    homeAgentInboxSummaryLines({ summary: agentViewOrchestrationSummary(), width: widthForHomeAgentViewSummary() }),
  )
  const visibleAgentViewRows = createMemo(() => [
    ...agentViewState().needsInput.slice(0, 3),
    ...agentViewState().looping.slice(0, 4),
    ...agentViewState().working.slice(0, 4),
    ...agentViewState().completed.slice(0, 3),
  ])
  const selectedAgentViewItem = createMemo(() =>
    visibleAgentViewRows().find((item) => item.background.sessionID === selectedAgentViewSessionID()),
  )
  const selectedAgentViewPromptSessionID = createMemo(() => {
    if (!agentViewHomeActive()) return undefined
    return selectedAgentViewItem()?.background.sessionID
  })
  const homePromptTarget = createMemo(() =>
    resolveHomePromptTarget({
      workspaceID: project.workspace.current(),
      selectedAgentViewSessionID: selectedAgentViewPromptSessionID(),
    }),
  )
  const moveAgentViewSelection = (direction: 1 | -1) => {
    const rows = visibleAgentViewRows()
    if (rows.length === 0) {
      setSelectedAgentViewSessionID(undefined)
      return
    }
    const current = rows.findIndex((item) => item.background.sessionID === selectedAgentViewSessionID())
    const next = current < 0 ? (direction > 0 ? 0 : rows.length - 1) : (current + direction + rows.length) % rows.length
    setSelectedAgentViewSessionID(rows[next]?.background.sessionID)
  }
  useKeyboard((evt) => {
    if (!agentViewHomeActive()) return
    if (dialog.stack.length > 0) return
    const rows = visibleAgentViewRows()
    if (rows.length === 0) return
    if (evt.name === "escape" && selectedAgentViewSessionID()) {
      evt.preventDefault()
      setSelectedAgentViewSessionID(undefined)
      return
    }
    const prompt = promptRef.current
    const promptInput = prompt?.current.input ?? ""
    if (promptInput !== "" || prompt?.submitPending) return
    if (evt.name === "up") {
      evt.preventDefault()
      moveAgentViewSelection(-1)
      return
    }
    if (evt.name === "down") {
      evt.preventDefault()
      moveAgentViewSelection(1)
      return
    }
    if (evt.name === "return") {
      const selected = selectedAgentViewItem()
      if (!selected) return
      if (
        !shouldOpenSelectedAgentViewSession({
          promptInput,
          submitPending: prompt?.submitPending,
          selectedSessionID: selected?.background.sessionID,
        })
      ) return
      evt.preventDefault()
      openAgentViewSession(selected)
    }
  })
  const sessionDetail = (item: AgentViewSessionItem) => {
    const pendingCommands = countAgentViewCommands({ commands: globalAgentCommands(), sessionID: item.background.sessionID, states: ["pending"] })
    if (pendingCommands > 0) return `${pendingCommands} command${pendingCommands === 1 ? "" : "s"} pending`
    const activeCommands = countAgentViewCommands({ commands: globalAgentCommands(), sessionID: item.background.sessionID, states: ["accepted", "running"] })
    if (activeCommands > 0) return `${activeCommands} command${activeCommands === 1 ? "" : "s"} active`
    const failedCommands = countAgentViewCommands({ commands: globalAgentCommands(), sessionID: item.background.sessionID, states: ["rejected", "failed", "expired"] })
    if (failedCommands > 0) return `${failedCommands} command${failedCommands === 1 ? "" : "s"} blocked`
    const pending = pendingInputCount(item.background.sessionID)
    if (pending > 0) return `${pending} input request${pending === 1 ? "" : "s"}`
    if (item.background.error) return Locale.truncateMiddle(item.background.error, Math.max(12, rightPanelWidth() - 22))
    const agentName = item.background.session?.agent || item.session?.agent
    const summaryIsState =
      item.background.summary === item.background.state ||
      (item.background.state === "completed" && item.background.summary === "working")
    const summaryIsAgent = Boolean(agentName && item.background.summary === agentName)
    if (item.background.summary && !summaryIsState && !summaryIsAgent) {
      return Locale.truncateMiddle(formatAgentViewDetailLabel(item.background.summary) ?? item.background.summary, Math.max(12, rightPanelWidth() - 22))
    }
    const status = globalStatuses()[item.background.sessionID] ?? sync.data.session_status[item.background.sessionID]
    if (status?.type === "retry") return Locale.truncateMiddle(status.message, Math.max(12, rightPanelWidth() - 22))
    if (status?.type === "busy") {
      return (
        formatAgentViewDetailLabel(item.background.summary) ||
        formatAgentViewPathLabel(item.background.session?.path) ||
        formatAgentViewPathLabel(item.session?.path) ||
        "working"
      )
    }
    const metadataParts = [
      item.background.metadata?.priority,
      item.background.metadata?.group,
      ...(item.background.metadata?.tags ?? []).map((tag) => `#${tag}`),
    ].filter(Boolean)
    if (metadataParts.length > 0) return Locale.truncateMiddle(metadataParts.join(" · "), Math.max(12, rightPanelWidth() - 22))
    return (
      formatAgentViewPathLabel(item.background.session?.path) ||
      formatAgentViewPathLabel(item.session?.path) ||
      formatAgentViewPathLabel(item.background.session?.directory) ||
      formatAgentViewPathLabel(item.session?.directory) ||
      item.background.session?.agent ||
      item.session?.agent ||
      item.background.state
    )
  }
  const timeLabel = (item: AgentViewSessionItem) => formatAgentViewSessionTime(item.background.time.updated)
  const elapsedLabel = (item: AgentViewSessionItem) =>
    homeAgentViewElapsedLabel({ now: Date.now(), startedAt: agentViewStartedAt(item) })
  const sessionTitle = (item: AgentViewSessionItem) =>
    item.background.metadata?.title ||
    item.background.session?.title ||
    item.session?.title ||
    item.background.session?.agent ||
    item.session?.agent ||
    item.background.sessionID
  const homeIdentityDetail = createMemo(() => productVersionLabel())
  const openAgentViewSession = (item: AgentViewSessionItem) => {
    route.navigate({
      type: "session",
      sessionID: item.background.session?.id || item.session?.id || item.background.sessionID,
    })
  }
  const promptPlaceholders = createMemo(() => {
    const selected = selectedAgentViewItem()
    if (!selected) return placeholder
    return {
      ...placeholder,
      normal: homePromptPlaceholderText({ selectedTitle: sessionTitle(selected) }),
    }
  })
  const logoSurface = () => (
    <Show when={homeIdentityKey()}>
      <TuiPluginRuntime.Slot name="home_logo" mode="replace">
        <Show
          when={logoMode() === "mascot" || props.surface?.homeAscii || !useCompactProductName()}
          fallback={<text fg={mend.profile.theme.tokens.foreground}>{mend.profile.identity.productName}</text>}
        >
          <box paddingBottom={logoBottomPad()}>
            <SurfaceLines text={activeHomeAscii()} />
          </box>
        </Show>
      </TuiPluginRuntime.Slot>
    </Show>
  )
  const homeActionsSurface = (options?: {
    alignItems?: "center" | "flex-end"
    paddingTop?: number
    width?: number | "100%"
  }) => (
    <Show
      when={props.surface?.homeBottom}
      fallback={
        <box
          paddingTop={options?.paddingTop ?? launcherTopPadding()}
          width={options?.width ?? "100%"}
          alignItems={options?.alignItems ?? "center"}
          flexShrink={0}
        >
          <box width={options?.width ?? launcherWidth()} maxWidth="100%" flexDirection="column" gap={0}>
            {visibleLauncherLines().map((item, index) => (
              <>
                <Show when={index > 0 && !launcherCompact()}>
                  <text fg={launcherRuleColor}>────────────────────────────────────────────</text>
                </Show>
                <box width="100%" height={1} flexDirection="row">
                  <text fg={mend.profile.theme.tokens.foreground}>{item.label}</text>
                  <box flexGrow={1} minWidth={1} />
                  <text fg={launcherHintColor}>{item.hint}</text>
                </box>
              </>
            ))}
          </box>
        </box>
      }
    >
      {(text) => (
        <box
          paddingTop={options?.paddingTop ?? launcherTopPadding()}
          alignItems={options?.alignItems ?? "center"}
          paddingLeft={sidePadding()}
          paddingRight={sidePadding()}
          flexShrink={0}
        >
          <SurfaceLines text={text()} />
        </box>
      )}
    </Show>
  )
  const homeAgentManagerSurface = (options?: { paddingTop?: number; width?: number | Accessor<number> }) => {
    const width = () => typeof options?.width === "function" ? options.width() : (options?.width ?? launcherWidth())
    const rowLayout = createMemo(() => homeAgentViewRowLayout({ width: width() }))
    const displayTimeLabel = (item: AgentViewSessionItem, maxWidth: number, elapsed?: boolean) => {
      const label = elapsed ? elapsedLabel(item) : timeLabel(item)
      if (Bun.stringWidth(label) <= maxWidth) return label
      if (elapsed) return Locale.truncateMiddle(label, maxWidth)
      const timeOnly = Locale.time(item.background.time.updated)
      if (Bun.stringWidth(timeOnly) <= maxWidth) return timeOnly
      return Locale.truncateMiddle(label.replace(" · ", " "), maxWidth)
    }
    const markerCell = (marker: () => JSX.Element | string, color: string) => (
      <box width={rowLayout().markerWidth} flexShrink={0}>
        {(() => {
          const value = marker()
          return typeof value === "string" ? <text fg={color} wrapMode="none">{value}</text> : value
        })()}
      </box>
    )
    const rowBackgroundColor = (item: AgentViewSessionItem) =>
      selectedAgentViewSessionID() === item.background.sessionID
        ? "#303030"
        : hoveredAgentViewSessionID() === item.background.sessionID
          ? "#242424"
          : undefined
    const row = (
      item: AgentViewSessionItem,
      marker: () => JSX.Element | string,
      color: string,
      options?: { elapsed?: boolean },
    ) => {
      const layout = rowLayout()
      return (
        <box
          width="100%"
          height={layout.compact ? 2 : 1}
          flexDirection="column"
          backgroundColor={rowBackgroundColor(item)}
          onMouseOver={() => setHoveredAgentViewSessionID(item.background.sessionID)}
          onMouseOut={() => setHoveredAgentViewSessionID((current) => current === item.background.sessionID ? undefined : current)}
          onMouseUp={() => setSelectedAgentViewSessionID(item.background.sessionID)}
        >
          <box width="100%" height={1} flexDirection="row">
            {markerCell(marker, color)}
            <box width={layout.titleWidth} flexShrink={0} overflow="hidden">
              <text fg={mend.profile.theme.tokens.foreground} wrapMode="none">
                {Locale.truncateMiddle(sessionTitle(item), layout.titleWidth)}
              </text>
            </box>
            <box width={1} flexShrink={0} />
            {!layout.compact && (
              <>
                <box width={layout.detailWidth} flexShrink={0} overflow="hidden">
                  <text fg={launcherHintColor} wrapMode="none">
                    {Locale.truncateMiddle(sessionDetail(item), layout.detailWidth)}
                  </text>
                </box>
                <box width={1} flexShrink={0} />
              </>
            )}
            <box width={layout.timeWidth} flexShrink={0} alignItems="flex-end">
              <text fg={launcherHintColor} wrapMode="none">
                {displayTimeLabel(item, layout.timeWidth, options?.elapsed)}
              </text>
            </box>
          </box>
          <Show when={layout.compact}>
            <box width="100%" height={1} flexDirection="row">
              <box width={layout.markerWidth} flexShrink={0} />
              <box width={layout.detailWidth} flexShrink={0} overflow="hidden">
                <text fg={launcherHintColor} wrapMode="none">
                  {Locale.truncateMiddle(sessionDetail(item), layout.detailWidth)}
                </text>
              </box>
            </box>
          </Show>
        </box>
      )
    }
    const section = (
      title: string,
      items: ReturnType<typeof agentViewSessions>,
      marker: (item: AgentViewSessionItem) => JSX.Element | string,
      color: string,
      max: number,
      options?: { elapsed?: boolean; gapBefore?: Accessor<boolean> },
    ) => (
      <Show when={items.length > 0}>
        <Show when={options?.gapBefore?.() ?? true}>
          <box height={1} />
        </Show>
        <text fg={mend.profile.theme.tokens.foreground} wrapMode="none">{title}</text>
        {items.slice(0, max).map((item) => row(item, () => marker(item), color, options))}
      </Show>
    )
    return (
        <box paddingTop={options?.paddingTop ?? 0} width={width()} flexDirection="column" gap={0} flexShrink={0}>
        <Show
          when={agentViewSessions().length > 0}
          fallback={
            <box width="100%" flexDirection="column" alignItems="center">
              <text fg={mend.profile.theme.tokens.muted} wrapMode="none">No sessions yet</text>
              <text fg={launcherHintColor} wrapMode="none">resume or start a task</text>
            </box>
          }
        >
          <Show when={agentViewSummaryVisible()}>
            <For each={agentViewSummary()}>{(line) =>
              <text fg={mend.profile.theme.tokens.muted} wrapMode="none">
                {Locale.truncate(line, Math.max(12, width()))}
              </text>
            }</For>
          </Show>
          <Show when={agentViewInboxSummaryVisible()}>
            <For each={agentViewInboxSummary()}>{(line) =>
              <text
                fg={agentViewOrchestrationSummary().overLimitTargets > 0 ? "#f59e0b" : launcherHintColor}
                wrapMode="none"
              >
                {Locale.truncate(line, Math.max(12, width()))}
              </text>
            }</For>
          </Show>
          {section("Needs input", agentViewState().needsInput, () => "✱", mend.profile.theme.tokens.accent, 3, {
            elapsed: true,
            gapBefore: () => homeAgentViewSectionGapVisible({
              headlineVisible: agentViewHeadlineVisible(),
              precedingSectionCounts: [],
            }),
          })}
          {section("Looping", agentViewState().looping, () => "↻", mend.profile.theme.tokens.accent, 4, {
            elapsed: true,
            gapBefore: () => homeAgentViewSectionGapVisible({
              headlineVisible: agentViewHeadlineVisible(),
              precedingSectionCounts: [agentViewState().needsInput.length],
            }),
          })}
          {section(
            "Working",
            agentViewState().working,
            () => <Spinner />,
            launcherHintColor,
            4,
            {
              elapsed: true,
              gapBefore: () => homeAgentViewSectionGapVisible({
                headlineVisible: agentViewHeadlineVisible(),
                precedingSectionCounts: [agentViewState().needsInput.length, agentViewState().looping.length],
              }),
            },
          )}
          {section("Completed", agentViewState().completed, () => "✦", "#86efac", 3, {
            gapBefore: () => homeAgentViewSectionGapVisible({
              headlineVisible: agentViewHeadlineVisible(),
              precedingSectionCounts: [
                agentViewState().needsInput.length,
                agentViewState().looping.length,
                agentViewState().working.length,
              ],
            }),
          })}
        </Show>
      </box>
    )
  }
  const homeRightPanelSurface = () =>
    homeWelcomeRightPanel() === "agentManager"
      ? homeAgentManagerSurface({ paddingTop: 0, width: rightPanelWidth })
      : homeActionsSurface({ alignItems: "flex-end", paddingTop: 0, width: launcherWidth() })

  return (
    <>
      <box flexGrow={1} flexDirection="column">
        <Show when={!splitWelcome()}>
          <box
            width="100%"
            flexDirection="row"
            paddingTop={rootPaddingTop()}
            paddingLeft={sidePadding()}
            paddingRight={sidePadding()}
            flexShrink={0}
          >
            <text fg={mend.profile.theme.tokens.muted}>{rootLabel()}</text>
            <box flexGrow={1} minWidth={1} />
            <text fg={mend.profile.theme.tokens.muted}>{productVersionLabel()}</text>
          </box>
        </Show>
        <box
          flexGrow={1}
          minHeight={0}
          alignItems="center"
          paddingLeft={sidePadding()}
          paddingRight={sidePadding()}
          flexDirection="column"
        >
          <Show
            when={splitWelcome()}
            fallback={
              <>
                <box flexGrow={1} minHeight={0} />
                <Show when={showLogo()}>
                  <box flexShrink={0} alignItems="center">
                    {logoSurface()}
                  </box>
                </Show>
                <box height={logoPromptGap()} minHeight={0} flexShrink={0} />
                <Show when={launcherVisible()}>
                  <Show
                    when={homeWelcomeRightPanel() === "agentManager"}
                    fallback={homeActionsSurface()}
                  >
                    {homeAgentManagerSurface({ paddingTop: launcherTopPadding(), width: rightPanelWidth })}
                  </Show>
                </Show>
                <box flexGrow={1} minHeight={0} />
              </>
            }
          >
            <box width="100%" flexDirection="column" paddingTop={1} flexGrow={1} minHeight={0}>
              <box
                width="100%"
                flexDirection={splitTwoColumnWelcome() ? "row" : "column"}
                flexShrink={0}
                alignItems="center"
                minHeight={13}
                border={["top", "bottom", "left", "right"]}
                borderColor={topPanelBorderColor()}
                customBorderChars={{
                  ...SplitBorder.customBorderChars,
                  topLeft: "┌",
                  topRight: "┐",
                  bottomLeft: "└",
                  bottomRight: "┘",
                  horizontal: "─",
                  vertical: "│",
                }}
                paddingTop={1}
                paddingBottom={1}
                paddingLeft={2}
                paddingRight={2}
              >
                <box
                  flexDirection="column"
                  width={splitTwoColumnWelcome() ? splitTitleAvailableWidth() : "100%"}
                  flexGrow={0}
                  minWidth={splitTwoColumnWelcome() ? Math.min(32, splitTitleAvailableWidth()) : 0}
                  alignItems="center"
                  justifyContent="center"
                >
                  <Show when={showLogo()}>
                    <box flexShrink={0} alignItems="center">
                      {logoSurface()}
                    </box>
                  </Show>
                  <box
                    flexDirection="column"
                    width={splitTwoColumnWelcome() ? splitTitleAvailableWidth() : "100%"}
                    flexGrow={0}
                    minWidth={Math.min(20, splitTitleAvailableWidth())}
                    justifyContent="center"
                    alignItems="center"
                  >
                    <Show when={splitShowsSideTitle()}>
                      <Show
                        when={showSplitAsciiTitle()}
                        fallback={
                          <box width="100%" alignItems="center">
                            <text fg={mend.profile.theme.tokens.foreground} wrapMode="none">{splitProductText()}</text>
                          </box>
                        }
                      >
                        <box>
                          <SurfaceLines text={splitProductAscii()} />
                        </box>
                      </Show>
                    </Show>
                    <text fg={mend.profile.theme.tokens.muted} wrapMode="none">{splitRootLabel()}</text>
                    <text fg={mend.profile.theme.tokens.muted} wrapMode="none">{homeIdentityDetail()}</text>
                  </box>
                </box>
                <Show when={splitTwoColumnWelcome()}>
                  <box width={2} flexShrink={0} />
                </Show>
                <Show when={launcherVisible()}>
                  <box
                    width={splitTwoColumnWelcome() ? splitRightPanelContainerWidth() : "100%"}
                    flexShrink={0}
                    alignItems={splitTwoColumnWelcome() ? "flex-end" : "center"}
                    paddingTop={splitTwoColumnWelcome() ? 0 : 1}
                    paddingRight={splitTwoColumnWelcome() ? 1 : 0}
                    overflow="hidden"
                  >
                    {homeRightPanelSurface()}
                  </box>
                </Show>
              </box>
              <box flexGrow={1} minHeight={0} />
            </box>
          </Show>
          <box
            width="100%"
            zIndex={1000}
            paddingBottom={homeDensity() === "tiny" ? 0 : 1}
            paddingLeft={promptEdgeToEdge() ? 0 : 2}
            paddingRight={promptEdgeToEdge() ? 0 : 2}
            flexShrink={0}
          >
            <TuiPluginRuntime.Slot
              name="home_prompt"
              mode="replace"
              workspace_id={project.workspace.current()}
              ref={props.bind}
            >
              {
                renderMendEditor({
                  workspaceID: project.workspace.current(),
                  disabled: props.disabled,
                  ref: props.bind,
                  right: <TuiPluginRuntime.Slot name="home_prompt_right" workspace_id={project.workspace.current()} />,
                  defaultEditor: () => (
                    <Prompt
                      ref={props.bind}
                      disabled={props.disabled}
                      historyScope={homePromptTarget().historyScope}
                      workspaceID={project.workspace.current()}
                      right={
                        <TuiPluginRuntime.Slot name="home_prompt_right" workspace_id={project.workspace.current()} />
                      }
                      sessionID={homePromptTarget().sessionID}
                      placeholders={promptPlaceholders()}
                    />
                  ),
                }) as any
              }
            </TuiPluginRuntime.Slot>
          </box>
          <Show when={props.showToast !== false}>
            <Toast />
          </Show>
        </box>
      </box>
    </>
  )
}

export function Home(props: { revision?: number; pluginsReady?: boolean }) {
  const sync = useSync()
  const route = useRouteData("home")
  const promptRef = usePromptRef()
  const [ref, setRef] = createSignal<PromptRef | undefined>()
  const args = useArgs()
  const local = useLocal()
  const editor = useEditorContext()
  let sent = false

  onMount(() => {
    editor.clearSelection()
  })

  const bind = (r: PromptRef | undefined) => {
    setRef(r)
    promptRef.set(r)
    if (once || !r) return
    if (route.prompt) {
      r.set(route.prompt)
      once = true
      return
    }
    if (!args.prompt) return
    r.set({ input: args.prompt, parts: [] })
    once = true
  }

  // Wait for sync and model store to be ready before auto-submitting --prompt
  createEffect(() => {
    const r = ref()
    if (sent) return
    if (!r) return
    if (props.pluginsReady === false || !sync.ready || !sync.providerMetadataReady || !local.model.ready) return
    if (!args.prompt) return
    if (r.current.input !== args.prompt) return
    sent = true
    r.submit()
  })

  return <HomeSurface bind={bind} revision={props.revision} disabled={false} />
}
