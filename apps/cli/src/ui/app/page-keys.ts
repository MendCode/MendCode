import { inProject } from "../../view/project-scope"
import type { createSession } from "./session"
import { helpKeyRows, helpPageWindow, type HelpExtensions } from "../../view/help-page"
import { listedBuiltins } from "../../view/commands"
import type { createLoops } from "./loops"
import type { createWorkflows } from "./workflows"
import type { createPermissions } from "./permissions"
import type { createDiagram } from "./diagram"
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
import { agentPickerKey, changesPageKey, contextPageStateKey, toolsPageKey, loopsPageKey, mcpsPageKey, memoryGraphCanvas, memoryPageKey, setupPageKey, storagePageKey, usagePageKey, usageSelectedSession, usageWasteAction, usageWasteOpen, agentsPageKey, packagesPageKey, petPickerKey, workflowsPageKey, customizePageKey, settingsPageKey, statusPageKey, extensionItems, extensionsPageKey, hooksPageKey, connectKey, providersPageKey, secretsPageKey, permissionsPageKey, diagramBounds, diagramViewKey } from "../lazy-pages"
import { activeTheme, SYSTEM_THEME, themeNames } from "../theme"
import type { Settings, PermissionMode, SessionId } from "@mendcode/protocol"
import { modelPageKey } from "../../view/model-page"
import { preload, onboardingKey } from "../lazy-pages"
import { keyName } from "../keymap"
import { DEFAULT_TUI_PROFILE, normalizeHomeMascot, type TuiProfile } from "../../view/tui-profile"
import { sessionListKey } from "../../view/session-list"
import { slashCatalog } from "../../view/commands"
import { viewRows } from "./view-rows"
import { scaffoldView } from "../../extensions/view-scaffold"
import type { PresentationMode } from "../../view/transcript"

export function createPageKeys(ctx: AppContext, actions: {
  environmentKey(key: string): Promise<void>
  petPlanKey(key: string): Promise<boolean>
  slashCommands?: () => import("../../view/commands").SlashCommand[]
  tasksKey(key: string): Promise<void>
  controlSession: ReturnType<typeof createAgents>["controlSession"]
  loadBackgroundSessions(): Promise<void>
  openAutomationLedger(scope: "workflow" | "loop", ownerId: string, name: string): Promise<void>
  automationLedgerKey(key: string): Promise<void>
  catalogKey(key: string): Promise<void>
  openMarketplace(sourceId?: string): Promise<void>
  transcriptActionsKey(key: string): Promise<void>
  openMessageActions: ReturnType<typeof import("./transcript-actions").createTranscriptActions>["openMessageActions"]
  compactionKey(key: string): Promise<void>
  openPromptMode(args?: string): Promise<void>
  promptModeKey(key: string): Promise<void>
  openPeerCommands(): Promise<void>
  peerCommandKey(key: string): Promise<SessionId | undefined>
  diagnosticsKey(key: string): Promise<void>
  worktreesKey(key: string): Promise<void>
  gitKey(key: string): Promise<boolean>
  compoundKey(key: string): Promise<void>
  aiConfigKey(key: string): Promise<void>
  releaseKey(key: string): Promise<void>
  tsmKey(key: string): Promise<void>
  mflowKey(key: string): Promise<void>
  keymapKey(key: string): Promise<void>
  terminalSetupKey(key: string): void
  tutorialPageKey(key: string): void
  consoleKey(key: string): Promise<void>
  historyKey(key: string): Promise<void>
  skillsKey(key: string): Promise<void>
  modelPickerKey(key: string): Promise<void>
  themePickerKey(key: string): Promise<void>
  variantsKey(key: string): Promise<void>
  closeExtensionPage: () => void
  sessionNav: ReturnType<typeof import("./session-nav").createSessionNav>
  sessionTree: ReturnType<typeof import("./session-tree").createSessionTree>
  switchSession: ReturnType<typeof createSession>["switchSession"]
  changeSession: ReturnType<typeof createSession>["changeSession"]
  reloadSessions: ReturnType<typeof createSession>["reloadSessions"]
  searchSessionContent: ReturnType<typeof createSession>["searchSessionContent"]
  forkAt: ReturnType<typeof createSession>["forkAt"]
  jumpTo: ReturnType<typeof createSession>["jumpTo"]
  loadUsage: ReturnType<typeof createUsage>["loadUsage"]
  usageSettingsKey: ReturnType<typeof createUsage>["usageSettingsKey"]
  loadWaste: ReturnType<typeof createUsage>["loadWaste"]
  applyWaste: ReturnType<typeof createUsage>["applyWaste"]
  openMemoryAssistant(): Promise<void>
  memoryAssistantKey(key: string): Promise<void>
  memoryPageData: ReturnType<typeof createMemory>["memoryPageData"]
  loadMemoryGraph: ReturnType<typeof createMemory>["loadMemoryGraph"]
  loadDreamRuns: ReturnType<typeof createMemory>["loadDreamRuns"]
  loadMemoryCategories: ReturnType<typeof createMemory>["loadMemoryCategories"]
  loadEvolution: ReturnType<typeof createMemory>["loadEvolution"]
  loadDreamReport: ReturnType<typeof createMemory>["loadDreamReport"]
  loadSharing: ReturnType<typeof createMemory>["loadSharing"]
  memoryAction: ReturnType<typeof createMemory>["memoryAction"]
  storageAction: ReturnType<typeof createStorage>["storageAction"]
  dropRevealedSecret: ReturnType<typeof createSecrets>["dropRevealedSecret"]
  revealSecret: ReturnType<typeof createSecrets>["revealSecret"]
  forgetSecret: ReturnType<typeof createSecrets>["forgetSecret"]
  authMcp: ReturnType<typeof createAgents>["authMcp"]
  copyAuthMcp: ReturnType<typeof createAgents>["copyAuthMcp"]
  loadMcpCatalog: ReturnType<typeof createAgents>["loadMcpCatalog"]
  readMcpResource: ReturnType<typeof createAgents>["readMcpResource"]
  acpKey: (key: string) => Promise<void>
  ideKey(key: string): Promise<void>
  restartMcp: ReturnType<typeof createAgents>["restartMcp"]
  decideMcp: ReturnType<typeof createAgents>["decideMcp"]
  loadTools: ReturnType<typeof createAgents>["loadTools"]
  loadPackages: ReturnType<typeof createAgents>["loadPackages"]
  profileLayers: () => import("./profile-layers").ProfileLayers
  openPrecedence: () => Promise<void>
  chooseAgent: ReturnType<typeof createAgentPicker>["chooseAgent"]
  modelAction: ReturnType<typeof createModel>["modelAction"]
  connectAction: ReturnType<typeof createProviders>["connectAction"]
  providersAction: ReturnType<typeof createProviders>["providersAction"]
  setupValues: ReturnType<typeof createSetup>["setupValues"]
  setupAction: ReturnType<typeof createSetup>["setupAction"]
  onboardingAction: ReturnType<typeof createSetup>["onboardingAction"]
  finishIntro: ReturnType<typeof createSetup>["finishIntro"]
  applyRecipe: ReturnType<typeof createModel>["applyRecipe"]
  changeProfile: (patch: Partial<TuiProfile>) => void
  openFromPage: (command: string) => Promise<void>
  settingsValues: () => { settings: Settings; theme: string; view: PresentationMode; reducedMotion: boolean }
  loadStatus: ReturnType<typeof createStatus>["loadStatus"]
  terminalExtensions: ReturnType<typeof createStatus>["terminalExtensions"]
  helpExtensions: () => HelpExtensions | undefined
  loadExtensionsReport: ReturnType<typeof createStatus>["loadExtensionsReport"]
  loadHooks: ReturnType<typeof createHooks>["loadHooks"]
  setTrust: ReturnType<typeof createHooks>["setTrust"]
  controlLoop: ReturnType<typeof createLoops>["controlLoop"]
  loadLoops: ReturnType<typeof createLoops>["loadLoops"]
  saveLoop: ReturnType<typeof createLoops>["saveLoop"]
  fireLoop: ReturnType<typeof createLoops>["fireLoop"]
  setPermission: (next: PermissionMode) => Promise<void>
  revokeGrant: ReturnType<typeof createPermissions>["revokeGrant"]
  diagramLayout: ReturnType<typeof createDiagram>["diagramLayout"]
  controlWorkflow: ReturnType<typeof createWorkflows>["controlWorkflow"]
  loadWorkflows: ReturnType<typeof createWorkflows>["loadWorkflows"]
  loadContext: ReturnType<typeof createContext>["loadContext"]
  saveReview: ReturnType<typeof createChanges>["saveReview"]
  loadChanges: ReturnType<typeof createChanges>["loadChanges"]
  sendReview: ReturnType<typeof createChanges>["sendReview"]
  orderReview: ReturnType<typeof createChanges>["orderReview"]
  viewChangedFile: ReturnType<typeof createChanges>["viewChangedFile"]
  ensureSelectedDiff: ReturnType<typeof createChanges>["ensureSelectedDiff"]
}) {
  const { input, state, now, editor, localDay, requestFrame, copyText, setupChoice } = ctx
  const { acpKey, closeExtensionPage, switchSession, changeSession, forkAt, jumpTo, loadUsage, memoryPageData, loadMemoryGraph, loadDreamRuns, loadMemoryCategories, loadEvolution, loadDreamReport, memoryAction, loadSharing, storageAction, dropRevealedSecret, revealSecret, forgetSecret, restartMcp, authMcp, copyAuthMcp, loadTools, loadPackages, chooseAgent, modelAction, connectAction, providersAction, setupValues, applyRecipe, changeProfile, openFromPage, settingsValues, loadStatus, terminalExtensions, loadExtensionsReport, loadHooks, setTrust, controlLoop, loadLoops, saveLoop, fireLoop, setPermission, revokeGrant, diagramLayout, controlWorkflow, loadWorkflows, loadContext, saveReview, loadChanges, sendReview, ensureSelectedDiff } = actions

  async function handlePageKey(key: string) {
    if (state.automationLedger) return actions.automationLedgerKey(key)
    if (await actions.gitKey(key)) { requestFrame(); return }
    if (key === "b" && state.page === "workflows" && state.workflowsLoaded) {
      const run = state.workflows[state.workflowsState.selected]
      if (run) await actions.openAutomationLedger("workflow", run.workflowId, run.name)
      return
    }
    if (key === "b" && state.page === "loops" && state.loopsLoaded && !state.loopsState.form && !state.loopsState.confirm) {
      const loops = state.loops.filter((loop) => (state.loopsState.tab === 1) === ["completed", "stopped"].includes(loop.state))
      const loop = loops[state.loopsState.selected]
      if (loop) await actions.openAutomationLedger("loop", loop.loopId, loop.name)
      return
    }
    if (state.page === "messages" || state.page === "export") return actions.transcriptActionsKey(key)
    if (state.page === "diagnostics") { await actions.diagnosticsKey(key); return }
    if (state.page === "worktrees" || state.page === "warp") { await actions.worktreesKey(key); return }
    if (state.page === "compound") { await actions.compoundKey(key); return }
    if (state.page === "ai-config") { await actions.aiConfigKey(key); return }
    if (state.page === "release-channel") { await actions.releaseKey(key); return }
    if (state.page === "tsm") { await actions.tsmKey(key); return }
    if (state.page === "console" || state.page === "share") { await actions.consoleKey(key); return }
    if (state.page === "mflow") { await actions.mflowKey(key); return }
    if (state.page === "keymap") { await actions.keymapKey(key); return }
    if (state.page === "terminal-setup") { actions.terminalSetupKey(key); return }
    if (state.page === "tutorial") { actions.tutorialPageKey(key); return }
    if (state.page === "help" && ["\x1b[A", "\x1b[B", "\x1b[5~", "\x1b[6~"].includes(key)) {
      const height = input.screen.size.height
      const extensions = actions.helpExtensions()
      const room = helpPageWindow(input.screen.size.width, height - 1, (extensions?.loaded.length ?? 0) + (extensions?.problems.length ?? 0)).visibleRows
      const max = Math.max(0, Math.max(helpKeyRows(state.bindings).length, listedBuiltins(state.settingsNow, state.tuiProfile.slashCommands).length + (state.ext?.commands().length ?? 0)) - room)
      const delta = key.endsWith("A") ? -1 : key.endsWith("B") ? 1 : key === "\x1b[5~" ? -room : room
      state.helpScroll = Math.max(0, Math.min(max, (state.helpScroll ?? 0) + delta))
      return requestFrame()
    }
    if (state.page === "extension") {
      // Typed-ahead text arrives as one chunk; the page gets one key at a time, named like keybindings.json names them.
      const id = state.extPageId
      const keys = /^[\x20-\x7e -￿]{2,}$/u.test(key) ? [...key] : [key]
      for (const each of keys) {
        const handled = id && state.ext ? state.ext.pageKey(id, keyName(each) ?? each, { close: closeExtensionPage, redraw: requestFrame }) : false
        if (!handled && each === "\x1b") closeExtensionPage()
        if (state.page !== "extension") break
      }
      if (state.page === "extension" && !(id && state.ext?.hasPage(id))) closeExtensionPage()
      return requestFrame()
    }
    if (state.page === "marketplace") { await actions.catalogKey(key); return }
    if (state.page === "sessions") {
      const previous = state.sessionList
      const result = sessionListKey(state.sessionList, key, state.sessions, state.sessionId)
      state.sessionList = result.state
      if (result.action.type === "close") state.page = "chat"
      if (result.action.type === "open") await switchSession(result.action.sessionId as SessionId)
      if (result.action.type === "reload") await actions.reloadSessions()
      if (result.action.type === "search") await actions.searchSessionContent()
      if (result.action.type === "rename" || result.action.type === "delete" || result.action.type === "archive" || result.action.type === "tag" || result.action.type === "pin") {
        const saved = await changeSession(result.action)
        if (!saved && result.action.type === "rename") state.sessionList = previous
        else if (state.renameFromChat) state.page = "chat"
      }
      if (state.renameFromChat && previous.edit && !state.sessionList.edit) { state.renameFromChat = false; state.page = "chat" }
    } else if (state.page === "tree") {
      await actions.sessionTree.key(key)
    } else if (state.page === "text") {
      await actions.sessionNav.textKey(key)
    } else if (state.page === "usage") {
      if (await actions.usageSettingsKey(key)) return
      const open = key === "\r" ? usageSelectedSession(state.usageState, state.usageReport) : undefined
      const waste = key === "\r" ? usageWasteAction(state.usageState, state.usageWaste) : undefined
      if (key === "\x1b" || key === "q") state.page = "chat"
      else if (key === "R" || key === "r") await loadUsage()
      else if (waste) await actions.applyWaste(waste)
      else if (open) {
        state.page = "chat"
        await switchSession(open as SessionId)
      } else {
        const next = usagePageKey(state.usageState, key, localDay(now()), state.usageReport, state.usageWaste)
        const rangeChanged = next.range !== state.usageState.range || next.scope !== state.usageState.scope || next.project !== state.usageState.project
        const wasteOpened = usageWasteOpen(next) && !usageWasteOpen(state.usageState)
        state.usageState = next
        if (rangeChanged) {
          state.usageReport = undefined
          state.usageWaste = undefined
          await loadUsage()
        } else if (wasteOpened && !state.usageWaste) await actions.loadWaste()
      }
    } else if (state.page === "tasks") {
      await actions.tasksKey(key)
    } else if (state.page === "memory-assistant") {
      await actions.memoryAssistantKey(key)
    } else if (state.page === "memory") {
      if (key === "t" && !state.memoryState.filtering && state.memoryState.workspace.picking === undefined && state.memoryState.sharing.confirmation === undefined && state.memoryState.extraction.editing === undefined && state.memoryState.dream.typing === undefined && state.memoryState.pick === undefined && !state.memoryState.confirmDelete) return actions.openMemoryAssistant()
      const { width, height } = input.screen.size
      const graph = { report: state.memoryGraph, size: memoryGraphCanvas(width, height - 1, state.memoryWorkspaces !== undefined) }
      const result = memoryPageKey(state.memoryState, key, state.memories, Math.max(1, Math.floor((height - 3) / 3)), graph, state.dreamRuns, memoryPageData(width, height - 1))
      const before = state.memoryState
      const entered = result.state.tab !== before.tab ? result.state.tab : undefined
      state.memoryState = result.state
      if (entered === "sharing") void loadSharing()
      if (entered === "graph") void loadMemoryGraph()
      if (entered === "dream") void loadDreamRuns()
      if (entered === "policies") void loadMemoryCategories()
      if (entered === "evolution") void loadEvolution()
      if (result.state.tab === "dream" && result.state.dream.selected !== before.dream.selected) void loadDreamReport()
      if (result.action.type === "close") state.page = "chat"
      else await memoryAction(result.action)
    } else if (state.page === "pet") {
      if (await actions.petPlanKey(key)) return
      const result = petPickerKey(state.petPicker, key, state.petList ?? [])
      state.petPicker = result.state
      if (result.action.type !== "none") state.page = "chat"
      if (result.action.type === "choose" && state.petPickerMascot) {
        // The same list for the start screen: `o` is the title alone, any entry the mascot shown with the title.
        const shown = state.tuiProfile.logoKind === "mascot" || state.tuiProfile.logoKind === "both"
        changeProfile(result.action.ref === "off" ? { logoKind: "wordmark" } : { homeMascot: result.action.ref, ...(shown ? {} : { logoKind: "both" as const }) })
      } else if (result.action.type === "choose") {
        // One pet: the start screen's mascot follows the one chosen for the prompt (`/mascot` still sets the start screen alone).
        changeProfile({ pet: result.action.ref, ...(result.action.ref === "off" ? {} : { homeMascot: normalizeHomeMascot(result.action.ref) }) })
        await setupChoice({ pet: result.action.ref === "off" ? null : result.action.ref })
      } else if (result.action.type === "fill") ctx.editor.replaceAll(result.action.text)
    } else if (state.page === "storage") {
      const result = storagePageKey(state.storageState, key)
      state.storageState = result.state
      if (result.action.type === "close") state.page = "chat"
      else void storageAction(result.action)
    } else if (state.page === "agent-commands") {
      const sessionId = await actions.peerCommandKey(key)
      if (sessionId) {
        state.page = "chat"
        await switchSession(sessionId)
      }
    } else if (state.page === "agents") {
      if (key === "r") await actions.loadBackgroundSessions()
      const result = agentsPageKey(state.agentsState, key, [...state.agentSessions.values()].filter((s) => inProject(s.directory, ctx.input.directory)), state.agentBackgrounds)
      state.agentsState = result.state
      const { action } = result
      if (action.type === "close") state.page = "chat"
      else if (action.type === "commands") await actions.openPeerCommands()
      else if (action.type === "control") await actions.controlSession(action.sessionId, action.action)
      else if (action.type === "open" || action.type === "approval") {
        state.page = "chat"
        await switchSession(action.sessionId as SessionId)
      }
    } else if (state.page === "env") {
      await actions.environmentKey(key)
    } else if (state.page === "secrets") {
      if (!state.secretsList) {
        if (key === "\x1b" || key === "q") state.page = "chat"
      } else {
        const result = secretsPageKey(state.secretsState, key, state.secretsList)
        state.secretsState = result.state
        if (result.action.type === "close") {
          dropRevealedSecret()
          state.page = "chat"
        }
        if (result.action.type === "reveal") void revealSecret(result.action.n)
        if (result.action.type === "forget") void forgetSecret(result.action.n)
      }
    } else if (state.page === "ide") {
      await actions.ideKey(key)
    } else if (state.page === "acp") {
      await acpKey(key)
    } else if (state.page === "mcps") {
      if (!state.mcpsReport) {
        if (key === "\x1b" || key === "q") state.page = "chat"
      } else {
        const result = mcpsPageKey(state.mcpsState, key, state.mcpsReport.servers)
        state.mcpsState = result.state
        if (result.action.type === "close") state.page = "chat"
        if (result.action.type === "restart") void restartMcp(result.action.server)
        if (result.action.type === "approve" || result.action.type === "reject") await actions.decideMcp(result.action.server, result.action.type === "approve")
        if (result.action.type === "auth") await authMcp(result.action.server)
        if (result.action.type === "copyAuth") copyAuthMcp(result.action.server)
        if (result.action.type === "catalog") void actions.loadMcpCatalog()
        if (result.action.type === "readResource") void actions.readMcpResource(result.action.server, result.action.uri, result.action.id)
        if (result.action.type === "use") {
          state.mcpsState.catalogOpen = false
          state.page = "chat"
          editor.replaceAll(result.action.token)
        }
      }
    } else if (state.page === "tools") {
      if (!state.toolsReport) {
        if (key === "\x1b" || key === "q") state.page = "chat"
      } else {
        const result = toolsPageKey(state.toolsState, key, state.toolsReport.tools)
        state.toolsState = result.state
        if (result.action.type === "close") state.page = "chat"
        if (result.action.type === "trust") void loadTools(result.action.trusted)
      }
    } else if (state.page === "packages") {
      const result = packagesPageKey(state.packagesState, key, state.packagesReport?.packages ?? [], state.activation)
      state.packagesState = result.state
      const { action } = result
      const directory = input.directory ?? ""
      if (action.type === "close") state.page = "chat"
      else if (action.type === "marketplace") await actions.openMarketplace()
      else if (action.type === "precedence") void actions.openPrecedence()
      else if (action.type === "disable-all") void loadPackages({ type: "packages.disable-all", directory }, "all packages deselected")
      else if (action.type === "reload") void loadPackages()
      else if (action.type === "enable") void loadPackages({ type: "packages.enable", directory, key: action.key, enabled: action.enabled, ...(action.switch ? { switch: true } : {}) }, `${action.key} ${action.enabled ? "on" : "off"}`)
      else if (action.type === "keep") actions.profileLayers().keep(action.key, action.on)
      else if (action.type === "remove") void loadPackages({ type: "packages.remove", directory, name: action.name, scope: action.scope }, `removed ${action.scope}:${action.name} (in the Trash for 30 days: mendcode package restore)`)
      else if (action.type === "config") void loadPackages({ type: "packages.config", directory, key: action.key })
      else if (action.type === "resource") void loadPackages({ type: "packages.resource", directory, key: action.key, resource: action.resource, enabled: action.enabled }, `${action.resource} ${action.enabled ? "on" : "off"}`)
    } else if (state.page === "agent") {
      const result = agentPickerKey(state.agentPicker, key, state.agentReport)
      state.agentPicker = result.state
      if (result.action.type === "close") state.page = "chat"
      else if (result.action.type === "choose") await chooseAgent(result.action.name)
    } else if (state.page === "model") {
      const result = modelPageKey(state.modelState, key, state.modelReport, state.recipes)
      if (result.state.reasoning && !state.modelState.reasoning) await preload("reasoning")
      state.modelState = result.state
      await modelAction(result.action)
    } else if (state.page === "connect") {
      const result = connectKey(state.connectState, key)
      state.connectState = result.state
      // Not awaited: the page shows its busy step while the daemon answers, and esc still closes it.
      void connectAction(result.action)
    } else if (state.page === "providers") {
      const result = providersPageKey(state.providersState, key, state.providersList ?? [])
      state.providersState = result.state
      void providersAction(result.action)
    } else if (state.page === "intro") {
      actions.finishIntro()
    } else if (state.page === "setup" && state.onboarding && !state.setupAdvanced) {
      const result = onboardingKey(state.onboarding.state, key, { detected: state.onboarding.detected, firstRun: state.onboarding.firstRun, themes: [SYSTEM_THEME, ...themeNames()] })
      state.onboarding.state = result.state
      await actions.onboardingAction(result.action)
    } else if (state.page === "setup") {
      const result = setupPageKey(state.setupState, key, setupValues(), { themes: themeNames() })
      state.setupState = result.state
      if (result.action.type === "profile") changeProfile(result.action.patch)
      else if (result.action.type === "set") await setupChoice(result.action.patch)
      else if (result.action.type === "recipe") await applyRecipe(result.action.name)
      else if (["preset", "helper", "ask"].includes(result.action.type)) void actions.setupAction(result.action)
      else if (result.action.type === "prompt") await actions.openPromptMode()
      else if (result.action.type === "finish") {
        state.page = "chat"
        await setupChoice({ onboarded: true })
      }
    } else if (state.page === "customize" || state.page === "settings" && state.settingsPageState.tui) {
      const modules = [...new Set([...(state.ext?.loaded ?? []).filter((entry) => entry.tui).map((entry) => entry.name), ...(state.ext?.problems ?? []).map((problem) => problem.extension)])].map((name) => ({ name, enabled: !state.tuiProfile.disabledUiExtensions.includes(name), errors: [] }))
      const result = customizePageKey(state.customizeState, key, { ...state.tuiProfile, ...(input.directory && state.settingsNow.projectThemes?.[input.directory] ? { theme: activeTheme().name } : {}), pet: state.tuiProfile.pet || state.settingsNow.pet || "off" }, modules, actions.slashCommands?.() ?? slashCatalog(), viewRows(state))
      state.customizeState = result.state
      const { action } = result
      if (action.type === "close") state.page = "chat"
      else if (action.type === "set") changeProfile(action.patch)
      else if (action.type === "reset") changeProfile({ ...DEFAULT_TUI_PROFILE })
      else if (action.type === "pet") await openFromPage("pet")
      else if (action.type === "open") await openFromPage(action.command)
      else if (action.type === "toggleExtension") changeProfile({ disabledUiExtensions: state.tuiProfile.disabledUiExtensions.includes(action.name) ? state.tuiProfile.disabledUiExtensions.filter((name) => name !== action.name) : [...state.tuiProfile.disabledUiExtensions, action.name] })
      else if (action.type === "toggleView") changeProfile({ disabledViews: state.tuiProfile.disabledViews.includes(action.slot) ? state.tuiProfile.disabledViews.filter((slot) => slot !== action.slot) : [...state.tuiProfile.disabledViews, action.slot] })
      else if (action.type === "resetView") {
        state.ext?.views.reset(action.slot)
        changeProfile({ disabledViews: state.tuiProfile.disabledViews.filter((slot) => slot !== action.slot) })
        ctx.say(`${action.slot} reset`)
      } else if (action.type === "scaffoldView") {
        if (input.remote || input.pure || !input.dataDir) ctx.fail("views are installed in a local terminal's data dir")
        else {
          const made = scaffoldView({ dataDir: input.dataDir, slot: action.slot })
          if (made.ok) ctx.say(`wrote ${made.file}`)
          else ctx.fail(made.message)
        }
      } else if (action.type === "exportLook") {
        const reply = await input.send({ type: "extensions.export", directory: input.directory ?? "" })
        if (reply.ok) ctx.say(`Look exported: ${reply.result?.file}`)
        else ctx.fail(reply.error.message)
      }
    } else if (state.page === "settings") {
      const result = settingsPageKey(state.settingsPageState, key, settingsValues(), { themes: themeNames() })
      state.settingsPageState = result.state
      const { action } = result
      if (action.type === "close") state.page = "chat"
      else if (action.type === "set") await setupChoice(action.patch)
      else if (action.type === "open") await openFromPage(action.command)
    } else if (state.page === "status") {
      const result = statusPageKey(state.statusState, key)
      state.statusState = result.state
      if (result.action.type === "close") state.page = "chat"
      else if (result.action.type === "refresh") await loadStatus()
    } else if (state.page === "extensions") {
      const result = extensionsPageKey(state.extensionsState, key, extensionItems(state.extensionsReport, terminalExtensions()), state.extensionsReport)
      state.extensionsState = result.state
      const { action } = result
      if (action.type === "close") state.page = "chat"
      else if (action.type === "refresh") await loadExtensionsReport()
      else if (action.type === "trust") {
        // The same project trust /tools sets; the daemon's settings push then lets this terminal load (or drop) them.
        await loadTools(action.trusted)
        await loadExtensionsReport()
      } else if (action.type === "disable") {
        // One switch for both halves: this terminal's profile list and, for a local terminal, the daemon's setting (the daemon then reloads every terminal).
        const rest = state.tuiProfile.disabledUiExtensions.filter((name) => name !== action.name)
        changeProfile({ disabledUiExtensions: action.disabled ? [...rest, action.name] : rest })
        if (!input.remote) {
          const reply = await input.send({ type: "extensions.disable", directory: input.directory ?? "", name: action.name, disabled: action.disabled })
          if (!reply.ok) ctx.fail(reply.error.message)
        }
        ctx.say(`${action.name} ${action.disabled ? "turned off" : "turned on"}`)
        await loadExtensionsReport()
      }
    } else if (state.page === "hooks") {
      if (!state.hooksReport) {
        if (key === "\x1b" || key === "q") state.page = "chat"
      } else {
        const result = hooksPageKey(state.hooksState, key, state.hooksReport)
        state.hooksState = result.state
        if (result.action.type === "close") state.page = "chat"
        else if (result.action.type === "refresh") await loadHooks()
        else if (result.action.type === "trust") {
          const prompting = state.hooksState.prompt
          if (await setTrust(result.action.trusted) && prompting) state.page = "chat"
        }
      }
    } else if (state.page === "loops") {
      if (!state.loopsLoaded) {
        if (key === "\x1b" || key === "q") state.page = "chat"
      } else {
        const result = loopsPageKey(state.loopsState, key, state.loops)
        state.loopsState = result.state
        const { action } = result
        if (action.type === "close") state.page = "chat"
        else if (action.type === "open") {
          state.page = "chat"
          await switchSession(action.sessionId as SessionId)
        } else if (action.type === "control") void controlLoop(action.loopId, action.action)
        else if (action.type === "accept") {
          state.page = "chat"
          editor.clear()
          editor.insert(`/loop accept ${action.loopId} `)
          state.notice = "type why the goal is met, then enter"
        }
        else if (action.type === "review") {
          state.page = "chat"
          editor.clear()
          editor.insert(`/loop ${action.action} ${action.loopId} ${JSON.stringify(action.target)} `)
          state.notice = "type the review reason, then enter"
        }
        else if (action.type === "scope") {
          state.loopsLoaded = false
          await loadLoops()
        } else if (action.type === "save") await saveLoop(action)
        else if (action.type === "fire") await fireLoop(action.loopId)
        else if (action.type === "copy") copyText(action.text, "the fire command")
      }
    } else if (state.page === "permissions") {
      const result = permissionsPageKey(state.permissionsState, key, state.permissionGrants ?? [])
      state.permissionsState = result.state
      const { action } = result
      if (action.type === "close") state.page = "chat"
      else if (action.type === "mode") await setPermission(action.mode)
      else if (action.type === "revoke") await revokeGrant(action.grantId)
      else if (action.type === "model") await openFromPage("model")
    } else if (state.page === "diagram") {
      const { width, height } = input.screen.size
      const layout = diagramLayout()
      const bounds = layout ? diagramBounds(layout, width, height - 1) : { maxX: 0, maxY: 0, viewWidth: Math.max(1, width - 2), viewHeight: Math.max(1, height - 6) }
      const result = diagramViewKey(state.diagramView, key, { count: state.diagramSources.length, bounds })
      state.diagramView = result.state
      if (result.action === "close") state.page = "chat"
    } else if (state.page === "workflows") {
      if (!state.workflowsLoaded) {
        if (key === "\x1b" || key === "q") state.page = "chat"
      } else {
        const result = workflowsPageKey(state.workflowsState, key, state.workflows)
        state.workflowsState = result.state
        const { action } = result
        if (action.type === "close") state.page = "chat"
        else if (action.type === "open") {
          state.page = "chat"
          await switchSession(action.sessionId as SessionId)
        } else if (action.type === "control") void controlWorkflow(action.workflowId, action.action)
        else if (action.type === "retry") void controlWorkflow(action.workflowId, "retry", action.taskId)
        else if (action.type === "answer") void controlWorkflow(action.workflowId, action.decision, action.taskId)
        else if (action.type === "accept") {
          state.page = "chat"
          editor.clear()
          editor.insert(`/workflows accept ${action.workflowId} `)
          state.notice = "type why the workflow is done, then enter"
        } else if (action.type === "scope") {
          state.workflowsLoaded = false
          await loadWorkflows()
        }
      }
    } else if (state.page === "context") {
      const { state: localState, action } = contextPageStateKey(state.contextState, key)
      state.contextState = localState
      if (action.type === "close") state.page = "chat"
      if (action.type === "refresh") await loadContext()
    } else if (state.page === "changes") {
      if (!state.changesReport) {
        if (key === "\x1b" || key === "q") state.page = "chat"
      } else {
        if (state.changesState.mode === "browse" && (key === "o" || key === "O")) {
          await actions.orderReview(key === "O")
          return
        }
        if (state.changesSource && ["c", "C", "s", "L", "e", "d", "X"].includes(key)) return
        const result = changesPageKey(state.changesState, key, state.changesReport, Math.max(1, input.screen.size.height - 4 - (state.pageBodyTop ?? 0)), now())
        const previous = state.changesState
        const changed = result.state.comments !== previous.comments || result.state.selected !== previous.selected || result.state.cursor !== previous.cursor
        state.changesState = result.state
        if (changed) await saveReview(previous)
        if (result.action.type === "close") state.page = "chat"
        if (result.action.type === "refresh") await loadChanges()
        else if (result.action.type === "send") await sendReview(result.action)
        else if (result.action.type === "view") actions.viewChangedFile(result.action)
        else void ensureSelectedDiff()
      }
    } else if (key === "\x1b" || key === "q") state.page = "chat"
    requestFrame()
  }

  async function pageKey(key: string) {
    if (state.page === "compaction") return actions.compactionKey(key)
    if (state.page === "history") {
      const keys = /^[\x20-\x7e -￿]{2,}$/u.test(key) ? [...key] : [key]
      for (const each of keys) {
        await actions.historyKey(each)
        if (state.page !== "history") break
      }
      return
    }
    if (state.page === "prompt-mode") return actions.promptModeKey(key)
    if (state.page === "skills") return actions.skillsKey(key)
    if (state.page === "model-picker") return actions.modelPickerKey(key)
    if (state.page === "theme") return actions.themePickerKey(key)
    if (state.page === "variants") return actions.variantsKey(key)
    const page = state.page
    const notice = state.notice
    await handlePageKey(key)
    if (state.page !== page && state.notice === notice) {
      state.notice = ""
      requestFrame()
    }
  }

  return { pageKey }
}
