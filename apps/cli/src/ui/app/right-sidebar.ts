import { estimateTokens } from "@mendcode/protocol/wire"
import type { SidebarWidget, McpStatusReport, Loop, SessionTreeNode, WorkflowSummary, ChangesReport, ContextReport } from "@mendcode/protocol"
import type { SlotContext } from "@mendcode/extension-api"
import { DEFAULT_COMPACT_AT_TOKENS } from "@mendcode/protocol/wire"
import { contextIsEngineWindow, contextLimit } from "../../view/context-meter"
import { boxPanel, fit } from "../../view/deck"
import { renderMarkdown } from "../../view/markdown"
import { modelLabel, servedByProvider, sessionModelId } from "../../view/model-label"
import { parseTodoText } from "../../view/dock"
import { sidebarSpec, SIDEBAR_PRESETS, WIDGET_TYPES, PANEL_PRESETS, NEAREST_PRESET, nextPreset, panelPreset, presetOf } from "../../view/sidebar-spec"
import { panelCard, facts, sparkline, sparkRows, labelValue } from "../../view/panel-card"
import { panelSession } from "../../view/panel-session"
import { forecastTurns } from "../../view/context-forecast"
import { compact } from "../../view/format"
import { featureOn, type BacklogItem } from "@mendcode/protocol/wire"
import { backlogCard } from "../../view/backlog"
import type { OrbitCamera, OrbitGraph, OrbitNode, OrbitView } from "../../view/panel-orbit"
import type { OrbitCode } from "../../view/panel-orbit-code"
import { ATOM_ELECTRONS, ATOM_FRAME_MS, ATOM_ROWS, atomAnimating, renderAtom, type AtomItem } from "../../view/panel-atom"
import { activityCard, agentCard, agentsCard, agentsTreeCard, alertsCard, contextCard, limitedRow, observedAge, quotaRow, todosCard, tokensCard, toolsCard, workspaceCard, type ActivityCard, type Alert, type ToolEntry } from "../../view/sidebar-cards"
import { quotaFresh } from "@mendcode/protocol/wire"
import type { Block } from "../../view/transcript"
import { rightBarCells } from "../../view/right-bar"
import { dropForHeight } from "../../view/sidebar-priority"
import { callSpeed } from "../../view/usage-notes"
import { statsCard, statsCardParts } from "../../view/stats-card"
import { readTuiProfile, type TuiProfile } from "../../view/tui-profile"
import { writeSessionLook } from "./session-look"
import { actionHint } from "../keymap"
import { sideChat, sideChatRows } from "./aside"
import type { AppContext } from "./context"
import { asciiChrome } from "./glyph-mode"
import type { Line } from "../theme"
import { preload } from "../lazy-pages"
import { labelString, sessionLabel } from "../../view/session-label"
import { fileInSlot } from "./file-slot"
import type { createFileOpen } from "./file-open"

/**
 * `look` puts a change on screen for this session of this terminal only (session-look.ts): showing, hiding, presets, an added card and
 * the width. `/panel edit` and `/panel reset` edit the panel's file, every terminal's default.
 */
export function createRightSidebar(ctx: AppContext, slotContext: (width: number, height: number) => SlotContext, fileOpen: ReturnType<typeof createFileOpen>, openNode: (node: OrbitNode) => Promise<void>, look: (patch: Partial<TuiProfile>) => void) {
  const { input, state, now, requestFrame, fail } = ctx
  let loadedKey = ""
  let scope: "user" | "project" = "user"
  let git: { branch?: string; ahead?: number; behind?: number; dirty?: number; conflicts?: number; untracked?: number; error?: string } = {}
  /** False until `git.status` answers, so the workspace card says it is checking instead of claiming there is no repository. */
  let gitKnown = false
  /** The active agent's tool switches (`agent.debug` without a tool: local, no provider call); undefined until it answers. */
  let tools: { enabled: number; total: number; names: string[] } | undefined
  let maxScroll = 0
  /** "<key> focus" for the key bound to `panel.focus` now (rebinding and the Option label applied), after `lead`; nothing when the action has no key. */
  const focusHint = (lead: string) => {
    const key = actionHint(state.bindings, "panel.focus")
    return key ? `${lead}${key} focus` : ""
  }
  const sourceErrors = new Map<string, string>()
  let files: ChangesReport["files"] | undefined
  let fileCoverage = false
  let savings: Array<{ source: string; tokens: number }> | undefined
  let rent: ContextReport["rent"] | undefined
  let sessionKey = ""
  let telemetryKey = ""
  let telemetry: ReturnType<typeof panelSession> | undefined
  let orbit: typeof import("../../view/panel-orbit") | undefined
  let orbitLoading = false
  /** The tilt a fresh galaxy starts at: seen almost from above, so the disc fills the rows its card has. Flatter, it was a wide band with empty rows over and under it. */
  const GALAXY_PITCH = 1.3
  let cellAspect: number | undefined
  let camera: OrbitCamera = { yaw: 0, pitch: GALAXY_PITCH, selected: 0, zoom: 1 }
  // The galaxy's code mode (docs/sidebar.md): the project's most connected files. Its module loads and the daemon is asked only when the user
  // presses the mode key; nothing here indexes on panel open, on session start or in session mode. The mode lasts for this session view.
  let orbitCode: typeof import("../../view/panel-orbit-code") | undefined
  let orbitMode: OrbitView["mode"] = "session"
  let code: OrbitCode = { state: "idle" }
  let codeGraph: OrbitGraph | undefined
  let codeCamera: OrbitCamera = { yaw: 0, pitch: GALAXY_PITCH, selected: 0, zoom: 1 }
  let codeAsked = 0
  // Shown by itself (not by the key) while the session has touched no code: it gives way to the session's own galaxy at its first file.
  let codeByItself = false
  let triedByItself = false
  const inCode = () => orbitMode === "code" && !!orbitCode
  const activeCamera = () => (inCode() ? codeCamera : camera)
  const emptyGraph: OrbitGraph = { nodes: [], edges: [] }
  /**
   * One `codegraph.overview` per press of the mode key: the explicit request that builds or refreshes the index. A graph already shown
   * stays while it refreshes. The caller does not wait for the reply: a first build takes seconds and the keyboard stays free.
   */
  async function askCode(module: NonNullable<typeof orbitCode>, byItself = false) {
    const asked = ++codeAsked
    const session = state.sessionId
    // Shown by itself, the view changes only once the project's code is ready to draw: a build or a failure leaves the session view as it was.
    if (!byItself) {
      orbitMode = "code"
      if (code.state !== "ready") code = { state: "building" }
      requestFrame()
    }
    // A connection that drops mid-build is a failure line like any other, not an unhandled rejection.
    const reply = await input.send({ type: "codegraph.overview", directory: input.directory ?? process.cwd() }).catch((error: unknown) => ({ ok: false as const, error: { message: error instanceof Error ? error.message : "no answer from the daemon" } }))
    if (asked !== codeAsked || session !== state.sessionId) return
    const selected = codeGraph?.nodes[codeCamera.selected]?.id
    code = reply.ok ? module.codeOverviewOf(reply.result) : module.codeOverviewOf({ state: "failed", reason: reply.error.message })
    codeGraph = code.state === "ready" ? module.codeOrbitGraph(code) : undefined
    codeCamera.selected = Math.max(0, selected ? codeGraph?.nodes.findIndex((node) => node.id === selected) ?? 0 : 0)
    if (byItself) {
      if (codeByItself && orbitMode === "session" && codeGraph?.nodes.length && snapshot().graph.nodes.length === 0) orbitMode = "code"
      else codeByItself = false
    }
    requestFrame()
  }
  /**
   * A session that has touched no code yet shows the project's code instead of an empty disc: once per session, only where the code
   * graph is on and not skipped for this folder (docs/code-graph.md).
   */
  function projectWhileEmpty() {
    if (codeByItself && inCode() && snapshot().graph.nodes.length > 0) {
      codeByItself = false
      orbitMode = "session"
      return
    }
    if (triedByItself || orbitMode !== "session" || !orbit || snapshot().graph.nodes.length > 0) return
    if (!featureOn(state.settingsNow, "codegraph") || ctx.codegraph.get(input.directory ?? process.cwd())?.state === "skipped") return
    triedByItself = true
    codeByItself = true
    const session = state.sessionId
    void import("../../view/panel-orbit-code").then((module) => {
      if (session !== state.sessionId || !codeByItself) return
      void askCode(orbitCode ??= module, true)
    })
  }
  const velocity = { yaw: 0, pitch: 0 }
  let tickMs = 0
  let orbitHeight = 12
  const ascii = () => asciiChrome(state)
  const orbitAllowed = () => featureOn(state.settingsNow, "panel_orbit") && (state.settingsNow.tier !== undefined || state.mode === "full")
  const snapshot = () => {
    const key = `${state.sessionId}:${state.transcript.lastSeq}`
    if (key !== telemetryKey || !telemetry) {
      telemetryKey = key
      const focused = telemetry?.graph.nodes[camera.selected]?.id
      telemetry = panelSession(state.transcript.blocks(), input.directory ?? "", files)
      camera.selected = Math.max(0, focused ? telemetry.graph.nodes.findIndex((node) => node.id === focused) : 0)
      if (camera.filter && telemetry.graph.nodes[camera.selected]?.kind !== camera.filter) camera.selected = telemetry.graph.nodes.findIndex((node) => node.kind === camera.filter)
    }
    return telemetry
  }

  function layout(width: number) {
    const chat = sideChat(ctx)
    const wanted = chat.open || fileInSlot(state) || state.tuiProfile.rightSidebar && state.tuiProfile.sidebarWidgets.length > 0
    if (!wanted) return { right: 0, bottom: false }
    const bar = rightBarCells({ columns: width, setting: state.tuiProfile.sidebarWidth, collapsed: state.rightBarCollapsed })
    state.rightBarCollapsed = bar.collapsed
    return { right: bar.cells, bottom: !bar.cells }
  }

  async function loadSpec() {
    const directory = input.directory ?? process.cwd()
    const reply = await input.send({ type: "sidebar.get", directory })
    if (directory !== (input.directory ?? process.cwd())) return
    if (reply.ok && Array.isArray(reply.result?.widgets)) {
      // The cards of an enabled package are a layer over the stored spec (profile-layers.ts): asking the daemon must not wipe them.
      // Saving or editing from here is the user's own change, which then wins over the layer.
      // A session that chose its own cards (`/panel <preset>`) keeps them.
      if (!("sidebarWidgets" in state.profileApplied) && !state.sessionLook.get(state.sessionId)?.sidebarWidgets) state.tuiProfile.sidebarWidgets = sidebarSpec(reply.result.widgets)
      scope = reply.result?.scope === "project" ? "project" : "user"
    }
    requestFrame()
  }

  function ensureData() {
    const widgets = state.tuiProfile.sidebarWidgets
    // The clock ticks every second; so does the activity card while a turn runs, for its run time.
    const running = ["generating", "tool", "compacting"].includes(state.transcript.foreground)
    const visible = state.page === "chat" && state.tuiProfile.rightSidebar
    const hasOrbit = widgets.some((widget) => widget.type === "orbit") && orbitAllowed()
    if (visible && hasOrbit && !orbit && !orbitLoading) {
      orbitLoading = true
      // The galaxy is round only at the terminal's own cell shape; ask once (the image layer may never have).
      void input.screen.resolveCellPixels?.().then((cell) => {
        cellAspect = cell.height / cell.width
        requestFrame()
      })
      void import("../../view/panel-orbit").then((module) => {
        orbit = module
        requestFrame()
      }).finally(() => { orbitLoading = false })
    }
    // The session's galaxy keeps moving for a few seconds after the last use it shows, so a spark can run and fade; then it rests.
    const firedAt = () => (hasOrbit && orbit && !inCode() ? snapshot().graph.at ?? 0 : 0)
    const animate = hasOrbit && orbit?.orbitAnimating(visible, state.rightFocus, running, state.reducedMotion, firedAt(), now())
    if (!animate) {
      velocity.yaw = 0
      velocity.pitch = 0
    }
    const clock = visible && widgets.some((widget) => ["clock", "limits", "usage"].includes(widget.type) || widget.type === "activity" && running)
    // The Atom card's electrons move only while something runs; its tree and jobs come from the same data as the agents and jobs cards.
    const atom = widgets.some((widget) => widget.type === "atom") && atomAnimating(visible, atomItems().length, state.reducedMotion)
    const interval = animate ? orbit!.ORBIT_FRAME_MS : atom ? ATOM_FRAME_MS : clock ? 1_000 : 0
    if (state.rightTick && interval !== tickMs) {
      clearInterval(state.rightTick)
      state.rightTick = undefined
    }
    tickMs = interval
    if (interval && !state.rightTick) {
      state.rightTick = setInterval(() => {
        ensureData()
        if (state.page !== "chat" || !state.tuiProfile.rightSidebar) return
        if (orbit?.orbitAnimating(true, state.rightFocus, isRunning(), state.reducedMotion, firedAt(), now()) && hasOrbit) orbit.stepOrbit(activeCamera(), velocity, state.reducedMotion)
        requestFrame()
      }, interval)
      state.rightTick.unref?.()
    }
    if (!interval && state.rightTick) {
      clearInterval(state.rightTick)
      state.rightTick = undefined
    }
    if (!visible || !widgets.length) return
    if (sessionKey !== state.sessionId) {
      sessionKey = state.sessionId
      files = undefined
      savings = undefined
      rent = undefined
      sourceErrors.clear()
      camera = { yaw: 0, pitch: GALAXY_PITCH, selected: 0, zoom: 1 }
      // Another session starts on its own activity again (or on the project's code while it has touched none).
      orbitMode = "session"
      codeByItself = false
      triedByItself = false
      code = { state: "idle" }
      codeGraph = undefined
      codeCamera = { yaw: 0, pitch: GALAXY_PITCH, selected: 0, zoom: 1 }
      codeAsked++
      velocity.yaw = 0
      velocity.pitch = 0
      telemetryKey = ""
    }
    const key = `${input.directory}:${state.sessionId}:${widgets.map((widget) => widget.type).join(",")}:${state.transcript.turnClock?.startedAt}:${state.transcript.turnClock?.endedAt}:${running}:${state.agentReport?.current ?? ""}:${state.sidebarTreeRev}`
    if (key === loadedKey) return
    loadedKey = key
    const types = new Set<string>(widgets.map((widget) => widget.type))
    if (types.has("orbit") || types.has("lineage") || types.has("atom")) types.add("agents")
    if (types.has("orbit") && orbitAllowed()) {
      types.add("files")
      if (!input.remote && featureOn(state.settingsNow, "mcp")) types.add("mcp")
    }
    // The workspace card reads the same local Git status as the git card.
    if (types.has("workspace")) types.add("git")
    // Alerts watch failed MCP servers and failed background jobs, so they ask for the same lists.
    if (types.has("alerts")) ["mcp", "jobs"].forEach((type) => types.add(type))
    const directory = input.directory ?? process.cwd()
    if (types.has("mcp")) state.sidebarMcpAsked = true
    const query = (type: string, command: Parameters<typeof input.send>[0], apply: (result: Record<string, unknown> | undefined) => void) => {
      if (!types.has(type)) return
      void input.send(command).then((reply) => {
        if (key !== loadedKey) return
        if (reply.ok) {
          sourceErrors.delete(type)
          apply(reply.result)
        }
        else sourceErrors.set(type, reply.error.message)
        requestFrame()
      })
    }
    query("mcp", { type: "mcp.status", directory }, (result) => { state.sidebarMcp = (result as McpStatusReport | undefined)?.servers })
    query("jobs", { type: "background.list" }, (result) => { if (Array.isArray(result?.tasks)) state.agentShells = result.tasks as typeof state.agentShells })
    query("loops", { type: "loop.list", directory }, (result) => { state.loops = (result?.loops ?? []) as Loop[] })
    query("workflows", { type: "workflow.list", directory }, (result) => { state.workflows = (result?.workflows ?? []) as WorkflowSummary[] })
    // The backlog card asks only while its feature is on; off, the card says so and the daemon is not asked.
    if (featureOn(state.settingsNow, "backlog")) query("backlog", { type: "backlog.get", directory }, (result) => { state.backlog = Array.isArray(result?.items) ? result.items as BacklogItem[] : [] })
    query("git", { type: "git.status", directory }, (result) => {
      git = result ?? {}
      gitKnown = true
    })
    query("agents", { type: "session.tree", sessionId: state.sessionId }, (result) => { if (Array.isArray(result?.nodes)) state.sidebarTree = result.nodes as SessionTreeNode[] })
    query("files", { type: "session.changes", sessionId: state.sessionId }, (result) => {
      files = Array.isArray(result?.files) ? (result.files as ChangesReport["files"]).map((file) => ({ ...file, diff: "" })) : undefined
      fileCoverage = result?.complete === true
      telemetryKey = ""
    })
    query("savings", { type: "session.savings", sessionId: state.sessionId }, (result) => { savings = Array.isArray(result?.savings) ? result.savings as typeof savings : undefined })
    query("rent", { type: "context.query", sessionId: state.sessionId }, (result) => { rent = (result as ContextReport | undefined)?.rent })
    query("tools", { type: "agent.debug", directory, name: state.agentReport?.current ?? "build" }, (result) => {
      const map = result?.tools
      if (!map || typeof map !== "object") return
      const entries = Object.entries(map as Record<string, unknown>)
      tools = { enabled: entries.filter(([, on]) => on === true).length, total: entries.length, names: entries.filter(([, on]) => on === true).map(([name]) => name).sort() }
    })
  }

  const isRunning = () => ["generating", "tool", "compacting"].includes(state.transcript.foreground)
  const modelName = () => sessionModelId(state.effectiveModel?.model, state.transcript.lastUsage?.model, state.modelReport)
  const modelInfo = () => state.modelReport?.models?.find((candidate) => candidate.id === (state.effectiveModel?.model ?? modelName()))
  const providerName = () => servedByProvider(state.effectiveModel?.model ?? modelName(), state.modelReport) ?? state.transcript.lastUsage?.provider
  /** The newest cache-miss note since the last user message (only present while `Cache notices` is on). */
  const cacheMiss = () => {
    if (!state.tuiProfile.cacheNotices) return false
    const blocks = state.transcript.blocks()
    const lastUser = blocks.findLastIndex((block) => block.kind === "user_message")
    return blocks.findLastIndex((block) => block.note?.kind === "cache") > lastUser
  }
  /** Bytes of this session in the storage report, when `/status` or `/storage` already fetched one that lists it; never fetched for the card. */
  const storageBytes = () => state.storageReport?.topSessions.find((session) => session.sessionId === state.sessionId)?.bytes
  /** What the Atom card draws: the tool calls, sub-agents and background jobs of this session that are running now. */
  const atomItems = (): AtomItem[] => [
    ...state.transcript.blocks().filter((block) => block.kind === "tool_call" && block.title && block.status === "running").slice(-ATOM_ELECTRONS).map((block): AtomItem => ({ kind: "tool", label: block.title! })),
    ...(state.sidebarTree ?? []).filter((node) => node.sessionId !== state.sessionId && ["running", "queued", "needs_input"].includes(node.state ?? "")).map((node): AtomItem => ({ kind: "agent", label: node.title || node.agent || node.sessionId })),
    ...state.agentShells.filter((job) => job.sessionId === state.sessionId && job.status === "running").map((job): AtomItem => ({ kind: "job", label: job.command.split("\n")[0]! })),
  ]
  const toolStatus = (block: Block): ToolEntry["status"] => (block.status === "running" ? "running" : block.status === "error" || block.status === "cancelled" || block.status === "interrupted" ? "error" : "ok")
  /** A finished tool's own timing, else the event clock; a running one counts up. */
  const durationOf = (block: Block): number | undefined => {
    if (block.status !== "running" && typeof block.meta?.durationMs === "number") return block.meta.durationMs
    if (block.at === undefined) return undefined
    return Math.max(0, (block.status === "running" ? now() : block.endAt ?? block.at) - block.at)
  }

  /** The activity card's data: this turn's (or the last one's) run time, the last call's first-token time and speed, and the tools of the latest turn. */
  function activityData(): ActivityCard {
    const running = isRunning()
    const clock = state.transcript.turnClock
    const calls = state.transcript.recentCalls.filter((call) => !running || clock === undefined || call.at >= clock.startedAt)
    const call = calls.at(-1)
    const turnMs = clock ? (running ? now() - clock.startedAt : clock.endedAt !== undefined ? clock.endedAt - clock.startedAt : undefined) : undefined
    let speed = call ? callSpeed(call) : undefined
    let estimated = false
    const live = running ? state.transcript.blocks().findLast((block) => (block.kind === "agent_message" || block.kind === "reasoning") && block.status === "running") : undefined
    if (live?.at !== undefined && now() - live.at >= 800 && live.text.length > 0) {
      speed = estimateTokens(live.text.length) / ((now() - live.at) / 1000)
      estimated = true
    }
    const toolBlocks = state.transcript.blocks().filter((block) => block.kind === "tool_call" && block.title)
    const turnTools = toolBlocks.filter((block) => block.turnId === toolBlocks.at(-1)?.turnId)
    const entry = (block: Block): ToolEntry => {
      const [, name = block.title!, summary = ""] = /^([^:\s]+)[:\s]*(.*)$/.exec(block.title!) ?? []
      const duration = durationOf(block)
      return { status: toolStatus(block), name, ...(summary ? { summary } : {}), ...(duration !== undefined ? { durationMs: duration } : {}) }
    }
    const active = turnTools.filter((block) => block.status === "running").slice(-2)
    const finished = turnTools.filter((block) => block.status !== "running").slice(-(3 - active.length))
    return {
      running, ...(turnMs !== undefined ? { turnMs } : {}),
      ...(call ? { firstTokenMs: call.firstTokenMs } : {}), ...(speed !== undefined ? { speed, speedEstimated: estimated } : {}),
      tools: [...finished, ...active].map(entry),
      done: turnTools.filter((block) => toolStatus(block) === "ok").length, failed: turnTools.filter((block) => toolStatus(block) === "error").length,
    }
  }

  /** What needs attention: connection, the footer notice, context and quota pressure, failed MCP servers and failed background jobs. Newest concern first within a level. */
  function alertList(): Alert[] {
    const alerts: Alert[] = []
    if (state.connection !== "connected") alerts.push({ level: state.connection === "closed" ? "error" : "warning", text: state.connection === "closed" ? "Disconnected" : "Offline, reconnecting" })
    const tokens = state.transcript.lastUsage?.contextTokens
    const limit = contextLimit(state.transcript.lastUsage, state.settingsNow.compactAtTokens ?? DEFAULT_COMPACT_AT_TOKENS)
    if (tokens !== undefined && limit > 0 && tokens / limit >= .75) alerts.push({ level: tokens / limit >= .9 ? "error" : "warning", text: `Context ${state.transcript.lastUsage?.contextApprox ? "~" : ""}${Math.round(tokens / limit * 100)}% of the ${contextIsEngineWindow(state.transcript.lastUsage) ? "model window" : "compaction limit"}` })
    for (const quota of ctx.quotas.values()) if (quotaFresh(quota.fetchedAt, now())) for (const window of quota.windows) if (window.usedPercent >= 70) alerts.push({ level: window.usedPercent >= 90 ? "error" : "warning", text: `${quota.provider} ${window.label} ${Math.round(window.usedPercent)}% used` })
    for (const server of state.sidebarMcp ?? []) if (server.enabled && server.state === "failed") alerts.push({ level: "error", text: `MCP ${server.name} failed${server.lastError ? `: ${server.lastError}` : ""}` })
    for (const job of state.agentShells) if (job.sessionId === state.sessionId && job.status === "exited" && job.exitCode) alerts.push({ level: "warning", text: `Job exited ${job.exitCode}: ${job.command}` })
    return alerts.sort((a, b) => Number(b.level === "error") - Number(a.level === "error")).slice(0, 8)
  }

  const text = (value: string, fg: "text" | "muted" | "primary" = "text"): Line => [{ text: value, fg }]
  function widgetBody(widget: SidebarWidget, width: number): Line[] {
    const problem = sourceErrors.get(widget.type)
    if (problem) return renderMarkdown(problem, width, "error")
    const usage = state.transcript.lastUsage
    // Still limited while the pause is open, even when its bar is snoozed.
    const pause = state.transcript.usageLimit
    const limited = pause ? { ...(pause.resetsAt !== undefined ? { resetsAt: pause.resetsAt } : {}), now: now() } : undefined
    const lines = (values: string[], empty: string) => (values.length ? values.map((value) => text(value)) : [text(empty, "muted")])
    switch (widget.type) {
      case "pace": {
        const calls = state.transcript.recentCalls
        const timed = calls.filter((call) => call.durationMs !== undefined && call.durationMs > 0)
        const rate = timed.length ? timed.reduce((sum, call) => sum + call.output + call.reasoning, 0) / timed.reduce((sum, call) => sum + call.durationMs!, 0) * 60_000 : undefined
        const forecast = forecastTurns(state.transcript.recentContexts, contextLimit(state.transcript.lastUsage, state.settingsNow.compactAtTokens ?? DEFAULT_COMPACT_AT_TOKENS))
        const times = state.transcript.recentTurnTimes
        // Nothing timed yet is one calm line, not four "unavailable" rows.
        if (rate === undefined && !forecast && !times.length) return [text("No timed turns yet", "muted")]
        return [
          facts(rate === undefined ? "Rate —" : `${compact(Math.round(rate))} tok/min`, forecast ? `~${forecast.turns} turns left` : "Forecast —", width),
          ...(timed.length ? sparkRows("Rate", timed.map((call) => (call.output + call.reasoning) / call.durationMs! * 60_000), width, (value) => `${compact(Math.round(value))}/m`, ascii()) : []),
          ...(times.length ? sparkRows("Turn", times, width, (value) => `${(value / 1000).toFixed(1)}s`, ascii(), "muted") : []),
          text(times.length ? `Last turn ${(times.at(-1)! / 1000).toFixed(1)}s · active-call rate` : "Active-call rate", "muted"),
        ]
      }
      case "savings": {
        if (!savings) return [text("Savings unavailable", "muted")]
        const total = savings.reduce((sum, entry) => sum + entry.tokens, 0)
        return total > 0 ? [text(`~${compact(total)} tokens saved`, "primary"), ...savings.map((entry) => text(`${entry.source} · ~${compact(entry.tokens)}`)), text("Session total · estimates", "muted")] : [text("Nothing saved yet", "muted")]
      }
      case "queue": return !state.transcript.queue.length ? [text("Nothing queued", "muted")] : [facts(`${state.transcript.queue.filter((entry) => entry.delivery !== "steer").length} queued`, `${state.transcript.queue.filter((entry) => entry.delivery === "steer").length} steering`, width), ...state.transcript.queue.slice(0, 5).map((entry) => text(`${entry.delivery === "steer" ? "steer" : "queue"} · ${entry.preview}`)), ...(state.transcript.queue.length > 5 ? [text(`+${state.transcript.queue.length - 5} more · /queue`, "muted")] : [])]
      case "lineage": {
        if (!state.sidebarTree) return [text("Lineage unavailable", "muted")]
        const nodes = state.sidebarTree.map((node) => ({ ...node, kind: node.kind ?? "fork" }))
        // A session with no forks or sub-agents is one calm line; its title would only sit above a second "none".
        if (!nodes.some((node) => node.parentId)) return [text("No forks or sub-agents", "muted")]
        const root = nodes.find((node) => !node.parentId) ?? nodes.find((node) => node.sessionId === state.sessionId)
        return [text(root?.title || "This session", "muted"), ...agentsTreeCard({ nodes, rootId: root?.sessionId ?? state.sessionId, width, glyphs: ctx.glyphs, maxNodes: 5, compact: true })]
      }
      case "files": {
        const recent = snapshot().files
        const known = new Map((files ?? []).map((file) => [file.path, file]))
        const paths = [...new Set([...recent.map((file) => file.path), ...known.keys()])]
        if (!paths.length) return [text(files === undefined ? "Session files unavailable" : "No files touched yet", "muted")]
        return [...paths.slice(0, 8).map((path) => {
          const file = known.get(path)
          return labelValue(path, file ? `+${file.additions} -${file.deletions}` : "± unavailable", width)
        }), ...(paths.length > 8 ? [text(`+${paths.length - 8} more · /changes session`, "muted")] : []), text(files === undefined ? "Session files unavailable" : fileCoverage ? "Session snapshots" : "Partial snapshots · shell untracked", "muted")]
      }
      case "rent": return rent?.length ? rent.slice().sort((a, b) => b.tokens - a.tokens).slice(0, 5).map((entry) => text(`${entry.tool} · ~${compact(entry.tokens)} · ${entry.uses} uses`)) : [text(rent ? "No tool schemas counted" : "Context rent unavailable", "muted")]
      case "atom": return renderAtom({ items: atomItems(), width, height: Math.min(ATOM_ROWS, widget.options.maxRows ?? ATOM_ROWS), now: now(), running: isRunning(), reduced: state.reducedMotion, ascii: ascii(), ...(cellAspect ? { aspect: cellAspect } : {}) })
      case "orbit": if (orbit) projectWhileEmpty()
        return !orbitAllowed() ? [text("Galaxy needs full tier", "muted")] : orbit ? orbit.renderOrbit(inCode() ? codeGraph ?? emptyGraph : snapshot().graph, width, Math.max(1, orbitHeight), { ...activeCamera(), focused: state.rightFocus, aspect: cellAspect }, ascii(), { now: now(), busy: isRunning(), reduced: state.reducedMotion }, inCode() ? orbitCode!.codeOrbitView(code, width) : { mode: "session" }) : [text("Loading galaxy", "muted")]
      case "context": {
        const rows = contextCard({ ...(usage?.contextTokens !== undefined ? { tokens: usage.contextTokens } : {}), compactAt: contextLimit(usage, state.settingsNow.compactAtTokens ?? DEFAULT_COMPACT_AT_TOKENS), ...(usage?.contextWindow ?? modelInfo()?.contextWindow ? { window: (usage?.contextWindow ?? modelInfo()!.contextWindow)! } : {}), ...(cacheMiss() ? { cacheMiss: "last call missed" } : {}) }, width, ctx.glyphs)
        const growth = state.transcript.recentContexts.map((sample) => sample.tokens)
        // No reading, no growth line: the card is one muted sentence.
        return usage?.contextTokens === undefined || !growth.length ? rows : [...rows, text(`Grow ${sparkline(growth, width - 5, ascii())}`, "muted")]
      }
      case "agent": return agentCard({
        stateLabel: ctx.stateLabels[state.transcript.foreground], state: state.transcript.foreground,
        ...(modelName() ? { model: modelLabel(modelName()!, state.modelReport) } : {}), ...(providerName() ? { provider: providerName()! } : {}), ...(state.effectiveModel?.effort ? { effort: state.effectiveModel.effort } : {}),
        billing: state.settingsNow.budgets?.mode === "api-usage" ? "Metered" : "Subscription", permission: ctx.permissionLabels[state.transcript.permissionMode],
        ...(limited ? { limited } : {}),
      }, width, ctx.glyphs)
      case "activity": return activityCard(activityData(), width, ctx.glyphs)
      case "workspace": return workspaceCard({
        ...(input.directory ? { project: input.directory.split(/[\\/]/).filter(Boolean).at(-1)! } : {}),
        ...(git.branch ? { branch: git.branch } : {}), ...(git.ahead !== undefined ? { ahead: git.ahead } : {}), ...(git.behind !== undefined ? { behind: git.behind } : {}),
        ...(git.conflicts !== undefined ? { conflicts: git.conflicts } : {}), ...(git.dirty !== undefined ? { dirty: git.dirty } : {}),
        files: state.changedFiles.length, added: state.diffTotals?.added ?? 0, removed: state.diffTotals?.removed ?? 0, changesKnown: !!state.diffTotals,
        untracked: git.untracked ?? state.changedFiles.filter((file) => file.status === "untracked").length,
        turns: state.transcript.blocks().filter((block) => block.kind === "user_message").length,
        ...(storageBytes() !== undefined ? { storageBytes: storageBytes()! } : {}),
        ...(git.error ?? sourceErrors.get("git") ? { error: git.error ?? sourceErrors.get("git")! } : {}),
        ...(gitKnown || sourceErrors.has("git") ? {} : { checking: true }),
      }, width)
      case "tokens": return tokensCard({ usage: state.transcript.sessionUsage, ...(state.transcript.sessionCost !== undefined ? { costMicros: state.transcript.sessionCost } : {}), subscription: state.settingsNow.budgets?.mode !== "api-usage" }, width)
      // The session stats registry (docs/customize.md): `options.text` is the comma list of parts, default `STATS_CARD_DEFAULT`.
      case "stats": return statsCard(statsCardParts(widget.options.text), ctx.stats.read(), width)
      case "models": {
        if (!featureOn(state.settingsNow, "panel_models")) return [text("Models disabled", "muted")]
        const models = [...state.transcript.modelUsage].sort((a, b) => b.input + b.output + b.cacheRead + b.cacheWrite + b.reasoning - a.input - a.output - a.cacheRead - a.cacheWrite - a.reasoning)
        return models.length ? [...models.slice(0, 5).flatMap((model) => [labelValue(model.provider ? `${model.provider}/${model.model}` : model.model, `${model.calls} call${model.calls === 1 ? "" : "s"}`, width), facts(`In ${compact(model.input)}`, `Out ${compact(model.output + model.reasoning)}`, width), facts(`Read ${compact(model.cacheRead)}`, `Write ${compact(model.cacheWrite)}`, width)]), ...(models.length > 5 ? [text(`+${models.length - 5} models · ${compact(models.slice(5).reduce((sum, model) => sum + model.input + model.output + model.reasoning + model.cacheRead + model.cacheWrite, 0))} tokens`, "muted")] : []), text("Loaded history · incl. compaction", "muted")] : [text("No model usage yet", "muted")]
      }
      case "tools": return toolsCard({ ...(tools ? { enabled: tools.enabled, total: tools.total, ...(widget.options.maxRows ? { names: tools.names } : {}) } : {}), ...(sourceErrors.get("tools") ? { error: sourceErrors.get("tools")! } : {}) }, width)
      case "alerts": return alertsCard(alertList(), width, ctx.glyphs)
      case "limits":
      case "usage": {
        const rows = [...ctx.quotas.values()].flatMap((quota) => {
          const age = observedAge(now() - quota.fetchedAt)
          // A reading that is stale or empty is one muted row carrying its age; a fresh one ends with the age as a stamp.
          if (!quotaFresh(quota.fetchedAt, now())) return [text(`${quota.provider} · quota stale · ${age}`, "muted")]
          if (!quota.windows.length) return [text(`${quota.provider} · quota unknown · ${age}`, "muted")]
          const stamp = text(`${quota.provider} · ${age}`, "muted")
          return [...quota.windows.map((window) => quotaRow({ provider: quota.provider, label: window.label, usedPercent: window.usedPercent, ...(window.resetsAt && window.resetsAt > now() ? { resetMinutes: Math.ceil((window.resetsAt - now()) / 60_000) } : {}) })), stamp]
        })
        // A turn paused by the usage limit comes first: `Limited · resets 2:10 AM (in 3h 12m)`.
        const head = limited ? [limitedRow(limited, width)] : []
        return rows.length ? [...head, ...rows] : [...head, text("Quota windows unavailable", "muted")]
      }
      case "todos": {
        const todo = state.transcript.blocks().findLast((block) => block.kind === "tool_call" && block.title?.startsWith("todo"))
        return todosCard({ items: todo ? parseTodoText(todo.text) : [], width, glyphs: ctx.glyphs })
      }
      case "backlog": return backlogCard({ items: state.backlog, off: !featureOn(state.settingsNow, "backlog"), width, glyphs: ctx.glyphs })
      case "changes": return lines(state.changedFiles.length ? [`${state.changedFiles.length} file${state.changedFiles.length === 1 ? "" : "s"} · +${state.diffTotals?.added ?? 0} -${state.diffTotals?.removed ?? 0}`, ...state.changedFiles.map((file) => `${file.status} ${file.path} +${file.additions} -${file.deletions}`)] : [], state.diffTotals ? "No changed files" : "Changes unavailable")
      case "jobs": return lines(state.agentShells.filter((job) => job.sessionId === state.sessionId).map((job) => `${job.status}: ${job.command}`), "No background jobs")
      case "loops": return lines(state.loops.filter((loop) => loop.directory === input.directory).map((loop) => `${loop.name}: ${loop.state}`), "No loops")
      case "workflows": return lines(state.workflows.filter((run) => run.directory === input.directory).map((run) => `${run.name}: ${run.state}`), "No workflows")
      case "agents": return state.sidebarTree ? agentsTreeCard({ nodes: state.sidebarTree.map((node) => ({ sessionId: node.sessionId, parentId: node.parentId, kind: node.kind ?? "fork", title: node.title, ...(node.model ? { model: modelLabel(node.model, state.modelReport) } : {}), state: node.state, agent: node.agent, headline: node.headline, unmerged: node.unmerged })), rootId: state.sessionId, width, glyphs: ctx.glyphs, ...(widget.options.maxRows ? { maxNodes: Math.max(1, Math.floor(widget.options.maxRows / 3)) } : {}) }) : agentsCard(state.transcript.blocks().filter((block) => block.kind === "tool_call" && block.title?.startsWith("task:")).map((block) => ({ title: block.title!, status: toolStatus(block), ...(durationOf(block) !== undefined ? { durationMs: durationOf(block)! } : {}) })), width, ctx.glyphs)
      case "mcp": return lines((state.sidebarMcp ?? []).map((server) => `${server.name}: ${server.enabled ? server.state : "off"} · ${server.tools} tools`), state.sidebarMcp ? "No MCP servers" : "MCP status unavailable")
      case "git": return git.branch ? [text(git.branch), text(`${git.ahead === undefined ? "ahead unavailable" : `${git.ahead} ahead`} · ${git.behind === undefined ? "behind unavailable" : `${git.behind} behind`}`), text(`${git.dirty ?? state.changedFiles.length} dirty`)] : [text(git.error ?? "No Git repository", "muted")]
      case "session": {
        const session = state.sessions.find((session) => session.sessionId === state.sessionId)
        return [...(session?.lifecycle?.pr ? [text("PR #" + session.lifecycle.pr.number + " · " + session.lifecycle.pr.state.toLowerCase(), "primary")] : []), text(labelString(sessionLabel({ title: session?.title || state.agentTitles.get(state.sessionId) || "", draft: session?.draft }, { untitled: "Untitled session", marker: "Draft" }))), text(state.effectiveModel?.model ?? usage?.model ?? "Model unavailable", "muted"), text(session ? `Started ${new Date(session.createdAt).toLocaleString()}` : "Start time unavailable", "muted"), text(`${state.transcript.blocks().filter((block) => block.kind === "user_message").length} turns loaded`)]
      }
      case "clock": return [text(new Date(now()).toLocaleTimeString())]
      case "text": return widget.options.text ? renderMarkdown(widget.options.text, width) : [text("No text", "muted")]
      default:
        if (widget.type.startsWith("extension:")) {
          const id = widget.type.slice(10)
          const context = slotContext(width, Math.min(8, widget.options.maxRows ?? 8))
          return state.ext?.widgets("sidebar", context, [id])[0]?.body ?? state.ext?.slot(`sidebar:${id}`, context) ?? [text("Extension widget unavailable", "muted")]
        }
        return []
    }
  }

  function rightRows(width: number, height: number): Line[] {
    // An open file has the slot (or, while the panel has it, a tab above the panel names the file and switches back).
    if (fileInSlot(state)) return fileOpen.slotRows(width, height)
    const rows = panelRows(width, height)
    return state.fileViewer && !state.fileViewer.page ? [fileOpen.tabRow(width), ...rows.slice(1)] : rows
  }

  function panelRows(width: number, height: number): Line[] {
    orbitHeight = Math.min(34, Math.max(3, height - 4))
    ensureData()
    const chat = sideChat(ctx)
    const flat = input.screen.size.width < 70
    const widgets = state.tuiProfile.rightSidebar ? state.tuiProfile.sidebarWidgets : []
    const cardPanel = (widget: SidebarWidget): Line[] => {
      const built = widgetBody(widget, width - 2)
      // The widget's rows go through the `panel.widget` slot: a custom view restyles them (or draws its own) from the same plain data.
      const shown = ctx.views.draw("panel.widget", { widget: widget.type, options: widget.options as never, body: built }, { width: width - 2, height: Math.max(1, widget.options.maxRows ?? 40) }).lines
      let body = shown.map((line) => fit(line.map((span) => ({ ...span, text: span.text.replace(/[\x00-\x1f\x7f-\x9f]/g, "") })), width - 2))
      if (widget.options.maxRows && body.length > widget.options.maxRows) body = [...body.slice(0, widget.options.maxRows), text(`${body.length - widget.options.maxRows} more`, "muted")]
      const title = widget.title ?? widget.type[0]!.toUpperCase() + widget.type.slice(1)
      const value = widget.type === "agent" ? ctx.stateLabels[state.transcript.foreground] : widget.type === "context" && state.transcript.lastUsage?.contextTokens !== undefined ? `${Math.round(state.transcript.lastUsage.contextTokens / contextLimit(state.transcript.lastUsage, state.settingsNow.compactAtTokens ?? DEFAULT_COMPACT_AT_TOKENS) * 100)}%` : widget.type === "queue" && state.transcript.queue.length > 0 ? `${state.transcript.queue.length}` : widget.type === "tokens" && state.transcript.sessionUsage.calls > 0 ? `${state.transcript.sessionUsage.calls} call${state.transcript.sessionUsage.calls === 1 ? "" : "s"}` : widget.type === "orbit" ? inCode() ? orbitCode!.codeOrbitValue(code) : `${snapshot().graph.nodes.length} nodes` : ""
      const color = widget.type === "agent" ? isRunning() ? "primary" : state.transcript.foreground === "error" ? "error" : "success" : "primary"
      return panelCard({ title, value, body, width, color, ascii: ascii() })
    }
    // The galaxy first in the bar keeps its own layout (sphere, then Focus, Recent and Top); the cards after it are drawn under those.
    if (widgets[0]?.type === "orbit" && !chat.open && widgets.slice(1).every((widget) => widget.type !== "orbit" && widget.type !== "sidechat")) {
      const inner = width - 2
      const extra = widgets.slice(1).flatMap(cardPanel)
      // The galaxy takes the width it has (a card, its rule and a four-row legend around it); what is left of a tall bar goes to cards about the same graph.
      // The disc's rows plus the one status row under it and the card's two.
      const sphereRows = Math.min(36, Math.round((inner - 5) / Math.max(1.5, Math.min(3, cellAspect ?? 2))) + 3)
      // The cards the user added come before the galaxy's own detail cards when the bar cannot hold both.
      const below = height - 1 - (sphereRows + 2) - extra.length
      const split = !!orbit && below >= 5
      orbitHeight = split ? sphereRows : Math.min(36, Math.max(extra.length ? 3 : 1, height - 2 - extra.length))
      const header = fit(text(`galaxy${inCode() ? " · code" : ""} · /panel${state.rightFocus ? " · focused · esc back" : focusHint(" · ")}`, "muted"), width)
      const body = widgetBody(widgets[0]!, inner)
      const graph = inCode() ? codeGraph ?? emptyGraph : snapshot().graph
      const view = panelCard({ title: "Galaxy", value: inCode() ? orbitCode!.codeOrbitValue(code) : `${graph.nodes.length} node${graph.nodes.length === 1 ? "" : "s"}`, body, width, ascii: ascii() })
      const lower: Line[] = []
      if (split && inCode()) {
        // The same cards about the code graph; there are no touches to list, so `Recent` gives its rows to the other two.
        if (code.state === "ready" && code.files.length) {
          const details = orbitCode!.codeOrbitDetails({ report: code, camera: codeCamera, width: inner, ascii: ascii() })
          let left = below
          for (const card of [{ title: "Focus", value: code.files[codeCamera.selected] ? "file" : "", rows: details.focus, least: 2 }, { title: "Top", value: "", rows: details.top, least: 1 }]) {
            const take = Math.min(card.rows.length, left - 2)
            if (take < card.least) break
            lower.push(...panelCard({ title: card.title, value: card.value, body: card.rows.slice(0, take), width, ascii: ascii() }))
            left -= take + 2
          }
        }
      } else if (split) {
        const details = orbit!.orbitDetails({ graph, camera: { ...camera, focused: state.rightFocus }, width: inner, now: now(), ascii: ascii(), rows: orbit!.ORBIT_CARD_ROWS })
        const shownNode = graph.nodes[camera.selected]
        const cards: Array<{ title: string; value: string; rows: Line[]; least: number }> = [
          // With nothing selected (a type filter with no nodes) Focus is its one line, and the cards under it still show.
          { title: "Focus", value: shownNode && (!camera.filter || shownNode.kind === camera.filter) ? shownNode.kind : "", rows: details.focus, least: Math.min(2, details.focus.length) },
          { title: "Recent", value: graph.touches?.length ? `${Math.min(orbit!.ORBIT_RECENT, graph.touches.length)}` : "", rows: details.recent, least: 1 },
          { title: "Top", value: "", rows: details.top, least: 1 },
        ]
        let left = below
        for (const card of cards) {
          const take = Math.min(card.rows.length, left - 2)
          if (take < card.least) break
          lower.push(...panelCard({ title: card.title, value: card.value, body: card.rows.slice(0, take), width, ascii: ascii() }))
          left -= take + 2
        }
      }
      const stack = [...view, ...lower, ...extra]
      const rows = height < 3 ? [header, ...body.slice(0, 1)] : [header, ...stack.slice(0, Math.max(0, height - 1))]
      while (rows.length < height) rows.push(fit([], width))
      maxScroll = 0
      state.rightScroll = 0
      return rows.slice(0, height)
    }
    const panels: Line[] = []
    let chatArea: { top: number; height: number } | undefined
    // Opened with no `sidechat` card of its own, the side chat takes the whole bar and the cards come back when it closes: stacked over them it left neither enough room.
    const implicitChat = chat.open && !widgets.some((widget) => widget.type === "sidechat")
    const chatHeight = implicitChat ? Math.max(3, height - 1) : Math.max(8, widgets.some((widget) => widget.type !== "sidechat") ? Math.floor(height * .6) : height)
    const addChat = (title?: string) => {
      if (chatArea) return
      chatArea = { top: panels.length, height: chatHeight }
      panels.push(...sideChatRows(chat, width, chatHeight, title))
    }
    if (implicitChat) addChat()
    // A bar shorter than its cards keeps the `high` ones (and drops `low`, then `normal`, first) instead of scrolling past them; without priorities it scrolls.
    const built = (implicitChat ? [] : widgets).map((widget, index) => {
      const panel = widget.type === "sidechat" ? undefined : cardPanel(widget)
      return { index, priority: widget.type === "sidechat" && chat.open ? "high" as const : widget.options.priority ?? "normal" as const, rows: panel?.length ?? (chat.open ? chatHeight : 3), panel }
    })
    const fixedRows = implicitChat ? chatHeight : 0
    let shown = dropForHeight(built, Math.max(0, height - fixedRows - 1))
    if (shown.length < built.length) shown = dropForHeight(built, Math.max(0, height - fixedRows - 2))
    const hidden = built.length - shown.length
    const shownIndexes = new Set(shown.map((card) => card.index))
    for (const card of built) {
      if (!shownIndexes.has(card.index)) continue
      const widget = widgets[card.index]!
      if (widget.type === "sidechat") {
        if (chat.open) addChat(widget.title)
        else panels.push(...boxPanel({ title: widget.title ?? "btw", body: [text("/btw to open side chat", "muted")], width, compact: true, borderTitle: true, flat }))
        continue
      }
      panels.push(...card.panel!)
    }
    const overflow = panels.length > height - (hidden > 0 ? 1 : 0)
    const note = [...(hidden > 0 ? [`${hidden} hidden`] : []), ...(overflow ? [focusHint(""), "PgUp/PgDn scroll"].filter(Boolean) : [])].join(" · ")
    const name = implicitChat ? "side chat · /btw" : `${presetOf(widgets)} · /panel${state.rightFocus ? " · focused · esc back" : ""}`
    // A short sheet spends one row on the name and the note together, so the cards keep the rest.
    // `panelHeader` off gives the name row to the cards; a note (hidden cards, how to scroll) still shows when there is one.
    const header: Line[] = !state.tuiProfile.panelHeader ? (note ? [fit(text(note, "muted"), width)] : []) : note && height < 10 ? [fit(text(`${name} · ${note}`, "muted"), width)] : [fit(text(name, "muted"), width), ...(note ? [fit(text(note, "muted"), width)] : [])]
    const room = height - header.length
    maxScroll = Math.max(0, panels.length - room)
    if (chat.focused && chatArea) state.rightScroll = Math.min(maxScroll, chatArea.top)
    state.rightScroll = Math.min(state.rightScroll, maxScroll)
    state.rightChatArea = chatArea ? { top: chatArea.top - state.rightScroll + header.length, height: chatArea.height } : undefined
    const rows = [...header, ...panels.slice(state.rightScroll, state.rightScroll + room)]
    while (rows.length < height) rows.push(fit([], width))
    return rows.slice(0, height).map((row) => fit(row, width))
  }

  /** Whether the bar is visible is the user's own file; a project spec lives elsewhere, so it must be written there too or a restart hides the panel. */
  async function persistVisible(visible: boolean) {
    if (!input.dataDir) return
    const { writeTuiProfile } = await import("../../view/tui-profile")
    const saved = writeTuiProfile(input.dataDir, { ...readTuiProfile(input.dataDir), rightSidebar: visible })
    if (!saved.ok) fail(saved.error)
  }

  async function save(widgets: SidebarWidget[]): Promise<boolean> {
    const reply = await input.send({ type: "sidebar.update", directory: input.directory ?? process.cwd(), change: { action: "set", scope, widgets } })
    if (!reply.ok) {
      fail(reply.error.message)
      return false
    }
    state.tuiProfile.sidebarWidgets = sidebarSpec(reply.result?.widgets ?? widgets)
    state.tuiProfile.rightSidebar = widgets.length > 0
    state.rightScroll = 0
    // The edited file is what this session shows now: it has no cards of its own any more.
    const own = state.sessionLook.get(state.sessionId)
    if (own && ("sidebarWidgets" in own || "rightSidebar" in own)) {
      const { sidebarWidgets: _cards, rightSidebar: _shown, ...rest } = own
      state.sessionLook.set(state.sessionId, rest)
      if (input.dataDir) writeSessionLook(input.dataDir, state.sessionLook)
    }
    if (scope === "project") await persistVisible(state.tuiProfile.rightSidebar)
    requestFrame()
    return true
  }

  /** The balanced/full gate for every verb that would show or change the bar. A refusal says why once and changes nothing. */
  const refusedView = () => state.mode === "minimal" || !featureOn(state.settingsNow, "panel") ? "Right bar presets need the balanced or full view" : undefined

  /** Writes a curated spec, using the same daemon permissions as the editor. */
  async function applyPreset(name: string | undefined) {
    const refusal = refusedView()
    if (refusal) return ctx.say(refusal, "info")
    const chosen = panelPreset(name || "pulse")
    if (!chosen) return ctx.say(`Presets: ${PANEL_PRESETS.join(", ")}`, "info")
    if (chosen === "galaxy" && !orbitAllowed()) return ctx.say(`Galaxy needs full tier (/tier full) · try /panel ${NEAREST_PRESET.galaxy}`, "info")
    showOwn(structuredClone(SIDEBAR_PRESETS[chosen]) as SidebarWidget[])
    ctx.say(`panel: ${chosen} (${SIDEBAR_PRESETS[chosen].length} card${SIDEBAR_PRESETS[chosen].length === 1 ? "" : "s"}) · this session`)
  }

  /** These cards, shown, for this session only. */
  function showOwn(widgets: SidebarWidget[]) {
    state.rightScroll = 0
    look({ sidebarWidgets: sidebarSpec(widgets), rightSidebar: widgets.length > 0 })
  }

  /** `/panel width 32..80|auto`: cells the right bar takes, in this session. */
  function applyWidth(value: string | undefined) {
    const cells = value === "auto" || value === "0" ? 0 : Number(value)
    if (!Number.isInteger(cells) || cells !== 0 && (cells < 32 || cells > 80)) return ctx.say("Use /panel width 32..80 or auto", "warning")
    look({ sidebarWidth: cells })
    ctx.say(cells ? `panel width: ${cells}` : "panel width: auto")
    requestFrame()
  }

  async function command(args: string, panel = false): Promise<boolean> {
    const [verbName, ...rest] = args.trim().split(/\s+/)
    const first = verbName?.toLowerCase()
    if (panel && first === "next") {
      const refusal = refusedView()
      if (refusal) return ctx.say(refusal, "info"), true
      await loadSpec()
      await applyPreset(nextPreset(presetOf(state.tuiProfile.sidebarWidgets), PANEL_PRESETS.filter((preset) => preset !== "galaxy" || orbitAllowed())))
      return true
    }
    if (panel && first && panelPreset(first)) {
      await applyPreset(first)
      return true
    }
    if (first === "widget") {
      const id = rest[0]
      if (!id || !/^[\w-]+$/.test(id)) {
        fail("Use /panel widget <id>")
        return true
      }
      const refusal = refusedView()
      if (refusal) return ctx.say(refusal, "info"), true
      await loadSpec()
      // A built-in card's own name adds that card; any other id is a registered extension panel.
      const builtIn = (WIDGET_TYPES as readonly string[]).includes(id) && id !== "sidechat" && id !== "text"
      const type = builtIn ? id as SidebarWidget["type"] : `extension:${id}` as const
      if (type === "orbit" && !orbitAllowed()) return ctx.say(`Galaxy needs full tier (/tier full) · try /panel ${NEAREST_PRESET.galaxy}`, "info"), true
      if (!state.tuiProfile.sidebarWidgets.some((widget) => widget.type === type)) showOwn([...state.tuiProfile.sidebarWidgets, builtIn ? { type, options: {} } : { type, title: id, options: { maxRows: 8 } }])
      requestFrame()
      return true
    }
    if (first === "preset") {
      await applyPreset(rest[0]?.toLowerCase())
      requestFrame()
      return true
    }
    if (first === "width") {
      applyWidth(rest[0]?.toLowerCase())
      return true
    }
    const verb = args.trim().toLowerCase() || (panel ? "toggle" : "")
    if (!["right", "edit", "reset", ...(panel ? ["toggle", "off"] : [])].includes(verb)) {
      if (panel) ctx.say("Use /panel [pulse|crew|ledger|focus|full|galaxy|next|off|edit|reset|width|widget]", "warning")
      return panel
    }
    const refusal = refusedView()
    if (verb === "edit") {
      if (refusal) return ctx.say(refusal, "info"), true
      await loadSpec()
      await preload("sidebar")
      state.sidebarEdit = { selected: 0, adding: false, type: 0 }
      state.page = "sidebar"
    } else if (verb === "reset") {
      await loadSpec()
      await save([])
    }
    else {
      await loadSpec()
      const turningOn = verb !== "off" && !state.tuiProfile.rightSidebar
      // Hiding is always allowed; showing waits for a view that has a bar.
      if (refusal && (turningOn || verb !== "off" && !state.tuiProfile.sidebarWidgets.length)) return ctx.say(refusal, "info"), true
      if (!state.tuiProfile.sidebarWidgets.length && verb !== "off") {
        await applyPreset("pulse")
        return true
      }
      const visible = verb !== "off" && !state.tuiProfile.rightSidebar && state.tuiProfile.sidebarWidgets.length > 0
      if (!visible) state.rightFocus = false
      look({ rightSidebar: visible })
    }
    requestFrame()
    return true
  }

  async function rightKey(key: string): Promise<boolean> {
    if (state.page === "sidebar") {
      if (state.sidebarEdit.draft === undefined && /^[\x20-\x7e]{2,}$/.test(key)) {
        for (const character of key) await rightKey(character)
        return true
      }
      const edit = state.sidebarEdit
      const widgets = [...state.tuiProfile.sidebarWidgets]
      if (edit.draft !== undefined) {
        if (key === "\x1b") edit.draft = undefined
        else if (key === "\r") {
          try {
            const parsed = JSON.parse(edit.draft)
            const valid = sidebarSpec([parsed])
            if (!valid.length) return fail("Invalid widget"), true
            if (edit.adding) widgets.push(valid[0]!)
            else widgets[edit.selected] = valid[0]!
            await save(widgets)
            edit.draft = undefined
            edit.adding = false
          } catch { fail("Invalid widget JSON") }
        } else if (key === "\x7f") edit.draft = edit.draft.slice(0, -1)
        else if (key === "\x15") edit.draft = ""
        else if (!/[\x00-\x1f\x7f]/.test(key)) edit.draft += key
      } else if (edit.adding) {
        if (key === "\x1b") edit.adding = false
        else if (key === "\x1b[C" || key === "\x1b[D") edit.type = (edit.type + (key.endsWith("C") ? 1 : WIDGET_TYPES.length)) % (WIDGET_TYPES.length + 1)
        else if (key === "\r") {
          const type = [...WIDGET_TYPES, "extension"][edit.type]!
          if (type === "extension" || type === "text") edit.draft = JSON.stringify({ type: type === "extension" ? "extension:id" : type, options: type === "text" ? { text: "" } : {} })
          else {
            await save([...widgets, { type, options: {} }])
            edit.adding = false
            edit.selected = widgets.length
          }
        }
      } else if (key === "\x1b") state.page = "chat"
      else if (key === "a") {
        edit.adding = true
        edit.type = 0
      }
      else if (key === "\x1b[A" || key === "\x1b[B") edit.selected = Math.max(0, Math.min(widgets.length - 1, edit.selected + (key.endsWith("B") ? 1 : -1)))
      else if (key === "e" && widgets[edit.selected]) edit.draft = JSON.stringify(widgets[edit.selected])
      else if (key === "d" && widgets[edit.selected]) {
        widgets.splice(edit.selected, 1)
        await save(widgets)
        edit.selected = Math.max(0, Math.min(edit.selected, widgets.length - 1))
      }
      else if ((key === "J" || key === "K") && widgets[edit.selected]) {
        const to = Math.max(0, Math.min(widgets.length - 1, edit.selected + (key === "J" ? 1 : -1)))
        widgets.splice(to, 0, widgets.splice(edit.selected, 1)[0]!)
        edit.selected = to
        await save(widgets)
      }
      requestFrame()
      return true
    }
    const currentLayout = layout(input.screen.size.width)
    if (state.page !== "chat" || !(currentLayout.right || currentLayout.bottom && state.tuiProfile.rightSidebar)) return false
    const mouse = /^\x1b\[<(\d+);(\d+);(\d+)M$/.exec(key)
    const inBar = !!mouse && currentLayout.right > 0 && Number(mouse[2]) > input.screen.size.width - currentLayout.right
    // A click outside the bar gives the keyboard back to the prompt, from the panel and from the side chat; the click itself goes on to what it hit.
    if (mouse && !inBar && Number(mouse[1]) === 0 && (state.rightFocus || sideChat(ctx).focused)) {
      state.rightFocus = false
      sideChat(ctx).focused = false
      requestFrame()
    }
    if (mouse && inBar) {
      if (Number(mouse[1]) === 0) {
        // A click on the side chat gives it the keyboard. A click on the cards does not: the panel's keys are plain letters (h j k l m f),
        // and a stray click would make it swallow them out of whatever is typed next. The panel takes the keyboard by its key only.
        const chat = sideChat(ctx)
        chat.focused = !!(chat.open && state.rightChatArea && Number(mouse[3]) - 1 >= state.rightChatArea.top && Number(mouse[3]) - 1 < state.rightChatArea.top + state.rightChatArea.height)
        if (chat.focused) { state.rightFocus = false; state.sidebarFocus = false }
      }
      if (Number(mouse[1]) === 64 || Number(mouse[1]) === 65) {
        const chat = sideChat(ctx)
        if (chat.open && state.rightChatArea && Number(mouse[3]) - 1 >= state.rightChatArea.top && Number(mouse[3]) - 1 < state.rightChatArea.top + state.rightChatArea.height) chat.scroll = Math.max(0, chat.scroll + (Number(mouse[1]) === 64 ? 3 : -3))
        else state.rightScroll = Math.max(0, Math.min(maxScroll, state.rightScroll + (Number(mouse[1]) === 65 ? 3 : -3)))
      }
      requestFrame()
      return true
    }
    if (key === "\x1b}" && state.tuiProfile.rightSidebar) {
      state.rightFocus = !state.rightFocus
      sideChat(ctx).focused = false
    } else if (state.rightFocus && key === "\x1b") {
      state.rightFocus = false
      sideChat(ctx).focused = false
    }
    else if (state.rightFocus && state.tuiProfile.sidebarWidgets.some((widget) => widget.type === "orbit") && orbitAllowed() && orbit && ["h", "j", "k", "l", "\x1b[A", "\x1b[B", "\x1b[C", "\x1b[D", "\t", "\r", "+", "=", "-", "f", "[", "]", orbit.ORBIT_MODE_KEY].includes(key)) {
      const coding = inCode()
      const graph = coding ? codeGraph ?? emptyGraph : snapshot().graph
      const camera = activeCamera()
      if (key === orbit.ORBIT_MODE_KEY) {
        velocity.yaw = 0
        velocity.pitch = 0
        // The key is the user's choice: the view no longer changes by itself in this session.
        codeByItself = false
        triedByItself = true
        if (coding) orbitMode = "session"
        else void askCode(orbitCode ??= await import("../../view/panel-orbit-code"))
      }
      // The code graph has one kind of node and no events: its type filter and event keys do nothing.
      else if (coding && ["f", "[", "]"].includes(key)) return true
      else if (coding && key === "\r") {
        const node = graph.nodes[camera.selected]
        if (node) {
          state.rightFocus = false
          fileOpen.openFile(node.target)
        }
      }
      else if (key === "[" || key === "]") orbit.stepOrbitEvent(graph, camera, key === "]" ? 1 : -1)
      else if (key === "f") {
        const next = camera.filter ? orbit.ORBIT_KINDS.indexOf(camera.filter) + 1 : 0
        camera.filter = orbit.ORBIT_KINDS[next]
        camera.selected = graph.nodes.findIndex((node) => !camera.filter || node.kind === camera.filter)
      }
      else if (["+", "=", "-"].includes(key)) camera.zoom = Math.max(.65, Math.min(1.35, (camera.zoom ?? 1) + (key === "-" ? -.1 : .1)))
      else if (key === "\t") {
        const visible = graph.nodes.map((node, index) => ({ node, index })).filter(({ node }) => !camera.filter || node.kind === camera.filter)
        camera.selected = visible[(visible.findIndex(({ index }) => index === camera.selected) + 1) % Math.max(1, visible.length)]?.index ?? -1
        camera.event = undefined
      }
      else if (key === "\r") {
        const node = graph.nodes[camera.selected]
        if (node) {
          state.rightFocus = false
          // A symbol opens its file at its line; a file opens its retained diff, as before.
          if (node.kind === "symbol" && node.parent) fileOpen.openFile(node.target, node.line ? { from: node.line } : undefined)
          else await openNode(node)
        }
      }
      else if (["h", "l", "\x1b[D", "\x1b[C"].includes(key)) {
        const direction = ["h", "\x1b[D"].includes(key) ? -.2 : .2
        camera.yaw += direction
        velocity.yaw = state.reducedMotion ? 0 : direction * .4
      } else {
        const direction = ["j", "\x1b[B"].includes(key) ? .2 : -.2
        camera.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, camera.pitch + direction))
        velocity.pitch = state.reducedMotion ? 0 : direction * .4
      }
    }
    else if (state.rightFocus && ["\x1b[5~", "\x1b[6~", "\x1b[A", "\x1b[B"].includes(key)) state.rightScroll = Math.max(0, Math.min(maxScroll, state.rightScroll + (key.endsWith("B") || key === "\x1b[6~" ? 5 : -5)))
    else return false
    requestFrame()
    return true
  }

  return { layout, rightRows, command, rightKey, loadSpec, ensureData }
}
