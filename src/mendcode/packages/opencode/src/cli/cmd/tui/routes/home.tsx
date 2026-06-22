import { Prompt, type PromptRef } from "@tui/component/prompt"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show, type JSX } from "solid-js"
import { Logo } from "../component/logo"
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
import { asciiTextWidth, renderAsciiText, type HomeLogoFont } from "../component/ascii-text"
import { homeMascotText } from "@/mend/tui/mascot"
import { logo as mendLogo } from "@/cli/logo"
import { Locale } from "@/util/locale"
import { Global } from "@mendcode/core/global"
import { Installation } from "@/installation"
import type { GlobalEvent, PermissionRequest, PlanReviewRequest, QuestionRequest, Session, SessionStatus } from "@mendcode/sdk/v2"
import {
  isAgentViewSessionFallbackVisible,
  isAgentViewSessionVisible,
  formatAgentViewSessionTime,
  type AgentViewBackgroundSession,
  type AgentViewSessionItem,
} from "../util/agent-view"

type BackgroundSessionInfo = AgentViewBackgroundSession & {
  pinned?: boolean | null
  writer?: {
    clientID: string
    acquired: number
    expires: number
  } | null
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

const activeLoopWorkflowStates = new Set(["active", "sleeping", "working", "needs_input", "blocked"])

let once = false
const placeholder = {
  normal: ["Fix a TODO in the codebase", "What is the tech stack of this project?", "Fix broken tests"],
  shell: ["ls -la", "git status", "pwd"],
}

function SurfaceLines(props: { text: string }) {
  const width = props.text.split("\n").reduce((max, line) => Math.max(max, line.length), 0)
  return (
    <box flexDirection="column" width={width}>
      {props.text.split("\n").map((line) => (
        <text wrapMode="none">{line}</text>
      ))}
    </box>
  )
}

function countLines(text: string | undefined) {
  if (!text) return 0
  return text.split("\n").length
}

function maxLineWidth(text: string | undefined) {
  if (!text) return 0
  return text.split("\n").reduce((max, line) => Math.max(max, line.length), 0)
}

function logoShapeWidth(shape: { left: string[]; right: string[] }) {
  return shape.left.reduce((max, line, index) => Math.max(max, line.length + 1 + (shape.right[index]?.length ?? 0)), 0)
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
  const useProfileIdentityLogo = createMemo(() => mend.profile.identity.productName !== "MendCode")
  const customProductAscii = createMemo(() => renderAsciiText(mend.profile.identity.productName, logoFont()))
  const configuredHomeAscii = createMemo(() => (logoMode() === "mascot" ? homeMascotText(mend.profile) : undefined))
  const activeHomeAscii = createMemo(() => props.surface?.homeAscii || configuredHomeAscii())
  const homeIdentityKey = createMemo(
    () =>
      `${props.revision ?? 0}:${mend.profile.identity.productName}:${logoFont()}:${logoMode()}:${activeHomeAscii() ?? ""}`,
  )
  const homeDensity = createMemo<"full" | "compact" | "tiny">(() => {
    const height = dimensions().height
    if (height <= 17) return "tiny"
    if (height <= 23 || dimensions().width <= 64) return "compact"
    return "full"
  })
  const logoLines = createMemo(() => {
    const homeAscii = activeHomeAscii()
    if (homeAscii) return countLines(homeAscii)
    return useProfileIdentityLogo() ? countLines(customProductAscii()) : 7
  })
  const splitLogoWidth = createMemo(() => {
    const homeAscii = activeHomeAscii()
    if (homeAscii) return maxLineWidth(homeAscii)
    if (useProfileIdentityLogo()) return asciiTextWidth(mend.profile.identity.productName, logoFont())
    return logoShapeWidth(mendLogo)
  })
  const showLogo = createMemo(() => {
    if (homeDensity() === "tiny") return false
    return dimensions().height - logoLines() >= 13
  })
  const useCompactProductName = createMemo(() => {
    if (homeDensity() !== "full") return true
    return dimensions().width < asciiTextWidth(mend.profile.identity.productName, logoFont()) + 12
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
  const splitIdentityMinWidth = createMemo(() => (showLogo() ? splitLogoWidth() + 3 : 0) + 24)
  const splitAgentPanelMinWidth = 54
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
    return Math.min(82, Math.max(36, available))
  })
  const splitRootLabel = createMemo(() => {
    const value = project.instance.path().directory || project.instance.path().worktree || mend.root
    const label = value.replace(/^\/Users\/[^/]+/, "~")
    const available = splitTwoColumnWelcome()
      ? splitPanelInnerWidth() - rightPanelWidth() - (showLogo() ? splitLogoWidth() + 8 : 6)
      : splitPanelInnerWidth() - (showLogo() ? splitLogoWidth() + 8 : 4)
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
    Math.max(
      24,
      splitTwoColumnWelcome()
        ? splitPanelInnerWidth() - rightPanelWidth() - (showLogo() ? splitLogoWidth() + 10 : 6)
        : splitPanelInnerWidth() - (showLogo() ? splitLogoWidth() + 8 : 4),
    ),
  )
  const splitProductAscii = createMemo(() => {
    const productName = mend.profile.identity.productName
    const configured = customProductAscii()
    if (countLines(configured) <= 3 && maxLineWidth(configured) <= splitTitleAvailableWidth()) return configured

    for (const font of ["mendcode", "classic"] satisfies HomeLogoFont[]) {
      const compact = renderAsciiText(productName, font)
      if (maxLineWidth(compact) <= splitTitleAvailableWidth()) return compact
    }
    return renderAsciiText(productName, "classic")
  })
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
  const [globalSessions, setGlobalSessions] = createSignal<Session[]>([])
  const [globalStatuses, setGlobalStatuses] = createSignal<Record<string, SessionStatus>>({})
  const [globalPendingInput, setGlobalPendingInput] = createSignal<Record<string, number>>({})
  const [selectedAgentViewSessionID, setSelectedAgentViewSessionID] = createSignal<string | undefined>()
  const [hoveredAgentViewSessionID, setHoveredAgentViewSessionID] = createSignal<string | undefined>()
  let agentViewRefreshTimer: ReturnType<typeof setTimeout> | undefined
  let agentViewPollTimer: ReturnType<typeof setInterval> | undefined

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
    return listAgentViewSessionsWithQuery(baseQuery)
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

  async function refreshAgentViewGlobalState() {
    const [background, loops, sessions, statuses, permissions, questions, planReviews] = await Promise.allSettled([
      fetchAgentViewJSON<BackgroundSessionInfo[]>("/session/background"),
      fetchAgentViewJSON<AgentViewLoopWorkflow[]>("/loop"),
      listAgentViewSessions(),
      sdk.client.session.status(),
      sdk.client.permission.list(),
      sdk.client.question.list(),
      sdk.client.planReview.list(),
    ])
    if (background.status === "fulfilled") setGlobalBackgroundSessions(background.value)
    if (loops.status === "fulfilled") setGlobalLoopWorkflows(loops.value)
    if (sessions.status === "fulfilled") setGlobalSessions(sessions.value)
    if (statuses.status === "fulfilled") setGlobalStatuses(statuses.value.data ?? {})
    setGlobalPendingInput(
      groupPendingInput(
        permissions.status === "fulfilled" ? (permissions.value.data ?? []) : [],
        questions.status === "fulfilled" ? (questions.value.data ?? []) : [],
        planReviews.status === "fulfilled" ? (planReviews.value.data ?? []) : [],
      ),
    )
  }

  const scheduleAgentViewRefresh = () => {
    if (!agentViewHomeActive()) return
    if (agentViewRefreshTimer) clearTimeout(agentViewRefreshTimer)
    agentViewRefreshTimer = setTimeout(() => {
      agentViewRefreshTimer = undefined
      void refreshAgentViewGlobalState().catch(() => undefined)
    }, 25)
  }

  createEffect(() => {
    if (!agentViewHomeActive()) return
    scheduleAgentViewRefresh()
  })

  createEffect(() => {
    const active = agentViewHomeActive()
    if (!active) {
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
    const local =
      (sync.data.permission[sessionID]?.length ?? 0) +
      (sync.data.question[sessionID]?.length ?? 0) +
      (sync.data.plan_review[sessionID]?.length ?? 0)
    return Math.max(globalPendingInput()[sessionID] ?? 0, local)
  }
  const activeForegroundState = (sessionID: string): BackgroundSessionInfo["state"] | undefined => {
    const status = globalStatuses()[sessionID] ?? sync.data.session_status[sessionID]
    if (pendingInputCount(sessionID) > 0 || status?.type === "retry") return "needs_input"
    if (status?.type === "busy") return "working"
    return undefined
  }
  const isLoopSession = (item: AgentViewSessionItem) =>
    item.background.summary?.startsWith("Loop ") ||
    item.background.session?.title?.startsWith("Loop:") ||
    item.session?.title?.startsWith("Loop:")
  const loopWorkflowByRootSessionID = createMemo(() => {
    const result = new Map<string, AgentViewLoopWorkflow>()
    for (const workflow of globalLoopWorkflows()) {
      if (workflow.rootSessionID) result.set(workflow.rootSessionID, workflow)
    }
    return result
  })
  const loopWorkflowForSession = (sessionID: string) => loopWorkflowByRootSessionID().get(sessionID)
  const backgroundStateForLoopWorkflow = (workflow: AgentViewLoopWorkflow): BackgroundSessionInfo["state"] => {
    if (workflow.state === "working") return "working"
    if (workflow.state === "needs_input") return "needs_input"
    if (workflow.state === "failed") return "failed"
    if (workflow.state === "stopped" || workflow.state === "paused") return "stopped"
    if (!activeLoopWorkflowStates.has(workflow.state)) return "completed"
    return "queued"
  }
  const isActiveLoopSession = (item: AgentViewSessionItem) => {
    const workflow = loopWorkflowForSession(item.background.sessionID)
    if (workflow) return activeLoopWorkflowStates.has(workflow.state)
    if (!isLoopSession(item)) return false
    return item.background.state !== "completed" && item.background.state !== "failed" && item.background.state !== "stopped"
  }
  const agentViewSessions = createMemo(() => {
    const byID = new Map<string, Session>()
    for (const session of globalSessions()) byID.set(session.id, session)
    for (const session of sync.data.session) byID.set(session.id, session)
    const backgroundItems = globalBackgroundSessions()
      .map((background) => {
        const workflow = loopWorkflowForSession(background.sessionID)
        const session = byID.get(background.sessionID)
        return {
          background: workflow
            ? {
                ...background,
                state: backgroundStateForLoopWorkflow(workflow),
                summary: `Loop ${workflow.state}: ${workflow.phase ?? "ready"}`,
                time: {
                  ...background.time,
                  updated: Math.max(background.time.updated, workflow.time?.updated ?? 0),
                },
                session: background.session ?? session,
              }
            : background,
          session,
        }
      })
      .filter(isInAgentViewScope)
    const backgroundIDs = new Set(backgroundItems.map((item) => item.background.sessionID))
    const foregroundItems = Array.from(byID.values())
      .filter((session) => agentViewGlobalScope() || !agentViewDirectory() || isDirectoryInAgentViewScope(session.directory, agentViewDirectory()))
      .filter((session) => !backgroundIDs.has(session.id))
      .filter((session) => !(session as { parentID?: string | null }).parentID)
      .map((session): AgentViewSessionItem => {
        const state = activeForegroundState(session.id) ?? "completed"
        const status = globalStatuses()[session.id] ?? sync.data.session_status[session.id]
        return {
          session,
          background: {
            sessionID: session.id,
            state,
            summary: status?.type === "retry" ? status.message : session.path || session.directory || state,
            time: session.time,
            session: {
              id: session.id,
              title: session.title,
              directory: session.directory,
              path: session.path,
              agent: session.agent,
              time: session.time,
            },
          },
        }
      })
    const items = [...backgroundItems, ...foregroundItems]
    const visible = items.filter((item) =>
      isAgentViewSessionVisible({
        item,
        status: globalStatuses()[item.background.sessionID] ?? sync.data.session_status[item.background.sessionID],
        pendingInput: pendingInputCount(item.background.sessionID),
      }),
    )
    const displayItems = visible.length > 0 ? visible : items.filter(isAgentViewSessionFallbackVisible)
    return displayItems
      .toSorted(
        (a, b) => b.background.time.updated - a.background.time.updated || b.background.sessionID.localeCompare(a.background.sessionID),
      )
  })
  const agentViewState = createMemo(() => {
    const needsInput: ReturnType<typeof agentViewSessions> = []
    const looping: ReturnType<typeof agentViewSessions> = []
    const working: ReturnType<typeof agentViewSessions> = []
    const completed: ReturnType<typeof agentViewSessions> = []
    for (const item of agentViewSessions()) {
      const sessionID = item.background.sessionID
      const status = globalStatuses()[sessionID] ?? sync.data.session_status[sessionID]
      const workflow = loopWorkflowForSession(sessionID)
      if (workflow && !activeLoopWorkflowStates.has(workflow.state)) completed.push(item)
      else if (item.background.state === "failed" || item.background.state === "stopped") completed.push(item)
      else if (pendingInputCount(sessionID) > 0 || status?.type === "retry" || item.background.state === "needs_input") needsInput.push(item)
      else if (isLoopSession(item) && !isActiveLoopSession(item)) completed.push(item)
      else if (isActiveLoopSession(item)) looping.push(item)
      else if (status?.type === "busy" || item.background.state === "queued" || item.background.state === "working") working.push(item)
      else completed.push(item)
    }
    return { needsInput, looping, working, completed }
  })
  const agentViewSummary = createMemo(() => {
    const state = agentViewState()
    return `${state.needsInput.length} awaiting input · ${state.looping.length} looping · ${state.working.length} working · ${state.completed.length} completed`
  })
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
    const promptInput = promptRef.current?.current.input ?? ""
    if (promptInput !== "") return
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
      evt.preventDefault()
      openAgentViewSession(selected)
    }
  })
  const sessionDetail = (item: AgentViewSessionItem) => {
    const pending = pendingInputCount(item.background.sessionID)
    if (pending > 0) return `${pending} input request${pending === 1 ? "" : "s"}`
    if (item.background.error) return Locale.truncateMiddle(item.background.error, Math.max(12, rightPanelWidth() - 22))
    const agentName = item.background.session?.agent || item.session?.agent
    const summaryIsState =
      item.background.summary === item.background.state ||
      (item.background.state === "completed" && item.background.summary === "working")
    const summaryIsAgent = Boolean(agentName && item.background.summary === agentName)
    if (item.background.summary && !summaryIsState && !summaryIsAgent) {
      return Locale.truncateMiddle(item.background.summary, Math.max(12, rightPanelWidth() - 22))
    }
    const status = globalStatuses()[item.background.sessionID] ?? sync.data.session_status[item.background.sessionID]
    if (status?.type === "retry") return Locale.truncateMiddle(status.message, Math.max(12, rightPanelWidth() - 22))
    if (status?.type === "busy") return item.background.summary || item.background.session?.path || item.session?.path || "working"
    return (
      item.background.session?.path ||
      item.session?.path ||
      item.background.session?.directory ||
      item.session?.directory ||
      item.background.session?.agent ||
      item.session?.agent ||
      item.background.state
    )
  }
  const timeLabel = (item: AgentViewSessionItem) => formatAgentViewSessionTime(item.background.time.updated)
  const elapsedLabel = (item: AgentViewSessionItem) => {
    const seconds = Math.max(0, Math.floor((Date.now() - item.background.time.updated) / 1000))
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}m`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h`
    return `${Math.floor(hours / 24)}d`
  }
  const sessionTitle = (item: AgentViewSessionItem) =>
    item.background.session?.title || item.session?.title || item.background.session?.agent || item.session?.agent || item.background.sessionID
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
      normal: [`Reply to selected session: ${Locale.truncate(sessionTitle(selected), 40)}`],
    }
  })
  const logoSurface = () => (
    <Show when={homeIdentityKey()}>
      <Show
        when={activeHomeAscii()}
        fallback={
          <TuiPluginRuntime.Slot name="home_logo" mode="replace">
            <Show
              when={useProfileIdentityLogo()}
              fallback={
                <Show
                  when={!useCompactProductName()}
                  fallback={
                    <text fg={mend.profile.theme.tokens.foreground}>{mend.profile.identity.productName}</text>
                  }
                >
                  <Logo />
                </Show>
              }
            >
              <Show
                when={!useCompactProductName()}
                fallback={<text fg={mend.profile.theme.tokens.foreground}>{mend.profile.identity.productName}</text>}
              >
                <box paddingBottom={logoBottomPad()}>
                  <SurfaceLines text={customProductAscii()} />
                </box>
              </Show>
            </Show>
          </TuiPluginRuntime.Slot>
        }
      >
        {(text) => <SurfaceLines text={text()} />}
      </Show>
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
  const homeAgentManagerSurface = (options?: { paddingTop?: number; width?: number }) => {
    const width = options?.width ?? launcherWidth()
    const nameWidth = createMemo(() => Math.min(26, Math.max(14, Math.floor(width * 0.32))))
    const timeWidth = createMemo(() => (width >= 68 ? 18 : width >= 54 ? 14 : 10))
    const detailWidth = createMemo(() => Math.max(10, width - nameWidth() - timeWidth() - 4))
    const row = (
      item: AgentViewSessionItem,
      marker: () => JSX.Element | string,
      color: string,
      options?: { elapsed?: boolean },
    ) => (
      <box
        width="100%"
        height={1}
        flexDirection="row"
        backgroundColor={
          selectedAgentViewSessionID() === item.background.sessionID
            ? "#303030"
            : hoveredAgentViewSessionID() === item.background.sessionID
              ? "#242424"
              : undefined
        }
        onMouseOver={() => setHoveredAgentViewSessionID(item.background.sessionID)}
        onMouseOut={() => setHoveredAgentViewSessionID((current) => current === item.background.sessionID ? undefined : current)}
        onMouseUp={() => setSelectedAgentViewSessionID(item.background.sessionID)}
      >
        <box width={2} flexShrink={0}>
          {(() => {
            const value = marker()
            return typeof value === "string" ? <text fg={color} wrapMode="none">{value}</text> : value
          })()}
        </box>
        <box width={nameWidth()} flexShrink={0} overflow="hidden">
          <text fg={mend.profile.theme.tokens.foreground} wrapMode="none">
            {Locale.truncateMiddle(sessionTitle(item), nameWidth())}
          </text>
        </box>
        <box width={detailWidth()} flexShrink={0} overflow="hidden">
          <text fg={launcherHintColor} wrapMode="none">
            {Locale.truncateMiddle(sessionDetail(item), detailWidth())}
          </text>
        </box>
        <box width={timeWidth()} flexShrink={0} alignItems="flex-end">
          <text fg={launcherHintColor} wrapMode="none">
            {Locale.truncateMiddle(options?.elapsed ? elapsedLabel(item) : timeLabel(item), timeWidth())}
          </text>
        </box>
      </box>
    )
    const section = (
      title: string,
      items: ReturnType<typeof agentViewSessions>,
      marker: (item: AgentViewSessionItem) => JSX.Element | string,
      color: string,
      max: number,
      options?: { elapsed?: boolean },
    ) => (
      <Show when={items.length > 0}>
        <box height={1} />
        <text fg={mend.profile.theme.tokens.foreground} wrapMode="none">{title}</text>
        {items.slice(0, max).map((item) => row(item, () => marker(item), color, options))}
      </Show>
    )
    return (
      <box paddingTop={options?.paddingTop ?? 0} width={width} flexDirection="column" gap={0} flexShrink={0}>
        <Show
          when={agentViewSessions().length > 0}
          fallback={
            <box width="100%" flexDirection="column" alignItems="center">
              <text fg={mend.profile.theme.tokens.muted} wrapMode="none">No sessions yet</text>
              <text fg={launcherHintColor} wrapMode="none">resume or start a task</text>
            </box>
          }
        >
          <text fg={mend.profile.theme.tokens.muted} wrapMode="none">{agentViewSummary()}</text>
          {section("Needs input", agentViewState().needsInput, () => "✱", mend.profile.theme.tokens.accent, 3, { elapsed: true })}
          {section("Looping", agentViewState().looping, () => "↻", mend.profile.theme.tokens.accent, 4, { elapsed: true })}
          {section(
            "Working",
            agentViewState().working,
            () => <Spinner />,
            launcherHintColor,
            4,
            { elapsed: true },
          )}
          {section("Completed", agentViewState().completed, () => "✦", "#86efac", 3)}
        </Show>
      </box>
    )
  }
  const homeRightPanelSurface = () =>
    homeWelcomeRightPanel() === "agentManager"
      ? homeAgentManagerSurface({ paddingTop: 0, width: rightPanelWidth() })
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
                    {homeAgentManagerSurface({ paddingTop: launcherTopPadding(), width: rightPanelWidth() })}
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
                  flexDirection="row"
                  width={splitTwoColumnWelcome() ? undefined : "100%"}
                  flexGrow={splitTwoColumnWelcome() ? 1 : 0}
                  minWidth={splitTwoColumnWelcome() ? 32 : 0}
                  alignItems="center"
                >
                  <Show when={showLogo()}>
                    <box flexShrink={0} alignItems="center">
                      {logoSurface()}
                    </box>
                  </Show>
                  <box width={3} flexShrink={0} />
                  <box
                    flexDirection="column"
                    width={splitTwoColumnWelcome() ? splitTitleAvailableWidth() : undefined}
                    flexGrow={splitTwoColumnWelcome() ? 0 : 1}
                    minWidth={Math.min(20, splitTitleAvailableWidth())}
                    justifyContent="center"
                  >
                    <Show when={splitShowsSideTitle()}>
                      <Show
                        when={showSplitAsciiTitle()}
                        fallback={<text fg={mend.profile.theme.tokens.foreground} wrapMode="none">{splitProductText()}</text>}
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
                  <box flexGrow={1} minWidth={2} />
                </Show>
                <Show when={launcherVisible()}>
                  <box
                    width={splitTwoColumnWelcome() ? undefined : "100%"}
                    flexShrink={0}
                    alignItems={splitTwoColumnWelcome() ? "center" : "flex-end"}
                    paddingTop={splitTwoColumnWelcome() ? 0 : 1}
                    paddingRight={splitTwoColumnWelcome() ? 1 : 0}
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
                      historyScope={`project:${project.workspace.current()}`}
                      workspaceID={project.workspace.current()}
                      right={
                        <TuiPluginRuntime.Slot name="home_prompt_right" workspace_id={project.workspace.current()} />
                      }
                      sessionID={selectedAgentViewPromptSessionID()}
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

export function Home(props: { revision?: number }) {
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
    if (!sync.ready || !local.model.ready) return
    if (!args.prompt) return
    if (r.current.input !== args.prompt) return
    sent = true
    r.submit()
  })

  return <HomeSurface bind={bind} revision={props.revision} />
}
