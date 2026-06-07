export type Dispose = () => void

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

export type MendUiRuntimeApi = {
  setStatus(id: string, value?: string, input?: { order?: number }): boolean
  clearStatus(id: string): boolean
  setWidget(id: string, render?: (() => unknown) | undefined, input?: { placement?: "aboveEditor" | "belowEditor"; order?: number }): boolean
  clearWidget(id: string): boolean
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
