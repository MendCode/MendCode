import { agentColor } from "../../view/agent-color"
import { compactFallback } from "./compact-fallback"
import type { createSession } from "./session"
import type { createScratch } from "./scratch"
import type { createSecrets } from "./secrets"
import type { createAgents } from "./agents"
import { goalSpans } from "../../view/goal"
import { reviewActivityView } from "../lazy-pages"
import { BREAKPOINTS, breakpointOf } from "../breakpoints"
import { chatColumns, projectSessions, SETTLED_ROW, SIDEBAR_WIDTH, sidebarVisible } from "../../view/sidebar"
import { SPINNER_FRAMES } from "../../view/tool-card"
import { DEFAULT_FOOTER, DEFAULT_AREA, FOOTER_SEGMENT_TIER, featureOn, areaFor, tierFooter, type FooterSegment } from "@mendcode/protocol/wire"
import { contextIsEngineWindow, contextLimit } from "../../view/context-meter"
import type { McpStatusReport } from "@mendcode/protocol"
import { fastMark, footerParts, quotaText, type FooterInput } from "../../view/footer"
import { externalEngine, fastApplies } from "../../view/fast-mode"
import { footerQuotaStyle, footerRowBudget, footerRowsOf, renderFooterRows, rowsWithContent } from "../../view/footer-rows"
import { footerPackNamed, packPlaces, renderFooterPack, type PackFacts, type PackGlyphs } from "../../view/footer-pack"
import type { FooterPackFile } from "@mendcode/protocol/wire"
import { partsLine } from "../../view/stat-parts"
import { statusLineSpans } from "../../view/status-line"
import { modelLabel, modelWithEffort, servedByProvider, sessionModelId } from "../../view/model-label"
import { planModelId } from "../../view/plan-mode-notice"
import { rightBarCells } from "../../view/right-bar"
import { maskSecretMarkers } from "../../view/secret-markers"
import { topbarAnimates, topbarContextArea } from "../../view/topbar"
import { renderDock, DOCK_BODY_ROWS, type DockJob } from "../../view/dock"
import { latestTodos } from "../../view/plan-row"
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

/** The shortest terminal that gives the full view's footer its second row (docs/layout.md "Footer by tier"). */
const DETAIL_ROW_MIN_HEIGHT = 24

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
  /** Children waiting for approval whose card is not in the open session: the footer says so and `/approvals` goes there. */
  const childrenWaitingElsewhere = () => [...state.childWaiting].reduce((sum, [launcher, waiting]) => sum + (launcher === state.sessionId ? 0 : waiting.total), 0)
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
      ...(input.dev ? { dev: true } : {}),
      ...(state.tuiProfile.showDiffFiles && state.diffTotals ? { files: state.changedFiles.length } : {}),
      ...(input.home ? { home: input.home } : {}),
      ...(state.tuiProfile.showProject && state.gitBranch ? { branch: state.gitBranch } : {}),
      title: state.tuiProfile.showSessionTitle ? title : "",
      ...(state.tuiProfile.showDiffLines && state.diffTotals ? { diff: state.diffTotals } : {}),
      ...(state.tuiProfile.showContext && context !== undefined ? { context: { tokens: context, limit: contextLimit(usageInForce(state), compactFallback(state)), ...(usageInForce(state)?.contextApprox ? { approx: true } : {}) } } : {}),
      ...(topbarStats.length ? { stats: topbarStats } : {}),
      contextHover: state.contextHover === true,
      contextStyle: state.tuiProfile.contextStyle,
      // A sub-agent's view names its keys in its own context line (agent-cue.ts), top bar or none.
      ...(!state.reducedMotion && topbarAnimates({ width: room, title }) ? { tick: state.topbarTick } : {}),
    }
    const area = topbarContextArea({ ...bar, width: room })
    state.contextArea = area ? { from: area.from + PROMPT_MARGIN, to: area.to + PROMPT_MARGIN } : undefined
    const rendered = ctx.views.draw("topbar", bar, { width: room, height: 1 }).lines[0] ?? []
    return [{ text: " ".repeat(PROMPT_MARGIN) }, ...rendered]
  }

  /** The session's current list (`latestTodos`): the dock and the sidebar show it. */
  const currentTodos = () => latestTodos(state.transcript.blocks())

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
    const percent = usage?.contextTokens !== undefined ? Math.round((usage.contextTokens / contextLimit(usage, compactFallback(state))) * 100) : undefined
    const model = sessionModelId(state.effectiveModel?.model, usage?.model, state.modelReport)
    ensureScratch()
    const rows = renderDock({
      width: width - PROMPT_MARGIN * 2,
      todos: currentTodos(),
      questions: state.transcript.pendingRequests.map((request) => ({ kind: request.kind, title: maskSecretMarkers(request.title, secretTail) })),
      showJobs: state.tuiProfile.dockJobs,
      jobs: state.tuiProfile.dockJobs ? dockJobs() : [],
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
    const sessions = projectSessions(state.sessions, input.directory ?? "").map(({ sessionId, title, state: sessionState, queued, updatedAt, archivedAt, lifecycle, draft, parentId, tool, paused }) => ({ sessionId, title, state: sessionState, queued, updatedAt, ...(archivedAt !== undefined ? { archivedAt } : {}), ...(lifecycle ? { lifecycle } : {}), ...(draft ? { draft } : {}), ...(parentId ? { parentId } : {}), ...(tool ? { tool } : {}), ...(paused ? { paused } : {}) }))
    const drawn = ctx.views.draw("sessions.sidebar", { sessions, current: state.sessionId, ...(state.sidebarSelected ? { selected: state.sidebarSelected } : {}), focused: state.sidebarFocus === true, unread: unreadSessions(sessions), ...sidebarMotion(), ...(state.sidebarSettledOpen ? { settledOpen: true } : {}) }, { width: SIDEBAR_WIDTH, height, extra: { header: state.tuiProfile.sidebarHeader } })
    state.sidebarHits = drawn.hits.flatMap((hit) => hit.action === "toggle" ? [{ row: hit.row, sessionId: SETTLED_ROW }] : hit.action === "open" && typeof hit.arg === "string" ? [{ row: hit.row, sessionId: hit.arg }] : [])
    return drawn.lines
  }

  /**
   * Sessions with a reply finished since this terminal last showed them. A session is seen when the list first draws it and
   * whenever it is the open one; nothing is written anywhere, so a fresh start has nothing unread.
   */
  function unreadSessions(sessions: ReadonlyArray<{ sessionId: string; updatedAt: number; state: string }>): string[] {
    const seen = (state.sidebarSeen ??= new Map())
    const unread: string[] = []
    for (const session of sessions) {
      if (session.sessionId === state.sessionId || !seen.has(session.sessionId)) seen.set(session.sessionId, session.updatedAt)
      else if (session.updatedAt > seen.get(session.sessionId)! && session.state === "idle") unread.push(session.sessionId)
    }
    return unread
  }

  /** The activity tick's frame and blink, only while that tick already runs (a busy turn or a busy row in this list). */
  function sidebarMotion(): { spinner?: string; blink?: boolean } {
    if (!state.pulse || state.reducedMotion) return {}
    return { spinner: SPINNER_FRAMES[state.spinFrame % SPINNER_FRAMES.length]!, blink: state.pulseOn }
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

  /** The rows the footer draws now: the user's, else the `rows` preset in the full view while nothing was chosen (footer-rows.ts `footerRowsOf`). */
  const rowsNow = () => footerRowsOf({ mode: state.mode, profile: state.tuiProfile, list: state.customFooter })
  const rowsOn = () => rowsNow().rows.length > 0

  /**
   * The `/footer` list, or undefined while the view's tier places the segments. A saved list equal to the old default (what `/footer
   * reset` used to write) means the default too, so it follows the tier.
   */
  function customFooter(): readonly FooterSegment[] | undefined {
    const list = state.customFooter
    return list && !(list.length === DEFAULT_FOOTER.length && list.every((segment, at) => segment === DEFAULT_FOOTER[at])) ? list : undefined
  }

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
    const graphShown = segments.includes("codegraph") || rowsNow().rows.some((row) => row.includes("codegraph"))
    // The saved tokens cost a `session.savings` request per model call: only a graph the user placed asks it, never the full view's own (nor its default rows').
    const graphPlaced = customFooter()?.includes("codegraph") || profile.footerRows.some((row) => row.includes("codegraph"))
    const savedTokens = graphPlaced ? footerSaved() : undefined
    const counts = graphShown && input.directory ? codegraph.get(input.directory) : undefined
    return {
      ...(directory ? { directory } : {}),
      codegraph: { on: featureOn(state.settingsNow, "codegraph"), ...(savedTokens ? { savedTokens } : {}), ...(counts?.state === "skipped" ? { skipped: counts.reason ?? "off" } : counts ? { index: { state: counts.state === "indexing" ? "indexing" as const : "indexed" as const, files: counts.files, symbols: counts.symbols, edges: counts.edges, ...(counts.percent !== undefined ? { percent: counts.percent } : {}) } } : {}) },
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
    const threshold = contextLimit(usage, compactFallback(state))
    const { rows, builtIn } = rowsNow()
    const rowInput: FooterInput = {
        ...feed,
        ...(builtIn && state.accessible ? { plainQuota: true } : {}),
        stateLabel: STATE_LABEL[state.transcript.foreground], dotOn: true,
        connection: state.connection,
        permission: state.transcript.permissionMode, permissionLabel: PERMISSION_LABEL[state.transcript.permissionMode], showPermission: state.tuiProfile.showPermission,
        ...(id ? { model: modelLabel(id, state.modelReport) } : {}),
        ...(usage?.contextTokens !== undefined && threshold > 0 ? { context: { tokens: usage.contextTokens, threshold } } : {}),
        ...(state.gitBranch ? { branch: state.gitBranch } : {}),
        ...(state.transcript.goal ? { goal: state.transcript.goal } : {}),
        // Adaptive reasoning applies to the daemon's own generations only (docs/reasoning.md): a Claude Code, Codex or pi model keeps its own level, unmarked.
        ...(featureOn(state.settingsNow, "jev") && !externalEngine(state.effectiveModel?.model ?? id, state.modelReport) ? { adaptive: true } : {}),
    }
    // The built-in default hides the rows with nothing to say (a provider nobody uses here, a graph not counted yet), so the height
    // budget, which cuts from the bottom, is spent on rows that show something.
    // The first call of every session is cold: its cache share would only read `cache 0%`, so the default waits for the second call.
    const shown = builtIn ? rowsWithContent({ input: rowInput, rows: rows.map((row) => state.transcript.sessionUsage.calls < 2 ? row.filter((entry) => entry !== "cache") : row) }) : rows
    return renderFooterRows({ input: rowInput, rows: shown, limit: footerRowBudget(input.screen.size.height) })
  }

  /** What the footer slot shows (docs/views.md): everything the first row is built from, as plain data. */
  function footerModel(width: number, provided?: ReturnType<typeof footerSlots>, detailRow = false): { model: FooterModel; slots: ReturnType<typeof footerSlots>; rows: Line[] | undefined } {
    // In plan mode the footer names the model that plans (the `plan` role), not the one that builds.
    const model = (state.transcript.permissionMode === "plan" ? planModelId(state.modelReport, state.effectiveModel?.model) : undefined) ?? sessionModelId(state.effectiveModel?.model, usageInForce(state)?.model, state.modelReport)
    const slots = state.shellMode ? undefined : provided ?? footerSlots(width - META_MARGIN - PROMPT_MARGIN)
    const name = state.transcript.permissionMode === "plan" ? "plan" : state.agentReport?.current ?? "build"
    // The model's own provider, else the engine that runs it (a Claude Code model is not served by the native engine the daemon started with).
    const provider = servedByProvider(state.effectiveModel?.model ?? model, state.modelReport) ?? usageInForce(state)?.provider
    // This session's background work; the row over the prompt names it, so the built-in count is not repeated (`/footer +jobs` still places it).
    const jobs = state.agentShells.filter((shell) => shell.status === "running" && shell.sessionId === state.sessionId).length
    // Without a `/footer` list the view's tier places the segments (FOOTER_SEGMENT_TIER); quota and today are the profile's own opt-ins.
    const custom = customFooter()
    const placed = custom ?? tierPlaced()
    // The full view's own segments wait until they say something: the code graph for what the daemon pushed about this folder (before
    // that it would only say `graph on`), the cache share for a second call (the first call of every session is cold: `cache 0%`).
    const waiting = (segment: FooterSegment) => !custom && ((segment === "codegraph" && !(input.directory !== undefined && codegraph.has(input.directory))) || (segment === "cache" && state.transcript.sessionUsage.calls < 2))
    const chosen = [...new Set(placed)].filter((segment) => FOOTER_SEGMENT_TIER[segment] !== "row" && FOOTER_SEGMENT_TIER[segment] !== "elsewhere" && !waiting(segment))
    // The forecast follows the tier (balanced and up; `/tier forecast off` removes it); `/footer` placing it is an explicit choice that stays even in minimalist.
    const forecastOn = custom ? chosen.includes("forecast") && state.settingsNow.features?.forecast !== false : featureOn(state.settingsNow, "forecast")
    const segments = forecastOn ? [...new Set<FooterSegment>([...chosen, "forecast"])] : chosen.filter((segment) => segment !== "forecast")
    // Reasoning effort is drawn beside the model: the profile's `showEffort` (on by default and by `/tier balanced|full`), or a `/footer` list that places it.
    const effortShown = (state.tuiProfile.showEffort || custom?.includes("effort") === true) && !statusInBorder()
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
      quotas: [...quotas.values()], quotaStyle: footerQuotaStyle({ profile: state.tuiProfile, builtIn: rowsNow().builtIn }), now: now(), notice: "",
      usage: state.transcript.sessionUsage, jobs, sandbox, calls: state.transcript.recentCalls,
      stats: ctx.stats.read(),
      ...(state.transcript.sessionCost !== undefined ? { spentMicros: state.transcript.sessionCost } : {}),
      ...(state.effectiveModel?.effort ? { effort: state.effectiveModel.effort } : {}),
      // Priority processing is a setting of the daemon's own providers: the mark shows when this model is served by one, and says `n/a` when it is not.
      ...((state.modelReport?.session?.fast ?? state.settingsNow.serviceTier === "fast") ? (fastApplies(state.effectiveModel?.model ?? model, state.modelReport) ? { fast: true } : { fastIgnored: true }) : {}),
      ...(state.tuiProfile.vimMode ? { vim: ctx.vim.label } : {}),      ...(update ? { update } : {}),
      ...(state.todayUsage ? { today: state.todayUsage } : {}),
      ...(warm ? { warm } : {}),
      ...(custom && state.gitBranch ? { branch: state.gitBranch } : {}),
      ...footerExtras(segments),
    }
    // `footerRows`: the whole footer is the rows, so the single row's segments are not built.
    const rows = rowsOn() && !state.shellMode ? footerRowLines(feed) : undefined
    // The full view's own segments get a second row when the caller has one to give; otherwise every segment shares the first.
    const inDetail = (segment: FooterSegment) => detailRow && state.mode === "full" && FOOTER_SEGMENT_TIER[segment] === "full"
    const rowSegments = rows ? [] : segments.filter((segment) => !inDetail(segment))
    // A screen reader gets the quota windows without their bars (their compact form): figures, not block characters.
    const parts = (ids: readonly FooterSegment[]) => footerParts(feed, ids).map(({ compact, ...part }) => state.accessible && compact && part.id === "quota" ? { ...part, spans: compact } : { ...part, ...(compact ? { compact } : {}) })
    const detail = rows ? [] : parts(segments.filter(inDetail))
    const counters: Line = []
    if (state.tuiProfile.showCommandHint) counters.push({ text: "  ctrl-p commands", fg: "muted" })
    if (state.tuiProfile.showAgentHint) counters.push({ text: "  /agents", fg: "muted" })
    if (state.mflowWait) counters.unshift({ text: `Mflow ${state.mflowWait.file.slice(0, 30)} · ${Math.max(0, Math.ceil((state.mflowWait.deadlineAt - now()) / 1000))}s  `, fg: "secondary" })
    // The built-in job count leads the row unless `/footer +jobs` places it among the segments.
    if (jobs && !segments.includes("jobs") && state.page !== "chat") counters.unshift({ text: `${jobs} job${jobs === 1 ? "" : "s"}${counters.length ? "  " : ""}`, fg: "secondary" })
    const shownModel = model ? `${modelLabel(model, state.modelReport)}${feed.fast ? ` ${fastMark(feed)}` : feed.fastIgnored ? ` ${fastMark(feed)} n/a` : ""}` : undefined
    const values = { mode: name.charAt(0).toUpperCase() + name.slice(1), model: shownModel, provider, reasoning: state.effectiveModel?.effort, variant: state.effectiveModel?.variant, permissionMode: PERMISSION_LABEL[state.transcript.permissionMode], commandsHint: "ctrl-p commands", agentsHint: "/agent", quota: quotaText({ quotas: [...quotas.values()], now: now(), view: state.tuiProfile.quotaView }) }
    // Plan mode is named once: a template that places `mode` (which reads `Plan`) does not also repeat `plan mode`.
    const items = (order: string) => statusItems(order, state.tuiProfile.statusColors, Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== undefined && !(key === "permissionMode" && state.transcript.permissionMode === "plan" && order.split(",").some((entry) => entry.trim() === "mode")))), state.tuiProfile.statusSeparator)
    const model_ = {
      ...(state.sessions.find((session) => session.sessionId === state.sessionId)?.lifecycle?.pr ? { pr: state.sessions.find((session) => session.sessionId === state.sessionId)!.lifecycle!.pr! } : {}),
      // With `footerRows` the first row is the left side whole (notice, goal and loops keep the right), and `statusRight` has no row to end.
      ...(rows ? { leftItems: rows[0] ?? [] } : state.tuiProfile.statusLeft ? { leftItems: items(state.tuiProfile.statusLeft) } : {}),
      ...(!rows && state.tuiProfile.statusRight ? { rightItems: items(state.tuiProfile.statusRight) } : {}),
      agentColor: agentColor(state.agentReport?.agents.find((agent) => agent.name === name)),
      ...(state.tuiProfile.showAgent ? { agent: name.charAt(0).toUpperCase() + name.slice(1) } : {}),
      // With the status line in the prompt border the row under it keeps telemetry only: model and effort are already above.
      ...(state.tuiProfile.showModel && model && !statusInBorder() ? { model: modelLabel(model, state.modelReport) } : {}),
      ...(state.tuiProfile.showModel && model && !statusInBorder() && (feed.fast || feed.fastIgnored) ? { fast: { mark: fastMark(feed), applies: feed.fast === true } } : {}),
      ...(state.tuiProfile.showProvider && provider && !statusInBorder() ? { provider } : {}),
      separator: state.tuiProfile.statusSeparator,
      counters,
      segments: parts(rowSegments),
      ...(detail.length ? { detail } : {}),
      // One kind of separator for a screen reader; ASCII chrome has no box line.
      divider: state.accessible ? state.tuiProfile.statusSeparator : asciiMarks() ? " | " : ` ${g.track} `,
      // Words without marks for a screen reader, and where ASCII would turn `↻` into `@`.
      ...(state.accessible || asciiMarks() ? { plainMarks: true } : {}),
      ...(effortShown && state.effectiveModel?.effort ? { effort: state.effectiveModel.effort } : {}),
      // A notice is not footer text: it shows in the notice slot over the prompt (app.ts).
      notice: "",
      connection: state.connection,
      ...(state.tuiProfile.showPermission ? { permission: state.transcript.permissionMode } : {}),
      permissionLabel: PERMISSION_LABEL[state.transcript.permissionMode],
      ...(areaName() !== DEFAULT_AREA ? { area: areaName() } : {}),
      ...(state.transcript.goal && !state.shellMode ? { goal: goalSpans(state.transcript.goal, now(), g) } : {}),
      loops: state.liveLoops.size,
      ...(state.loops.some((loop) => loop.state === "needs_input" && state.liveLoops.has(loop.loopId)) ? { loopsWaiting: state.loops.filter((loop) => loop.state === "needs_input" && state.liveLoops.has(loop.loopId)).length } : {}),
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
    const packed = packFooter(width, state.shellMode ? undefined : provided ?? footerSlots(width - META_MARGIN - PROMPT_MARGIN))
    if (packed) return packed.rows[0] ?? []
    const { model, slots } = footerModel(width, provided)
    return ctx.views.draw("footer", model, { width, height: 1, extra: { ...(slots ? { ext: slots } : {}) } }).lines[0] ?? []
  }

  /** Whether the prompt's top rule carries the status line (off in the minimal view and in shell mode). */
  const statusInBorder = () => state.tuiProfile.promptStatus === "border" && state.mode !== "minimal" && !state.shellMode && (state.ext?.promptChrome()?.preset ?? state.tuiProfile.promptChrome) !== "minimal"

  /** `READY › model › effort › repo › branch › ctx 42%` for the prompt's top rule, `room` cells wide; undefined when it is off. */
  function promptStatusLine(room: number, activity?: Line): Line | undefined {
    if (!statusInBorder()) return undefined
    if (state.gitBranch === undefined && !state.branchRequested) {
      state.branchRequested = true
      void loadBranch()
    }
    const tokens = usageInForce(state)?.contextTokens
    const threshold = contextLimit(usageInForce(state), compactFallback(state))
    const model = sessionModelId(state.effectiveModel?.model, usageInForce(state)?.model, state.modelReport)
    const effort = state.effectiveModel?.effort
    const repo = input.directory ? input.directory.split(/[\\/]/).filter(Boolean).at(-1) : undefined
    return statusLineSpans({
      stateLabel: STATE_LABEL[state.transcript.foreground], state: state.transcript.foreground, glyphs: g,
      ...(activity?.length ? { activity } : {}),
      ...(model ? { model: modelLabel(model, state.modelReport) } : {}), ...(effort ? { effort } : {}), ...(repo ? { repo } : {}),
      ...(state.gitBranch ? { branch: state.gitBranch } : {}),
      ...(tokens !== undefined && threshold > 0 ? { contextPercent: Math.round(tokens / threshold * 100), ...(contextIsEngineWindow(usageInForce(state)) ? { contextLabel: "ctx" } : {}), ...(usageInForce(state)?.contextApprox ? { contextApprox: true } : {}) } : {}),
    }, room)
  }

  /** The session's model, context fill and cost, as a multiplexer's rail shows them beside the pane (`herdr.ts`). */
  function paneFacts(): { model?: string; contextPercent?: number; costMicros?: number } {
    const usage = usageInForce(state)
    const threshold = contextLimit(usage, compactFallback(state))
    const model = sessionModelId(state.effectiveModel?.model, usage?.model, state.modelReport)
    return {
      ...(model ? { model: modelLabel(model, state.modelReport) } : {}),
      ...(usage?.contextTokens !== undefined && threshold > 0 ? { contextPercent: Math.round(usage.contextTokens / threshold * 100) } : {}),
      ...(state.transcript.sessionCost ? { costMicros: state.transcript.sessionCost } : {}),
    }
  }

  /** The area of this terminal's project, from the pushed settings. */
  function areaName() {
    return areaFor(input.directory, state.settingsNow.areas, input.home)
  }

  function footer(width: number): Line {
    return statusRow(width)
  }

  // ─── Footer packs (docs/customize.md "Footer packs") ────────────────────────────────────────────────────────────────

  /**
   * Whether the footer is one the user made: rows (their own or a preset's), `/footer preset classic`, a `/footer` list, a `statusLeft`
   * or `statusRight` template, a status line script, an extension's footer slot or a footer view. A pack never draws over it.
   */
  function ownFooter(slots: ReturnType<typeof footerSlots>): boolean {
    const profile = state.tuiProfile
    // The quota and today opt-ins are off by default: turning one on is the user shaping the built-in footer.
    return profile.footerRows.length > 0 || !profile.footerDefaultRows || customFooter() !== undefined || profile.statusLeft !== "" || profile.statusRight !== "" || profile.footerQuota || profile.footerToday
      || !!(state.statusLine && (state.statusLine.left.length || state.statusLine.right.length || state.statusLine.leftRows?.length || state.statusLine.rightRows?.length))
      || !!(slots && (slots.left?.length || slots.right?.length || slots.replace || slots.rows?.length)) || ctx.views.hasCustom("footer")
  }

  /**
   * What says a turn ended in this folder and session: the changes are asked again after every turn (changes.ts `loadDiffTotals`), so
   * their object is a new one each time. What a pack reads from git is asked once per mark, never per frame or on a timer.
   */
  const turnMark = () => ({ where: `${input.directory}:${state.sessionId}`, totals: state.diffTotals })
  const sameMark = (a: ReturnType<typeof turnMark> | undefined, b: ReturnType<typeof turnMark>) => a !== undefined && a.where === b.where && a.totals === b.totals
  /** A pack asks git nothing before the settings arrive (`ensureBranch`): a render before them sends no command, like the built-in footer. */
  let packGitAllowed = false

  /** git's state for a pack that shows it (`git`): asked at start and after each turn while such a pack is in force. */
  let packGit: { mark: ReturnType<typeof turnMark>; value?: NonNullable<PackFacts["git"]> } | undefined
  function packGitState(): PackFacts["git"] {
    const mark = turnMark()
    if (!packGitAllowed || sameMark(packGit?.mark, mark) || !input.directory) return packGit?.value
    const entry: { mark: ReturnType<typeof turnMark>; value?: NonNullable<PackFacts["git"]> } = { mark, ...(packGit?.value ? { value: packGit.value } : {}) }
    packGit = entry
    void input.send({ type: "git.status", directory: input.directory }).then((reply) => {
      if (!reply.ok || packGit !== entry) return
      const found = (reply.result ?? {}) as Record<string, unknown>
      const count = (name: string) => (typeof found[name] === "number" ? found[name] as number : 0)
      entry.value = { staged: count("staged"), unstaged: count("unstaged"), untracked: count("untracked"), conflicts: count("conflicts"), ...(typeof found.ahead === "number" ? { ahead: found.ahead } : {}), ...(typeof found.behind === "number" ? { behind: found.behind } : {}) }
      requestFrame()
    })
    return entry.value
  }

  /**
   * The branch for a pack that shows it: asked once, as the top bar asks it (no request when the top bar already did); a pack with
   * git's state asks it again after each turn with that state, since a turn may switch it.
   */
  let packBranchMark: ReturnType<typeof turnMark> | undefined
  function packBranch(pack: FooterPackFile) {
    if (!packGitAllowed) return
    const status = packPlaces(pack, "git")
    if (!status && !packPlaces(pack, "branch")) return
    if (!status) {
      if (state.gitBranch !== undefined || state.branchRequested) return
    } else {
      const mark = turnMark()
      if (sameMark(packBranchMark, mark)) return
      packBranchMark = mark
    }
    state.branchRequested = true
    void loadBranch()
  }

  /** The glyph set the pack is drawn with: words only for `footerPackSymbols: text` and a screen reader, ASCII on ASCII chrome. */
  const packGlyphs = (): PackGlyphs => (state.tuiProfile.accessible || state.accessible || state.tuiProfile.footerPackSymbols === "text" ? "text" : asciiMarks() ? "ascii" : state.glyphMode)

  /** What the pack can say this frame. With the status line in the prompt's border, what it already says (folder, branch, model, effort, context) is left out. */
  function packFacts(pack: FooterPackFile): PackFacts {
    const usage = usageInForce(state)
    const border = statusInBorder()
    const id = (state.transcript.permissionMode === "plan" ? planModelId(state.modelReport, state.effectiveModel?.model) : undefined) ?? sessionModelId(state.effectiveModel?.model, usage?.model, state.modelReport)
    const threshold = contextLimit(usage, compactFallback(state))
    const name = state.transcript.permissionMode === "plan" ? "plan" : state.agentReport?.current ?? "build"
    const profile = state.tuiProfile
    const directory = input.home && input.directory?.startsWith(input.home) ? `~${input.directory.slice(input.home.length)}` : input.directory
    const fastOn = state.modelReport?.session?.fast ?? state.settingsNow.serviceTier === "fast"
    const hints: Line = []
    if (profile.showCommandHint) hints.push({ text: "ctrl-p commands", fg: "muted" })
    if (profile.showAgentHint) hints.push(...(hints.length ? [{ text: "  " }] : []), { text: "/agents", fg: "muted" })
    if (state.mflowWait) hints.unshift({ text: `Mflow ${state.mflowWait.file.slice(0, 30)} · ${Math.max(0, Math.ceil((state.mflowWait.deadlineAt - now()) / 1000))}s`, fg: "secondary" }, ...(hints.length ? [{ text: "  " }] : []))
    const loopsWaiting = state.loops.filter((loop) => loop.state === "needs_input" && state.liveLoops.has(loop.loopId)).length
    const flowsWaiting = [...state.liveWorkflows.values()].filter(Boolean).length
    if (!border) packBranch(pack)
    return {
      now: now(),
      ...(!border && areaName() !== DEFAULT_AREA ? { area: areaName() } : {}),
      ...(!border && directory ? { directory } : {}),
      ...(!border && state.gitBranch ? { branch: state.gitBranch } : {}),
      ...(!border && packPlaces(pack, "git") ? (() => { const git = packGitState(); return git ? { git } : {} })() : {}),
      ...(state.diffTotals ? { diff: state.diffTotals } : {}),
      ...(!border && profile.showModel && id ? { model: modelLabel(id, state.modelReport) } : {}),
      ...(!border && profile.showModel && id && fastOn ? { fast: { mark: fastMark(profile.footerIcons === "none" ? {} : { icons: { mode: profile.footerIcons, ...(packGlyphs() === "ascii" || packGlyphs() === "text" ? { ascii: true } : {}) } }), applies: fastApplies(state.effectiveModel?.model ?? id, state.modelReport) } } : {}),
      ...(!border && profile.showEffort && state.effectiveModel?.effort ? { effort: state.effectiveModel.effort } : {}),
      ...(featureOn(state.settingsNow, "jev") && !externalEngine(state.effectiveModel?.model ?? id, state.modelReport) ? { adaptive: true } : {}),
      ...(!border && usage?.contextTokens !== undefined && threshold > 0 ? { context: { tokens: usage.contextTokens, limit: threshold, ...(usage.contextApprox ? { approx: true } : {}) } } : {}),
      quotas: [...quotas.values()],
      ...((reviewing) => (reviewing ? { reviewing } : {}))(state.reviewActivity.length ? reviewActivityView()?.reviewFooterWord(state.reviewActivity, state.sessionId, state.transcript.activeTurn !== undefined) : undefined),
      ...(state.transcript.sessionCost !== undefined ? { costMicros: state.transcript.sessionCost } : {}),
      jobs: state.agentShells.filter((shell) => shell.status === "running" && shell.sessionId === state.sessionId).length,
      loops: state.liveLoops.size,
      workflows: state.liveWorkflows.size,
      agents: state.liveTasks?.filter((task) => task.parentId === state.sessionId && task.state === "running").length ?? 0,
      waiting: loopsWaiting + flowsWaiting + childrenWaitingElsewhere(),
      ...(childrenWaitingElsewhere() ? { childApprovals: childrenWaitingElsewhere() } : {}),
      ...(state.transcript.goal ? { goal: goalSpans(state.transcript.goal, now(), g) } : {}),
      ...(profile.showAgent ? { mode: name.charAt(0).toUpperCase() + name.slice(1), modeColor: agentColor(state.agentReport?.agents.find((agent) => agent.name === name)) } : {}),
      ...(profile.showPermission ? { permission: state.transcript.permissionMode, permissionLabel: PERMISSION_LABEL[state.transcript.permissionMode] } : {}),
      connection: state.connection,
      ...(hints.length ? { hints } : {}),
    }
  }

  /**
   * The pack's rows, when a pack draws: the footer is not the user's own (or `footerPackStack` stacks the pack above it), the prompt is
   * not in shell mode, and `footerPack` is not `off`. `stack` says the user's footer follows.
   */
  function packFooter(width: number, slots: ReturnType<typeof footerSlots>): { rows: Line[]; stack: boolean } | undefined {
    if (state.shellMode) return undefined
    const pack = footerPackNamed(state.tuiProfile.footerPack)
    if (!pack) return undefined
    const own = ownFooter(slots)
    if (own && !state.tuiProfile.footerPackStack) return undefined
    // The footer slot's built-in look: a custom `footer` view counts as the user's own footer (`ownFooter`), so it replaces the pack.
    return { rows: renderFooterPack({ pack, facts: packFacts(pack), width, glyphs: packGlyphs(), limit: footerRowBudget(input.screen.size.height) }), stack: own }
  }

  function statusRows(width: number): Line[] {
    if (!state.tuiProfile.showStatus) return []
    const slots = state.shellMode ? undefined : footerSlots(width - META_MARGIN - PROMPT_MARGIN)
    const packed = packFooter(width, slots)
    if (packed && !packed.stack) return packed.rows
    const own = builtinStatusRows(width, slots)
    return packed ? [...packed.rows, ...own].slice(0, Math.max(packed.rows.length + 1, footerRowBudget(input.screen.size.height))) : own
  }

  function builtinStatusRows(width: number, slots: ReturnType<typeof footerSlots>): Line[] {
    const left = state.shellMode || slots?.replace ? [] : state.statusLine?.leftRows ?? []
    const right = state.shellMode || slots?.replace ? [] : state.statusLine?.rightRows ?? []
    // The full view's second row takes the place no script, extension or `footerRows` row needs, and only on a terminal of at least the
    // classic 24 rows: on a shorter one the row is worth more to the transcript and the panel sheet than to telemetry.
    const detailRow = !state.shellMode && !slots?.replace && !slots?.rows?.length && left.length <= 1 && right.length <= 1 && !rowsOn() && input.screen.size.height >= DETAIL_ROW_MIN_HEIGHT
    const { model, rows } = footerModel(width, slots, detailRow)
    if (model.detail?.length) return ctx.views.draw("footer", model, { width, height: 2, extra: { ...(slots ? { ext: slots } : {}) } }).lines
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

  /** The list `/footer` edits and shows: the saved one, else the segments the view's tier places with the profile's quota and today. */
  const footerSegments = (): readonly FooterSegment[] => customFooter() ?? tierPlaced()
  function tierPlaced(): FooterSegment[] {
    return [...new Set<FooterSegment>([...tierFooter(state.mode), ...(state.tuiProfile.footerQuota ? ["quota"] as const : []), ...(state.tuiProfile.footerToday ? ["today"] as const : [])])]
  }

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
    packGitAllowed = true
    if ((footerSegments().includes("branch") || state.tuiProfile.footerRows.some((row) => row.includes("branch")) || state.tuiProfile.titleTemplate.includes("{branch}")) && state.gitBranch === undefined) void loadBranch()
  }

  /** Whether the footer on screen is one the user made, so a pack stands aside (`/footer pack` says so). */
  const footerIsOwn = () => ownFooter(state.shellMode ? undefined : footerSlots(input.screen.size.width - META_MARGIN - PROMPT_MARGIN))

  return { sessionTitle, topbarRow, dockRows, sidebarRows, loadSidebarMcp, setSidebar, statusRow, statusRows, footer, footerSegments, footerIsOwn, sidebarShown, chatWidth, scrollbarGutter, transcriptWidth, ensureBranch, promptStatusLine, paneFacts }
}
