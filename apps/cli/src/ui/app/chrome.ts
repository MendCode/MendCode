import { agentColor } from "../../view/agent-color"
import type { createSession } from "./session"
import type { createScratch } from "./scratch"
import type { createSecrets } from "./secrets"
import type { createAgents } from "./agents"
import { goalSpans } from "../../view/goal"
import { BREAKPOINTS, breakpointOf } from "../breakpoints"
import { chatColumns, projectSessions, SIDEBAR_WIDTH, sidebarVisible } from "../../view/sidebar"
import { DEFAULT_COMPACT_AT_TOKENS, DEFAULT_FOOTER, DEFAULT_PROFILE, FOOTER_OPT_IN, FOOTER_SEGMENTS, featureOn, profileFor, type FooterSegment } from "@mendcode/protocol/wire"
import { contextIsEngineWindow, contextLimit } from "../../view/context-meter"
import type { McpStatusReport } from "@mendcode/protocol"
import { fastMark, quotaText, renderFooter, type FooterInput } from "../../view/footer"
import { externalEngine, fastApplies } from "../../view/fast-mode"
import { footerRowBudget, renderFooterRows } from "../../view/footer-rows"
import { partsLine } from "../../view/stat-parts"
import { statusLineSpans } from "../../view/status-line"
import { modelLabel, modelWithEffort, servedByProvider, sessionModelId } from "../../view/model-label"
import { rightBarCells } from "../../view/right-bar"
import { maskSecretMarkers } from "../../view/secret-markers"
import { topbarAnimates, topbarContextArea } from "../../view/topbar"
import { parseTodoText, renderDock, DOCK_BODY_ROWS, type DockJob } from "../../view/dock"
import { META_MARGIN, PROMPT_MARGIN, renderStatusRow } from "../../view/prompt-chrome"
import { statusItems } from "../../view/status-items"
import type { SidebarMode, TuiProfile } from "../../view/tui-profile"
import type { FooterModel } from "@mendcode/extension-api/views"
import type { Line } from "../theme"
import type { AppContext } from "./context"
import { asciiChrome } from "./glyph-mode"
import { fileInSlot, panelWanted } from "./file-slot"
import { sessionDisplayTitle } from "./display-title"
import { boxPanel } from "../../view/deck"
import { createCacheClock } from "./cache-clock"
import { usageInForce } from "./usage-in-force"

/** A turn in progress: the cache is being read and written, so there is nothing to count down. */
const WORKING = new Set(["generating", "tool", "compacting", "cancelling"])

export function createChrome(ctx: AppContext, actions: {
  loadBranch: ReturnType<typeof createSession>["loadBranch"]
  ensureScratch: ReturnType<typeof createScratch>["ensureScratch"]
  secretTail: ReturnType<typeof createSecrets>["secretTail"]
  agentSubtasks: ReturnType<typeof createAgents>["agentSubtasks"]
  changeProfile: (patch: Partial<TuiProfile>, options?: { session?: boolean }) => void
  footerSlots: (width: number) => { left?: Line; right?: Line; replace?: Line; rows?: Array<{ left?: Line; right?: Line; replace?: Line }> } | undefined
}) {
  const { input, state, now, editor, stateLabels: STATE_LABEL, permissionLabels: PERMISSION_LABEL, say, requestFrame, glyphs: g, quotas, codegraph } = ctx
  const { loadBranch, ensureScratch, secretTail, agentSubtasks, changeProfile, footerSlots } = actions
  const cacheClock = createCacheClock({ send: (command) => input.send(command), requestFrame })

  /** The agent title (kept live by `session.activity`), else the title of the session's own listed summary. */
  function sessionTitle() {
    const agent = state.agentTitles.get(state.sessionId)?.trim()
    if (agent) return agent
    const summary = state.sessions.find((listed) => listed.sessionId === state.sessionId) ?? state.paletteSessions.find((listed) => listed.sessionId === state.sessionId)
    return summary?.title.trim() ?? ""
  }

  /** The top bar; a branch is asked for the first time it shows. */
  function topbarRow(width: number): Line {
    if (state.gitBranch === undefined && !state.branchRequested) {
      state.branchRequested = true
      void loadBranch()
    }
    const context = usageInForce(state)?.contextTokens
    const title = sessionDisplayTitle(state, sessionTitle())
    // v1's session container pads two cells on each side.
    const room = width - PROMPT_MARGIN * 2
    // The stat parts the profile places in the bar (`topbarStats`), drawn by the registry like every other surface.
    const topbarStats = state.tuiProfile.topbarStats ? partsLine(state.tuiProfile.topbarStats.split(","), ctx.stats.read(), { quiet: true }) : []
    const bar = {
      path: !state.tuiProfile.showProject ? "" : input.remote ? `remote ${input.remote.host}${input.remote.readOnly ? " · read-only" : ""}` : input.directory ?? "",
      hideProject: !state.tuiProfile.showProject,
      ...(state.tuiProfile.showDiffFiles && state.diffTotals ? { files: state.changedFiles.length } : {}),
      ...(input.home ? { home: input.home } : {}),
      ...(state.tuiProfile.showProject && state.gitBranch ? { branch: state.gitBranch } : {}),
      title: state.tuiProfile.showSessionTitle ? title : "",
      ...(state.tuiProfile.showDiffLines && state.diffTotals ? { diff: state.diffTotals } : {}),
      ...(state.tuiProfile.showContext && context !== undefined ? { context: { tokens: context, limit: contextLimit(usageInForce(state), state.settingsNow.compactAtTokens ?? DEFAULT_COMPACT_AT_TOKENS), ...(usageInForce(state)?.contextApprox ? { approx: true } : {}) } } : {}),
      ...(topbarStats.length ? { stats: topbarStats } : {}),
      contextHover: state.contextHover === true,
      contextStyle: state.tuiProfile.contextStyle,
      // An open sub-agent thread names its keys in its own header (agent-thread-header.ts).
      ...(state.agentView ? {} : state.sessionParentId ? { navigation: width < 70 ? "↑ parent · ←→" : "↑ parent · ←→ siblings" } : {}),
      ...(!state.reducedMotion && topbarAnimates({ width: room, title }) ? { tick: state.topbarTick } : {}),
    }
    const area = topbarContextArea({ ...bar, width: room })
    state.contextArea = area ? { from: area.from + PROMPT_MARGIN, to: area.to + PROMPT_MARGIN } : undefined
    const rendered = ctx.views.draw("topbar", bar, { width: room, height: 1 }).lines[0] ?? []
    return [{ text: " ".repeat(PROMPT_MARGIN) }, ...rendered]
  }

  /** The newest `todo` tool result's checklist (the dock and the sidebar show it). */
  function currentTodos() {
    const todo = state.transcript.blocks().findLast((block) => block.kind === "tool_call" && block.title?.startsWith("todo"))
    return todo ? parseTodoText(todo.text) : []
  }

  /** This session's background shell tasks, running ones first, for the dock's Jobs panel. */
  function dockJobs(): DockJob[] {
    const shells = state.agentShells.filter((shell) => shell.sessionId === state.sessionId).map((shell): DockJob => ({ command: shell.command, status: shell.status, startedAt: shell.startedAt, ...(shell.exitCode !== undefined ? { exitCode: shell.exitCode } : {}), ...(shell.endedAt !== undefined ? { endedAt: shell.endedAt } : {}) }))
    const jobs = state.transcript.continuityJobs.map((record): DockJob => ({ command: record.tool ?? record.id, status: record.status as DockJob["status"], startedAt: record.createdAt, ...(!["queued", "running"].includes(record.status) ? { endedAt: record.updatedAt } : {}) }))
    return [...jobs, ...shells].sort((a, b) => Number(["queued", "running"].includes(b.status)) - Number(["queued", "running"].includes(a.status)) || b.startedAt - a.startedAt).slice(0, 12)
  }

  /** ctrl+t: todos from the newest `todo` tool result, pending questions, running sub-agents and background jobs, the session's scratch note, and its facts. */
  function dockRows(width: number, maxRows = Number.POSITIVE_INFINITY): Line[] {
    state.scratchArea = undefined
    state.scratchCursor = undefined
    const usage = usageInForce(state)
    const percent = usage?.contextTokens !== undefined ? Math.round((usage.contextTokens / contextLimit(usage, state.settingsNow.compactAtTokens ?? DEFAULT_COMPACT_AT_TOKENS)) * 100) : undefined
    const model = sessionModelId(state.effectiveModel?.model, usage?.model, state.modelReport)
    ensureScratch()
    const rows = renderDock({
      width: width - PROMPT_MARGIN * 2,
      todos: currentTodos(),
      questions: state.transcript.pendingRequests.map((request) => ({ kind: request.kind, title: maskSecretMarkers(request.title, secretTail) })),
      jobs: dockJobs(),
      now: now(),
      scratch: { lines: state.scratchNote.split("\n"), editing: state.editingScratch !== undefined, editor: ctx.scratchEditor },
      onScratch: (area) => {
        state.scratchArea = { top: 3, left: area.left + PROMPT_MARGIN, width: area.width, rows: DOCK_BODY_ROWS, first: area.first }
        state.scratchCursor = area.cursor ? { row: area.cursor.row, col: area.cursor.col + PROMPT_MARGIN } : undefined
      },
      subagents: agentSubtasks().map((task) => ({ label: task.title.replace(/^task:\s*/, "") || "subagent", status: task.latest ? "working" : "starting", tone: "warning" as const })),
      info: {
        ...(state.gitBranch ? { branch: state.gitBranch } : {}),
        cwd: input.home && input.directory?.startsWith(input.home) ? `~${input.directory.slice(input.home.length)}` : (input.directory ?? ""),
        ...(percent !== undefined ? { context: `${percent}%` } : {}),
        permission: state.transcript.permissionMode,
        ...(model ? { model: modelWithEffort(model, state.effectiveModel?.effort, state.modelReport) } : {}),
        activity: state.transcript.foreground,
      },
    }).map((line): Line => [{ text: " ".repeat(PROMPT_MARGIN) }, ...line])
    const screen = input.screen.size
    const custom = state.ext?.widgets("tray", { width: width - 8, height: 2, breakpoint: breakpointOf(screen.width), screen: { width: screen.width, height: screen.height }, directory: input.directory ?? "", state: "idle", stats: ctx.stats.read(), usage: ctx.usage.read(), now: now(), ...(state.gitBranch ? { branch: state.gitBranch } : {}) }) ?? []
    for (const widget of custom.slice(0, 2)) {
      const panel = [[], ...boxPanel({ title: widget.title, body: widget.body.slice(0, 2), width: width - 4, compact: true, borderTitle: true }).map((line): Line => [{ text: "  " }, ...line])]
      if (rows.length + panel.length <= maxRows) rows.push(...panel)
    }
    return rows
  }

  /** The project's sessions, with hit rows for mouse navigation. */
  function sidebarRows(height: number): Line[] {
    const sessions = projectSessions(state.sessions, input.directory ?? "").map(({ sessionId, title, state: sessionState, queued, updatedAt, archivedAt, lifecycle, draft }) => ({ sessionId, title, state: sessionState, queued, updatedAt, ...(archivedAt !== undefined ? { archivedAt } : {}), ...(lifecycle ? { lifecycle } : {}), ...(draft ? { draft } : {}) }))
    const drawn = ctx.views.draw("sessions.sidebar", { sessions, current: state.sessionId, ...(state.sidebarSelected ? { selected: state.sidebarSelected } : {}), focused: state.sidebarFocus === true }, { width: SIDEBAR_WIDTH, height, extra: { header: state.tuiProfile.sidebarHeader } })
    state.sidebarHits = drawn.hits.filter((hit) => hit.action === "open" && typeof hit.arg === "string").map((hit) => ({ row: hit.row, sessionId: hit.arg as string }))
    return drawn.lines
  }

  async function loadSidebarMcp() {
    state.sidebarMcpAsked = true
    const reply = await input.send({ type: "mcp.status", directory: input.directory ?? "" })
    if (reply.ok) state.sidebarMcp = (reply.result as McpStatusReport | undefined)?.servers ?? []
    requestFrame()
  }

  /** `/sidebar auto|always|hidden` sets the mode; with no argument the key's toggle: hide it when it shows, show it when it does not. */
  function setSidebar(next: SidebarMode) {
    changeProfile({ sidebar: next }, { session: true })
    say(`sidebar: ${next}`)
    requestFrame()
  }

  const rowsOn = () => state.tuiProfile.footerRows.length > 0

  /** `statusColors` as a map, parsed again only when the setting changed. */
  let colorsText = ""
  let colorsMap: Record<string, string> = {}
  function statusColorMap(): Record<string, string> {
    if (state.tuiProfile.statusColors !== colorsText) {
      colorsText = state.tuiProfile.statusColors
      try { colorsMap = colorsText ? JSON.parse(colorsText) : {} } catch { colorsMap = {} }
    }
    return colorsMap
  }

  /**
   * Tokens this session's own code graph lookups saved (source `graph` of the daemon's `session.savings`, which the panel's `savings`
   * card lists whole), asked again after each model call. Output filters and graft report other sources: the GRAPH row never counts them.
   */
  let savedFor: { key: string; tokens?: number } | undefined
  function footerSaved(): number | undefined {
    const key = `${state.sessionId}:${state.transcript.sessionUsage.calls}`
    if (savedFor?.key === key) return savedFor.tokens
    const previous = savedFor?.key.startsWith(`${state.sessionId}:`) ? savedFor.tokens : undefined
    const entry: { key: string; tokens?: number } = { key, ...(previous !== undefined ? { tokens: previous } : {}) }
    savedFor = entry
    void input.send({ type: "session.savings", sessionId: state.sessionId }).then((reply) => {
      if (!reply.ok || savedFor !== entry || !Array.isArray(reply.result?.savings)) return
      entry.tokens = (reply.result.savings as Array<{ source?: unknown; tokens: number }>).reduce((sum, item) => item.source === "graph" ? sum + item.tokens : sum, 0)
      requestFrame()
    })
    return entry.tokens
  }

  /** Whether the chrome is plain ASCII (accessible mode, an ASCII prompt): icons are never drawn there. */
  const asciiMarks = () => state.tuiProfile.accessible || asciiChrome(state)

  /**
   * What only the newer segments read: the directory, the code graph, the texts, the icons and the colours of `statusColors`. A footer
   * that uses none of them (the default) gets nothing, so its frames and its cost are the ones it always had.
   */
  function footerExtras(segments: readonly FooterSegment[]): Partial<FooterInput> {
    const profile = state.tuiProfile
    const icons = profile.footerIcons !== "none"
    if (!rowsOn() && !icons && !profile.statusColors && !segments.some((segment) => segment === "directory" || segment === "codegraph" || segment === "time")) return {}
    const directory = input.home && input.directory?.startsWith(input.home) ? `~${input.directory.slice(input.home.length)}` : input.directory
    const graphShown = segments.includes("codegraph") || profile.footerRows.some((row) => row.includes("codegraph"))
    const savedTokens = graphShown ? footerSaved() : undefined
    const counts = graphShown && input.directory ? codegraph.get(input.directory) : undefined
    return {
      ...(directory ? { directory } : {}),
      codegraph: { on: featureOn(state.settingsNow, "codegraph"), ...(savedTokens ? { savedTokens } : {}), ...(counts?.state === "skipped" ? { skipped: counts.reason ?? "off" } : counts ? { index: { state: counts.state === "indexing" ? "indexing" as const : "indexed" as const, files: counts.files, symbols: counts.symbols, edges: counts.edges } } : {}) },
      texts: profile.footerText,
      ...(icons ? { icons: { mode: profile.footerIcons, ascii: asciiMarks() } } : {}),
      separator: profile.statusSeparator,
      colors: statusColorMap(),
    }
  }

  /** The rows of `footerRows`, each cut to the footer's width, as many as a quarter of the terminal's height allows. */
  function footerRowLines(feed: FooterInput): Line[] {
    const usage = usageInForce(state)
    const id = sessionModelId(state.effectiveModel?.model, usage?.model, state.modelReport)
    const threshold = contextLimit(usage, state.settingsNow.compactAtTokens ?? DEFAULT_COMPACT_AT_TOKENS)
    return renderFooterRows({
      input: {
        ...feed,
        stateLabel: STATE_LABEL[state.transcript.foreground], dotOn: true,
        connection: state.connection,
        permission: state.transcript.permissionMode, permissionLabel: PERMISSION_LABEL[state.transcript.permissionMode], showPermission: state.tuiProfile.showPermission,
        ...(id ? { model: modelLabel(id, state.modelReport) } : {}),
        ...(usage?.contextTokens !== undefined && threshold > 0 ? { context: { tokens: usage.contextTokens, threshold } } : {}),
        ...(state.gitBranch ? { branch: state.gitBranch } : {}),
        ...(state.transcript.goal ? { goal: state.transcript.goal } : {}),
        // Adaptive reasoning applies to the daemon's own generations only (docs/reasoning.md): a Claude Code, Codex or pi model keeps its own level, unmarked.
        ...(featureOn(state.settingsNow, "jev") && !externalEngine(state.effectiveModel?.model ?? id, state.modelReport) ? { adaptive: true } : {}),
      },
      rows: state.tuiProfile.footerRows,
      limit: footerRowBudget(input.screen.size.height),
    })
  }

  /** What the footer slot shows (docs/views.md): everything the first row is built from, as plain data. */
  function footerModel(width: number, provided?: ReturnType<typeof footerSlots>): { model: FooterModel; slots: ReturnType<typeof footerSlots>; rows: Line[] | undefined } {
    const model = sessionModelId(state.effectiveModel?.model, usageInForce(state)?.model, state.modelReport)
    const slots = state.shellMode ? undefined : provided ?? footerSlots(width - META_MARGIN - PROMPT_MARGIN)
    const name = state.transcript.permissionMode === "plan" ? "plan" : state.agentReport?.current ?? "build"
    // The model's own provider, else the engine that runs it (a Claude Code model is not served by the native engine the daemon started with).
    const provider = servedByProvider(state.effectiveModel?.model ?? model, state.modelReport) ?? usageInForce(state)?.provider
    // This session's background work; the row over the prompt names it, so the built-in count is not repeated (`/footer +jobs` still places it).
    const jobs = state.agentShells.filter((shell) => shell.status === "running" && shell.sessionId === state.sessionId).length
    const chosen = (state.customFooter ?? [...(state.tuiProfile.footerQuota ? ["quota"] as const : []), ...(state.tuiProfile.footerToday ? ["today"] as const : [])]).filter((segment) => !["state", "model", "permission", "context", "goal", "notice"].includes(segment))
    // The forecast follows the tier (balanced and up; `/tier forecast off` removes it); `/footer` placing it is an explicit choice that stays even in minimalist.
    const forecastOn = state.customFooter ? chosen.includes("forecast") && state.settingsNow.features?.forecast !== false : featureOn(state.settingsNow, "forecast")
    const segments = forecastOn ? [...new Set<FooterSegment>([...chosen, "forecast"])] : chosen.filter((segment) => segment !== "forecast")
    const sandbox = state.settingsNow.sandbox?.mode ?? "off"
    const update = state.updateAvailable ? (state.updateAvailable.installed ? "restart to update" : `update ${state.updateAvailable.version}`) : undefined
    // The cache countdown is a full-tier segment the user places (`/footer +warm`): without the feature it has no data and draws nothing.
    const warmPlaced = segments.includes("warm") || (rowsOn() && state.tuiProfile.footerRows.some((row) => row.includes("warm")))
    const warm = warmPlaced && featureOn(state.settingsNow, "cache_countdown") ? cacheClock.read(state.sessionId, usageInForce(state), WORKING.has(state.transcript.foreground)) : undefined
    cacheClock.ticking(warm !== undefined)
    const feed: FooterInput = {
      segments,
      width: width - META_MARGIN - PROMPT_MARGIN,
      glyphs: g, stateLabel: "", state: state.transcript.foreground, dotOn: false,
      connection: "connected", permission: "ask", permissionLabel: "",
      quotas: [...quotas.values()], quotaStyle: { view: state.tuiProfile.quotaView, color: state.tuiProfile.quotaColor }, now: now(), notice: "",
      usage: state.transcript.sessionUsage, jobs, sandbox, calls: state.transcript.recentCalls,
      stats: ctx.stats.read(),
      ...(state.transcript.sessionCost !== undefined ? { spentMicros: state.transcript.sessionCost } : {}),
      ...(state.effectiveModel?.effort ? { effort: state.effectiveModel.effort } : {}),
      // Priority processing is a setting of the daemon's own providers: the mark shows when this model is served by one, and says `n/a` when it is not.
      ...((state.modelReport?.session?.fast ?? state.settingsNow.serviceTier === "fast") ? (fastApplies(state.effectiveModel?.model ?? model, state.modelReport) ? { fast: true } : { fastIgnored: true }) : {}),
      ...(state.tuiProfile.vimMode ? { vim: ctx.vim.label } : {}),      ...(update ? { update } : {}),
      ...(state.todayUsage ? { today: state.todayUsage } : {}),
      ...(warm ? { warm } : {}),
      ...(state.customFooter && state.gitBranch ? { branch: state.gitBranch } : {}),
      ...footerExtras(segments),
    }
    // `footerRows`: the whole footer is the rows, so the single row's counters are not built.
    const rows = rowsOn() && !state.shellMode ? footerRowLines(feed) : undefined
    const counters = rows ? [] : renderFooter(feed)
    if (state.tuiProfile.showCommandHint) counters.push({ text: "  ctrl-p commands", fg: "muted" })
    if (state.tuiProfile.showAgentHint) counters.push({ text: "  /agents", fg: "muted" })
    if (state.mflowWait) counters.unshift({ text: `Mflow ${state.mflowWait.file.slice(0, 30)} · ${Math.max(0, Math.ceil((state.mflowWait.deadlineAt - now()) / 1000))}s  `, fg: "secondary" })
    // The built-in job count leads the row unless `/footer +jobs` places it among the segments.
    if (jobs && !segments.includes("jobs") && state.page !== "chat") counters.unshift({ text: `${jobs} job${jobs === 1 ? "" : "s"}${counters.length ? "  " : ""}`, fg: "secondary" })
    const shownModel = model ? `${modelLabel(model, state.modelReport)}${feed.fast ? ` ${fastMark(feed)}` : feed.fastIgnored ? ` ${fastMark(feed)} n/a` : ""}` : undefined
    const values = { mode: name.charAt(0).toUpperCase() + name.slice(1), model: shownModel, provider, reasoning: state.effectiveModel?.effort, variant: state.effectiveModel?.variant, permissionMode: PERMISSION_LABEL[state.transcript.permissionMode], commandsHint: "ctrl-p commands", agentsHint: "/agent", quota: quotaText({ quotas: [...quotas.values()], now: now(), view: state.tuiProfile.quotaView }) }
    const items = (order: string) => statusItems(order, state.tuiProfile.statusColors, Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)), state.tuiProfile.statusSeparator)
    const model_ = {
      ...(state.sessions.find((session) => session.sessionId === state.sessionId)?.lifecycle?.pr ? { pr: state.sessions.find((session) => session.sessionId === state.sessionId)!.lifecycle!.pr! } : {}),
      // With `footerRows` the first row is the left side whole (notice, goal and loops keep the right), and `statusRight` has no row to end.
      ...(rows ? { leftItems: rows[0] ?? [] } : state.tuiProfile.statusLeft ? { leftItems: items(state.tuiProfile.statusLeft) } : {}),
      ...(!rows && state.tuiProfile.statusRight ? { rightItems: items(state.tuiProfile.statusRight) } : {}),
      agentColor: agentColor(state.agentReport?.agents.find((agent) => agent.name === name)),
      ...(state.tuiProfile.showAgent ? { agent: name.charAt(0).toUpperCase() + name.slice(1) } : {}),
      // With the status line in the prompt border the row under it keeps telemetry only: model and effort are already above.
      ...(state.tuiProfile.showModel && shownModel && !statusInBorder() ? { model: shownModel } : {}),
      ...(state.tuiProfile.showProvider && provider && !statusInBorder() ? { provider } : {}),
      separator: state.tuiProfile.statusSeparator,
      counters,
      ...(state.tuiProfile.showEffort && state.effectiveModel?.effort && !statusInBorder() ? { effort: state.effectiveModel.effort } : {}),
      // A notice is not footer text: it shows in the notice slot over the prompt (app.ts).
      notice: "",
      connection: state.connection,
      ...(state.tuiProfile.showPermission ? { permission: state.transcript.permissionMode } : {}),
      permissionLabel: PERMISSION_LABEL[state.transcript.permissionMode],
      ...(profileName() !== DEFAULT_PROFILE ? { profile: profileName() } : {}),
      ...(state.transcript.goal && !state.shellMode ? { goal: goalSpans(state.transcript.goal, now(), g) } : {}),
      loops: state.liveLoops.size,
      workflows: { live: state.liveWorkflows.size, waiting: [...state.liveWorkflows.values()].filter(Boolean).length },
      shell: state.shellMode,
      ...(state.statusLine ? { scriptLeft: state.statusLine.left, scriptRight: state.statusLine.right } : {}),
      ...(state.statusLine?.leftRows?.length ? { scriptLeftRow: state.statusLine.leftRows[0] } : {}),
      ...(state.statusLine?.rightRows?.length ? { scriptRightRow: state.statusLine.rightRows[0] } : {}),
    }
    return { model: { ...model_, extraRows: [] } as FooterModel, slots, rows }
  }

  /** The first footer row, through the footer view slot. */
  function statusRow(width: number, provided?: ReturnType<typeof footerSlots>): Line {
    if (!state.tuiProfile.showStatus) return []
    const { model, slots } = footerModel(width, provided)
    return ctx.views.draw("footer", model, { width, height: 1, extra: { ...(slots ? { ext: slots } : {}) } }).lines[0] ?? []
  }

  /** Whether the prompt's top rule carries the status line (off in the minimal view and in shell mode). */
  const statusInBorder = () => state.tuiProfile.promptStatus === "border" && state.mode !== "minimal" && !state.shellMode && (state.ext?.promptChrome()?.preset ?? state.tuiProfile.promptChrome) !== "minimal"

  /** `READY › model › effort › repo › branch › ctx 42%` for the prompt's top rule, `room` cells wide; undefined when it is off. */
  function promptStatusLine(room: number): Line | undefined {
    if (!statusInBorder()) return undefined
    if (state.gitBranch === undefined && !state.branchRequested) {
      state.branchRequested = true
      void loadBranch()
    }
    const tokens = usageInForce(state)?.contextTokens
    const threshold = contextLimit(usageInForce(state), state.settingsNow.compactAtTokens ?? DEFAULT_COMPACT_AT_TOKENS)
    const model = sessionModelId(state.effectiveModel?.model, usageInForce(state)?.model, state.modelReport)
    const effort = state.effectiveModel?.effort
    const repo = input.directory ? input.directory.split(/[\\/]/).filter(Boolean).at(-1) : undefined
    return statusLineSpans({
      stateLabel: STATE_LABEL[state.transcript.foreground], state: state.transcript.foreground, glyphs: g,
      ...(model ? { model: modelLabel(model, state.modelReport) } : {}), ...(effort ? { effort } : {}), ...(repo ? { repo } : {}),
      ...(state.gitBranch ? { branch: state.gitBranch } : {}),
      ...(tokens !== undefined && threshold > 0 ? { contextPercent: Math.round(tokens / threshold * 100), ...(contextIsEngineWindow(usageInForce(state)) ? { contextLabel: "ctx" } : {}), ...(usageInForce(state)?.contextApprox ? { contextApprox: true } : {}) } : {}),
    }, room)
  }

  /** The session's model, context fill and cost, as a multiplexer's rail shows them beside the pane (`herdr.ts`). */
  function paneFacts(): { model?: string; contextPercent?: number; costMicros?: number } {
    const usage = usageInForce(state)
    const threshold = contextLimit(usage, state.settingsNow.compactAtTokens ?? DEFAULT_COMPACT_AT_TOKENS)
    const model = sessionModelId(state.effectiveModel?.model, usage?.model, state.modelReport)
    return {
      ...(model ? { model: modelLabel(model, state.modelReport) } : {}),
      ...(usage?.contextTokens !== undefined && threshold > 0 ? { contextPercent: Math.round(usage.contextTokens / threshold * 100) } : {}),
      ...(state.transcript.sessionCost ? { costMicros: state.transcript.sessionCost } : {}),
    }
  }

  /** The folder profile of this terminal's project, from the pushed settings. */
  function profileName() {
    return profileFor(input.directory, state.settingsNow.profiles, input.home)
  }

  function footer(width: number): Line {
    return statusRow(width)
  }

  function statusRows(width: number): Line[] {
    if (!state.tuiProfile.showStatus) return []
    const slots = state.shellMode ? undefined : footerSlots(width - META_MARGIN - PROMPT_MARGIN)
    const left = state.shellMode || slots?.replace ? [] : state.statusLine?.leftRows ?? []
    const right = state.shellMode || slots?.replace ? [] : state.statusLine?.rightRows ?? []
    const { model, rows } = footerModel(width, slots)
    // The rows of `footerRows` (none when an extension replaced the whole footer) and the extension rows beside them share the budget.
    const built = slots?.replace ? [] : rows ?? []
    const count = Math.min(footerRowBudget(input.screen.size.height), Math.max(1, left.length, right.length, (slots?.rows?.length ?? 0) + 1, built.length))
    const extraRows = Array.from({ length: count - 1 }, (_, index) => ({ scriptLeftRow: left[index + 1] ?? [], scriptRightRow: right[index + 1] ?? [] }))
    const rowExt = Array.from({ length: count - 1 }, (_, index) => {
      const ext = slots?.rows?.[index] ?? {}
      const mine = built[index + 1]
      if (!mine) return ext
      return { replace: [...mine, ...(ext.left ? [{ text: "  " }, ...ext.left] : []), ...(ext.right ? [{ text: "  " }, ...ext.right] : [])] }
    })
    return ctx.views.draw("footer", { ...model, extraRows }, { width, height: count, extra: { ...(slots ? { ext: slots } : {}), rows: rowExt } }).lines
  }

  // The full view turns every segment on except the stat parts added later, which stay opt-in (`/footer +ctx`).
  const FULL_FOOTER = FOOTER_SEGMENTS.filter((segment) => !FOOTER_OPT_IN.includes(segment))
  const footerSegments = (): readonly FooterSegment[] => state.customFooter ?? (state.mode === "full" ? FULL_FOOTER : DEFAULT_FOOTER)

  // ─── Sidebar layout ─────────────────────────────────────────────────────────────────────────────────────────────────

  const rightWanted = () => panelWanted(state) || fileInSlot(state)
  const sidebarShown = (width: number) => (!rightWanted() || width >= BREAKPOINTS.xl) && sidebarVisible({ mode: state.tuiProfile.sidebar, width, minimal: state.mode === "minimal" })

  /** Columns the chat (transcript, prompt, panels) is laid out in: the screen, less the sidebar when it shows. */
  function chatWidth() {
    const { width } = input.screen.size
    const bar = rightWanted() ? rightBarCells({ columns: width, setting: state.tuiProfile.sidebarWidth, collapsed: state.rightBarCollapsed }) : undefined
    if (bar) state.rightBarCollapsed = bar.collapsed
    const right = bar?.cells ? bar.cells + 1 : 0
    return (sidebarShown(width) ? chatColumns(width) : width) - right
  }

  /**
   * Cells the transcript leaves free at its right edge for the scrollbar: one while the bar is `auto` or `always` (hidden or not, so
   * showing and hiding it never reflows the text), none when it is `off` and in inline mode, which does not scroll.
   */
  const scrollbarGutter = () => (state.tuiProfile.scrollbar !== "off" && input.screen.inline !== true ? 1 : 0)

  /** Columns the transcript's text is laid out in: the chat column less the scrollbar's. Everything that measures transcript rows uses this. */
  const transcriptWidth = () => Math.max(1, chatWidth() - scrollbarGutter())

  const ensureBranch = () => {
    if ((footerSegments().includes("branch") || state.tuiProfile.footerRows.some((row) => row.includes("branch")) || state.tuiProfile.titleTemplate.includes("{branch}")) && state.gitBranch === undefined) void loadBranch()
  }

  return { sessionTitle, topbarRow, dockRows, sidebarRows, loadSidebarMcp, setSidebar, statusRow, statusRows, footer, footerSegments, sidebarShown, chatWidth, scrollbarGutter, transcriptWidth, ensureBranch, promptStatusLine, paneFacts }
}
