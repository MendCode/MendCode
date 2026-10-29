import type { SessionId, CustomToolsReport, McpStatusReport, PackageConfigReport, PackagesReport, GlobalEvent, SessionSummary, AgentCommandsReport, McpCatalogReport, McpResourceContent } from "@mendcode/protocol"
import type { AgentShell, AgentSubtask } from "../../view/agents-page"
import { taskUsage } from "../../view/tasks-page"
import type { CommandInput } from "@mendcode/client"
import type { AppContext } from "./context"

/** Titles of sessions heard of (activity pushes, the Agent View list). */
const AGENT_TITLES_MAX = 500

export function createAgents(ctx: AppContext) {
  let backgroundBusy = false
  let backgroundStale = false
  let metadata: AgentCommandsReport["metadata"] | undefined
  async function loadAgentMetadata() {
    const sessionId = ctx.state.sessionId
    const reply = await ctx.input.send({ type: "session.agent-command.list", sessionId })
    if (sessionId !== ctx.state.sessionId) return
    metadata = reply.ok ? (reply.result as AgentCommandsReport | undefined)?.metadata : undefined
    const full = await ctx.input.send({ type: "session.agent-view.metadata.list", ...(ctx.input.directory ? { directory: ctx.input.directory } : {}) })
    if (sessionId !== ctx.state.sessionId) return
    if (full.ok && full.result?.metadata) metadata = full.result.metadata as AgentCommandsReport["metadata"]
    ctx.requestFrame()
  }
  async function loadBackgroundSessions() {
    if (backgroundBusy) { backgroundStale = true; return }
    backgroundBusy = true
    try {
      do {
        backgroundStale = false
        const reply = await ctx.input.send({ type: "session.background.list" })
        if (reply.ok) { ctx.state.agentBackgrounds = (reply.result?.sessions as import("@mendcode/protocol").SessionBackgroundEntry[] | undefined) ?? []; ctx.state.agentBackgroundError = "" }
        else ctx.state.agentBackgroundError = reply.error.message
      } while (backgroundStale)
    } finally { backgroundBusy = false }
    ctx.requestFrame()
  }
  async function authMcp(server: string) {
    const { state, input, requestFrame } = ctx
    const selected = state.mcpsReport?.servers.findIndex((entry) => entry.name === server) ?? -1
    if (selected >= 0) state.mcpsState = { ...state.mcpsState, selected }
    const reply = await input.send({ type: "mcp.auth", directory: input.directory ?? "", server })
    if (!reply.ok) state.mcpsError = reply.error.message
    else {
      const url = reply.result?.url as string | undefined
      if (url) {
        state.mcpsState = { ...state.mcpsState, authUrls: { ...state.mcpsState.authUrls, [server]: url } }
        copyAuthMcp(server)
      }
    }
    await loadMcps()
    if (!reply.ok) state.mcpsError = reply.error.message
    requestFrame()
  }

  function copyAuthMcp(server: string) {
    const url = ctx.state.mcpsState.authUrls?.[server]
    if (url) {
      ctx.copyText(url, "auth URL")
      if (ctx.state.page === "mcps") {
        ctx.toasts.dismiss()
        ctx.state.mcpsState.authCopied = server
        ctx.requestFrame()
      }
    }
  }
  const { input, state, requestFrame, fail, report } = ctx

  /** Running `task` sub-agents of the current session with their newest tool line, read from the transcript. */
  function agentSubtasks(): AgentSubtask[] {
    return state.transcript
      .blocks()
      .filter((block) => block.kind === "tool_call" && block.status === "running" && block.title?.startsWith("task:"))
      .map((block) => {
        // The child's record (by its description, which is the call's title) adds what it runs on, what it spent and wrote.
        const task = state.liveTasks?.find((each) => each.parentId === state.sessionId && `task: ${each.description}` === block.title)
        const facts = task ? [task.run?.name ?? task.run?.model, task.stats ? taskUsage(task.stats) : undefined, task.stats?.files.length ? `${task.stats.files.length} file${task.stats.files.length === 1 ? "" : "s"}` : undefined].filter(Boolean).join(" · ") : ""
        return { itemId: block.itemId, title: block.title!, latest: (block.text.split("\n").filter((line) => line.trim()).at(-1) ?? "").replace(/^◆\s*/, "").trim(), ...(facts ? { facts } : {}) }
      })
  }

  function noteActivity(event: Extract<GlobalEvent, { type: "session.activity" }>) {
    // Newest last: past the cap the title heard of longest ago goes (Agent View lists at most 200 sessions).
    state.agentTitles.delete(event.sessionId)
    state.agentTitles.set(event.sessionId, event.title)
    if (state.agentTitles.size > AGENT_TITLES_MAX) state.agentTitles.delete(state.agentTitles.keys().next().value!)
    // A paused session stays listed even when idle, so it can be resumed from Agent View.
    if ((event.state === "idle" || event.state === "error") && !event.paused) state.agentSessions.delete(event.sessionId)
    else
      state.agentSessions.set(event.sessionId, {
        sessionId: event.sessionId,
        title: event.title,
        directory: event.directory,
        state: event.state,
        updatedAt: event.updatedAt,
        queued: event.queued ?? 0,
        ...(event.since !== undefined ? { since: event.since } : {}),
        ...(event.tool ? { tool: event.tool } : {}),
        ...(event.pending ? { pending: event.pending } : {}),
        ...(event.paused ? { paused: true } : {}),
      })
  }

  /** Pause, resume or stop a session from Agent View or a slash command; the daemon's ack and the next activity push update the rows. */
  async function controlSession(sessionId: string, action: "pause" | "resume" | "stop") {
    const reply = await ctx.input.send({ type: "session.control", sessionId: sessionId as SessionId, action })
    if (!reply.ok) return ctx.fail(reply.error.message)
    const result = (reply.result ?? {}) as { paused?: boolean; cancelledTurn?: boolean; cancelledChildren?: number }
    const known = state.agentSessions.get(sessionId)
    if (known && action !== "stop") state.agentSessions.set(sessionId, { ...known, ...(result.paused ? { paused: true } : { paused: false }) })
    const children = result.cancelledChildren ?? 0
    state.notice = action === "pause" ? "paused · the running turn finishes, then nothing starts" : action === "resume" ? "resumed" : `stopped · ${result.cancelledTurn ? "turn cancelled" : "no running turn"}${children ? `, ${children} sub-agent${children === 1 ? "" : "s"} cancelled` : ""}`
    void loadBackgroundSessions()
    ctx.requestFrame()
  }

  async function loadAgentShells() {
    if (state.agentShellsBusy) return void (state.agentShellsStale = true)
    state.agentShellsBusy = true
    try {
      do {
        state.agentShellsStale = false
        const reply = await input.send({ type: "background.list" })
        if (reply.ok) state.agentShells = (reply.result?.tasks as AgentShell[] | undefined) ?? []
      } while (state.agentShellsStale)
    } finally {
      state.agentShellsBusy = false
    }
    requestFrame()
  }

  /**
   * The newest sessions of every project with their live state: what already runs or waits for the user in another terminal is in
   * Agent View at once, not at its next change, and the home's Completed reads the project's tree (every project from `~`), as in v1.
   */
  async function loadAgentSessions(quiet = false): Promise<void> {
    const listed = await input.send({ type: "session.list", limit: 200, hideEmpty: true })
    if (!listed.ok) return void (quiet || fail(listed.error.message))
    const sessions = (listed.result?.sessions as SessionSummary[] | undefined) ?? []
    state.homeRecent = sessions
    for (const s of sessions) {
      state.agentTitles.set(s.sessionId, s.title)
      if ((s.state === "idle" || s.state === "error") && !s.paused) state.agentSessions.delete(s.sessionId)
      else state.agentSessions.set(s.sessionId, { sessionId: s.sessionId, title: s.title, directory: s.directory, state: s.state, updatedAt: s.updatedAt, queued: s.queued, ...(s.since !== undefined ? { since: s.since } : {}), ...(s.tool ? { tool: s.tool } : {}), ...(s.pending ? { pending: s.pending } : {}), ...(s.paused ? { paused: true } : {}) })
    }
    requestFrame()
  }

  async function loadAgents() {
    await loadAgentSessions()
    await loadAgentShells()
    await loadAgentMetadata()
    await loadBackgroundSessions()
  }

  async function loadMcps() {
    const reply = await input.send({ type: "mcp.status", directory: input.directory ?? "" })
    if (reply.ok) {
      state.mcpsReport = reply.result as McpStatusReport
      const urls = state.mcpsState?.authUrls
      if (urls) {
        state.mcpsState.authUrls = Object.fromEntries(Object.entries(urls).filter(([name]) => state.mcpsReport?.servers.some((server) => server.name === name && server.enabled && ["pending", "needs_auth"].includes(server.auth ?? ""))))
        if (state.mcpsState.authCopied && !state.mcpsState.authUrls[state.mcpsState.authCopied]) delete state.mcpsState.authCopied
      }
      state.mcpsError = ""
    } else state.mcpsError = reply.error.message
    requestFrame()
  }

  async function loadTools(trust?: boolean) {
    const reply = await input.send(trust === undefined ? { type: "tools.list", directory: input.directory ?? "" } : { type: "tools.trust", directory: input.directory ?? "", trusted: trust })
    if (reply.ok) {
      state.toolsReport = reply.result as CustomToolsReport
      state.toolsError = ""
      if (trust !== undefined) state.notice = trust ? "project tools trusted" : "project tools no longer trusted"
    } else state.toolsError = reply.error.message
    requestFrame()
  }

  /** Lists packages, or runs a packages command whose ack is the fresh report; `done` becomes the notice on success. */
  async function loadPackages(command?: CommandInput, done?: string) {
    const reply = await input.send(command ?? { type: "packages.list", directory: input.directory ?? "" })
    if (reply.ok && (command?.type === "packages.config" || command?.type === "packages.resource")) {
      // Resource switches of one package: shown by the page's config view, the installed list is unchanged.
      const found = (reply.result as PackageConfigReport).packages[0]
      if (state.packagesState.config && found?.key === state.packagesState.config.key) state.packagesState.config.resources = found.resources
      state.packagesError = ""
      if (done) state.notice = done
    } else if (reply.ok) {
      state.packagesReport = reply.result as PackagesReport
      state.packagesError = ""
      if (done) state.notice = done
    } else if (command?.type === "packages.enable" && command.enabled && /--switch/.test(reply.error.message)) {
      // Another package owns the look: turning this one on is the switch the user asked for, so it is made at once and the notice
      // says which one went off. Turning that one back on switches back.
      const owner = /(\S+) owns the look/.exec(reply.error.message)?.[1]
      return loadPackages({ ...command, switch: true }, owner ? `${command.key} on · ${owner} off` : `${command.key} on`)
    } else state.packagesError = reply.error.message
    requestFrame()
  }

  /** MCP servers for the home footer, asked once. */
  async function loadHomeMcp() {
    if (state.homeMcpAsked) return
    state.homeMcpAsked = true
    const reply = await input.send({ type: "mcp.status", directory: input.directory ?? "" })
    if (reply.ok) {
      const servers = (reply.result as McpStatusReport | undefined)?.servers ?? []
      state.homeMcp = { total: servers.length, connected: servers.filter((server) => server.state === "running").length, failed: servers.some((server) => server.enabled && server.state === "failed") }
    }
    requestFrame()
  }

  async function restartMcp(server: string) {
    state.notice = `restarting ${server}…`
    requestFrame()
    const reply = await input.send({ type: "mcp.restart", directory: input.directory ?? "", server })
    report(reply)
    await loadMcps()
  }

  async function decideMcp(server: string, approve: boolean) {
    const pending = state.mcpsReport?.servers.find((entry) => entry.name === server)?.pending
    if (!pending) return
    const reply = await input.send({ type: "mcp.decide", directory: input.directory ?? "", server, scope: pending.scope, revision: pending.revision, approve })
    report(reply)
    await loadMcps()
  }

  async function loadMcpCatalog() {
    state.mcpsState.catalogLoading = true
    state.mcpsState.catalogError = ""
    requestFrame()
    try {
      const reply = await input.send({ type: "mcp.catalog", directory: input.directory ?? "" })
      if (reply.ok) state.mcpsState.catalog = reply.result as McpCatalogReport
      else state.mcpsState.catalogError = reply.error.message
    } catch (error) { state.mcpsState.catalogError = error instanceof Error ? error.message : String(error) }
    state.mcpsState.catalogLoading = false
    requestFrame()
  }

  async function readMcpResource(server: string, uri: string, id: string) {
    state.mcpsState.catalogError = ""
    try {
      const reply = await input.send({ type: "mcp.resource.read", directory: input.directory ?? "", server, uri })
      if (reply.ok) state.mcpsState.catalogPreview = { id, contents: (reply.result?.contents as McpResourceContent[]) ?? [] }
      else state.mcpsState.catalogError = reply.error.message
    } catch (error) { state.mcpsState.catalogError = error instanceof Error ? error.message : String(error) }
    state.mcpsState.catalogScroll = 0
    requestFrame()
  }

  return { agentMetadata: () => metadata, controlSession, loadAgentSessions, loadAgentMetadata, loadBackgroundSessions, agentSubtasks, noteActivity, loadAgentShells, loadAgents, loadMcps, loadTools, loadPackages, loadHomeMcp, restartMcp, decideMcp, authMcp, copyAuthMcp, loadMcpCatalog, readMcpResource }
}
