import { createComponent, createSignal, ErrorBoundary, type JSX } from "solid-js"
import { capabilityAllowed } from "./capabilities"
import { clearActiveCustomization, upsertActiveCustomization } from "./customization-state"
import type { MendPromptChromeConfig } from "./prompt-chrome"
import type { MendTrustTier } from "./trust"

export type MendEditorHostInput = {
  sessionID?: string
  workspaceID?: string
  permissionMode?: string
  permissionModeLabel?: string
  permissionPending?: number
  visible?: boolean
  disabled?: boolean
  onSubmit?: () => void
  right?: unknown
  ref?: ((ref: any) => void) | undefined
  defaultEditor: () => unknown
}

export type MendEditorFactory = (input: MendEditorHostInput) => unknown

export type MendEditorVisualConfig = {
  showPlaceholder?: boolean
  normalPrefix?: string
  shellPrefix?: string
  normalExamples?: string[]
  shellExamples?: string[]
  borderGlyph?: string
  footerGlyph?: string
  chrome?: Partial<MendPromptChromeConfig>
}

const [editorFactory, setEditorFactory] = createSignal<MendEditorFactory | undefined>()
const [editorVisual, setEditorVisualStore] = createSignal<MendEditorVisualConfig | undefined>()

export function setMendEditor(factory?: MendEditorFactory, trust: MendTrustTier = "trusted") {
  if (factory && !capabilityAllowed("session.prompt.fullEditor", trust)) return false
  setEditorFactory(() => factory)
  if (!factory) clearActiveCustomization("session.prompt.fullEditor", "session.prompt.fullEditor")
  else upsertActiveCustomization({ surface: "session.prompt.fullEditor", source: "session.prompt.fullEditor", trust, detail: "factory" })
  return true
}

export function getMendEditor() {
  return editorFactory()
}

export function setMendEditorVisual(config?: MendEditorVisualConfig, trust: MendTrustTier = "trusted") {
  if (config && !capabilityAllowed("session.prompt.visual", trust)) return false
  setEditorVisualStore(() => config)
  if (!config) clearActiveCustomization("session.prompt.visual", "session.prompt.visual")
  else {
    upsertActiveCustomization({
      surface: "session.prompt.visual",
      source: "session.prompt.visual",
      trust,
      detail: [config.borderGlyph, config.footerGlyph, config.showPlaceholder === false ? "placeholder:hidden" : undefined]
        .filter(Boolean)
        .join(" · "),
    })
  }
  return true
}

export function readMendEditorVisual() {
  return editorVisual()
}

export function renderMendEditor(input: MendEditorHostInput): JSX.Element {
  const factory = editorFactory()
  if (!factory) return input.defaultEditor() as JSX.Element
  let rendered: JSX.Element
  try {
    rendered = factory(input) as JSX.Element
  } catch {
    return input.defaultEditor() as JSX.Element
  }
  return createComponent(ErrorBoundary, {
    fallback: () => input.defaultEditor() as JSX.Element,
    get children() {
      return rendered
    },
  })
}
