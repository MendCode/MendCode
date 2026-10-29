import { homedir } from "node:os"
import { HOME_RECENT_MS, HOME_WORKING, inProject } from "../../view/project-scope"
import { ideSelectionKey } from "@mendcode/protocol/wire"
import { subagentRunOf } from "./subagent-run"
import type { createPrompt } from "./prompt"
import { PET_MIN_WIDTH } from "../breakpoints"
import { goalSpans } from "../../view/goal"

/** How the daemon opens the notice of a background task that ended or printed (packages/daemon/src/background-notice.ts): the notices that ride with the next message. */
const BACKGROUND_NOTICE = /^\[(background task|monitor) /
import { modelLabel, sessionModelId } from "../../view/model-label"
import { renderHeaderSlot } from "../../view/topbar"
import { agentThreadHeader } from "../../view/agent-thread-header"
import { DOCK_HEIGHT } from "../../view/dock"
import { textWidth, truncateEnd } from "../../view/wrap"
import { leaderHint, LEADER_TIMEOUT_MS } from "../keymap"
import type { SlotContext } from "@mendcode/extension-api"
import type { BarModel } from "@mendcode/extension-api/views"
import { attachmentLabel, chipRowAttachments, liveAttachments, tokenLooks } from "../../view/attachments"
import { POPUP_ROWS, popupWindowStart, renderPopup } from "../../view/popup"
import { META_MARGIN, promptRow, PROMPT_MARGIN, withRightBlock, withRightLabel } from "../../view/prompt-chrome"
import { limitBarVisible, limitChips, limitLine } from "../../view/usage-limit"
import { renderShortcutOverlay, shortcutEntries } from "../../view/shortcut-overlay"
import { voiceRow } from "../../view/voice-row"
import { paintMatches } from "../../view/find"
import { activityPartsOf, phaseOf, renderWorkingReplacement, renderWorkingRow, quietTurn } from "../../view/working-row"
import type { ActivityPart } from "@mendcode/protocol/wire"
import { ACTIVITY_MIN_CELLS, insideRoom, placeInside } from "../../view/activity-status"
import { jumpFrom, jumpPill, jumpText, offsetForThumb, overlayAt, scrollbarGlyphs, scrollbarShown, scrollThumb, SCROLLBAR_LINGER_MS, withScrollbar } from "../../view/scroll-chrome"
import { SPINNER_FRAMES } from "../../view/tool-card"
import { renderAgentsStrip } from "../../view/agents-strip"
import { refreshLiveTasks } from "./live-tasks"
import { sessionChildren } from "./session-children"
import { fit, lineWidth } from "../../view/deck"
import { backgroundRows, backgroundName } from "../../view/background-row"
import { linkRows } from "../../view/links"
import { homeLook, renderWelcomeReplacement } from "../../view/home"
import { mascotPhase, mascotRows } from "../../view/mascot"
import { createHomeMascot } from "./home-mascot"
import { rowsWidth } from "../../view/logo-fonts"
import type { HomeSession } from "../../view/home"
import type { ImagePlacement } from "../image-layer"
import { activeTheme, type Line } from "../theme"
import { mendBeat, mendChatLines } from "../../view/mend-sprite"
import type { ViewLine } from "../../view/transcript"
import { CHART_KEY } from "../../view/chart-picture"
import type { StripTask } from "../../view/agents-strip"
import type { ItemId } from "@mendcode/protocol"
import { bodyHighlight, footerHighlight, bodyPoint, highlightLine, promptRange, type BodyLine, type SelectionMap } from "../selection"
import type { AppContext } from "./context"
import { asciiChrome } from "./glyph-mode"
import { overlayRule, ruleRight } from "../../view/status-line"
import { BUSY, DOUBLE_ESC_MS, MAX_EDITOR_ROWS } from "./constants"
import { queuePolicy } from "./queue-policy"
import { waitingNotice } from "./daemon"

/** Below this many transcript rows the pinned prompt would crowd the conversation out. */
const STICKY_MIN_BODY = 6

export function createChatRows(ctx: AppContext, actions: {
  slashMenu: ReturnType<typeof import("./slash-menu").createSlashMenu>
  findBar: (width: number) => { row: Line; cursor: number } | undefined
  searchBar: (width: number) => { row: Line; cursor: number } | undefined
  statusRow: (width: number) => Line
  statusRows: (width: number) => Line[]
  suggestionPool: ReturnType<typeof createPrompt>["suggestionPool"]
  requestPanel: (width: number) => { rows: Line[]; hits: Array<{ row: number; index: number; from?: number; to?: number }>; kind: "approval" | "question"; cursor?: { row: number; col: number } } | undefined
  extOn: () => boolean
  slotContext: (width: number, height: number) => SlotContext
  topbarRow: (width: number) => Line
  dockRows: (width: number, maxRows?: number) => Line[]
  promptSlotRows: (name: "prompt.above" | "prompt.below", width: number, height: number) => Line[]
  chatWidth: () => number
  /** Cells the transcript leaves free for the scrollbar, and the columns its text is laid out in. */
  scrollbarGutter: () => number
  transcriptWidth: () => number
  promptStatusLine: (room: number) => Line | undefined
  loadEarlier(): Promise<void>
  compactionLive: ReturnType<typeof import("./compaction-live").createCompactionLive>
}) {
  const { input, state, now, editor, view, glyphs: g, homeTipText, leader } = ctx
  const { compactionLive } = actions
  const { statusRow, suggestionPool, requestPanel, extOn, slotContext, topbarRow, dockRows, promptSlotRows, chatWidth } = actions

  /** The row for the newest user prompt when the viewport shows none of it and sits at or below it; undefined while it is in view. */
  function stickyPrompt(visible: ReadonlyArray<{ itemId?: string }>, width: number): Line | undefined {
    const blocks = state.transcript.blocks()
    const lastAt = blocks.findLastIndex((block) => block.kind === "user_message")
    const last = blocks[lastAt]
    if (!last || visible.length === 0 || visible.some((line) => line.itemId === last.itemId)) return undefined
    const topId = visible.find((line) => line.itemId !== undefined)?.itemId
    const topAt = topId === undefined ? -1 : blocks.findIndex((block) => block.itemId === topId)
    if (topAt < lastAt) return undefined
    const text = last.text.replace(/\s+/g, " ").trim()
    if (!text) return undefined
    return [{ text: " ".repeat(PROMPT_MARGIN) }, { text: truncateEnd(`› ${text}`, Math.max(1, width - PROMPT_MARGIN * 2)), fg: "muted" }]
  }

  /**
   * The chat frame. With `inlineView` (inline mode) it is only the live region: the unfinished blocks (`inlineView.tail`), what sits
   * above the prompt, the prompt and the footer, with no top bar, pet or scrolling; finished blocks are not part of it.
   */
  function chatRows(width: number, height: number, inlineView?: { tail: Line[] }, bottomPanel?: (room: number) => Line[], toastRow?: Line) {
    state.contextArea = undefined
    const comments = ctx.comments
    comments.beginFrame()
    // A pending approval docks above the prompt. A question takes the prompt's place: its card holds the field the editor types
    // into, so there is one input on screen, and the working row would only repeat that the turn waits (docs/layout.md, "Questions").
    const request = requestPanel(width)
    const asking = request?.kind === "question"
    const editorLines = editor.lines()
    // Balanced and full draw v1's prompt: straight rules with a 2-cell margin, a `❭` lead, v1's row under it. Minimal keeps bare rules and nothing below.
    const rich = state.mode !== "minimal"
    const home = state.transcript.blocks().length === 0 && !(state.paging?.loading || state.paging?.more)
    // The /customize preset frames the prompt (top-bottom, the default, is the rules above); every preset leaves the footer outside it.
    const customChrome = state.ext?.promptChrome()
    const preset = customChrome?.preset ?? state.tuiProfile.promptChrome
    const lead = customChrome?.lead ?? state.tuiProfile.promptLead
    const frame = comments.frame(ctx.views.frame({ preset, lead, border: customChrome?.border ?? state.tuiProfile.promptBorder, borders: state.tuiProfile.promptGlyphs, rich }, { width }), width)
    // `promptStatus: border` lays the READY › model › … line over the top rule (rules and boxes; the tinted minimal preset has no rule).
    const statusRule = rich && preset !== "minimal" && frame.top.length === 1 ? actions.promptStatusLine(width - PROMPT_MARGIN * 2 - 6) : undefined
    // The activity status: `above` lies over the top rule and `inside` over the prompt's first row, so neither takes a row from the transcript or
    // the prompt. A host without that rule or row (the minimal view and preset) keeps the classic row, and `off` keeps only a retry or the Esc hint.
    const ruleOffset = PROMPT_MARGIN + (preset === "top-bottom" ? 2 : 3)
    const overlay: "above" | "inside" | undefined = state.tuiProfile.activityPlacement === "above" && rich && preset !== "minimal" && frame.top.length === 1 ? "above" : state.tuiProfile.activityPlacement === "inside" && rich ? "inside" : undefined
    const workingBuilt = asking ? undefined : overlay === "above" ? overlayWorking(width - ruleOffset - 4, true) : workingRow(width, overlay !== undefined)
    // It takes the rule from the status line while the turn works; the status line is back when it stops.
    // A one-line notice lies over the same rule for the seconds it lasts: it takes no row, so nothing on screen moves when it comes or goes.
    // Only a host without that rule (the minimal view and preset) gives it a row of its own.
    const toastSpans: Line | undefined = toastRow && !asking && rich && preset !== "minimal" && frame.top.length === 1 ? ruleNotice(toastRow, width - ruleOffset - 4) : undefined
    const toastAbove = toastSpans ? undefined : toastRow
    // A newer build installed under this terminal: on the right of the prompt's top rule until the restart into it, so it takes no
    // row (the pet keeps standing on the prompt). Only a prompt without that rule gives it a right-aligned row of its own.
    // After the restart into it, the same place says so until the first key: a restart nobody watched still gets seen.
    const updateText = state.updateReady ? `${g.ok} Update installed ${g.sep} /restart to update` : state.updated ? `${g.ok} Updated to the new build` : ""
    const updateOnRule = updateText !== "" && !asking && rich && preset !== "minimal" && frame.top.length === 1
    const promptRule: Line[] = asking ? [] : toastSpans?.length ? [overlayRule(frame.top[0]!, toastSpans, ruleOffset)] : overlay === "above" && workingBuilt?.length ? [overlayRule(frame.top[0]!, workingBuilt, ruleOffset)] : statusRule?.length ? [overlayRule(frame.top[0]!, statusRule, ruleOffset)] : frame.top
    const promptTop: Line[] = updateOnRule && promptRule.length === 1 ? [ruleRight(promptRule[0]!, [{ text: updateText, fg: "success" }])] : promptRule
    const frameBottom: Line[] = asking ? [] : frame.bottom
    // While the card's field has the editor, the editor wraps at the field's width (set by the card).
    if (!asking) editor.setVisualWidth(Math.max(1, width - frame.inset - PROMPT_MARGIN - 2))
    const visual = editor.visualLines()
    const cursorAt = Math.max(0, visual.findLastIndex((line) => line.start <= editor.cursorOffset))
    // `showPlaceholder` off leaves the empty prompt blank; `placeholderText` replaces the built-in examples.
    const shownPlaceholder = state.shellMode ? (rich ? state.shellPlaceholder : undefined) : rich && home && state.tuiProfile.showPlaceholder ? state.tuiProfile.placeholderText || state.placeholder : undefined
    const popupRowsMax = Math.max(1, Math.min(POPUP_ROWS, height - 14))
    const menu = !state.transcript.pendingRequests.length && !state.editingScratch && editorLines.length === 1 && !state.shellMode ? actions.slashMenu.model(width, Math.max(3, height - 9)) : undefined
    const suggestions = menu?.items ?? []
    const mentionActive = !state.transcript.pendingRequests.length && !state.editingScratch && !state.shellMode && suggestions.length === 0 && state.mentionToken !== undefined && state.mentionResults.length > 0
    const mentionSelected = Math.min(state.mentionSuggestion, Math.max(0, state.mentionResults.length - 1))
    const popupBuilt: Line[] = menu
      ? actions.slashMenu.draw(width, Math.max(3, height - 9))
      : mentionActive
        ? renderPopup({ items: state.mentionResults.map((entry) => ({ label: `@${entry.path}${entry.kind === "dir" ? "/" : ""}`, ...(entry.description ? { note: entry.description } : {}), ...(entry.kind === "resource" ? { suffix: "MCP" } : entry.kind === "agent" ? { suffix: "agent" } : entry.kind === "thread" ? { suffix: "thread" } : {}) })), width, selected: mentionSelected, maxRows: popupRowsMax }).rows
        : []
    const popup: Line[] = menu || !mentionActive ? popupBuilt : barRows("mention", popupBuilt, width)
    const inset: Line = rich ? [{ text: " ".repeat(PROMPT_MARGIN + 1) }] : []
    // The row over the prompt: with tokens in the text (`inline`) only what has no token is left for it; `above` and `both` draw every attachment.
    const pending = liveAttachments(state.attachments, editor.text)
    const looks = [...tokenLooks(pending), ...state.pastes.map((paste) => ({ label: paste.label, role: "secondary" as const }))]
    const chipped = chipRowAttachments(pending, state.tuiProfile.attachmentChips)
    const chips: Line[] = barRows("attachments", chipped.length
      ? [[...inset, ...chipped.flatMap((a): Line => [{ text: a.kind === "image" ? "" : "■ ", fg: "heading" }, { text: `${attachmentLabel(pending, pending.indexOf(a))}  `, fg: "body" }]), ...(chipped.some((a) => !a.label) ? [{ text: "backspace removes", fg: "muted" as const, dim: true }] : [])]]
      : [], width)
    // Minimal shows nothing under the prompt; a notice, when there is one, goes above it instead.
    const minimal = !rich
    // A turn paused by the provider's usage limit is one muted line here and no bar (docs/usage-limit.md).
    const limitText = minimal ? limitLine(state.transcript.usageLimit, now()) : undefined
    const noticeRows: Line[] = minimal ? [...(limitText ? [[{ text: limitText, fg: "muted" as const }]] : []), ...(state.transcript.goal ? [[...goalSpans(state.transcript.goal, now(), g)]] : [])] : []
    const requestAbove: Line[] = request && !asking ? request.rows : []
    /** Rows the question card takes in the prompt's place, besides the one prompt row the room sums below already count. */
    const cardRows = asking ? Math.max(0, request!.rows.length - 1) : 0
    const shellQueued = new Set(state.transcript.queue.flatMap((entry, index) => (state.turnState.isShellQueued(entry.queueId) ? [index] : [])))
    const queueDrawn = ctx.views.draw("notice", { kind: "queue", previews: state.transcript.queue.map((entry) => entry.preview), delivery: state.transcript.queue.map((entry) => entry.delivery), held: state.transcript.foreground === "queued", paused: (state.agentSessions.get(state.sessionId)?.paused ?? state.sessions.find((session) => session.sessionId === state.sessionId)?.paused) === true, shell: [...shellQueued], notices: state.transcript.queue.flatMap((entry, index) => (entry.notice && BACKGROUND_NOTICE.test(entry.preview) ? [index] : [])), mode: queuePolicy(state) }, { width, height: 12 })
    const sendHit = queueDrawn.hits.find((hit) => hit.action === "send")
    const queue = { rows: queueDrawn.lines, sendChip: sendHit ? { row: sendHit.row, from: sendHit.from, to: sendHit.to } : undefined }
    // A turn paused by the provider's usage limit: the bar offers Resume at reset and Snooze until reset (docs/usage-limit.md).
    const limitView = state.transcript.usageLimit
    const limit = !minimal && limitBarVisible(limitView) ? limitBar(limitView, width) : { rows: [] as Line[], chips: [] as Array<{ action: "schedule" | "cancel" | "snooze" | "resume" | "dismiss"; row: number; from: number; to: number }> }
    const working = workingBuilt && overlay === undefined ? barRows("working", [workingBuilt], width)[0] : undefined
    // v1's top bar sits above a session's transcript (balanced and full); the widgets dock (ctrl+t) sits above the working row.
    // A terminal extension's `header.replace` takes the top bar's place (and shows on the home screen too). The minimal view has
    // no top bar, but an extension the user installed draws its header there as well: no view or tier turns an extension off.
    const headerSlot = state.ext && extOn() ? state.ext.slot("header.replace", slotContext(width - PROMPT_MARGIN * 2, 3)) : undefined
    // `showTopbar` off removes the row itself (an extension's header still shows: it is the user's own).
    const topbarShown = state.tuiProfile.showTopbar
    if (!topbarShown && !headerSlot) state.contextArea = undefined
    let topbar: Line[] = inlineView ? [] : headerSlot ? renderHeaderSlot(headerSlot, width - PROMPT_MARGIN * 2).map((row): Line => [{ text: " ".repeat(PROMPT_MARGIN) }, ...row]) : topbarShown && (input.remote || rich && !home) ? [topbarRow(width)] : []
    // A sub-agent's thread open in the chat's place says whose it is, right under the top bar (or at the top without one).
    const openThreads = state.agentView && !inlineView && (topbar.length || !topbarShown && rich && !home) ? (state.agentRoot ?? state.transcript).agentThreads() : []
    const openAt = openThreads.findIndex((thread) => thread.itemId === state.agentView)
    if (openAt >= 0) topbar = [...topbar, ...agentThreadHeader({ thread: openThreads[openAt]!, index: openAt, count: openThreads.length, now: now(), width, inset: PROMPT_MARGIN, sep: g.sep, rule: g.rule })]
    const findBuilt = state.find ? actions.findBar(width) : state.promptSearch ? actions.searchBar(width) : undefined
    const findDrawn = findBuilt ? barRows(state.find ? "find" : "search", [findBuilt.row], width) : []
    const findRow = findBuilt && findDrawn[0] ? { row: findDrawn[0], cursor: findDrawn[0] === findBuilt.row ? findBuilt.cursor : findDrawn[0].reduce((sum, span) => sum + textWidth(span.text), 0) } : undefined
    const asciiMascot = !inlineView && rich && state.tuiProfile.activityMascot && home === false && workingBuilt ? activityArt().map((line): Line => [{ text: " ".repeat(META_MARGIN) }, ...line]) : []
    const extAbove = promptSlotRows("prompt.above", width, height)
    const extBelow = promptSlotRows("prompt.below", width, height)
    // Pending comments on the answer (docs/editor.md): the reply bar and the chips above the prompt, or the chips under it.
    const commentRows = inlineView ? { above: [] as Line[], below: [] as Line[], chip: undefined } : comments.rows({ width, height })
    // The minimal view has no footer of its own; rows the user (or a package's look) set in `footerRows` are asked for, so they show,
    // and so is the footer an extension draws in or beside (`footer.*` slots).
    const extFooter = !!state.ext && extOn() && (["footer.replace", "footer.left", "footer.right"] as const).some((slot) => state.ext!.hasSlot(slot))
    const minimalRows = minimal && state.tuiProfile.showStatus && (state.tuiProfile.footerRows.length > 0 || extFooter) ? actions.statusRows(width) : []
    // A question card takes the prompt's place and the footer's: the screen bottom is the card, then one empty row.
    const below: Line[] = asking ? [[]] : minimal ?[...commentRows.below, ...minimalRows, ...extBelow, ...(minimalRows.length ? [] : [[]])] :[...(preset === "minimal" ? [[]] : []), ...commentRows.below, ...(state.tuiProfile.showStatus ? actions.statusRows(width) : []), ...extBelow]
    const ide = state.ideState
    const ideSelection = ide?.directory === input.directory && ide?.sessionId === state.sessionId ? ide?.report?.selection : undefined
    const ideKey = ideSelectionKey(ideSelection)
    const ideBuilt: Line[] = ideSelection && ideKey !== ide?.dismissed ? [fit([
      ...inset, { text: `${ideSelection.filePath.split(/[\\/]/).at(-1)} · ${ideKey === ide?.sent ? "sent" : "pending"}`, fg: "primary" },
      { text: " · /ide clear", fg: "muted" },
    ], width)] : []
    const ideRows = barRows("ide", ideBuilt, width)
    // Vim mode names its mode (and a half-typed command) above the prompt; insert is quiet, the others stand out.
    const vimBuilt: Line[] = state.tuiProfile.vimMode && !request ? [[...inset, { text: ctx.vim.label, fg: ctx.vim.mode === "insert" ? "muted" : "primary", bold: ctx.vim.mode !== "insert" }]] : []
    const vimRows = barRows("vim", vimBuilt, width)
    const voiceBuilt: Line[] = state.voice ? [fit([...inset, ...voiceRow({ voice: state.voice, now: now(), dot: g.dot, width: width - lineWidth(inset) - PROMPT_MARGIN, ascii: !rich })], width)] : []
    const voiceRows = barRows("voice", voiceBuilt, width)
    // `?` on an empty prompt: what the keys do right now, as bound.
    const shortcutBuilt: Line[] = state.shortcuts && !request ? renderShortcutOverlay({ width, entries: shortcutEntries(state.bindings, { multiline: state.tuiProfile.multiline, backtrack: state.tuiProfile.escBacktrack }), maxRows: Math.max(3, height - 12 - (width >= 70 ? 4 : 2)) }) : []
    const shortcutRows = barRows("shortcuts", shortcutBuilt, width)
    // A daemon older than this terminal that is still in use: one standing line until it is restarted (`/daemon restart`).
    const daemonBuilt: Line[] = [
      ...(state.daemonNotice ? [fit([...inset, { text: state.daemonNotice, fg: "warning" }], width)] : []),
      ...(state.waitingFor ? [fit([...inset, { text: waitingNotice(state.waitingFor), fg: "warning" }], width)] : []),
      ...(updateText && !asking && !updateOnRule ? [fit([{ text: " ".repeat(Math.max(0, width - PROMPT_MARGIN - lineWidth([{ text: updateText }]))) }, { text: updateText, fg: "success" }], width)] : []),
    ]
    const daemonRows = barRows("daemon", daemonBuilt, width)
    const fixedAbove: Line[] = [...asciiMascot, ...requestAbove, ...queue.rows, ...limit.rows, ...chips, ...ideRows, ...voiceRows, ...vimRows, ...daemonRows, ...noticeRows, ...shortcutRows, ...(toastAbove ? [toastAbove] : [])]
    // The open session's sub-agents, live, right over the working line. A session opened without a switch (the first one) asks for them here, once.
    if (state.liveTasks === undefined && !state.liveTasksAsk && !home && !inlineView && !input.remote) void refreshLiveTasks(ctx)
    // They hang under the working line as its tree and stop short of the pet, which stands on the prompt beside them.
    const agentsPet = rich && !inlineView && popup.length === 0 && width >= PET_MIN_WIDTH ? petCells(height) : undefined
    // Child tasks of the daemon and the sub-agents an engine runs inside the session (Claude Code's) are one list, with the
    // background commands right over the prompt; the multiplexer's pane reports the same children (session-children.ts).
    const { tasks: stripList, commands: backgroundItems, activity: childActivity } = sessionChildren(state, { now: now(), sep: g.sep })
    // With sub-agents in the strip, the commands are rows of its tree: one block for everything that runs, not two lists.
    const strip = rich && !inlineView && stripList.length ? renderAgentsStrip({ run: subagentRunOf(state, g.sep).ofTask, tasks: stripList, activity: childActivity, now: now(), width: width - (agentsPet ? agentsPet.cols + 1 : 0), inset: PROMPT_MARGIN + 1, glyphs: g, root: !working, openHint: `ctrl+x ↓ open ${g.sep} /tasks`, ...(!asking ? { commands: backgroundItems } : {}) }) : { rows: [], ids: [] }
    const stripBuilt: Line[] = strip.rows
    const stripRows: Line[] = stripBuilt.length ? barRows("agents", stripBuilt, width) : []
    const backgroundBuilt = !asking && !inlineView && !stripBuilt.length ? barRows("background", backgroundRows({ items: backgroundItems, full: state.mode === "full", width, now: now(), inset: PROMPT_MARGIN + 1, ascii: !rich }), width) : []
    // `showTasks` off takes both lists off the screen; /tasks and ctrl+t still show what runs.
    const agentRows: Line[] = state.tuiProfile.showTasks ? [...stripRows, ...backgroundBuilt] : []
    const dockRoom = height - agentRows.length - topbar.length - fixedAbove.length - extAbove.length - commentRows.above.length - (findRow ? 1 : 0) - (working ? 1 : 0) - below.length - popup.length - promptTop.length - frameBottom.length - cardRows - 3
    // While the compaction panel hosts the scratchpad the dock stays out of its way: one editor, one place.
    const dock: Line[] = rich && state.dockOpen && dockRoom >= DOCK_HEIGHT && !(compactionLive.visible() && compactionLive.mode() === "scratchpad") ? [...dockRows(width, dockRoom), []] : []
    if (!dock.length) { state.scratchArea = undefined; state.scratchCursor = undefined }
    // The compaction panel takes what is left once the prompt, the footer and six rows of transcript are kept.
    const live = compactionLive.rows({ width, room: height - agentRows.length - topbar.length - fixedAbove.length - dock.length - (findRow ? 1 : 0) - (working ? 1 : 0) - extAbove.length - commentRows.above.length - below.length - popup.length - promptTop.length - frameBottom.length - cardRows - 7 })
    if (live?.scratch) {
      state.scratchArea = { top: dock.length + live.scratch.top, left: live.scratch.left, width: live.scratch.width, rows: live.scratch.rows, first: live.scratch.first }
      state.scratchCursor = live.scratch.cursor ? { row: dock.length + live.scratch.cursor.row, col: live.scratch.cursor.col } : undefined
    }
    const above: Line[] = [...fixedAbove, ...dock, ...(live?.rows ?? []), ...(working ? [working] : []), ...agentRows, ...extAbove, ...commentRows.above, ...(findRow ? [findRow.row] : [])]
    // Reserve chrome first: a multiline prompt must not push the tray or footer off a short terminal.
    const editorRows = Math.max(1, Math.min(MAX_EDITOR_ROWS, height - topbar.length - above.length - popup.length - promptTop.length - frameBottom.length - below.length - cardRows - 1))
    const firstRow = Math.max(0, cursorAt - editorRows + 1)
    const shown = visual.slice(firstRow, firstRow + editorRows)
    const cursorText = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(visual[cursorAt]!.text)].slice(0, editor.cursorOffset - visual[cursorAt]!.start).map((cell) => cell.segment).join("")
    const replacement = !asking && !state.shellMode ? state.ext?.prompt({ ...slotContext(width, editorRows), text: editor.text, lines: shown.map((line) => line.text), cursor: { row: cursorAt - firstRow, col: textWidth(cursorText) } }) : undefined
    const rawReplacement = !asking && !replacement && !state.shellMode ?state.ext?.slot("prompt.replace", slotContext(width, editorRows))?.slice(0, editorRows) : undefined
    // The prompt's own selection (shift-arrows) or the one dragged with the mouse.
    const framedCount = asking ? request!.rows.length : replacement?.lines.length ?? rawReplacement?.length ?? shown.length
    const promptMap = { width, bodyTop: 0, body: [], promptTop: height - below.length - frameBottom.length - framedCount, promptRows: !asking && !replacement && !rawReplacement ? framedCount : 0, promptBelow: frameBottom.length, promptFirst: firstRow, promptInset: frame.inset, promptLines: visual }
    const selected = (state.selection?.area === "prompt" ? promptRange(promptMap, state.selection) : undefined) ?? editor.selection
    const framed: Line[] = asking ? request!.rows : replacement?.lines ?? rawReplacement ?? shown.map((line, i) => frame.row(promptRow({ text: line.text, ...(selected ? { selection: { start: Math.max(0, selected.start - line.start), end: Math.max(0, Math.min(line.end, selected.end) - line.start) } } : {}), first: firstRow + i === 0, rich, glyphs: g, lead, shell: state.shellMode, tokens: looks, ...(shownPlaceholder && editor.isEmpty() ? { placeholder: shownPlaceholder } : {}) })))
    // `inside`: the status sits at the right end of the prompt's first row, only where the typed text leaves room for it. The text and the
    // cursor do not move, and a prompt another module draws (an extension's replacement) is left alone.
    if (overlay === "inside" && workingBuilt && !replacement && !rawReplacement && shown.length) {
      const right = width - (frame.rightEdge ?? PROMPT_MARGIN)
      const room = insideRoom(frame.inset + textWidth(shown[0]!.text), right)
      const label = room >= ACTIVITY_MIN_CELLS && !(shownPlaceholder && editor.isEmpty()) ? overlayWorking(room, false) : undefined
      if (label) framed[0] = placeInside({ row: framed[0]!, width, right, label })
    }
    const chrome = topbar.length + above.length + popup.length + promptTop.length + framed.length + frameBottom.length + below.length
    // A collapsed sidebar is part of the layout, not an overlay on the newest output or requests.
    const sheet = !inlineView ? bottomPanel?.(Math.max(0, height - chrome - STICKY_MIN_BODY)) ?? [] : []
    const reserved = chrome + sheet.length
    // Inline mode: the live blocks that fit above the prompt; the rest of the transcript is already in the terminal's scrollback.
    const inlineBody = inlineView?.tail.slice(-Math.max(0, height - reserved))
    let bodyHeight = inlineBody ? inlineBody.length : Math.max(1, height - reserved)
    const localState = view.get(state.sessionId)
    // The transcript's text is laid out one column short of the chat column while the scrollbar is `auto` or `always`: that column is the
    // bar's, drawn or blank, so showing and hiding it never reflows a line (docs/customize.md, "Scrolling").
    const gutter = inlineView ? 0 : actions.scrollbarGutter()
    const tw = width - gutter
    const cleared = !inlineBody && state.clearFrom && localState.follow ? state.transcript.from(state.clearFrom, tw, bodyHeight) : undefined
    let visible = home || cleared || inlineBody ? [] : state.transcript.viewport(tw, bodyHeight, localState.offset)
    // The newest prompt, once it has scrolled up out of view, stays pinned under the top bar (one muted row taken from the transcript).
    const pinned = !inlineBody && !home && !cleared && state.tuiProfile.stickyPrompt && bodyHeight > STICKY_MIN_BODY ? stickyPrompt(visible, width) : undefined
    if (pinned) {
      topbar = [...topbar, pinned]
      bodyHeight -= 1
      visible = state.transcript.viewport(tw, bodyHeight, localState.offset)
    }
    state.lastBodyHeight = Math.max(1, bodyHeight)
    if (!inlineBody && !home && !cleared) wantImages(visible)
    const links = state.tuiProfile.hyperlinks ? { cwd: input.directory ?? "", ...(input.home ? { home: input.home } : {}), opener: state.tuiProfile.fileOpener } : undefined
    const plainRows = (lines: Line[]) => links ? linkRows(lines.map((spans) => ({ spans, text: spans.map((span) => span.text).join("") })), links) : lines
    const linked = (lines: Line[]) => links ? linkRows(visible, links) : lines
    const hovered = state.hoverLink
    // The address under the pointer is underlined on every row it covers, the way a browser shows a link.
    const underHover = (lines: Line[]) => hovered ? lines.map((line) => line.some((span) => span.link === hovered) ? line.map((span) => span.link === hovered ? { ...span, underline: true } : span) : line) : lines
    const body: Line[] = inlineBody ? plainRows(inlineBody) : cleared ? plainRows(cleared) : (home ? emptyState(width, bodyHeight).slice(0, bodyHeight) : underHover(linked(visible.map((l) => l.spans))))
    // A transcript shorter than the body starts under the top bar after one blank row and the free rows sit between its last
    // message and the prompt; once it overflows the view follows the bottom.
    const topAnchored = !inlineBody && !home && !cleared && visible.length < bodyHeight
    if (topAnchored && visible.length > 0 && body[0]?.some((span) => span.text.trim())) body.unshift([])
    const blankAbove = topAnchored ? body.length - visible.length : 0
    while (body.length < bodyHeight) home || cleared || topAnchored ? body.push([]) : body.unshift([])
    /** Blank rows above the transcript's first shown row. */
    const padTop = topAnchored ? blankAbove : body.length - visible.length
    const shownFrom = topAnchored ? 0 : state.transcript.totalLines(tw) - localState.offset - visible.length
    // The "jump to latest" button: a pill on the transcript's last row whenever the view is off the bottom, with how many rows arrived below
    // while it was. A click or End (with an empty prompt) follows the newest output again. It covers the text under it, never the bar's column
    // or the pet: at the right it stops before the pet's cells.
    const petShown = rich && !inlineBody && popup.length === 0 && width >= PET_MIN_WIDTH
    let jump: { row: number; from: number; to: number } | undefined
    if (!inlineBody && !home && !localState.follow && state.tuiProfile.jumpHint !== "off") {
      const pill = jumpPill(jumpText({ template: state.tuiProfile.jumpText, unseen: localState.unseen, keyHint: editor.isEmpty(), g }), g)
      const pillWidth = pill.reduce((sum, span) => sum + textWidth(span.text), 0)
      const pet = petShown && state.tuiProfile.jumpHint === "right" ? petCells(bodyHeight) : undefined
      const from = jumpFrom({ position: state.tuiProfile.jumpHint, width: tw, labelWidth: pillWidth, gutter: pet ? Math.max(0, pet.cols + 1 - gutter) : 0 })
      const drawn = overlayAt({ line: body[body.length - 1]!, width: tw, from, label: pill })
      if (drawn) {
        body[body.length - 1] = drawn
        jump = { row: topbar.length + body.length - 1, from, to: from + pillWidth }
      }
    }
    // The find bar's hits in the rows on screen: the current one stands out.
    if (state.find?.matches.length && !home && !cleared && !inlineBody) {
      const find = state.find
      const current = find.matches[find.index]
      for (let at = 0; at < visible.length; at++) {
        const hits = find.matches.filter((match) => match.line === shownFrom + at).map((match) => ({ match, current: match === current }))
        if (hits.length) body[padTop + at] = paintMatches(body[padTop + at]!, hits)
      }
    }
    // Commented passages get a margin mark, the passage being written about a fill, and a kept selection its hint (docs/editor.md). Nothing runs without comments.
    if (!inlineBody && !home && !cleared) comments.decorate({ body, visible, padTop, top: topbar.length, width: tw })
    // At the top of the laid-out window with older blocks waiting: scrolling up lays out the next slice of them.
    const topBefore = body[0]
    if (!inlineBody && !home && state.transcript.olderBlocks > 0 && localState.offset >= Math.max(0, state.transcript.totalLines(tw) - bodyHeight)) body[0] = withRightLabel(body[0] ?? [], tw, `↑ ${state.transcript.olderBlocks} earlier · scroll up`)
    else if (!inlineBody && !home && state.paging && !localState.follow && state.transcript.totalLines(tw) > bodyHeight && localState.offset >= Math.max(0, state.transcript.totalLines(tw) - bodyHeight)) {
      const label = state.paging.loading ? "loading earlier…" : !state.paging.ready ? "history unavailable" : state.paging.more ? "↑ earlier · scroll up" : state.paging.loadedEarlier ? "start of session" : ""
      if (label) body[0] = withRightLabel(body[0] ?? [], tw, label)
    }
    // Rows that carry a label at their right edge: a picture reaching them would hide it.
    const labelRows = new Set<number>([...(body[0] !== topBefore ? [0] : []), ...(jump ? [body.length - 1] : [])])
    // The scrollbar: a one-cell track in the column the layout left free, a thumb as long as the view is of the transcript. `auto` draws it while
    // the view is off the bottom or was scrolled a moment ago; the column is reserved either way.
    let scrollbar: SelectionMap["scrollbar"]
    if (gutter && !inlineBody && !home) {
      const total = cleared ? 0 : state.transcript.totalLines(tw)
      const thumb = scrollThumb({ rows: body.length, total, viewport: bodyHeight, offset: localState.offset })
      const lingering = state.scrollbarAt !== undefined && now() - state.scrollbarAt < SCROLLBAR_LINGER_MS
      const shown = !!thumb && scrollbarShown({ mode: state.tuiProfile.scrollbar, offset: localState.offset, lingering })
      body.splice(0, body.length, ...withScrollbar({ rows: body, width, thumb, glyphs: scrollbarGlyphs(state.tuiProfile.scrollbarGlyphs, g), shown }))
      if (shown && thumb) scrollbar = { col: width - 1, top: topbar.length, rows: body.length, thumb, total, viewport: bodyHeight }
    }
    // Minimal keeps the last row empty: the prompt's closing rule stays full width (the screen never draws the bottom-right cell).
    const rows: Line[] = [...topbar, ...body, ...sheet, ...above, ...popup, ...promptTop, ...framed, ...frameBottom, ...below]
    const panel = sheet.length ? { top: topbar.length + body.length, height: sheet.length } : undefined
    const bodyEnd = topbar.length + body.length + sheet.length
    if (!inlineView) {
      const commentTop = fixedAbove.length + dock.length + (live?.rows.length ?? 0) + agentRows.length + (working ? 1 : 0) + extAbove.length
      const belowTop = bodyEnd + above.length + popup.length + promptTop.length + framed.length + frameBottom.length +(!minimal && preset === "minimal" ? 1 : 0)
      comments.place({ rows, rule: bodyEnd + above.length + popup.length, ...(commentRows.chip !== undefined ? { chip: bodyEnd + commentTop + commentRows.chip } : {}), ...(commentRows.below.length ? { below: belowTop } : {}), width })
    }
    // What a mouse selection reads: the transcript rows as laid out (not as decorated above) and where the prompt landed.
    const bodyLine = (line: { text: string; gutter?: number; soft?: "space" | "none"; itemId?: string; fold?: number; copy?: BodyLine["copy"] }): BodyLine => ({ text: line.text, gutter: line.gutter ?? 0, ...(line.itemId ? { itemId: line.itemId } : {}), ...(line.soft ? { soft: line.soft } : {}), ...(line.fold !== undefined && line.itemId ? { fold: { itemId: line.itemId, ordinal: line.fold } } : {}), ...(line.copy ? { copy: line.copy } : {}) })
    const bodyLines: Array<BodyLine | undefined> = home || cleared ? body.map(() => undefined) : [...body.slice(0, padTop).map(() => undefined), ...visible.map(bodyLine), ...body.slice(padTop + visible.length).map(() => undefined)]
    // A scrolling transcript keeps its selection in transcript rows, so a drag past the edge can scroll and still copy what left the screen.
    const scrolls = !inlineBody && !home && !cleared
    const laid = scrolls ? (() => {
      let rows: BodyLine[] | undefined
      return {
        base: shownFrom - padTop,
        count: state.transcript.totalLines(tw),
        at: (row: number) => (rows ??= state.transcript.blocks().slice(state.transcript.olderBlocks).flatMap((block) => state.transcript.blockLines(block.itemId, tw)).map(bodyLine))[row],
      }
    })() : undefined
    const footerTop = rows.length - below.length
    state.selectionMap = { ...promptMap, footer: { top: footerTop, rows: below.map((row) => row.map((span) => span.text).join("")) }, bodyTop: topbar.length, body: bodyLines, ...(jump ? { jump } : {}), ...(scrollbar ? { scrollbar } : {}), ...(laid ? { bodyBase: laid.base, bodyRows: laid.count, lineAt: laid.at } : {}) }
    if (state.selection?.pointer && state.selection.area === "body") state.selection = { ...state.selection, focus: bodyPoint(state.selectionMap, state.selection.pointer) }
    if (state.selection) for (const [row, [from, to]] of bodyHighlight(state.selectionMap, state.selection)) rows[row] = highlightLine(rows[row]!, from, to)
    if (state.selection?.area === "footer") for (const [row, [from, to]] of footerHighlight(state.selectionMap, state.selection)) rows[row] = highlightLine(rows[row]!, from, to)
    // Where the panels and the popup landed, so a click can pick an option, send a queued message or complete a suggestion.
    // The strip names what each of its rows opens; a custom bar view that re-laid its rows has no such map, so clicks pass through.
    state.agentsArea = state.tuiProfile.showTasks && stripRows.length && stripRows === stripBuilt
      ? { top: bodyEnd + fixedAbove.length + dock.length + (live?.rows.length ?? 0) + (working ? 1 : 0), ids: strip.ids }
      : undefined
    state.homeArea = home && !inlineBody && !cleared && homeHits.length ? { top: topbar.length, hits: homeHits } : undefined
    const requestTop = asking ? bodyEnd + above.length + popup.length + promptTop.length : bodyEnd + asciiMascot.length
    state.requestArea = request ? { top: requestTop, hits: request.hits, kind: request.kind } : undefined
    state.sendChipArea = queue.sendChip ? { row: bodyEnd + asciiMascot.length + requestAbove.length + queue.sendChip.row, from: queue.sendChip.from, to: queue.sendChip.to } : undefined
    state.limitArea = limit.chips.length ? { top: bodyEnd + asciiMascot.length + requestAbove.length + queue.rows.length, chips: limit.chips } : undefined
    const popupTop = bodyEnd + above.length
    state.popupArea = menu ? { top: popupTop, first: 0, count: popup.length } : undefined
    state.mentionPopupArea = mentionActive ? { top: popupTop, first: popupWindowStart(state.mentionResults.length, mentionSelected, popupRowsMax), count: popup.length } : undefined
    const cursorRow = bodyEnd + above.length + popup.length + promptTop.length + (cursorAt - firstRow)
    const current = visual[cursorAt]!
    const before = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(current.text)].slice(0, editor.cursorOffset - current.start).map((s) => s.segment).join("")
    const placements = drawPet({ rows, bottom: topbar.length + body.length, floor: sheet.length === 0 && above.length === (working ? 1 : 0) + agentRows.length ? bodyEnd + above.length : topbar.length + body.length, top: topbar.length, width, shown: petShown && !(home && homeMascot.drawn) })
    // The start screen's pet mascot, where the terminal draws pictures: over the blank cells the home reserved for it.
    if (home && !inlineBody && !cleared) placements.push(...homeMascot.placement(topbar.length).filter((placement) => placement.row + placement.rows <= topbar.length + body.length))
    if (!inlineBody && !home && !cleared) placements.push(...transcriptPlacements({ visible, top: topbar.length + padTop, labelRows: new Set([...labelRows].map((row) => topbar.length + row)), clear: placements }))
    const dockTop = bodyEnd + asciiMascot.length + requestAbove.length + queue.rows.length + limit.rows.length + chips.length + voiceRows.length + vimRows.length + noticeRows.length + shortcutRows.length + (toastAbove ? 1 : 0)
    if (state.scratchArea) state.scratchArea.top += dockTop
    compactionLive.place(live ? { top: dockTop + dock.length, rows: live.rows.length, width } : undefined)
    // A question card puts the caret in its field, or on its highlighted answer (the row a screen reader reads).
    const cursor = findRow ? { row: bodyEnd + above.length - 1, col: Math.min(width - 1, findRow.cursor) } : asking && request?.cursor ? { row: requestTop + request.cursor.row, col: Math.min(width - 1, request.cursor.col) } : state.editingScratch && state.scratchCursor ? { row: dockTop + state.scratchCursor.row, col: state.scratchCursor.col } : replacement ? { row: bodyEnd + above.length + popup.length + frame.top.length + replacement.cursor.row, col: replacement.cursor.col } : { row: rawReplacement ? Math.min(cursorRow, bodyEnd + above.length + popup.length + frame.top.length + Math.max(0, rawReplacement.length - 1)) : cursorRow, col: Math.min(width - 1, frame.inset + textWidth(before)) }
    // The prompt's first text row: cards above the prompt end over it, so a prompt of several rows is never covered.
    const promptFirst = bodyEnd + above.length + popup.length + promptTop.length
    return { rows, placements, cursor, panel, promptFirst, body: { top: topbar.length, end: topbar.length + body.length } }
  }

  /** The usage-limit bar through the `notice` slot; chip regions are the ones the view named, each checked against the real chips. */
  function limitBar(view: NonNullable<typeof state.transcript.usageLimit>, width: number) {
    const model = { kind: "limit" as const, view: { state: view.state, ...(view.provider ? { provider: view.provider } : {}), message: view.message, ...(view.resetsAt !== undefined ? { resetsAt: view.resetsAt } : {}) }, chips: limitChips(view) }
    const drawn = ctx.views.draw("notice", model, { width, height: 8 })
    const chips = drawn.hits.flatMap((hit) => (hit.arg === undefined ? [{ action: hit.action as "schedule" | "cancel" | "snooze" | "resume" | "dismiss", row: hit.row, from: hit.from, to: hit.to }] : []))
    return { rows: drawn.lines, chips }
  }

  /** Clickable session rows of the home last drawn (rows relative to its first row). */
  let homeHits: Array<{ row: number; from: number; to: number; sessionId: string }> = []

  /** The rows of a bar through the `bar` slot; a bar the terminal does not show is never drawn. */
  function barRows(variant: BarModel["variant"], rows: Line[], width: number): Line[] {
    if (rows.length === 0 || !ctx.views.hasCustom("bar")) return rows
    return ctx.views.wrap("bar", () => ({ variant }), rows, { width, height: 24 })
  }

  const homeMascot = createHomeMascot(ctx, {
    // The pet plays its working state while the Agent View lists a session at work.
    working: () => homeSessions().some((session) => session.state === "working" || session.state === "looping"),
    ascii: () => asciiGlyphs(),
  })

  function emptyState(width: number, height: number): Line[] {
    homeHits = []
    const root = homeRoot()
    // Balanced and full show v1's home; minimal keeps only the name and the project, like Pi.
    const sessions = homeSessions()
    // Terminal extensions: `welcome.replace` is the whole home, `welcome.below` adds rows under its centered block.
    const replaced = state.ext && extOn() ? state.ext.slot("welcome.replace", slotContext(width, height)) : undefined
    if (replaced) return renderWelcomeReplacement(replaced, width, height)
    const below = state.ext && extOn() ? state.ext.slot("welcome.below", slotContext(width, Math.max(1, Math.min(8, height - 6)))) : undefined
    // The /customize profile shapes the home; an extension's `welcome.*` and `footer.*` slots win over its tip and footer.
    const footerTaken = state.ext && extOn() && (state.ext.hasSlot("footer.replace") || state.ext.hasSlot("footer.left") || state.ext.hasSlot("footer.right"))
    // A pet mascot belongs to the pet companion (full tier): below it, and wherever its picture cannot go, the home keeps the ASCII Mend.
    const mascot = homeMascot.art()
    const profile = state.tuiProfile
    const drawn = ctx.views.draw("home", {
      screenHeight: input.screen.size.height,
      root,
      bare: state.mode === "minimal",
      sessions,
      ...(state.homeSelected ?? state.homeHover ? { selectedId: (state.homeSelected ?? state.homeHover)! } : {}),
      spinner: state.spinFrame,
      look: homeLook(profile) as never,
      ...(state.tuiProfile.homeTips ? { tip: homeTipText } : {}),
      ...(state.tuiProfile.homeFooter && !footerTaken ? { footer: state.homeMcp ? { mcp: state.homeMcp } : {} } : {}),
      ...(input.version ? { version: input.version } : {}),
    }, { width, height, extra: { ...(below ? { below } : {}), ...(mascot ? { mascot } : {}) } })
    homeHits = drawn.hits.flatMap((hit) => (hit.action === "open" && typeof hit.arg === "string" ? [{ row: hit.row, from: hit.from, to: hit.to, sessionId: hit.arg }] : []))
    return drawn.lines
  }

  /** The project root as the home shows it, `~` for the user's home. */
  const homeRoot = () => input.remote ? `remote ${input.remote.host}${input.remote.readOnly ? " · read-only" : ""}` : (input.home && input.directory?.startsWith(input.home) ? `~${input.directory.slice(input.home.length)}` : (input.directory ?? ""))

  /** The running sessions as the home's Agent View lists them. */
  const homeSessions = (): HomeSession[] => {
    // This project and the folders inside it (another project's sessions belong to its own home); from the user's home every project, as in v1.
    const scope = input.directory === homedir() ? undefined : input.directory
    const sessions: HomeSession[] = [...state.agentSessions.values()].filter((s) => HOME_WORKING.has(s.state) && inProject(s.directory, scope)).map((s) => ({
      id: s.sessionId, title: s.title || s.sessionId, state: s.state === "waiting_approval" ? "needs_input" : "working", updatedAt: s.updatedAt,
      ...(s.since !== undefined ? { startedAt: s.since } : {}), ...(s.tool || s.pending ? { detail: s.tool ?? s.pending! } : {}),
    }))
    for (const loop of state.loops.filter((loop) => state.liveLoops.has(loop.loopId) && inProject(loop.directory, scope))) {
      const id = loop.sessionId
      const existing = sessions.find((session) => session.id === id)
      if (existing && existing.state !== "needs_input") existing.state = "looping"
      else if (!existing) sessions.push({ ...(id ? { id } : {}), title: loop.name || loop.loopId, state: loop.state === "needs_input" ? "needs_input" : "looping", updatedAt: loop.updatedAt ?? now(), detail: loop.state })
    }
    // v1 lists the project's last finished conversations under Completed: root sessions of the last 30 days, not archived.
    const since = now() - HOME_RECENT_MS
    // What changed since attach (`sessions`, kept current by activity) wins over the list read at attach (`homeRecent`, every project).
    const known = new Map([...state.homeRecent, ...state.sessions].map((s) => [s.sessionId, s]))
    for (const s of known.values()) {
      if (!inProject(s.directory, scope) || s.parentId || s.archivedAt !== undefined || s.sessionId === state.sessionId || s.updatedAt < since || sessions.some((session) => session.id === s.sessionId)) continue
      if (state.agentSessions.has(s.sessionId) || HOME_WORKING.has(s.state)) continue
      sessions.push({ id: s.sessionId, title: s.title || s.sessionId, state: "completed", updatedAt: s.updatedAt, ...(s.state === "error" ? { detail: "failed" } : {}) })
    }
    return sessions
  }

  function activityPhase(): string {
    const current = state.turnState.current
    return state.petHover ? "hover" : mascotPhase({ state: state.transcript.foreground, connected: state.connection === "connected", retry: state.turnState.retry !== undefined, ...(current ? { current } : {}), failed: state.transcript.blocks().at(-1)?.end?.outcome === "failed" })
  }

  /** The profile's own text for `phase` (`activityStates`), which replaces Mend's art. */
  function customActivityArt(phase: string): string | undefined {
    const states = state.tuiProfile.activityStates ? JSON.parse(state.tuiProfile.activityStates) : {}
    return states[phase] || states.idle || undefined
  }

  function activityArt(): Line[] {
    const phase = activityPhase()
    const custom = customActivityArt(phase)
    if (custom) return custom.split("\n").map((text: string) => [{ text, fg: "text" as const }])
    return textMascot() ? mascotRows(phase) : mendChatLines(phase, mendBeat(state.spinFrame, !state.reducedMotion))
  }

  const petGraphics = () => (input.screen.imageProtocol === undefined ? input.pets?.images === true : input.screen.imageProtocol !== "off")
  let mendPet: typeof import("../../pets/mend-pet") | undefined
  let mendPetLoading = false

  /**
   * Where the terminal draws pictures, the built-in Mend beside the prompt is one too: its own pixels, at the size every pet
   * of `petSize` gets (`pets/mend-pet.ts`). `loading` while that module loads; nothing where it stays half blocks or text.
   */
  function mendPictureCells(): { cols: number; rows: number } | "loading" | undefined {
    if (!petGraphics() || textMascot() || customActivityArt(activityPhase())) return undefined
    if (mendPet) return mendPet.mendChatCells(state.tuiProfile.petSize)
    if (!mendPetLoading) {
      mendPetLoading = true
      void import("../../pets/mend-pet").then((loaded) => {
        mendPet = loaded
        ctx.requestFrame()
      }).finally(() => { mendPetLoading = false })
    }
    return "loading"
  }

  /** Where colored half blocks cannot go (a 16-color palette, ASCII glyphs) Mend is v1's text mascot. */
  const asciiGlyphs = () => asciiChrome(state)
  const textMascot = () => asciiGlyphs() || activeTheme().ansi !== undefined

  /** Images are drawn only on a local alternate screen whose terminal speaks a graphics protocol, and when the profile allows them. */
  const imagesWanted = () => state.tuiProfile.transcriptImages && !input.remote && input.screen.inline !== true && (input.screen.imageProtocol ?? "off") !== "off"

  /** Asks for the images of the blocks on screen; the image module loads with the first one. */
  function wantImages(visible: ReadonlyArray<{ itemId?: ItemId }>) {
    if (!imagesWanted()) return
    const ids = new Set<ItemId>()
    for (const line of visible) if (line.itemId && state.transcript.attachmentsOf(line.itemId).some((file) => file.sha256 && file.mime.startsWith("image/"))) ids.add(line.itemId)
    // A chart on screen is painted by the same module, with nothing to fetch.
    if (!ids.size && !(state.imageCards === undefined && visible.some((line) => (line as ViewLine).image?.sha256.startsWith(CHART_KEY)))) return
    if (state.imageCards) return state.imageCards.ensure(state.sessionId, ids)
    void import("./image-cards").then(({ createImageCards }) => {
      state.imageCards ??= createImageCards(ctx)
      ctx.requestFrame()
    })
  }

  /**
   * The loaded pictures over the rows the transcript reserved for them. A picture partly scrolled out of view, or reaching a row
   * something else is drawn on, keeps the rows of it that are on screen and free: it is cut, not dropped.
   */
  function transcriptPlacements({ visible, top, labelRows, clear }: { visible: ViewLine[]; top: number; labelRows: ReadonlySet<number>; clear: ImagePlacement[] }): ImagePlacement[] {
    const cards = state.imageCards
    if (!cards || !imagesWanted()) return []
    const out: ImagePlacement[] = []
    for (let at = 0; at < visible.length; at++) {
      const image = visible[at]!.image
      if (!image) continue
      const follows = (line: ViewLine | undefined, row: number) => line !== undefined && line.itemId === visible[at]!.itemId && line.image?.sha256 === image.sha256 && line.image.index === image.index && line.image.row === row
      if (at > 0 && follows(visible[at - 1], image.row - 1)) continue
      let count = 1
      while (follows(visible[at + count], image.row + count)) count++
      const taken = (row: number) => labelRows.has(row) || clear.some((other) => row >= other.row && row < other.row + other.rows && image.col < other.col + other.cols && image.col + image.cols > other.col)
      let first = 0
      while (first < count && taken(top + at + first)) first++
      let rows = 0
      while (first + rows < count && !taken(top + at + first + rows)) rows++
      const picture = rows ? cards.place(image) : undefined
      if (picture) out.push({ slot: `transcript:${visible[at]!.itemId}:${image.index}`, key: image.sha256, image: picture, row: top + at + first, col: image.col, cols: image.cols, rows, ...(rows < image.rows ? { part: { of: image.rows, skip: image.row + first } } : {}) })
      at += count - 1
    }
    return out
  }

  /** The cells of the pet as it would be drawn in a transcript `room` rows tall; undefined when there is none or it does not fit. */
  /** A notice row as it lies over the prompt's rule: the message cut to the room and its hint kept. */
  function ruleNotice(row: Line, room: number): Line {
    const spans = row.filter((span) => span.text.trim() !== "")
    if (!spans.length) return []
    const over = spans.reduce((sum, span) => sum + textWidth(span.text), 0) - room
    const first = over > 0 ? { ...spans[0]!, text: truncateEnd(spans[0]!.text, Math.max(1, textWidth(spans[0]!.text) - over)) } : spans[0]!
    return [first, ...spans.slice(1)]
  }

  /** Mend stands beside the prompt when chosen, and in place of a pet that half blocks would draw as noise (no pictures here). */
  function drawsMend(): boolean {
    if ((state.tuiProfile.pet || state.settingsNow.pet) === "mend") return true
    const graphics = input.screen.imageProtocol === undefined ? input.pets?.images : input.screen.imageProtocol !== "off"
    return !graphics && state.pet !== undefined && !state.pet.halfBlockLegible(state.tuiProfile.petSize)
  }

  function petCells(room: number): { cols: number; rows: number } | undefined {
    if (drawsMend()) {
      const picture = mendPictureCells()
      if (picture === "loading") return undefined
      if (picture) return picture.rows <= room ? picture : undefined
      const lines = activityArt()
      return lines.length <= room ? { cols: rowsWidth(lines.map((line) => line.map((span) => span.text).join(""))), rows: lines.length } : undefined
    }
    const graphics = input.screen.imageProtocol === undefined ? input.pets?.images : input.screen.imageProtocol !== "off"
    const drawn = state.pet?.draw(state.pet.box(state.tuiProfile.petSize, !graphics), state.imageCellPixels)
    return drawn && drawn.rows <= room ? { cols: drawn.cols, rows: drawn.rows } : undefined
  }

  /**
   * The pet in the bottom-right corner above the prompt: half-block text, or blank cells under an image. It stands on the
   * prompt (`floor`: past the working line, when no panel sits above the prompt), else on the transcript's last row. It is always
   * there while the chat shows, so it never comes and goes as the transcript scrolls: a row that reaches its cells is cut short with an
   * ellipsis, except under a kitty image, which is transparent and lets the text show.
   */
  function drawPet(at: { rows: Line[]; bottom: number; floor: number; top: number; width: number; shown: boolean }): ImagePlacement[] {
    state.petArea = undefined
    if (at.shown && drawsMend()) {
      state.pet?.setVisible(false)
      const picture = mendPictureCells()
      if (picture === "loading") return []
      if (picture && mendPet) {
        if (at.bottom - picture.rows < at.top) return []
        const first = at.floor - picture.rows
        const from = at.width - PROMPT_MARGIN - picture.cols
        state.petArea = { top: first, bottom: at.floor, from, to: at.width - PROMPT_MARGIN }
        // As for an image pet: kitty's picture is transparent around Mend, the other protocols replace the cells they cover.
        if (input.screen.imageProtocol !== "kitty") for (let i = 0; i < picture.rows; i++) at.rows[first + i] = withRightBlock(at.rows[first + i]!, at.width, [{ text: " ".repeat(picture.cols) }], picture.cols)
        // iTerm2 and sixel redraw a picture by replacing it, which flickers: there Mend keeps one frame a phase, as image pets do.
        const moving = !state.reducedMotion && input.screen.imageProtocol !== "iterm2" && input.screen.imageProtocol !== "sixel"
        const drawn = mendPet.mendPicture(activityPhase(), picture.cols, picture.rows, state.imageCellPixels ?? { width: 8, height: 16 }, mendBeat(state.spinFrame, moving))
        return [{ slot: "pet", align: "bottom", key: drawn.key, image: drawn.image, row: first, col: from, cols: picture.cols, rows: picture.rows }]
      }
      const lines = activityArt()
      const cols = rowsWidth(lines.map((line) => line.map((span) => span.text).join("")))
      if (at.bottom - lines.length < at.top) return []
      // It stands where every pet does: on the prompt (`floor`), past the working line, not on the transcript's last row.
      state.petArea = { top: at.floor - lines.length, bottom: at.floor, from: at.width - PROMPT_MARGIN - cols, to: at.width - PROMPT_MARGIN }
      for (let i = 0; i < lines.length; i++) {
        const row = at.floor - lines.length + i
        at.rows[row] = withRightBlock(at.rows[row]!, at.width, lines[i]!, cols)
      }
      return []
    }
    const graphics = input.screen.imageProtocol === undefined ? input.pets?.images : input.screen.imageProtocol !== "off"
    const drawn = at.shown ? state.pet?.draw(state.pet.box(state.tuiProfile.petSize, !graphics), state.imageCellPixels) : undefined
    const draw = drawn && at.bottom - drawn.rows >= at.top ? drawn : undefined
    state.pet?.setVisible(draw !== undefined)
    if (!draw) return []
    const first = at.floor - draw.rows
    state.petArea = { top: first, bottom: at.floor, from: at.width - PROMPT_MARGIN - draw.cols, to: at.width - PROMPT_MARGIN }
    const blank: Line = [{ text: " ".repeat(draw.cols) }]
    // A kitty image lies over the text and is transparent around the pet, so the rows keep their text and show through it. The
    // other protocols replace the cells they cover, and the text pet is cells itself: for those the rows are cut at its edge.
    const seeThrough = graphics && draw.image !== undefined && input.screen.imageProtocol === "kitty"
    if (!seeThrough) for (let i = 0; i < draw.rows; i++) at.rows[first + i] = withRightBlock(at.rows[first + i]!, at.width, graphics ? blank : (draw.lines[i] ?? blank), draw.cols)
    if (!graphics || !draw.image) return []
    return [{ slot: "pet", align: "bottom", key: draw.image.key, image: draw.image.image, row: first, col: at.width - PROMPT_MARGIN - draw.cols, cols: draw.cols, rows: draw.rows }]
  }

  /** v1's working line: shown in every view while the turn works or waits, so it is always plain that the model is busy; `showActivity` and `activityPlacement off` hide it. */
  /**
   * The status for a rule or a prompt row `room` cells wide: all the parts the profile lists when they fit, else the core (spinner, phase,
   * elapsed), else the spinner and the time; a retry draws its own narrowing. `onRule` keeps a clipped line as the last resort, the prompt row
   * leaves the status out rather than show half of it.
   */
  function overlayWorking(room: number, onRule: boolean): Line | undefined {
    if (state.turnState.retry !== undefined) return workingRow(room, true)
    const listed = activityPartsOf(state.tuiProfile.activityParts)
    for (const parts of [listed, listed.filter((part) => part === "spinner" || part === "verb" || part === "elapsed"), listed.filter((part) => part === "spinner" || part === "elapsed")]) {
      const line = parts.length ? workingRow(1000, true, parts) : undefined
      if (!line) return undefined
      if (line.reduce((sum, span) => sum + textWidth(span.text), 0) <= room) return line
    }
    return onRule ? workingRow(room, true) : undefined
  }

  function workingRow(width: number, overlay = false, partsOverride?: readonly ActivityPart[]): Line | undefined {
    // Over the prompt's chrome (`activityPlacement` above or inside) the line has no margin of its own and its parts are set off by a glyph.
    const margin = overlay || state.mode === "minimal" ? 0 : META_MARGIN
    // While the leader key is armed its chords take the working row's place.
    if (leader.armedAt !== undefined && now() - leader.armedAt <= LEADER_TIMEOUT_MS)
      return [{ text: " ".repeat(margin) }, { text: truncateEnd(leaderHint(state.bindings), width - margin - (overlay ? 0 : PROMPT_MARGIN)), fg: "warning" }]
    // A sub-agent's thread open in the chat's place shows that agent at work, not the parent turn (often over while a background agent runs).
    const thread = state.agentView ? (state.agentRoot ?? state.transcript).agentThreads().find((each) => each.itemId === state.agentView) : undefined
    if (thread) {
      if (!thread.running || !state.tuiProfile.showActivity || state.tuiProfile.activityPlacement === "off") return undefined
      return renderWorkingRow({
        width,
        margin,
        parts: partsOverride ?? activityPartsOf(state.tuiProfile.activityParts),
        ...(overlay ? { separator: g.sep } : {}),
        spinner: state.reducedMotion ? "⋯" : SPINNER_FRAMES[state.spinFrame % SPINNER_FRAMES.length]!,
        phase: thread.last ? `${truncateEnd(thread.last, 60)}...` : "Working...",
        ...(state.tuiProfile.showElapsed && !state.accessible && thread.startedAt !== undefined ? { elapsedMs: now() - thread.startedAt } : {}),
        now: now(),
        interruptHint: false,
      })
    }
    const localState = state.transcript.foreground
    const retry = state.turnState.retry
    const hint = state.escArmedAt > 0 && now() - state.escArmedAt <= DOUBLE_ESC_MS && state.transcript.activeTurn !== undefined
    const active = BUSY.has(localState) || localState === "waiting_approval" || retry !== undefined
    if (!active) return undefined
    if (!state.tuiProfile.showActivity && !retry && !hint) return undefined
    // `off` keeps what the user must see (a retry, the Esc hint) and nothing else, as the minimal view does.
    if (state.tuiProfile.activityPlacement === "off" && !retry && !hint) return undefined
    // A terminal extension's `working.replace` draws in place of the spinner row whenever that row would show.
    const custom = state.ext && extOn() ? state.ext.slot("working.replace", slotContext(width - margin, 1)) : undefined
    if (custom) return renderWorkingReplacement({ width, margin, line: custom[0] ?? [], interruptHint: hint })
    const waiting = localState === "waiting_approval" ? state.transcript.pendingRequests[0]?.kind : undefined
    const current = state.turnState.current
    const modelInfo = state.modelReport?.models?.find((model) => model.id === state.effectiveModel?.model)
    const effort = state.effectiveModel?.effort ?? modelInfo?.defaultEffort
    const reasons = Boolean(modelInfo?.efforts.length) && effort !== undefined && effort !== "none"
    const quiet = quietTurn({ state: localState, ...(current ? { current } : {}), ...(state.lastEventAt !== undefined ? { lastEventAt: state.lastEventAt } : {}), now: now(), retrying: retry !== undefined, reasons })
    const silentMs = quiet.stalledMs
    // Quiet past the usual stall point but within the thinking allowance: the row says the model is thinking, not that it went silent.
    const thinkingQuietly = quiet.thinking
    // A quiet turn whose session has a background agent or command running is waiting on it, not stalled: the row names what it waits on.
    const awaited = silentMs !== undefined ? state.agentShells.find((shell) => shell.status === "running" && shell.sessionId === state.sessionId) : undefined
    // An external harness (Claude Code, Codex, pi, ACP) goes quiet for minutes while it thinks and retries its own calls; as in that
    // harness itself, the silence is not called a stall.
    const external = Boolean(modelInfo?.engine)
    const stalledMs = state.tuiProfile.showStalled && !awaited && !external ? silentMs : undefined
    const elapsedMs = state.turnState.startedAt !== undefined ? now() - state.turnState.startedAt : undefined
    return renderWorkingRow({
      width,
      margin,
      parts: partsOverride ?? activityPartsOf(state.tuiProfile.activityParts),
      stats: ctx.stats.read(),
      ...(overlay ? { separator: g.sep } : {}),
      ...(state.transcript.queue.length ? { queued: state.transcript.queue.length } : {}),
      ...(elapsedMs !== undefined && elapsedMs >= 2_000 && state.turnState.outputLive > 0 ? { tokensPerSecond: Math.round(state.turnState.outputLive / (elapsedMs / 1000)) } : {}),
      spinner: state.reducedMotion ? "⋯" : SPINNER_FRAMES[state.spinFrame % SPINNER_FRAMES.length]!,
      phase: (state.tuiProfile.activityMessages ? JSON.parse(state.tuiProfile.activityMessages)[mascotPhase({ state: localState, connected: state.connection === "connected", retry: retry !== undefined, ...(current ? { current } : {}) })] : undefined) ?? (awaited ? `Waiting on ${backgroundName(awaited.command, 48)}...` : thinkingQuietly ? "Thinking..." : phaseOf({ state: localState, ...(current ? { current } : {}), ...(waiting ? { waiting } : {}) })),
      ...(state.tuiProfile.showActivityModel && state.effectiveModel?.model ? { model: modelLabel(sessionModelId(state.effectiveModel.model, state.transcript.lastUsage?.model, state.modelReport)!, state.modelReport) } : {}),
      ...(state.tuiProfile.showElapsed && !state.accessible && state.turnState.startedAt !== undefined ? { elapsedMs: now() - state.turnState.startedAt } : {}),
      ...(retry ? { retry } : {}),
      ...(state.tuiProfile.showTokens && (state.turnState.outputLive > 0 || state.turnState.input > 0) ? { tokens: { input: state.turnState.input, output: state.turnState.outputLive, estimated: state.turnState.estimating } } : {}),
      now: now(),
      interruptHint: state.tuiProfile.showInterruptHint && hint,
      ...(stalledMs !== undefined ? { stalledMs } : {}),
    })
  }

  /** The farthest the transcript scrolls up: its first line at the top of the viewport, never blank rows above it. */
  function maxScroll() {
    return Math.max(0, state.transcript.totalLines(actions.transcriptWidth()) - state.lastBodyHeight)
  }

  /** Remembers that the transcript just moved and, for the `auto` scrollbar, asks for one more frame when it should go away again. */
  let lingerTimer: ReturnType<typeof setTimeout> | undefined
  function noteScrolled() {
    state.scrollbarAt = now()
    if (lingerTimer) clearTimeout(lingerTimer)
    if (state.tuiProfile.scrollbar !== "auto") return
    lingerTimer = setTimeout(() => ctx.requestFrame(), SCROLLBAR_LINGER_MS + 40)
    lingerTimer.unref?.()
  }

  function scrollTranscript(lines: number) {
    noteScrolled()
    state.clearFrom = undefined
    const pastTop = lines > 0 && view.get(state.sessionId).offset + lines > maxScroll()
    // Up from the top of the laid-out window lays out the next slice of older blocks (all of them for Home).
    if (lines > 0 && state.transcript.olderBlocks > 0) {
      if (lines === Number.MAX_SAFE_INTEGER) while (state.transcript.olderBlocks > 0) state.transcript.loadOlder()
      else if (view.get(state.sessionId).offset >= maxScroll()) state.transcript.loadOlder()
    }
    view.scroll(state.sessionId, lines, maxScroll())
    if (pastTop && state.transcript.olderBlocks === 0) void actions.loadEarlier()
  }

  return { chatRows, homeRoot, homeSessions, homeMascot, maxScroll, scrollTranscript }
}
