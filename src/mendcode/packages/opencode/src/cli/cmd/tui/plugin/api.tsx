import type { ParsedKey } from "@opentui/core"
import type { TuiDialogSelectOption, TuiPluginApi, TuiRouteDefinition, TuiSlotProps } from "@mendcode/plugin/tui"
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
import { Slot as HostSlot } from "./slots"
import type { useToast } from "../ui/toast"
import { InstallationVersion } from "@mendcode/core/installation/version"
import { visibleCustomizationCapabilities } from "@/mend/tui/capabilities"
import { clearMendStatus, setMendStatus } from "@/mend/tui/status"
import { clearMendWidget, setMendWidget } from "@/mend/tui/widgets"
import { setMendFooter, setMendFooterEntry } from "@/mend/tui/footer"
import { setMendWorkingIndicator } from "@/mend/tui/working-indicator"
import { setMendEditor, setMendEditorVisual } from "@/mend/tui/editor-host"

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
        "theme.set",
        "state.read",
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
      runtime: {
        setStatus(id, value, options) {
          return setMendStatus(id, value, options)
        },
        clearStatus(id) {
          return clearMendStatus(id)
        },
        setWidget(id, render, options) {
          return setMendWidget(id, render, options)
        },
        clearWidget(id) {
          return clearMendWidget(id)
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
    get client() {
      return input.sdk.client
    },
    event: input.event,
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
