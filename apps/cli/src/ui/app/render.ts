import { psCard } from "../../view/ps-card"
import { inProject } from "../../view/project-scope"
import { renderEnvironmentPage } from "../../view/environment-page"
import { renderIntroPage, renderOnboardingPage } from "../lazy-pages"
import { listedBuiltins, slashCatalog } from "../../view/commands"
import { modelLabel, sessionModelId } from "../../view/model-label"
import { renderConsolePage, renderSharePage } from "../lazy-pages"
import { renderMflowPage } from "../lazy-pages"
import { renderKeymapPage, keymapRows, renderTerminalSetupPage, renderTutorialPage } from "../lazy-pages"
import type { createDiagram } from "./diagram"
import type { createSetup } from "./setup"
import type { createMemory } from "./memory"
import type { createSecrets } from "./secrets"
import type { createAgents } from "./agents"
import type { createStatus } from "./status"
import { renderMessageActions, renderExportOptions } from "../lazy-pages"
import { renderTreePage, renderTextPage, renderCompactionPage, renderPromptModePage, renderStashPage, renderDraftsPage, renderHistoryPage, renderSkillsPage, renderModelPicker, renderVariantPicker } from "../lazy-pages"
import { renderDiagnosticsPage, renderQueuePage } from "../lazy-pages"
import { renderIdePage } from "../lazy-pages"
import { renderWorktreesPage } from "../lazy-pages"
import { gitTabsRow, renderGitCommitPage, renderGitInitPage, renderGitPrPage } from "../lazy-pages"
import { renderCompoundPage } from "../lazy-pages"
import { renderAIConfigPage } from "../lazy-pages"
import { renderReasoningPage } from "../lazy-pages"
import { renderReleasePage } from "../lazy-pages"
import { renderTsmPage } from "../lazy-pages"
import { renderInfoCard, renderRewindCard } from "../../view/rewind-card"
import { goalPromptCard } from "../../view/goal"
import { returnPromptCard } from "../../view/return-card"
import { fit } from "../../view/deck"
import { paneChildren } from "./session-children"
import { attachSidebar } from "../../view/sidebar"
import { renderAcpPage, renderAgentPicker, renderThemePicker, themeEntries, filterPalette, composeOverlay, renderToolsPage, renderChangesPage, renderContextPage, renderLoopsPage, renderMcpsPage, renderTasksPage, renderMemoryPage, renderMemoryAssistant, memoryAssistantCursor, renderPalette, renderModelQuick, renderSetupPage, renderStoragePage, renderUsagePage, renderAgentsPage, renderPackagesPage, renderPetPicker, renderWorkflowsPage, renderCustomizePage, renderSettingsPage, renderExtensionsPage, renderHooksPage, renderConnectPage, renderProvidersPage, renderSecretsPage, renderPermissionsPage, reviewerStatus, renderDiagramView, renderSidebarEditor } from "../lazy-pages"
import type { Settings } from "@mendcode/protocol"
import { activeTheme, themeList, themeModeState, themeSelection } from "../theme"
import { asciiLine } from "../ascii"
import { applyGlyphMode } from "./glyph-mode"
import { renderModelPage } from "../../view/model-page"
import type { PaletteItem, PaletteOverlay, PaletteState } from "../../view/palette"
import { pageModel } from "../../view/page-views"
import { sideChat, sideChatRows, sideInput } from "./aside"
import { renderFetchCard } from "../../view/fetch-card"
import { viewRows } from "./view-rows"
import { toastBoxed, toastPosition, toastSpot } from "../../view/toast"
import { PROMPT_MARGIN } from "../../view/prompt-chrome"
import { overlayLines } from "../../view/overlay"
import { type HelpExtensions, renderHelpPage } from "../../view/help-page"
import { renderSessionList } from "../../view/session-list"
import type { PresentationMode } from "../../view/transcript"
import { mascotPhase } from "../../view/mascot"
import { terminalTitle } from "../../view/terminal-title"
import { lineWidth as lineWidthOf, textWidth } from "../../view/wrap"
import type { ImagePlacement } from "../image-layer"
import type { Line } from "../theme"
import type { AppContext } from "./context"
import { renderAutomationLedger } from "../lazy-pages"
import { sessionDisplayTitle } from "./display-title"

export function createRender(ctx: AppContext, actions: {
  /** The Git page's frame: `framed` while a page of its three tabs is open with the feature on, `typing` while the page takes text. */
  git: { framed(): boolean; typing(): boolean }
  slashCommands?: () => import("../../view/commands").SlashCommand[]
  inline: ReturnType<typeof import("./inline").createInline>
  catalogRows(width: number, height: number): Line[]
  syncIde(): void
  /** The home mascot's per-frame check (`home-mascot.ts`): a frame that does not draw her stops her timer. */
  mascotFrame(): void
  agentMetadata: ReturnType<typeof createAgents>["agentMetadata"]
  peerCommandRows: (width: number, height: number) => Line[]
  dropRevealedSecret: ReturnType<typeof createSecrets>["dropRevealedSecret"]
  syncPulse: () => void
  syncCompactionLive: () => void
  syncLoopsTick: () => void
  syncWorkflowsTick: () => void
  syncUsageTick: () => void
  syncBackgroundTick: () => void
  syncTopbarTick: () => void
  sessionTitle: () => string
  paletteItems: () => PaletteItem[]
  rightLayout: (width: number) => { right: number; bottom: boolean }
  fileOpen: ReturnType<typeof import("./file-open").createFileOpen>
  rightRows: (width: number, height: number) => Line[]
  sidebarShown: (width: number) => boolean
  chatRows: (width: number, height: number, inlineView?: { tail: Line[] }, bottomPanel?: (room: number) => Line[], toastRow?: Line) => { rows: Line[]; placements: ImagePlacement[]; cursor: { row: number; col: number; }; panel?: { top: number; height: number } | undefined; promptFirst?: number; body: { top: number; end: number } }
  sidebarRows: (height: number) => Line[]
  memoryDirectory: ReturnType<typeof createMemory>["memoryDirectory"]
  memoryPageData: ReturnType<typeof createMemory>["memoryPageData"]
  agentSubtasks: ReturnType<typeof createAgents>["agentSubtasks"]
  psItems(): import("../../view/ps-card").PsItem[]
  diagramLayout: ReturnType<typeof createDiagram>["diagramLayout"]
  setupValues: ReturnType<typeof createSetup>["setupValues"]
  setupChecks: ReturnType<typeof createSetup>["setupChecks"]
  topbarRow: (width: number) => Line
  /** The columns the transcript lays out in: the chat column less the scrollbar's. */
  transcriptWidth: () => number
  homeRoot: () => string
  homeSessions: () => import("../../view/home").HomeSession[]
  settingsValues: () => { settings: Settings; theme: string; view: PresentationMode; reducedMotion: boolean }
  statusInput: ReturnType<typeof createStatus>["statusInput"]
  terminalExtensions: ReturnType<typeof createStatus>["terminalExtensions"]
  otherExtensionProblems: ReturnType<typeof createStatus>["otherExtensionProblems"]
  helpExtensions: () => HelpExtensions | undefined
  extensionPageRows: (width: number, height: number) => Line[]
  /** The open extension modal as a card over the screen; undefined when none is open (or it closed itself). */
  extensionModalOverlay: (width: number, height: number) => { rows: Line[]; top: number; left: number; title?: string } | undefined
  footer: (width: number) => Line
  paneFacts: () => { model?: string; contextPercent?: number; costMicros?: number }
  statusRows: (width: number) => Line[]
  planReviewFrame: (width: number, height: number) => { rows: Line[]; cursor?: { row: number; col: number } } | undefined
}) {
  const { input, state, now, localDay, glyphs: g, homeTipText, toasts, stash } = ctx
  const { dropRevealedSecret, syncPulse, syncLoopsTick, syncWorkflowsTick, syncUsageTick, syncTopbarTick, sessionTitle, paletteItems, sidebarShown, chatRows, sidebarRows, memoryPageData, memoryDirectory, agentSubtasks, diagramLayout, setupValues, setupChecks, homeRoot, homeSessions, settingsValues, statusInput, terminalExtensions, otherExtensionProblems, helpExtensions, extensionPageRows, footer } = actions

  function render() {
    state.frameScheduled = false
    if (toasts.current && state.toastPage !== state.page && (toasts.current.variant === "info" || toasts.current.variant === "success")) toasts.dismiss()
    if (state.page !== "secrets" && state.secretsState?.revealed) dropRevealedSecret()
    if (state.page !== "env" && state.environmentPage) state.environmentPage = undefined
    syncPulse()
    actions.syncCompactionLive()
    syncLoopsTick()
    syncWorkflowsTick()
    syncUsageTick()
    actions.syncBackgroundTick()
    syncTopbarTick()
    actions.mascotFrame()
    actions.syncIde()
    // A terminal too narrow for the right slot shows an open file as the `file` page; wide again, it goes back to the slot.
    actions.fileOpen.syncPage(input.screen.size.width)
    const { width, height } = input.screen.size
    input.screen.setCursorShape?.(state.tuiProfile.vimMode && state.page === "chat" ? ctx.vim.cursorShape : "default")
    // Inline mode keeps the plain chat in the terminal's own screen; every page and overlay borrows the alternate screen.
    const plan = actions.planReviewFrame(width, height)
    const inlineLive = !plan?.rows.length && actions.inline.live()
    if (input.screen.inline === true) input.screen.fullscreen(!inlineLive)
    if (plan?.rows.length) { state.pet?.setVisible(false); input.screen.draw(plan.rows, plan.cursor); return }
    const title = sessionDisplayTitle(state, sessionTitle())
    const waiting = state.transcript.pendingRequests[0]
    if (input.paneState) input.paneState({ foreground: state.transcript.foreground, sessionId: state.sessionId, facts: actions.paneFacts(), children: paneChildren(state, now()), ...(waiting?.title ? { message: waiting.title } : {}) })
    input.screen.setHyperlinks?.(state.tuiProfile.hyperlinks)
    if (state.tuiProfile.terminalTitle) {
      const model = sessionModelId(state.effectiveModel?.model, state.transcript.lastUsage?.model, state.modelReport)
      input.screen.setTitle?.(terminalTitle({
        template: state.tuiProfile.titleTemplate, product: state.tuiProfile.productName, session: title || (state.page === "chat" ? "" : state.page),
        route: state.page, path: input.directory ?? "", state: state.transcript.foreground, activity: state.tuiProfile.titleActivity,
        ...(model ? { model: modelLabel(model, state.modelReport) } : {}), ...(state.gitBranch ? { branch: state.gitBranch } : {}),
      }))
    }
    else input.screen.setTitle?.("")
    if (inlineLive) return drawInline(width, height)
    const built = state.palette ? renderPalette({ items: paletteItems(), state: state.palette, width, height, glyphs: g }) : undefined
    // A custom `overlay` view replaces the card; its rows sit at the top left and the caret rests on the card's first cell.
    const overlay = built?.rows.length && state.palette && ctx.views.hasCustom("overlay")
      ? paletteOverlay(built, state.palette, width, height)
      : built
    const paint = overlay?.rows.length ? overlay : undefined
    // An extension modal (`api.modal`) is a card over the chat or the page, through the `overlay` slot like the other cards; it hides the caret.
    const modalBuilt = !paint && state.extModalId ? actions.extensionModalOverlay(width, height) : undefined
    const modal = modalBuilt?.rows.length ? card(modalBuilt.title ?? "", modalBuilt) : undefined
    const layered = (rows: Line[]) => (paint ? composeOverlay(rows, paint, width) : modal ? overlayLines(rows, modal.rows, { row: modal.top, col: modal.left }, width) : rows)
    // A toast floats over everything, the palette included (v1: z 4000 over the dialogs' 3000).
    const right = state.page === "chat" ? actions.rightLayout(width) : { right: 0, bottom: false }
    const leftWidth = state.page === "chat" && sidebarShown(width) ? 39 : 0
    const chatCols = width - leftWidth - (right.right ? right.right + 1 : 0)
    const sessionsSide = right.right ? "left" : state.tuiProfile.sidebarSide
    const chatOffset = sessionsSide === "left" ? leftWidth : 0
    // One row unless the message needs more (an error with detail): the notice row above the prompt, never a box over the transcript. Pages keep the box.
    const current = toasts.current
    const toastView = (inline: boolean, cols: number) => ctx.views.draw("notice", { kind: "toast", ...(inline ? { inline: true } : {}), variant: current!.variant, ...(current!.title ? { title: current!.title } : {}), message: current!.message, ...(current!.hint ? { hint: current!.hint } : {}) }, { width: cols, height: inline ? 1 : 8 }).lines
    const boxed = !!current && (state.page !== "chat" || toastBoxed(current, chatCols))
    const toast = boxed ? toastView(false, chatCols) : []
    const accentColors = ["#86efac", "#67e8f9", "#fcd34d", "#c4b5fd", "#fda4af"]
    const accentIndex = [...(state.sessionId ?? "")].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 0) % accentColors.length
    // In the chat the toast goes where it covers nothing (below the top bar and the pinned prompt); with no such place it is the
    // one-line notice row above the prompt, and `place` is null. Pages have no transcript: top right, as in v1.
    const withToast = (raw: Line[], place?: { row: number; col: number } | null) => {
      const rows = state.tuiProfile.sessionAccent && state.page === "chat" ? raw.map((row) => row.map((span) => span.fg === "primary" || span.fg === "accent" ? { ...span, fgHex: accentColors[accentIndex]! } : span)) : raw
      const position = place === undefined ? toastPosition(lineWidthOf(toast[0] ?? []), chatCols) : place
      return toast.length && position ? overlayLines(rows, toast, { ...position, col: position.col + chatOffset }, width) : rows
    }
    if (state.page === "chat") {
      // Cards stay in the chat column to the right of the session list.
      const sidebarOn = sidebarShown(width)
      const chat = sideChat(ctx)
      const bottomPanel = right.bottom ? (room: number) => {
        const sheetHeight = Math.min(Math.floor(height * .55), room)
        if (sheetHeight < 3) return []
        // An open side chat is being typed in and keeps its sheet; the cards give the chat back its rows (`panelNarrow: hide`).
        return chat.open ? sideChatRows(chat, chatCols, sheetHeight) : state.tuiProfile.rightSidebar && state.tuiProfile.panelNarrow === "sheet" ? actions.rightRows(chatCols, sheetHeight) : []
      } : undefined
      let laid = chatRows(chatCols, height, undefined, bottomPanel, current && !boxed ? toastView(true, chatCols)[0] : undefined)
      const spot = toast.length ? toastSpot({ rows: laid.rows, top: laid.body.top, bottom: laid.body.end, box: toast, width: chatCols }) : undefined
      // A boxed toast with no empty place takes the notice row (the transcript gives one up) instead of covering text.
      if (current && boxed && !spot) laid = chatRows(chatCols, height, undefined, bottomPanel, toastView(true, chatCols)[0])
      const { rows, cursor, placements, panel } = laid
      const bottom = Math.max(0, Math.min(cursor.row, laid.promptFirst ?? cursor.row) - 1)
      const asideCard = state.palette ? undefined : state.fetchFacts ? card("Fetch", renderFetchCard({ facts: state.fetchFacts, width: chatCols, bottom })) : undefined
      const withAside = asideCard ? overlayLines(rows, asideCard.rows, { row: asideCard.top, col: asideCard.left }, chatCols) : rows
      const rewind = state.palette || asideCard || !state.rewindCard ? undefined : card("Rewind", renderRewindCard({ card: state.rewindCard, width: chatCols, bottom }))
      const withRewind = rewind ? overlayLines(withAside, rewind.rows, { row: rewind.top, col: rewind.left }, chatCols) : withAside
      const goalView = state.palette || asideCard || rewind || !state.goalPrompt ? undefined : card("Goal", renderInfoCard({ card: goalPromptCard(state.goalPrompt, state.transcript.goal, now()), width: chatCols, bottom }))
      const withGoal = goalView ? overlayLines(withRewind, goalView.rows, { row: goalView.top, col: goalView.left }, chatCols) : withRewind
      const returnView = state.palette || asideCard || rewind || goalView || !state.returnPrompt ? undefined : card("Return", renderInfoCard({ card: returnPromptCard(state.returnPrompt), width: chatCols, bottom }))
      const withReturn = returnView ? overlayLines(withGoal, returnView.rows, { row: returnView.top, col: returnView.left }, chatCols) : withGoal
      const psView = state.palette || asideCard || rewind || goalView || returnView || !state.psCard ? undefined : card("Background", renderInfoCard({ card: psCard({ state: state.psCard, items: actions.psItems(), now: now() }), width: chatCols, bottom }))
      const withPs = psView ? overlayLines(withReturn, psView.rows, { row: psView.top, col: psView.left }, chatCols) : withReturn
      const rightRows = right.right ? actions.rightRows(right.right, height) : undefined
      // The quick model switch sits above the prompt like the other cards and takes the caret for its filter.
      const quickView = state.palette || !state.modelQuick ? undefined : renderModelQuick({ state: state.modelQuick, report: state.modelReport, prefs: state.modelPrefs, width: chatCols, bottom, error: state.modelError, glyphs: g })
      const quick = quickView ? { ...quickView, rows: card("Model", quickView)!.rows } : undefined
      const withQuick = quick ? overlayLines(withPs, quick.rows, { row: quick.top, col: quick.left }, chatCols) : withPs
      const withRight = rightRows ? withQuick.map((row, i) => [...fit(row, chatCols), { text: " " }, ...fit(rightRows[i] ?? [], right.right)]) : withQuick
      const withSidebar = sidebarOn ? attachSidebar(withRight, sidebarRows(height), width - leftWidth, sessionsSide) : withRight
      // An image under the palette, a card or a toast would cover them: it shows only on a clear prompt.
      if (state.scratchArea) state.scratchArea.left += chatOffset
      const shiftedCursor = state.sidebarFocus && sidebarOn
        ? { row: state.sidebarHits?.find((hit) => hit.sessionId === (state.sidebarSelected ?? state.sessionId))?.row ?? 0, col: sessionsSide === "left" ? 2 : width - 36 }
        : { ...cursor, col: cursor.col + chatOffset }
      const sideCursor = chat.open && chat.focused && (right.right || panel) ? { row: right.right ? ((state.rightChatArea?.top ?? 0) + (state.rightChatArea?.height ?? height) - 2) : panel!.top + panel!.height - 2, col: (right.right ? chatOffset + chatCols + 5 : chatOffset + 4) + sideInput(chat, right.right || chatCols).cursor } : shiftedCursor

      input.screen.draw(withToast(layered(withSidebar), spot ?? null), paint ? paint.cursor : modal ? undefined : quick ? { row: quick.cursor.row, col: quick.cursor.col + chatOffset } : sideCursor, paint || modal || quick || asideCard || rewind || goalView || returnView || spot ? [] : placements.map((placement) => ({ ...placement, col: placement.col + chatOffset })))
    } else {
      if (state.rightTick) {
        clearInterval(state.rightTick)
        state.rightTick = undefined
      }
      state.pet?.setVisible(false)
      const placements: ImagePlacement[] = []
      const rows = pageRows(width, height, placements)
      input.screen.draw(withToast(layered(rows)), paint?.cursor ?? (modal ? undefined : state.page === "memory-assistant" && state.memoryAssistant ? memoryAssistantCursor(state.memoryAssistant, width, height - (state.tuiProfile.showStatus ? actions.statusRows(width).length : 0)) : state.page === "compaction" ? state.compactionCursor : undefined), paint || modal || toast.length ? [] : placements)
    }
  }

  /** Inline mode: the blocks that became final go above the region once; the region is the live blocks, the prompt and the footer. */
  function drawInline(width: number, height: number) {
    state.pet?.setVisible(false)
    if (state.rightTick) {
      clearInterval(state.rightTick)
      state.rightTick = undefined
    }
    const { finished, tail } = actions.inline.take(width)
    const start = actions.inline.startLine()
    const toast = toasts.current ? ctx.views.draw("notice", { kind: "toast", inline: true, variant: toasts.current.variant, ...(toasts.current.title ? { title: toasts.current.title } : {}), message: toasts.current.message, ...(toasts.current.hint ? { hint: toasts.current.hint } : {}) }, { width, height: 1 }).lines[0] : undefined
    const { rows, cursor } = chatRows(width, height - (toast ? 1 : 0), { tail })
    input.screen.draw(toast ? [toast, ...rows] : rows, toast ? { ...cursor, row: cursor.row + 1 } : cursor, [], start ? [start, [], ...finished] : finished)
  }

  /** A floating card (fetch, rewind, goal, return) through the `overlay` slot: the view's rows replace the card's, in the same place. */
  function card<C extends { rows: Line[] }>(title: string, drawn: C | undefined): C | undefined {
    if (!drawn) return drawn
    const rows = ctx.views.wrap("overlay", () => ({ variant: "card" as const, title, query: "", selected: 0, matches: 0 }), drawn.rows, { width: Math.max(1, ...drawn.rows.map((row) => row.reduce((sum, span) => sum + textWidth(span.text), 0))), height: drawn.rows.length })
    return rows === drawn.rows ? drawn : { ...drawn, rows }
  }

  /** The palette as a custom `overlay` view draws it: the built-in card goes in the model, the view's rows replace it. */
  function paletteOverlay(built: PaletteOverlay, palette: PaletteState, width: number, height: number): PaletteOverlay {
    const matches = filterPalette(paletteItems(), palette.query).length
    const rows = ctx.views.wrap("overlay", () => ({ variant: (palette.title === "Commands" || !palette.title ? "palette" : "picker") as "palette" | "picker", title: palette.title ?? "Commands", query: palette.query, selected: palette.selected, matches }), built.rows, { width, height })
    return rows === built.rows ? built : { rows, top: 0, left: 0, cursor: { row: 0, col: 0 } }
  }

  function pageRows(width: number, height: number, placements: ImagePlacement[] = []): Line[] {
    // Setup draws the model it is choosing; the agent/model bar would show the one in use, so no page of the setup flow carries it.
    const inSetup = state.page === "setup" || state.onboarding !== undefined && state.page === "text"
    // `footerRows` are the chat's: a page keeps its whole height (the single-row footer still shows on a page).
    const foot = state.tuiProfile.footerRows.length === 0 && !["diagnostics", "worktrees", "warp", "setup", "intro", "ai-config", "tsm", "mflow", "console", "share"].includes(state.page) && !inSetup && state.tuiProfile.showStatus ? actions.statusRows(width).slice(0, Math.max(0, height - 1)) : []
    const bodyHeight = Math.max(1, height - foot.length)
    const preview = { root: homeRoot(), sessions: homeSessions(), tip: homeTipText, now: now(), chatWidth: actions.transcriptWidth(),agent: state.agentReport?.current ?? "Build", loops: state.liveLoops.size, ...(input.version ? { version: input.version } : {}), ...(state.effectiveModel?.model ? { model: state.effectiveModel.model } : {}), ...(state.effectiveModel?.effort ? { effort: state.effectiveModel.effort } : {}), ...(state.modelReport?.engine ? { provider: state.modelReport.engine } : {}), ...(state.homeMcp ? { mcp: state.homeMcp } : {}), phase: mascotPhase({ state: state.transcript.foreground, connected: state.connection === "connected", retry: state.turnState.retry !== undefined, ...(state.turnState.current ? { current: state.turnState.current } : {}) }), session: (cols: number, rows: number, profile = state.tuiProfile): Line[] => {
      const saved = state.tuiProfile
      const glyphsNow = { state, glyphs: ctx.glyphs, pinned: input.glyphs, env: input.env ?? process.env }
      state.tuiProfile = profile
      applyGlyphMode(glyphsNow)
      state.transcript.setAppearance(profile)
      // The sample shows the previewed glyph set even while the rest of the frame keeps the saved one.
      const ascii = state.glyphMode === "ascii"
      try {
        const rows_ = state.transcript.blocks().length ? [actions.topbarRow(cols), ...state.transcript.viewport(cols, Math.max(0, rows - 1)).map((line) => line.spans)] : [[{ text: "No conversation yet", fg: "muted" as const }]]
        return ascii ? rows_.map(asciiLine) : rows_
      }
      finally { state.tuiProfile = saved; applyGlyphMode(glyphsNow); state.transcript.setAppearance(saved) }
    } }
    let body: Line[] = []
    if (state.page === "file") body = actions.fileOpen.pageRows(width, bodyHeight)
    else if (state.automationLedger) body = renderAutomationLedger({ state: state.automationLedger, width, height: bodyHeight })
    else if (state.page === "ai-config" && state.aiConfigState) body = renderAIConfigPage({ state: state.aiConfigState, readOnly: input.remote?.readOnly ?? false, width, height: bodyHeight })
    else if (state.page === "messages" && state.messageActions) body = renderMessageActions({ state: state.messageActions, width, height: bodyHeight, now: now() })
    else if (state.page === "export" && state.exportOptions) body = renderExportOptions({ state: state.exportOptions, width, height: bodyHeight })
    else if (state.page === "compaction") {
      const entries = state.transcript.compactions()
      const data = entries.find((entry) => entry.turnId === state.compactionView?.turnId) ?? entries.at(-1)
      const result = renderCompactionPage({ ...(data ? { data } : {}), state: state.compactionView!, profile: state.tuiProfile, readOnly: input.remote?.readOnly === true, width, height: bodyHeight })
      body = result.rows
      state.compactionCursor = result.cursor
    } else if (state.page === "history") body = renderHistoryPage({ state: state.historyState, report: state.historyReport, detail: state.historyDetail, error: state.historyError, loading: state.historyLoading, width, height: bodyHeight, now: now() })
    else if (state.page === "prompt-mode") body = renderPromptModePage({ state: state.promptModeState!, ...(state.promptReport ? { report: state.promptReport } : {}), error: state.promptError ?? "", width, height: bodyHeight })
    else if (state.page === "compound") body = renderCompoundPage({ ...(state.compoundReport ? { report: state.compoundReport } : {}), state: state.compoundPage!, width, height: bodyHeight, readOnly: input.remote?.readOnly ?? false })
    else if (state.page === "skills") body = renderSkillsPage({ state: state.skillsState, report: state.skillsReport, error: state.skillsError, width, height: bodyHeight })
    else if (state.page === "model-picker") body = renderModelPicker({ state: state.modelPicker, report: state.modelReport, prefs: state.modelPrefs, error: state.modelError, width, height: bodyHeight })
    else if (state.page === "variants") body = renderVariantPicker({ state: state.variantState, report: state.modelReport, error: state.modelError, prefs: state.modelPrefs, width, height: bodyHeight })
    else if (state.page === "sidebar") body = renderSidebarEditor(state.tuiProfile.sidebarWidgets, state.sidebarEdit, width, bodyHeight)
    else if (state.page === "sessions") body = renderSessionList({ sessions: state.sessions, state: state.sessionList, currentSessionId: state.sessionId, ...(process.env.HOME ? { home: process.env.HOME } : {}), width, height: bodyHeight, now: now(), glyphs: g })
    else if (state.page === "usage")
      body = state.usageReport
        ? renderUsagePage({ report: state.usageReport, state: state.usageState, today: localDay(now()), width, height: bodyHeight, now: now(), clock: state.tuiProfile.usageClock, widgets: state.tuiProfile.usageWidgets, profile: state.tuiProfile, glyphs: g, ...(state.usageWaste ? { waste: state.usageWaste } : {}), ...(state.usageWasteLoading === false ? { wasteLoading: false } : {}) })
        : [[{ text: "loading usage…", fg: "muted" }]]
    else if (state.page === "tasks") body = renderTasksPage({ tasks: state.childTasks ?? [], selected: state.taskSelected ?? 0, scroll: state.taskScroll ?? 0, error: state.taskError ?? "", width, height: bodyHeight })
    else if (state.page === "memory-assistant" && state.memoryAssistant) body = renderMemoryAssistant({ chat: state.memoryAssistant, memories: state.memories, width, height: bodyHeight })
    else if (state.page === "memory")
      body = renderMemoryPage({ memories: state.memories, state: state.memoryState, ...(memoryDirectory() ? { directory: memoryDirectory()! } : {}), width, height: bodyHeight, now: now(), glyphs: g, graph: state.memoryGraph, dream: { runs: state.dreamRuns, dreamAt: state.settingsNow.dreamAt }, data: memoryPageData(width, bodyHeight) })
    else if (state.page === "context") body = renderContextPage({ report: state.contextReport, error: state.contextError, state: state.contextState, width, height: bodyHeight, glyphs: g })
    else if (state.page === "changes") {
      // A click on the page is resolved against the rows this frame drew. Inside the Git page the tabs row takes the first one.
      const framed = actions.git.framed()
      state.pageBodyTop = framed ? 1 : 0
      state.pageBodyHeight = bodyHeight - state.pageBodyTop
      body = state.changesReport
        ? renderChangesPage({ report: state.changesReport, state: state.changesState, width, height: state.pageBodyHeight, glyphs: g })
        : [[{ text: state.changesError || "loading changes…", fg: state.changesError ? "warning" : "muted" }], [], [{ text: "esc back", fg: "muted", dim: true }]]
      if (framed) body = [gitTabsRow({ active: "changes", status: state.gitStatus, width, typing: actions.git.typing() }), ...body]
    }
    else if (state.page === "git-commit" && state.gitCommit) {
      state.pageBodyTop = 1
      body = [gitTabsRow({ active: "commit", status: state.gitStatus, width, typing: actions.git.typing() }), ...renderGitCommitPage({ state: state.gitCommit, width, height: bodyHeight - 1, glyphs: g })]
    }
    else if (state.page === "git-pr" && state.gitPr) {
      state.pageBodyTop = 1
      body = [gitTabsRow({ active: "pr", status: state.gitStatus, width, typing: actions.git.typing() }), ...renderGitPrPage({ state: state.gitPr, width, height: bodyHeight - 1, glyphs: g })]
    }
    else if (state.page === "git-init" && state.gitInit) {
      state.pageBodyTop = 1
      // No tab has content here, so the row carries no `< >` hint (typing: the keys are not tab switches).
      body = [gitTabsRow({ active: undefined, status: state.gitStatus, width, typing: true }), ...renderGitInitPage({ state: state.gitInit, width, height: bodyHeight - 1 })]
    }
    else if (state.page === "env") body = renderEnvironmentPage(state.environmentPage, width, bodyHeight, { glyphs: g, now: now() })
    else if (state.page === "secrets")
      body = state.secretsList
        ? renderSecretsPage({ secrets: state.secretsList, state: state.secretsState, width, height: bodyHeight, now: now(), glyphs: g })
        : [[{ text: state.secretsError || "loading secrets…", fg: state.secretsError ? "warning" : "muted" }], [], [{ text: "esc back", fg: "muted", dim: true }]]
    else if (state.page === "tree") body = renderTreePage({ model: state.tree?.model, error: state.tree?.error ?? "", state: state.treeState, stats: state.tree?.stats ?? new Map(), width, height: bodyHeight, now: now(), pick: state.tree?.pick ?? false, glyphs: g, label: (id) => modelLabel(id, state.modelReport) })
    else if (state.page === "text" && state.textPage) {
      state.pageBodyHeight = bodyHeight
      body = renderTextPage({ state: state.textPage, width, height: bodyHeight })
    }
    else if (state.page === "pet") body = renderPetPicker({ choices: state.petList, current: state.petPickerMascot ? (state.tuiProfile.logoKind === "mascot" || state.tuiProfile.logoKind === "both" ? state.tuiProfile.homeMascot : "off") : state.tuiProfile.pet || state.settingsNow.pet, ...(state.petPickerMascot ? { mascot: true } : {}), state: state.petPicker, width, height: bodyHeight, graphics: input.screen.imageProtocol !== undefined && input.screen.imageProtocol !== "off", placements, plan: state.petPlan, progress: state.petProgress, busy: state.petGenerating, error: state.petPlanError })
    else if (state.page === "storage") body = renderStoragePage({ report: state.storageReport, error: state.storageError, state: state.storageState, ...(state.storageRetention ? { retentionDays: state.storageRetention } : {}), ...(state.storageWorktreeGc ? { worktreeGcDays: state.storageWorktreeGc } : {}), width, height: bodyHeight, now: now(), glyphs: g })
    else if (state.page === "tools")
      body = state.toolsReport
        ? renderToolsPage({ report: state.toolsReport, state: state.toolsState, width, height: bodyHeight, glyphs: g })
        : [[{ text: state.toolsError || "loading tools…", fg: state.toolsError ? "warning" : "muted" }], [], [{ text: "esc back", fg: "muted", dim: true }]]
    else if (state.page === "marketplace") body = actions.catalogRows(width, bodyHeight)
    else if (state.page === "packages") body = renderPackagesPage({ report: state.packagesReport, error: state.packagesError, state: state.packagesState, width, height: bodyHeight, now: now(), glyphs: g, activation: state.activation })
    else if (state.page === "mcps")
      body = state.mcpsReport && !state.mcpsError
        ? renderMcpsPage({ report: state.mcpsReport, state: state.mcpsState, width, height: bodyHeight, glyphs: g })
        : [[{ text: state.mcpsError || "loading mcps…", fg: state.mcpsError ? "warning" : "muted" }], [], [{ text: "esc back", fg: "muted", dim: true }]]
    else if (state.page === "agent-commands") body = actions.peerCommandRows(width, bodyHeight)
    else if (state.page === "agents")
      body = renderAgentsPage({ ...(actions.agentMetadata() ? { metadata: actions.agentMetadata()! } : {}), ...(state.agentBackgrounds ? { backgrounds: state.agentBackgrounds } : {}), backgroundError: state.agentBackgroundError ?? "", sessions: [...state.agentSessions.values()].filter((s) => inProject(s.directory, ctx.input.directory)), subtasks: agentSubtasks(), shells: state.agentShells, titles: Object.fromEntries(state.agentTitles), state: state.agentsState, currentSessionId: state.sessionId, width, height: bodyHeight, now: now(), glyphs: g })
    else if (state.page === "loops")
      body = state.loopsLoaded
        ? renderLoopsPage({ loops: state.loops, state: state.loopsState, width, height: bodyHeight, now: now(), glyphs: g })
        : [[{ text: state.loopsError || "loading loops…", fg: state.loopsError ? "warning" : "muted" }], [], [{ text: "esc back", fg: "muted", dim: true }]]
    else if (state.page === "permissions")
      body = renderPermissionsPage({
        mode: state.transcript.permissionMode,
        grants: state.permissionGrants,
        ...(state.permissionHistory ? { history: state.permissionHistory } : {}),
        ...(state.permissionHistoryError ? { historyError: state.permissionHistoryError } : {}),
        ...(state.permissionGrantsError ? { grantsError: state.permissionGrantsError } : {}),
        reviewer: reviewerStatus(state.permissionsModels, state.permissionsModelsError || undefined, state.settingsNow.permissionReviewerRole),
        settings: state.settingsNow,
        state: state.permissionsState,
        width,
        height: bodyHeight,
        now: now(),
        glyphs: g,
      })
    else if (state.page === "diagram") body = renderDiagramView({ layout: diagramLayout(), state: state.diagramView, count: state.diagramSources.length, width, height: bodyHeight })
    else if (state.page === "workflows")
      body = state.workflowsLoaded
        ? renderWorkflowsPage({ runs: state.workflows, state: state.workflowsState, width, height: bodyHeight, now: now(), glyphs: g })
        : [[{ text: state.workflowsError || "loading workflows…", fg: state.workflowsError ? "warning" : "muted" }], [], [{ text: "esc back", fg: "muted", dim: true }]]
    else if (state.page === "theme") body = renderThemePicker({ state: state.themePicker, entries: themeEntries({ themes: themeList(), query: state.themePicker.query, mode: themeModeState() }), current: state.themeRestore ?? themeSelection(), mode: themeModeState(), width, height: bodyHeight, glyphs: g })
    else if (state.page === "agent") body = renderAgentPicker({ report: state.agentReport, error: state.agentError, state: state.agentPicker, width, height: bodyHeight, glyphs: g })
    else if (state.page === "model") body = (state.modelState.reasoning ? renderReasoningPage : renderModelPage)({ state: state.modelState, report: state.modelReport, recipes: state.recipes, prefs: state.modelPrefs, error: state.modelError, width, height: bodyHeight, glyphs: g })
    else if (state.page === "connect") body = renderConnectPage({ state: state.connectState, providers: state.connectProviders, models: state.connectModels, width, height: bodyHeight, glyphs: g })
    else if (state.page === "providers") body = renderProvidersPage({ state: state.providersState, providers: state.providersList, error: state.providersError || undefined, notes: state.providerNotes, width, height: bodyHeight, glyphs: g })
    else if (state.page === "intro") body = renderIntroPage({ profile: state.tuiProfile, elapsedMs: state.intro?.elapsedMs ?? 1460, width, height: bodyHeight })
    else if (state.page === "setup" && state.onboarding && !state.setupAdvanced)
      body = renderOnboardingPage({ state: state.onboarding.state, detected: state.onboarding.detected, firstRun: state.onboarding.firstRun, loading: state.onboarding.loading, accessible: state.accessible, width, height: bodyHeight, glyphs: g, now: now(), chatWidth: actions.transcriptWidth() })
    else if (state.page === "setup")
      body = renderSetupPage({ state: state.setupState, values: setupValues(), checks: setupChecks(), firstRun: state.settingsNow.onboarded !== true, preview, width, height: bodyHeight, glyphs: g })
    else if (state.page === "stash") body = renderStashPage(stash.list(), state.stashState ?? { selected: 0 }, width, bodyHeight)
    else if (state.page === "drafts") body = renderDraftsPage(state.unsent, state.draftsState ?? { selected: 0 }, now(), width, bodyHeight)
    else if (state.page === "queue" && state.queueState) body = renderQueuePage(state.queueState, width, bodyHeight)
    else if (state.page === "customize" || state.page === "settings" && state.settingsPageState.tui)
      body = renderCustomizePage({
        ...(state.page === "settings" ? { title: "Settings" } : {}),
        commands: actions.slashCommands?.() ?? slashCatalog(),
        modules: [...new Set([...(state.ext?.loaded ?? []).filter((entry) => entry.tui).map((entry) => entry.name), ...(state.ext?.problems ?? []).map((problem) => problem.extension)])].map((name) => ({ name, enabled: !state.tuiProfile.disabledUiExtensions.includes(name), errors: (state.ext?.problems ?? []).filter((problem) => problem.extension === name).map((problem) => problem.message) })),
        views: viewRows(state),
        state: state.customizeState,
        profile: { ...state.tuiProfile, ...(input.directory && state.settingsNow.projectThemes?.[input.directory] ? { theme: activeTheme().name } : {}), ...(state.promptReport ? { promptContext: state.promptReport.mode } : {}) },
        ...(state.settingsNow.pet ? { pet: state.settingsNow.pet } : {}),
        ...(state.petList?.some((choice) => choice.ref === state.tuiProfile.homeMascot) ? { mascot: state.petList.find((choice) => choice.ref === state.tuiProfile.homeMascot)!.name } : {}),
        ...(state.promptReport ? { promptStatus: state.promptReport } : {}),
        graphIndex: state.settingsNow.codegraph_index ?? "auto",
        preview,
        width,
        height: bodyHeight,
        glyphs: g,
      })
    else if (state.page === "ide") body = renderIdePage({ state: state.ideState, width, height: bodyHeight })
    else if (state.page === "acp") body = renderAcpPage({ state: state.acpState, agents: state.settingsNow.acpAgents ?? {}, width, height: bodyHeight, glyphs: g })
    else if (state.page === "settings") body = renderSettingsPage({ state: state.settingsPageState, values: settingsValues(), profile: state.tuiProfile, pet: state.pet?.draw({ cols: 12, rows: 4 })?.lines, now: now(), width, height: bodyHeight, glyphs: g })
    else if (state.page === "status") {
      // The status page draws through the `page.status` slot; the page state (scroll) stays the terminal's, a custom view sees its value.
      const { state: pageState, width: _width, height: _height, ...facts } = statusInput(width, bodyHeight)
      body = ctx.views.draw("page.status", { ...facts, scroll: pageState.scroll } as never, { width, height: bodyHeight, extra: { state: pageState } }).lines
    }
    else if (state.page === "release-channel") body = renderReleasePage({ width, height: bodyHeight, ...(state.releaseReport ? { report: state.releaseReport } : {}), selected: state.releaseSelected ?? 0, scroll: state.releaseScroll ?? 0, error: state.releaseError ?? "", loading: state.releaseLoading ?? false, readOnly: input.remote?.readOnly ?? false })
    else if (state.page === "diagnostics") body = renderDiagnosticsPage({ width, height: bodyHeight, ...(state.diagnosticsMemory ? { memory: state.diagnosticsMemory } : {}), ...(state.diagnosticsReport ? { report: state.diagnosticsReport } : {}), ...(state.diagnosticsError ? { error: state.diagnosticsError } : {}), ...(state.diagnosticsSnapshots ? { snapshots: state.diagnosticsSnapshots } : {}), scroll: state.diagnosticsScroll ?? 0, readOnly: input.remote?.readOnly ?? false, ui: { sessions: state.sessions.length, messages: state.transcript.blocks().filter((block) => block.kind === "user_message" || block.kind === "agent_message").length, items: state.transcript.blocks().length, route: state.page, pid: process.pid, uptime: process.uptime() } })
    else if (state.page === "console" && state.console) body = renderConsolePage({ state: state.console, width, height: bodyHeight })
    else if (state.page === "share" && state.sharePage) body = renderSharePage({ state: state.sharePage, width, height: bodyHeight })
    else if (state.page === "keymap" && state.keymapState) body = renderKeymapPage({ rows: keymapRows(state.bindings), state: state.keymapState, file: input.dataDir ? "keybindings.json" : undefined, problems: ctx.keybindingFile.problems, width, height: bodyHeight })
    else if (state.page === "terminal-setup" && state.terminalSetupState) body = renderTerminalSetupPage({ env: ctx.env, state: state.terminalSetupState, width, height: bodyHeight, canApply: !!ctx.input.terminalConfig, ...(ctx.input.platform ? { platform: ctx.input.platform } : {}) })
    else if (state.page === "tutorial" && state.tutorialState) body = renderTutorialPage({ view: state.tutorialState.view(), bindings: state.bindings, sandbox: (w, h) => state.tutorialState!.sandbox.rows(w, h), width, height: bodyHeight, glyphs: ctx.glyphs, accessible: state.accessible })
    else if (state.page === "mflow" && state.mflow) body = renderMflowPage({ state: state.mflow, width, height: bodyHeight, now: now() })
    else if ((state.page === "worktrees" || state.page === "warp") && state.worktrees) {
      const framed = actions.git.framed()
      body = renderWorktreesPage({ state: state.worktrees, width, height: framed ? bodyHeight - 1 : bodyHeight })
      if (framed) body = [gitTabsRow({ active: "worktrees", status: state.gitStatus, width, typing: actions.git.typing() }), ...body]
    }
    else if (state.page === "tsm" && state.tsm) body = renderTsmPage({ state: state.tsm, width, height: bodyHeight })
    else if (state.page === "extensions")
      body = renderExtensionsPage({ state: state.extensionsState, ...(state.extensionsReport ? { report: state.extensionsReport } : {}), ...(state.extensionsError ? { error: state.extensionsError } : {}), terminal: terminalExtensions(), terminalProblems: otherExtensionProblems(), skipped: state.extSkipped, ...(state.settingsNow.tier ? { tier: state.settingsNow.tier } : {}), width, height: bodyHeight, glyphs: g })
    else if (state.page === "hooks")
      body = state.hooksReport
        ? renderHooksPage({ report: state.hooksReport, state: state.hooksState, now: now(), width, height: bodyHeight, glyphs: g })
        : [[{ text: state.hooksError || "loading hooks…", fg: state.hooksError ? "warning" : "muted" }], [], [{ text: "esc back", fg: "muted", dim: true }]]
    else if (state.page === "help") {
      const extensions = helpExtensions()
      body = renderHelpPage({ width, height: bodyHeight, bindings: state.bindings, scroll: state.helpScroll ?? 0, builtin: listedBuiltins(state.settingsNow, state.tuiProfile.slashCommands), ...(state.ext ? { commands: state.ext.commands().map(({ name, description }) => ({ name, summary: description })) } : {}), ...(extensions ? { extensions } : {}) })
    } else if (state.page === "extension") body = extensionPageRows(width, bodyHeight)
    // Every page, built-in or not, passes through the `page` slot; the page's own state and keys stay with the terminal.
    if (ctx.views.hasCustom("page")) body = ctx.views.wrap("page", () => pageModel({ page: state.automationLedger ? "automation" : state.page, body, status: foot, ...(state.page === "help" ? { scroll: state.helpScroll ?? 0 } : {}) }), body, { width, height: bodyHeight })
    body = body.slice(0, bodyHeight)
    while (body.length < bodyHeight) body.push([])
    return [...body, ...foot]
  }


  /** Shortens a path in the middle so both the root and the project name stay visible. */
  function middle(text: string, max: number) {
    if (textWidth(text) <= max) return text
    const keep = Math.max(4, Math.floor((max - 1) / 2))
    return `${text.slice(0, keep)}…${text.slice(text.length - (max - 1 - keep))}`
  }

  return { render }
}
