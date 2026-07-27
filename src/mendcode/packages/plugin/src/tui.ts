export {
  asciiGraphCellToWorld,
  asciiGraphNearestNode,
  asciiGraphRuns,
  asciiGraphWithNodePosition,
  layoutAsciiGraph,
  renderAsciiGraph,
  type AsciiGraphCell,
  type AsciiGraphCellKind,
  type AsciiGraphEdge,
  type AsciiGraphFrame,
  type AsciiGraphLabelMode,
  type AsciiGraphLayoutNode,
  type AsciiGraphMarker,
  type AsciiGraphNode,
  type AsciiGraphPoint,
  type AsciiGraphRun,
  type AsciiGraphScene,
  type AsciiGraphViewport,
} from "./ascii-graph.js"

import type {
  AgentPart,
  OpencodeClient,
  Event,
  FilePart,
  LspStatus,
  McpStatus,
  Todo,
  Message,
  Part,
  Provider,
  PermissionRequest,
  QuestionRequest,
  SessionStatus,
  TextPart,
  Config as SdkConfig,
} from "@mendcode/sdk/v2"
import type { CliRenderer, ParsedKey, RGBA, SlotMode } from "@opentui/core"
import type { JSX, SolidPlugin } from "@opentui/solid"
import type { Config as PluginConfig, PluginOptions } from "./index.js"

export type { CliRenderer, SlotMode } from "@opentui/core"

export type TuiRouteCurrent =
  | {
      name: "home"
    }
  | {
      name: "session"
      params: {
        sessionID: string
        prompt?: unknown
      }
    }
  | {
      name: string
      params?: Record<string, unknown>
    }

export type TuiRouteDefinition = {
  name: string
  render: (input: { params?: Record<string, unknown> }) => JSX.Element
}

export type TuiCommand = {
  title: string
  value: string
  description?: string
  category?: string
  keybind?: string
  suggested?: boolean
  hidden?: boolean
  enabled?: boolean
  slash?: {
    name: string
    aliases?: string[]
  }
  onSelect?: () => void
}

export type TuiKeybind = {
  name: string
  ctrl: boolean
  meta: boolean
  shift: boolean
  super?: boolean
  leader: boolean
}

export type TuiKeybindMap = Record<string, string>

export type TuiKeybindSet = {
  readonly all: TuiKeybindMap
  get: (name: string) => string
  match: (name: string, evt: ParsedKey) => boolean
  print: (name: string) => string
}

export type TuiDialogSize = "medium" | "large" | "xlarge" | "command"

export type TuiDialogProps = {
  size?: TuiDialogSize
  onClose: () => void
  children?: JSX.Element
}

export type TuiDialogStack = {
  replace: (render: () => JSX.Element, onClose?: () => void) => void
  clear: () => void
  setSize: (size: TuiDialogSize) => void
  readonly size: TuiDialogSize
  readonly depth: number
  readonly open: boolean
}

export type TuiDialogAlertProps = {
  title: string
  message: string
  onConfirm?: () => void
}

export type TuiDialogConfirmProps = {
  title: string
  message: string
  onConfirm?: () => void
  onCancel?: () => void
}

export type TuiDialogPromptProps = {
  title: string
  description?: () => JSX.Element
  placeholder?: string
  value?: string
  busy?: boolean
  busyText?: string
  onConfirm?: (value: string) => void
  onCancel?: () => void
}

export type TuiDialogSelectOption<Value = unknown> = {
  title: string
  value: Value
  description?: string
  footer?: JSX.Element | string
  category?: string
  disabled?: boolean
  onSelect?: () => void
}

export type TuiDialogSelectProps<Value = unknown> = {
  title: string
  placeholder?: string
  options: TuiDialogSelectOption<Value>[]
  flat?: boolean
  onMove?: (option: TuiDialogSelectOption<Value>) => void
  onFilter?: (query: string) => void
  onSelect?: (option: TuiDialogSelectOption<Value>) => void
  skipFilter?: boolean
  current?: Value
}

export type TuiPromptInfo = {
  input: string
  mode?: "normal" | "shell"
  parts: (
    | Omit<FilePart, "id" | "messageID" | "sessionID">
    | Omit<AgentPart, "id" | "messageID" | "sessionID">
    | (Omit<TextPart, "id" | "messageID" | "sessionID"> & {
        source?: {
          text: {
            start: number
            end: number
            value: string
          }
        }
      })
  )[]
}

export type TuiPromptRef = {
  focused: boolean
  current: TuiPromptInfo
  set(prompt: TuiPromptInfo): void
  reset(): void
  blur(): void
  focus(): void
  submit(): void
}

export type TuiPromptProps = {
  sessionID?: string
  workspaceID?: string
  visible?: boolean
  disabled?: boolean
  onSubmit?: () => void
  ref?: (ref: TuiPromptRef | undefined) => void
  hint?: JSX.Element
  right?: JSX.Element
  showPlaceholder?: boolean
  placeholders?: {
    normal?: string[]
    shell?: string[]
  }
}

export type TuiToast = {
  variant?: "info" | "success" | "warning" | "error"
  title?: string
  message: string
  duration?: number
}

export type TuiThemeCurrent = {
  readonly primary: RGBA
  readonly secondary: RGBA
  readonly accent: RGBA
  readonly error: RGBA
  readonly warning: RGBA
  readonly success: RGBA
  readonly info: RGBA
  readonly text: RGBA
  readonly textMuted: RGBA
  readonly selectedListItemText: RGBA
  readonly background: RGBA
  readonly backgroundPanel: RGBA
  readonly backgroundElement: RGBA
  readonly backgroundMenu: RGBA
  readonly border: RGBA
  readonly borderActive: RGBA
  readonly borderSubtle: RGBA
  readonly diffAdded: RGBA
  readonly diffRemoved: RGBA
  readonly diffContext: RGBA
  readonly diffHunkHeader: RGBA
  readonly diffHighlightAdded: RGBA
  readonly diffHighlightRemoved: RGBA
  readonly diffAddedBg: RGBA
  readonly diffRemovedBg: RGBA
  readonly diffContextBg: RGBA
  readonly diffLineNumber: RGBA
  readonly diffAddedLineNumberBg: RGBA
  readonly diffRemovedLineNumberBg: RGBA
  readonly markdownText: RGBA
  readonly markdownHeading: RGBA
  readonly markdownLink: RGBA
  readonly markdownLinkText: RGBA
  readonly markdownCode: RGBA
  readonly markdownBlockQuote: RGBA
  readonly markdownEmph: RGBA
  readonly markdownStrong: RGBA
  readonly markdownHorizontalRule: RGBA
  readonly markdownListItem: RGBA
  readonly markdownListEnumeration: RGBA
  readonly markdownImage: RGBA
  readonly markdownImageText: RGBA
  readonly markdownCodeBlock: RGBA
  readonly syntaxComment: RGBA
  readonly syntaxKeyword: RGBA
  readonly syntaxFunction: RGBA
  readonly syntaxVariable: RGBA
  readonly syntaxString: RGBA
  readonly syntaxNumber: RGBA
  readonly syntaxType: RGBA
  readonly syntaxOperator: RGBA
  readonly syntaxPunctuation: RGBA
  readonly thinkingOpacity: number
}

export type TuiTheme = {
  readonly current: TuiThemeCurrent
  readonly selected: string
  has: (name: string) => boolean
  set: (name: string) => boolean
  install: (jsonPath: string) => Promise<void>
  mode: () => "dark" | "light"
  readonly ready: boolean
}

export type TuiKV = {
  get: <Value = unknown>(key: string, fallback?: Value) => Value
  set: (key: string, value: unknown) => void
  readonly ready: boolean
}

export type TuiWidgetPlacement = "aboveEditor" | "belowEditor" | "sessionBottomDock"

export type TuiWidgetSize = number | "auto"

export type TuiWidgetRenderContext = {
  requestRender: () => void
  maxFps: number
}

export type TuiWidgetOptions = {
  placement?: TuiWidgetPlacement
  order?: number
  title?: string
  width?: TuiWidgetSize
  minWidth?: number
  maxWidth?: number
  height?: TuiWidgetSize
  interactive?: boolean
  onVisible?: () => boolean | void
  onFocus?: () => boolean | void
  onKey?: (event: ParsedKey) => boolean | void
  maxFps?: number
  requestRender?: () => void
  dispose?: TuiDispose
}

export type TuiOverlayAnchor =
  | "top-center"
  | "center"
  | "bottom-center"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right"
export type TuiOverlaySize = number | `${number}%` | "auto"
export type TuiOverlayRenderContext = {
  /** Close the overlay that owns this render context. */
  close: () => boolean
  /** Focus the overlay that owns this render context. */
  focus: () => boolean
  /** Remove focus from the overlay that owns this render context. */
  blur: () => boolean
  /** Whether the overlay that owns this render context currently has focus. */
  focused: () => boolean
  /** Request a TUI render when plugin-local overlay state changes outside Solid signals. */
  requestRender: () => void
}
export type TuiOverlayOptions = {
  anchor?: TuiOverlayAnchor
  width?: TuiOverlaySize
  height?: TuiOverlaySize
  maxHeight?: TuiOverlaySize
  margin?: {
    top?: number
    right?: number
    bottom?: number
    left?: number
  }
  nonCapturing?: boolean
  modal?: boolean
  allowStack?: boolean
  title?: string
  onFocus?: () => boolean | void
  onClose?: TuiDispose
  requestRender?: () => void
}
export type TuiOverlayApi = {
  /** Open or replace a plugin-owned floating overlay. Runtime plugins clean open overlays on dispose. */
  open: (
    id: string,
    render: (context: TuiOverlayRenderContext) => JSX.Element | string | number | null,
    options?: TuiOverlayOptions,
  ) => boolean
  /** Close a plugin-owned floating overlay by ID. */
  close: (id: string) => boolean
  /** Focus a capturable plugin-owned overlay by ID. */
  focus: (id: string) => boolean
  /** Blur a plugin-owned overlay. Without an ID, blur whichever overlay is focused. */
  blur: (id?: string) => boolean
  /** Read the currently focused overlay ID, if any. */
  focused: () => string | undefined
}

export type TuiCompactionArcadeRender = {
  title?: string
  status?: string
  lines?: string[]
  cells?: TuiCompactionArcadeCell[][]
}

export type TuiCompactionArcadeCellTone =
  | "primary"
  | "muted"
  | "text"
  | "wall"
  | "empty"
  | "head"
  | "body"
  | "food"
  | "danger"
  | "accent"

export type TuiCompactionArcadeCell = {
  text: string
  tone?: TuiCompactionArcadeCellTone
}

export type TuiCompactionArcadeGame<State = unknown> = {
  id: string
  label: string
  intervalMs?: number
  initialState: () => State
  tick?: (state: State) => State
  key?: (state: State, key: string) => State | undefined
  render: (state: State) => TuiCompactionArcadeRender
}

export type TuiSessionAccent = "theme" | "random" | `#${string}`

export type TuiCustomization = {
  contextBar: boolean
  diffCount: boolean
  diffFiles: boolean
  sessionTitle: boolean
  projectPath: boolean
  terminalTitle: boolean
  sessionAccent: TuiSessionAccent
  terminalTitleTemplate: string
}

export type TuiCustomizationApi = {
  get: () => TuiCustomization
  set: (patch: Partial<TuiCustomization>) => TuiCustomization
  reset: () => TuiCustomization
  setTerminalTitle: (input?: { enabled?: boolean; template?: string }) => TuiCustomization
  setSessionAccent: (accent: TuiSessionAccent) => TuiCustomization
  setDiffFiles: (visible: boolean) => TuiCustomization
}

export type TuiRuntimeApi = {
  customization: TuiCustomizationApi
  setStatus: (id: string, value?: string, input?: { order?: number }) => boolean
  clearStatus: (id: string) => boolean
  setWidget: (
    id: string,
    render?: ((context: TuiWidgetRenderContext) => JSX.Element | null) | undefined,
    input?: TuiWidgetOptions,
  ) => boolean
  clearWidget: (id: string) => boolean
  focusWidget: (id: string) => boolean
  blurWidget: (id?: string) => boolean
  setFooter: (renderer?: (() => JSX.Element | null) | undefined) => boolean
  setFooterEntry: (id: string, render?: (() => JSX.Element | null) | undefined, input?: { order?: number }) => boolean
  setWorkingIndicator: (input?: { frames?: string[]; intervalMs?: number; visible?: boolean }) => boolean
  registerCompactionArcadeGame: (game: TuiCompactionArcadeGame) => boolean
  clearCompactionArcadeGame: (id: string) => boolean
  setEditorVisual: (input?: {
    showPlaceholder?: boolean
    normalPrefix?: string
    shellPrefix?: string
    normalExamples?: string[]
    shellExamples?: string[]
    borderGlyph?: string
    footerGlyph?: string
  }) => boolean
  setEditor: (
    factory?:
      | ((input: {
          sessionID?: string
          workspaceID?: string
          visible?: boolean
          disabled?: boolean
          onSubmit?: () => void
          right?: JSX.Element
          defaultEditor: () => JSX.Element
        }) => JSX.Element | null)
      | undefined,
  ) => boolean
}

export type TuiState = {
  readonly ready: boolean
  readonly config: SdkConfig
  readonly provider: ReadonlyArray<Provider>
  readonly path: {
    state: string
    config: string
    worktree: string
    directory: string
  }
  readonly vcs: { branch?: string } | undefined
  session: {
    count: () => number
    diff: (sessionID: string) => ReadonlyArray<TuiSidebarFileItem>
    todo: (sessionID: string) => ReadonlyArray<TuiSidebarTodoItem>
    messages: (sessionID: string) => ReadonlyArray<Message>
    status: (sessionID: string) => SessionStatus | undefined
    permission: (sessionID: string) => ReadonlyArray<PermissionRequest>
    question: (sessionID: string) => ReadonlyArray<QuestionRequest>
  }
  part: (messageID: string) => ReadonlyArray<Part>
  lsp: () => ReadonlyArray<TuiSidebarLspItem>
  mcp: () => ReadonlyArray<TuiSidebarMcpItem>
}

type TuiConfigView = Pick<PluginConfig, "$schema" | "theme" | "keybinds" | "plugin"> &
  NonNullable<PluginConfig["tui"]> & {
    plugin_enabled?: Record<string, boolean>
  }

export type TuiApp = {
  readonly version: string
  /** Runtime-discovered public extension capabilities. */
  readonly capabilities?: ReadonlyArray<string>
}

type Frozen<Value> = Value extends (...args: never[]) => unknown
  ? Value
  : Value extends ReadonlyArray<infer Item>
    ? ReadonlyArray<Frozen<Item>>
    : Value extends object
      ? { readonly [Key in keyof Value]: Frozen<Value[Key]> }
      : Value

export type TuiSidebarMcpItem = {
  name: string
  status: McpStatus["status"]
  error?: string
}

export type TuiSidebarLspItem = Pick<LspStatus, "id" | "root" | "status">

export type TuiSidebarTodoItem = Pick<Todo, "content" | "status">

export type TuiSidebarFileItem = {
  file: string
  additions: number
  deletions: number
}

export type TuiHostSlotMap = {
  app: {}
  home_logo: {}
  home_prompt: {
    workspace_id?: string
    ref?: (ref: TuiPromptRef | undefined) => void
  }
  home_prompt_right: {
    workspace_id?: string
  }
  session_prompt: {
    session_id: string
    visible?: boolean
    disabled?: boolean
    on_submit?: () => void
    ref?: (ref: TuiPromptRef | undefined) => void
  }
  session_prompt_right: {
    session_id: string
  }
  home_bottom: {}
  home_footer: {}
  sidebar_title: {
    session_id: string
    title: string
    share_url?: string
  }
  sidebar_content: {
    session_id: string
  }
  sidebar_footer: {
    session_id: string
  }
}

export type TuiSlotMap<Slots extends Record<string, object> = {}> = TuiHostSlotMap & Slots

type TuiSlotShape<Name extends string, Slots extends Record<string, object>> = Name extends keyof TuiHostSlotMap
  ? TuiHostSlotMap[Name]
  : Name extends keyof Slots
    ? Slots[Name]
    : Record<string, unknown>

export type TuiSlotProps<Name extends string = string, Slots extends Record<string, object> = {}> = {
  name: Name
  mode?: SlotMode
  children?: JSX.Element
} & TuiSlotShape<Name, Slots>

export type TuiSlotContext = {
  theme: TuiTheme
}

type SlotCore<Slots extends Record<string, object> = {}> = SolidPlugin<TuiSlotMap<Slots>, TuiSlotContext>

export type TuiSlotPlugin<Slots extends Record<string, object> = {}> = Omit<SlotCore<Slots>, "id"> & {
  id?: never
}

export type TuiSlots = {
  register: {
    (plugin: TuiSlotPlugin): string
    <Slots extends Record<string, object>>(plugin: TuiSlotPlugin<Slots>): string
  }
}

export type TuiEventBus = {
  on: <Type extends Event["type"]>(type: Type, handler: (event: Extract<Event, { type: Type }>) => void) => () => void
}

export type TuiShellOutputEvent = {
  stream: "stdout" | "stderr"
  text: string
  output: string
}

export type TuiShellExitEvent = {
  code: number
  output: string
  stderr: string
}

export type TuiShellSpawnOptions = {
  cwd?: string
  env?: Record<string, string | undefined>
  shell?: boolean | string
  maxBuffer?: number
}

export type TuiShellProcess = {
  readonly pid: number | undefined
  write: (data: string | Uint8Array) => boolean
  stop: () => Promise<void>
  output: () => string
  stderr: () => string
  onOutput: (handler: (event: TuiShellOutputEvent) => void) => () => void
  onExit: (handler: (event: TuiShellExitEvent) => void) => () => void
  exited: Promise<number>
}

export type TuiShellApi = {
  spawn: (command: string | string[], options?: TuiShellSpawnOptions) => TuiShellProcess
}

export type TuiPtyOutputEvent = {
  text: string
  output: string
  screen: string
  rows: string[]
}

export type TuiPtyExitEvent = {
  code: number
  output: string
}

export type TuiPtySpawnOptions = {
  cwd?: string
  env?: Record<string, string | undefined>
  cols?: number
  rows?: number
  maxBuffer?: number
  term?: string
}

export type TuiPtyProcess = {
  readonly id: string
  readonly pid: number | undefined
  write: (data: string | Uint8Array) => boolean
  resize: (cols: number, rows: number) => void
  stop: () => Promise<void>
  output: () => string
  screen: () => string
  rows: () => string[]
  onOutput: (handler: (event: TuiPtyOutputEvent) => void) => () => void
  onExit: (handler: (event: TuiPtyExitEvent) => void) => () => void
  exited: Promise<number>
}

export type TuiPtyApi = {
  spawn: (command: string | string[], options?: TuiPtySpawnOptions) => Promise<TuiPtyProcess>
}

export type TuiDispose = () => void | Promise<void>

export type TuiLifecycle = {
  readonly signal: AbortSignal
  onDispose: (fn: TuiDispose) => () => void
}

export type TuiPluginState = "first" | "updated" | "same"

export type TuiPluginEntry = {
  id: string
  source: "file" | "npm" | "internal"
  spec: string
  target: string
  requested?: string
  version?: string
  modified?: number
  first_time: number
  last_time: number
  time_changed: number
  load_count: number
  fingerprint: string
}

export type TuiPluginMeta = TuiPluginEntry & {
  state: TuiPluginState
}

export type TuiPluginStatus = {
  id: string
  source: TuiPluginEntry["source"]
  spec: string
  target: string
  enabled: boolean
  active: boolean
}

export type TuiPluginInstallOptions = {
  global?: boolean
}

export type TuiPluginInstallResult =
  | {
      ok: true
      dir: string
      tui: boolean
    }
  | {
      ok: false
      message: string
      missing?: boolean
    }

export type TuiWorkspace = {
  current: () => string | undefined
  set: (workspaceID?: string) => void
}

export type TuiMemoryGraphFact = {
  id: string
  legacyEntryID: string | null
  text: string
  normalizedSummary: string
  scope: string
  ownerWorkspaceIDs: string[]
  ownerGroupIDs: string[]
  categoryIDs: string[]
  provenance: string[]
  createdAt: string
  updatedAt: string
  verifiedAt: string | null
  confidence: number
  durability: number
  changeRisk: number
  sensitivity: "low" | "medium" | "high"
  stale: boolean
  retrievalPriority: number
  materialized: boolean
}

export type TuiMemoryGraphLink = {
  id: string
  from: string
  to: string
  kind: string
  createdAt: string
}

export type TuiMemoryGraphCategory = {
  id: string
  label: string
  count: number
}

export type TuiMemoryGraphSnapshot = {
  root: string
  facts: TuiMemoryGraphFact[]
  links: TuiMemoryGraphLink[]
  categories: TuiMemoryGraphCategory[]
  health: {
    graphHealth: string
    materializedFacts: number
    legacyFacts: number
    links: number
    connectedFacts: number
    isolatedFacts: number
    orphanLinks: number
  }
}

export type TuiMemoryGraphFactInput = {
  id?: string
  text: string
  scope?: "global" | "project" | "workspace" | "group-view"
  ownerWorkspaceIDs?: string[]
  ownerGroupIDs?: string[]
  categoryIDs?: string[]
  normalizedSummary?: string
  provenance?: string[]
  confidence?: number
  durability?: number
  changeRisk?: number
  sensitivity?: "low" | "medium" | "high"
  stale?: boolean
  retrievalPriority?: number
}

export type TuiMemoryGraphLinkInput = {
  id?: string
  from: string
  to: string
  kind: "related" | "conflicts" | "supersedes" | "supports"
  createdAt?: string
}

export type TuiMemoryGraphDeleteResult = {
  ok: boolean
  id: string
  deletedLinks?: number
}

export type TuiMemoryApi = {
  /** Read the current project's persisted memory graph without granting arbitrary filesystem access. */
  graph: () => Promise<TuiMemoryGraphSnapshot>
  /** Ask the instance-backed Memory side chat and receive structured proposed actions. */
  sideChat: OpencodeClient["memory"]["sideChat"]
  /** Create or update a materialized graph fact in the current project. */
  upsertGraphFact: (input: TuiMemoryGraphFactInput) => Promise<TuiMemoryGraphFact>
  /** Delete a materialized graph fact and any links that point to it. */
  deleteGraphFact: (id: string) => Promise<TuiMemoryGraphDeleteResult>
  /** Create or update a graph link in the current project. */
  upsertGraphLink: (input: TuiMemoryGraphLinkInput) => Promise<TuiMemoryGraphLink>
  /** Delete a graph link by ID. */
  deleteGraphLink: (id: string) => Promise<TuiMemoryGraphDeleteResult>
}

export type TuiSessionApi = {
  /** Return the session currently visible in the TUI, if the active route is a session. */
  current: () => string | undefined
  list: OpencodeClient["session"]["list"]
  create: OpencodeClient["session"]["create"]
  status: OpencodeClient["session"]["status"]
  delete: OpencodeClient["session"]["delete"]
  get: OpencodeClient["session"]["get"]
  update: OpencodeClient["session"]["update"]
  children: OpencodeClient["session"]["children"]
  todo: OpencodeClient["session"]["todo"]
  diff: OpencodeClient["session"]["diff"]
  messages: OpencodeClient["session"]["messages"]
  prompt: OpencodeClient["session"]["prompt"]
  promptAsync: OpencodeClient["session"]["promptAsync"]
  command: OpencodeClient["session"]["command"]
  shell: OpencodeClient["session"]["shell"]
  deleteMessage: OpencodeClient["session"]["deleteMessage"]
  message: OpencodeClient["session"]["message"]
  fork: OpencodeClient["session"]["fork"]
  abort: OpencodeClient["session"]["abort"]
  interrupt: OpencodeClient["session"]["interrupt"]
  init: OpencodeClient["session"]["init"]
  summarize: OpencodeClient["session"]["summarize"]
  revert: OpencodeClient["session"]["revert"]
  unrevert: OpencodeClient["session"]["unrevert"]
  background: OpencodeClient["session"]["background"]
  agentView: OpencodeClient["session"]["agentView"]
  agentCommand: OpencodeClient["session"]["agentCommand"]
}

export type TuiSessionMetadataApi = {
  /** Return the session currently visible in the TUI, if any. */
  current: () => string | undefined
  list: OpencodeClient["session"]["agentView"]["metadata"]["list"]
  get: OpencodeClient["session"]["agentView"]["metadata"]["get"]
  patch: OpencodeClient["session"]["agentView"]["metadata"]["patch"]
  getCurrent: () => Promise<Awaited<ReturnType<OpencodeClient["session"]["agentView"]["metadata"]["get"]>>>
}

export type TuiSessionCreateInput = NonNullable<Parameters<OpencodeClient["session"]["create"]>[0]>
type TuiSessionPromptInput = NonNullable<Parameters<OpencodeClient["session"]["prompt"]>[0]>
type TuiSessionPromptAsyncInput = NonNullable<Parameters<OpencodeClient["session"]["promptAsync"]>[0]>
type TuiSessionMessagesInput = NonNullable<Parameters<OpencodeClient["session"]["messages"]>[0]>
type TuiSessionUpdateInput = NonNullable<Parameters<OpencodeClient["session"]["update"]>[0]>

export type TuiAiPromptInput = string | Omit<TuiSessionPromptInput, "sessionID">

/** A persistent MendCode session that a plugin can use as an AI-backed page or modal. */
export type TuiAiSession = {
  readonly id: string
  prompt: (input: TuiAiPromptInput) => ReturnType<OpencodeClient["session"]["prompt"]>
  promptAsync: (
    input: Omit<TuiSessionPromptAsyncInput, "sessionID"> | string,
  ) => ReturnType<OpencodeClient["session"]["promptAsync"]>
  messages: (input?: Omit<TuiSessionMessagesInput, "sessionID">) => ReturnType<OpencodeClient["session"]["messages"]>
  update: (input: Omit<TuiSessionUpdateInput, "sessionID">) => ReturnType<OpencodeClient["session"]["update"]>
  abort: () => ReturnType<OpencodeClient["session"]["abort"]>
  delete: () => ReturnType<OpencodeClient["session"]["delete"]>
}

export type TuiAiApi = {
  /** Wrap an existing session as a plugin-owned AI handle. */
  open: (sessionID: string) => TuiAiSession
  /** Create a regular MendCode session that can power a custom page or modal. */
  create: (input?: TuiSessionCreateInput) => Promise<TuiAiSession>
}

export type TuiPluginApi = {
  app: TuiApp
  command: {
    register: (cb: () => TuiCommand[]) => () => void
    trigger: (value: string) => void
    show: () => void
  }
  route: {
    register: (routes: TuiRouteDefinition[]) => () => void
    navigate: (name: string, params?: Record<string, unknown>) => void
    readonly current: TuiRouteCurrent
  }
  ui: {
    Dialog: (props: TuiDialogProps) => JSX.Element
    DialogAlert: (props: TuiDialogAlertProps) => JSX.Element
    DialogConfirm: (props: TuiDialogConfirmProps) => JSX.Element
    DialogPrompt: (props: TuiDialogPromptProps) => JSX.Element
    DialogSelect: <Value = unknown>(props: TuiDialogSelectProps<Value>) => JSX.Element
    Slot: <Name extends string>(props: TuiSlotProps<Name>) => JSX.Element | null
    Prompt: (props: TuiPromptProps) => JSX.Element
    toast: (input: TuiToast) => void
    dialog: TuiDialogStack
    overlay: TuiOverlayApi
    runtime: TuiRuntimeApi
  }
  keybind: {
    match: (key: string, evt: ParsedKey) => boolean
    print: (key: string) => string
    create: (defaults: TuiKeybindMap, overrides?: Record<string, unknown>) => TuiKeybindSet
  }
  readonly tuiConfig: Frozen<TuiConfigView>
  kv: TuiKV
  state: TuiState
  session: TuiSessionApi
  metadata: TuiSessionMetadataApi
  ai: TuiAiApi
  memory: TuiMemoryApi
  theme: TuiTheme
  client: OpencodeClient
  event: TuiEventBus
  shell: TuiShellApi
  pty: TuiPtyApi
  renderer: CliRenderer
  slots: TuiSlots
  plugins: {
    list: () => ReadonlyArray<TuiPluginStatus>
    activate: (id: string) => Promise<boolean>
    deactivate: (id: string) => Promise<boolean>
    add: (spec: string) => Promise<boolean>
    install: (spec: string, options?: TuiPluginInstallOptions) => Promise<TuiPluginInstallResult>
  }
  lifecycle: TuiLifecycle
}

export type TuiPlugin = (api: TuiPluginApi, options: PluginOptions | undefined, meta: TuiPluginMeta) => Promise<void>

export type TuiPluginModule = {
  id?: string
  tui: TuiPlugin
  server?: never
}
