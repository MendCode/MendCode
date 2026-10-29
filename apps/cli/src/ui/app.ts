import { createConsole } from "./app/console"
import { applyGlyphMode, asciiChrome, asciiScreen } from "./app/glyph-mode"
import { subagentRunOf } from "./app/subagent-run"
import { modelLabel, sessionModelId } from "../view/model-label"
import { createSessionImport } from "./app/session-import"
import { createSandbox } from "./app/sandbox"
import { createVoice } from "./app/voice"
import { createAddDir } from "./app/add-dir"
import { createChannels } from "./app/channels"
import { createMflow } from "./app/mflow"
import { createKeymapEditor } from "./app/keymap-editor"
import { createTerminalSetup } from "./app/terminal-setup"
import { createTutorial } from "./app/tutorial"
import { createDoctor } from "./app/doctor"
import { createPrecedence } from "./app/precedence"
import { createMemoryAssistant } from "./app/memory-assistant"
import { createTrace } from "./app/trace"
import { createCompaction } from "./app/compaction"
import { createAIConfig } from "./app/ai-config"
import { createHistory } from "./app/history"
import { createPromptMode } from "./app/prompt-mode"
import { createSkills } from "./app/skills"
import { createSession } from "./app/session"
import { createSessionNav } from "./app/session-nav"
import { createSessionTree } from "./app/session-tree"
import { createTranscriptActions } from "./app/transcript-actions"
import { readSessionLook, switchSessionLook } from "./app/session-look"
import { createScratch } from "./app/scratch"
import { createGoal } from "./app/goal"
import { createUsageLimit } from "./app/usage-limit"
import { createDaemon } from "./app/daemon"
import { createPrWatchCommand } from "./app/pr-watch"
import { createSessionLifecycle } from "./app/session-lifecycle"
import { createFanout } from "./app/fanout"
import { createReturn } from "./app/return"
import { createPs } from "./app/ps"
import { createPrompt } from "./app/prompt"
import { createSlashMenu } from "./app/slash-menu"
import { editableCatalog } from "../view/commands"
import { expandUserAlias } from "../view/slash-aliases"
import { createPets } from "./app/pets"
import { createImages } from "./app/images"
import { createLoops } from "./app/loops"
import { createWorkflows } from "./app/workflows"
import { createAutomationLedger } from "./app/automation-ledger"
import { createPermissions } from "./app/permissions"
import { createDiagram } from "./app/diagram"
import { createRightSidebar } from "./app/right-sidebar"
import { createStatsHub } from "../view/session-stats"
import { usageSnapshot } from "../view/usage-snapshot"
import { liveStatsInput } from "./app/stats"
import { createAside } from "./app/aside"
import { createSetup } from "./app/setup"
import { createAgentPicker } from "./app/agent-picker"
import { createThemePicker } from "./app/theme-picker"
import { createModel } from "./app/model"
import { createProviders } from "./app/providers"
import { createContext, type AppContext, type AppInput, type AppState } from "./app/context"
import { createUsage } from "./app/usage"
import { createChanges } from "./app/changes"
import { createMemory } from "./app/memory"
import { createSecrets } from "./app/secrets"
import { createEnvironmentPanel } from "./app/environment"
import { createFileOpen } from "./app/file-open"
import { createFilePick } from "./app/file-pick"
import { createStorage } from "./app/storage"
import { createPackageCatalogPages } from "./app/package-catalog"
import { createAgents } from "./app/agents"
import { createSubagents } from "./app/subagents"
import { createPeerCommands } from "./app/peer-commands"
import { createStatus } from "./app/status"
import { createStartup } from "./app/startup"
import { createHooks } from "./app/hooks"
import { createDiagnostics } from "./app/diagnostics"
import { createQueue } from "./app/queue"
import { createWorktrees } from "./app/worktrees"
import { createGit } from "./app/git"
import { createCompound } from "./app/compound"
import { createRelease } from "./app/release"
import { createQuickSettings } from "./app/quick-settings"
import { createTsm } from "./app/tsm"
import { readModelPrefs } from "../view/model-prefs"
import type { Settings, ForegroundState, GlobalEvent, PermissionMode } from "@mendcode/protocol"
import type { AgentSession } from "../view/agents-page"
import { createModelPageState } from "../view/model-page"
import type { CommandReply } from "@mendcode/client"
import { createToasts } from "./toasts"
/** A command's own report stays long enough to read a status line, then goes. */
const NOTICE_MS = 8_000
import type { ToastVariant } from "../view/toast"
import { exitSummary } from "../view/exit-summary"
import { DEFAULT_BINDINGS, type LeaderState } from "./keymap"
import { buildBindings, readKeybindings, type KeybindingFile } from "../extensions/keybindings"
import type { TranscriptHooks } from "../extensions/hooks"
import { createEditor } from "../view/editor"
import { attachmentLabels } from "../view/attachments"
import { createVim } from "../view/vim"
import { createDraftSync } from "./drafts"
import { createComments } from "./app/comments"
import { osc52Copy } from "./osc52"
import { createPromptStash } from "./prompt-stash"
import { placeholderFor, shellPlaceholderFor } from "../view/prompt-chrome"
import { DEFAULT_TUI_PROFILE, normalizeTuiProfile, readTuiProfile } from "../view/tui-profile"
import { ACCESSIBLE_LOOK } from "../view/accessible"
import { homeTip } from "../view/home-tips"
import { createTurnState } from "../view/turn-state"
import { createCompactionFacts } from "../view/compaction-facts"
import { createCompactionLive } from "./app/compaction-live"
import { createSessionListState } from "../view/session-list"
import { createTranscript, createViewState } from "../view/transcript"
import { DEFAULT_IMAGE_ROOM, imageRoomRows } from "../view/image-wait"
import { compactNoticeConfig } from "../view/usage-notes"
import { createViewHost } from "../view/views"
import { onMermaidLoaded } from "../view/mermaid-lazy"
import { glyphs as defaultGlyphs } from "./theme"
import { configureKeyLabels } from "./key-labels"
import { createSlash } from "./app/slash"
import { createPageKeys } from "./app/page-keys"
import { createKeys } from "./app/keys"
import { createTuiControl } from "./app/tui-control"
import { createInput } from "./app/input"
import { createPlanReview } from "./app/plan-review"
import { createRequests } from "./app/requests"
import { createPalette } from "./app/palette"
import { createRender } from "./app/render"
import { createChatRows } from "./app/chat-rows"
import { createChrome } from "./app/chrome"
import { createExtensions } from "./app/extensions"
import { createTicks } from "./app/ticks"
import { createSettings } from "./app/settings"
import { createEvents } from "./app/events"
import { createAcp } from "./app/acp"
import { createIde } from "./app/ide"
import { createPaging } from "./app/paging"
import { createActivityAudio } from "./app/activity-audio"
import { createFind } from "./app/find"
import { createComposerRecovery } from "./app/composer-recovery"
import { createInline } from "./app/inline"

const STATE_LABEL: Record<ForegroundState, string> = {
  idle: "ready",
  queued: "queue held",
  generating: "working",
  tool: "running tool",
  waiting_approval: "needs approval",
  compacting: "compacting",
  cancelling: "cancelling",
  error: "error",
}
const PERMISSION_LABEL: Record<PermissionMode, string> = { ask: "ask before edits", smart: "smart approval", edits: "auto edits", full: "full access", plan: "plan mode" }
type Quota = Extract<GlobalEvent, { type: "quota.snapshot" }>

function localDay(at: number) {
  const date = new Date(at)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

/**
 * MendCode terminal presentation (specs/ui.md). All state shown comes from events; every action is
 * a protocol command. Frames are drawn only when something changed; the only timer is the busy
 * indicator, alive exclusively while a turn runs (P6).
 */
export function createApp(input: AppInput) {
  if (input.remote) {
    const { dataDir: _dataDir, pets: _pets, ...remoteInput } = input
    input = remoteInput
  }
  const now = input.now ?? Date.now
  const schedule = input.schedule ?? ((fn: () => void) => void setTimeout(fn, 16))
  // One glyph object for the whole app, changed in place when the `glyphs` setting resolves to another set (glyph-mode.ts).
  const g = { ...(input.glyphs ?? defaultGlyphs()) }
  // In ASCII mode every frame is transliterated on its way out, so no view (built-in or an extension's) can put a non-ASCII byte on screen.
  input = { ...input, screen: asciiScreen(input.screen, () => appState.glyphMode === "ascii") }
  const appState: AppState = {
    sessionId: input.sessionId,
    mode: input.mode ?? "balanced",
    ext: undefined,
    secretTails: new Map<number, string>(),
    transcript: undefined!,
    paging: undefined,
    memories: [],
    memoryGraph: undefined,
    dreamRuns: undefined,
    dreamReportAsked: new Set<number>(),
    memoryCategories: undefined,
    evolutionData: undefined,
    memoryState: undefined!,
    editingMemory: undefined,
    changesReport: undefined,
    gitStatus: { loaded: false },
    contextReport: undefined,
    contextError: "",
    changesError: "",
    changesState: undefined!,
    mcpsReport: undefined,
    mcpsError: "",
    acpState: { selected: 0 },
    agentSessions: new Map<string, AgentSession>(),
    agentTitles: new Map<string, string>(),
    agentParents: new Map<string, string>(),
    agentShells: [],
    relaunched: new Set<string>(),
    agentShellsBusy: false,
    agentShellsStale: false,
    toolsReport: undefined,
    toolsError: "",
    packagesReport: undefined,
    packagesError: "",
    statusState: undefined!,
    statusInfo: undefined,
    statusInfoError: "",
    statusModels: undefined,
    extensionsReport: undefined,
    extensionsError: "",
    hooksReport: undefined,
    hooksError: "",
    homeMcp: undefined,
    homeMcpAsked: false,
    storageReport: undefined,
    storageError: "",
    storageRetention: undefined,
    storageWorktreeGc: undefined,
    storageState: undefined!,
    page: "chat",
    settingsNow: {},
    usageReport: undefined,
    usageWaste: undefined,
    usageWasteLoading: undefined,
    usageState: undefined!,
    connection: "connected",
    notice: input.notice ?? "",
    ...(input.updated ? { updated: true } : {}),
    secretsList: undefined,
    secretsError: "",
    secretsState: undefined!,
    secretsVisit: 0,
    secretsMissing: new Set<number>(),
    secretsLoading: false,
    secretsAgain: false,
    effectiveModel: undefined,
    diffTotals: undefined,
    changedFiles: [],
    extKeyProblems: [],
    fetchedDiffs: new Set<string>(),
    rewindCard: undefined,
    historyState: undefined!, historyReport: undefined, historyDetail: undefined, historyError: "", historyLoading: false,
    skillsState: undefined!, skillsReport: undefined, skillsError: "", modelPicker: undefined!, modelQuick: undefined, variantState: { selected: 0 },
    treeState: undefined!,
    lastBodyHeight: 1,
    find: undefined,
    promptSearch: undefined,
    shortcuts: false,
    backtrackArmedAt: 0,
    pasteBurstUntil: 0,
    spinFrame: 0,
    turnState: undefined!,
    openedAt: undefined!,
    escArmedAt: 0,
    editingScratch: undefined,
    scratchFor: undefined,
    goalPrompt: undefined,
    editingGoal: undefined,
    shellMode: false,
    placeholder: undefined!,
    pet: undefined,
    sessions: [],
    homeRecent: [],
    renameFromChat: false,
    sessionList: undefined!,
    gitBranch: undefined,
    scratchNote: "",
    scratchArea: undefined,
    scratchCursor: undefined,
    dockOpen: false,
    compactionFacts: createCompactionFacts(),
    compactionLive: { session: undefined, focused: false, best: {}, area: undefined, scratchPanel: false, loading: undefined },
    attachments: [],
    pastes: [],
    suggestion: 0,
    recall: { prompts: undefined as import("../view/prompt-search").RecallEntry[] | undefined, index: -1, draft: "", draftCursor: 0, shown: "", shell: false },
    submits: 0,
    unsent: [],
    mentionPending: undefined,
    mentionInFlight: false,
    mentionResults: [],
    mentionSuggestion: 0,
    mentionToken: undefined,
    mentionLastQuery: undefined,
    petList: undefined,
    petPicker: { selected: 0 },
    reducedMotion: input.reducedMotion === true,
    accessible: false,
    glyphMode: "unicode",
    loopsState: undefined!,
    loops: [],
    loopsLoaded: false,
    loopsError: "",
    liveLoops: new Set<string>(),
    workflowsState: undefined!,
    workflows: [],
    workflowsLoaded: false,
    workflowsError: "",
    liveWorkflows: new Map<string, boolean>(),
    permissionGrants: undefined,
    permissionGrantsError: "",
    permissionsModels: undefined,
    permissionsModelsError: "",
    permissionsState: { selected: 0 },
    diagramSources: [],
    diagramView: undefined!,
    diagramMemo: undefined,
    sideChats: new Map(),
    rightScroll: 0,
    rightFocus: false,
    rightChatArea: undefined,
    rightTick: undefined,
    sidebarEdit: { selected: 0, adding: false, type: 0 },
    paletteSessions: [],
    pathPicks: [],
    fetchFacts: undefined,
    todayUsage: undefined,
    recipes: undefined,
    intro: undefined,
    setupInfo: undefined,
    setupInfoError: "",
    setupMcp: undefined,
    setupMemory: undefined,
    setupState: undefined!,
    onboarding: undefined,
    setupAdvanced: false,
    agentReport: undefined,
    agentError: "",
    agentPicker: { selected: 0 },
    themePicker: { query: "", selected: 0 },
    themeRestore: undefined,
    modelReport: undefined,
    modelError: "",
    modelState: undefined!,
    modelPrefs: undefined!,
    connectSerial: 0,
    connectState: undefined!,
    connectProviders: undefined,
    connectModels: undefined,
    providersList: undefined,
    providersError: "",
    providerNotes: {},
    contextState: undefined!,
    mcpsState: undefined!,
    agentsState: undefined!,
    toolsState: undefined!,
    packagesState: undefined!,
    tuiProfile: undefined!,
    profileBase: undefined!,
    activation: undefined,
    profileApplied: {},
    sessionLook: new Map(),
    profileRuntime: {},
    keptKeys: new Set<string>(),
    keptValues: {},
    customizeState: undefined!,
    settingsPageState: undefined!,
    extensionsState: undefined!,
    hooksState: undefined!,
    workflowsTick: undefined!,
    loopsTick: undefined!,
    usageTick: undefined!,
    backgroundTick: undefined!,
    palette: undefined!,
    customFooter: undefined!,
    providersState: undefined!,
    popupArea: undefined!,
    mentionPopupArea: undefined!,
    approvalScroll: undefined!,
    approvalScrollFor: undefined!,
    frameScheduled: undefined!,
    scrollbarAt: undefined!,
    pulse: undefined!,
    pulseOn: undefined!,
    approvalChoice: undefined!,
    approvalChoiceFor: undefined!,
    planDraft: undefined!,
    approvalExplainFor: undefined!,
    statusLoaded: undefined!,
    shellPlaceholder: undefined!,
    statusLine: undefined!,
    statusProblem: undefined!,
    leaderTimer: undefined!,
    sidebarMcp: undefined!,
    sidebarMcpAsked: undefined!,
    sidebarTree: undefined!,
    sidebarTreeRev: undefined!,
    rightBarCollapsed: undefined!,
    branchRequested: undefined!,
    topbarTick: undefined!,
    topbarTimer: undefined!,
    requestArea: undefined!,
    sendChipArea: undefined!,
    homeArea: undefined,
    limitArea: undefined!,
    bindings: undefined!,
    extPageId: undefined!,
    extSkipped: undefined!,
    extStarted: undefined!,
    extAnnounced: undefined!,
    extSettingsKey: undefined!,
    extLoad: undefined!,
  }

  // Terminal extensions: the runtime exists only once an extension module registered something (see loadExtensions);
  // until then every hook below answers at once and the frame does no extension work.
  const transcriptHooks: TranscriptHooks = {
    markdown: (text, message, width) => (appState.ext ? appState.ext.markdown(text, message, width) : text),
    message: (message, width) => appState.ext?.message(message, width),
    tool: (view) => appState.ext?.tool(view),
    messageStyle: (role) => appState.ext?.messageStyle(role),
    generation: () => appState.ext?.generation ?? 0,
  }
  /** The view-slot host: a custom view of the loaded extensions answers first, then the built-in renderer of the same slot. */
  const views = createViewHost({
    custom: () => appState.ext?.views,
    glyphs: g,
    ascii: () => appState.tuiProfile.accessible || asciiChrome(appState),
    now,
    disabled: () => appState.tuiProfile.disabledViews,
  })
  // A chart needs no loaded picture, so whether it is painted is asked of the terminal, not of the image cards (they load with the
  // first picture on screen); the answer is part of the generation, so a layout made before the terminal answered is made again.
  const chartsPainted = () => appState.tuiProfile.transcriptImages && !input.remote && input.screen.inline !== true && (input.screen.imageProtocol ?? "off") !== "off"
  const transcriptImages = { generation: () => (appState.imageCards?.images.generation() ?? 0) * 2 + (chartsPainted() ? 1 : 0), slot: (sha256: string, maxCols: number, maxRows?: number) => appState.imageCards?.images.slot(sha256, maxCols, maxRows), charts: chartsPainted }
  /** A generated picture's room: the screen's height less its chrome, at the cell size the graphics layer measured. */
  const imageRoom = () => ({ rows: imageRoomRows(input.screen.size.height), cell: appState.imageCellPixels ?? DEFAULT_IMAGE_ROOM.cell })
  /** A transcript with every option the app gives it; a chat switch makes its own through this, so views and model names keep applying. */
  const newTranscript = () => createTranscript({ glyphs: g, mode: appState.mode, frame: () => appState.spinFrame, motion: () => !appState.reducedMotion, hooks: transcriptHooks, views, images: transcriptImages, secretTail: (n) => secretTail(n), modelLabel: (id) => modelLabel(id, appState.modelReport), now, agent: () => appState.transcript.permissionMode === "plan" ? "Plan" : "Build", compactNotice: () => compactNoticeConfig(appState.settingsNow), subagentRun: (ref) => subagentRunOf(appState, g.sep).ofCall(ref), imageRoom, backgroundRunning: (description) => appState.agentShells.some((shell) => shell.status === "running" && shell.sessionId === appState.sessionId && shell.command === description) })
  appState.transcript = newTranscript()
  // Page states are created when the page first opens (its module loads lazily, see lazy-pages.ts).
  appState.contextState = {}
  appState.mcpsState = undefined!
  // Agent view: busy sessions come from `session.activity` pushes (tracked always, bounded to the busy ones);
  // shells are asked for when the page opens and again on activity while it is open. No timers.
  appState.agentsState = undefined!
  appState.toolsState = undefined!
  appState.packagesState = undefined!
  /** The terminal's own look (`<dataDir>/tui/profile.json`, see /customize); read once at start, the defaults without a data dir. */
  appState.tuiProfile = input.profile ?? (input.dataDir ? readTuiProfile(input.dataDir) : { ...DEFAULT_TUI_PROFILE })
  // Screen-reader mode from the saved setting or from this run (flag, environment): reduced motion and the plain look, in memory only for a one-off run.
  appState.accessible = input.accessible ?? appState.tuiProfile.accessible
  if (appState.accessible) {
    appState.reducedMotion = true
    appState.tuiProfile = normalizeTuiProfile({ ...appState.tuiProfile, ...(appState.tuiProfile.accessible ? {} : ACCESSIBLE_LOOK) })
  }
  appState.profileBase = { ...appState.tuiProfile }
  // What slash commands showed or hid in each session is that session's (session-look.ts): the one this terminal opens on gets its own back.
  appState.sessionLook = input.profile ? new Map() : readSessionLook(input.dataDir)
  const ownLook = appState.sessionLook.get(appState.sessionId)
  if (ownLook) appState.tuiProfile = normalizeTuiProfile({ ...appState.tuiProfile, ...ownLook })
  applyGlyphMode({ state: appState, glyphs: g, pinned: input.glyphs, env: input.env ?? process.env })
  // What key hints call Alt: Option on a Mac. The platform is the caller's (main.ts passes process.platform; a test that passes none gets canonical `alt`).
  configureKeyLabels({ setting: appState.tuiProfile.altLabel, platform: input.platform, altWorks: false })
  appState.customizeState = undefined!
  appState.settingsPageState = undefined!
  appState.extensionsState = undefined!
  appState.hooksState = undefined!
  /** 1 s elapsed tick: only exists while the workflows page shows a live run. */
  appState.workflowsTick = undefined!
  /** 1 s countdown tick: only exists while the loops page shows a pending wakeup. */
  appState.loopsTick = undefined!
  /** The usage page's Clock widget has no other reason to re-render while idle; ticks once a minute, only while the page is open. */
  appState.usageTick = undefined!
  /** 1 s tick for the run times in the background row over the prompt: only while this session has something running there. */
  appState.backgroundTick = undefined!
  /** Ctrl+P command palette: open only from the chat page (every other page uses ctrl+p as "up"). */
  appState.palette = undefined!
  /** The user's /footer choice; without one, full view shows every segment and the others the default set. */
  appState.customFooter = undefined!

  appState.modelState = createModelPageState()

  appState.modelPrefs = input.modelPrefs ?? (input.dataDir ? readModelPrefs(input.dataDir) : { favorites: [], recents: [] })
  appState.providersState = undefined!

  appState.sessionList = createSessionListState()
  /** Screen rows of the slash popup in the last chat frame (0-based top row, first suggestion index shown, rows). */
  appState.popupArea = undefined!
  /** Screen rows of the mention popup in the last chat frame; same shape as `popupArea`. */
  appState.mentionPopupArea = undefined!
  const view = createViewState()
  // The tokens of the attachments pasted into the prompt are single characters for the editor.
  const editor = createEditor({ tokens: () => attachmentLabels(appState.attachments) })
  const scratchEditor = createEditor({ wordWrap: true })
  const stash = createPromptStash({ dataDir: input.dataDir, now })
  const drafts = createDraftSync({ send: input.send, comments: (sessionId) => ctx.comments.draftView(sessionId) })
  const env = input.env ?? process.env
  const quotas = new Map<string, Quota>()
  const codegraph = new Map<string, Extract<GlobalEvent, { type: "codegraph.status" }>>()
  const stats = createStatsHub(() => liveStatsInput(appState))
  /** Scroll offset of the approval diff box; reset when a different request is pending. */
  appState.approvalScroll = 0
  appState.approvalScrollFor = ""
  appState.frameScheduled = false
  appState.scrollbarAt = undefined
  appState.pulse = undefined!
  appState.pulseOn = true
  /** Highlighted option of the pending approval (rich views), reset per request. */
  appState.approvalChoice = 0
  appState.approvalChoiceFor = undefined!
  /** A plan review being answered in the prompt: `edit` holds the plan text to send back edited, `comment` is feedback. Enter sends, Esc drops it. */
  appState.planDraft = undefined!
  appState.approvalExplainFor = undefined!
  appState.turnState = createTurnState()
  appState.statusLoaded = false

  const random = input.random ?? Math.random
  appState.placeholder = placeholderFor(random())
  appState.shellPlaceholder = shellPlaceholderFor(random())
  /** The home's tip (v1 picks one per launch). */
  const homeTipText = homeTip(random())
  /** The project's script-backed status line (`status.line`), drawn in the row under the prompt. */
  appState.statusLine = undefined!
  appState.statusProblem = ""
  /** Toasts (v1's floating notices): results and errors. `notice` stays for hints like "view: minimal". */
  const toasts = createToasts(() => requestFrame())
  /** The leader key (`ctrl+x`): armed for LEADER_TIMEOUT_MS, disarmed by the one timer below. */
  const leader: LeaderState = {}
  appState.leaderTimer = undefined!
  /** The project's MCP servers for the sidebar; asked when the sidebar first shows and after each turn. */
  appState.sidebarMcp = undefined!
  appState.sidebarMcpAsked = false
  appState.sidebarTree = undefined
  appState.sidebarTreeRev = 0
  appState.rightBarCollapsed = false
  appState.branchRequested = false
  /** The top bar's title scrolls one cell per tick; the timer exists only while it overflows. */
  appState.topbarTick = 0
  appState.topbarTimer = undefined!

  appState.openedAt = now()
  /** Screen rows of the panels in the last chat frame, for clicks (0-based; rows are relative to `top`). */
  appState.requestArea = undefined!
  appState.sendChipArea = undefined!
  appState.limitArea = undefined!

  function say(message: string, variant: ToastVariant = "info", extra: { title?: string; hint?: string; oneLine?: boolean; ms?: number; quiet?: boolean } = {}) {
    // Success is silent where the result is already on screen (`quiet`): only what failed or tells something new is said. `confirmNotices` brings those back.
    // The notice it would have replaced goes all the same: it spoke of a state that is over.
    if (extra.quiet && !appState.tuiProfile.confirmNotices) return void toasts.dismiss()
    appState.toastPage = appState.page
    toasts.show({ variant, message, ...(extra.title ? { title: extra.title } : {}), ...(extra.hint ? { hint: extra.hint } : {}), ...(extra.oneLine ? { oneLine: true } : {}) }, extra.ms)
  }

  // One place for a passing notice: what a command reports through `state.notice` shows in the notice slot over the prompt, like
  // every other, and goes by itself. The footer keeps state (model, context, quota), not sentences.
  const startNotice = appState.notice
  let noticeText = ""
  Object.defineProperty(appState, "notice", {
    configurable: true, enumerable: true,
    get: () => noticeText,
    set: (value: string | undefined) => {
      const next = value ?? ""
      // The same report asked for again (`/daemon` twice) shows again once the first has gone.
      if (next === noticeText && (!next || toasts.current?.message === next)) return
      const was = noticeText
      noticeText = next
      if (next) say(next, "info", { oneLine: true, ms: NOTICE_MS })
      else if (toasts.current?.message === was) toasts.dismiss()
    },
  })

  function fail(message: string) {
    say(message.replace(/^\[[A-Z]+\]: /, ""), "error")
  }

  /** A command's reply: clears a stale notice; a failure becomes an error toast. */
  function report(reply: CommandReply) {
    appState.notice = ""
    if (!reply.ok) fail(reply.error.message)
  }

  // `keybindings.json` is read once here (one existsSync without it); extension modules load after the first settings
  // push (they need the trusted and disabled lists) and only when files exist. Nothing below costs a frame otherwise.
  const keybindingFile: KeybindingFile = input.dataDir ? readKeybindings(input.dataDir) : { entries: [], problems: [] }

  const ctx: AppContext = {
    input,
    state: appState,
    now,
    editor,
    vim: createVim(editor),
    scratchEditor,
    keybindingFile,
    stateLabels: STATE_LABEL,
    permissionLabels: PERMISSION_LABEL,
    localDay,
    say,
    fail,
    report,
    requestFrame,
    copyText,
    setupChoice: (patch) => setupChoice(patch),
    extensionProblemLines,
    view,
    env,
    drafts,
    comments: undefined!,
    stash,
    random,
    glyphs: g,
    views,
    transcriptHooks,
    transcriptImages,
    quotas,
    codegraph,
    stats,
    usage: { read: () => usageSnapshot({ stats: stats.read(), quotas: quotas.values(), now: now() }) },
    schedule,
    homeTipText,
    toasts,
    leader,
  }
  const audio = createActivityAudio(ctx)
  // Comments on the answer's passages (docs/editor.md); the draft sync reads their pending state to save it with the draft.
  ctx.comments = createComments(ctx, { syncDraft: () => syncDraft(), scroll: (rows) => scrollTranscript(rows), transcriptWidth: () => transcriptWidth() })
  const exit = input.exit
  input.exit = () => { audio.dispose(); exit() }
  const { loadUsage, loadWaste, applyWaste, usageSettingsKey } = createUsage(ctx, (...args) => changeProfile(...args))
  const { ensureSelectedDiff, saveReview, sendReview, loadChanges, loadDiffTotals, noteReview, selectChangesSource, orderReview, viewChangedFile, changesClick } = createChanges(ctx, { openRef: (ref, opened) => fileOpen.openRef(ref, opened) })
  const { loadMemories, memoryPageData, loadMemoryCategories, loadEvolution, loadDreamReport, loadMemoryGraph, loadDreamRuns, startDream, undoMemory, memoryAction, loadSharing, memoryDirectory } = createMemory(ctx)
  const { openMemoryAssistant, memoryAssistantKey } = createMemoryAssistant(ctx, loadMemories)
  const { loadContext, contextWindowCommand, filesCommand } = createContext(ctx)
  const { loadSecretTails, noteSecretMarkers, loadSecrets, dropRevealedSecret, revealSecret, forgetSecret, secretTail } = createSecrets(ctx)
  const environmentPanel = createEnvironmentPanel(ctx)
  const { openTranscript, loadEarlier } = createPaging(ctx, {
    chatWidth: () => transcriptWidth(),
    noteSecretMarkers,
    replay: (event) => onEvent(event),
    recoverMissingSession: () => recoverMissingSession(),
  })
  const { loadStorage, storageAction } = createStorage(ctx)
  const { openAcp, acpKey } = createAcp(ctx)
  const { ideCommand, ideKey, syncIde, prepareIdeContext } = createIde(ctx)
  const peerCommands = createPeerCommands(ctx)
  const { openMarketplace, openAssets, catalogKey, catalogRows } = createPackageCatalogPages(ctx)
  const { agentMetadata, controlSession, loadAgentSessions, loadAgentMetadata, loadBackgroundSessions, agentSubtasks, noteActivity, loadAgentShells, loadAgents, loadMcps, loadTools, loadPackages, loadHomeMcp, restartMcp, decideMcp, authMcp, copyAuthMcp, loadMcpCatalog, readMcpResource } = createAgents(ctx)
  const { terminalExtensions, otherExtensionProblems, statusInput, loadExtensionsReport, loadStatus } = createStatus(ctx, { loadMcps, loadStorage })
  const { loadHooks, setTrust, openHooks, trustCommand, checkStartupTrust } = createHooks(ctx)
  const { diagnosticsCommand, diagnosticsKey } = createDiagnostics(ctx)
  const { worktreesCommand, worktreesKey, placeNewSession } = createWorktrees(ctx)
  const git = createGit(ctx, { loadChanges, loadDiffTotals, worktreesCommand, runSlash: (...args) => runSlash(...args), insertPrompt: (text) => { editor.insert(text); syncMentions(); requestFrame() } })
  const { compoundCommand, compoundKey } = createCompound(ctx, { switchSession: (sessionId) => switchSession(sessionId) })
  const { releaseCommand, releaseKey } = createRelease(ctx)
  const { quickCommand, setFlags } = createQuickSettings(ctx, { changeProfile: (...args) => changeProfile(...args) })
  const { tsmCommand, tsmKey } = createTsm(ctx)
  const { mflowCommand, mflowKey } = createMflow(ctx)
  const { openKeymap, keymapKey } = createKeymapEditor(ctx, { loadPage: () => loadPage("keymap"), reloadKeybindings: () => reloadKeybindings() })
  const { openTerminalSetup, terminalSetupKey } = createTerminalSetup(ctx, { loadPage: () => loadPage("terminal-setup") })
  const { openTutorial, tutorialPageKey } = createTutorial(ctx, { loadPage: () => loadPage("tutorial"), changeProfile: (...args) => changeProfile(...args) })
  const { precedenceReport, precedenceSections, openPrecedence } = createPrecedence(ctx)
  const { doctorCommand } = createDoctor(ctx, { precedenceReport, precedenceSections })
  const { consoleCommand, consoleKey, stopConsole } = createConsole(ctx)
  const { importCommand, shareStaticCommand } = createSessionImport(ctx, { switchSession: (sessionId) => switchSession(sessionId) })
  const { sandboxCommand } = createSandbox(ctx)
  const { addDirCommand } = createAddDir(ctx)
  const { remoteControlCommand } = createChannels(ctx)
  const { voiceCommand, cancelVoice, disposeVoice, voiceKey, voiceLive } = createVoice(ctx)
  const exitVoice = input.exit
  input.exit = () => { disposeVoice(); exitVoice() }
  const { agentCommand, chooseAgent } = createAgentPicker(ctx)
  const { openThemes, themeCommand, themePickerKey, restoreTheme } = createThemePicker(ctx, { changeProfile: (...args) => changeProfile(...args), loadPage: (...args) => loadPage(...args) })
  const { loadEffectiveModel, takeModels, modelCommand, loadRecipes, applyRecipe, changeModelPrefs, modelAction, openModelPicker, modelPickerKey, openVariants, variantsKey, modelQuickKey } = createModel(ctx, { loadPage: (...args) => loadPage(...args), connectProvider: () => runSlash("/connect").then(() => {}) })
  const { openCompaction, compactionKey, compactionPaste } = createCompaction(ctx)
  const { aiConfigCommand, aiConfigKey } = createAIConfig(ctx)
  const { openHistory, historyKey, noteMessageRevision } = createHistory(ctx, { loadPage: () => loadPage("history") })
  const { openPromptMode, promptModeKey, loadPromptMode } = createPromptMode(ctx, { loadPage: () => loadPage("prompt-mode") })
  const { openSkills, skillsKey } = createSkills(ctx, { loadPage: () => loadPage("skills") })
  const { ensureScratch, editScratch, endScratchEdit, saveScratch, scratchKey, scratchPaste } = createScratch(ctx, { loadAgentShells })
  const compactionLive = createCompactionLive(ctx, { editScratch, endScratchEdit, ensureScratch })
  const { endGoalEdit, saveGoalEdit, goalCommand, confirmGoalPrompt } = createGoal(ctx)
  const { limitCommand, limitKey, limitClick, limitEscape } = createUsageLimit(ctx)
  const { daemonCommand, whenIdle, noteTurnEnded, cancelWait, reconcile: reconcileDaemon } = createDaemon(ctx, { reloadTerminal: async () => refreshThemes() })
  const { prCommand } = createPrWatchCommand(ctx, { setFlags })
  const returnFlow = createReturn(ctx, { submit: () => submit() })
  const ps = createPs(ctx, { loadAgentShells })
  const { attachmentsOf, stashKey, syncDraft, restoreDraft, restoreUnsent, openDrafts, draftsKey, attachPasted, insertPasted, expandedPrompt, pasteClipboardImage, undoEdit, stashPrompt, restoreStash, runStashCommand, editInExternalEditor, copyAnswer, recallOlder, recallNewer, remember, recordCommand, ranCommand, keepDiscarded, bump, recallEntriesOf, suggestionPool, loadCustomCommands, syncMentions, expandCustom } = createPrompt(ctx, { extOn: () => extOn() })
  const slashMenu = createSlashMenu(ctx, { suggestionPool, extOn: () => extOn() })
  const { loadPetChoices, choosePet, petReady, petCommand, petPlanKey, petNames } = createPets(ctx, { changeProfile: (...args) => changeProfile(...args) })
  const images = createImages(ctx)
  const subagents = createSubagents(ctx, { switchSession: (id) => switchSession(id), loadPage: (name) => loadPage(name) })
  const { releaseBackgroundWriter, forkSession, rewind, navigateMessage, renameSession, jumpTo, forkAt, forkCommand, mergeFork, switchSession, changeSession, searchSessionContent, reloadSessions, openSessions, loadTitle, loadBranch, recoverMissingSession, verifySession } = createSession(ctx, {
    resetAudio: audio.reset,
    newTranscript,
    loadDiffTotals,
    chatWidth: () => transcriptWidth(),
    maxScroll: (...args) => maxScroll(...args),
    sessionTitle: (...args) => sessionTitle(...args),
    dropRevealedSecret,
    secretTail,
    endScratchEdit,
    endGoalEdit,
    loadEffectiveModel,
    restoreDraft,
    keepDiscarded: (...args) => keepDiscarded(...args),
    openTranscript,
    loadEarlier,
    checkResume: () => returnFlow.checkResume(),
    sessionLookSwitched: (previous) => { if (switchSessionLook(ctx, previous, (patch) => changeProfile(patch, { layer: true }))) void rightBar.loadSpec() },
    openTree: (options) => sessionTree.open(options),
  })
  const sessionNav = createSessionNav(ctx)
  const { titleCommand, pinCommand, settleCommand, prMetadata } = createSessionLifecycle(ctx, reloadSessions)
  const { fanoutCommand } = createFanout(ctx, { switchSession, openChanges: async () => { await loadPage("changes"); ctx.state.page = "changes"; await loadChanges() } })
  const { openMessageActions, copyCommand, exportSession, transcriptActionsKey } = createTranscriptActions(ctx, { loadPage: () => loadPage("transcriptActions"), sessionTitle: (...args) => sessionTitle(...args), rewind, forkAt, copyAnswer })
  const sessionTree = createSessionTree(ctx, { loadPage: (...args) => loadPage(...args), sessionTitle: (...args) => sessionTitle(...args), switchSession: (id) => switchSession(id), jumpTo: (entry) => jumpTo(entry), forkAt: (entry) => forkAt(entry), mergeFork: (id) => mergeFork(id), openMessageActions: (...args) => openMessageActions(...args) })
  const composer = createComposerRecovery(ctx, { attachmentsOf, syncMentions, syncDraft, recallEntriesOf, keepDiscarded, openBacktrack: () => openMessageActions(false, undefined, undefined, true) })
  const { loadLoops, saveLoop, fireLoop, controlLoop, createLoop, loadLiveLoops, noteLoop } = createLoops(ctx)
  const { loadWorkflows, openWorkflows, controlWorkflow, workflowCommand, loadLiveWorkflows, noteWorkflow } = createWorkflows(ctx)
  const automationLedger = createAutomationLedger(ctx)
  const { openPermissions, revokeGrant, approveRetry } = createPermissions(ctx)
  const { diagramLayout, openDiagram } = createDiagram(ctx)
  const fileOpen = createFileOpen(ctx, { insertPrompt: (text) => { editor.insert(text); syncMentions(); requestFrame() } })
  const rightBar = createRightSidebar(ctx, (...args) => slotContext(...args), fileOpen, async (node) => {
    if (node.kind === "file") {
      await runSlash("/changes session")
      const selected = appState.changesReport?.files.findIndex((file) => file.path === node.target) ?? -1
      if (selected >= 0) appState.changesState = { ...appState.changesState, selected, focus: "diff", scroll: 0, cursor: 0 }
      else appState.changesState.notice = `${node.target} · no retained diff`
    } else if (node.kind === "agent") {
      await runSlash("/tree")
      sessionTree.select(node.target)
    } else if (node.kind === "mcp") {
      if (input.remote) {
        say("MCP details are local-only", "warning")
        return
      }
      await runSlash("/mcp")
      const selected = appState.mcpsReport?.servers.findIndex((server) => server.name === node.target) ?? -1
      if (selected >= 0) appState.mcpsState = { ...appState.mcpsState, selected, detailScroll: 0 }
    }
    else await runSlash("/tools")
    requestFrame()
  }, (patch) => changeProfile(patch, { session: true }))
  const { askAside, openFetch, scrollAside, asideKey, loadAside } = createAside(ctx)
  const { setupValues, setupChecks, openSetup, openSetupIfFirstRun, setupChoice, setupAction, onboardingAction, openIntro, finishIntro } = createSetup(ctx, { loadRecipes, loadPage: (...args) => loadPage(...args), applySettings: (...args) => applySettings(...args), changeProfile: (...args) => changeProfile(...args) })
  const { openConnect, connectAction, loadProviders, providersAction } = createProviders(ctx, { takeModels, loadPage: (...args) => loadPage(...args), runSlash: (...args) => runSlash(...args) })
  /** Effective keys: the defaults, `keybindings.json`, then `api.key` of extensions. */
  appState.bindings = input.bindings ?? (keybindingFile.entries.length > 0 ? buildBindings({ file: keybindingFile.entries }).bindings : DEFAULT_BINDINGS)
  appState.extPageId = undefined!
  /** Project extension modules left unloaded because the directory is not trusted (shown in /help). */
  appState.extSkipped = 0
  appState.extStarted = false
  appState.extAnnounced = false
  appState.extSettingsKey = ""
  appState.extLoad = Promise.resolve()
  // Factories capture these callbacks; cross-feature calls resolve after composition is complete.
  const { slotContext, footerSlots, promptSlotRows, helpExtensions, syncExtensions, reloadExtensions, runExtensionCommand, openExtensionPage, closeExtensionPage, extensionPageRows, openExtensionModal, extensionModalOverlay, extensionModalKey, runExtensionAction, extOn, tuiActions, extensionProblemLines: extensionProblems, reloadKeybindings } = createExtensions(ctx, {
    recordSlash: slashMenu.record,
    changeProfile: (...args) => changeProfile(...args),
    profileLayers: () => profileLayers,
    refreshThemes: () => refreshThemes(),
    loadBranch,
    sessionTitle: (...args) => sessionTitle(...args),
    runSlash: (...args) => runSlash(...args),
    syncMentions,
    openFile: (...args) => fileOpen.openFile(...args),
  })
  const { openFromPage, loadPage, runSlash } = createSlash(ctx, {
    openGit: git.openGit,
    openEnvironment: environmentPanel.open,
    recordSlash: slashMenu.record,
    composer,
    openFind: (...args) => find.open(...args),
    openTasks: subagents.openTasks,
    openPs: ps.open,
    releaseBackgroundWriter,
    queueCommand: (...args) => queueCommand(...args),
    openMarketplace,
    openAssets,
    openPlanReview: () => openPlanReview(),
    openCompaction,
    openPromptMode,
    loadPromptMode,
    peerCommand: peerCommands.command,
    controlSession,
    diagnosticsCommand,
    worktreesCommand,
    placeNewSession,
    compoundCommand,
    aiConfigCommand,
    releaseCommand,
    quickCommand,
    tsmCommand,
    mflowCommand,
    consoleCommand,
    importCommand,
    shareStaticCommand,
    sandboxCommand,
    addDirCommand,
    remoteControlCommand,
    voiceCommand,
    openKeymap,
    openTerminalSetup,
    openTutorial,
    doctorCommand,
    openAcp,
    ideCommand,
    setSidebar: (...args) => setSidebar(...args),
    footerSegments: (...args) => footerSegments(...args),
    switchSession,
    openSessions,
    attachPasted,
    fileOpen,
    loadUsage,
    loadMemoryCategories,
    loadMemories,
    loadContext,
    contextWindowCommand,
    filesCommand,
    loadSecrets,
    loadChanges,
    selectChangesSource,
    loadPetChoices,
    petCommand,
    petNames,
    loadStorage,
    loadAgents,
    loadMcps,
    authMcp,
    loadTools,
    loadPackages,
    openSetup,
    openIntro,
    loadStatus,
    loadExtensionsReport,
    openHooks,
    trustCommand,
    agentCommand,
    themeCommand,
    modelCommand,
    openConnect,
    loadProviders,
    loadLoops,
    createLoop,
    goalCommand,
    limitCommand,
    daemonCommand,
    whenIdle,
    prCommand,
    titleCommand, pinCommand, settleCommand, prMetadata, fanoutCommand,
    openWorkflows,
    workflowCommand,
    askAside,
    rightSidebarCommand: rightBar.command,
    openFetch,
    setPermission: (...args) => setPermission(...args),
    startDream,
    undoMemory,
    runStashCommand,
    openDrafts,
    sessionNav,
    sessionTree,
    copyAnswer,
    rewind,
    openHistory,
    openSkills,
    openVariants,
    editInExternalEditor,
    renameSession,
    forkCommand,
    exportSession,
    copyCommand,
    openMessageActions,
    editScratch,
    openPermissions,
    approveRetry,
    openDiagram,
    setMode: (...args) => setMode(...args),
    changeProfile: (...args) => changeProfile(...args),
  })
  const { pageKey } = createPageKeys(ctx, {
    gitKey: git.gitKey,
    environmentKey: environmentPanel.key,
    petPlanKey,
    profileLayers: () => profileLayers,
    openPrecedence,
    slashCommands: () => editableCatalog(suggestionPool(), appState.settingsNow),
    sessionNav,
    sessionTree,
    tasksKey: subagents.tasksKey,
    controlSession,
    loadBackgroundSessions,
    openAutomationLedger: automationLedger.open,
    automationLedgerKey: automationLedger.key,
    catalogKey,
    openMarketplace,
    usageSettingsKey,
    loadWaste,
    applyWaste,
    transcriptActionsKey,
    openMessageActions,
    compactionKey,
    openPromptMode,
    promptModeKey,
    peerCommandKey: peerCommands.key,
    openPeerCommands: peerCommands.open,
    diagnosticsKey,
    worktreesKey,
    compoundKey,
    aiConfigKey,
    releaseKey,
    tsmKey,
    mflowKey,
    keymapKey,
    terminalSetupKey,
    tutorialPageKey,
    consoleKey,
    helpExtensions,
    acpKey,
    ideKey,
    closeExtensionPage: (...args) => closeExtensionPage(...args),
    switchSession,
    changeSession,
    searchSessionContent,
    reloadSessions,
    historyKey,
    skillsKey,
    modelPickerKey,
    themePickerKey,
    variantsKey,
    forkAt,
    jumpTo,
    loadUsage,
    memoryPageData,
    openMemoryAssistant,
    memoryAssistantKey,
    loadMemoryGraph,
    loadDreamRuns,
    loadMemoryCategories,
    loadEvolution,
    loadDreamReport,
    memoryAction,
    loadSharing,
    storageAction,
    dropRevealedSecret,
    revealSecret,
    forgetSecret,
    restartMcp,
    decideMcp,
    authMcp,
    copyAuthMcp,
    loadMcpCatalog,
    readMcpResource,
    loadTools,
    loadPackages,
    chooseAgent,
    modelAction,
    connectAction,
    providersAction,
    setupValues,
    setupAction,
    onboardingAction,
    finishIntro,
    applyRecipe,
    changeProfile: (...args) => changeProfile(...args),
    openFromPage: (...args) => openFromPage(...args),
    settingsValues: (...args) => settingsValues(...args),
    loadStatus,
    terminalExtensions,
    loadExtensionsReport,
    loadHooks,
    setTrust,
    controlLoop,
    loadLoops,
    saveLoop,
    fireLoop,
    setPermission: (...args) => setPermission(...args),
    revokeGrant,
    diagramLayout,
    controlWorkflow,
    loadWorkflows,
    loadContext,
    saveReview,
    orderReview,
    viewChangedFile,
    loadChanges,
    sendReview,
    ensureSelectedDiff,
  })
  const { openPlanReview, planReviewKey, planReviewPaste, planReviewFrame } = createPlanReview(ctx)
  const find = createFind(ctx, { chatWidth: () => transcriptWidth() })
  const inline = createInline(ctx)
  const { onKey, runKeyAction } = createKeys(ctx, {
    openPathInView: () => filePick.run(),
    changesClick,
    gitClick: git.gitClick,
    slashMenu,
    cancelVoice,
    voiceKey,
    findKey: find.key,
    openFind: find.open,
    composer,
    stopConsole,
    compactionLive,
    navigateSession: subagents.navigate,
    openAgent: subagents.open,
    openAgentCard: subagents.openCard,
    releaseBackgroundWriter,
    returnKey: returnFlow.returnKey,
    psKey: ps.key,
    stashKey,
    draftsKey,
    queueKey: (...args) => queueKey(...args),
    restoreUnsent,
    scratchKey,
    switchSession,
    homeSessions: (...args) => homeSessions(...args),
    navigateMessage,
    endScratchEdit,
    endGoalEdit,
    syncMentions,
    paletteInput: (...args) => paletteInput(...args),
    openPalette: (...args) => openPalette(...args),
    scrollTranscript: (...args) => scrollTranscript(...args),
    pageKey: (...args) => pageKey(...args),
    suggestionPool,
    runSlash: (...args) => runSlash(...args),
    chatWidth: (...args) => chatWidth(...args),
    transcriptWidth: () => transcriptWidth(),
    pickApproval: (...args) => pickApproval(...args),
    pickQuestion: (...args) => pickQuestion(...args),
    questionKey: (...args) => questionKey(...args),
    planReviewKey,
    pasteClipboardImage,
    pendingPanelRequest: (...args) => pendingPanelRequest(...args),
    tuiActions,
    rewind,
    confirmGoalPrompt,
    limitKey,
    limitClick,
    limitEscape,
    cancelWait,
    scrollAside,
    asideKey,
    modelQuickKey,
    rightKey: rightBar.rightKey,
    fileOpen,
    recallOlder,
    recallNewer,
    ranCommand,
    keepDiscarded,
    onEscape: (...args) => onEscape(...args),
    scrollApproval: (...args) => scrollApproval(...args),
    resolveRequest: (...args) => resolveRequest(...args),
    toggleApprovalExplain: (...args) => toggleApprovalExplain(...args),
    submit: (...args) => submit(...args),
    loadCustomCommands,
    runExtensionCommand: (...args) => runExtensionCommand(...args),
    openExtensionPage: (...args) => openExtensionPage(...args),
    openExtensionModal: (...args) => openExtensionModal(...args),
    extensionModalKey: (...args) => extensionModalKey(...args),
    runExtensionAction: (...args) => runExtensionAction(...args),
    loadAgentShells,
    editScratch,
    undoEdit,
    stashPrompt,
    restoreStash,
    editInExternalEditor,
    copyAnswer,
    setPermission: (...args) => setPermission(...args),
    takeModels,
    changeModelPrefs,
  })
  const { onInput, submit, onEscape } = createInput(ctx, {
    recordSlash: slashMenu.record,
    suggestionPool,
    rewind,
    findPaste: find.paste,
    composer,
    prepareIdeContext,
    compactionPaste,
    scratchPaste,
    attachPasted,
    insertPasted,
    expandedPrompt,
    pasteClipboardImage,
    syncMentions,
    syncDraft,
    saveScratch,
    saveGoalEdit,
    loadMemories,
    submitPlanDraft: (...args) => submitPlanDraft(...args),
    answerQuestion: (...args) => answerQuestion(...args),
    questionPaste: (...args) => questionPaste(...args),
    planReviewPaste,
    gitPaste: git.gitPaste,
    remember,
    recordCommand,
    runExtensionCommand: (...args) => runExtensionCommand(...args),
    runSlash: (...args) => runSlash(...args),
    expandCustom,
    expandAlias: (text) => expandUserAlias(text, appState.tuiProfile.slashCommands, suggestionPool()),
    switchSession,
    endScratchEdit,
    endGoalEdit,
    idleGate: () => returnFlow.idleGate(),
    noteInput: () => returnFlow.noteInput(),
  })
  const { answerQuestion, questionKey, questionPaste, submitPlanDraft, toggleApprovalExplain, resolveRequest, pickApproval, pickQuestion, scrollApproval, pendingPanelRequest, requestPanel } = createRequests(ctx, {
    secretTail,
  })
  const { applyStartup } = createStartup(ctx, { submit, syncDraft, restoreDraft })
  const { paletteItems, openPalette, paletteInput, openPathPicker } = createPalette(ctx, {
    suggestionPool,
    loadPage: (...args) => loadPage(...args),
    forkSession,
    switchSession,
    runSlash: (...args) => runSlash(...args),
    changeProfile: (...args) => changeProfile(...args),
    openRef: (ref) => fileOpen.openRef(ref),
    runExtensionAction: (...args) => runExtensionAction(...args),
    stashPrompt,
  })
  const filePick = createFilePick(ctx, { fileOpen, pickPaths: openPathPicker })
  const { render: renderFrame } = createRender(ctx, {
    git,
    slashCommands: () => editableCatalog(suggestionPool(), appState.settingsNow),
    inline,
    catalogRows,
    syncIde,
    mascotFrame: () => homeMascot.frame(),
    planReviewFrame,
    peerCommandRows: peerCommands.render,
    agentMetadata,
    psItems: ps.items,
    dropRevealedSecret,
    syncPulse: (...args) => syncPulse(...args),
    syncCompactionLive: compactionLive.sync,
    syncLoopsTick: (...args) => syncLoopsTick(...args),
    syncWorkflowsTick: (...args) => syncWorkflowsTick(...args),
    syncUsageTick: (...args) => syncUsageTick(...args),
    syncBackgroundTick: (...args) => syncBackgroundTick(...args),
    syncTopbarTick: (...args) => syncTopbarTick(...args),
    sessionTitle: (...args) => sessionTitle(...args),
    paletteItems: (...args) => paletteItems(...args),
    sidebarShown: (...args) => sidebarShown(...args),
    rightLayout: (width) => { rightBar.ensureData(); return rightBar.layout(width) },
    fileOpen,
    rightRows: rightBar.rightRows,
    chatRows: (...args) => chatRows(...args),
    sidebarRows: (...args) => sidebarRows(...args),
    memoryPageData,
    memoryDirectory,
    agentSubtasks,
    diagramLayout,
    setupValues,
    setupChecks,
    topbarRow: (...args) => topbarRow(...args),
    transcriptWidth: () => transcriptWidth(),
    homeRoot: (...args) => homeRoot(...args),
    homeSessions: (...args) => homeSessions(...args),
    settingsValues: (...args) => settingsValues(...args),
    statusInput,
    terminalExtensions,
    otherExtensionProblems,
    helpExtensions: (...args) => helpExtensions(...args),
    extensionPageRows: (...args) => extensionPageRows(...args),
    extensionModalOverlay: (...args) => extensionModalOverlay(...args),
    footer: (...args) => footer(...args),
    paneFacts: () => paneFacts(),
    statusRows: (...args) => statusRows(...args),
  })
  const { chatRows, homeRoot, homeSessions, homeMascot, maxScroll, scrollTranscript } = createChatRows(ctx, {
    slashMenu,
    findBar: find.bar,
    searchBar: composer.searchRow,
    loadEarlier,
    compactionLive,
    statusRow: (...args) => statusRow(...args),
    statusRows: (...args) => statusRows(...args),
    suggestionPool,
    requestPanel: (...args) => requestPanel(...args),
    extOn: (...args) => extOn(...args),
    slotContext: (...args) => slotContext(...args),
    topbarRow: (...args) => topbarRow(...args),
    dockRows: (...args) => dockRows(...args),
    promptSlotRows: (...args) => promptSlotRows(...args),
    chatWidth: (...args) => chatWidth(...args),
    scrollbarGutter: () => scrollbarGutter(),
    transcriptWidth: () => transcriptWidth(),
    promptStatusLine: (...args) => promptStatusLine(...args),
  })
  const { sessionTitle, topbarRow, dockRows, sidebarRows, loadSidebarMcp, setSidebar, statusRow, statusRows, footer, footerSegments, sidebarShown, chatWidth, scrollbarGutter, transcriptWidth, ensureBranch, promptStatusLine, paneFacts } = createChrome(ctx, {
    loadBranch,
    ensureScratch,
    secretTail,
    agentSubtasks,
    changeProfile: (...args) => changeProfile(...args),
    footerSlots: (...args) => footerSlots(...args),
  })
  const { syncPulse, syncTopbarTick, syncLoopsTick, syncWorkflowsTick, syncUsageTick, syncBackgroundTick, requestFrame: tickFrame } = createTicks(ctx, {
    chatWidth: (...args) => chatWidth(...args),
    sessionTitle: (...args) => sessionTitle(...args),
    render,
  })
  const { queueCommand, queueKey, noteQueue } = createQueue(ctx, (...args) => applySettings(...args))
  const { watchStatus, setPermission, setMode, applySettings, settingsValues, changeProfile, ringTurnBell, profileLayers, refreshThemes } = createSettings(ctx, {
    syncSlashDefault: slashMenu.syncDefault,
    syncAudio: audio.sync,
    syncImages: images.syncImages,
    ensureBranch: (...args) => ensureBranch(...args),
    choosePet,
    syncExtensions: (...args) => syncExtensions(...args),
    loadEffectiveModel,
    loadLiveLoops,
    loadLiveWorkflows,
    loadHomeMcp,
    loadAgentShells,
    loadTitle,
    loadDiffTotals,
    restoreDraft,
  })
  const { onEvent, onGlobal } = createEvents(ctx, {
    loadTasks: subagents.loadTasks,
    reloadTree: sessionTree.reload,
    loadBackgroundSessions: () => loadBackgroundSessions(),
    noteQueue,
    voiceLive,
    noteFileMaybeChanged: () => fileOpen.refresh(),
    noteMessageRevision: (event) => { noteMessageRevision(event); sessionTree.noteRevision(event) },
    noteAudio: audio.note,
    peerCommandsChanged: (source, target) => {
      peerCommands.changed(source, target)
      if (appState.page === "agents") { void loadAgentMetadata(); void loadBackgroundSessions() }
    },
    reloadExtensions,
    noteTurnEnded,
    loadMcps,
    chatWidth: () => transcriptWidth(),
    noteSecretMarkers,
    loadPage: (...args) => loadPage(...args),
    ringTurnBell: (...args) => ringTurnBell(...args),
    noteReturn: returnFlow.noteEvent,
    footerSegments: (...args) => footerSegments(...args),
    loadBranch,
    loadDiffTotals,
    noteReview,
    loadSidebarMcp: (...args) => loadSidebarMcp(...args),
    noteActivity,
    loadAgentShells,
    loadMemories,
    loadMemoryGraph,
    noteLoop,
    noteWorkflow,
    loadMemoryCategories,
    applySettings: (...args) => applySettings(...args),
    loadDreamReport,
    loadEvolution,
  })
  const tuiControl = createTuiControl(ctx, { runKeyAction, openThemes, restoreTheme, openModels: () => openModelPicker("session", "chat"), switchSession, submit, syncDraft, syncMentions })
  const exitWithAudio = input.exit
  input.exit = () => { void tuiControl.stop().finally(exitWithAudio) }

  function requestFrame() {
    tickFrame()
  }

  const trace = createTrace(ctx)
  function render() {
    trace.frame(renderFrame)
  }

  function extensionProblemLines() {
    return extensionProblems()
  }

  // A ```mermaid fence loads its renderer lazily (P5); this redraws once so its placeholder becomes the diagram.
  onMermaidLoaded(requestFrame)

  /** Puts `text` on the clipboard through the terminal (OSC 52), like `/copy`. */
  function copyText(text: string, what: string, extra: { hint?: string; ms?: number; quiet?: boolean } = {}) {
    const sequence = osc52Copy(text, { tmux: Boolean(env.TMUX) })
    if (!sequence) return fail(`${what} is too long to copy through the terminal`)
    input.screen.write?.(sequence)
    say(what === "auth URL" ? "auth URL copied" : `copied ${what}`, "success", extra)
  }

  return {
    get transcript() {
      return appState.transcript
    },
    get sessionId() {
      return appState.sessionId
    },
    get page() {
      return appState.page
    },
    /** Screen-reader mode and what it forces, read-only (tests, diagnostics). */
    get accessibility() {
      return { accessible: appState.accessible, reducedMotion: appState.reducedMotion, profile: appState.tuiProfile }
    },
    editor,
    render,
    /** The installed build changed under this terminal (main.ts watches it): say so above the prompt until the restart. */
    announceUpdate() {
      if (appState.updateReady) return
      appState.updateReady = true
      render()
    },
    async start() {
      // What the launch had to say (a config problem, a new build) is a notice like any other, shown once the screen is this app's.
      if (startNotice) appState.notice = startNotice
      // The sidebar's cards (the daemon's answer) and the image layer (the terminal's) fill in when they come: neither holds
      // the first frame or the chat, which opens at once and asks for its own frame. Unanswered, the sidebar keeps the profile's cards.
      const filling = Promise.allSettled([rightBar.loadSpec(), images.syncImages()])
      await openTranscript()
      await applyStartup()
      // A project with hooks, tools or extensions waiting for trust asks before anything of it runs; never blocks the start.
      void checkStartupTrust().catch(() => undefined)
      void returnFlow.checkResume({ launch: true }).catch(() => undefined)
      // Agent View lists what already runs or waits in other terminals from the first frames, not at its next change.
      void loadAgentSessions(true).catch(() => undefined)
      await tuiControl.register()
      await filling
    },
    get imagesReady() {
      return images.ready
    },
    /** Settles when every pet choice started so far has loaded (tests and scripts wait on it). */
    get petReady() {
      return petReady()
    },
    /** Whether the home mascot holds a timer right now (tests: none while she is off screen, still or unfocused). */
    get mascotAnimating() {
      return homeMascot.animating
    },
    /** Settles when the extension modules of the last settings push are loaded (tests and scripts wait on it). */
    get extensionsReady() {
      return appState.extLoad
    },
    /** Extensions stop what they started (a helper process): a closed window, a quit or a restart into a new build leaves no orphan. */
    stopExtensions() {
      return appState.ext?.dispose() ?? Promise.resolve()
    },
    /** Saves the prompt now and settles once the daemon has it: a quit or a closing terminal waits for this before the socket goes. */
    saveDrafts() {
      syncDraft()
      // What is left in the prompt is also kept as a draft entry of the project's history, so ↑ finds it next time.
      const kept = appState.page === "chat" && !appState.editingScratch && !appState.editingGoal && !appState.editingMemory && !appState.planDraft ? keepDiscarded({ track: false }) : Promise.resolve()
      return Promise.all([drafts.settled(), kept]).then(() => undefined)
    },
    /** What to print after leaving the full-screen UI: the session, its usage and how long it ran (empty when nothing happened). */
    exitSummary(options: { color?: boolean } = {}) {
      const model = sessionModelId(appState.effectiveModel?.model, appState.transcript.lastUsage?.model, appState.modelReport)
      const { turns, input: tokensIn, output: tokensOut } = appState.turnState.totals
      const hasHistory = appState.transcript.blocks().length > 0 || appState.paging?.more === true
      return exitSummary({ sessionId: appState.sessionId, title: sessionTitle(), turns, input: tokensIn, output: tokensOut, ...(model ? { model: modelLabel(model, appState.modelReport) } : {}), elapsedMs: now() - appState.openedAt, hasHistory, ...(options.color ? { color: true } : {}) })
    },
    applySettings,
    openSetup,
    openIntro,
    /** First launch, when the daemon's settings say setup was never completed: the setup page opens (the minimalist preset configures itself instead). `preset` is the tier the installer was asked for; it only counts while no tier is saved. */
    openSetupIfFirstRun,
    onEvent(event: Parameters<typeof appState.transcript.apply>[0]) {
      return onEvent(event)
    },
    onGlobal(event: GlobalEvent) {
      const handled = tuiControl.onGlobal(event)
      if (handled) return handled
      return onGlobal(event)
    },
    onConnection(state: typeof appState.connection) {
      const back = state === "connected" && appState.connection !== "connected"
      appState.connection = state
      // A watch belongs to the connection, so a reconnect asks again.
      if (back && appState.statusLoaded) watchStatus()
      if (back) void tuiControl.register()
      if (back) void reconcileDaemon()
      if (back) void verifySession().catch(() => undefined)
      // A new daemon has none of the old one's background work (an engine's agents ended with its process): the list is asked again.
      if (back && appState.statusLoaded) void loadAgentShells()
      if (back) { void rightBar.loadSpec(); const chat = appState.sideChats.get(appState.sessionId); if (chat?.open) void loadAside(chat) }
      requestFrame()
    },
    /** Raw stdin chunk: split into keys and handled in order. */
    onInput(data: string) {
      return onInput(data, (key) => this.onKey(key))
    },
    onKey(key: string) {
      return onKey(key)
    },
  }
}
