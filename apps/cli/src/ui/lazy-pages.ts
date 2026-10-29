/**
 * Page views load on first use (P5): a terminal that never opens /usage or /storage never pays for their
 * code. Each export below has the same name and signature as the real function, so the app calls it as
 * before; the module must have been loaded first with `preload`. Chat, transcript, markdown, editor and
 * footer stay eager and are not listed here.
 */

type Loaded<T> = { load(): Promise<T>; get(): T; loaded(): boolean }

function lazyModule<T>(name: string, load: () => Promise<T>): Loaded<T> {
  let module: T | undefined
  let pending: Promise<T> | undefined
  return {
    load: () => (pending ??= load().then((m) => (module = m))),
    get() {
      if (!module) throw new Error(`[UI]: page module "${name}" used before it was loaded`)
      return module
    },
    loaded: () => module !== undefined,
  }
}

const tasks = lazyModule("tasks-page", () => import("../view/tasks-page"))
const usage = lazyModule("usage-page", () => import("../view/usage-page"))
const memory = lazyModule("memory-page", () => import("../view/memory-page"))
const context = lazyModule("context-page", () => import("../view/context-page"))
const changes = lazyModule("changes-page", () => import("../view/changes-page"))
const gitPage = lazyModule("git-page", () => import("../view/git-page"))
const gitCommitPage = lazyModule("git-commit-page", () => import("../view/git-commit-page"))
const gitPrPage = lazyModule("git-pr-page", () => import("../view/git-pr-page"))
const gitInitPage = lazyModule("git-init-page", () => import("../view/git-init-page"))
const acp = lazyModule("acp-page", () => import("../view/acp-page"))
const mcps = lazyModule("mcps-page", () => import("../view/mcps-page"))
const tools = lazyModule("tools-page", () => import("../view/tools-page"))
const packages = lazyModule("packages-page", () => import("../view/packages-page"))
const storage = lazyModule("storage-page", () => import("../view/storage-page"))
const agentPicker = lazyModule("agent-picker", () => import("../view/agent-picker"))
const themePicker = lazyModule("theme-picker", () => import("../view/theme-picker"))
const agents = lazyModule("agents-page", () => import("../view/agents-page"))
const peerCommands = lazyModule("agent-commands-page", () => import("../view/agent-commands-page"))
const loops = lazyModule("loops-page", () => import("../view/loops-page"))
const workflows = lazyModule("workflows-page", () => import("../view/workflows-page"))
const workflowCommand = lazyModule("workflow-command", () => import("../view/workflow-command"))
const loopCommand = lazyModule("loop-command", () => import("../view/loop-command"))
const setup = lazyModule("setup-page", () => import("../view/setup-page"))
const onboarding = lazyModule("onboarding-page", () => import("../view/onboarding-page"))
const onboardingDetect = lazyModule("onboarding-detect", () => import("../view/onboarding-detect"))
const customize = lazyModule("customize-page", () => import("../view/customize-page"))
const stash = lazyModule("stash-page", () => import("../view/stash-page"))
const queuePage = lazyModule("queue-page", () => import("../view/queue-page"))
const settings = lazyModule("settings-page", () => import("../view/settings-page"))
const status = lazyModule("status-page", () => import("../view/status-page"))
const fileViewer = lazyModule("file-viewer", () => import("../view/file-viewer"))
const extensionsPage = lazyModule("extensions-page", () => import("../view/extensions-page"))
const hooksPage = lazyModule("hooks-page", () => import("../view/hooks-page"))
const palette = lazyModule("palette", () => import("../view/palette"))
const approvalDiff = lazyModule("approval-diff", () => import("../view/approval-diff"))
const petPicker = lazyModule("pet-picker", () => import("../view/pet-picker"))
const connect = lazyModule("connect-page", () => import("../view/connect-page"))
const providers = lazyModule("providers-page", () => import("../view/providers-page"))
const secrets = lazyModule("secrets-page", () => import("../view/secrets-page"))
const history = lazyModule("history-page", () => import("../view/history-page"))
const skills = lazyModule("skills-page", () => import("../view/skills-page"))
const modelPicker = lazyModule("model-picker", () => import("../view/model-picker"))
const modelQuick = lazyModule("model-quick", () => import("../view/model-quick"))
const sessionTree = lazyModule("session-tree-page", () => import("../view/session-tree-page"))
const textPage = lazyModule("text-page", () => import("../view/text-page"))
const permissions = lazyModule("permissions-page", () => import("../view/permissions-page"))
const sidebar = lazyModule("sidebar-editor", () => import("../view/sidebar-editor"))
const promptMode = lazyModule("prompt-mode-page", () => import("../view/prompt-mode-page"))
const diagram = lazyModule("mermaid-viewer", () => import("../view/mermaid-viewer"))
const transcriptActions = lazyModule("transcript-actions-page", () => import("../view/transcript-actions-page"))
const marketplace = lazyModule("marketplace-page", () => import("../view/marketplace-page"))
const planReview = lazyModule("plan-review-page", () => import("../view/plan-review-page"))
const compaction = lazyModule("compaction-page", () => import("../view/compaction-page"))
const compactionLive = lazyModule("compaction-live", () => import("../view/compaction-live"))
const compactionArcade = lazyModule("compaction-arcade", () => import("../view/compaction-arcade"))
const diagnostics = lazyModule("diagnostics-page", () => import("../view/diagnostics-page"))
const ide = lazyModule("ide-page", () => import("../view/ide-page"))
const worktrees = lazyModule("worktrees-page", () => import("../view/worktrees-page"))
const automationLedger = lazyModule("automation-ledger-page", () => import("../view/automation-ledger-page"))
const compound = lazyModule("compound-page", () => import("../view/compound-page"))
const aiConfig = lazyModule("ai-config-page", () => import("../view/ai-config-page"))
const reasoning = lazyModule("reasoning-page", () => import("../view/reasoning-page"))

const release = lazyModule("release-page", () => import("../view/release-page"))
const tsm = lazyModule("tsm-page", () => import("../view/tsm-page"))
const console = lazyModule("console-page", () => import("../view/console-page"))
const mflow = lazyModule("mflow-page", () => import("../view/mflow-page"))
const keymap = lazyModule("keymap-page", () => import("../view/keymap-page"))
const terminalSetup = lazyModule("terminal-setup-page", () => import("../view/terminal-setup-page"))
const tutorial = lazyModule("tutorial-page", () => import("../view/tutorial-page"))
/** The practice chat and its scripted engine live outside `view/`: they load with the tutorial and nowhere else. */
const tutorialTour = lazyModule("tutorial-tour", () => import("../tutorial/tour"))
const tutorialSandbox = lazyModule("tutorial-sandbox", () => import("../tutorial/sandbox"))

/** Modules behind each slash command that opens a page (or needs one to run). */
export const PAGE_MODULES = {
  tasks: [tasks],
  usage: [usage],
  memory: [memory],
  context: [context],
  changes: [changes, gitPage],
  git: [changes, gitPage],
  "git-commit": [changes, gitPage, gitCommitPage],
  "git-pr": [changes, gitPage, gitCommitPage, gitPrPage],
  "git-init": [gitPage, gitInitPage],
  storage: [storage],
  mcps: [mcps],
  acp: [acp],
  tools: [tools],
  packages: [packages],
  agent: [agentPicker],
  theme: [themePicker],
  agents: [agents, peerCommands],
  loops: [loops, loopCommand],
  loop: [loops, loopCommand],
  workflows: [workflows, workflowCommand],
  workflow: [workflows, workflowCommand],
  setup: [setup, onboarding, onboardingDetect],
  detect: [onboardingDetect],
  customize: [customize],
  stash: [stash],
  drafts: [stash],
  queue: [queuePage],
  settings: [settings],
  status: [status],
  fileViewer: [fileViewer],
  extensions: [extensionsPage],
  hooks: [hooksPage],
  trust: [hooksPage],
  palette: [palette],
  approval: [approvalDiff],
  pet: [petPicker],
  connect: [connect],
  providers: [providers],
  secrets: [secrets],
  history: [history],
  skills: [skills],
  variants: [modelPicker],
  modelPicker: [modelPicker],
  modelQuick: [modelPicker, modelQuick],
  timeline: [sessionTree],
  tree: [sessionTree],
  recap: [textPage],
  pr: [textPage],
  changelog: [textPage],
  permissions: [permissions],
  diagram: [diagram],
  sidebar: [sidebar],
  transcriptActions: [transcriptActions],
  messages: [transcriptActions],
  export: [transcriptActions],
  "plan-review": [planReview],
  "stats-project": [usage],
  "prompt-mode": [promptMode],
  compaction: [compaction],
  compactionLive: [compactionLive],
  compactionArcade: [compactionLive, compactionArcade],
  diagnostics: [diagnostics],
  worktrees: [worktrees, gitPage],
  warp: [worktrees, gitPage],
  automationLedger: [automationLedger],
  compound: [compound],
  marketplace: [marketplace],
  "mend-assets": [marketplace],
  intro: [setup],
  "ai-config": [aiConfig],
  reasoning: [reasoning],
  "release-channel": [release],
  tsm: [tsm],
  ide: [ide],
  mflow: [mflow],
  console: [console],
  share: [console],
  keymap: [keymap],
  "terminal-setup": [terminalSetup],
  tutorial: [tutorial, tutorialTour, tutorialSandbox],
} as const
export type PageName = keyof typeof PAGE_MODULES

/** Names of the lazily loaded modules, for the footprint test. */
export const LAZY_MODULE_FILES = ["stash-page", "queue-page","history-page", "skills-page", "model-picker", "acp-page", "agent-picker", "theme-picker", "usage-page", "memory-page", "context-page", "changes-page", "git-page", "git-commit-page", "git-pr-page", "git-init-page", "mcps-page", "tools-page", "packages-page", "storage-page", "agents-page", "loops-page", "loop-command", "workflows-page", "workflow-command", "setup-page", "onboarding-page", "onboarding-detect", "customize-page", "settings-page", "status-page", "extensions-page", "hooks-page", "palette", "approval-diff", "pet-picker", "connect-page", "providers-page", "secrets-page", "session-tree-page", "text-page", "permissions-page", "mermaid-viewer", "sidebar-editor", "transcript-actions-page", "plan-review-page", "prompt-mode-page", "compaction-page", "agent-commands-page", "diagnostics-page", "worktrees-page", "automation-ledger-page", "compound-page", "marketplace-page", "ai-config-page", "reasoning-page", "release-page", "tsm-page", "ide-page", "mflow-page", "console-page", "compaction-live", "compaction-arcade", "keymap-page", "terminal-setup-page", "tutorial-page", "model-quick", "file-viewer"] as const

/** The lazily loaded modules a slash command needs, if any. */
export function slashPage(command: string): PageName | undefined {
  return command in PAGE_MODULES && command !== "palette" && command !== "approval" ? (command as PageName) : undefined
}

export function isLoaded(name: PageName) {
  return PAGE_MODULES[name].every((module) => module.loaded())
}

/**
 * Loads the modules behind `name` (cached after the first time). `onSlow` fires only when the import takes
 * longer than `slowMs`, so a fast open never flashes a loading message.
 */
export async function preload(name: PageName, options: { onSlow?: () => void; slowMs?: number } = {}) {
  const pending = PAGE_MODULES[name].filter((module) => !module.loaded())
  if (pending.length === 0) return
  const timer = options.onSlow ? setTimeout(options.onSlow, options.slowMs ?? 50) : undefined
  try {
    await Promise.all(pending.map((module) => module.load()))
  } finally {
    if (timer) clearTimeout(timer)
  }
}

type UsageMod = typeof import("../view/usage-page")
export const createUsagePageState: UsageMod["createUsagePageState"] = (...args) => usage.get().createUsagePageState(...args)
export const rangeBounds: UsageMod["rangeBounds"] = (...args) => usage.get().rangeBounds(...args)
export const renderUsagePage: UsageMod["renderUsagePage"] = (...args) => usage.get().renderUsagePage(...args)
export const usagePageKey: UsageMod["usagePageKey"] = (...args) => usage.get().usagePageKey(...args)
export const usageSelectedSession: UsageMod["usageSelectedSession"] = (...args) => usage.get().usageSelectedSession(...args)
export const usageWasteAction: UsageMod["usageWasteAction"] = (...args) => usage.get().usageWasteAction(...args)
export const usageWasteOpen: UsageMod["usageWasteOpen"] = (...args) => usage.get().usageWasteOpen(...args)

type MemoryMod = typeof import("../view/memory-page")
export const createMemoryPageState: MemoryMod["createMemoryPageState"] = (...args) => memory.get().createMemoryPageState(...args)
export const memoryPageKey: MemoryMod["memoryPageKey"] = (...args) => memory.get().memoryPageKey(...args)
export const renderTasksPage: typeof import("../view/tasks-page").renderTasksPage = (...args) => tasks.get().renderTasksPage(...args)
export const renderMemoryPage: MemoryMod["renderMemoryPage"] = (...args) => memory.get().renderMemoryPage(...args)
export const memoryGraphCanvas: MemoryMod["memoryGraphCanvas"] = (...args) => memory.get().memoryGraphCanvas(...args)
export const memoryBodyRoom: MemoryMod["memoryBodyRoom"] = (...args) => memory.get().memoryBodyRoom(...args)

type ContextMod = typeof import("../view/context-page")
export const contextPageStateKey: ContextMod["contextPageStateKey"] = (...args) => context.get().contextPageStateKey(...args)
export const renderContextPage: ContextMod["renderContextPage"] = (...args) => context.get().renderContextPage(...args)

type ChangesMod = typeof import("../view/changes-page")
export const changesPageKey: ChangesMod["changesPageKey"] = (...args) => changes.get().changesPageKey(...args)
export const changesReviewSent: ChangesMod["changesReviewSent"] = (...args) => changes.get().changesReviewSent(...args)
export const createChangesPageState: ChangesMod["createChangesPageState"] = (...args) => changes.get().createChangesPageState(...args)
export const renderChangesPage: ChangesMod["renderChangesPage"] = (...args) => changes.get().renderChangesPage(...args)
export const changesPageHits: ChangesMod["changesPageHits"] = (...args) => changes.get().changesPageHits(...args)
export const firstChangedLine: ChangesMod["firstChangedLine"] = (...args) => changes.get().firstChangedLine(...args)

type McpsMod = typeof import("../view/mcps-page")
export const createMcpsPageState: McpsMod["createMcpsPageState"] = (...args) => mcps.get().createMcpsPageState(...args)
export const mcpsPageKey: McpsMod["mcpsPageKey"] = (...args) => mcps.get().mcpsPageKey(...args)
export const renderMcpsPage: McpsMod["renderMcpsPage"] = (...args) => mcps.get().renderMcpsPage(...args)

type ToolsMod = typeof import("../view/tools-page")
export const createToolsPageState: ToolsMod["createToolsPageState"] = (...args) => tools.get().createToolsPageState(...args)
export const toolsPageKey: ToolsMod["toolsPageKey"] = (...args) => tools.get().toolsPageKey(...args)
export const renderToolsPage: ToolsMod["renderToolsPage"] = (...args) => tools.get().renderToolsPage(...args)

type PackagesMod = typeof import("../view/packages-page")
export const createPackagesPageState: PackagesMod["createPackagesPageState"] = (...args) => packages.get().createPackagesPageState(...args)
export const packagesPageKey: PackagesMod["packagesPageKey"] = (...args) => packages.get().packagesPageKey(...args)
export const renderPackagesPage: PackagesMod["renderPackagesPage"] = (...args) => packages.get().renderPackagesPage(...args)

type PetPickerMod = typeof import("../view/pet-picker")
export const createPetPickerState: PetPickerMod["createPetPickerState"] = (...args) => petPicker.get().createPetPickerState(...args)
export const petPickerKey: PetPickerMod["petPickerKey"] = (...args) => petPicker.get().petPickerKey(...args)
export const renderPetPicker: PetPickerMod["renderPetPicker"] = (...args) => petPicker.get().renderPetPicker(...args)

type ConnectMod = typeof import("../view/connect-page")
export const createConnectState: ConnectMod["createConnectState"] = (...args) => connect.get().createConnectState(...args)
export const connectKey: ConnectMod["connectKey"] = (...args) => connect.get().connectKey(...args)
export const connectPaste: ConnectMod["connectPaste"] = (...args) => connect.get().connectPaste(...args)
export const connectBusy: ConnectMod["connectBusy"] = (...args) => connect.get().connectBusy(...args)
export const connectDone: ConnectMod["connectDone"] = (...args) => connect.get().connectDone(...args)
export const connectFailed: ConnectMod["connectFailed"] = (...args) => connect.get().connectFailed(...args)
export const connectWithMethods: ConnectMod["connectWithMethods"] = (...args) => connect.get().connectWithMethods(...args)
export const renderConnectPage: ConnectMod["renderConnectPage"] = (...args) => connect.get().renderConnectPage(...args)

type ProvidersMod = typeof import("../view/providers-page")
export const createProvidersPageState: ProvidersMod["createProvidersPageState"] = (...args) => providers.get().createProvidersPageState(...args)
export const providersPageKey: ProvidersMod["providersPageKey"] = (...args) => providers.get().providersPageKey(...args)
export const renderProvidersPage: ProvidersMod["renderProvidersPage"] = (...args) => providers.get().renderProvidersPage(...args)

type SecretsMod = typeof import("../view/secrets-page")
export const createSecretsPageState: SecretsMod["createSecretsPageState"] = (...args) => secrets.get().createSecretsPageState(...args)
export const secretsPageKey: SecretsMod["secretsPageKey"] = (...args) => secrets.get().secretsPageKey(...args)
export const secretsRevealed: SecretsMod["secretsRevealed"] = (...args) => secrets.get().secretsRevealed(...args)
export const renderSecretsPage: SecretsMod["renderSecretsPage"] = (...args) => secrets.get().renderSecretsPage(...args)

type StorageMod =typeof import("../view/storage-page")
export const createStoragePageState: StorageMod["createStoragePageState"] = (...args) => storage.get().createStoragePageState(...args)
export const formatBytes: StorageMod["formatBytes"] = (...args) => storage.get().formatBytes(...args)
export const renderStoragePage: StorageMod["renderStoragePage"] = (...args) => storage.get().renderStoragePage(...args)
export const storageConfirmClean: StorageMod["storageConfirmClean"] = (...args) => storage.get().storageConfirmClean(...args)
export const storageNote: StorageMod["storageNote"] = (...args) => storage.get().storageNote(...args)
export const storagePageKey: StorageMod["storagePageKey"] = (...args) => storage.get().storagePageKey(...args)

type AgentsMod = typeof import("../view/agents-page")
export const agentsPageKey: AgentsMod["agentsPageKey"] = (...args) => agents.get().agentsPageKey(...args)
export const createAgentsPageState: AgentsMod["createAgentsPageState"] = (...args) => agents.get().createAgentsPageState(...args)
export const renderAgentsPage: AgentsMod["renderAgentsPage"] = (...args) => agents.get().renderAgentsPage(...args)

type WorkflowsMod = typeof import("../view/workflows-page")
export const createWorkflowsPageState: WorkflowsMod["createWorkflowsPageState"] = (...args) => workflows.get().createWorkflowsPageState(...args)
export const workflowsPageKey: WorkflowsMod["workflowsPageKey"] = (...args) => workflows.get().workflowsPageKey(...args)
export const renderWorkflowsPage: WorkflowsMod["renderWorkflowsPage"] = (...args) => workflows.get().renderWorkflowsPage(...args)
/** Only meaningful on the workflows page, which is loaded by then; false before that. */
export const workflowsNeedTick: WorkflowsMod["needsTick"] = (...args) => (workflows.loaded() ? workflows.get().needsTick(...args) : false)
type WorkflowCommandMod = typeof import("../view/workflow-command")
export const parseWorkflowCommand: WorkflowCommandMod["parseWorkflowCommand"] = (...args) => workflowCommand.get().parseWorkflowCommand(...args)
type LoopsMod = typeof import("../view/loops-page")
export const createLoopsPageState: LoopsMod["createLoopsPageState"] = (...args) => loops.get().createLoopsPageState(...args)
export const loopsPageKey: LoopsMod["loopsPageKey"] = (...args) => loops.get().loopsPageKey(...args)
export const renderLoopsPage: LoopsMod["renderLoopsPage"] = (...args) => loops.get().renderLoopsPage(...args)
/** Only meaningful on the loops page, which is loaded by then; false before that. */
export const needsTick: LoopsMod["needsTick"] = (...args) => (loops.loaded() ? loops.get().needsTick(...args) : false)

type LoopCommandMod = typeof import("../view/loop-command")
export const parseLoopCommand: LoopCommandMod["parseLoopCommand"] = (...args) => loopCommand.get().parseLoopCommand(...args)

type SetupMod = typeof import("../view/setup-page")
export const createSetupPageState: SetupMod["createSetupPageState"] = (...args) => setup.get().createSetupPageState(...args)
export const renderSetupPage: SetupMod["renderSetupPage"] = (...args) => setup.get().renderSetupPage(...args)
export const setupPageKey: SetupMod["setupPageKey"] = (...args) => setup.get().setupPageKey(...args)

type OnboardingMod = typeof import("../view/onboarding-page")
export const createOnboardingState: OnboardingMod["createOnboardingState"] = (...args) => onboarding.get().createOnboardingState(...args)
export const onboardingKey: OnboardingMod["onboardingKey"] = (...args) => onboarding.get().onboardingKey(...args)
export const renderOnboardingPage: OnboardingMod["renderOnboardingPage"] = (...args) => onboarding.get().renderOnboardingPage(...args)
export const onboardingText: OnboardingMod["onboardingText"] = (...args) => onboarding.get().onboardingText(...args)
export const detectReady: typeof import("../view/onboarding-detect").detectReady = (...args) => onboardingDetect.get().detectReady(...args)

type CustomizeMod = typeof import("../view/customize-page")
export const customizeRow = (field: string) => customize.get().CUSTOMIZE_ROWS.indexOf(field as CustomizeMod["CUSTOMIZE_ROWS"][number])
export const renderStashPage: typeof import("../view/stash-page").renderStashPage = (...args) => stash.get().renderStashPage(...args)
export const renderDraftsPage: typeof import("../view/stash-page").renderDraftsPage = (...args) => stash.get().renderDraftsPage(...args)
export const renderQueuePage: typeof import("../view/queue-page").renderQueuePage = (...args) => queuePage.get().renderQueuePage(...args)
export const createQueuePageState: typeof import("../view/queue-page").createQueuePageState = (...args) => queuePage.get().createQueuePageState(...args)
export const createCustomizePageState: CustomizeMod["createCustomizePageState"] = (...args) => customize.get().createCustomizePageState(...args)
export const customizePageKey: CustomizeMod["customizePageKey"] = (...args) => customize.get().customizePageKey(...args)
export const renderCustomizePage: CustomizeMod["renderCustomizePage"] = (...args) => customize.get().renderCustomizePage(...args)

type SettingsMod = typeof import("../view/settings-page")
export const createSettingsPageState: SettingsMod["createSettingsPageState"] = (...args) => settings.get().createSettingsPageState(...args)
export const settingsPageKey: SettingsMod["settingsPageKey"] = (...args) => settings.get().settingsPageKey(...args)
export const renderSettingsPage: SettingsMod["renderSettingsPage"] = (...args) => settings.get().renderSettingsPage(...args)

type StatusMod = typeof import("../view/status-page")
export const createStatusPageState: StatusMod["createStatusPageState"] = (...args) => status.get().createStatusPageState(...args)
export const statusPageKey: StatusMod["statusPageKey"] = (...args) => status.get().statusPageKey(...args)
export const renderStatusPage: StatusMod["renderStatusPage"] = (...args) => status.get().renderStatusPage(...args)

type FileViewerMod = typeof import("../view/file-viewer")
export const renderFileViewer: FileViewerMod["renderFileViewer"] = (...args) => fileViewer.get().renderFileViewer(...args)

type ExtensionsPageMod = typeof import("../view/extensions-page")
export const createExtensionsPageState: ExtensionsPageMod["createExtensionsPageState"] = (...args) => extensionsPage.get().createExtensionsPageState(...args)
export const extensionItems: ExtensionsPageMod["extensionItems"] = (...args) => extensionsPage.get().extensionItems(...args)
export const extensionsPageKey: ExtensionsPageMod["extensionsPageKey"] = (...args) => extensionsPage.get().extensionsPageKey(...args)
export const renderExtensionsPage: ExtensionsPageMod["renderExtensionsPage"] = (...args) => extensionsPage.get().renderExtensionsPage(...args)

type HooksPageMod = typeof import("../view/hooks-page")
export const createHooksPageState: HooksPageMod["createHooksPageState"] = (...args) => hooksPage.get().createHooksPageState(...args)
export const hooksPageKey: HooksPageMod["hooksPageKey"] = (...args) => hooksPage.get().hooksPageKey(...args)
export const renderHooksPage: HooksPageMod["renderHooksPage"] = (...args) => hooksPage.get().renderHooksPage(...args)

type SessionTreeMod = typeof import("../view/session-tree-page")
export const buildTree: SessionTreeMod["buildTree"] = (...args) => sessionTree.get().buildTree(...args)
export const treeRows: SessionTreeMod["treeRows"] = (...args) => sessionTree.get().treeRows(...args)
export const createTreeState: SessionTreeMod["createTreeState"] = (...args) => sessionTree.get().createTreeState(...args)
export const settle: SessionTreeMod["settle"] = (...args) => sessionTree.get().settle(...args)
export const treeKey: SessionTreeMod["treeKey"] = (...args) => sessionTree.get().treeKey(...args)
export const renderTreePage: SessionTreeMod["renderTreePage"] = (...args) => sessionTree.get().renderTreePage(...args)

type TextPageMod = typeof import("../view/text-page")
export const createTextPageState: TextPageMod["createTextPageState"] = (...args) => textPage.get().createTextPageState(...args)
export const textPageRows: TextPageMod["textPageRows"] = (...args) => textPage.get().textPageRows(...args)
export const textPageKey: TextPageMod["textPageKey"] = (...args) => textPage.get().textPageKey(...args)
export const textPageViewport: TextPageMod["textPageViewport"] = (...args) => textPage.get().textPageViewport(...args)
export const renderTextPage: TextPageMod["renderTextPage"] = (...args) => textPage.get().renderTextPage(...args)

type PermissionsMod = typeof import("../view/permissions-page")
export const createPermissionsPageState: PermissionsMod["createPermissionsPageState"] = (...args) => permissions.get().createPermissionsPageState(...args)
export const permissionsPageKey: PermissionsMod["permissionsPageKey"] = (...args) => permissions.get().permissionsPageKey(...args)
export const renderPermissionsPage: PermissionsMod["renderPermissionsPage"] = (...args) => permissions.get().renderPermissionsPage(...args)
export const reviewerStatus: PermissionsMod["reviewerStatus"] = (...args) => permissions.get().reviewerStatus(...args)

type DiagramMod = typeof import("../view/mermaid-viewer")
export const createDiagramView: DiagramMod["createDiagramView"] = (...args) => diagram.get().createDiagramView(...args)
export const diagramBounds: DiagramMod["diagramBounds"] = (...args) => diagram.get().diagramBounds(...args)
export const diagramViewKey: DiagramMod["diagramViewKey"] = (...args) => diagram.get().diagramViewKey(...args)
export const layoutDiagram: DiagramMod["layoutDiagram"] = (...args) => diagram.get().layoutDiagram(...args)
export const renderDiagramView: DiagramMod["renderDiagramView"] = (...args) => diagram.get().renderDiagramView(...args)
export const transcriptDiagrams: DiagramMod["transcriptDiagrams"] = (...args) => diagram.get().transcriptDiagrams(...args)

type PaletteMod = typeof import("../view/palette")
export const composeOverlay: PaletteMod["composeOverlay"] = (...args) => palette.get().composeOverlay(...args)
export const createPaletteState: PaletteMod["createPaletteState"] = (...args) => palette.get().createPaletteState(...args)
export const paletteKey: PaletteMod["paletteKey"] = (...args) => palette.get().paletteKey(...args)
export const filterPalette: PaletteMod["filterPalette"] = (...args) => palette.get().filterPalette(...args)
export const renderPalette: PaletteMod["renderPalette"] = (...args) => palette.get().renderPalette(...args)

type ApprovalMod = typeof import("../view/approval-diff")
/** Approvals fall back to plain text until the module is loaded (the app preloads it on the first request). */
export const approvalWindow: ApprovalMod["approvalWindow"] = (...args) => approvalDiff.get().approvalWindow(...args)
export const renderApprovalDiff: ApprovalMod["renderApprovalDiff"] = (...args) => (approvalDiff.loaded() ? approvalDiff.get().renderApprovalDiff(...args) : undefined)
export const splitApprovalDetail: ApprovalMod["splitApprovalDetail"] = (...args) => (approvalDiff.loaded() ? approvalDiff.get().splitApprovalDetail(...args) : undefined)
export const parseApprovalReview: ApprovalMod["parseApprovalReview"] = (...args) => (approvalDiff.loaded() ? approvalDiff.get().parseApprovalReview(...args) : { detail: args[0] })
export const approvalReviewRows: ApprovalMod["approvalReviewRows"] = (...args) => (approvalDiff.loaded() ? approvalDiff.get().approvalReviewRows(...args) : [])

type AgentPickerMod = typeof import("../view/agent-picker")
export const createAgentPickerState: AgentPickerMod["createAgentPickerState"] = (...args) => agentPicker.get().createAgentPickerState(...args)
export const agentPickerKey: AgentPickerMod["agentPickerKey"] = (...args) => agentPicker.get().agentPickerKey(...args)
export const renderAgentPicker: AgentPickerMod["renderAgentPicker"] = (...args) => agentPicker.get().renderAgentPicker(...args)

type ThemePickerMod = typeof import("../view/theme-picker")
export const createThemePickerState: ThemePickerMod["createThemePickerState"] = (...args) => themePicker.get().createThemePickerState(...args)
export const themeEntries: ThemePickerMod["themeEntries"] = (...args) => themePicker.get().themeEntries(...args)
export const themeIndex: ThemePickerMod["themeIndex"] = (...args) => themePicker.get().themeIndex(...args)
export const renderThemePicker: ThemePickerMod["renderThemePicker"] = (...args) => themePicker.get().renderThemePicker(...args)

type AcpMod = typeof import("../view/acp-page")
export const createAcpPageState: AcpMod["createAcpPageState"] = (...args) => acp.get().createAcpPageState(...args)
export const acpPageKey: AcpMod["acpPageKey"] = (...args) => acp.get().acpPageKey(...args)
export const renderAcpPage: AcpMod["renderAcpPage"] = (...args) => acp.get().renderAcpPage(...args)

export const renderSidebarEditor: typeof import("../view/sidebar-editor").renderSidebarEditor = (...args) => sidebar.get().renderSidebarEditor(...args)

type HistoryMod = typeof import("../view/history-page")
export const createHistoryState: HistoryMod["createHistoryState"] = (...args) => history.get().createHistoryState(...args)
export const historyTurns: HistoryMod["historyTurns"] = (...args) => history.get().historyTurns(...args)
export const historyReaderRows: typeof import("../view/history-page").historyReaderRows = (...args) => history.get().historyReaderRows(...args)
export const renderHistoryPage: HistoryMod["renderHistoryPage"] = (...args) => history.get().renderHistoryPage(...args)
type SkillsMod = typeof import("../view/skills-page")
export const createSkillsState: SkillsMod["createSkillsState"] = (...args) => skills.get().createSkillsState(...args)
export const skillOptions: SkillsMod["skillOptions"] = (...args) => skills.get().skillOptions(...args)
export const renderSkillsPage: SkillsMod["renderSkillsPage"] = (...args) => skills.get().renderSkillsPage(...args)
type PickerMod = typeof import("../view/model-picker")
export const createModelPickerState: PickerMod["createModelPickerState"] = (...args) => modelPicker.get().createModelPickerState(...args)
export const modelOptions: PickerMod["modelOptions"] = (...args) => modelPicker.get().modelOptions(...args)
export const renderModelPicker: PickerMod["renderModelPicker"] = (...args) => modelPicker.get().renderModelPicker(...args)
export const variantOptions: PickerMod["variantOptions"] = (...args) => modelPicker.get().variantOptions(...args)
export const renderVariantPicker: PickerMod["renderVariantPicker"] = (...args) => modelPicker.get().renderVariantPicker(...args)
type QuickMod = typeof import("../view/model-quick")
export const createModelQuickState: QuickMod["createModelQuickState"] = (...args) => modelQuick.get().createModelQuickState(...args)
export const renderModelQuick: QuickMod["renderModelQuick"] = (...args) => modelQuick.get().renderModelQuick(...args)
export const quickChoice: QuickMod["quickChoice"] = (...args) => modelQuick.get().quickChoice(...args)
export const stepQuickValue: QuickMod["stepQuickValue"] = (...args) => modelQuick.get().stepQuickValue(...args)

export const renderMemoryAssistant: MemoryMod["renderMemoryAssistant"] = (...args) => memory.get().renderMemoryAssistant(...args)
export const memoryAssistantCursor: MemoryMod["memoryAssistantCursor"] = (...args) => memory.get().memoryAssistantCursor(...args)
export const visibleMemories: MemoryMod["visibleMemories"] = (...args) => memory.get().visibleMemories(...args)

type TranscriptActionsMod = typeof import("../view/transcript-actions-page")
export const EXPORT_FIELDS: TranscriptActionsMod["EXPORT_FIELDS"] = ["filename", "format", "reasoning", "toolDetails", "assistantMetadata", "timestamps", "destination", "openEditor", "sanitize"]
export const messageEntries: TranscriptActionsMod["messageEntries"] = (...args) => transcriptActions.get().messageEntries(...args)
export const renderMessageActions: TranscriptActionsMod["renderMessageActions"] = (...args) => transcriptActions.get().renderMessageActions(...args)
export const renderExportOptions: TranscriptActionsMod["renderExportOptions"] = (...args) => transcriptActions.get().renderExportOptions(...args)

export const renderPlanReviewPage: typeof import("../view/plan-review-page")["renderPlanReviewPage"] = (...args) => planReview.loaded() ? planReview.get().renderPlanReviewPage(...args) : { rows: [] }
export const createPromptModeState: typeof import("../view/prompt-mode-page").createPromptModeState = (...args) => promptMode.get().createPromptModeState(...args)
export const renderPromptModePage: typeof import("../view/prompt-mode-page").renderPromptModePage = (...args) => promptMode.get().renderPromptModePage(...args)

/** The live compaction panel and its arcade: loaded by `preload("compactionLive" | "compactionArcade")` when a compaction starts. */
type CompactionLiveMod = typeof import("../view/compaction-live")
type CompactionArcadeMod = typeof import("../view/compaction-arcade")
export const renderLiveCompaction: CompactionLiveMod["renderLiveCompaction"] = (...args) => compactionLive.get().renderLiveCompaction(...args)
export const liveRowsNeeded: CompactionLiveMod["liveRowsNeeded"] = (...args) => compactionLive.get().liveRowsNeeded(...args)
export const arcadeInput: CompactionArcadeMod["arcadeInput"] = (...args) => compactionArcade.get().arcadeInput(...args)
export const pickGame: CompactionArcadeMod["pickGame"] = (...args) => compactionArcade.get().pickGame(...args)
export const startArcade: CompactionArcadeMod["startArcade"] = (...args) => compactionArcade.get().startArcade(...args)
export const advanceArcade: CompactionArcadeMod["advanceArcade"] = (...args) => compactionArcade.get().advanceArcade(...args)
export const arcadeField: CompactionArcadeMod["arcadeField"] = (...args) => compactionArcade.get().arcadeField(...args)
export const renderCompactionPage: typeof import("../view/compaction-page").renderCompactionPage = (...args) => compaction.get().renderCompactionPage(...args)
type PeerCommandsMod = typeof import("../view/agent-commands-page")
export const renderAgentCommandsPage: PeerCommandsMod["renderAgentCommandsPage"] = (...args) => peerCommands.get().renderAgentCommandsPage(...args)
export const renderDiagnosticsPage: typeof import("../view/diagnostics-page").renderDiagnosticsPage = (...args) => diagnostics.get().renderDiagnosticsPage(...args)
export const renderWorktreesPage: typeof import("../view/worktrees-page").renderWorktreesPage = (...args) => worktrees.get().renderWorktreesPage(...args)
type GitPageMod = typeof import("../view/git-page")
export const gitTabsRow: GitPageMod["gitTabsRow"] = (...args) => gitPage.get().gitTabsRow(...args)
export const gitTabHits: GitPageMod["gitTabHits"] = (...args) => gitPage.get().gitTabHits(...args)
type GitCommitMod = typeof import("../view/git-commit-page")
export const createGitCommitState: GitCommitMod["createGitCommitState"] = (...args) => gitCommitPage.get().createGitCommitState(...args)
export const gitCommitKey: GitCommitMod["gitCommitKey"] = (...args) => gitCommitPage.get().gitCommitKey(...args)
export const gitCommitReport: GitCommitMod["gitCommitReport"] = (...args) => gitCommitPage.get().gitCommitReport(...args)
export const gitCommitSelection: GitCommitMod["gitCommitSelection"] = (...args) => gitCommitPage.get().gitCommitSelection(...args)
export const renderGitCommitPage: GitCommitMod["renderGitCommitPage"] = (...args) => gitCommitPage.get().renderGitCommitPage(...args)
type GitPrMod = typeof import("../view/git-pr-page")
export const createGitPrState: GitPrMod["createGitPrState"] = (...args) => gitPrPage.get().createGitPrState(...args)
export const gitPrKey: GitPrMod["gitPrKey"] = (...args) => gitPrPage.get().gitPrKey(...args)
export const gitPrTyping: GitPrMod["gitPrTyping"] = (...args) => gitPrPage.get().gitPrTyping(...args)
export const gitPrLinkRow: GitPrMod["gitPrLinkRow"] = (...args) => gitPrPage.get().gitPrLinkRow(...args)
export const gitPrPublishHit: GitPrMod["gitPrPublishHit"] = (...args) => gitPrPage.get().gitPrPublishHit(...args)
export const renderGitPrPage: GitPrMod["renderGitPrPage"] = (...args) => gitPrPage.get().renderGitPrPage(...args)
type GitInitMod = typeof import("../view/git-init-page")
export const createGitInitState: GitInitMod["createGitInitState"] = (...args) => gitInitPage.get().createGitInitState(...args)
export const gitInitKey: GitInitMod["gitInitKey"] = (...args) => gitInitPage.get().gitInitKey(...args)
export const gitInitHit: GitInitMod["gitInitHit"] = (...args) => gitInitPage.get().gitInitHit(...args)
export const renderGitInitPage: GitInitMod["renderGitInitPage"] = (...args) => gitInitPage.get().renderGitInitPage(...args)

export const renderAutomationLedger: typeof import("../view/automation-ledger-page")["renderAutomationLedger"] = (...args) => automationLedger.get().renderAutomationLedger(...args)
export const renderCompoundPage: typeof import("../view/compound-page").renderCompoundPage = (...args) => compound.get().renderCompoundPage(...args)

type MarketplaceMod = typeof import("../view/marketplace-page")
export const createMarketplaceState: MarketplaceMod["createMarketplaceState"] = (...args) => marketplace.get().createMarketplaceState(...args)
export const catalogMatches: MarketplaceMod["catalogMatches"] = (...args) => marketplace.get().catalogMatches(...args)
export const renderMarketplacePage: MarketplaceMod["renderMarketplacePage"] = (...args) => marketplace.get().renderMarketplacePage(...args)

export const renderIntroPage: SetupMod["renderIntroPage"] = (...args) => setup.get().renderIntroPage(...args)
export const renderAIConfigPage: typeof import("../view/ai-config-page").renderAIConfigPage = (...args) => aiConfig.get().renderAIConfigPage(...args)
export const renderReasoningPage: typeof import("../view/reasoning-page").renderReasoningPage = (...args) => reasoning.get().renderReasoningPage(...args)

export const renderReleasePage: typeof import("../view/release-page").renderReleasePage = (...args) => release.get().renderReleasePage(...args)
export const renderTsmPage: typeof import("../view/tsm-page").renderTsmPage = (...args) => tsm.get().renderTsmPage(...args)
export const renderIdePage: typeof import("../view/ide-page").renderIdePage = (...args) => ide.get().renderIdePage(...args)
type MflowMod = typeof import("../view/mflow-page")
export const renderMflowPage: MflowMod["renderMflowPage"] = (...args) => mflow.get().renderMflowPage(...args)

type ConsoleMod = typeof import("../view/console-page")
export const renderConsolePage: ConsoleMod["renderConsolePage"] = (...args) => console.get().renderConsolePage(...args)
export const renderSharePage: ConsoleMod["renderSharePage"] = (...args) => console.get().renderSharePage(...args)

export const createKeymapState: typeof import("../view/keymap-page").createKeymapState = (...args) => keymap.get().createKeymapState(...args)
export const keymapRows: typeof import("../view/keymap-page").keymapRows = (...args) => keymap.get().keymapRows(...args)
export const filterKeymapRows: typeof import("../view/keymap-page").filterKeymapRows = (...args) => keymap.get().filterKeymapRows(...args)
export const specFromKey: typeof import("../view/keymap-page").specFromKey = (...args) => keymap.get().specFromKey(...args)
export const chordFromKey: typeof import("../view/keymap-page").chordFromKey = (...args) => keymap.get().chordFromKey(...args)
export const keyHolder: typeof import("../view/keymap-page").keyHolder = (...args) => keymap.get().keyHolder(...args)
export const resetEntries: typeof import("../view/keymap-page").resetEntries = (...args) => keymap.get().resetEntries(...args)
export const renderKeymapPage: typeof import("../view/keymap-page").renderKeymapPage = (...args) => keymap.get().renderKeymapPage(...args)
export const createTerminalSetupState: typeof import("../view/terminal-setup-page").createTerminalSetupState = (...args) => terminalSetup.get().createTerminalSetupState(...args)
export const detectTerminal: typeof import("../view/terminal-setup-page").detectTerminal = (...args) => terminalSetup.get().detectTerminal(...args)
export const terminalGuides: typeof import("../view/terminal-setup-page").terminalGuides = (...args) => terminalSetup.get().terminalGuides(...args)
export const configLines: typeof import("../view/terminal-setup-page").configLines = (...args) => terminalSetup.get().configLines(...args)
export const optionNotice: typeof import("../view/terminal-setup-page").optionNotice = (...args) => terminalSetup.get().optionNotice(...args)
export const renderTerminalSetupPage: typeof import("../view/terminal-setup-page").renderTerminalSetupPage = (...args) => terminalSetup.get().renderTerminalSetupPage(...args)
export const renderTutorialPage: typeof import("../view/tutorial-page").renderTutorialPage = (...args) => tutorial.get().renderTutorialPage(...args)
export const createTour: typeof import("../tutorial/tour").createTour = (...args) => tutorialTour.get().createTour(...args)
export const createSandbox: typeof import("../tutorial/sandbox").createSandbox = (...args) => tutorialSandbox.get().createSandbox(...args)
