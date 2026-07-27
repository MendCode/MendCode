import type {
  TuiAiApi,
  TuiCustomizationApi,
  TuiMemoryApi,
  TuiSessionApi,
  TuiSessionMetadataApi,
} from "@mendcode/plugin/tui"

export type Dispose = () => void
export type MendKeyEvent = {
  name: string
  ctrl?: boolean
  meta?: boolean
  shift?: boolean
  sequence?: string
  preventDefault?: () => void
  stopPropagation?: () => void
}

export type MendRouteName = "home" | "session" | "setup" | string

export type MendPublicSlotName =
  | "home_logo"
  | "home_prompt"
  | "home_prompt_right"
  | "home_bottom"
  | "home_footer"
  | "session_prompt"
  | "session_prompt_right"
  | "sidebar_title"
  | "sidebar_content"
  | "sidebar_footer"

export type MendCommandDefinition = {
  title: string
  value: string
  description?: string
  category?: string
  keybind?: string
  hidden?: boolean
  suggested?: boolean
  slash?: {
    name: string
    aliases?: string[]
  }
  onSelect?: () => void | Promise<void>
}

export type MendRouteDefinition = {
  name: MendRouteName
  render: (...args: any[]) => any
}

export type MendToastInput = {
  title?: string
  message: string
  variant?: "info" | "success" | "warning" | "error"
  duration?: number
}

export type MendOverlayAnchor = "top-center" | "center" | "bottom-center" | "top-left" | "top-right" | "bottom-left" | "bottom-right"
export type MendOverlaySize = number | `${number}%` | "auto"
export type MendOverlayApi = {
  open(
    id: string,
    render: (context: {
      close: () => boolean
      focus: () => boolean
      blur: () => boolean
      focused: () => boolean
      requestRender: () => void
    }) => unknown,
    input?: {
      anchor?: MendOverlayAnchor
      width?: MendOverlaySize
      height?: MendOverlaySize
      maxHeight?: MendOverlaySize
      margin?: { top?: number; right?: number; bottom?: number; left?: number }
      nonCapturing?: boolean
      modal?: boolean
      allowStack?: boolean
      title?: string
      onFocus?: () => boolean | void
      onClose?: Dispose | (() => Promise<void>)
      requestRender?: () => void
    },
  ): boolean
  close(id: string): boolean
  focus(id: string): boolean
  blur(id?: string): boolean
  focused(): string | undefined
}

export type MendUiRuntimeApi = {
  customization: TuiCustomizationApi
  setStatus(id: string, value?: string, input?: { order?: number }): boolean
  clearStatus(id: string): boolean
  setWidget(
    id: string,
    render?: ((context: { requestRender: () => void; maxFps: number }) => unknown) | undefined,
    input?: {
      placement?: "aboveEditor" | "belowEditor" | "sessionBottomDock"
      order?: number
      title?: string
      width?: number | "auto"
      minWidth?: number
      maxWidth?: number
      height?: number | "auto"
      interactive?: boolean
      onVisible?: () => boolean | void
      onFocus?: () => boolean | void
      onKey?: (event: MendKeyEvent) => boolean | void
      maxFps?: number
      requestRender?: () => void
      dispose?: Dispose | (() => Promise<void>)
    },
  ): boolean
  clearWidget(id: string): boolean
  focusWidget(id: string): boolean
  blurWidget(id?: string): boolean
  setFooter(renderer?: (() => unknown) | undefined): boolean
  setFooterEntry(id: string, render?: (() => unknown) | undefined, input?: { order?: number }): boolean
  setWorkingIndicator(input?: { frames?: string[]; intervalMs?: number; visible?: boolean }): boolean
  setEditorVisual(input?: {
    showPlaceholder?: boolean
    normalPrefix?: string
    shellPrefix?: string
    normalExamples?: string[]
    shellExamples?: string[]
    borderGlyph?: string
    footerGlyph?: string
  }): boolean
  setEditor(factory?: ((input: { sessionID?: string; workspaceID?: string; visible?: boolean; disabled?: boolean; onSubmit?: () => void; right?: unknown; defaultEditor: () => unknown }) => unknown) | undefined): boolean
}

export type MendThemeMode = "dark" | "light" | "system"

export type MendTheme = {
  [key: string]: unknown
}

export type MendSlotRegistration = {
  id?: string | number
  setup?: () => void | Promise<void>
  slots: Partial<Record<MendPublicSlotName | string, (...args: any[]) => any>>
}

export type MendExtensionApi = {
  app: {
    version: string
    capabilities?: string[]
  }
  command: {
    register(factory: () => MendCommandDefinition[]): Dispose
    trigger(value: string): void
    show(): void
  }
  route: {
    register(routes: MendRouteDefinition[]): Dispose
    navigate(name: MendRouteName, params?: Record<string, unknown>): void
    current: {
      name: MendRouteName
      params?: Record<string, unknown>
    }
  }
  ui: {
    overlay: MendOverlayApi
    runtime: MendUiRuntimeApi
  } & Record<string, unknown>
  slots: {
    register(input: MendSlotRegistration): Dispose
  }
  theme: {
    current: MendTheme
    selected: string
    has(name: string): boolean
    set(name: string): Promise<boolean> | boolean
    install(path: string): Promise<void>
    mode(): MendThemeMode
    ready: boolean
  }
  keybind: unknown
  kv: {
    get<T>(key: string, fallback?: T): T
    set(key: string, value: unknown): void
    ready: boolean
  }
  session: TuiSessionApi
  metadata: TuiSessionMetadataApi
  ai: TuiAiApi
  memory: TuiMemoryApi
  state: {
    customization: {
      capabilities(): string[]
    }
  } & Record<string, unknown>
  events?: unknown
  client: unknown
  lifecycle: {
    signal: AbortSignal
    onDispose(cb: () => void | Promise<void>): Dispose
  }
}

export type MendExtensionModule = {
  id: string
  activate(api: MendExtensionApi, options?: Record<string, unknown>): Promise<void> | void
}
