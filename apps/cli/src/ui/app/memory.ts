import { memoryBodyRoom, type memoryPageKey } from "../lazy-pages"
import type { DreamRun, EvolutionSuggestion, MemoryCategoryInfo, MemoryEntry, MemoryGraphReport, MemoryId } from "@mendcode/protocol"
import type { MemoryPageData } from "../../view/memory-page"
import type { EvolutionData } from "../../view/memory-evolution"
import type { AppContext } from "./context"

export function createMemory(ctx: AppContext) {
  const { input, state, fail, requestFrame, say, setupChoice, editor } = ctx

  let memoryLoad = 0
  let sharingLoad = 0
  const memoryDirectory = () => state.memoryState?.workspace.root ?? input.directory
  const selectionKey = () => JSON.stringify([state.memoryState?.workspace.view, memoryDirectory()])

  async function loadMemories() {
    const generation = ++memoryLoad
    const workspace = state.memoryState?.workspace
    const browsed = workspace && (workspace.view !== "project" || workspace.root !== undefined)

    // A management view: session-scope memories are listed too (`session: "all"`).
    const directory = memoryDirectory()
    const reply = browsed ? await input.send({ type: "memory.browse", view: workspace.view, ...(input.directory ? { directory: input.directory } : {}), ...(workspace.root ? { root: workspace.root } : {}) })
      : await input.send({ type: "memory.list", session: "all", ...(directory ? { directory } : {}) })
    if (generation !== memoryLoad) return
    state.memoryOmitted = reply.ok ? Number(reply.result?.omitted ?? 0) : 0
    if (reply.ok) state.memories = (reply.result?.memories as MemoryEntry[]) ?? []
    else fail(reply.error.message)
    const projects = await input.send({ type: "memory.workspaces", ...(input.directory ? { directory: input.directory } : {}) })
    if (generation !== memoryLoad) return
    if (projects.ok && projects.result?.workspaces) state.memoryWorkspaces = projects.result as import("@mendcode/protocol").MemoryWorkspacesReport
    else if (!projects.ok) fail(projects.error.message)
    const extractions = await input.send({ type: "memory.extraction.list", ...(directory ? { directory } : {}) })
    if (generation !== memoryLoad) return
    if (extractions.ok) {
      state.extractionJobs = (extractions.result?.jobs as Omit<import("@mendcode/protocol").ExtractionJob, "text">[]) ?? []
      state.extractorConfigured = extractions.result?.configured === true
      state.extractionStatus = extractions.result?.status as typeof state.extractionStatus
      state.memoryMaintenanceReport = extractions.result?.maintenance as typeof state.memoryMaintenanceReport
    } else fail(extractions.error.message)
    requestFrame()
  }

  /** What the Memory page needs besides the memories; `width` × `height` are the page body's, for the scrolling report. */
  function memoryPageData(width: number, height: number): MemoryPageData {
    return {
      currentDirectory: input.directory,
      workspaces: state.memoryWorkspaces,
      omitted: state.memoryOmitted,
      sharing: { status: state.sharingStatus, result: state.sharingResult, error: state.sharingError },
      extraction: { jobs: state.extractionJobs, status: state.extractionStatus, configured: state.extractorConfigured, settings: state.settingsNow, maintenance: state.memoryMaintenanceReport },
      categories: state.memoryCategories,
      evolution: state.evolutionData,
      evolutionMode: state.settingsNow.evolution ?? "off",
      evolutionSize: { width, height: Math.max(0, height - 3) },
      dreamMaxTokens: state.settingsNow.dreamMaxTokens,
      bodyRoom: state.memoryWorkspaces ? Math.max(0, height - 7) : memoryBodyRoom(state.memoryState.tab, width, height),
    }
  }

  async function loadMemoryCategories() {
    const reply = await input.send({ type: "memory.categories" })
    if (reply.ok) state.memoryCategories = (reply.result?.categories as MemoryCategoryInfo[]) ?? []
    else fail(reply.error.message)
    requestFrame()
  }

  async function loadEvolution() {
    const directory = memoryDirectory()
    if (!directory) {
      state.evolutionData = { mode: state.settingsNow.evolution ?? "off", suggestions: [], observed: { corrections: 0, preferences: 0, recurring: 0 } }
      return requestFrame()
    }
    const reply = await input.send({ type: "evolution.list", directory })
    if (directory !== memoryDirectory()) return
    if (reply.ok) state.evolutionData = reply.result as EvolutionData
    else fail(reply.error.message)
    requestFrame()
  }

  /** `dream.list` carries the report of the newest runs only; the selected older run's is asked for once, by its id. */
  async function loadDreamReport() {
    const run = state.dreamRuns?.[Math.max(0, Math.min(state.memoryState.dream.selected, (state.dreamRuns?.length ?? 1) - 1))]
    if (!run || run.report || run.status === "running" || state.dreamReportAsked.has(run.runId)) return
    state.dreamReportAsked.add(run.runId)
    const directory = memoryDirectory()
    const reply = await input.send({ type: "dream.list", runId: run.runId, ...(directory ? { directory } : {}) })
    if (directory !== memoryDirectory()) return
    const full = reply.ok ? (reply.result?.runs as DreamRun[] | undefined)?.find((candidate) => candidate.runId === run.runId) : undefined
    if (full && state.dreamRuns) state.dreamRuns = state.dreamRuns.map((candidate) => (candidate.runId === full.runId ? full : candidate))
    requestFrame()
  }

  async function loadMemoryGraph() {
    const selection = selectionKey()
    const workspace = state.memoryState.workspace
    const reply = workspace.view !== "project" || workspace.root ? await input.send({ type: "memory.browse", view: workspace.view, ...(input.directory ? { directory: input.directory } : {}), ...(workspace.root ? { root: workspace.root } : {}) })
      : await input.send({ type: "memory.graph", ...(input.directory ? { directory: input.directory } : {}) })
    if (selection !== selectionKey()) return
    if (reply.ok) state.memoryGraph = (reply.result?.graph ?? reply.result) as MemoryGraphReport
    else fail(reply.error.message)
    requestFrame()
  }

  async function loadDreamRuns() {
    const directory = memoryDirectory()
    const reply = await input.send({ type: "dream.list", ...(directory ? { directory } : {}) })
    if (directory !== memoryDirectory()) return
    if (reply.ok) state.dreamRuns = (reply.result?.runs as DreamRun[]) ?? []
    else fail(reply.error.message)
    requestFrame()
    await loadDreamReport()
  }

  /** A memory has no scope to edit: moving one saves a copy in the new scope, then deletes the old one (its links go with it). The old one stays if the copy fails. */
  async function moveMemoryScope(memoryId: MemoryId, scope: "user" | "project" | "session") {
    const entry = state.memories.find((memory) => memory.memoryId === memoryId)
    if (!entry) return
    if (scope !== "user" && !input.directory) return say("no project directory to move it into", "warning")
    const added = await input.send({
      type: "memory.add",
      scope,
      text: entry.text,
      category: entry.category,
      ...(entry.pinned ? { pinned: true } : {}),
      ...(scope !== "user" && input.directory ? { directory: input.directory } : {}),
      ...(scope === "session" ? { sessionId: state.sessionId } : {}),
    })
    if (!added.ok) return fail(added.error.message)
    const removed = await input.send({ type: "memory.delete", memoryId })
    if (!removed.ok) return fail(`copied to ${scope} scope, but the old one could not be deleted: ${removed.error.message}`)
    say(`moved to ${scope} scope`, "success")
  }

  /** Memories `/memory undo` already removed, so the next undo reaches the save before them. */
  const undone = new Set<string>()

  /** `/memory undo`: deletes the newest memory this session saved (its notice names it); the daemon's `Memory removed` toast follows. */
  async function undoMemory() {
    const notice = state.transcript.blocks().findLast((block) => block.meta?.memoryChange === "saved" && typeof block.meta.memoryId === "string" && !undone.has(block.meta.memoryId))
    const memoryId = notice?.meta?.memoryId
    if (typeof memoryId !== "string") return say("No memory saved in this session to undo", "info")
    const reply = await input.send({ type: "memory.delete", memoryId: memoryId as MemoryId })
    undone.add(memoryId)
    if (!reply.ok) say(reply.error.message.replace(/^\[[A-Z]+\]: /, ""), "warning")
  }

  async function startDream() {
    const reply = await input.send({ type: "dream.run", directory: memoryDirectory() ?? "" })
    if (reply.ok) say("dream running in the background…")
    else fail(reply.error.message)
  }

  async function loadSharing() {
    const generation = ++sharingLoad
    const selection = selectionKey()
    const scope = state.memoryState.sharing.scope
    state.sharingStatus = undefined
    state.sharingError = undefined
    const reply = await input.send({ type: "memory.sharing.status", scope: state.memoryState.sharing.scope, ...(memoryDirectory() ? { directory: memoryDirectory()! } : {}) })
    if (generation !== sharingLoad || selection !== selectionKey() || scope !== state.memoryState.sharing.scope) return
    if (reply.ok) state.sharingStatus = reply.result as import("@mendcode/protocol").SharingStatusReport
    else state.sharingError = reply.error.message
    requestFrame()
  }

  async function memoryAction(action: ReturnType<typeof memoryPageKey>["action"]) {
    if (action.type === "refreshSharing") { state.sharingResult = undefined; return loadSharing() }
    if (action.type === "browseMemory") {
      state.memories = []
      state.memoryGraph = undefined
      state.dreamRuns = undefined
      state.dreamReportAsked.clear()
      state.evolutionData = undefined
      state.sharingResult = undefined
      state.sharingStatus = undefined
      state.notice = ""
      await loadMemories()
      if (state.memoryState.tab === "graph") await loadMemoryGraph()
      if (state.memoryState.tab === "dream") await loadDreamRuns()
      if (state.memoryState.tab === "evolution") await loadEvolution()
      if (state.memoryState.tab === "sharing") await loadSharing()
      return
    }
    if (action.type === "sharing") {
      const generation = ++sharingLoad
      state.memoryState.sharing = { ...state.memoryState.sharing, busy: true }
      state.sharingError = undefined
      requestFrame()
      const scope = state.memoryState.sharing.scope
      const common = { scope, ...(memoryDirectory() ? { directory: memoryDirectory()! } : {}) }
      const reply = action.action === "enable" || action.action === "disable"
        ? await input.send({ type: "memory.sharing.configure", ...common, enabled: action.action === "enable", ...(action.confirmation ? { confirmation: action.confirmation } : {}) })
        : await input.send({ type: action.action === "export" ? "memory.sharing.export" : "memory.sharing.import", ...common })
      if (generation !== sharingLoad) return
      state.memoryState.sharing = { ...state.memoryState.sharing, busy: false }
      if (reply.ok) {
        state.sharingStatus = reply.result as import("@mendcode/protocol").SharingStatusReport
        if (action.action === "export" || action.action === "import") state.sharingResult = reply.result as import("@mendcode/protocol").SharingResult
        if (action.action === "import") await loadMemories()
      } else state.sharingError = reply.error.message
      return requestFrame()
    }

    if (action.type === "refreshExtraction") return loadMemories()
    if (action.type === "extractionRetry") {
      const reply = await input.send({ type: "memory.extraction.retry", jobId: action.jobId })
      if (!reply.ok) fail(reply.error.message)
      return loadMemories()
    }
    if (action.type === "memorySetting") {
      await setupChoice({ [action.key]: action.value })
      return loadMemories()
    }
    if (action.type === "dream") return startDream()
    if (action.type === "notice") {
      state.notice = action.text
      return
    }
    if (action.type === "link" || action.type === "unlink") {
      const reply =
        action.type === "link"
          ? await input.send({ type: "memory.link", from: action.from as MemoryId, to: action.to as MemoryId, kind: "related" })
          : await input.send({ type: "memory.unlink", from: action.from as MemoryId, to: action.to as MemoryId })
      if (!reply.ok) fail(reply.error.message)
      return
    }
    if (action.type === "policy") {
      const reply = await input.send({ type: "memory.policy", category: action.category, policy: action.policy })
      if (reply.ok) state.memoryCategories = (reply.result?.categories as MemoryCategoryInfo[]) ?? state.memoryCategories
      else fail(reply.error.message)
      return requestFrame()
    }
    if (action.type === "evolutionMode") {
      await setupChoice({ evolution: action.mode })
      return loadEvolution()
    }
    if (action.type === "evolutionWorkflows") {
      await setupChoice({ evolutionWorkflows: action.enabled })
      return loadEvolution()
    }
    if (action.type === "evolutionPromote" || action.type === "evolutionRollback") {
      const reply = await input.send(action.type === "evolutionPromote" ? { type: "evolution.promote", suggestionId: action.suggestionId, expectedHash: action.expectedHash, policyRevision: action.policyRevision } : { type: "evolution.rollback", suggestionId: action.suggestionId, expectedHash: action.expectedHash, expectedRevision: action.expectedRevision })
      await loadEvolution()
      if (!reply.ok && state.evolutionData) {
        state.evolutionData = { ...state.evolutionData, error: reply.error.message }
        state.memoryState.evolution = { ...state.memoryState.evolution, scroll: 0 }
        requestFrame()
      }
      return
    }
    if (action.type === "dreamBudget") {
      await setupChoice({ dreamMaxTokens: action.tokens })
      say(action.tokens === null ? "dream budget back to the default" : `dream budget ${action.tokens} tokens per run`, "success")
      return
    }
    if (action.type === "suggestion") {
      const reply = await input.send({ type: "evolution.resolve", suggestionId: action.suggestionId, decision: action.decision, ...(action.expectedHash ? { expectedHash: action.expectedHash } : {}) })
      if (!reply.ok) {
        await loadEvolution()
        if (state.evolutionData) state.evolutionData = { ...state.evolutionData, error: reply.error.message }
        state.memoryState.evolution = { ...state.memoryState.evolution, scroll: 0 }
        return requestFrame()
      }
      const { suggestion, path } = reply.result as { suggestion: EvolutionSuggestion; path?: string }
      if (state.evolutionData) state.evolutionData = { ...state.evolutionData, suggestions: state.evolutionData.suggestions.map((item) => (item.suggestionId === suggestion.suggestionId ? suggestion : item)) }
      if (path) say(`${suggestion.kind} written to ${path}`, "success")
      return requestFrame()
    }
    const memoryId = "memoryId" in action ? (action.memoryId as MemoryId) : undefined
    if (!memoryId) return
    if (action.type === "scope") return moveMemoryScope(memoryId, action.scope)
    if (action.type === "pin" || action.type === "category") {
      const reply = await input.send({ type: "memory.update", memoryId, ...(action.type === "pin" ? { pinned: action.pinned } : { category: action.category }) })
      if (!reply.ok) fail(reply.error.message)
      else if (action.type === "pin") say(action.pinned ? "pinned: always in the agent's context" : "unpinned")
      return
    }
    if (action.type === "edit") {
      state.editingMemory = memoryId
      state.page = "chat"
      editor.clear()
      editor.insert(action.text)
      state.notice = "editing memory · enter saves · esc cancels"
      return
    }
    const reply =
      action.type === "delete"
        ? await input.send({ type: "memory.delete", memoryId })
        : await input.send({ type: "memory.update", memoryId, status: action.type === "reject" ? "archived" : "saved" })
    if (!reply.ok) fail(reply.error.message)
  }

  return { loadMemories, memoryPageData, loadMemoryCategories, loadEvolution, loadDreamReport, loadMemoryGraph, loadDreamRuns, moveMemoryScope, startDream, undoMemory, memoryAction, loadSharing, memoryDirectory }
}
