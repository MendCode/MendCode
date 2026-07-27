import { createOpencodeClient } from "@mendcode/sdk/v2"
import { RGBA, type CliRenderer } from "@opentui/core"
import { createPluginKeybind } from "../../src/cli/cmd/tui/context/plugin-keybinds"
import type { HostPluginApi } from "../../src/cli/cmd/tui/plugin/slots"

type Count = {
  event_add: number
  event_drop: number
  route_add: number
  route_drop: number
  command_add: number
  command_drop: number
}

function themeCurrent(): HostPluginApi["theme"]["current"] {
  const a = RGBA.fromInts(0, 120, 240)
  const b = RGBA.fromInts(120, 120, 120)
  const c = RGBA.fromInts(230, 230, 230)
  const d = RGBA.fromInts(120, 30, 30)
  const e = RGBA.fromInts(140, 100, 40)
  const f = RGBA.fromInts(20, 140, 80)
  const g = RGBA.fromInts(20, 80, 160)
  const h = RGBA.fromInts(40, 40, 40)
  const i = RGBA.fromInts(60, 60, 60)
  const j = RGBA.fromInts(80, 80, 80)
  return {
    primary: a,
    secondary: b,
    accent: a,
    error: d,
    warning: e,
    success: f,
    info: g,
    text: c,
    textMuted: b,
    selectedListItemText: h,
    background: h,
    backgroundPanel: h,
    backgroundElement: i,
    backgroundMenu: i,
    border: j,
    borderActive: c,
    borderSubtle: i,
    diffAdded: f,
    diffRemoved: d,
    diffContext: b,
    diffHunkHeader: b,
    diffHighlightAdded: f,
    diffHighlightRemoved: d,
    diffAddedBg: h,
    diffRemovedBg: h,
    diffContextBg: h,
    diffLineNumber: b,
    diffAddedLineNumberBg: h,
    diffRemovedLineNumberBg: h,
    markdownText: c,
    markdownHeading: c,
    markdownLink: a,
    markdownLinkText: g,
    markdownCode: f,
    markdownBlockQuote: e,
    markdownEmph: e,
    markdownStrong: c,
    markdownHorizontalRule: b,
    markdownListItem: a,
    markdownListEnumeration: g,
    markdownImage: a,
    markdownImageText: g,
    markdownCodeBlock: c,
    syntaxComment: b,
    syntaxKeyword: a,
    syntaxFunction: g,
    syntaxVariable: c,
    syntaxString: f,
    syntaxNumber: e,
    syntaxType: a,
    syntaxOperator: a,
    syntaxPunctuation: c,
    thinkingOpacity: 0.6,
  }
}

type Opts = {
  client?: HostPluginApi["client"] | (() => HostPluginApi["client"])
  renderer?: HostPluginApi["renderer"]
  pty?: Partial<HostPluginApi["pty"]>
  count?: Count
  keybind?: Partial<HostPluginApi["keybind"]>
  ui?: {
    overlay?: Partial<HostPluginApi["ui"]["overlay"]>
    runtime?: Partial<HostPluginApi["ui"]["runtime"]>
  }
  tuiConfig?: HostPluginApi["tuiConfig"]
  app?: Partial<HostPluginApi["app"]>
  memory?: Partial<HostPluginApi["memory"]>
  state?: {
    ready?: HostPluginApi["state"]["ready"]
    config?: HostPluginApi["state"]["config"]
    provider?: HostPluginApi["state"]["provider"]
    path?: HostPluginApi["state"]["path"]
    vcs?: HostPluginApi["state"]["vcs"]
    session?: Partial<HostPluginApi["state"]["session"]>
    part?: HostPluginApi["state"]["part"]
    lsp?: HostPluginApi["state"]["lsp"]
    mcp?: HostPluginApi["state"]["mcp"]
  }
  theme?: {
    selected?: string
    has?: HostPluginApi["theme"]["has"]
    set?: HostPluginApi["theme"]["set"]
    install?: HostPluginApi["theme"]["install"]
    mode?: HostPluginApi["theme"]["mode"]
    ready?: boolean
    current?: HostPluginApi["theme"]["current"]
  }
}

export function createTuiPluginApi(opts: Opts = {}): HostPluginApi {
  const kv: Record<string, unknown> = {}
  const count = opts.count
  const ctrl = new AbortController()
  const own = createOpencodeClient({
    baseUrl: "http://localhost:4096",
  })
  const fallback = () => own
  const read =
    typeof opts.client === "function"
      ? opts.client
      : opts.client
        ? () => opts.client as HostPluginApi["client"]
        : fallback
  const client = () => read()
  let depth = 0
  let size: HostPluginApi["ui"]["dialog"]["size"] = "medium"
  const has = opts.theme?.has ?? (() => false)
  let selected = opts.theme?.selected ?? "opencode"
  const key = {
    match: opts.keybind?.match ?? (() => false),
    print: opts.keybind?.print ?? ((name: string) => name),
  }
  const set =
    opts.theme?.set ??
    ((name: string) => {
      if (!has(name)) return false
      selected = name
      return true
    })
  const renderer: CliRenderer = opts.renderer ?? {
    ...Object.create(null),
    once(this: CliRenderer) {
      return this
    },
  }
  type CustomizationState = ReturnType<HostPluginApi["ui"]["runtime"]["customization"]["get"]>
  let customizationState: CustomizationState = {
    contextBar: true,
    diffCount: true,
    diffFiles: true,
    sessionTitle: true,
    projectPath: true,
    terminalTitle: true,
    sessionAccent: "theme" as const,
    terminalTitleTemplate: "{product} | {session}",
  }
  const customization =
    opts.ui?.runtime?.customization ??
    ({
      get: () => customizationState,
      set(patch) {
        customizationState = { ...customizationState, ...patch }
        return customizationState
      },
      reset() {
        customizationState = {
          contextBar: true,
          diffCount: true,
          diffFiles: true,
          sessionTitle: true,
          projectPath: true,
          terminalTitle: true,
          sessionAccent: "theme",
          terminalTitleTemplate: "{product} | {session}",
        }
        return customizationState
      },
      setTerminalTitle(input) {
        return this.set({
          ...(input?.enabled === undefined ? {} : { terminalTitle: input.enabled }),
          ...(input?.template === undefined ? {} : { terminalTitleTemplate: input.template }),
        })
      },
      setSessionAccent(accent) {
        return this.set({ sessionAccent: accent })
      },
      setDiffFiles(visible) {
        return this.set({ diffFiles: visible })
      },
    } as HostPluginApi["ui"]["runtime"]["customization"])

  function kvGet(name: string): unknown
  function kvGet<Value>(name: string, fallback: Value): Value
  function kvGet(name: string, fallback?: unknown) {
    const value = kv[name]
    if (value === undefined) return fallback
    return value
  }

  return {
    app: {
      get version() {
        return opts.app?.version ?? "0.0.0-test"
      },
    },
    get client() {
      return client()
    },
    event: {
      on: () => {
        if (count) count.event_add += 1
        return () => {
          if (!count) return
          count.event_drop += 1
        }
      },
    },
    shell: {
      spawn: () => ({
        pid: undefined,
        write: () => false,
        stop: async () => {},
        output: () => "",
        stderr: () => "",
        onOutput: () => () => {},
        onExit: () => () => {},
        exited: Promise.resolve(0),
      }),
    },
    pty: {
      spawn:
        opts.pty?.spawn ??
        (async () => ({
          id: "fixture-pty",
          pid: undefined,
          write: () => false,
          resize: () => {},
          stop: async () => {},
          output: () => "",
          screen: () => "",
          rows: () => [],
          onOutput: () => () => {},
          onExit: () => () => {},
          exited: Promise.resolve(0),
        })),
    },
    renderer,
    slots: {
      register: () => "fixture-slot",
    },
    plugins: {
      list: () => [],
      activate: async () => false,
      deactivate: async () => false,
      add: async () => false,
      install: async () => ({
        ok: false,
        message: "not implemented in fixture",
      }),
    },
    lifecycle: {
      signal: ctrl.signal,
      onDispose() {
        return () => {}
      },
    },
    command: {
      register: () => {
        if (count) count.command_add += 1
        return () => {
          if (!count) return
          count.command_drop += 1
        }
      },
      trigger: () => {},
      show: () => {},
    },
    route: {
      register: () => {
        if (count) count.route_add += 1
        return () => {
          if (!count) return
          count.route_drop += 1
        }
      },
      navigate: () => {},
      get current() {
        return { name: "home" }
      },
    },
    ui: {
      Dialog: () => null,
      DialogAlert: () => null,
      DialogConfirm: () => null,
      DialogPrompt: () => null,
      DialogSelect: () => null,
      Slot: () => null,
      Prompt: () => null,
      toast: () => {},
      dialog: {
        replace: () => {
          depth = 1
        },
        clear: () => {
          depth = 0
          size = "medium"
        },
        setSize: (next) => {
          size = next
        },
        get size() {
          return size
        },
        get depth() {
          return depth
        },
        get open() {
          return depth > 0
        },
      },
      overlay: {
        open: opts.ui?.overlay?.open ?? (() => true),
        close: opts.ui?.overlay?.close ?? (() => true),
        focus: opts.ui?.overlay?.focus ?? (() => true),
        blur: opts.ui?.overlay?.blur ?? (() => true),
        focused: opts.ui?.overlay?.focused ?? (() => undefined),
      },
      runtime: {
        customization,
        setStatus: opts.ui?.runtime?.setStatus ?? (() => true),
        clearStatus: opts.ui?.runtime?.clearStatus ?? (() => true),
        setWidget: opts.ui?.runtime?.setWidget ?? (() => true),
        clearWidget: opts.ui?.runtime?.clearWidget ?? (() => true),
        focusWidget: opts.ui?.runtime?.focusWidget ?? (() => true),
        blurWidget: opts.ui?.runtime?.blurWidget ?? (() => true),
        setFooter: opts.ui?.runtime?.setFooter ?? (() => true),
        setFooterEntry: opts.ui?.runtime?.setFooterEntry ?? (() => true),
        setWorkingIndicator: opts.ui?.runtime?.setWorkingIndicator ?? (() => true),
        registerCompactionArcadeGame: opts.ui?.runtime?.registerCompactionArcadeGame ?? (() => true),
        clearCompactionArcadeGame: opts.ui?.runtime?.clearCompactionArcadeGame ?? (() => true),
        setEditorVisual: opts.ui?.runtime?.setEditorVisual ?? (() => true),
        setEditor: opts.ui?.runtime?.setEditor ?? (() => true),
      },
    },
    keybind: {
      ...key,
      create:
        opts.keybind?.create ??
        ((defaults, over) => {
          return createPluginKeybind(key, defaults, over)
        }),
    },
    tuiConfig: opts.tuiConfig ?? {},
    kv: {
      get: kvGet,
      set(name, value) {
        kv[name] = value
      },
      get ready() {
        return true
      },
    },
    get session() {
      return Object.assign(client().session, { current: () => undefined })
    },
    get metadata() {
      return Object.assign(client().session.agentView.metadata, { current: () => undefined, getCurrent: () => Promise.reject(new Error("No session route is currently active")) })
    },
    ai: {
      open() {
        throw new Error("AI sessions are not configured in this fixture")
      },
      async create() {
        throw new Error("AI sessions are not configured in this fixture")
      },
    },
    memory: {
      graph: opts.memory?.graph ?? (async () => ({
        root: opts.state?.path?.directory ?? "",
        facts: [],
        links: [],
        categories: [],
        health: {
          graphHealth: "empty",
          materializedFacts: 0,
          legacyFacts: 0,
          links: 0,
          connectedFacts: 0,
          isolatedFacts: 0,
          orphanLinks: 0,
        },
      })),
      sideChat: opts.memory?.sideChat ?? (async () => {
        throw new Error("Memory side chat is not configured in this fixture")
      }),
      upsertGraphFact: opts.memory?.upsertGraphFact ?? (async () => {
        throw new Error("Memory graph writes are not configured in this fixture")
      }),
      deleteGraphFact: opts.memory?.deleteGraphFact ?? (async () => {
        throw new Error("Memory graph writes are not configured in this fixture")
      }),
      upsertGraphLink: opts.memory?.upsertGraphLink ?? (async () => {
        throw new Error("Memory graph writes are not configured in this fixture")
      }),
      deleteGraphLink: opts.memory?.deleteGraphLink ?? (async () => {
        throw new Error("Memory graph writes are not configured in this fixture")
      }),
    },
    state: {
      get ready() {
        return opts.state?.ready ?? true
      },
      get config() {
        return opts.state?.config ?? {}
      },
      get provider() {
        return opts.state?.provider ?? []
      },
      get path() {
        return opts.state?.path ?? { home: "", state: "", config: "", worktree: "", directory: "" }
      },
      get vcs() {
        return opts.state?.vcs
      },
      session: {
        count: opts.state?.session?.count ?? (() => 0),
        diff: opts.state?.session?.diff ?? (() => []),
        todo: opts.state?.session?.todo ?? (() => []),
        messages: opts.state?.session?.messages ?? (() => []),
        status: opts.state?.session?.status ?? (() => undefined),
        permission: opts.state?.session?.permission ?? (() => []),
        question: opts.state?.session?.question ?? (() => []),
      },
      part: opts.state?.part ?? (() => []),
      lsp: opts.state?.lsp ?? (() => []),
      mcp: opts.state?.mcp ?? (() => []),
    },
    theme: {
      get current() {
        return opts.theme?.current ?? themeCurrent()
      },
      get selected() {
        return selected
      },
      has(name) {
        return has(name)
      },
      set(name) {
        return set(name)
      },
      async install(file) {
        if (opts.theme?.install) return opts.theme.install(file)
        throw new Error("base theme.install should not run")
      },
      mode() {
        if (opts.theme?.mode) return opts.theme.mode()
        return "dark"
      },
      get ready() {
        return opts.theme?.ready ?? true
      },
    },
  }
}
