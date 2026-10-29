import type { createSession } from "./session"
import type { createTranscriptActions } from "./transcript-actions"
import type { createScratch } from "./scratch"
import { runBacklogCommand } from "./backlog"
import type { createGoal } from "./goal"
import type { createUsageLimit } from "./usage-limit"
import type { createDaemon } from "./daemon"
import type { createPrWatchCommand } from "./pr-watch"
import type { createPrompt } from "./prompt"
import type { createPets } from "./pets"
import type { createLoops } from "./loops"
import type { createWorkflows } from "./workflows"
import type { createPermissions } from "./permissions"
import type { createDiagram } from "./diagram"
import type { createAside } from "./aside"
import type { createSetup } from "./setup"
import type { createAgentPicker } from "./agent-picker"
import type { createModel } from "./model"
import type { createProviders } from "./providers"
import type { createContext, AppContext } from "./context"
import type { createUsage } from "./usage"
import type { createChanges } from "./changes"
import type { createMemory } from "./memory"
import type { createSecrets } from "./secrets"
import type { createStorage } from "./storage"
import type { createAgents } from "./agents"
import type { createStatus } from "./status"
import type { createHooks } from "./hooks"
import { featureOn } from "@mendcode/protocol/wire"
import { BREAKPOINTS } from "../breakpoints"
import { relaunchMessage, relaunchTargets } from "../../view/relaunch"
import { sidebarVisible } from "../../view/sidebar"
import { createChangesPageState, createLoopsPageState, createMcpsPageState, createMemoryPageState, createStoragePageState, createToolsPageState, createUsagePageState, preload, createAgentsPageState, slashPage, createPackagesPageState, createCustomizePageState, createSettingsPageState, createStatusPageState, createExtensionsPageState, createProvidersPageState, createSecretsPageState } from "../lazy-pages"
import { readReviewComments } from "../../view/review-comments"
import type { createThemePicker } from "./theme-picker"
import type { FooterSegment } from "@mendcode/protocol/wire"
import type { PermissionMode, SessionId } from "@mendcode/protocol"
import { parseFooterCommand } from "../../view/footer"
import { parseFooterRowsCommand } from "../../view/footer-rows"
import { parseActivityCommand } from "../../view/activity-status"
import { parseSlash } from "../../view/commands"
import { normalizeHomeMascot, SIDEBAR_MODES, type SidebarMode, type TuiProfile } from "../../view/tui-profile"
import { PRESENTATION_MODES, type PresentationMode } from "../../view/transcript"
import { SELECTABLE_PERMISSION_MODES } from "./constants"
import { keyText } from "../key-labels"
import { customizeRow } from "../lazy-pages"

export function createSlash(ctx: AppContext, actions: {
  openGit(args: string): Promise<void>
  openEnvironment(privacy?: boolean): Promise<void>
  recordSlash?: (name: string) => void
  openFind(query?: string): void
  openTasks(): Promise<void>
  openPs(): Promise<void>
  releaseBackgroundWriter(): Promise<void>
  queueCommand(args: string): Promise<void>
  openMarketplace(sourceId?: string): Promise<void>
  openAssets(): Promise<void>
  openCompaction(): Promise<void>
  openPromptMode(args?: string): Promise<void>
  loadPromptMode(): Promise<void>
  openKeymap(): Promise<void>
  openTerminalSetup(): Promise<void>
  openTutorial(args?: string): Promise<void>
  doctorCommand(): Promise<void>
  diagnosticsCommand(text: string): Promise<boolean>
  worktreesCommand(text: string): Promise<boolean>
  /** `git.newSessionWorktree`: moves a session just created into a fresh workspace; a line saying why it stayed in the project, or undefined. */
  placeNewSession(sessionId: SessionId): Promise<string | undefined>
  compoundCommand(text: string): Promise<boolean>
  aiConfigCommand(args: string): Promise<void>
  releaseCommand(text: string): Promise<boolean>
  tsmCommand(text: string): Promise<boolean>
  mflowCommand(text: string): Promise<boolean>
  consoleCommand(text: string): Promise<boolean>
  quickCommand(text: string): Promise<boolean>
  importCommand(text: string): Promise<boolean>
  shareStaticCommand(text: string): Promise<boolean>
  sandboxCommand(text: string): Promise<boolean>
  addDirCommand(text: string): Promise<boolean>
  remoteControlCommand(text: string): Promise<boolean>
  voiceCommand(text: string): Promise<boolean>
  composer: ReturnType<typeof import("./composer-recovery").createComposerRecovery>
  openAcp:() => Promise<void>
  ideCommand(args: string): Promise<void>
  setSidebar: (next: SidebarMode) => void
  footerSegments: () => readonly FooterSegment[]
  switchSession: ReturnType<typeof createSession>["switchSession"]
  openSessions: ReturnType<typeof createSession>["openSessions"]
  attachPasted: ReturnType<typeof createPrompt>["attachPasted"]
  fileOpen: ReturnType<typeof import("./file-open").createFileOpen>
  openPlanReview: () => Promise<void>
  loadUsage: ReturnType<typeof createUsage>["loadUsage"]
  loadMemoryCategories: ReturnType<typeof createMemory>["loadMemoryCategories"]
  loadMemories: ReturnType<typeof createMemory>["loadMemories"]
  loadContext: ReturnType<typeof createContext>["loadContext"]
  contextWindowCommand: ReturnType<typeof createContext>["contextWindowCommand"]
  filesCommand: ReturnType<typeof createContext>["filesCommand"]
  loadSecrets: ReturnType<typeof createSecrets>["loadSecrets"]
  loadChanges: ReturnType<typeof createChanges>["loadChanges"]
  selectChangesSource: ReturnType<typeof createChanges>["selectChangesSource"]
  loadPetChoices: ReturnType<typeof createPets>["loadPetChoices"]
  petCommand: ReturnType<typeof createPets>["petCommand"]
  petNames: ReturnType<typeof createPets>["petNames"]
  loadStorage: ReturnType<typeof createStorage>["loadStorage"]
  peerCommand: (args: string) => Promise<void>
  controlSession: ReturnType<typeof createAgents>["controlSession"]
  loadAgents: ReturnType<typeof createAgents>["loadAgents"]
  authMcp: ReturnType<typeof createAgents>["authMcp"]
  loadMcps: ReturnType<typeof createAgents>["loadMcps"]
  loadTools: ReturnType<typeof createAgents>["loadTools"]
  loadPackages: ReturnType<typeof createAgents>["loadPackages"]
  openIntro: ReturnType<typeof createSetup>["openIntro"]
  openSetup: ReturnType<typeof createSetup>["openSetup"]
  loadStatus: ReturnType<typeof createStatus>["loadStatus"]
  loadExtensionsReport: ReturnType<typeof createStatus>["loadExtensionsReport"]
  openHooks: ReturnType<typeof createHooks>["openHooks"]
  trustCommand: ReturnType<typeof createHooks>["trustCommand"]
  agentCommand: ReturnType<typeof createAgentPicker>["agentCommand"]
  themeCommand: ReturnType<typeof createThemePicker>["themeCommand"]
  modelCommand: ReturnType<typeof createModel>["modelCommand"]
  openConnect: ReturnType<typeof createProviders>["openConnect"]
  loadProviders: ReturnType<typeof createProviders>["loadProviders"]
  loadLoops: ReturnType<typeof createLoops>["loadLoops"]
  createLoop: ReturnType<typeof createLoops>["createLoop"]
  goalCommand: ReturnType<typeof createGoal>["goalCommand"]
  limitCommand: ReturnType<typeof createUsageLimit>["limitCommand"]
  daemonCommand: ReturnType<typeof createDaemon>["daemonCommand"]
  whenIdle: ReturnType<typeof createDaemon>["whenIdle"]
  prCommand: ReturnType<typeof createPrWatchCommand>["prCommand"]
  openWorkflows: ReturnType<typeof createWorkflows>["openWorkflows"]
  workflowCommand: ReturnType<typeof createWorkflows>["workflowCommand"]
  rightSidebarCommand: (args: string, panel?: boolean) => Promise<boolean>
  askAside: ReturnType<typeof createAside>["askAside"]
  openFetch: ReturnType<typeof createAside>["openFetch"]
  setPermission: (next: PermissionMode) => Promise<void>
  startDream: ReturnType<typeof createMemory>["startDream"]
  undoMemory: ReturnType<typeof createMemory>["undoMemory"]
  runStashCommand: ReturnType<typeof createPrompt>["runStashCommand"]
  openDrafts: ReturnType<typeof createPrompt>["openDrafts"]
  sessionNav: ReturnType<typeof import("./session-nav").createSessionNav>
  sessionTree: ReturnType<typeof import("./session-tree").createSessionTree>
  copyAnswer: ReturnType<typeof createPrompt>["copyAnswer"]
  rewind: ReturnType<typeof createSession>["rewind"]
  openHistory(): Promise<void>
  openSkills(): Promise<void>
  openVariants(): Promise<void>
  editInExternalEditor(): Promise<void>
  renameSession(title: string): Promise<void>
  titleCommand(args: string): Promise<void>
  pinCommand(args: string): Promise<void>
  settleCommand(args: string): Promise<void>
  prMetadata(args: string): Promise<boolean>
  fanoutCommand(args: string): Promise<void>
  forkCommand: ReturnType<typeof createSession>["forkCommand"]
  exportSession: ReturnType<typeof createTranscriptActions>["exportSession"]
  copyCommand: ReturnType<typeof createTranscriptActions>["copyCommand"]
  openMessageActions: ReturnType<typeof createTranscriptActions>["openMessageActions"]
  editScratch: ReturnType<typeof createScratch>["editScratch"]
  openPermissions: ReturnType<typeof createPermissions>["openPermissions"]
  approveRetry: ReturnType<typeof createPermissions>["approveRetry"]
  openDiagram: ReturnType<typeof createDiagram>["openDiagram"]
  setMode: (next: PresentationMode) => void
  changeProfile: (patch: Partial<TuiProfile>, options?: { session?: boolean }) => void
}) {
  const { input, state, now, editor, localDay, say, fail, requestFrame, setupChoice, drafts } = ctx
  const { openAcp, setSidebar, footerSegments, switchSession, openSessions, attachPasted, loadUsage, loadMemoryCategories, loadMemories, loadContext, loadSecrets, loadChanges, loadPetChoices, loadStorage, loadAgents, loadMcps, authMcp, loadTools, loadPackages, openSetup, loadStatus, loadExtensionsReport, openHooks, trustCommand, agentCommand, themeCommand, modelCommand, openConnect, loadProviders, loadLoops, createLoop, goalCommand, limitCommand, openWorkflows, workflowCommand, askAside, openFetch, setPermission, startDream, undoMemory, runStashCommand, copyAnswer, rewind, forkCommand, exportSession, editScratch, openPermissions, approveRetry, openDiagram, setMode, changeProfile } = actions

  /** Opens a session `/new` or `/bg` just made: in a fresh workspace when `git.newSessionWorktree` is on, and a line when it could not be. */
  async function enterNewSession(sessionId: SessionId) {
    const stayed = await actions.placeNewSession(sessionId)
    await switchSession(sessionId)
    if (stayed) say(stayed, "info")
  }

  function sidebarCommand(args: string) {
    const requested = args.trim().toLowerCase()
    if (requested === "") {
      const { width } = input.screen.size
      if (sidebarVisible({ mode: state.tuiProfile.sidebar, width, minimal: false })) return setSidebar("hidden")
      if (width < BREAKPOINTS.wide) return say(`the sidebar needs ${BREAKPOINTS.wide} columns`, "warning")
      return setSidebar("auto")
    }
    const chosen = SIDEBAR_MODES.find((candidate) => candidate === requested)
    if (!chosen) {
      state.notice = `usage: /sidebar [${SIDEBAR_MODES.join(" | ")}]`
      return
    }
    setSidebar(chosen)
  }

  // ─── /connect and /providers ─────────────────────────────────────────────────────────────────────────────────────────

  /** `/footer +branch -quota` | `reset` | bare ids; saved at once and echoed in the notice. */
  async function footerCommand(args: string) {
    // `rows N`, `row N a b`, `preset NAME` and `icons MODE` shape the footer's rows (profile keys footerRows, footerIcons).
    const rows = parseFooterRowsCommand(args, { rows: state.tuiProfile.footerRows, icons: state.tuiProfile.footerIcons })
    if (rows) {
      if (rows.ok) changeProfile(rows.patch)
      state.notice = rows.ok ? rows.notice : rows.error
      requestFrame()
      return
    }
    const parsed = parseFooterCommand(args, footerSegments())
    if (!parsed.ok) {
      state.notice = parsed.error
      return
    }
    if (args.trim()) await setupChoice({ footer: parsed.segments })
    if (args.trim().toLowerCase() === "reset" && state.tuiProfile.footerRows.length) changeProfile({ footerRows: [] })
    const shown = state.tuiProfile.footerRows.length && !args.trim().toLowerCase().startsWith("reset") ? `rows: ${state.tuiProfile.footerRows.length} (/footer rows 0 to clear) · single row: ` : "footer: "
    state.notice = `${shown}${parsed.segments.join(" ")}`
  }

  /** Opens another page from a link row of a page, leaving the prompt's draft as it was. */
  async function openFromPage(command: string) {
    const draft = editor.text
    await runSlash(`/${command}`)
    if (draft) editor.insert(draft)
  }

  /** Loads a page's module on first use; a "loading…" notice shows only when the import takes over 50 ms. */
  async function loadPage(name: Parameters<typeof preload>[0] | undefined) {
    if (!name) return
    await preload(name, {
      onSlow: () => {
        state.notice = "loading…"
        requestFrame()
      },
    })
    if (state.notice === "loading…") state.notice = ""
  }

  async function runSlash(text: string) {
    const invocation = parseSlash(text)
    if (invocation) actions.recordSlash?.(invocation.command.name)
    if (await actions.diagnosticsCommand(text)) { editor.clear(); return true }
    if (await actions.worktreesCommand(text)) { editor.clear(); return true }
    if (await actions.compoundCommand(text)) { editor.clear(); return true }
    if (await actions.releaseCommand(text)) { editor.clear(); return true }
    if (await actions.tsmCommand(text)) { editor.clear(); return true }
    if (await actions.quickCommand(text)) { editor.clear(); return true }
    if (await actions.importCommand(text)) { editor.clear(); return true }
    if (await actions.shareStaticCommand(text)) { editor.clear(); return true }
    if (await actions.sandboxCommand(text)) { editor.clear(); return true }
    if (await actions.addDirCommand(text)) { editor.clear(); return true }
    if (await actions.remoteControlCommand(text)) { editor.clear(); return true }
    if (await actions.voiceCommand(text)) { editor.clear(); return true }
    if (await actions.consoleCommand(text)) { editor.clear(); return true }
    if (await actions.mflowCommand(text)) { editor.clear(); return true }
    const parsed = parseSlash(text)
    if (!parsed) return false
    if (parsed.command.custom) return false
    // `/pr comments` is the daemon's `pr-comments` template: the prompt path expands it (prompt.ts expandCustom).
    if (parsed.command.name === "pr" && /^comments(?:\s|$)/i.test(parsed.args)) return false
    editor.clear()
    ctx.toasts.dismiss()
    state.notice = ""
    await loadPage(slashPage(parsed.command.name))
    switch (parsed.command.name) {
      case "queue":
        await actions.queueCommand(parsed.args)
        return true
      case "tasks": {
        await actions.openTasks()
        break
      }
      case "ps":
        await actions.openPs()
        break
      case "pause":
      case "unpause":
      case "stop": {
        const target = parsed.args.trim() || state.sessionId
        if (/\s/.test(target)) { fail(`usage: /${parsed.command.name} [session-id]`); break }
        await actions.controlSession(target, parsed.command.name === "unpause" ? "resume" : parsed.command.name)
        break
      }
      case "relaunch": {
        const stopped = (state.agentRoot ?? state.transcript).agentThreads().filter((thread) => thread.stoppedByUser && !state.relaunched.has(thread.itemId))
        if (!stopped.length) { fail("no sub-agent stopped by esc to relaunch"); break }
        const targets = relaunchTargets(stopped, parsed.args)
        if (!targets.length) { fail(`no stopped sub-agent matches "${parsed.args.trim()}"`); break }
        const sent = await input.send({ type: "user.submit", sessionId: state.sessionId, text: relaunchMessage(targets), attachments: [] })
        if (!sent.ok) { fail(sent.error.message); break }
        for (const thread of targets) state.relaunched.add(thread.itemId)
        break
      }
      case "bg": {
        const detached = await input.send({ type: "session.detach", sessionId: state.sessionId })
        if (!detached.ok) { fail(detached.error.message); break }
        changeProfile({ homeRightPanel: "agentManager", homeLayout: "split" })
        await loadAgents()
        const reply = await input.send({ type: "session.create", directory: input.directory ?? "", title: "" })
        if (reply.ok) await enterNewSession(reply.result?.sessionId as SessionId)
        else fail(reply.error.message)
        break
      }
      case "new": {
        const reply = await input.send({ type: "session.create", directory: input.directory ?? "", title: "", reuseEmpty: true })
        if (reply.ok) await enterNewSession(reply.result?.sessionId as SessionId)
        else fail(reply.error.message)
        break
      }
      case "sessions":
        await openSessions()
        break
      // `/open src/app.rs:120-140` opens a file in the viewer (`@` completes the path); `/open close` or a bare `/open` with a file open closes it.
      case "open": {
        const raw = parsed.args.trim()
        if (!raw || raw === "close") {
          if (state.fileViewer) actions.fileOpen.close()
          else say("usage: /open <path>[:line[-line]]", "info")
        } else actions.fileOpen.openTarget(raw)
        break
      }
      case "attach": {
        const raw = parsed.args.trim()
        if (!raw) state.notice = "usage: /attach <path>"
        else await attachPasted(raw)
        break
      }
      case "usage":
      case "stats-project":
        state.page = "usage"
        state.usageState = createUsagePageState(localDay(now()))
        if (parsed.command.name === "stats-project") state.usageState.scope = "project"
        state.usageReport = undefined
        requestFrame()
        await loadUsage()
        break
      case "help":
        state.page = "help"
        break
      case "memory":
        if (parsed.args.trim().toLowerCase() === "undo") {
          await undoMemory()
          break
        }
        state.page = "memory"
        state.memoryState = createMemoryPageState()
        state.memoryGraph = undefined
        state.dreamRuns = undefined
        state.evolutionData = undefined
        state.dreamReportAsked.clear()
        requestFrame()
        void loadMemoryCategories()
        await loadMemories()
        break
      case "theme":
        await themeCommand(parsed.args)
        break
      case "context":
        state.page = "context"
        state.contextReport = undefined
        state.contextState = {}
        state.contextError = ""
        requestFrame()
        await loadContext()
        break
      case "files":
        await actions.filesCommand()
        break
      case "context-window":
        await actions.contextWindowCommand(parsed.args)
        break
      case "env":
      case "privacy":
        await actions.openEnvironment(parsed.command.name === "privacy")
        break
      case "secrets":
        state.page = "secrets"
        state.secretsVisit++
        state.secretsState = createSecretsPageState()
        state.secretsList = undefined
        state.secretsError = ""
        requestFrame()
        await loadSecrets()
        break
      case "git":
        await actions.openGit(parsed.args)
        break
      case "changes":
        if (!await actions.selectChangesSource(parsed.args)) break
        state.page = "changes"
        state.changesState = createChangesPageState(!state.changesSource && input.dataDir ? readReviewComments(input.dataDir, state.sessionId) : [])
        if (/^replay\b/.test(parsed.args.trim())) state.changesState = { ...state.changesState, replay: true, focus: "diff" }
        state.changesReport = undefined
        state.changesError = ""
        requestFrame()
        await loadChanges()
        break
      case "pet": {
        // `/pet small|medium|large` is the session pet's size. A pet is chosen by reference (`user:<id>`), never by name, so no pet answers to these words.
        const size = parsed.args.trim().toLowerCase()
        if (size === "small" || size === "medium" || size === "large") {
          changeProfile({ petSize: size })
          break
        }
        if (await actions.petCommand(parsed.args)) break
        if (parsed.args.trim()) {
          const ref = parsed.args.trim()
          // One pet: the start screen's mascot follows it, as in the picker.
          changeProfile({ pet: ref, ...(ref === "off" ? {} : { homeMascot: normalizeHomeMascot(ref) }) })
          await setupChoice({ pet: parsed.args.trim() === "off" ? null : parsed.args.trim() })
          break
        }
        state.page = "pet"
        state.petPickerMascot = false
        state.petList = undefined
        state.petPicker = { selected: 0 }
        requestFrame()
        await loadPetChoices()
        break
      }
      case "storage":
        state.page = "storage"
        state.storageState = createStoragePageState()
        state.storageReport = undefined
        state.storageError = ""
        requestFrame()
        await loadStorage()
        break
      case "agents":
        if (parsed.args) {
          await actions.peerCommand(parsed.args)
          break
        }
        state.page = "agents"
        state.agentsState = createAgentsPageState()
        requestFrame()
        await loadAgents()
        break
      case "ide":
        await actions.ideCommand(parsed.args)
        break
      case "acp":
        await openAcp()
        break
      case "mcps":
        state.page = "mcps"
        state.mcpsState = createMcpsPageState()
        state.mcpsReport = undefined
        state.mcpsError = ""
        requestFrame()
        await loadMcps()
        if (parsed.args) {
          const match = /^auth\s+(\S+)$/.exec(parsed.args.trim())
          if (match) {
            await authMcp(match[1]!)
          } else state.notice = "usage: /mcp auth <server>"
        }
        break
      case "tools":
        state.page = "tools"
        state.toolsState = createToolsPageState()
        state.toolsReport = undefined
        state.toolsError = ""
        requestFrame()
        await loadTools()
        break
      case "packages":
        state.page = "packages"
        state.packagesState = createPackagesPageState()
        state.packagesReport = undefined
        state.packagesError = ""
        requestFrame()
        await loadPackages()
        break
      case "intro":
        await actions.openIntro()
        break
      case "setup":
        await openSetup({ advanced: /^advanced$/i.test(parsed.args.trim()) })
        break
      case "customize":
        await actions.loadPromptMode()
        state.page = "customize"
        state.customizeState = createCustomizePageState()
        break
      case "vim": {
        const arg = parsed.args.trim().toLowerCase()
        if (arg !== "" && arg !== "on" && arg !== "off" && arg !== "toggle") { state.notice = "usage: /vim [on|off|toggle]"; break }
        const next = arg === "on" ? true : arg === "off" ? false : !state.tuiProfile.vimMode
        ctx.vim.reset()
        changeProfile({ vimMode: next })
        say(next ? "vim mode on · esc for normal mode" : "vim mode off", "success")
        break
      }
      case "multiline": {
        const arg = parsed.args.trim().toLowerCase()
        if (arg !== "" && arg !== "on" && arg !== "off" && arg !== "toggle") { state.notice = "usage: /multiline [on|off|toggle]"; break }
        const next = arg === "on" ? true : arg === "off" ? false : !state.tuiProfile.multiline
        changeProfile({ multiline: next })
        say(next ? keyText("multiline on · enter adds a line · alt+enter sends") : "multiline off · enter sends", "success")
        break
      }
      case "accessible": {
        const arg = parsed.args.trim().toLowerCase()
        if (arg !== "" && arg !== "on" && arg !== "off" && arg !== "toggle") { state.notice = "usage: /accessible [on|off|toggle]"; break }
        const next = arg === "on" ? true : arg === "off" ? false : !state.tuiProfile.accessible
        changeProfile({ accessible: next })
        say(next ? "screen-reader mode on · plain text, no animation · inline screen and no mouse from the next launch (or mendcode --accessible)" : "screen-reader mode off · normal look back · the screen and mouse follow at the next launch", "success")
        break
      }
      case "shortcuts":
        state.shortcuts = true
        break
      case "prompt-history":
        await actions.composer.openSearch(parsed.args)
        break
      case "backtrack":
        await actions.composer.openBacktrack()
        break
      case "keymap":
        await actions.openKeymap()
        break
      case "terminal-setup":
        await actions.openTerminalSetup()
        break
      case "tutorial":
        await actions.openTutorial(parsed.args)
        break
      case "doctor":
        await actions.doctorCommand()
        break
      case "prompt-mode":
        await actions.openPromptMode(parsed.args)
        break
      case "prompt-chrome":
      case "presentation":
      case "message-rendering":
      case "submit-scroll": {
        // All selectors share the existing customization factory and persistence.
        await preload("customize")
        const field = { "prompt-chrome": "promptChrome", presentation: "presentation", "message-rendering": "messageRenderer", "submit-scroll": "submitScroll" }[parsed.command.name] as "promptContext" | "promptChrome" | "presentation" | "messageRenderer" | "submitScroll"
        const values = { promptContext: ["minimal", "focus", "guide", "full", "custom"], promptChrome: ["box", "top-bottom", "minimal", "ascii-box"], presentation: ["raw", "minimal", "mendcode", "full", "balanced", "auto"], messageRenderer: ["plain", "markdown", "full"], submitScroll: ["bottom", "clear"] }
        const selected = field === "messageRenderer" && parsed.args === "rich" ? "full" : parsed.args
        if (selected && !values[field].includes(selected)) { state.notice = `usage: /${parsed.command.name} ${values[field].join("|")}`; break }
        if (parsed.args) {
          const patch = { [field]: selected } as Partial<TuiProfile>
          if (field === "presentation") {
            patch.messageRenderer = parsed.args === "raw" ? "plain" : parsed.args === "minimal" ? "markdown" : "full"
            patch.reasoning = parsed.args === "raw" ? "expanded" : "collapsed"
          }
          changeProfile(patch)
        } else {
          state.page = "customize"
          state.customizeState = { row: customizeRow(field) }
        }
        break
      }
      case "timestamps": changeProfile({ timestamps: !state.tuiProfile.timestamps }, { session: true }); break
      case "thinking": changeProfile({ reasoning: state.tuiProfile.reasoning === "hidden" ? "expanded" : "hidden" }, { session: true }); break
      case "scrollbar": {
        // `/scrollbar auto|always|off` sets it; bare (and the bound toggle) it switches between off and the bar that was always there when it was on.
        const modes = ["auto", "always", "off"]
        if (parsed.args && !modes.includes(parsed.args)) { state.notice = `usage: /scrollbar ${modes.join("|")}`; break }
        changeProfile({ scrollbar: (parsed.args || (state.tuiProfile.scrollbar === "off" ? "always" : "off")) as TuiProfile["scrollbar"] }, { session: true })
        break
      }
      case "jump-to-latest": {
        const positions = ["right", "center", "left", "off"]
        if (parsed.args && !positions.includes(parsed.args)) { state.notice = `usage: /jump-to-latest ${positions.join("|")}`; break }
        if (parsed.args) changeProfile({ jumpHint: parsed.args as TuiProfile["jumpHint"] })
        else {
          await preload("customize")
          state.page = "customize"
          state.customizeState = { row: customizeRow("jumpHint") }
        }
        break
      }
      case "mascot": {
        // `/mascot <pet>|mend` chooses the home mascot and shows it with the title; `off` goes back to the title alone;
        // `animated|static` set a pet's motion, `small|medium|large` its size. Bare, it opens the list (pets need the full tier).
        const arg = parsed.args.trim().replace(/^"(.*)"$/, "$1")
        const word = arg.toLowerCase()
        const shown = state.tuiProfile.logoKind === "mascot" || state.tuiProfile.logoKind === "both"
        const show = shown ? {} : { logoKind: "both" as const }
        const pets = featureOn(state.settingsNow, "pets")
        if (word === "mend") changeProfile({ homeMascot: "mend", ...show })
        else if (word === "mendy") {
          // The built-in sprite of that name was removed; the value keeps working as the ASCII mascot.
          changeProfile({ homeMascot: "mend", ...show })
          ctx.say("Mendy was retired · showing Mend · /pet import <picture> brings your own", "info")
        } else if (word === "off") changeProfile({ logoKind: "wordmark" })
        else if (word === "animated" || word === "static") changeProfile({ mascotMotion: word === "animated" })
        else if (word === "small" || word === "medium" || word === "large") changeProfile({ mascotSize: word })
        else if (!pets) ctx.say(arg ? "A pet mascot needs full tier (/tier full) · /mascot mend is the ASCII one" : "usage: /mascot mend|off · pets need full tier (/tier full)", "info")
        else if (arg) {
          const names = await actions.petNames()
          const pet = names.find((item) => item.ref === arg) ?? names.find((item) => item.id.toLowerCase() === word) ?? names.find((item) => item.name.toLowerCase() === word)
          if (pet) changeProfile({ homeMascot: pet.ref, ...show })
          else state.notice = `no pet named ${arg} · /mascot lists them · usage: /mascot <pet>|mend|off|animated|static|small|medium|large`
        } else {
          state.page = "pet"
          state.petPickerMascot = true
          state.petList = undefined
          state.petPicker = { selected: 0 }
          requestFrame()
          await loadPetChoices()
        }
        break
      }
      case "comments": {
        // `/comments` lists the pending ones; `reply` walks the newest answer; `clear` drops them; `on|off|auto` set the feature; `settings` opens its rows.
        const words = ["list", "reply", "clear", "on", "off", "auto", "settings"]
        const word = parsed.args.trim().toLowerCase() || "list"
        if (!words.includes(word)) { state.notice = `usage: /comments ${words.join("|")}`; break }
        if (word === "on" || word === "off" || word === "auto") changeProfile({ comments: word })
        else if (word === "settings") {
          await preload("customize")
          state.page = "customize"
          state.customizeState = { row: customizeRow("comments") }
        } else if (word === "clear") ctx.comments.run("comment.clear")
        else if (word === "reply") ctx.comments.run("comment.reply")
        else ctx.comments.run("comment.list")
        break
      }
      case "activity": {
        // `/activity above|inside|transcript|off` places it; `+tps -model`, bare part names or `reset` shape what it shows.
        const next = parseActivityCommand(parsed.args, state.tuiProfile.activityParts)
        if (!next.ok) { state.notice = next.error; break }
        if (Object.keys(next.patch).length) changeProfile(next.patch)
        else {
          await preload("customize")
          state.page = "customize"
          state.customizeState = { row: customizeRow("activityPlacement") }
        }
        break
      }
      case "terminal-title": changeProfile({ terminalTitle: !state.tuiProfile.terminalTitle }); break
      case "sticky-prompt": changeProfile({ stickyPrompt: !state.tuiProfile.stickyPrompt }); break
      case "find": actions.openFind(parsed.args); break
      // Copy-friendly output: plain text with no chrome, and back to the automatic look.
      case "raw": changeProfile(state.tuiProfile.presentation === "raw" ? { presentation: "auto", messageRenderer: "full", reasoning: "auto" } : { presentation: "raw", messageRenderer: "plain", reasoning: "expanded" }); break
      case "tips": changeProfile({ homeTips: !state.tuiProfile.homeTips }); break
      case "username": changeProfile(parsed.args ? { username: parsed.args, showUsername: true } : { showUsername: !state.tuiProfile.showUsername }); break
      case "settings":
        state.page = "settings"
        state.settingsPageState = { ...createSettingsPageState(), ...(parsed.args ? { tui: parsed.args } : {}) }
        if (parsed.args) {
          await preload("customize")
          const row = customizeRow(parsed.args)
          if (row < 0) { state.settingsPageState = createSettingsPageState(); state.notice = "Unknown setting"; break }
          state.customizeState = { row }
        }
        break
      case "status":
        state.page = "status"
        state.statusState = createStatusPageState()
        ;[state.statusInfo, state.statusInfoError, state.statusModels, state.mcpsReport, state.mcpsError, state.storageReport, state.storageError, state.extensionsReport, state.extensionsError] = [undefined, "", undefined, undefined, "", undefined, "", undefined, ""]
        requestFrame()
        await loadStatus()
        break
      case "hooks":
        await openHooks()
        break
      case "trust":
        await trustCommand(parsed.args)
        break
      case "extensions":
        if (parsed.args.trim() === "reload") {
          const reply = await input.send({ type: "extensions.reload", directory: input.directory ?? "" })
          if (!reply.ok) fail(reply.error.message)
          else say("Extensions reloaded")
          break
        }
        state.page = "extensions"
        state.extensionsState = createExtensionsPageState()
        state.extensionsReport = undefined
        state.extensionsError = ""
        requestFrame()
        await loadExtensionsReport()
        break
      case "agent":
        await agentCommand(parsed.args)
        break
      case "model":
        await modelCommand(parsed.args)
        break
      case "connect":
        await openConnect(parsed.args)
        break
      case "providers":
        state.page = "providers"
        state.providersState = createProvidersPageState()
        state.providersList = undefined
        state.providersError = ""
        requestFrame()
        await loadProviders()
        break
      case "loops":
        if (parsed.args || /^\/loop(?:\s|$)/i.test(text)) { await createLoop(parsed.args); break }
        state.page = "loops"
        state.loopsState = createLoopsPageState()
        state.loopsLoaded = false
        state.loopsError = ""
        requestFrame()
        await loadLoops()
        break
      case "loop":
        await createLoop(parsed.args)
        break
      case "goal":
        await goalCommand(parsed.args)
        break
      case "pr":
        if (!await actions.prMetadata(parsed.args)) await actions.prCommand(parsed.args)
        break
      case "limit":
        await limitCommand(parsed.args)
        break
      case "daemon":
        await actions.daemonCommand(parsed.args)
        break
      case "restart":
      case "reload":
        await actions.whenIdle(parsed.command.name)
        break
      case "workflows":
        if (parsed.args) await workflowCommand(parsed.args)
        else await openWorkflows()
        break
      case "btw":
        // Not awaited: the prompt stays usable while the answer is on its way.
        void askAside(parsed.args)
        break
      case "fetch":
        await openFetch()
        break
      case "remember": {
        const user = /^--user\b/.test(parsed.args)
        const text = parsed.args.replace(/^--user\b\s*/, "").trim()
        if (!text) {
          state.notice = "usage: /remember [--user] <text>"
          break
        }
        const reply = await input.send({ type: "memory.add", scope: user ? "user" : "project", ...(input.directory ? { directory: input.directory } : {}), text })
        if (reply.ok) say(`remembered (${user ? "all projects" : "this project"})`, "success")
        else fail(reply.error.message)
        break
      }
      case "plan":
        await setPermission(state.transcript.permissionMode === "plan" ? "ask" : "plan")
        break
      case "dream":
        await startDream()
        break
      case "stash":
        // The command itself is what sits in the prompt, so it cannot stash the prompt: that is the keys' job.
        await runStashCommand(parsed.args === "" ? "list" : parsed.args)
        break
      case "drafts":
        await actions.openDrafts()
        break
      case "tree":
        await actions.sessionTree.open()
        break
      case "label":
        await actions.sessionTree.labelCommand(parsed.args)
        break
      case "recap":
        await actions.sessionNav.recapCommand(parsed.args)
        break
      case "changelog":
        await actions.sessionNav.changelogCommand()
        break
      case "copy": {
        await actions.copyCommand(parsed.args)
        break
      }
      case "compaction":
        await actions.openCompaction()
        break
      case "compact": {
        // Queued like a message: it runs now if idle, or right after the current turn.
        const busy = state.transcript.activeTurn !== undefined
        const reply = await input.send({ type: "session.compact", sessionId: state.sessionId })
        if (!reply.ok) fail(reply.error.message)
        else if (busy) say("compaction queued after this turn")
        break
      }
      case "undo":
        await rewind("undo")
        break
      case "redo":
        await rewind("redo")
        break
      case "history":
        await actions.openHistory()
        break
      case "skills":
        await actions.openSkills()
        break
      case "variants":
        await actions.openVariants()
        break
      case "editor":
        await actions.editInExternalEditor()
        break
      case "rename":
        await actions.renameSession(parsed.args)
        break
      case "title": await actions.titleCommand(parsed.args); break
      case "pin": await actions.pinCommand(parsed.args); break
      case "settle": await actions.settleCommand(parsed.args); break
      case "fanout": await actions.fanoutCommand(parsed.args); break
      case "timeline":
        await actions.sessionTree.open({ filter: "messages" })
        break
      case "fork":
        await forkCommand(parsed.args)
        break
      case "handoff":
        await forkCommand(`handoff ${parsed.args}`)
        break
      case "export":
        await exportSession(parsed.args)
        break
      case "sidebar":
        if (!(await actions.rightSidebarCommand(parsed.args))) sidebarCommand(parsed.args)
        break
      case "panel":
        await actions.rightSidebarCommand(parsed.args, true)
        break
      case "scratch":
        await editScratch()
        break
      case "backlog":
        await runBacklogCommand(ctx, { switchSession: (sessionId) => switchSession(sessionId as SessionId), openFile: (target) => actions.fileOpen.openTarget(target) }, parsed.args)
        break
      case "permissions": {
        const requested = parsed.args.toLowerCase()
        if (!requested) {
          await openPermissions()
          break
        }
        const next = SELECTABLE_PERMISSION_MODES.find((m) => m === requested)
        if (!next) state.notice = `unknown permission mode: ${requested} (ask, smart, edits, full, plan)`
        else await setPermission(next)
        break
      }
      case "approve":
        await approveRetry()
        break
      case "diagram":
        openDiagram(parsed.args)
        break
      case "view": {
        const requested = parsed.args.toLowerCase()
        const next = PRESENTATION_MODES.find((m) => m === requested) ?? PRESENTATION_MODES[(PRESENTATION_MODES.indexOf(state.mode) + 1) % PRESENTATION_MODES.length]!
        if (requested && next !== requested) state.notice = `unknown view: ${requested} (minimal, balanced, full)`
        else setMode(next)
        break
      }
      case "footer":
        await footerCommand(parsed.args)
        break
      case "quit":
        if (state.pulse) clearInterval(state.pulse)
        drafts.flush()
        await actions.releaseBackgroundWriter()
        input.exit()
        break
      case "messages":
        await actions.openMessageActions()
        break
      case "plan-review":
        await actions.openPlanReview()
        break
      case "marketplace":
        await actions.openMarketplace(parsed.args)
        break
      case "mend-assets":
        await actions.openAssets()
        break
      case "ai-config":
        await actions.aiConfigCommand(parsed.args)
        break
    }
    requestFrame()
    return true
  }

  return { openFromPage, loadPage, runSlash }
}
