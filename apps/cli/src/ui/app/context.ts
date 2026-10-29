import type { createMcpsPageState, createToolsPageState, createAgentsPageState, createPackagesPageState, createLoopsPageState, createSetupPageState, createWorkflowsPageState, createChangesPageState, createMemoryPageState, createStoragePageState, createUsagePageState, createSecretsPageState } from "../lazy-pages"
import type { AgentPickerState } from "../../view/agent-picker"
import type { ThemePickerState } from "../../view/theme-picker"
import type { AgentsReport } from "@mendcode/protocol"
import type { ProvidersPageState, ProviderNote } from "../../view/providers-page"
import type { FooterSegment } from "@mendcode/protocol/wire"
import type { McpStatusReport, StatusSegment, PermissionGrant, ProviderInfo, Loop, GlobalEvent, RecipesReport, SessionSummary, WorkflowSummary, CustomToolsReport, DaemonInfoReport, DreamRun, ExtensionsReport, HooksReport, MemoryCategoryInfo, MemoryEntry, MemoryGraphReport, MemoryId, PackagesReport, Settings, ChangesReport, ContextReport, ForegroundState, PermissionMode, SessionId, UsageReport, UsageWasteReport, StorageReport, ModelChoice, ModelsReport, SecretInfo } from "@mendcode/protocol"
import type { ContextPageState } from "../../view/context-page"
import { contextWindowReply, parseContextWindowArgs, type ContextWindowAck } from "../../view/context-window-reply"
import { preload } from "../lazy-pages"
import type { PaletteState } from "../../view/palette"
import type { Bindings, LeaderState } from "../keymap"
import type { TuiProfile } from "../../view/tui-profile"
import type { CustomizePageState } from "../../view/customize-page"
import type { SettingsPageState } from "../../view/settings-page"
import type { ExtensionsPageState } from "../../view/extensions-page"
import type { HooksPageState } from "../../view/hooks-page"
import type { createToasts } from "../toasts"
import type { RewindCard } from "../../view/rewind-card"
import type { GoalPrompt } from "../../view/goal"
import type { DiagramLayout, DiagramSource, DiagramViewState } from "../../view/mermaid-viewer"
import type { PermissionsPageState } from "../../view/permissions-page"
import type { ConnectState } from "../../view/connect-page"
import type { ModelPrefs } from "../../view/model-prefs"
import type { PetChoice, PetPickerState } from "../../view/pet-picker"
import type { SetupChecks } from "../../view/setup-page"
import type { createModelPageState } from "../../view/model-page"
import type { SideChatState } from "./aside"
import type { FetchFacts } from "../../view/fetch-card"
import type { TranscriptHooks } from "../../extensions/hooks"
import type { PendingAttachment } from "../../view/attachments"
import type { createDraftSync } from "../drafts"
import type { createPromptStash } from "../prompt-stash"
import type { MentionEntry, MentionToken } from "../../view/mentions"
import type { createTurnState } from "../../view/turn-state"
import type { createSessionListState } from "../../view/session-list"
import type { createViewState, createTranscript, PresentationMode } from "../../view/transcript"
import type { PetSlot, PetDirs } from "../../pets/pet-slot"
import type { SidebarChange } from "../../view/sidebar"
import type { EvolutionData } from "../../view/memory-evolution"
import type { AgentSession, AgentShell } from "../../view/agents-page"
import type { CommandInput, CommandReply, WindowReply } from "@mendcode/client"
import type { ToastVariant } from "../../view/toast"
import type { KeybindingFile } from "../../extensions/keybindings"
import type { ExtensionRuntime } from "../../extensions/runtime"
import type { createEditor } from "../../view/editor"
import type { EditorLauncher } from "../external-editor"
import type { HomeFooter } from "../../view/home"
import type { StatusPageState } from "../../view/status-page"
import type { Screen } from "../screen"
import type { Glyphs } from "../theme"

/** What a reconnect found: the daemon matches this build, is being restarted, or is older and in use (`legacy`: too old to say). */
export type DaemonSkew = "fresh" | "restarting" | "busy" | "legacy"

export type AppInput = {
  /** What the session on screen is doing, said at every frame (repeats included): main.ts reports it to the herdr or tuios pane MendCode runs in (herdr.ts). */
  paneState?(state: { foreground: string; message?: string; sessionId: string; facts: { model?: string; contextPercent?: number; costMicros?: number }; children: import("../../herdr").PaneChild[] }): void
  /** The OS the key hints are written for (`process.platform`; main.ts passes it): Option instead of Alt on `darwin`. Unset keeps hints canonical (`alt`), which is what tests rely on. */
  platform?: string
  /** The id of the active macOS keyboard layout ("ABC", "Spanish-ISO"), asked when a lone Option character arrives; unset or undefined reads as the default layout (view/option-keys.ts). */
  keyboardLayout?(): string | undefined
  /** What `/terminal-setup` needs to add a setting to the terminal's own config file: the user's home, and the file access (the real one unless a test brings its own). Unset: the page only prints. */
  terminalConfig?: { home: string; files?: import("../terminal-config").ConfigFiles }
  tuiControl?: boolean
  /** False (`--no-approve`): no startup prompt to trust the project's hooks, tools and extensions. */
  trustPrompt?: boolean
  trace?(sample: import("@mendcode/protocol").TraceSample): void
  startup?: { prompt?: string; initialMessage?: string }
  diagnostics?: { memory(): NodeJS.MemoryUsage; snapshot(): Promise<string> }
  sessionId: SessionId
  remote?: { host: string; readOnly: boolean }
  screen: Screen
  send(command: CommandInput): Promise<CommandReply>
  /** Subscribe from `afterSeq`; the app ignores events of any other session. */
  subscribe?(sessionId: SessionId, afterSeq: number): Promise<CommandReply>
  /** Bounded event reads; absent on older embedders that replay through subscribe. */
  events?: {
    loadWindow(sessionId: SessionId): Promise<WindowReply>
    loadBefore(sessionId: SessionId, firstSeq: number): Promise<WindowReply>
  }
  exit(): void
  /** Real project path: new sessions are created here. Shown with `home` abbreviated to "~". */
  directory?: string
  /** Where the terminal was started when a resumed session lives in another directory (`--session`); the app then asks where to continue. */
  launchDirectory?: string
  /** Shown on the home screen next to the product name. */
  version?: string
  home?: string
  now?: () => number
  schedule?: (fn: () => void) => void
  glyphs?: Glyphs
  /** 0–1; picks the home placeholder example (injectable so a frame is reproducible). */
  random?: () => number
  reducedMotion?: boolean
  /** Screen-reader mode for this run (`--accessible`, `MENDCODE_ACCESSIBLE=1`); the saved `accessible` setting turns it on too. */
  accessible?: boolean
  notice?: string
  /** This run is the newer build an open terminal restarted into (`relaunch.ts`). */
  updated?: boolean
  /** Build id of the connected daemon, shown on the setup page. */
  daemonBuildId?: string
  /**
   * Version skew with a local daemon (docs/upgrade.md, "Version skew"). `older`: it was found older and left running at startup.
   * `check` runs after every reconnect (it restarts an idle older daemon); `restart` serves `/daemon restart`.
   * Absent for a remote daemon, which this terminal never restarts.
   */
  daemon?: {
    older?: boolean
    check(): Promise<DaemonSkew>
    restart(): Promise<{ ok: true; /** Busy: it restarts once its running work ends. */ pending?: true } | { ok: false; message: string }>
    /** `/restart`: this terminal starts again on the same session, the daemon keeps running; resolves only when that could not happen. */
    restartTerminal?(): Promise<{ ok: false; message: string }>
  }
  mode?: PresentationMode
  /** Where pets live and their frame cache; `images` is the graphics fallback for embedders without a protocol-aware screen. */
  pets?: { dirs: PetDirs; cacheDir: string; images: boolean }
  /** Capability replies a host already has; this client does not probe stdin for image support. */
  imageAnswers?: { da1?: string; cellPixels?: { width: number; height: number } }
  /**
   * The MendCode data dir (`--dir`). With it the terminal reads `keybindings.json` and loads terminal extensions
   * from `<dir>/extensions` and packages (plus the project's, when it is trusted); without it, neither.
   */
  dataDir?: string
  pure?: boolean
  /** Effective key bindings handed in by a host that has no data dir of its own (the tutorial's practice chat uses the user's). */
  bindings?: import("../keymap").Bindings
  /** What a look change says when there is no data dir to save it in (the practice chat says nothing is saved there). */
  unsavedNote?: string
  /** Favorite and recent models handed in by a host with no data dir (the practice chat cycles through its two). */
  modelPrefs?: ModelPrefs
  /** `--safe-mode`: shown in /doctor and /tier; the switches below it are the daemon's. */
  safeMode?: boolean
  profile?: TuiProfile
  /** Gives up the terminal to another program (leave the alternate screen and raw mode) and takes it back; the external editor needs both. */
  terminal?: { suspend(): void; resume(): void; suspendProcess?(): Promise<void> }
  /** Loads the external-editor launcher; the real one is a dynamic import, tests inject a fake. */
  editorLauncher?: () => Promise<EditorLauncher>
  /** Environment for `$VISUAL`/`$EDITOR` and tmux detection; `process.env` by default. */
  env?: Record<string, string | undefined>
}

export type Page = "file" | "tasks" | "stash" | "drafts" | "queue" | "history" | "skills" | "variants" | "model-picker" | "chat" | "sessions" | "usage" | "help" | "changes" | "memory" | "context" | "mcps" | "acp" | "tools" | "packages" | "loops" | "storage" | "setup" | "model" | "agent" | "theme" | "agents" | "pet" | "workflows" | "extension" | "customize" | "settings" | "status" | "extensions" | "hooks" | "connect" | "providers" | "secrets" | "env" | "tree" | "text" | "permissions" | "diagram" | "sidebar" | "memory-assistant" | "messages" | "export" | "plan-review" | "prompt-mode" | "compaction" | "agent-commands" | "diagnostics" | "worktrees" | "warp" | "git-commit" | "git-pr" | "git-init" | "compound" | "marketplace" | "intro" | "ai-config" | "release-channel" | "tsm" | "ide" | "mflow" | "console" | "share" | "keymap" | "terminal-setup" | "tutorial"

/** Mutable bindings shared by the entry point and its feature factories. */
export type AppState = {
  /** The file open in the viewer (the right slot, or the `file` page on a narrow terminal); absent when none is (docs/file-viewer.md). */
  fileViewer?: import("./file-viewer").FileViewerState | undefined
  environmentPage?: import("../../view/environment-page").EnvironmentPageState | undefined
  /** A connected daemon older than this terminal that could not be restarted yet: one standing line above the prompt. */
  daemonNotice?: string | undefined
  /** A newer build was installed under this terminal: one right-aligned line above the prompt until it restarts into it. */
  updateReady?: boolean
  /** This run is the newer build an open terminal restarted into: said on the prompt's top rule until the first key. */
  updated?: boolean
  /** `/reload` or `/restart` asked while this session's response runs: done when it ends, a standing line until then. */
  waitingFor?: import("./daemon").SessionAction | undefined
  /** Why the daemon is going away: after the reconnect the matching toast is shown. */
  daemonRestart?: "manual" | "older" | undefined
  /** A question or card shown on coming back to a session: where to continue, compact a large one, send after a long idle, a recap of the absence. */
  returnPrompt?: import("../../view/return-card").ReturnPrompt | undefined
  /** The `/ps` card over the prompt: the open session's background commands and agents, one selected. */
  psCard?: import("../../view/ps-card").PsCardState | undefined
  /** Set while dictating (`/voice`): the clip is being recorded or its transcript is on its way. */
  voice?: import("../../view/voice-row").VoiceState | undefined
  automationLedger?: import("../../view/automation-ledger-page").AutomationLedgerState
  compoundPage?: import("../../view/compound-page").CompoundPageState
  compoundReport?: import("@mendcode/protocol").CompoundReport
  aiConfigState?: import("../../view/ai-config-page").AIConfigPageState
  releaseReport?: import("@mendcode/protocol/wire").ReleaseReport | undefined
  /** The newest release the daemon announced (`release.available`), for the footer's `update` segment. */
  updateAvailable?: { version: string; installed: boolean } | undefined
  /** Local time of the last session event received (the working row's stalled hint). */
  lastEventAt?: number | undefined
  releaseSelected?: number
  releaseScroll?: number
  releaseError?: string
  releaseLoading?: boolean
  ideState?: import("./ide").IdeState
  ideTimer?: ReturnType<typeof setInterval> | undefined
  ideStopped?: boolean
  console?: import("../../view/console-page").ConsolePageState
  sharePage?: import("../../view/console-page").SharePageState
  mflow?: import("../../view/mflow-page").MflowPageState
  keymapState?: import("../../view/keymap-page").KeymapState
  terminalSetupState?: import("../../view/terminal-setup-page").TerminalSetupState
  /** The running tour of /tutorial: its practice chat is a second, isolated terminal app (src/tutorial). */
  tutorialState?: import("../../tutorial/tour").Tour | undefined
  mflowWait?: { file: string; deadlineAt: number } | undefined
  compactionView?: import("../../view/compaction-page").CompactionView
  compactionCursor?: { row: number; col: number } | undefined
  promptModeState?: import("../../view/prompt-mode-page").PromptModeState
  promptReport?: import("@mendcode/protocol/wire").PromptStatus | undefined
  promptError?: string
  diagnosticsReport?: import("../../view/diagnostics-page").DiagnosticsReport | undefined
  diagnosticsMemory?: NodeJS.MemoryUsage
  diagnosticsError?: string
  diagnosticsSnapshots?: string[]
  diagnosticsScroll?: number
  helpScroll?: number
  toastPage?: Page
  stashState?: import("../../view/stash-page").StashState
  draftsState?: import("../../view/stash-page").DraftsState
  /** The /queue page: the session's queue with full text, read from the daemon (`queue.list`) and refreshed on every queue change. */
  queueState?: import("../../view/queue-page").QueuePageState | undefined
  /** Set by the flip-send key for the next `user.submit` only: how that one message meets a running turn. */
  nextDelivery?: import("@mendcode/protocol").QueueDelivery | undefined
  /** The mouse selection in the transcript or the prompt, while it is dragged (or kept, with `copyOnSelect` off); and where the last frame put them. */
  selection?: import("../selection").Selection | undefined
  selectionMap?: import("../selection").SelectionMap | undefined
  /** Unsent drafts of this project's other sessions, newest first: found at start, restored with ctrl+r or /drafts. */
  unsent: import("../drafts").UnsentDraft[]
  /** Large pastes the prompt shows as `[Pasted Content N chars]` labels; the message gets their text (view/paste-placeholders.ts). */
  pastes: import("../../view/paste-placeholders").PendingPaste[]
  clearPending?: boolean
  clearFrom?: import("@mendcode/protocol").ItemId | undefined
  sessionId: SessionId
  mode: PresentationMode
  ext: ExtensionRuntime | undefined
  /** Last characters of the session's pasted secrets by marker number, from `secrets.list`: `‹secret:N›` is drawn as `‹secret ··<tail>›`. Never a value. */
  secretTails: Map<number, string>
  transcript: ReturnType<typeof createTranscript>
  /** `held` keeps live events of the session that arrive before its first window lands; they replay after it. */
  paging: { firstSeq: number; more: boolean; loading: boolean; ready: boolean; loadedEarlier: boolean; held: Array<import("@mendcode/protocol").SessionEvent> } | undefined
  memoryWorkspaces?: import("@mendcode/protocol").MemoryWorkspacesReport | undefined
  sharingStatus?: import("@mendcode/protocol").SharingStatusReport | undefined
  sharingResult?: import("@mendcode/protocol").SharingResult | undefined
  sharingError?: string | undefined
  memoryAssistant?: import("./memory-assistant").MemoryAssistantState | undefined
  memoryOmitted?: number | undefined
  memories: MemoryEntry[]
  /** The /memory Graph tab's report, loaded when that tab opens and refreshed on memory.changed. */
  childTasks?: import("@mendcode/protocol").TaskRecord[]
  /** The open session's sub-agents for the strip above the prompt (`view/agents-strip.ts`), asked again on every `task.changed` that names it as parent. */
  liveTasks?: import("@mendcode/protocol").TaskRecord[] | undefined
  /** A `task.list` for the strip is in flight; `again` when another change arrived meanwhile. */
  liveTasksAsk?: { again: boolean } | undefined
  taskSelected?: number
  taskScroll?: number
  taskError?: string
  sessionParentId?: SessionId | undefined
  /** A sub-agent thread open in the chat's place (ui/app/agent-view.ts): the item of its call, and the session's own transcript while `transcript` is the thread's view. */
  agentView?: import("@mendcode/protocol").ItemId | undefined
  agentRoot?: AppState["transcript"] | undefined
  agentBackgrounds?: import("@mendcode/protocol").SessionBackgroundEntry[]
  agentBackgroundError?: string
  extractionJobs?: Omit<import("@mendcode/protocol").ExtractionJob, "text">[]
  memoryMaintenanceReport?: { policy: string; duplicates: Array<{ memoryId: string; canonicalId: string }> } | undefined
  extractorConfigured?: boolean
  extractionStatus?: import("../../view/memory-extraction-tab").ExtractionData["status"]
  memoryGraph: MemoryGraphReport | undefined
  /** The /memory Dream tab's recent runs of this project, loaded when that tab opens and kept current by dream.changed. */
  dreamRuns: DreamRun[] | undefined
  /** Dream runs whose full report was already asked for (`dream.list` carries it for the newest five only). */
  dreamReportAsked: Set<number>
  /** The /memory Policies tab's categories with the policy in force; also the category picker's options. */
  memoryCategories: MemoryCategoryInfo[] | undefined
  /** The /memory Evolution tab's mode, suggestions and what Evolution has seen in this project. */
  evolutionData: EvolutionData | undefined
  memoryState: ReturnType<typeof createMemoryPageState>
  /** Set while the chat editor holds a memory being edited; Enter saves it, Esc cancels. */
  editingMemory: MemoryId | undefined
  changesReport: ChangesReport | undefined
  changesSource?: { sessionId: SessionId; atItemId?: import("@mendcode/protocol").ItemId } | undefined
  contextReport: ContextReport | undefined
  contextError: string
  changesError: string
  changesState: ReturnType<typeof createChangesPageState>
  mcpsReport: McpStatusReport | undefined
  mcpsError: string
  acpState: import("../../view/acp-page").AcpPageState
  agentSessions: Map<string, AgentSession>
  agentTitles: Map<string, string>
  /** The parent of each sub-agent session a `task.changed` named (the activity push does not carry it): the session pet's `agents` state reads it. */
  agentParents: Map<string, string>
  agentShells: AgentShell[]
  /** Sub-agents the user stopped and `/relaunch` already asked to start again, by their call's item: their stopped row goes. */
  relaunched: Set<string>
  agentShellsBusy: boolean
  agentShellsStale: boolean
  toolsReport: CustomToolsReport | undefined
  toolsError: string
  packagesReport: PackagesReport | undefined
  packagesError: string
  statusState: StatusPageState
  statusInfo: DaemonInfoReport | undefined
  statusInfoError: string
  statusModels: ModelsReport | undefined
  extensionsReport: ExtensionsReport | undefined
  extensionsError: string
  hooksReport: HooksReport | undefined
  hooksError: string
  /** MCP servers for the home footer (`/customize` footer on); asked once, when the footer is first wanted. */
  homeMcp: HomeFooter["mcp"]
  homeMcpAsked: boolean
  storageReport: StorageReport | undefined
  storageError: string
  storageRetention: number | undefined
  storageWorktreeGc: number | undefined
  storageState: ReturnType<typeof createStoragePageState>
  page: Page
  /** Latest daemon-owned settings (the setup page shows and edits these). */
  settingsNow: Settings
  usageReport: UsageReport | undefined
  /** The Waste tab's report, asked for when the tab opens; `usageWasteLoading` false after a failed ask. */
  usageWaste: UsageWasteReport | undefined
  usageWasteLoading: boolean | undefined
  usageState: ReturnType<typeof createUsagePageState>
  connection: "connected" | "reconnecting" | "closed"
  notice: string
  /** The /secrets page: the session's secrets (never values) and the page state, which alone may hold a revealed value. */
  secretsList: SecretInfo[] | undefined
  secretsError: string
  secretsState: ReturnType<typeof createSecretsPageState>
  /** Bumped when /secrets opens or is left, so a reveal that answers late cannot land on another visit. */
  secretsVisit: number
  /** Marker numbers a `secrets.list` did not know (forgotten or never stored): not asked about again. */
  secretsMissing: Set<number>
  secretsLoading: boolean
  secretsAgain: boolean
  /** Model and effort the next answer uses (`models.list`), shown in the row under the prompt. */
  effectiveModel: ModelChoice | undefined
  /** Lines added and removed in the working tree, for the top bar (and the files for the sidebar); fetched at start and after each turn. */
  diffTotals: { added: number; removed: number } | undefined
  changedFiles: SidebarChange[]
  extKeyProblems: string[]
  /** The report cuts diffs to fit one frame; the selected file's full diff is fetched once on demand. */
  fetchedDiffs: Set<string>
  /** What `/undo` or `/redo` just did (or refused over changed files), shown as a card over the transcript until esc. */
  rewindCard: RewindCard | undefined
  historyState: import("../../view/history-page").HistoryState
  historyReport: import("@mendcode/protocol").HistoryReport | undefined
  historyDetail: import("@mendcode/protocol").HistoryTurn | undefined
  historyError: string
  historyLoading: boolean
  skillsState: import("../../view/skills-page").SkillsState
  skillsReport: import("@mendcode/protocol").SkillsReport | undefined
  skillsError: string
  modelPicker: import("../../view/model-picker").ModelPickerState
  /** The quick model switch over the chat (`/model`): its filter, highlighted row and the efforts picked in place. Undefined while closed. */
  modelQuick: import("../../view/model-quick").ModelQuickState | undefined
  variantState: import("../../view/model-picker").VariantState
  /** `/tree` and `/timeline`: the session's messages, its fork family and what each branch cost, merged into one model (ui/app/session-tree.ts). */
  tree?: import("./session-tree").TreeData | undefined
  /** The tree page's own selection, filter, search, folds and bookmark being typed. */
  treeState: import("../../view/session-tree-keys").TreeState
  /** `/recap` and `/changelog`: a read-only scrollable document, and the body height of the page showing it. */
  textPage?: import("../../view/text-page").TextPageState
  /** Where `/import setup` was opened from; esc on its page goes back there. */
  textReturn?: Page | undefined
  pageBodyHeight?: number
  messageActions?: import("../../view/transcript-actions-page").MessageActionsState
  exportOptions?: import("../../view/transcript-actions-page").ExportOptionsState
  /** Height of the transcript viewport in the last chat frame (Home scrolls to the top of it). */
  lastBodyHeight: number
  /** The transcript find bar (ctrl+f, `/find`) while it is open. */
  find: import("../../view/find").FindState | undefined
  /** The prompt-history search bar (alt+r, `/prompt-history`) while it is open. */
  promptSearch: import("../../view/prompt-search").PromptSearchState | undefined
  /** The `?` shortcut overlay above the prompt. */
  shortcuts: boolean
  /** When Esc was last pressed on an idle, empty prompt (a second press inside the window opens the backtrack picker). */
  backtrackArmedAt: number
  /** Until when a terminal read of plain text still counts as part of a paste burst. */
  pasteBurstUntil: number
  spinFrame: number
  /** Turn facts the transcript does not keep: start time, running item, provider retry, request extras. */
  turnState: ReturnType<typeof createTurnState>
  /** When this session was opened here, for the exit summary. */
  openedAt: number
  escArmedAt: number
  /** The tray's own editor has focus; Esc returns to the prompt and flushes autosave. */
  editingScratch: true | undefined
  scratchFor: string | undefined
  /** `/goal`'s card: the summary, or a question (replace the goal, resume it) that `y` answers; esc closes it. */
  goalPrompt: GoalPrompt | undefined
  /** Set while the prompt edits the goal's objective: Enter saves it, Esc drops the edit. `draft` is what the prompt held before. */
  editingGoal: { draft: string } | undefined
  /** v1's `!` shell mode: the prompt runs its text as a command instead of sending it to the model. */
  shellMode: boolean
  placeholder: string
  /** The companion next to the prompt; its module loads only once a pet is chosen (an unset pet costs nothing). */
  pet: PetSlot | undefined
  sessions: SessionSummary[]
  /** The newest sessions of every project as listed at attach (`loadAgentSessions`): the home's Completed reads them with `sessions`. */
  homeRecent: SessionSummary[]
  renameFromChat: boolean
  sessionList: ReturnType<typeof createSessionListState>
  gitBranch: string | undefined
  /** The project note loaded through the daemon; `scratchFor` is its project directory. */
  scratchNote: string
  scratchArea: { top: number; left: number; width: number; rows: number; first: number } | undefined
  scratchCursor: { row: number; col: number } | undefined
  /** ctrl+t: v1's session widgets dock above the working row. */
  dockOpen: boolean
  /** What the compaction events reported so far; feeds the live compaction panel. */
  compactionFacts: import("../../view/compaction-facts").CompactionFactsStore
  /** The live compaction panel's own state: the arcade game in play, whether it has the keys, and where the panel was drawn. */
  compactionLive: {
    session: import("../../view/compaction-arcade").ArcadeSession | undefined
    /** True while the arcade owns the keyboard; the prompt does not see them. */
    focused: boolean
    /** Best score per game for this run of the terminal. */
    best: Record<string, number>
    area: { top: number; rows: number; width: number } | undefined
    /** The scratchpad editor is drawn in the panel this frame (not in the dock). */
    scratchPanel: boolean
    loading: Promise<void> | undefined
  }
  /** Images and small text files waiting for the next submit; shown above the prompt, removed with backspace on an empty prompt. */
  attachments: PendingAttachment[]
  suggestion: number
  /** ↑/↓ prompt recall for this project (sent messages, commands, shell lines, drafts); loaded from the daemon on first use and again after a session switch. `draft`, `draftCursor` and `shell` are the unsent text at the bottom, where its cursor was and whether it was in shell mode; `shown` is the text the recalled entry put in the prompt (an edit of it ends the browsing). */
  recall: { prompts: import("../../view/prompt-search").RecallEntry[] | undefined; index: number; draft: string; draftCursor: number; shown: string; shell: boolean }
  /** Counts the prompts handed on (sent, a command picked from the menu, stashed), so a prompt emptied that way is told apart from one that was discarded. */
  submits: number
  mentionPending: string | undefined
  mentionInFlight: boolean
  mentionResults: MentionEntry[]
  mentionSuggestion: number
  /** `@token` under the cursor, and its latest matches from `files.search` (S4 mention picker). */
  mentionToken: MentionToken | undefined
  mentionLastQuery: string | undefined
  /** `/pet`: installed pets and their idle previews (loading a preview may decode a sheet once). */
  petList: PetChoice[] | undefined
  petPicker: PetPickerState
  /** The picker is choosing the start screen's mascot (`/mascot`) instead of the prompt's pet. */
  petPickerMascot?: boolean | undefined
  petPlan?: import("../../../../../packages/protocol/src/pet-data").PetPlan | undefined
  petGenerating?: boolean | undefined
  petProgress?: import("../../../../../packages/protocol/src/pet-data").PetProgress | undefined
  petPlanError?: string | undefined
  homeSelected?: string | undefined
  /** The Agent View row under the mouse: drawn like the selected row, so the row a click opens shows before the click. */
  homeHover?: string | undefined
  /** The mouse is over the chat's pet: the ASCII Mend shows its hover face, a pixel pet waves once as it arrives. */
  petHover?: boolean
  petArea?: { top: number; bottom: number; from: number; to: number } | undefined
  /** Inline images of the transcript (loaded lazily with the first image on screen) and the cell size the graphics layer was made for. */
  imageCards?: import("./image-cards").ImageCards | undefined
  imageCellPixels?: import("../../pets/frames").CellPixels | undefined
  reducedMotion: boolean
  /** Screen-reader mode is on: this run asked for it or the saved setting did. It forces reduced motion and drops the live clock. */
  accessible: boolean
  /** The glyph set every view draws with, resolved once per profile change (`glyph-mode.ts`); `ascii` also transliterates each frame. */
  glyphMode: import("../theme").GlyphMode
  loopsState: ReturnType<typeof createLoopsPageState>
  loops: Loop[]
  loopsLoaded: boolean
  loopsError: string
  /** Loops in a live state for this project, kept from `loop.list` and `loop.changed`. */
  liveLoops: Set<string>
  workflowsState: ReturnType<typeof createWorkflowsPageState>
  workflows: WorkflowSummary[]
  workflowsLoaded: boolean
  workflowsError: string
  /** Live workflows of this project (id → waits for the user), from `workflow.list` and `workflow.changed`. */
  liveWorkflows: Map<string, boolean>
  permissionGrants: PermissionGrant[] | undefined
  permissionGrantsError: string
  permissionHistory?: import("@mendcode/protocol").PermissionsHistoryReport
  permissionHistoryError?: string
  permissionsModels: ModelsReport | undefined
  permissionsModelsError: string
  /** `/permissions`: the session's grants and the reviewer role (from `models.list`), loaded when the page opens. */
  permissionsState: PermissionsPageState
  /** `/diagram`: the session's diagrams when the page opened, the view over one of them, and its last layout. */
  diagramSources: DiagramSource[]
  diagramView: DiagramViewState
  diagramMemo: { key: string; layout: DiagramLayout } | undefined
  /** Session-owned side chats, outside the main transcript. */
  sideChats: Map<string, SideChatState>
  rightScroll: number
  rightFocus: boolean
  rightChatArea: { top: number; height: number } | undefined
  rightTick: ReturnType<typeof setInterval> | undefined
  sidebarEdit: { selected: number; adding: boolean; type: number; draft?: string | undefined }
  paletteSessions: SessionSummary[]
  /** The open `/fetch` card; it shares the `/btw` card's place over the transcript and closes with esc. */
  fetchFacts: FetchFacts | undefined
  todayUsage: { tokens: number; calls: number; costMicros?: number } | undefined
  recipes: RecipesReport | undefined
  intro: { returnPage: Page; elapsedMs: number } | undefined
  setupInfo: DaemonInfoReport | undefined
  setupInfoError: string
  setupMcp: number | undefined
  setupMemory: SetupChecks["memory"]
  setupState: ReturnType<typeof createSetupPageState>
  /** The welcome page behind `/setup` and the first run; `/setup advanced` is the long page held in `setupState`. */
  onboarding: { state: import("../../view/onboarding-page").OnboardingState; detected: import("../../view/onboarding-detect").Detected | undefined; loading: boolean; firstRun: boolean; /** The theme in use when the page opened: put back on esc, compared on Enter. */ lookStart: string; /** The profile keys the Look rows move (glyphs, tool cards, diff, prompt, pet) as they were when the page opened: put back on esc, compared on Enter. */ styleStart: Partial<import("../../view/tui-profile").TuiProfile>; /** The tier the installer was asked for, shown as the Tier row's start and applied when the page is left with esc. */ preset?: import("@mendcode/protocol/wire").Tier } | undefined
  setupAdvanced: boolean
  agentReport: AgentsReport | undefined
  agentError: string
  agentPicker: AgentPickerState
  themePicker: ThemePickerState
  /** The theme choice the picker opened on, put back if it is left without Enter. */
  themeRestore: string | undefined
  modelReport: ModelsReport | undefined
  modelError: string
  modelState: ReturnType<typeof createModelPageState>
  /** The model page's favorites and last used models, kept in `<dataDir>/tui/models.json` (this terminal's own, like the profile). */
  modelPrefs: ModelPrefs
  /** Bumped by every connect attempt and every open, so a reply that arrives after the page closed or restarted is dropped. */
  connectSerial: number
  /** The key exists only inside connectState.values.key while it is typed; submitting moves it into one providers.set call. */
  connectState: ConnectState
  connectProviders: ProviderInfo[] | undefined
  connectModels: ModelsReport | undefined
  providersList: ProviderInfo[] | undefined
  providersError: string
  providerNotes: Record<string, ProviderNote>
  contextState: ContextPageState
  mcpsState: ReturnType<typeof createMcpsPageState>
  agentsState: ReturnType<typeof createAgentsPageState>
  toolsState: ReturnType<typeof createToolsPageState>
  packagesState: ReturnType<typeof createPackagesPageState>
  /** The terminal's own look (`<dataDir>/tui/profile.json`, see /customize); read once at start, the defaults without a data dir. */
  tuiProfile: TuiProfile
  /** The stored profile as this run knows it; `tuiProfile` is this with the layers over it (profile-layers.ts). */
  profileBase: TuiProfile
  /** What slash commands showed or hid in each session of this terminal (session-look.ts); over the profile, never saved. */
  sessionLook: Map<string, Partial<TuiProfile>>
  /** What enabled packages' activation profiles currently ask for (extensions/activation.ts, loaded only when one exists). */
  activation: import("../../extensions/activation").TuiActivation | undefined
  /** The keys a package overlay or a running extension holds right now, with the value each put there. */
  profileApplied: Record<string, unknown>
  /** What running extensions asked for through `api.settings.set`; gone with them. */
  profileRuntime: Record<string, unknown>
  /** Keys the user chose by hand after a layer held them (profile keys, or `keybindings:<key>`): theirs over every layer. */
  keptKeys: Set<string>
  /** The value of each kept profile key a package holds: saved per look owner in activation.json, never in the stored profile. */
  keptValues: Record<string, unknown>
  customizeState: CustomizePageState
  settingsPageState: SettingsPageState
  extensionsState: ExtensionsPageState
  hooksState: HooksPageState
  /** 1 s elapsed tick: only exists while the workflows page shows a live run. */
  workflowsTick: ReturnType<typeof setInterval> | undefined
  /** 1 s countdown tick: only exists while the loops page shows a pending wakeup. */
  loopsTick: ReturnType<typeof setInterval> | undefined
  /** The usage page's Clock widget has no other reason to re-render while idle; ticks once a minute, only while the page is open. */
  usageTick: ReturnType<typeof setInterval> | undefined
  /** 1 s tick for the background row's run times: only while this session has something running in the background. */
  backgroundTick: ReturnType<typeof setInterval> | undefined
  /** Ctrl+P command palette: open only from the chat page (every other page uses ctrl+p as "up"). */
  palette: PaletteState | undefined
  /** The file paths the palette lists while it is titled "Open file" (the `file.open` key found several). */
  pathPicks: import("../../view/file-ref").FileRef[]
  /** The transcript text the last mouse selection copied (copy on select drops the selection itself): what the open-path key looks in for a few seconds. */
  copiedBody?: { text: string; at: number } | undefined
  /** The user's /footer choice; without one, full view shows every segment and the others the default set. */
  customFooter: readonly FooterSegment[] | undefined
  providersState: ProvidersPageState
  /** Screen rows of the slash popup in the last chat frame (0-based top row, first suggestion index shown, rows). */
  popupArea: { top: number; first: number; count: number } | undefined
  /** Screen rows of the mention popup in the last chat frame; same shape as `popupArea`. */
  mentionPopupArea: { top: number; first: number; count: number } | undefined
  /** Scroll offset of the approval diff box; reset when a different request is pending. */
  approvalScroll: number
  approvalScrollFor: string
  frameScheduled: boolean
  /** When the transcript last scrolled (wheel, key or scrollbar drag): the `auto` scrollbar stays up for a moment after. */
  scrollbarAt: number | undefined
  pulse: ReturnType<typeof setInterval> | undefined
  pulseOn: boolean
  /** Highlighted option of the pending approval (rich views), reset per request. */
  approvalChoice: number
  approvalChoiceFor: string | undefined
  /** A plan review being answered in the prompt: `edit` holds the plan text to send back edited, `comment` is feedback. Enter sends, Esc drops it. */
  planDraft: { requestId: string; kind: "edit" | "comment" | "note" } | undefined
  /** The approval whose explanation (`?`) is open. */
  approvalExplainFor: string | undefined
  statusLoaded: boolean
  shellPlaceholder: string
  /** The project's script-backed status line (`status.line`), drawn in the row under the prompt. */
  statusLine: { left: readonly StatusSegment[]; right: readonly StatusSegment[]; leftRows?: readonly StatusSegment[][]; rightRows?: readonly StatusSegment[][] } | undefined
  statusProblem: string
  leaderTimer: ReturnType<typeof setTimeout> | undefined
  /** The project's MCP servers for the sidebar; asked when the sidebar first shows and after each turn. */
  sidebarMcp: McpStatusReport["servers"] | undefined
  sidebarMcpAsked: boolean
  /** The project backlog as last read (`backlog.get`) or changed by `/backlog`; undefined until then. */
  backlog?: readonly import("@mendcode/protocol/wire").BacklogItem[] | undefined
  /** The lineage the agents card draws (`session.tree`), undefined until the first answer; `sidebarTreeRev` grows when a sub-agent changes, which asks again. */
  sidebarTree: import("@mendcode/protocol").SessionTreeNode[] | undefined
  sidebarTreeRev: number
  /** The right bar found no room at the last width: it returns only a few columns above its threshold (view/right-bar.ts). */
  rightBarCollapsed: boolean
  branchRequested: boolean
  /** The top bar's title scrolls one cell per tick; the timer exists only while it overflows. */
  topbarTick: number
  contextHover?: boolean
  /** The web address under the mouse pointer in the transcript: its rows draw underlined, and a click opens it. */
  hoverLink?: string | undefined
  contextArea?: { from: number; to: number } | undefined
  sidebarFocus?: boolean
  sidebarSelected?: string | undefined
  sidebarHits?: Array<{ row: number; sessionId: string }>
  topbarTimer: ReturnType<typeof setInterval> | undefined
  /** Screen rows of the panels in the last chat frame, for clicks (0-based; rows are relative to `top`). */
  requestArea: { top: number; hits: Array<{ row: number; index: number; from?: number; to?: number }>; kind: "approval" | "question" } | undefined
  sendChipArea: { row: number; from: number; to: number } | undefined
  /** Where the home screen's session rows landed, so a click can open one. */
  homeArea: { top: number; hits: Array<{ row: number; from: number; to: number; sessionId: string }> } | undefined
  /** Where the usage-limit bar's chips landed in the last chat frame: `top` is the bar's first screen row, chip rows are relative to it. */
  /** Where the Agents strip's rows landed: a click on one opens that sub-agent. `ids` has no entry for a row that is not a sub-agent. */
  agentsArea?: { top: number; ids: Array<string | undefined> } | undefined
  limitArea: { top: number; chips: Array<{ action: "schedule" | "cancel" | "snooze" | "resume" | "dismiss"; row: number; from: number; to: number }> } | undefined
  /** Effective keys: the defaults, `keybindings.json`, then `api.key` of extensions. */
  bindings: Bindings
  extPageId: string | undefined
  /** The extension modal drawn over the screen (`api.modal`); it takes the keyboard while open. */
  extModalId?: string | undefined
  /** Project extension modules left unloaded because the directory is not trusted (shown in /help). */
  extSkipped: number
  extStarted: boolean
  extAnnounced: boolean
  extSettingsKey: string
  extLoad: Promise<void>
  worktrees?: import("../../view/worktrees-page").WorktreesPageState
  /** The repository's state in the Git page's tabs row (`git.status`, asked when a tab opens and after a commit). */
  gitStatus: import("../../view/git-page").GitStatusInfo
  /** The Commit tab: ticked files, the message, the confirmation card. Kept while the page is closed, so a half-written message survives a trip to Changes. */
  gitCommit?: import("../../view/git-commit-page").GitCommitState | undefined
  /** The PR tab: the branch's pull request, the push and create cards, the form. Made again each time the tab opens. */
  gitPr?: import("../../view/git-pr-page").GitPrState | undefined
  /** The Git page in a folder that is not a repository: the Initialize action and its card. */
  gitInit?: import("../../view/git-init-page").GitInitState | undefined
  /** Rows the Git tabs row takes above the page body (1 inside the frame, else 0): a click is resolved against what was drawn. */
  pageBodyTop?: number
  tsm?: import("../../view/tsm-page").TsmPageState
}

export type AppContext = {
  input: AppInput
  state: AppState
  now(): number
  scratchEditor: ReturnType<typeof createEditor>
  editor: ReturnType<typeof createEditor>
  /** Modal layer over `editor`, active while the `vimMode` profile setting is on. */
  vim: import("../../view/vim").Vim
  keybindingFile: KeybindingFile
  stateLabels: Record<ForegroundState, string>
  permissionLabels: Record<PermissionMode, string>
  localDay(at: number): string
  say(message: string, variant?: ToastVariant, extra?: { title?: string; hint?: string; oneLine?: boolean; ms?: number; quiet?: boolean }): void
  fail(message: string): void
  report(reply: CommandReply): void
  requestFrame(): void
  copyText(text: string, what: string, extra?: { hint?: string; ms?: number; quiet?: boolean }): void
  setupChoice(patch: Record<string, unknown>): Promise<void>
  extensionProblemLines(): string[]
  view: ReturnType<typeof createViewState>
  env: Record<string, string | undefined>
  drafts: ReturnType<typeof createDraftSync>
  /** Comments on an answer's passages (docs/editor.md): the store, the modes, the keys and what is drawn. Set once the app has built it. */
  comments: import("./comments").Comments
  stash: ReturnType<typeof createPromptStash>
  random(): number
  glyphs: Glyphs
  /** The view-slot host: every redrawable part of the screen draws through it (docs/views.md). */
  views: import("../../view/views").ViewHost
  transcriptHooks: TranscriptHooks
  /** The transcript's window onto `state.imageCards`: answers "not shown" until the first image is loaded. */
  transcriptImages: import("../../view/transcript").TranscriptImages
  quotas: Map<string, Extract<GlobalEvent, { type: "quota.snapshot" }>>
  /** The code graph's counts per project directory, as the daemon last pushed them (`codegraph.status`); the footer's `codegraph` segment reads it. */
  codegraph: Map<string, Extract<GlobalEvent, { type: "codegraph.status" }>>
  /** The live session stats (docs/customize.md, "Session stats"): every surface and `api.stats()` read this one holder. */
  stats: import("../../view/session-stats").StatsHub
  /** Context, tokens and the provider quota windows observed so far (`api.usage()`, the slot context's `usage`). */
  usage: { read(): import("@mendcode/extension-api").UsageSnapshot }
  schedule(fn: () => void): void
  homeTipText: string
  toasts: ReturnType<typeof createToasts>
  leader: LeaderState
}

export function createContext(ctx: AppContext) {
  const { input, state, requestFrame, say, fail } = ctx

  /**
   * `/context-window` shows this session's window; `/context-window 200k` (or `1m`, `128000`) sets it; `reset` goes back to the
   * model's own. `--always` makes it (or its reset) the model's `modelContext` window, for every session on that model.
   */
  async function contextWindowCommand(args: string) {
    if (!state.sessionId) return fail("context-window: no session yet")
    if (!args.trim()) {
      await loadContext()
      const report = state.contextReport
      if (!report) return fail(`context-window: ${state.contextError || "unavailable"}`)
      say(`context window: ${report.contextWindow ? `${report.contextWindow.toLocaleString("en-US")} tokens${report.contextWindowOverride ? " (override)" : report.contextWindowModelSetting ? " (modelContext setting)" : ""}` : "unknown"} · compacts at ${report.compactAtTokens.toLocaleString("en-US")}`)
      return
    }
    const parsed = parseContextWindowArgs(args)
    if (!parsed) return fail("context-window: use a number like 200k, 1m or 128000 (1k to 10m), or reset; add --always for every session on this model")
    const reply = await input.send({ type: "session.context-window", sessionId: state.sessionId, tokens: parsed.tokens, ...(parsed.always ? { always: true } : {}) })
    if (!reply.ok) return fail(`context-window: ${reply.error.message.replace(/^\[DAEMON\]: /, "")}`)
    say(contextWindowReply(reply.result as ContextWindowAck, parsed.always), "success")
    if (state.page === "context") await loadContext()
  }

  /** `/files` opens the context page on the files the history still holds. */
  async function filesCommand() {
    await preload("context")
    state.page = "context"
    state.contextReport = undefined
    state.contextState = { tab: 2 }
    state.contextError = ""
    requestFrame()
    await loadContext()
  }

  async function loadContext() {
    const reply = await input.send({ type: "context.query", sessionId: state.sessionId })
    if (reply.ok) {
      state.contextReport = reply.result as ContextReport
      state.contextError = ""
    } else {
      state.contextReport = undefined
      state.contextError = reply.error.message
    }
    requestFrame()
  }

  return { loadContext, contextWindowCommand, filesCommand }
}
