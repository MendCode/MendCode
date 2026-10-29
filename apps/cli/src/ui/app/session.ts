import { isRewindConflict, type RewindKind } from "../../view/rewind-card"
import { draftRefs, pendingFromRefs } from "../../view/attachments"
import type { BlobRef, ItemId, RewindReport, SessionMergeReport, SessionTreeNode, TimelineEntry } from "@mendcode/protocol"
import type { SessionId, SessionSummary } from "@mendcode/protocol"
import type { SessionColor } from "@mendcode/protocol/wire"
import { featureOn } from "@mendcode/protocol/wire"
import { contentQuery } from "../../view/session-query"
import { truncateEnd } from "../../view/wrap"
import { placeholderFor } from "../../view/prompt-chrome"
import { createTurnState } from "../../view/turn-state"
import { createCompactionFacts } from "../../view/compaction-facts"
import { createSessionListState, orderSessions, sessionListKey, viewOf } from "../../view/session-list"
import type { AppContext } from "./context"
import { followPet } from "./pet-follow"
import { refreshLiveTasks } from "./live-tasks"

export function createSession(ctx: AppContext, actions: {
  resetAudio(): void
  /** A transcript built with the same options as the app's first one (views, model names). */
  newTranscript(): AppContext["state"]["transcript"]
  loadDiffTotals(): Promise<void>
  chatWidth(): number
  maxScroll(): number
  sessionTitle(): string
  dropRevealedSecret(): void
  secretTail(n: number): string | undefined
  endScratchEdit(): void
  endGoalEdit(): void
  loadEffectiveModel(): Promise<void>
  restoreDraft(target: SessionId): Promise<void>
  keepDiscarded(options: { track?: boolean }): Promise<void>
  openTranscript(): Promise<void>
  loadEarlier(): Promise<void>
  /** A session was switched to: its age and size decide the resume questions. */
  checkResume(): Promise<void>
  /** The terminal now shows another session: what slash commands showed or hid follows it (session-look.ts). */
  sessionLookSwitched(previous: SessionId): void
  /** `/fork pick`: the tree on the messages, where enter forks. */
  openTree(options: { filter: "messages"; pick: true }): Promise<void>
}) {
  const { input, state, editor, fail, say, requestFrame, view, drafts, now, random } = ctx
  const { loadDiffTotals, chatWidth, maxScroll, sessionTitle, dropRevealedSecret, secretTail, endScratchEdit, endGoalEdit, loadEffectiveModel, restoreDraft } = actions
  let writer: SessionId | undefined
  let writerTick: ReturnType<typeof setInterval> | undefined
  let writerStopped = false
  async function releaseBackgroundWriter() {
    writerStopped = true
    if (writerTick) clearInterval(writerTick)
    writerTick = undefined
    const previous = writer
    writer = undefined
    if (previous) await input.send({ type: "session.background.writer.release", sessionId: previous })
  }
  async function acquireBackgroundWriter(sessionId: SessionId) {
    if (input.remote || writer === sessionId || writerStopped) return
    const reply = await input.send({ type: "session.background.writer.acquire", sessionId })
    if (!reply.ok || !reply.result?.acquired) return
    if (state.sessionId !== sessionId || writerStopped) { await input.send({ type: "session.background.writer.release", sessionId }); return }
    writer = sessionId
    if (writerTick) clearInterval(writerTick)
    writerTick = setInterval(() => { if (writer === sessionId) void input.send({ type: "session.background.writer.acquire", sessionId }) }, 10_000)
    writerTick.unref?.()
  }

  /** Copies this conversation into a new session (a side chat is read-only) and switches to it. */
  async function forkSession(readOnly: boolean) {
    const reply = await input.send({ type: "session.fork", sessionId: state.sessionId, ...(readOnly ? { readOnly: true } : {}) })
    if (!reply.ok) return fail(reply.error.message)
    await switchSession(reply.result?.sessionId as SessionId)
    say(readOnly ? "side chat · read-only, plan mode" : "forked session", "success")
  }

  /** `/undo` and `/redo`: the daemon's report as a card; files changed after the turn make it ask before overwriting them (`force`). */
  async function rewind(kind: RewindKind, force = false, atItemId?: ItemId, prompt?: string, images?: BlobRef[]) {
    const sessionId = state.sessionId
    const reply = await input.send({ type: kind === "undo" ? "session.undo" : "session.redo", sessionId, ...(force ? { force: true } : {}), ...(kind === "undo" && atItemId ? { atItemId } : {}), ...(kind === "undo" && state.transcript.activeTurn ? { cancelRunning: true } : {}) })
    if (sessionId !== state.sessionId) return
    if (!reply.ok) {
      if (isRewindConflict(reply.error)) state.rewindCard = { kind, state: "conflict", message: reply.error.message, ...(atItemId ? { atItemId } : {}), ...(prompt !== undefined ? { prompt } : {}), ...(images ? { images } : {}) }
      else {
        state.rewindCard = undefined
        fail(reply.error.message)
      }
      return requestFrame()
    }
    if (!reply.result) {
      state.rewindCard = undefined
      return fail(`${kind} returned no report`)
    }
    const report = reply.result as RewindReport
    state.rewindCard = { kind, state: "done", report }
    if (prompt === undefined && kind === "undo" && report.prompt) {
      prompt = report.prompt.text
      images = report.prompt.attachments
    }
    if (kind === "redo" && report.canRedo !== true) { prompt = ""; images = [] }
    if (prompt !== undefined) {
      ctx.editor.replaceAll(prompt)
      state.attachments = pendingFromRefs(images ?? [])
      drafts.changed(state.sessionId, { text: prompt, images: images ?? [] })
    }
    void loadDiffTotals()
    requestFrame()
  }

  /** Puts the transcript on the chosen message, widening the laid-out window when it is further up. */
  async function jumpTo(entry: TimelineEntry) {
    if (entry.reverted) return say("that message was undone · /redo brings it back", "warning")
    state.page = "chat"
    const sessionId = state.sessionId
    let offset = state.transcript.offsetFor(entry.itemId, chatWidth(), state.lastBodyHeight)
    while (offset === undefined && state.paging?.more && !state.paging.loading) {
      const first = state.paging.firstSeq
      await actions.loadEarlier()
      if (sessionId !== state.sessionId || first === state.paging?.firstSeq) return
      offset = state.transcript.offsetFor(entry.itemId, chatWidth(), state.lastBodyHeight)
    }
    if (offset === undefined) return say("that message is not in the transcript", "warning")
    view.jump(state.sessionId, offset, maxScroll())
  }

  /** A new session branched from the chosen message (`session.fork` with `atItemId`); this terminal switches to it. */
  async function forkAt(entry: TimelineEntry) {
    if (entry.reverted) return say("that message was undone: fork at one that was not", "warning")
    const reply = await input.send({ type: "session.fork", sessionId: state.sessionId, atItemId: entry.itemId })
    if (!reply.ok) return fail(reply.error.message)
    state.page = "chat"
    await switchSession(reply.result?.sessionId as SessionId)
    say(`forked at "${truncateEnd(entry.preview, 40)}"`, "success")
    return true
  }

  /** Merge-back: the fork's turns since it branched go into its parent as context for the parent's next message (no model call). */
  async function mergeFork(forkId: SessionId) {
    const reply = await input.send({ type: "session.merge", sessionId: forkId })
    if (!reply.ok) { fail(reply.error.message); return false }
    const report = reply.result as SessionMergeReport | undefined
    if (!report) return false
    say(`merged ${report.turns} ${report.turns === 1 ? "turn" : "turns"} (~${report.tokens.toLocaleString("en-US")} tokens${report.omitted ? `, ${report.omitted} older left out` : ""}) into the parent · sent with its next message`, "success")
    return true
  }

  /** `/fork merge` merges this fork into its parent; `/fork merge <id>` merges that fork of this tree (the end of its id is enough). */
  async function mergeCommand(ref: string) {
    if (!ref) return void await mergeFork(state.sessionId)
    const tree = await input.send({ type: "session.tree", sessionId: state.sessionId })
    if (!tree.ok) return fail(tree.error.message)
    const needle = ref.toLowerCase()
    const matches = ((tree.result?.nodes as SessionTreeNode[] | undefined) ?? []).filter((node) => node.parentId && node.kind !== "task" && node.sessionId.toLowerCase().endsWith(needle))
    if (matches.length !== 1) return say(matches.length ? `${ref} matches more than one fork · use more of the id` : `no fork ${ref} in this tree · /tree lists them`, "warning")
    await mergeFork(matches[0]!.sessionId)
  }

  /** `/fork` copies the session; `/fork pick` opens the tree on the messages to choose where; `/fork <n>` forks at the nth message of `/timeline`; `/fork merge [id]` brings a fork back into its parent. */
  async function forkCommand(args: string) {
    if (args.startsWith("handoff ")) {
      const goal = args.slice(8).trim()
      if (!goal || goal.length > 2000) return say("usage: /handoff <goal> (up to 2000 characters)", "warning")
      if (input.remote) return say("handoff is local only", "warning")
      const reply = await input.send({ type: "session.fork", sessionId: state.sessionId, handoffGoal: goal })
      if (!reply.ok) return fail(reply.error.message)
      await switchSession(reply.result?.sessionId as SessionId)
      ctx.editor.replaceAll(goal)
      drafts.changed(state.sessionId, { text: goal, images: [] })
      return say("handoff ready · review the goal and send", "success")
    }
    const requested = args.trim().toLowerCase()
    if (requested === "") return forkSession(false)
    if (requested === "pick" || requested === "at") return actions.openTree({ filter: "messages", pick: true })
    if (requested === "merge" || requested.startsWith("merge ")) return mergeCommand(args.trim().slice("merge".length).trim())
    if (!/^[1-9]\d*$/.test(requested)) {
      state.notice = "usage: /fork [pick | <message number> | merge [id]]"
      return
    }
    const reply = await input.send({ type: "session.timeline", sessionId: state.sessionId })
    if (!reply.ok) return fail(reply.error.message)
    const entries = (reply.result?.entries as TimelineEntry[] | undefined) ?? []
    const entry = entries[Number(requested) - 1]
    if (!entry) return say(`no message ${requested} · this session has ${entries.length}`, "warning")
    return forkAt(entry)
  }

  async function switchSession(next: SessionId) {
    if (next === state.sessionId) return
    state.changesSource = undefined
    // A comment being typed ends with the prompt back as it was, so the draft saved below holds the pending comments and the prompt.
    ctx.comments.switching()
    // The prompt is the leaving session's draft: saved now (a pending save goes out too), and emptied below so the next one starts with its own.
    const promptOwned = !input.remote?.readOnly && !state.editingScratch && !state.editingGoal && state.editingMemory === undefined && !state.planDraft
    if (promptOwned) drafts.changed(state.sessionId, { text: editor.text, images: draftRefs(state.attachments, editor.text) })
    drafts.flush()
    // The history is the project's, shared by its sessions: what is in the prompt is kept as a draft entry, and the next ↑ reads the list again.
    void actions.keepDiscarded({ track: false })
    if (!input.remote) state.recall.prompts = undefined
    await releaseBackgroundWriter()
    writerStopped = false
    if (input.subscribe) await input.send({ type: "client.unsubscribe", sessionId: state.sessionId })
    if (input.remote) {
      const listed = await input.send({ type: "session.list", limit: 500, archived: true })
      const summary = listed.ok ? (listed.result?.sessions as SessionSummary[] | undefined)?.find((session) => session.sessionId === next) : undefined
      if (!summary) return fail("remote session not found")
      input.directory = summary.directory
      state.gitBranch = undefined
      state.branchRequested = false
    }
    const previousChat = state.sideChats.get(state.sessionId)
    if (previousChat) previousChat.focused = false
    state.rightFocus = false
    actions.resetAudio()
    const previousSession = state.sessionId
    state.sessionId = next
    state.liveTasks = undefined
    void refreshLiveTasks(ctx)
    // The pending comments belong to the session they were made in: they wait in its saved draft and come back with it.
    ctx.comments.reset(next)
    state.mflowWait = undefined
    state.clearFrom = undefined
    state.clearPending = false
    state.sessionParentId = undefined
    state.agentRoot = undefined
    state.agentView = undefined
    state.sidebarFocus = false
    state.sidebarSelected = next
    state.contextHover = false
    state.notice = ""
    state.agentReport = undefined
    state.secretTails.clear()
    state.secretsMissing.clear()
    state.environmentPage = undefined
    if (state.page === "env") state.page = "chat"
    dropRevealedSecret()
    state.transcript = actions.newTranscript()
    if (previousSession !== next) actions.sessionLookSwitched(previousSession)
    state.turnState = createTurnState()
    state.compactionFacts = createCompactionFacts()
    state.compactionLive.session = undefined
    state.compactionLive.focused = false
    state.openedAt = now()
    state.escArmedAt = 0
    // Leave the project note saved; reset the session's undo and goal editing cards.
    if (state.editingScratch) endScratchEdit()
    state.rewindCard = undefined
    state.goalPrompt = undefined
    state.returnPrompt = undefined
    if (state.editingGoal) endGoalEdit()
    if (promptOwned) {
      editor.clear()
      editor.resetHistory()
      state.attachments = []
      state.pastes = []
      state.suggestion = 0
      state.mentionToken = undefined
      state.mentionResults = []
      state.mentionLastQuery = undefined
    }
    state.shellMode = false
    state.placeholder = placeholderFor(random())
    state.page = "chat"
    void loadEffectiveModel()
    void loadTitle()
    requestFrame()
    await actions.openTranscript()
    if (state.sessionId !== next) return
    void restoreDraft(next)
    void actions.checkResume().catch(() => undefined)
    followPet(state)
    state.pet?.cheer("waving")
    requestFrame()
  }

  let recovering = false
  /**
   * The session this terminal holds is not on the daemon: a replaced daemon (an update, a crash) removes the blank chats when it
   * starts, and a chat deleted elsewhere is gone too. The terminal moves to the project's blank chat, the same one `/new` opens,
   * without a word, and what was typed in the prompt comes along. False when it could not (the caller then reports the original error).
   */
  async function recoverMissingSession(): Promise<boolean> {
    if (recovering || input.remote) return false
    recovering = true
    try {
      const gone = state.sessionId
      const reply = await input.send({ type: "session.create", directory: input.directory ?? "", title: "", reuseEmpty: true })
      const next = reply.ok ? reply.result?.sessionId : undefined
      if (typeof next !== "string") return false
      if (state.sessionId !== gone) return true
      // What was typed has no chat to be saved in: it comes along to the blank chat instead of being lost.
      const typed = { text: editor.text, attachments: state.attachments }
      await switchSession(next as SessionId)
      if (typed.text && state.sessionId === next && editor.isEmpty() && state.attachments.length === 0) {
        editor.insert(typed.text)
        state.attachments = typed.attachments
        requestFrame()
      }
      return true
    } finally {
      recovering = false
    }
  }

  /** After a reconnect: the daemon may be a new process that does not have the open chat any more. */
  async function verifySession() {
    const held = state.sessionId
    const reply = await input.send({ type: "session.get", sessionId: held })
    if (!reply.ok && reply.error.code === "unknown_session" && state.sessionId === held) await recoverMissingSession()
  }

  /** Sends a picker mutation, then reloads the daemon's list. */
  async function changeSession(action: { type: "rename"; sessionId: string; title: string } | { type: "delete"; sessionId: string } | { type: "archive"; sessionId: string; restore: boolean } | { type: "pin"; sessionId: string; pinned: boolean } | { type: "tag"; sessionId: string; tags: string[]; color: SessionColor | null | undefined }) {
    const target = action.sessionId as SessionId
    const command = action.type === "pin" ? { type: "session.meta" as const, sessionId: target, input: { action: "pin" as const, pinned: action.pinned } }
      : action.type === "archive" && featureOn(state.settingsNow, "session_meta") ? { type: "session.meta" as const, sessionId: target, input: { action: action.restore ? "restore" as const : "settle" as const } }
      : action.type === "rename" ? { type: "session.rename" as const, sessionId: target, title: action.title }
      : action.type === "archive" ? { type: "session.archive" as const, sessionId: target, ...(action.restore ? { restore: true } : {}) }
      : action.type === "tag" ? { type: "session.agent-view.metadata.patch" as const, sessionId: target, patch: { tags: action.tags, ...(action.color === undefined ? {} : { color: action.color }) } }
      : { type: "session.delete" as const, sessionId: target }
    const reply = await input.send(command)
    if (!reply.ok) fail(reply.error.message)
    else if (action.type === "archive" && !action.restore) say("settled · select it in /sessions, ctrl+o then ctrl+a to undo", "success")
    await reloadSessions()
    requestFrame()
    return reply.ok
  }

  let contentSearch = 0
  /** Asks the daemon which sessions have the picker's filter in their messages (local only); the latest question wins. */
  async function searchSessionContent() {
    const serial = ++contentSearch
    const list = state.sessionList
    const query = list.content ? contentQuery(list.filter) : undefined
    if (!query) {
      if (state.sessionList.hits) delete state.sessionList.hits
      if (list.content && list.filter) state.sessionList.hits = {}
      return requestFrame()
    }
    const reply = await input.send({ type: "session.search", text: query.text, ...(query.regex ? { regex: true } : {}), sessionIds: state.sessions.slice(0, 200).map((session) => session.sessionId), limit: 100 })
    if (serial !== contentSearch || !state.sessionList.content || state.sessionList.filter !== list.filter) return
    if (!reply.ok) {
      state.sessionList.hits = {}
      state.sessionList.note = reply.error.message.replace(/^\[DAEMON\]: /, "")
    } else state.sessionList.hits = Object.fromEntries(((reply.result?.hits as Array<{ sessionId: string; snippet: string }> | undefined) ?? []).map((hit) => [hit.sessionId, hit.snippet]))
    requestFrame()
  }

  async function navigateMessage(kind: "next" | "previous" | "last-user") {
    if (kind === "last-user") {
      const sessionId = state.sessionId
      const reply = await input.send({ type: "session.timeline", sessionId })
      if (state.sessionId !== sessionId) return
      if (!reply.ok) return fail(reply.error.message)
      const entry = (reply.result?.entries as TimelineEntry[] | undefined)?.findLast((entry) => !entry.reverted)
      if (entry) await jumpTo(entry)
      return
    }
    const transcript = state.transcript
    const width = chatWidth()
    const local = view.get(state.sessionId)
    const messages = () => transcript.blocks().filter((block) => block.kind === "user_message" || block.kind === "agent_message")
    const anchor = transcript.viewport(width, state.lastBodyHeight, local.offset).find((line) => line.itemId && messages().some((block) => block.itemId === line.itemId))?.itemId
    let list = messages()
    let at = list.findIndex((block) => block.itemId === anchor)
    while (kind === "previous" && at <= 0 && state.paging?.more && !state.paging.loading) {
      const first = state.paging.firstSeq
      await actions.loadEarlier()
      if (transcript !== state.transcript || first === state.paging?.firstSeq) return
      list = messages()
      at = list.findIndex((block) => block.itemId === anchor)
    }
    const target = list[kind === "next" ? Math.max(0, at + 1) : Math.max(0, at - 1)]
    if (target) {
      const offset = transcript.offsetFor(target.itemId, width, state.lastBodyHeight)
      if (offset !== undefined) view.jump(state.sessionId, offset, maxScroll())
    }
    requestFrame()
  }

  async function renameSession(title: string) {
    if (!title.trim()) {
      await openSessions(true)
      state.renameFromChat = true
      const index = orderSessions(state.sessions, state.sessionList.filter, state.sessionId, state.sessionList.archived, viewOf(state.sessionList)).findIndex((session) => session.sessionId === state.sessionId)
      state.sessionList.selected = Math.max(0, index)
      state.sessionList = sessionListKey(state.sessionList, "\x12", state.sessions, state.sessionId).state
      requestFrame()
      return
    }
    if (title.length > 200) return fail("session title exceeds 200 characters")
    await changeSession({ type: "rename", sessionId: state.sessionId, title: title.trim() })
  }

  async function reloadSessions() {
    const reply = await input.send({ type: "session.list", limit: 200, archived: true, hideEmpty: true })
    if (!reply.ok) fail(reply.error.message)
    else state.sessions = (reply.result?.sessions as SessionSummary[]) ?? []
    requestFrame()
  }

  async function openSessions(archived = false) {
    state.renameFromChat = false
    state.page = "sessions"
    state.sessionList = createSessionListState()
    if (archived) state.sessionList.archived = true
    requestFrame()
    await reloadSessions()
  }

  /** The session's title for the top bar and the terminal title; later changes arrive with `session.activity`. */
  async function loadTitle() {
    const sessionId = state.sessionId
    const reply = await input.send({ type: "session.list", limit: 50, archived: true, hideEmpty: true, ...(input.directory ? { directory: input.directory } : {}) })
    if (sessionId !== state.sessionId) return
    if (reply.ok) {
      state.sessions = (reply.result?.sessions as SessionSummary[] | undefined) ?? []
      for (const listed of state.sessions) if (!state.agentTitles.get(listed.sessionId)?.trim()) state.agentTitles.set(listed.sessionId, listed.title)
      state.sessionParentId = state.sessions.find((listed) => listed.sessionId === sessionId)?.parentId
    }
    const detail = await input.send({ type: "session.get", sessionId })
    if (sessionId !== state.sessionId) return
    if (detail.ok && detail.result?.session) state.sessionParentId = (detail.result.session as import("@mendcode/protocol").SessionDetail).parentId
    void acquireBackgroundWriter(sessionId)
    requestFrame()
  }

  /** Read from .git/HEAD by the daemon: on start and after each turn, never on a timer. */
  async function loadBranch() {
    if (!input.directory) return
    const reply = await input.send({ type: "git.branch", directory: input.directory })
    state.gitBranch = reply.ok && typeof reply.result?.branch === "string" ? reply.result.branch : ""
    requestFrame()
  }

  return { releaseBackgroundWriter, navigateMessage, renameSession, forkSession, rewind, jumpTo, forkAt, forkCommand, mergeFork, switchSession, changeSession, searchSessionContent, reloadSessions, openSessions, loadTitle, loadBranch, recoverMissingSession, verifySession }
}
