import type { ParsedKey } from "@opentui/core"
import type {
  TuiDialogSelectOption,
  TuiAiApi,
  TuiAiPromptInput,
  TuiAiSession,
  TuiCustomizationApi,
  TuiMemoryGraphFact,
  TuiMemoryApi,
  TuiSessionApi,
  TuiSessionMetadataApi,
  TuiPluginApi,
  TuiPtyApi,
  TuiRouteDefinition,
  TuiShellApi,
  TuiShellOutputEvent,
  TuiSlotProps,
} from "@mendcode/plugin/tui"
import type { MendExtensionApi, MendRouteDefinition, MendRouteName, MendSlotRegistration } from "@/mend/sdk"
import type { useCommandDialog } from "@tui/component/dialog-command"
import type { useEvent } from "@tui/context/event"
import type { useKeybind } from "@tui/context/keybind"
import type { useRoute } from "@tui/context/route"
import type { useSDK } from "@tui/context/sdk"
import type { useSync } from "@tui/context/sync"
import type { useTheme } from "@tui/context/theme"
import { Dialog as DialogUI, type useDialog } from "@tui/ui/dialog"
import type { TuiConfig } from "@/cli/cmd/tui/config/tui"
import { createPluginKeybind } from "../context/plugin-keybinds"
import type { useKV } from "../context/kv"
import { DialogAlert } from "../ui/dialog-alert"
import { DialogConfirm } from "../ui/dialog-confirm"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogSelect, type DialogSelectOption as SelectOption } from "../ui/dialog-select"
import { Prompt } from "../component/prompt"
import { registerCompactionArcadeGame, unregisterCompactionArcadeGame } from "../component/compaction-panel"
import { Slot as HostSlot } from "./slots"
import type { useToast } from "../ui/toast"
import { InstallationVersion } from "@mendcode/core/installation/version"
import { visibleCustomizationCapabilities } from "@/mend/tui/capabilities"
import { clearMendStatus, setMendStatus } from "@/mend/tui/status"
import { blurMendWidget, clearMendWidget, focusMendWidget, setMendWidget, type MendWidgetRenderContext } from "@/mend/tui/widgets"
import { blurMendOverlay, clearMendOverlay, focusMendOverlay, readFocusedMendOverlayID, setMendOverlay, type MendOverlayRenderContext } from "@/mend/tui/overlays"
import { setMendFooter, setMendFooterEntry } from "@/mend/tui/footer"
import { setMendWorkingIndicator } from "@/mend/tui/working-indicator"
import { setMendEditor, setMendEditorVisual } from "@/mend/tui/editor-host"
import { Process } from "@/util/process"
import { memoryOverview } from "@/mend/memory/overview"
import { deleteMemoryFact, deleteMemoryFactLink, upsertMemoryFact, upsertMemoryFactLink } from "@/mend/memory/graph"
import {
  readMendTuiCustomization,
  resetMendTuiCustomization,
  writeMendTuiCustomization,
} from "@/mend/tui/customization"

type RouteEntry = {
  key: symbol
  render: TuiRouteDefinition["render"]
}

export type RouteMap = Map<string, RouteEntry[]>

type Input = {
  command: ReturnType<typeof useCommandDialog>
  tuiConfig: TuiConfig.Info
  dialog: ReturnType<typeof useDialog>
  keybind: ReturnType<typeof useKeybind>
  kv: ReturnType<typeof useKV>
  route: ReturnType<typeof useRoute>
  routes: RouteMap
  bump: () => void
  event: ReturnType<typeof useEvent>
  sdk: ReturnType<typeof useSDK>
  sync: ReturnType<typeof useSync>
  theme: ReturnType<typeof useTheme>
  toast: ReturnType<typeof useToast>
  renderer: TuiPluginApi["renderer"]
}

function routeRegister(routes: RouteMap, list: TuiRouteDefinition[], bump: () => void) {
  const key = Symbol()
  for (const item of list) {
    const prev = routes.get(item.name) ?? []
    prev.push({ key, render: item.render })
    routes.set(item.name, prev)
  }
  bump()

  return () => {
    for (const item of list) {
      const prev = routes.get(item.name)
      if (!prev) continue
      const next = prev.filter((x) => x.key !== key)
      if (!next.length) {
        routes.delete(item.name)
        continue
      }
      routes.set(item.name, next)
    }
    bump()
  }
}

function mendRouteRegister(routes: RouteMap, list: MendRouteDefinition[], bump: () => void) {
  return routeRegister(routes, list as TuiRouteDefinition[], bump)
}

function routeNavigate(route: ReturnType<typeof useRoute>, name: string, params?: Record<string, unknown>) {
  if (name === "home") {
    route.navigate({ type: "home" })
    return
  }

  if (name === "session") {
    const sessionID = params?.sessionID
    if (typeof sessionID !== "string") return
    route.navigate({ type: "session", sessionID })
    return
  }

  if (name === "memory") {
    route.navigate({ type: "memory" })
    return
  }

  if (name === "workflows") {
    route.navigate({ type: "workflows", selectedID: typeof params?.selectedID === "string" ? params.selectedID : undefined })
    return
  }

  route.navigate({ type: "plugin", id: name, data: params })
}

function mendRouteNavigate(route: ReturnType<typeof useRoute>, name: MendRouteName, params?: Record<string, unknown>) {
  routeNavigate(route, name, params)
}

function routeCurrent(route: ReturnType<typeof useRoute>): TuiPluginApi["route"]["current"] {
  if (route.data.type === "home") return { name: "home" }
  if (route.data.type === "session") {
    return {
      name: "session",
      params: {
        sessionID: route.data.sessionID,
        prompt: route.data.prompt,
      },
    }
  }
  if (route.data.type === "setup") {
    return {
      name: "setup",
      params: {
        step: route.data.step,
        minimal: route.data.minimal,
      },
    }
  }
  if (route.data.type === "stats") {
    return {
      name: "stats",
    }
  }
  if (route.data.type === "memory") {
    return {
      name: "memory",
    }
  }
  if (route.data.type === "changes") {
    return {
      name: "changes",
    }
  }
  if (route.data.type === "loops") {
    return {
      name: "loops",
      params: {
        selectedID: route.data.selectedID,
      },
    }
  }
  if (route.data.type === "workflows") {
    return {
      name: "workflows",
      params: {
        selectedID: route.data.selectedID,
      },
    }
  }

  return {
    name: route.data.id,
    params: route.data.data,
  }
}

function mapOption<Value>(item: TuiDialogSelectOption<Value>): SelectOption<Value> {
  return {
    ...item,
    onSelect: () => item.onSelect?.(),
  }
}

function pickOption<Value>(item: SelectOption<Value>): TuiDialogSelectOption<Value> {
  return {
    title: item.title,
    value: item.value,
    description: item.description,
    footer: item.footer,
    category: item.category,
    disabled: item.disabled,
  }
}

function mapOptionCb<Value>(cb?: (item: TuiDialogSelectOption<Value>) => void) {
  if (!cb) return
  return (item: SelectOption<Value>) => cb(pickOption(item))
}

const DEFAULT_SHELL_BUFFER = 64_000

function commandArgs(command: string | string[]) {
  if (Array.isArray(command)) return command
  return process.platform === "win32" ? ["cmd.exe", "/d", "/s", "/c", command] : ["sh", "-lc", command]
}

function capShellBuffer(text: string, max: number) {
  if (max <= 0) return ""
  if (text.length <= max) return text
  return text.slice(text.length - max)
}

function shellApi(): TuiShellApi {
  return {
    spawn(command, options = {}) {
      const maxBuffer = Math.max(0, options.maxBuffer ?? DEFAULT_SHELL_BUFFER)
      const outputHandlers = new Set<(event: TuiShellOutputEvent) => void>()
      const exitHandlers = new Set<(event: { code: number; output: string; stderr: string }) => void>()
      let output = ""
      let stderr = ""

      const proc = Process.spawn(commandArgs(command), {
        cwd: options.cwd,
        env: options.env as NodeJS.ProcessEnv | undefined,
        shell: Array.isArray(command) ? options.shell : false,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      })

      const emit = (stream: "stdout" | "stderr", chunk: unknown) => {
        const text = Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk)
        output = capShellBuffer(output + text, maxBuffer)
        if (stream === "stderr") stderr = capShellBuffer(stderr + text, maxBuffer)
        const event = { stream, text, output }
        for (const handler of outputHandlers) handler(event)
      }

      proc.stdout?.on("data", (chunk) => emit("stdout", chunk))
      proc.stderr?.on("data", (chunk) => emit("stderr", chunk))

      const exited = proc.exited.then((code) => {
        const event = { code, output, stderr }
        for (const handler of exitHandlers) handler(event)
        return code
      })
      void exited.catch(() => undefined)

      return {
        get pid() {
          return proc.pid
        },
        write(data) {
          if (!proc.stdin || proc.stdin.destroyed) return false
          return proc.stdin.write(data)
        },
        async stop() {
          await Process.stop(proc)
        },
        output() {
          return output
        },
        stderr() {
          return stderr
        },
        onOutput(handler) {
          outputHandlers.add(handler)
          return () => {
            outputHandlers.delete(handler)
          }
        },
        onExit(handler) {
          exitHandlers.add(handler)
          return () => {
            exitHandlers.delete(handler)
          }
        },
        exited,
      }
    },
  }
}

function ptyApi(): TuiPtyApi {
  return {
    async spawn() {
      throw new Error("TUI PTY widgets are disabled in this build. Use the widget/overlay substrate for interactive UI and api.shell.spawn only for non-interactive output.")
    },
  }
}

function stateApi(sync: ReturnType<typeof useSync>): TuiPluginApi["state"] {
  return {
    get ready() {
      return sync.ready
    },
    get config() {
      return sync.data.config
    },
    get provider() {
      return sync.data.provider
    },
    get path() {
      return sync.path
    },
    get vcs() {
      if (!sync.data.vcs) return
      return {
        branch: sync.data.vcs.branch,
      }
    },
    session: {
      count() {
        return sync.data.session.length
      },
      diff(sessionID) {
        return sync.data.session_diff[sessionID] ?? []
      },
      todo(sessionID) {
        return sync.data.todo[sessionID] ?? []
      },
      messages(sessionID) {
        return sync.data.message[sessionID] ?? []
      },
      status(sessionID) {
        return sync.data.session_status[sessionID]
      },
      permission(sessionID) {
        return sync.data.permission[sessionID] ?? []
      },
      question(sessionID) {
        return sync.data.question[sessionID] ?? []
      },
    },
    part(messageID) {
      return sync.data.part[messageID] ?? []
    },
    lsp() {
      return sync.data.lsp.map((item) => ({ id: item.id, root: item.root, status: item.status }))
    },
    mcp() {
      return Object.entries(sync.data.mcp)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, item]) => ({
          name,
          status: item.status,
          error: item.status === "failed" ? item.error : undefined,
        }))
    },
  }
}

function currentSessionID(route: ReturnType<typeof useRoute>) {
  const current = routeCurrent(route)
  if (current.name !== "session") return undefined
  const sessionID = current.params?.sessionID
  return typeof sessionID === "string" ? sessionID : undefined
}

function sessionApi(input: Input): TuiSessionApi {
  const session = input.sdk.client.session
  return {
    current: () => currentSessionID(input.route),
    list: (...args) => session.list(...args),
    create: (...args) => session.create(...args),
    status: (...args) => session.status(...args),
    delete: (...args) => session.delete(...args),
    get: (...args) => session.get(...args),
    update: (...args) => session.update(...args),
    children: (...args) => session.children(...args),
    todo: (...args) => session.todo(...args),
    diff: (...args) => session.diff(...args),
    messages: (...args) => session.messages(...args),
    prompt: (...args) => session.prompt(...args),
    promptAsync: (...args) => session.promptAsync(...args),
    command: (...args) => session.command(...args),
    shell: (...args) => session.shell(...args),
    deleteMessage: (...args) => session.deleteMessage(...args),
    message: (...args) => session.message(...args),
    fork: (...args) => session.fork(...args),
    abort: (...args) => session.abort(...args),
    interrupt: (...args) => session.interrupt(...args),
    init: (...args) => session.init(...args),
    summarize: (...args) => session.summarize(...args),
    revert: (...args) => session.revert(...args),
    unrevert: (...args) => session.unrevert(...args),
    background: session.background,
    agentView: session.agentView,
    agentCommand: session.agentCommand,
  }
}

function metadataApi(input: Input): TuiSessionMetadataApi {
  const metadata = input.sdk.client.session.agentView.metadata
  return {
    current: () => currentSessionID(input.route),
    list: (...args) => metadata.list(...args),
    get: (...args) => metadata.get(...args),
    patch: (...args) => metadata.patch(...args),
    getCurrent() {
      const sessionID = currentSessionID(input.route)
      if (!sessionID) return Promise.reject(new Error("No session route is currently active"))
      return metadata.get({ sessionID })
    },
  }
}

function memoryFactView(fact: {
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
}): TuiMemoryGraphFact {
  return {
    id: fact.id,
    legacyEntryID: fact.legacyEntryID,
    text: fact.text,
    normalizedSummary: fact.normalizedSummary,
    scope: fact.scope,
    ownerWorkspaceIDs: fact.ownerWorkspaceIDs,
    ownerGroupIDs: fact.ownerGroupIDs,
    categoryIDs: fact.categoryIDs,
    provenance: fact.provenance,
    createdAt: fact.createdAt,
    updatedAt: fact.updatedAt,
    verifiedAt: fact.verifiedAt,
    confidence: fact.confidence,
    durability: fact.durability,
    changeRisk: fact.changeRisk,
    sensitivity: fact.sensitivity,
    stale: fact.stale,
    retrievalPriority: fact.retrievalPriority,
    materialized: fact.materialized,
  }
}

function memoryApi(input: Input): TuiMemoryApi {
  const root = () => input.sync.path.directory
  return {
    async graph() {
      const overview = await memoryOverview(root())
      return {
        root: root(),
        facts: overview.facts.map(memoryFactView),
        links: overview.links.map((link) => ({ id: link.id, from: link.from, to: link.to, kind: link.kind, createdAt: link.createdAt })),
        categories: overview.categories.map((category) => ({ id: category.id, label: category.label, count: category.count })),
        health: overview.graphHealth,
      }
    },
    sideChat(...args) {
      return input.sdk.client.memory.sideChat(...args)
    },
    async upsertGraphFact(fact) {
      const next = await upsertMemoryFact(fact, root())
      return memoryFactView({ ...next, materialized: true })
    },
    deleteGraphFact(id) {
      return deleteMemoryFact(id, root())
    },
    async upsertGraphLink(link) {
      const next = await upsertMemoryFactLink(link, root())
      return { id: next.id, from: next.from, to: next.to, kind: next.kind, createdAt: next.createdAt }
    },
    deleteGraphLink(id) {
      return deleteMemoryFactLink(id, root())
    },
  }
}

function aiPromptParameters(input: TuiAiPromptInput | string) {
  return typeof input === "string" ? { parts: [{ type: "text" as const, text: input }] } : input
}

function aiApi(input: Input): TuiAiApi {
  const client = input.sdk.client
  const open = (sessionID: string): TuiAiSession => ({
    id: sessionID,
    prompt(prompt) {
      return client.session.prompt({ ...aiPromptParameters(prompt), sessionID })
    },
    promptAsync(prompt) {
      return client.session.promptAsync({ ...aiPromptParameters(prompt), sessionID })
    },
    messages(parameters) {
      return client.session.messages({ ...(parameters ?? {}), sessionID })
    },
    update(parameters) {
      return client.session.update({ ...parameters, sessionID })
    },
    abort() {
      return client.session.abort({ sessionID })
    },
    delete() {
      return client.session.delete({ sessionID })
    },
  })

  return {
    open,
    async create(parameters) {
      const result = await client.session.create(parameters)
      if (!result.data?.id) throw new Error("MendCode did not return an ID for the plugin AI session")
      return open(result.data.id)
    },
  }
}

function tuiCustomizationApi(input: Input): TuiCustomizationApi {
  const read = () => readMendTuiCustomization((key, fallback) => input.kv.get(key, fallback))
  const set = (patch: Parameters<TuiCustomizationApi["set"]>[0]) =>
    writeMendTuiCustomization((key, fallback) => input.kv.get(key, fallback), input.kv.set, patch)

  return {
    get: read,
    set,
    reset() {
      return resetMendTuiCustomization(input.kv.set)
    },
    setTerminalTitle(options) {
      const patch: Parameters<TuiCustomizationApi["set"]>[0] = {}
      if (options?.enabled !== undefined) patch.terminalTitle = options.enabled
      if (options?.template !== undefined) patch.terminalTitleTemplate = options.template
      return set(patch)
    },
    setSessionAccent(accent) {
      return set({ sessionAccent: accent })
    },
    setDiffFiles(visible) {
      return set({ diffFiles: visible })
    },
  }
}

function mendAppApi(): MendExtensionApi["app"] {
  return {
    get version() {
      return InstallationVersion
    },
    get capabilities() {
      return [
        "command.register",
        "route.register",
        "route.navigate",
        "ui.dialog",
        "ui.slot",
        "ui.overlay",
        "ui.customization",
        "ui.widgets",
        "shell.spawn",
        "overlay.custom",
        "overlay.nonCapturing",
        "overlay.focus",
        "theme.set",
        "theme.install",
        "state.read",
        "session.read",
        "session.write",
        "session.prompt",
        "session.command",
        "session.shell",
        "session.delete",
        "session.ai",
        "metadata.read",
        "metadata.write",
        "memory.graph.read",
        "memory.graph.write",
        "memory.graph.delete",
        "memory.side-chat",
        "lifecycle.dispose",
      ]
    },
  }
}

export function createTuiApi(input: Input): TuiPluginApi & MendExtensionApi {
  const lifecycle: TuiPluginApi["lifecycle"] = {
    signal: new AbortController().signal,
    onDispose() {
      return () => {}
    },
  }
  const session = sessionApi(input)
  const metadata = metadataApi(input)
  const ai = aiApi(input)
  const memory = memoryApi(input)

  return {
    app: mendAppApi(),
    command: {
      register(cb) {
        return input.command.register(() => cb())
      },
      trigger(value) {
        input.command.trigger(value)
      },
      show() {
        input.command.show()
      },
    },
    route: {
      register(list) {
        return mendRouteRegister(input.routes, list as MendRouteDefinition[], input.bump)
      },
      navigate(name, params) {
        mendRouteNavigate(input.route, name as MendRouteName, params)
      },
      get current() {
        return routeCurrent(input.route)
      },
    },
    ui: {
      Dialog(props) {
        return (
          <DialogUI size={props.size} onClose={props.onClose}>
            {props.children}
          </DialogUI>
        )
      },
      DialogAlert(props) {
        return <DialogAlert {...props} />
      },
      DialogConfirm(props) {
        return <DialogConfirm {...props} />
      },
      DialogPrompt(props) {
        return <DialogPrompt {...props} description={props.description} />
      },
      DialogSelect(props) {
        return (
          <DialogSelect
            title={props.title}
            placeholder={props.placeholder}
            options={props.options.map(mapOption)}
            flat={props.flat}
            onMove={mapOptionCb(props.onMove)}
            onFilter={props.onFilter}
            onSelect={mapOptionCb(props.onSelect)}
            skipFilter={props.skipFilter}
            current={props.current}
          />
        )
      },
      Slot<Name extends string>(props: TuiSlotProps<Name>) {
        return <HostSlot {...props} />
      },
      Prompt(props) {
        return (
          <Prompt
            sessionID={props.sessionID}
            workspaceID={props.workspaceID}
            visible={props.visible}
            disabled={props.disabled}
            onSubmit={props.onSubmit}
            ref={props.ref}
            hint={props.hint}
            right={props.right}
            showPlaceholder={props.showPlaceholder}
            placeholders={props.placeholders}
          />
        )
      },
      toast(inputToast) {
        input.toast.show({
          title: inputToast.title,
          message: inputToast.message,
          variant: inputToast.variant ?? "info",
          duration: inputToast.duration,
        })
      },
      dialog: {
        replace(render, onClose) {
          input.dialog.replace(render, onClose)
        },
        clear() {
          input.dialog.clear()
        },
        setSize(size) {
          input.dialog.setSize(size)
        },
        get size() {
          return input.dialog.size
        },
        get depth() {
          return input.dialog.stack.length
        },
        get open() {
          return input.dialog.stack.length > 0
        },
      },
      overlay: {
        open(id, render, options) {
          return setMendOverlay(id, render as (context: MendOverlayRenderContext) => unknown, {
            ...options,
            requestRender: options?.requestRender ?? (() => input.renderer.requestRender()),
          })
        },
        close(id) {
          return clearMendOverlay(id)
        },
        focus(id) {
          return focusMendOverlay(id)
        },
        blur(id) {
          return blurMendOverlay(id)
        },
        focused() {
          return readFocusedMendOverlayID()
        },
      },
      runtime: {
        customization: tuiCustomizationApi(input),
        setStatus(id, value, options) {
          return setMendStatus(id, value, options)
        },
        clearStatus(id) {
          return clearMendStatus(id)
        },
        setWidget(id, render, options) {
          return setMendWidget(id, render as ((context: MendWidgetRenderContext) => unknown) | undefined, {
            ...options,
            requestRender: options?.requestRender ?? (() => input.renderer.requestRender()),
          })
        },
        clearWidget(id) {
          return clearMendWidget(id)
        },
        focusWidget(id) {
          return focusMendWidget(id)
        },
        blurWidget(id) {
          return blurMendWidget(id)
        },
        setFooter(renderer) {
          return setMendFooter(renderer)
        },
        setFooterEntry(id, render, options) {
          return setMendFooterEntry(id, render, options)
        },
        setWorkingIndicator(input) {
          return setMendWorkingIndicator(input)
        },
        registerCompactionArcadeGame(game) {
          return registerCompactionArcadeGame(game)
        },
        clearCompactionArcadeGame(id) {
          return unregisterCompactionArcadeGame(id)
        },
        setEditorVisual(input) {
          return setMendEditorVisual(input)
        },
        setEditor(factory) {
          return setMendEditor(factory)
        },
      },
    },
    keybind: {
      match(key, evt: ParsedKey) {
        return input.keybind.match(key, evt)
      },
      print(key) {
        return input.keybind.print(key)
      },
      create(defaults, overrides) {
        return createPluginKeybind(input.keybind, defaults, overrides)
      },
    },
    get tuiConfig() {
      return input.tuiConfig
    },
    kv: {
      get(key, fallback) {
        return input.kv.get(key, fallback)
      },
      set(key, value) {
        input.kv.set(key, value)
      },
      get ready() {
        return input.kv.ready
      },
    },
    state: {
      ...stateApi(input.sync),
      customization: {
        capabilities() {
          return visibleCustomizationCapabilities().map((item) => `${item.id}:${item.status}:${item.trust}`)
        },
      },
    },
    session,
    metadata,
    ai,
    memory,
    get client() {
      return input.sdk.client
    },
    event: input.event,
    shell: shellApi(),
    pty: ptyApi(),
    renderer: input.renderer,
    slots: {
      register(...args: any[]) {
        void args
        throw new Error("slots.register is only available in plugin context")
      },
    } as TuiPluginApi["slots"] & MendExtensionApi["slots"],
    plugins: {
      list() {
        return []
      },
      async activate() {
        return false
      },
      async deactivate() {
        return false
      },
      async add() {
        return false
      },
      async install() {
        return {
          ok: false,
          message: "plugins.install is only available in plugin context",
        }
      },
    },
    lifecycle,
    theme: {
      get current() {
        return input.theme.theme
      },
      get selected() {
        return input.theme.selected
      },
      has(name) {
        return input.theme.has(name)
      },
      set(name) {
        return input.theme.set(name)
      },
      async install(_jsonPath) {
        throw new Error("theme.install is only available in plugin context")
      },
      mode() {
        return input.theme.mode()
      },
      get ready() {
        return input.theme.ready
      },
    },
  }
}

export function createMendExtensionApi(input: Input): MendExtensionApi {
  return createTuiApi(input)
}
