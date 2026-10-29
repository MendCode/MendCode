import type { createSession } from "./session"
import type { createLoops } from "./loops"
import type { createWorkflows } from "./workflows"
import type { createChanges } from "./changes"
import type { createMemory } from "./memory"
import type { createSecrets } from "./secrets"
import type { createAgents } from "./agents"
import { preload } from "../lazy-pages"
import { sidebarVisible } from "../../view/sidebar"
import { withPushedDraft } from "../../view/session-label"
import { normalizeTuiProfile } from "../../view/tui-profile"
import type { FooterSegment } from "@mendcode/protocol/wire"
import { createThresholds } from "../../view/threshold-notices"
import { memoryToast } from "../../view/memory-notice"
import type { Settings, GlobalEvent } from "@mendcode/protocol"
import type { AppContext } from "./context"
import { followPet } from "./pet-follow"
import { refreshLiveTasks } from "./live-tasks"
import { configureKeyLabels } from "../key-labels"
import { keyboardWanted } from "../keyboard-protocol"

/** Sub-agent parents remembered from `task.changed`, newest kept. */
const AGENT_PARENTS_KEPT = 256
/** Sessions the list keeps from activity pushes; a long-running terminal does not hold every session other terminals made. */
const PUSHED_SESSIONS_MAX = 500

export function createEvents(ctx: AppContext, actions: {
  loadTasks(): Promise<void>
  /** Draws the open /tree again (a sub-agent changed), keeping the selected row. */
  reloadTree(): Promise<void>
  loadBackgroundSessions(): Promise<void>
  /** The queue changed (this terminal or another): the open /queue page reads it again. */
  noteQueue(): void
  /** The live level and words of this terminal's on-device dictation. */
  voiceLive(update: { level?: number; text?: string }): void
  /** The open file may have changed on disk (a tool finished, a turn ended): the viewer asks the daemon whether it did. */
  noteFileMaybeChanged(): void
  noteMessageRevision(event: import("@mendcode/protocol").MessageRevision): void
  noteAudio(event: Parameters<AppContext["state"]["transcript"]["apply"]>[0]): void
  peerCommandsChanged: (source: import("@mendcode/protocol").SessionId, target: import("@mendcode/protocol").SessionId) => void
  reloadExtensions: (revision: number) => Promise<void>
  /** A turn of this session ended: a `/reload` or `/restart` that waited for it runs. */
  noteTurnEnded: () => void
  chatWidth: () => number
  noteSecretMarkers: ReturnType<typeof createSecrets>["noteSecretMarkers"]
  loadPage: (name: Parameters<typeof preload>[0] | undefined) => Promise<void>
  ringTurnBell: (event: { type: string; at: number; kind?: string; title?: string }) => void
  /** Live session events keep the idle clock and the last turn end for the return prompts. */
  noteReturn: (event: { type: string }) => void
  footerSegments: () => readonly FooterSegment[]
  loadBranch: ReturnType<typeof createSession>["loadBranch"]
  noteReview: ReturnType<typeof createChanges>["noteReview"]
  loadDiffTotals: ReturnType<typeof createChanges>["loadDiffTotals"]
  loadSidebarMcp: () => Promise<void>
  noteActivity: ReturnType<typeof createAgents>["noteActivity"]
  loadMcps: ReturnType<typeof createAgents>["loadMcps"]
  loadAgentShells: ReturnType<typeof createAgents>["loadAgentShells"]
  loadMemories: ReturnType<typeof createMemory>["loadMemories"]
  loadMemoryGraph: ReturnType<typeof createMemory>["loadMemoryGraph"]
  noteLoop: ReturnType<typeof createLoops>["noteLoop"]
  noteWorkflow: ReturnType<typeof createWorkflows>["noteWorkflow"]
  loadMemoryCategories: ReturnType<typeof createMemory>["loadMemoryCategories"]
  applySettings: (settings: Settings) => void
  loadDreamReport: ReturnType<typeof createMemory>["loadDreamReport"]
  loadEvolution: ReturnType<typeof createMemory>["loadEvolution"]
}) {
  const { input, state, say, fail, requestFrame, view, quotas, codegraph } = ctx
  const { chatWidth, noteSecretMarkers, loadPage, ringTurnBell, footerSegments, loadBranch, loadDiffTotals, loadSidebarMcp, noteActivity, loadAgentShells, loadMcps, loadMemories, loadMemoryGraph, noteLoop, noteWorkflow, loadMemoryCategories, applySettings, loadDreamReport, loadEvolution } = actions

  const thresholds = createThresholds()
  /** Memories whose save just toasted, by id: their follow-up `updated` event stays quiet. */
  const savedToasts = new Map<string, number>()
  /** The memory toast on screen, so the transcript row for the same write (it arrives a moment later) can replace it. */
  let shownMemoryToast: { memoryId: string; toast: unknown } | undefined

  function onEvent(event: Parameters<typeof state.transcript.apply>[0]) {
    if (event.sessionId !== state.sessionId) return
    // Until the opening window lands, live events wait: applied first they would raise the transcript's cursor past the window and drop it.
    if (state.paging && !state.paging.ready && state.paging.loading) { state.paging.held.push(event); return }
    state.lastEventAt = ctx.now()
    const width = chatWidth()
    const before = state.transcript.totalLines(width)
    const windowTop = state.transcript.olderBlocks
    const following = view.get(state.sessionId).follow
    state.turnState.apply(event)
    state.compactionFacts.apply(event)
    state.transcript.apply(event)
    if (event.type === "item.completed" && event.meta?.memorySaved === true && event.meta.memoryId === shownMemoryToast?.memoryId && ctx.toasts.current === shownMemoryToast?.toast) ctx.toasts.dismiss()
    if (event.type === "session.workspace.changed") {
      input.directory = event.directory
      state.gitBranch = undefined
      state.branchRequested = false
      state.sessions = state.sessions.map((session) => session.sessionId === event.sessionId ? { ...session, directory: event.directory } : session)
      void loadBranch()
      void loadDiffTotals()
      void loadSidebarMcp()
    }
    if (event.type === "message.revised") actions.noteMessageRevision(event)
    if (state.clearPending && event.type === "item.started" && event.kind === "user_message") {
      state.clearFrom = event.itemId
      state.clearPending = false
    }
    // A reader scrolled up keeps the window's top where it was, so new blocks cannot push their position off.
    if (!following) state.transcript.pinWindow(windowTop)
    // Extensions listening to the stats hear about a call or a compaction when it lands, with no surface needing to draw it.
    if ((event.type === "usage.recorded" || event.type === "compaction.updated") && ctx.stats.listeners > 0) ctx.stats.read()
    if (event.type === "turn.started") state.rewindCard = undefined
    if (["turn.completed", "turn.cancelled", "turn.interrupted", "turn.failed"].includes(event.type)) {
      state.mflowWait = undefined
      actions.noteTurnEnded()
    }
    noteSecretMarkers(event)
    followPet(state)
    // Approvals draw a diff: load its module when a turn starts so it is ready by the first request.
    if (event.type === "turn.started" || event.type === "server.request") void loadPage("approval").then(() => requestFrame())
    if (event.type === "server.request" && event.planReview) void loadPage("plan-review").then(() => requestFrame())
    ringTurnBell(event)
    if (state.fileViewer && (event.type === "item.completed" || event.type === "turn.completed")) actions.noteFileMaybeChanged()
    if (event.type === "queue.changed" || event.type === "foreground.state") actions.noteQueue()
    actions.noteReturn(event)
    actions.noteAudio(event)
    if (event.type === "turn.completed") {
      if (state.statusLoaded) void loadAgentShells()
      if (footerSegments().includes("branch")) void loadBranch()
      void loadDiffTotals()
      if (state.sidebarMcpAsked) void loadSidebarMcp()
    }
    // A finished background task arrives as a system notice message: say so in a toast, like v1.
    if (event.type === "queue.added" && event.notice) say(event.text.split("\n")[0]!.slice(0, 200), "info")
    // A /compact that did nothing says why; with no card in the transcript it would otherwise just vanish.
    if (event.type === "compaction.updated" && event.state === "skipped" && event.reason === "manual") say(event.note ?? "Nothing to compact", "info")
    view.onGrowth(state.sessionId, state.transcript.totalLines(chatWidth()) - before)
    requestFrame()
  }

  function onGlobal(event: GlobalEvent) {
    if (event.type === "mflow.waiting") {
      if (event.sessionId !== state.sessionId) return
      state.mflowWait = event.file !== null && event.deadlineAt !== null ? { file: event.file, deadlineAt: event.deadlineAt } : undefined
      requestFrame()
      return
    }
    if (event.type === "review.changed") return actions.noteReview(event)
    // The code graph's counts for one project directory: kept for the footer's `codegraph` segment, which reads them only when it draws.
    if (event.type === "codegraph.status") {
      if (event.state === "none") codegraph.delete(event.directory)
      else codegraph.set(event.directory, event)
      requestFrame()
      return
    }
    // `api.toast` from a daemon extension: the toast line only. The prompt, its focus and the transcript are untouched, and nothing reaches the model.
    if (event.type === "extension.feedback") return say(`${event.extension}: ${event.text}`, event.level)
    if (event.type === "extensions.changed") {
      void actions.reloadExtensions(event.revision)
      return
    }
    if (event.type === "tui.changed") {
      state.tuiProfile = normalizeTuiProfile(event.profile)
      configureKeyLabels({ setting: state.tuiProfile.altLabel })
      input.screen.setKeyboard?.(keyboardWanted(state.tuiProfile.keyProtocol, input.platform))
      applySettings(state.settingsNow)
      requestFrame()
      return
    }
    if (event.type === "voice.live") {
      actions.voiceLive({ ...(event.level !== undefined ? { level: event.level } : {}), ...(event.text !== undefined ? { text: event.text } : {}) })
      return
    }
    if (event.type === "aside.changed") {
      const chat = state.sideChats.get(event.sessionId)
      if (chat) chat.thread = event.thread
      return requestFrame()
    }
    if (event.type === "sidebar.changed") {
      if (event.directory && event.directory !== input.directory) return
      const directory = input.directory ?? process.cwd()
      void input.send({ type: "sidebar.get", directory }).then((reply) => {
        if (directory !== (input.directory ?? process.cwd())) return
        if (reply.ok) {
          // The panel's file changed: a session that chose its own cards keeps them, and the bar opens only where a turn is running
          // (the agent that built it is working there); every other terminal keeps it as shown or hidden.
          if (state.sessionLook.get(state.sessionId)?.sidebarWidgets) return
          const widgets = (reply.result?.widgets ?? []) as typeof state.tuiProfile.sidebarWidgets
          const working = state.transcript.foreground !== "idle"
          state.tuiProfile = { ...state.tuiProfile, sidebarWidgets: widgets, ...(working && widgets.length ? { rightSidebar: true } : {}) }
          state.rightScroll = 0
          requestFrame()
        }
      })
      return
    }
    if (event.type === "mcp.changed") {
      if (event.directory !== input.directory) return
      if (state.page === "mcps" || state.page === "status") void loadMcps()
      if (state.sidebarMcpAsked) void loadSidebarMcp()
      return
    }
    if (event.type === "usage.today") {
      state.todayUsage = { tokens: event.tokens, calls: event.calls, ...(event.costMicros ? { costMicros: event.costMicros } : {}) }
      return requestFrame()
    }
    if (event.type === "agent-commands.changed") return actions.peerCommandsChanged(event.sourceSessionId, event.targetSessionId)
    if (event.type === "task.changed") {
      state.agentParents.delete(event.sessionId)
      state.agentParents.set(event.sessionId, event.parentId)
      if (state.agentParents.size > AGENT_PARENTS_KEPT) state.agentParents.delete(state.agentParents.keys().next().value!)
      followPet(state)
      if (state.page === "tasks" && event.parentId === state.sessionId) void actions.loadTasks()
      if (event.parentId === state.sessionId) void refreshLiveTasks(ctx)
      if (state.page === "agents") void actions.loadBackgroundSessions()
      // The agents card and /tree draw the sub-agents' state and model: ask again.
      state.sidebarTreeRev++
      if (state.page === "tree") void actions.reloadTree()
      requestFrame()
      return
    }
    if (event.type === "session.background.changed") {
      if (state.page === "agents") void actions.loadBackgroundSessions()
      // An engine's own background tasks (Claude Code's) come and go with this event: the jobs count follows them.
      void loadAgentShells().then(requestFrame)
      return
    }
    if (event.type === "session.activity") {
      noteActivity(event)
      // A sub-agent of the open session started or stopped working: the pet's `agents` state follows it.
      if (event.sessionId !== state.sessionId) followPet(state)
      if (state.statusLoaded || state.page === "agents" || (state.page === "chat" && (state.dockOpen || state.tuiProfile.rightSidebar && state.tuiProfile.sidebarWidgets.some((widget) => widget.type === "jobs")))) {
        void loadAgentShells()
        requestFrame()
      }
      const { sessionId: id, title, directory, state: localState, updatedAt } = event
      const known = state.sessions.find((session) => session.sessionId === id)
      const archived = event.archivedAt === null ? { archivedAt: undefined } : event.archivedAt !== undefined ? { archivedAt: event.archivedAt } : {}
      // The draft of an untitled session labels it in every list: the push carries it when it appeared, changed its first line or went.
      state.sessions = known
        ? state.sessions.map((session) => (session.sessionId === id ? withPushedDraft({ ...session, ...archived, ...(event.lifecycle ? { lifecycle: event.lifecycle } : {}), title, directory, state: localState, updatedAt, queued: event.queued ?? 0, paused: event.paused === true }, event.draft) : session))
        : [withPushedDraft({ sessionId: id, ...archived, ...(event.lifecycle ? { lifecycle: event.lifecycle } : {}), title, directory, createdAt: updatedAt, updatedAt, lastSeq: 0, state: localState, queued: event.queued ?? 0, paused: event.paused === true }, event.draft), ...state.sessions]
      // Sessions pushed by other terminals join at the top; past the cap the oldest go (the open one stays), and /sessions reads the rest again.
      if (state.sessions.length > PUSHED_SESSIONS_MAX) state.sessions = state.sessions.filter((session, at) => at < PUSHED_SESSIONS_MAX || session.sessionId === state.sessionId)
      state.paletteSessions = state.paletteSessions.map((session) => (session.sessionId === id ? withPushedDraft({ ...session, title }, event.draft) : session))
      if (state.page === "sessions" || state.page === "chat" && sidebarVisible({ mode: state.tuiProfile.sidebar, width: input.screen.size.width, minimal: state.mode === "minimal" })) requestFrame()
      return
    }
    if (event.type === "memory.changed") {
      const toast = memoryToast(event)
      // A write that adds details right after saving (a proposal's metadata) is one save, not two toasts.
      const savedAt = savedToasts.get(event.memoryId)
      // The write is in the transcript on screen when this session's own memory tool is running: its row is the notice, so no toast.
      const rowFollows = state.page === "chat" && state.transcript.blocks().some((block) => block.meta?.memoryId === event.memoryId || block.kind === "tool_call" && block.status === "running" && /^(memory|memory_graph|remember)\b/.test(block.title ?? ""))
      if (toast && !rowFollows && !(event.change === "updated" && savedAt !== undefined && ctx.now() - savedAt < 3_000)) {
        if (event.change === "added") savedToasts.set(event.memoryId, ctx.now())
        if (savedToasts.size > 50) savedToasts.delete(savedToasts.keys().next().value!)
        say(toast.message, toast.variant, { title: toast.title, ...(toast.hint ? { hint: toast.hint } : {}), oneLine: true })
        shownMemoryToast = { memoryId: event.memoryId, toast: ctx.toasts.current }
      }
      if (state.page === "memory") void loadMemories()
      if (state.page === "memory" && state.memoryState.tab === "graph") void loadMemoryGraph()
      return requestFrame()
    }
    if (event.type === "loop.changed") {
      noteLoop(event.loop, event.deleted === true)
      if (event.loop.state === "completed" && !event.deleted) state.pet?.cheer("jumping")
      if (state.page !== "loops" || !state.loopsLoaded) return requestFrame()
      if (state.loopsState.scope === "project" && event.loop.directory !== input.directory) return
      const known = state.loops.some((loop) => loop.loopId === event.loop.loopId)
      state.loops = event.deleted
        ? state.loops.filter((loop) => loop.loopId !== event.loop.loopId)
        : known
          ? state.loops.map((loop) => (loop.loopId === event.loop.loopId ? event.loop : loop))
          : [event.loop, ...state.loops]
      return requestFrame()
    }
    if (event.type === "workflow.changed") {
      const run = event.workflow
      noteWorkflow(run, event.deleted === true)
      if (run.state === "completed" && !event.deleted) state.pet?.cheer("jumping")
      if (state.page !== "workflows" || !state.workflowsLoaded) return requestFrame()
      if (state.workflowsState.scope === "project" && run.directory !== input.directory) return
      const known = state.workflows.some((entry) => entry.workflowId === run.workflowId)
      state.workflows = event.deleted ? state.workflows.filter((entry) => entry.workflowId !== run.workflowId) : known ? state.workflows.map((entry) => (entry.workflowId === run.workflowId ? run : entry)) : [run, ...state.workflows]
      return requestFrame()
    }
    if (event.type === "status.line") {
      if (event.directory !== input.directory) return
      state.statusLine = { left: event.left, right: event.right, ...(event.leftRows ? { leftRows: event.leftRows } : {}), ...(event.rightRows ? { rightRows: event.rightRows } : {}) }
      // A script that could not run is reported once, not on every push.
      const problem = event.problems[0] ?? ""
      if (problem && problem !== state.statusProblem) state.notice = problem
      state.statusProblem = problem
      return requestFrame()
    }
    if (event.type === "settings.changed") {
      if (state.page === "memory" && state.memoryState.tab === "policies") void loadMemoryCategories()
      return applySettings(event.settings as Settings)
    }
    if (event.type === "release.available") {
      say(event.installed ? `Updated to ${event.version} · restart MendCode` : `Update ${event.version} · ${event.channel} · /release-channel`, "info")
      state.updateAvailable = { version: event.version, installed: event.installed === true }
      if (state.releaseReport) state.releaseReport = { ...state.releaseReport, latest: event.version, status: event.installed ? "installed" : "update-available" }
      return requestFrame()
    }
    if (event.type === "dream.changed") {
      if (event.run.directory !== (state.page === "memory" ? state.memoryState.workspace.root ?? input.directory : input.directory)) return
      if (state.dreamRuns) state.dreamRuns = [event.run, ...state.dreamRuns.filter((run) => run.runId !== event.run.runId)].sort((a, b) => b.startedAt - a.startedAt || b.runId - a.runId)
      if (event.run.status === "running") return requestFrame()
      if (state.page === "memory" && state.memoryState.tab === "dream") void loadDreamReport()
      if (state.page === "memory" && state.memoryState.tab === "evolution") void loadEvolution()
      const { status, proposed, error, notes } = event.run
      if (status === "done") say(proposed ? `dream: ${proposed} proposal${proposed === 1 ? "" : "s"} · /memory to review` : "dream: nothing new to remember", "success")
      else if (status === "skipped") say(`dream skipped: ${notes ?? ""}`, "warning")
      else fail(`dream failed: ${error ?? ""}`)
      return requestFrame()
    }
    if (event.type !== "quota.snapshot") return
    quotas.set(event.provider, event)
    // A reached limit explains why the next turn fails, so it is said even with the notices off; the percentages are not.
    for (const notice of thresholds.quota(event, ctx.now())) if (state.tuiProfile.usageNotices || notice.tone === "error") say(notice.text, notice.tone)
    if (state.usageReport) state.usageReport = { ...state.usageReport, quotas: [...quotas.values()] }
    requestFrame()
  }

  return { onEvent, onGlobal }
}
