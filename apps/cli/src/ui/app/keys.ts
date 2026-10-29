import type { createSession } from "./session"
import { modelWithEffort } from "../../view/model-label"
import { chipRowAttachments, liveAttachments } from "../../view/attachments"
import type { createScratch } from "./scratch"
import type { createGoal } from "./goal"
import type { createPrompt } from "./prompt"
import type { createAside } from "./aside"
import type { createModel } from "./model"
import type { createAgents } from "./agents"
import { noteRecent } from "../../view/model-prefs"
import type { PermissionMode, ModelsReport } from "@mendcode/protocol"
import { COMMENT_KEY, LEADER_TIMEOUT_MS, resolveKey, type BindingAction } from "../keymap"
import type { TuiActions } from "@mendcode/extension-api"
import { nextVariantChoice, nextModelChoice } from "../model-cycle"
import { answersForItself, parseSlash, runsOnSelect, takesArguments } from "../../view/commands"
import { shellPlaceholderFor } from "../../view/prompt-chrome"
import { projectSessions, SIDEBAR_WIDTH } from "../../view/sidebar"
import { approvalChoicesOf, type ApprovalChoice, type PanelRequest } from "../../view/request-panel"
import type { AppContext } from "./context"
import { EDIT_ACTIONS, type EditAction } from "../../view/editor-actions"
import type { AgentsReport } from "@mendcode/protocol"
import { homeVisibleSessions, type HomeSession } from "../../view/home"
import { PERMISSION_MODES, MOUSE_SGR } from "./constants"
import { rightBarCells } from "../../view/right-bar"
import { rightClick } from "../selection"
import { createMouseSelection } from "./mouse-selection"
import { createDetails } from "./details"
import { createOptionKeys } from "./option-keys"
import { createBlockCopy } from "./block-copy"
import { footerShowsModel } from "../../view/tui-profile"
import { fileInSlot, panelWanted } from "./file-slot"
import { queuePolicy } from "./queue-policy"

export function createKeys(ctx: AppContext, actions: {
  slashMenu: ReturnType<typeof import("./slash-menu").createSlashMenu>
  /** Esc while dictating drops the clip; false when nothing is being dictated. */
  cancelVoice(): boolean
  /** Holding space on the plain prompt dictates; true when the key was taken for it. */
  voiceKey(key: string): boolean
  /** The find bar's keys while it is open (false lets a key through). */
  findKey(key: string): Promise<boolean>
  openFind(query?: string): void
  composer: ReturnType<typeof import("./composer-recovery").createComposerRecovery>
  stopConsole(): void
  compactionLive: ReturnType<typeof import("./compaction-live").createCompactionLive>
  openAgent(id: string): Promise<void>
  /** A click on a card of the chat: true when it was a sub-agent's call and that sub-agent is being opened. */
  openAgentCard(itemId: import("@mendcode/protocol").ItemId): boolean
  navigateSession(action: import("./subagents").SessionNavigation): Promise<boolean>
  releaseBackgroundWriter(): Promise<void>
  /** Keys while a return prompt is open (true when it took the key). */
  returnKey(key: string): Promise<boolean>
  psKey(key: string): Promise<boolean>
  stashKey(key: string): void
  draftsKey(key: string): Promise<void>
  queueKey(key: string): Promise<void>
  restoreUnsent: ReturnType<typeof createPrompt>["restoreUnsent"]
  scratchKey: ReturnType<typeof createScratch>["scratchKey"]
  endScratchEdit: ReturnType<typeof createScratch>["endScratchEdit"]
  endGoalEdit: ReturnType<typeof createGoal>["endGoalEdit"]
  syncMentions: ReturnType<typeof createPrompt>["syncMentions"]
  paletteInput: (key: string) => Promise<void>
  openPalette: () => Promise<void>
  scrollTranscript: (lines: number) => void
  pageKey: (key: string) => Promise<void>
  suggestionPool: ReturnType<typeof createPrompt>["suggestionPool"]
  runSlash: (text: string) => Promise<boolean>
  chatWidth: () => number
  /** The columns the transcript's text is laid out in (the chat column less the scrollbar's). */
  transcriptWidth: () => number
  pickApproval: (index: number) => Promise<void>
  pickQuestion: (index: number) => void | Promise<void>
  questionKey: (key: string) => Promise<boolean>
  planReviewKey: (key: string) => Promise<boolean>
  pasteClipboardImage: ReturnType<typeof createPrompt>["pasteClipboardImage"]
  pendingPanelRequest: () => (PanelRequest & { kind: "approval" | "question"; }) | undefined
  tuiActions: TuiActions
  rewind: ReturnType<typeof createSession>["rewind"]
  confirmGoalPrompt: ReturnType<typeof createGoal>["confirmGoalPrompt"]
  /** ctrl+s with the usage-limit bar open (false when it is not) and a click on one of its chips. */
  limitKey: () => Promise<boolean>
  limitClick: (row: number, col: number) => Promise<boolean>
  /** esc with an armed auto-resume in the minimal view, where the one muted line says `esc cancel` (false when it does not apply). */
  limitEscape: () => Promise<boolean>
  /** esc while `/reload` or `/restart` waits for the response: the wait is dropped (false when nothing waits). */
  cancelWait: () => boolean
  rightKey: (key: string) => Promise<boolean>
  /** The file viewer's controller as the terminal sees it before it is loaded (`file-open.ts`). */
  fileOpen: ReturnType<typeof import("./file-open").createFileOpen>
  asideKey: ReturnType<typeof createAside>["asideKey"]
  modelQuickKey(key: string): Promise<void>
  scrollAside: ReturnType<typeof createAside>["scrollAside"]
  recallOlder: ReturnType<typeof createPrompt>["recallOlder"]
  recallNewer: ReturnType<typeof createPrompt>["recallNewer"]
  ranCommand: ReturnType<typeof createPrompt>["ranCommand"]
  keepDiscarded: ReturnType<typeof createPrompt>["keepDiscarded"]
  onEscape: () => Promise<void>
  scrollApproval: (direction: -1 | 1) => boolean
  resolveRequest: (choice: ApprovalChoice["choice"]) => Promise<void>
  toggleApprovalExplain: () => boolean
  submit: () => Promise<void>
  loadCustomCommands: ReturnType<typeof createPrompt>["loadCustomCommands"]
  runExtensionCommand: (text: string) => Promise<boolean>
  openExtensionPage: (id: string) => void
  openExtensionModal: (id: string) => void
  /** A key while an extension modal is open: the modal takes every key but the mouse. */
  extensionModalKey: (key: string) => void
  runExtensionAction: (id: string) => boolean
  loadAgentShells: ReturnType<typeof createAgents>["loadAgentShells"]
  editScratch: ReturnType<typeof createScratch>["editScratch"]
  undoEdit: ReturnType<typeof createPrompt>["undoEdit"]
  stashPrompt: ReturnType<typeof createPrompt>["stashPrompt"]
  restoreStash: ReturnType<typeof createPrompt>["restoreStash"]
  editInExternalEditor: ReturnType<typeof createPrompt>["editInExternalEditor"]
  copyAnswer: ReturnType<typeof createPrompt>["copyAnswer"]
  setPermission: (next: PermissionMode) => Promise<void>
  takeModels: ReturnType<typeof createModel>["takeModels"]
  changeModelPrefs: ReturnType<typeof createModel>["changeModelPrefs"]
  switchSession: ReturnType<typeof createSession>["switchSession"]
  homeSessions: () => HomeSession[]
  navigateMessage(kind: "next" | "previous" | "last-user"): Promise<void>
  /** `file.open`: the first file path of the selection or the item in view (a list when there are several). */
  openPathInView(): Promise<void>
  /** A left click on the Changes page: a file of its list or the heading of its diff opens in the viewer. */
  changesClick(at: { row: number; col: number }): boolean
  gitClick(at: { row: number; col: number }): Promise<boolean>
}) {
  const { input, state, now, editor, say, fail, requestFrame, drafts, random, leader } = ctx
  const details = createDetails(ctx, { chatWidth: () => actions.transcriptWidth() })
  const blockCopy = createBlockCopy(ctx, { chatWidth: () => actions.transcriptWidth() })
  const mouseSelection = createMouseSelection(ctx, { by: (rows) => actions.scrollTranscript(rows), width: () => actions.transcriptWidth(), offset: () => ctx.view.get(state.sessionId).offset, fold: details.click, card: (itemId) => actions.openAgentCard(itemId), openPath: (text, at) => actions.fileOpen.clickPath(text, at), openUrl: (url) => void input.send({ type: "url.open", url }).then((reply) => { if (!reply.ok) fail(`not opened: ${reply.error.message}`) }), openImage: (path, reveal) => void input.send({ type: "image.open", path, ...(reveal ? { reveal: true } : {}) }).then((reply) => { if (!reply.ok) fail(`not opened: ${reply.error.message.replace(/^\[[A-Z]+\]: /, "")}`) }) })
  const vim = ctx.vim
  const optionKeys = createOptionKeys(ctx)
  /** Vim mode applies to the prompt while the setting is on; switching it off drops back to plain insert. */
  function vimOn() {
    if (!state.tuiProfile.vimMode && vim.mode !== "insert") vim.reset()
    return state.tuiProfile.vimMode
  }
  const vimLive = () => vimOn() && !actions.pendingPanelRequest()
  /** Enter inserts a newline while `/multiline` is on, except for a slash command (one line), shell mode and an answer to a pending request. */
  const multilineOn = () => state.tuiProfile.multiline && !state.shellMode && !actions.pendingPanelRequest() && !state.editingScratch && !state.editingGoal && !state.editingMemory && !state.planDraft && !(editor.lines().length === 1 && editor.text.startsWith("/"))
  const { endScratchEdit, endGoalEdit, syncMentions, paletteInput, openPalette, scrollTranscript, pageKey, suggestionPool, runSlash, chatWidth, pickApproval, pickQuestion, pasteClipboardImage, pendingPanelRequest, tuiActions, rewind, confirmGoalPrompt, scrollAside, recallOlder, recallNewer, onEscape, scrollApproval, resolveRequest, toggleApprovalExplain, submit, loadCustomCommands, runExtensionCommand, openExtensionPage, loadAgentShells, editScratch, undoEdit, stashPrompt, restoreStash, editInExternalEditor, copyAnswer, setPermission, takeModels, changeModelPrefs } = actions

  /** A left-button press as a 0-based screen position; undefined for any other key or mouse report. */
  function clickOf(key: string): { row: number; col: number } | undefined {
    const match = /^\x1b\[<0;(\d+);(\d+)M$/.exec(key)
    return match ? { col: Number(match[1]) - 1, row: Number(match[2]) - 1 } : undefined
  }

  function wheelOf(key: string): -1 | 1 | undefined {
    const match = MOUSE_SGR.exec(key)
    if (!match) return undefined
    const button = Number(match[1]) & ~(4 | 8 | 16)
    return button === 64 ? -1 : button === 65 ? 1 : undefined
  }

  /** A plain prompt: not an edit card (scratch, goal, memory, plan), a question or a menu. Only its text counts as a draft. */
  const plainPrompt = () => state.page === "chat" && !state.palette && !state.promptSearch && !state.editingScratch && !state.editingGoal && !state.editingMemory && !state.planDraft && !actions.pendingPanelRequest()

  /**
   * Any key that empties a prompt holding worthwhile text without sending it (ctrl+c, ctrl+u, a select-all delete, undo of a
   * paste…) saves that text as a draft entry of the project's history, with a one-line toast.
   */
  async function onKey(key: string) {
    const before = plainPrompt() ? editor.text : ""
    const submits = state.submits
    await handleKey(key)
    // An edit of a recalled entry makes it the text being typed: ↑/↓ no longer jump through the history from the middle of it.
    if (state.recall.index >= 0 && editor.text !== state.recall.shown) state.recall.index = -1
    // A key that opens another page with the prompt's text (the sessions picker, a model list…) takes the text out of the prompt too.
    if (before && editor.isEmpty() && state.submits === submits) void actions.keepDiscarded({ text: before, toast: true })
  }

  async function handleKey(typed: string) {
    // Before anything drops the selection or types the key: Option+Q arriving as `œ` is the comment key where that key means something (ui/app/option-keys.ts).
    const key = optionKeys.rewrite(typed, plainPrompt() && !MOUSE_SGR.test(typed) && !(vimLive() && vim.mode !== "insert"))
    // The tutorial's practice chat is a whole terminal of its own: every key (ctrl+c and esc included) is its, never this one's.
    if (state.page === "tutorial") return MOUSE_SGR.test(key) ? undefined : pageKey(key)
    // An extension modal owns the keyboard while it is open, ctrl+c included (it closes the modal); mouse reports are dropped.
    if (state.extModalId) return MOUSE_SGR.test(key) ? undefined : actions.extensionModalKey(key)
    if (await actions.planReviewKey(key)) return requestFrame()
    if (state.page === "chat" && state.editingScratch) return actions.scratchKey(key)
    // The compaction arcade owns every key but the mouse while it has focus; the prompt sees none of them.
    if (state.page === "chat" && actions.compactionLive.focused() && !MOUSE_SGR.test(key)) return actions.compactionLive.playKey(key)
    // A kept mouse selection: ctrl+c copies it; any other key drops it.
    const globalKey = state.bindings.direct.get(key)
    // ctrl+x then w is the comment key too: ctrl+x keeps a kept selection and the offer after a copy for the chord, and so does the chord itself.
    const armed = leader.armedAt !== undefined && now() - leader.armedAt <= LEADER_TIMEOUT_MS
    const chord = armed ? state.bindings.leader.get(key) ?? state.bindings.leader.get(key.toLowerCase()) : undefined
    // The actions that work on the selection keep it: quoting or commenting on it, and opening the file paths inside it.
    const usesSelection = (action: string) => action === "selection.quote" || action === "selection.comment" || action === "file.open"
    const commentChord = chord !== undefined && "action" in chord && usesSelection(chord.action)
    const leading = key === state.bindings.leaderKey && !armed && (state.selection !== undefined || ctx.comments.offering())
    const quoting = commentChord || leading || globalKey && "action" in globalKey && usesSelection(globalKey.action)
    if (!commentChord && !leading) ctx.comments.noteInput(key)
    if (state.selection && !MOUSE_SGR.test(key) && !quoting && mouseSelection.onKey(key)) return
    // The comment modes (composing, the list, the reply mode) take their keys here; a key that is not theirs closes the mode and goes on.
    if (state.page === "chat" && !state.palette && ctx.comments.modal() && !pendingPanelRequest() && ctx.comments.key(key)) return requestFrame()
    if (state.returnPrompt && state.page === "chat" && await actions.returnKey(key)) return requestFrame()
    if (state.psCard && state.page === "chat" && await actions.psKey(key)) return requestFrame()
    if (globalKey && "action" in globalKey && globalKey.action === "terminal.suspend") return runKeyAction(globalKey.action)
    // The find bar owns the keyboard while it is open; the wheel and the paging keys still scroll the transcript.
    if (state.page === "chat" && state.find && await actions.findKey(key)) return
    // The prompt-history search bar takes the keyboard the same way (the wheel and paging keys still scroll).
    if (state.page === "chat" && state.promptSearch && await actions.composer.searchKey(key)) return requestFrame()
    if (state.page === "compaction" && state.compactionView?.editing) return pageKey(key)
    const { width, height } = input.screen.size
    // The keymap editor waiting for a key takes ctrl+c too (it is reserved, and says so) instead of quitting.
    if (key === "\x03" && state.page === "keymap" && state.keymapState?.capture) return pageKey(key)
    if (key === "\x03" && await actions.questionKey(key)) return requestFrame()
    if (key === "\x03") {
      if (state.modelQuick) {
        state.modelQuick = undefined
        return requestFrame()
      }
      // v1: Ctrl+C clears what is typed; it exits only from an empty prompt (or any other page).
      if (state.page === "chat" && !state.palette && state.editingScratch) return endScratchEdit()
      if (state.page === "chat" && !state.palette && state.editingGoal) return endGoalEdit()
      if (state.page === "chat" && !state.palette && !editor.isEmpty()) {
        editor.clear()
        state.planDraft = undefined
        state.suggestion = 0
        syncMentions()
        return requestFrame()
      }
      if (state.page === "chat" && !state.palette && state.shellMode) {
        state.shellMode = false
        return requestFrame()
      }
      // An empty prompt with comments pending: ctrl+c keeps them as a draft instead of leaving; a second one leaves as usual.
      if (state.page === "chat" && !state.palette && ctx.comments.ctrlC()) return requestFrame()
      if (state.rightTick) {
        clearInterval(state.rightTick)
        state.rightTick = undefined
      }
      state.ideStopped = true
      if (state.ideTimer) { clearInterval(state.ideTimer); state.ideTimer = undefined }
      if (state.pulse) clearInterval(state.pulse)
      drafts.flush()
      await actions.releaseBackgroundWriter()
      // Extensions stop what they started (a helper process) before the terminal goes.
      await state.ext?.dispose()
      actions.stopConsole()
      return input.exit()
    }
    const scratchClick = clickOf(key)
    if (state.page === "chat" && scratchClick && state.scratchArea && scratchClick.row >= state.scratchArea.top && scratchClick.row < state.scratchArea.top + state.scratchArea.rows && scratchClick.col >= state.scratchArea.left && scratchClick.col < state.scratchArea.left + state.scratchArea.width) return editScratch()
    // The keys that move the keyboard or the right slot are keymap keys: where one is bound it acts at once, from any row; unbound (keybindings.json), alt+} and alt+{ do nothing.
    const slotKey = state.bindings.direct.get(key)
    const slotAction = slotKey && "action" in slotKey && (slotKey.action === "panel.focus" || slotKey.action === "file.switch") ? slotKey.action : undefined
    if (slotAction) return runKeyAction(slotAction)
    if (key !== "\x1b}" && key !== "\x1b{" && await actions.fileOpen.key(key)) return
    if (key !== "\x1b}" && await actions.rightKey(key)) return
    if (actions.asideKey(key)) return
    // The quick model switch owns the keyboard while it is open, mouse reports included.
    if (state.modelQuick && state.page === "chat" && !state.palette) return actions.modelQuickKey(key)
    if (state.palette) return paletteInput(key)
    if (state.page === "chat" && await actions.compactionLive.enterKey(key)) return requestFrame()
    if (state.bindings.inline.get(key) === "palette" && state.page === "chat" && !state.transcript.pendingRequests.some((request) => request.kind === "approval")) return openPalette()
    const wheel = wheelOf(key)
    if (wheel !== undefined) {
      const notch = state.tuiProfile.wheelLines
      // A transcript selection stays on its text while the wheel moves it, so a drag can reach past one screen.
      if (state.page === "chat") mouseSelection.scrollUnder(-wheel * notch)
      else state.selection = undefined
      if (state.page === "sessions" || state.page === "changes") for (let i = 0; i < (state.page === "changes" ? notch : 1); i++) await pageKey(wheel < 0 ? "\x1b[A" : "\x1b[B")
      // Pages that read like a list scroll the way their keys do: help by lines, settings by rows (not while a value is typed), context by pages.
      else if (state.page === "help") for (let i = 0; i < notch; i++) await pageKey(wheel < 0 ? "\x1b[A" : "\x1b[B")
      else if (state.page === "settings" && !state.settingsPageState.tui && state.settingsPageState.typing === undefined) await pageKey(wheel < 0 ? "\x1b[A" : "\x1b[B")
      else if (state.page === "context") await pageKey(wheel < 0 ? "\x1b[5~" : "\x1b[6~")
      return requestFrame()
    }
    const menu = state.page === "chat" && editor.lines().length === 1 && !state.shellMode && !pendingPanelRequest() ? actions.slashMenu.model(chatWidth(), Math.max(3, height - 9)) : undefined
    const suggestions = menu?.items ?? []
    const mentionActive = state.page === "chat" && !state.shellMode && suggestions.length === 0 && state.mentionToken !== undefined && state.mentionResults.length > 0
    const complete = async (index: number, textOnly = false) => {
      const command = suggestions[index]?.command
      if (!command) return
      // A command of a feature that is off runs nothing: its row and the notice name the switch that turns it on (docs/commands.md).
      const gated = suggestions[index]?.gated
      if (gated) {
        if (!textOnly) editor.clear()
        say(`/${command.name} ${gated}`, "info")
        return requestFrame()
      }
      state.suggestion = 0
      editor.clear()
      // An argument word: Tab writes it and a space; Enter sends the line as typed, unless another word has to follow.
      if (command.argument) {
        editor.insert(`/${command.name}${textOnly || command.argument.more ? " " : ""}`)
        if (!textOnly && !command.argument.more) return submit()
        return requestFrame()
      }
      if (!textOnly && (command.setting || runsOnSelect(command))) {
        state.submits++
        actions.ranCommand(`/${command.name}`)
      }
      if (!textOnly && command.setting) await runSlash(`/settings ${command.setting}`)
      else if (!textOnly && runsOnSelect(command)) await runSlash(`/${command.name}`)
      else editor.insert(`/${command.name}${takesArguments(command) ? " " : ""}`)
      return requestFrame()
    }
    const closeMentions = () => {
      state.mentionToken = undefined
      state.mentionResults = []
      state.mentionLastQuery = undefined
      return requestFrame()
    }
    const completeMention = (index: number) => {
      const entry = state.mentionResults[index]
      if (!entry || !state.mentionToken) return closeMentions()
      editor.replaceCurrentLine(state.mentionToken.start, editor.cursor.col, `${state.mentionToken.slash ? "/" : "@"}${entry.path} `)
      return closeMentions()
    }
    const mouse = /^\x1b\[<(\d+);(\d+);(\d+)[Mm]$/.exec(key)
    // A right click pastes the clipboard into the prompt when `rightClickPaste` is on (the daemon reads it; never for a remote client).
    if (state.page === "chat" && state.tuiProfile.rightClickPaste && rightClick(key) && !pendingPanelRequest() && !state.editingScratch && !state.editingGoal && !state.editingMemory) return pasteClipboardImage()
    const rightWanted = panelWanted(state) || fileInSlot(state)
    // The same width the layout gives the bar (a set `sidebarWidth`, the hysteresis), or the mouse offsets drift from what is drawn.
    const rightCells = rightWanted ? rightBarCells({ columns: width, setting: state.tuiProfile.sidebarWidth, collapsed: state.rightBarCollapsed }).cells : 0
    const rightWidth = rightCells ? rightCells + 1 : 0
    const sideWidth = state.page === "chat" ? width - chatWidth() - rightWidth : 0
    const onRight = !rightWidth && state.tuiProfile.sidebarSide === "right"
    const offset = onRight ? 0 : sideWidth
    if (mouse && state.page === "chat" && mouseSelection.onMouse(key, offset)) return
    if (mouse && state.page === "chat") {
      const col = Number(mouse[2]) - 1 - offset
      const row = Number(mouse[3]) - 1
      const area = state.petArea
      const petHover = !!area && row >= area.top && row < area.bottom && col >= area.from && col < area.to
      if (state.petHover !== petHover) {
        state.petHover = petHover
        if (petHover) state.pet?.cheer("waving")
        requestFrame()
      }
      mouseSelection.hover(row, col)
      const homeHover = state.homeArea?.hits.find((hit) => row === state.homeArea!.top + hit.row && col >= hit.from && col < hit.to)?.sessionId
      if (state.homeHover !== homeHover) {
        state.homeHover = homeHover
        // The pointer becomes a hand over a row a click opens, as over a web address (OSC 22).
        input.screen.write?.(homeHover ? "\x1b]22;pointer\x1b\\" : "\x1b]22;default\x1b\\")
        requestFrame()
      }
      const hover = row === 0 && !!state.contextArea && col >= state.contextArea.from && col < state.contextArea.to
      if (state.contextHover !== hover) {
        state.contextHover = hover
        requestFrame()
      }
    }
    const screenClick = clickOf(key)
    if (screenClick && state.page === "chat" && (onRight ? screenClick.col >= width - sideWidth : screenClick.col < offset)) {
      const hit = (onRight ? screenClick.col >= width - sideWidth : screenClick.col < SIDEBAR_WIDTH) ? state.sidebarHits?.find((hit) => hit.row === screenClick.row) : undefined
      if (hit) await actions.switchSession(hit.sessionId as typeof state.sessionId)
      return requestFrame()
    }
    const click = screenClick ? { ...screenClick, col: screenClick.col - offset } : undefined
    if (click && state.page === "chat" && actions.compactionLive.click(click)) return requestFrame()
    // A click on a row of the Agents strip opens that sub-agent: its session, or its thread when it lives inside this one.
    const agentHit = click && state.page === "chat" && state.agentsArea ? state.agentsArea.ids[click.row - state.agentsArea.top] : undefined
    if (agentHit) {
      await actions.openAgent(agentHit)
      return requestFrame()
    }
    const home = click && state.page === "chat" ? state.homeArea?.hits.find((hit) => click.row === state.homeArea!.top + hit.row && click.col >= hit.from && click.col < hit.to) : undefined
    if (home) {
      state.homeSelected = undefined
      state.homeHover = undefined
      await actions.switchSession(home.sessionId as typeof state.sessionId)
      return requestFrame()
    }
    if (click && state.page === "chat" && click.row === 0 && state.contextArea && click.col >= state.contextArea.from && click.col < state.contextArea.to) return requestFrame()
    if (state.page === "chat" && leader.armedAt === undefined && state.tuiProfile.homeRightPanel === "agentManager" && state.transcript.blocks().length === 0 && !state.paging?.more && !state.paging?.loading && !pendingPanelRequest() && editor.isEmpty()) {
      const sessions = homeVisibleSessions(actions.homeSessions()).filter((session) => session.id)
      const selected = sessions.findIndex((session) => session.id === state.homeSelected)
      // Down enters the list; up stays the prompt's history until a row is selected.
      if (sessions.length && (key === "\x1b[B" || (key === "\x1b[A" && selected >= 0))) {
        const next = selected < 0 ? 0 : (selected + (key === "\x1b[B" ? 1 : -1) + sessions.length) % sessions.length
        state.homeSelected = sessions[next]!.id
        return requestFrame()
      }
      if (key === "\x1b" && state.homeSelected) {
        state.homeSelected = undefined
        return requestFrame()
      }
      if (key === "\r" && selected >= 0) {
        state.homeSelected = undefined
        await actions.switchSession(sessions[selected]!.id as typeof state.sessionId)
        return requestFrame()
      }
    }
    if (state.page === "chat" && sideWidth > 0 && !pendingPanelRequest() && !state.editingScratch && !state.editingGoal && !suggestions.length && !mentionActive) {
      const sessions = projectSessions(state.sessions, input.directory ?? "")
      if (!state.sidebarFocus && (onRight ? key === "\x1b[C" : key === "\x1b[D") && editor.isEmpty()) {
        state.sidebarFocus = true
        state.sidebarSelected = state.sessionId
        return requestFrame()
      }
      if (state.sidebarFocus && !mouse) {
        const index = Math.max(0, sessions.findIndex((session) => session.sessionId === (state.sidebarSelected ?? state.sessionId)))
        if (key === "\x1b[A" || key === "\x1b[B") state.sidebarSelected = sessions[Math.max(0, Math.min(sessions.length - 1, index + (key === "\x1b[B" ? 1 : -1)))]?.sessionId
        else if (key === "\r" && sessions[index]) {
          state.sidebarFocus = false
          await actions.switchSession(sessions[index]!.sessionId)
        } else if (key === "\x1b" || (onRight ? key === "\x1b[D" : key === "\x1b[C")) state.sidebarFocus = false
        return requestFrame()
      }
    } else state.sidebarFocus = false
    if (click && state.popupArea && suggestions.length && click.row >= state.popupArea.top && click.row < state.popupArea.top + state.popupArea.count) {
      const index = actions.slashMenu.hit(click.row - state.popupArea.top, chatWidth(), Math.max(3, height - 9))
      if (index !== undefined && suggestions[index]?.command) return complete(index)
    }
    if (click && state.mentionPopupArea && mentionActive && click.row >= state.mentionPopupArea.top && click.row < state.mentionPopupArea.top + state.mentionPopupArea.count) {
      const index = state.mentionPopupArea.first + (click.row - state.mentionPopupArea.top)
      if (index < state.mentionResults.length) return completeMention(index)
    }
    if (click && state.page === "chat") {
      const hit = state.requestArea?.hits.find((candidate) => click.row === state.requestArea!.top + candidate.row && (candidate.from === undefined || click.col >= candidate.from && click.col < candidate.to!))
      if (state.requestArea && hit) return state.requestArea.kind === "approval" ? pickApproval(hit.index) : pickQuestion(hit.index)
      const chip = state.sendChipArea
      if (chip && click.row === chip.row && click.col >= chip.from && click.col < chip.to) return promoteQueued()
      if (await actions.limitClick(click.row, click.col)) return
    }
    // The Changes page is the one page with clickable parts (a file opens in the viewer); every other page ignores the mouse.
    const pageClick = state.page === "changes" ? clickOf(key) : undefined
    // Inside the Git page the first row is the tabs row; the rows below it are the Changes page, one row lower than it draws itself.
    if (state.page === "changes" || state.page === "git-commit" || state.page === "git-pr" || state.page === "git-init" || state.page === "worktrees" || state.page === "warp") {
      const tabClick = clickOf(key)
      if (tabClick && await actions.gitClick(tabClick)) return
    }
    if (pageClick && actions.changesClick(pageClick)) return
    if (MOUSE_SGR.test(key)) return
    if (state.page === "stash") return actions.stashKey(key)
    if (state.page === "drafts") return actions.draftsKey(key)
    if (state.page === "queue") return actions.queueKey(key)
    if (state.page !== "chat") return pageKey(key)
    if (await actions.questionKey(key)) return requestFrame()
    // After alt+j / alt+shift+j the next character is where the cursor goes; anything else cancels the jump and acts as usual.
    if (editor.jumpPending) {
      const jumped = /^[^\x00-\x1f\x7f\x1b]$/u.test(key) && editor.jumpTo(key)
      if (editor.jumpPending) editor.cancelJump()
      if (jumped || /^[^\x00-\x1f\x7f\x1b]$/u.test(key)) return requestFrame()
    }
    // The shortcut overlay closes on any key, which then acts as usual; `?` on an empty prompt opens it (`??` types a question mark).
    const overlayWasOpen = state.shortcuts
    if (overlayWasOpen) {
      state.shortcuts = false
      if (key === "\x1b") return requestFrame()
    }
    if (key === "?" && !overlayWasOpen && state.tuiProfile.shortcutOverlay && editor.isEmpty() && liveAttachments(state.attachments, editor.text).length === 0 && !state.shellMode && !pendingPanelRequest() && !state.editingScratch && !state.editingGoal && !state.editingMemory && !state.planDraft && !(vimLive() && vim.mode !== "insert")) {
      state.shortcuts = true
      return requestFrame()
    }
    // A bracketed paste already inserts clipboard text on its own (onPaste/onInput); Ctrl+V (\x16) is
    // the terminal's separate forwarded keypress, used here only to pull an image off the clipboard.
    // Vim mode: Esc leaves insert and visual mode (a mention popup closes first), ctrl+r redoes in normal mode instead of restoring a draft.
    if (vimLive() && (key === "\x1b" ? (vim.mode !== "normal" || vim.pending !== "") && !mentionActive : key === "\x12" && vim.mode !== "insert")) {
      vim.key(key)
      return requestFrame()
    }
    if (state.bindings.inline.get(key) === "image.paste") return pasteClipboardImage()
    if (state.bindings.inline.get(key) === "drafts.restore" && !pendingPanelRequest() && !state.editingScratch && !state.editingGoal) return void await actions.restoreUnsent()
    // v1's keymap: ctrl+x chords, ctrl+t, F2/F3. Not while a popup or a request owns the keys.
    // The tray editor owns all editing keys while its scratchpad has focus.
    if (!suggestions.length && !mentionActive && !pendingPanelRequest() && !state.editingScratch && !state.editingGoal) {
      const resolved = resolveKey(leader, key, now(), state.bindings)
      if (resolved.kind === "armed") {
        if (state.leaderTimer) clearTimeout(state.leaderTimer)
        state.leaderTimer = setTimeout(() => {
          state.leaderTimer = undefined
          leader.armedAt = undefined
          requestFrame()
        }, LEADER_TIMEOUT_MS)
        state.leaderTimer.unref?.()
        return requestFrame()
      }
      if (resolved.kind !== "pass" && state.leaderTimer) (clearTimeout(state.leaderTimer), (state.leaderTimer = undefined))
      if (resolved.kind === "cancelled") return requestFrame()
      if (resolved.kind === "action") return runKeyAction(resolved.action, key)
      if (resolved.kind === "run") {
        state.ext?.runKey(resolved, tuiActions)
        return requestFrame()
      }
    }
    if (state.voice && key === "\x1b") { actions.cancelVoice(); return }
    if (plainPrompt() && actions.voiceKey(key)) return requestFrame()
    // The undo/redo card owns esc (and `y` on an empty prompt when it asks to overwrite changed files); typing goes on underneath.
    if (state.rewindCard && key === "\x1b") {
      state.rewindCard = undefined
      return requestFrame()
    }
    if (state.rewindCard?.state === "conflict" && key === "y" && editor.isEmpty()) {
      const { kind, atItemId, prompt, images } = state.rewindCard
      state.rewindCard = undefined
      await rewind(kind, true, atItemId, prompt, images)
      return requestFrame()
    }
    // The /goal card owns esc, and `y` on an empty prompt when it asks something; typing goes on underneath.
    if (state.goalPrompt && key === "\x1b") {
      state.goalPrompt = undefined
      return requestFrame()
    }
    if (state.goalPrompt && state.goalPrompt.kind !== "summary" && key === "y" && editor.isEmpty()) {
      await confirmGoalPrompt()
      return requestFrame()
    }
    // The /fetch card owns Esc; side-chat input is handled before the main prompt.
    if (state.fetchFacts && key === "\x1b") {
      state.fetchFacts = undefined
      return requestFrame()
    }
    // The prompt's own keys (PgUp, ctrl+o, shift+tab…) by what they do now, after keybindings.json.
    const inline = state.bindings.inline.get(key)
    // v1: `!` as the first character of an empty prompt switches to shell mode and is consumed. Not while a request waits (typing then answers it).
    if (key.startsWith("!") && !state.shellMode && !state.editingMemory && editor.isEmpty() && !pendingPanelRequest() && !(vimLive() && vim.mode !== "insert")) {
      state.shellMode = true
      state.shellPlaceholder = shellPlaceholderFor(random())
      editor.insert(key.slice(1))
      return requestFrame()
    }
    if ((key === "\x7f" || key === "\b") && state.shellMode && editor.isEmpty()) {
      state.shellMode = false
      return requestFrame()
    }
    // A fully typed command name is simply submitted (so `/attach` with no path reports its usage); anything shorter completes the highlighted one.
    if (menu && actions.slashMenu.key(key)) return requestFrame()
    const selected = Math.min(state.suggestion, suggestions.length - 1)
    // Enter on the exact name of a switched-off command answers with its hint even while a looser match is highlighted first.
    const typedName = key === "\r" && state.suggestion === 0 ? parseSlash(editor.text)?.command.name : undefined
    const gatedAt = suggestions.findIndex((_, index) => {
      const { gated, command } = suggestions[index]!
      return !!gated && !!command && !answersForItself(command.name) && ((index === selected && (key === "\t" || key === "\r")) || command.name === typedName)
    })
    if (gatedAt >= 0) return complete(gatedAt, key === "\t")
    const chosen = suggestions[selected]?.command
    // Enter on a half-typed argument word (`/pr rev`) takes the highlighted one, like a half-typed command; a word that only contains what was typed
    // (`/sandbox on`, read-only) is never taken for it, and on a blank word Enter runs the command as typed.
    const typedArgument = editor.text.trim().toLowerCase()
    const halfArgument = chosen?.argument && /\S$/.test(editor.text) && typedArgument !== `/${chosen.name}` && `/${chosen.name}`.startsWith(typedArgument)
    if (chosen && (key === "\t" || key === "\r" && ((!parseSlash(editor.text) && editor.text !== `/${chosen.name}`) || halfArgument || state.suggestion > 0))) return complete(Math.min(state.suggestion, suggestions.length - 1), key === "\t")
    if (mentionActive && (key === "\t" || key === "\r")) return completeMention(Math.min(state.mentionSuggestion, state.mentionResults.length - 1))
    if (mentionActive && key === "\x1b") return closeMentions()
    if (mentionActive && (key === "\x1b[A" || key === "\x1b[B")) {
      state.mentionSuggestion = (state.mentionSuggestion + (key === "\x1b[B" ? 1 : state.mentionResults.length - 1)) % state.mentionResults.length
      return requestFrame()
    }
    // Home and End scroll the transcript to its top and bottom while nothing is typed (otherwise they move within the line).
    if (editor.isEmpty() && (inline === "scroll.top" || inline === "scroll.bottom")) {
      scrollTranscript(inline === "scroll.top" ? Number.MAX_SAFE_INTEGER : -Number.MAX_SAFE_INTEGER)
      return requestFrame()
    }
    const pendingApproval = state.mode !== "minimal" && editor.isEmpty() && state.transcript.pendingRequests[0]?.kind === "approval" ? state.transcript.pendingRequests[0] : undefined
    if (pendingApproval && (key === "\x1b[A" || key === "\x1bOA" || key === "\x1b[B" || key === "\x1bOB")) {
      const count = approvalChoicesOf(pendingPanelRequest()).length
      state.approvalChoice = (state.approvalChoice + (key.endsWith("B") ? 1 : count - 1)) % count
      return requestFrame()
    }
    // ↑ and ↓ move the cursor one visual row; the prompt's history takes over only at the first and the last one.
    if ((key === "\x1b[A" || key === "\x1bOA") && !editor.canMoveRows(-1)) {
      // While something is queued, ↑ on an empty prompt edits it, as alt+↑ does; the prompt history follows once the queue is empty.
      if (editor.isEmpty() && state.recall.index === -1 && !pendingPanelRequest() && actions.composer.canEditQueued()) {
        await actions.composer.editQueued()
        return requestFrame()
      }
      if (editor.isEmpty() && !pendingPanelRequest() && inline === "session.parent" && await actions.navigateSession("session.parent")) return requestFrame()
      await recallOlder()
      return requestFrame()
    }
    if (editor.isEmpty() && !pendingPanelRequest() && (inline === "session.child.next" || inline === "session.child.previous") && await actions.navigateSession(inline)) return requestFrame()
    if ((key === "\x1b[B" || key === "\x1bOB") && state.recall.index >= 0 && !editor.canMoveRows(1)) {
      recallNewer()
      return requestFrame()
    }
    if (key === "\x1b" && state.shellMode) {
      state.shellMode = false
      return requestFrame()
    }
    if (key === "\x1b" && editor.isEmpty() && !pendingPanelRequest() && await actions.limitEscape()) return requestFrame()
    if (key === "\x1b" && !pendingPanelRequest() && actions.cancelWait()) return
    if (key === "\x1b") return onEscape()
    if (inline === "permission.next") return cyclePermission()
    if (inline === "view.next" && editor.isEmpty() && !pendingPanelRequest()) return void await runSlash("/view")
    if (inline === "queue.send" && editor.isEmpty() && state.transcript.visibleCount === 0 && !state.transcript.queue.length) return void await runSlash("/sessions")
    if (inline === "queue.send" && (state.transcript.queue[0] || state.transcript.usageLimit)) return promoteQueued()
    // Backspace on an empty prompt takes the last chip off the row (an attachment with a token in the text is removed with its token instead).
    const lastChip = (key === "\x7f" || key === "\b") && editor.isEmpty() ? chipRowAttachments(liveAttachments(state.attachments, editor.text), state.tuiProfile.attachmentChips).at(-1) : undefined
    if (lastChip) {
      state.attachments = state.attachments.filter((item) => item !== lastChip)
      return requestFrame()
    }
    if (inline === "queue.drop" && editor.isEmpty() && state.transcript.queue.length > 0) return dropLastQueued()
    if (inline === "queue.flip") return sendFlipped()
    if (inline === "tools.expand") state.transcript.toggleTools()
    else if ((inline === "scroll.up" || inline === "scroll.down") && scrollApproval(inline === "scroll.up" ? -1 : 1)) {
      // a long approval preview owns PgUp/PgDn while it is pending
    } else if (inline === "scroll.up") scrollTranscript(height - 6)
    else if (inline === "scroll.down") scrollTranscript(-(height - 6))
    else if (key === "?" && editor.isEmpty() && !state.planDraft && toggleApprovalExplain()) {
      // the explanation of the pending approval is shown or hidden
    }
    else if (editor.isEmpty() && !state.planDraft && state.transcript.pendingRequests[0]?.kind === "approval" && approvalChoicesOf(pendingPanelRequest()).some((option) => option.key === key))
      await resolveRequest(approvalChoicesOf(pendingPanelRequest()).find((option) => option.key === key)!.choice)
    else if (/^[1-9]$/.test(key) && editor.isEmpty() && !state.planDraft && state.mode !== "minimal" && state.transcript.pendingRequests[0]?.kind === "approval") {
      const option = approvalChoicesOf(pendingPanelRequest())[Number(key) - 1]
      if (option) await resolveRequest(option.choice)
    } else if (key === "\r" && editor.isEmpty() && !state.planDraft && state.mode !== "minimal" && state.transcript.pendingRequests[0]?.kind === "approval") {
      const option = approvalChoicesOf(pendingPanelRequest())[state.approvalChoice]
      if (option) await resolveRequest(option.choice)
    }
    else if (vimLive() && vim.key(key) === "handled") {
      // Consumed by normal or visual mode (or recorded in insert mode, which passes the key on).
      syncMentions()
    }
    // `/multiline`: Enter adds a line and the newline keys (shift/alt/ctrl+Enter) send. Slash commands and shell lines still send on Enter.
    else if (inline === "edit.newline" && multilineOn() && !state.bindings.disabled.has(key)) return (vim.reset(), submit())
    else if (key === "\r" && multilineOn() && !state.bindings.disabled.has(key)) { if (!editor.isEmpty()) editor.action("newline") }
    else if (inline?.startsWith("edit.")) editor.action(inline.slice(5) as EditAction)
    else if (!state.bindings.disabled.has(key) && editor.key(key) === "submit") return (vim.reset(), submit())
    else {
      state.suggestion = 0
      if (editor.text.startsWith("/")) void loadCustomCommands(editor.text === "/")
      syncMentions()
    }
    requestFrame()
  }

  /** A keymap action, through the same handlers as the slash commands; a draft in the prompt survives it. */
  async function runKeyAction(action: BindingAction, key?: string) {
    if (action === "selection.quote") { mouseSelection.quote(); return requestFrame() }
    // The comment key: with comments off (or `commentKey` set to quote) it keeps its old job of quoting the selection into the prompt.
    // ctrl+g never had that job: it always comments.
    if (action === "selection.comment") {
      if (!ctx.comments.commentKey({ always: key === COMMENT_KEY })) mouseSelection.quote()
      return requestFrame()
    }
    if (action === "comment.list" || action === "comment.reply" || action === "comment.clear") {
      ctx.comments.run(action)
      return requestFrame()
    }
    if (action === "session.child.first" || action === "session.child.next" || action === "session.child.previous" || action === "session.parent") {
      await actions.navigateSession(action)
      return requestFrame()
    }
    const slash: Partial<Record<BindingAction, string>> = {
      new: "/new", sessions: "/sessions", model: "/model", theme: "/theme", compact: "/compact", quit: "/quit", agents: "/agents", usage: "/usage", changes: "/changes", help: "/help",
      "message.undo": "/undo", "message.redo": "/redo", "session.timeline": "/timeline", "session.history": "/history", "variant.list": "/variants", "extensions.open": "/extensions", "session.export": "/export", "sidebar.toggle": "/sidebar", "panel.toggle": "/panel", "diagram.open": "/diagram", "messages.open": "/messages", "voice.toggle": "/voice",
    }
    const command = action.startsWith("command:") ? `/${action.slice("command:".length)}` : slash[action]
    if (command) {
      const draft = editor.text
      if (!(await runExtensionCommand(command))) {
        if (command === "/undo" || command === "/redo") {
          state.notice = ""
          await rewind(command === "/undo" ? "undo" : "redo")
        } else await runSlash(command)
      }
      if (draft && (state.page === "chat" || state.page === "theme") && command !== "/undo" && command !== "/redo") editor.insert(draft)
    } else if (action.startsWith("edit.") && EDIT_ACTIONS.includes(action.slice(5) as EditAction)) editor.action(action.slice(5) as EditAction)
    else if (action.startsWith("page:")) openExtensionPage(action.slice("page:".length))
    else if (action.startsWith("modal:")) actions.openExtensionModal(action.slice("modal:".length))
    else if (action.startsWith("action:")) actions.runExtensionAction(action.slice("action:".length))
    else if (action === "dock") {
      state.dockOpen = !state.dockOpen
      // The Jobs panel shows the session's background shell tasks: ask for them when the dock opens.
      if (state.dockOpen) void loadAgentShells()
    } else if (action === "scratch.edit") await editScratch()
    else if (action === "model.next" || action === "model.previous" || action === "model.favorite.next" || action === "model.favorite.previous") await cycleModel("model", action.endsWith("previous") ? -1 : 1, action.includes("favorite"))
    else if (action === "agent.picker") await runSlash("/agent")
    else if (action === "agent.next" || action === "agent.previous") {
      const sessionId = state.sessionId
      const reply = await input.send({ type: "agents.list", sessionId })
      if (!reply.ok) return fail(reply.error.message)
      const report = reply.result as AgentsReport
      const agents = report.agents.filter((agent) => agent.trusted && !agent.disable && !agent.hidden && agent.mode !== "subagent")
      const at = agents.findIndex((agent) => agent.name === report.current)
      const next = agents[(at + (action === "agent.next" ? 1 : -1) + agents.length) % agents.length]
      if (next && sessionId === state.sessionId) await runSlash(`/agent ${next.name}`)
    }
    else if (action === "stash.list") await runSlash("/stash list")
    else if (action === "terminal.suspend") {
      if (process.platform === "win32" || !input.terminal?.suspendProcess) say("terminal suspend unavailable", "warning")
      else await input.terminal.suspendProcess()
    }
    else if (action === "scrollbar.toggle" || action === "username.toggle" || action === "terminal-title.toggle" || action === "tips.toggle" || action === "thinking.toggle" || action === "sticky-prompt.toggle") {
      const commands = { "scrollbar.toggle": "/scrollbar", "username.toggle": "/username", "terminal-title.toggle": "/terminal-title", "tips.toggle": "/tips", "thinking.toggle": "/thinking", "sticky-prompt.toggle": "/sticky-prompt" }
      await runSlash(commands[action])
    }
    else if (action === "effort.next") await cycleModel("effort")
    else if (action === "effort.previous") await cycleModel("effort", -1)
    else if (action === "panel.focus") { if (!(await actions.fileOpen.key("\x1b}"))) await actions.rightKey("\x1b}") }
    else if (action === "file.switch") await actions.fileOpen.key("\x1b{")
    else if (action === "file.close") actions.fileOpen.close()
    else if (action === "file.open") await actions.openPathInView()
    else if (action === "queue.edit") await actions.composer.editQueued()
    else if (action === "history.search") await actions.composer.openSearch()
    else if (action === "history.previous") await recallOlder()
    else if (action === "history.next") { if (state.recall.index >= 0) recallNewer() }
    else if (action === "backtrack.open") await actions.composer.openBacktrack()
    else if (action === "shortcuts.toggle") state.shortcuts = !state.shortcuts
    else if (action === "palette") {
      if (!state.transcript.pendingRequests.some((request) => request.kind === "approval")) await openPalette()
    } else if (action === "tools.expand") state.transcript.toggleTools()
    else if (action === "permission.next") await cyclePermission()
    else if (action === "view.next") await runSlash("/view")
    else if (action === "queue.send") await promoteQueued()
    else if (action === "queue.drop") await dropLastQueued()
    else if (action === "queue.flip") await sendFlipped()
    else if (action === "image.paste") await pasteClipboardImage()
    else if (action === "edit.undo") undoEdit("undo")
    else if (action === "edit.redo") undoEdit("redo")
    else if (action === "stash.push") stashPrompt()
    else if (action === "stash.pop") restoreStash()
    else if (action === "drafts.restore") await actions.restoreUnsent()
    else if (action === "editor.open") await editInExternalEditor()
    else if (action === "message.copy") copyAnswer()
    else if (action === "messages.conceal") state.transcript.toggleConceal()
    else if (action === "transcript.find") actions.openFind()
    else if (action === "details.toggle") details.toggleFocused()
    else if (action === "block.copy") blockCopy.copyFocused()
    else if (action === "message.next" || action === "message.previous" || action === "message.last-user") await actions.navigateMessage(action.slice(8) as "next" | "previous" | "last-user")
    else if (action === "scroll.line-up") scrollTranscript(1)
    else if (action === "scroll.line-down") scrollTranscript(-1)
    else if (action === "scroll.half-up") scrollTranscript(Math.max(1, Math.floor(state.lastBodyHeight / 2)))
    else if (action === "scroll.half-down") scrollTranscript(-Math.max(1, Math.floor(state.lastBodyHeight / 2)))
    else if (action === "scroll.top") scrollTranscript(Number.MAX_SAFE_INTEGER)
    else if (action === "scroll.bottom") scrollTranscript(-Number.MAX_SAFE_INTEGER)
    else if (action === "scroll.up") scrollTranscript(input.screen.size.height - 6)
    else if (action === "scroll.down") scrollTranscript(-(input.screen.size.height - 6))
    requestFrame()
  }

  async function cyclePermission() {
    const current = state.transcript.permissionMode
    await setPermission(PERMISSION_MODES[(PERMISSION_MODES.indexOf(current) + 1) % PERMISSION_MODES.length]!)
  }

  /**
   * ctrl+shift+enter: sends the prompt once the other way round. Under `after-response` it is a steer (joins the running turn
   * after its next tool result); under `after-tools` (the default where the engine allows it) and `immediate` it waits for the response.
   * With no turn running it is an ordinary send.
   */
  async function sendFlipped() {
    const flipped = queuePolicy(state) === "after-response" ? "steer" : "queue"
    state.nextDelivery = state.transcript.foreground === "idle" ? undefined : flipped
    await submit()
    state.nextDelivery = undefined
    requestFrame()
  }

  /** The newest queued message is removed (ctrl+k on an empty prompt). */
  async function dropLastQueued() {
    const last = state.transcript.queue.at(-1)
    if (!last) return
    const reply = await input.send({ type: "queue.remove", sessionId: state.sessionId, queueId: last.queueId })
    if (!reply.ok) fail(reply.error.message)
    requestFrame()
  }

  /** F2 / F3: the next model or effort for this session, through `session.model.set`, with the result in a toast. */
  async function cycleModel(kind: "model" | "effort", direction = 1, favorite = false) {
    const listed = await input.send({ type: "models.list", ...(state.sessionId ? { sessionId: state.sessionId } : {}) })
    if (!listed.ok) return fail(listed.error.message)
    const report = listed.result as ModelsReport
    const choice = kind === "model" ? nextModelChoice(report, favorite ? state.modelPrefs.favorites : state.modelPrefs.recents, direction) : nextVariantChoice(report, direction)
    if (!choice) return say(report.selectable ? `no other ${kind} to cycle to` : `${report.engine} engine chooses its own model`)
    if (!state.sessionId) return say("model: no session yet")
    if (takeModels(await input.send({ type: "session.model.set", sessionId: state.sessionId, choice }))) {
      if (kind !== "model") changeModelPrefs(noteRecent(state.modelPrefs, choice.model))
      if (!footerShowsModel(state.tuiProfile)) say(`model: ${modelWithEffort(choice.model, choice.variant ?? choice.effort, state.modelReport)}`, "success")
    }
    else fail(state.modelError)
  }

  /** Ctrl+S and the ` ↗ SEND ` chip: the first queued message goes now. */
  async function promoteQueued() {
    const first = state.transcript.queue[0]
    // Nothing queued but a turn paused by a usage limit: the key continues it (Resume at reset).
    if (!first) {
      if (await actions.limitKey()) requestFrame()
      return
    }
    const reply = await input.send({ type: "queue.promote", sessionId: state.sessionId, queueId: first.queueId })
    if (!reply.ok) fail(reply.error.message)
    requestFrame()
  }

  return { onKey, runKeyAction }
}
