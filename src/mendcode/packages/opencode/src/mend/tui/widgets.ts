import type { ParsedKey } from "@opentui/core"
import { createSignal } from "solid-js"
import { capabilityAllowed } from "./capabilities"
import { clearActiveCustomization, upsertActiveCustomization } from "./customization-state"
import type { MendTrustTier } from "./trust"

export type MendWidgetPlacement = "aboveEditor" | "belowEditor" | "sessionBottomDock"
export type MendWidgetSize = number | "auto"
export type MendWidgetRenderContext = {
  requestRender: () => void
  maxFps: number
}

export type MendWidgetOptions = {
  placement?: MendWidgetPlacement
  order?: number
  title?: string
  width?: MendWidgetSize
  minWidth?: number
  maxWidth?: number
  height?: MendWidgetSize
  interactive?: boolean
  onVisible?: () => boolean | void
  onFocus?: () => boolean | void
  onKey?: (event: ParsedKey) => boolean | void
  maxFps?: number
  requestRender?: () => void
  dispose?: () => void | Promise<void>
  trust?: MendTrustTier
}

export type MendWidgetEntry = {
  id: string
  placement: MendWidgetPlacement
  order: number
  render: (context: MendWidgetRenderContext) => unknown
  trust: MendTrustTier
  title?: string
  width?: MendWidgetSize
  minWidth?: number
  maxWidth?: number
  height?: MendWidgetSize
  interactive?: boolean
  onVisible?: () => boolean | void
  onFocus?: () => boolean | void
  onKey?: (event: ParsedKey) => boolean | void
  maxFps?: number
  requestRender?: () => void
  dispose?: () => void | Promise<void>
}

const [widgets, setWidgets] = createSignal<MendWidgetEntry[]>([])
const [focusedWidgetID, setFocusedWidgetID] = createSignal<string | undefined>()
const DEFAULT_WIDGET_MAX_FPS = 15
const MAX_WIDGET_MAX_FPS = 35
const lastWidgetRenderRequest = new Map<string, number>()

function widgetSurface(placement: MendWidgetPlacement) {
  if (placement === "belowEditor") return "editor.widget.below"
  if (placement === "sessionBottomDock") return "session.bottomDock"
  return "editor.widget.above"
}

function normalizeWidgetMaxFps(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  return Math.min(MAX_WIDGET_MAX_FPS, Math.max(1, Math.round(value)))
}

function disposeWidgetEntry(item: MendWidgetEntry) {
  const dispose = item.dispose
  if (!dispose) return
  void Promise.resolve(dispose()).catch((error) => {
    console.error("[mend.widget] dispose failed", {
      id: item.id,
      placement: item.placement,
      error,
    })
  })
}

function removeWidgetEntries(id: string, input: { dispose: boolean; blur: boolean }) {
  for (const item of widgets().filter((entry) => entry.id === id)) {
    clearActiveCustomization(widgetSurface(item.placement), id)
    lastWidgetRenderRequest.delete(item.id)
    if (input.dispose) disposeWidgetEntry(item)
  }
  setWidgets((list) => list.filter((item) => item.id !== id))
  if (input.blur) blurMendWidget(id)
}

export function setMendWidget(
  id: string,
  render?: ((context: MendWidgetRenderContext) => unknown) | undefined,
  input: MendWidgetOptions = {},
) {
  const placement = input.placement ?? "aboveEditor"
  const surface = widgetSurface(placement)
  if (!capabilityAllowed(surface, input.trust)) return false
  if (!render) {
    removeWidgetEntries(id, { dispose: true, blur: true })
    return true
  }
  const previous = widgets().find((entry) => entry.id === id)
  if (previous) removeWidgetEntries(id, { dispose: true, blur: previous.placement !== placement })
  const next = {
    id,
    render,
    placement,
    order: input.order ?? 0,
    trust: input.trust ?? "trusted",
    title: input.title,
    width: input.width,
    minWidth: input.minWidth,
    maxWidth: input.maxWidth,
    height: input.height,
    interactive: input.interactive,
    onVisible: input.onVisible,
    onFocus: input.onFocus,
    onKey: input.onKey,
    maxFps: normalizeWidgetMaxFps(input.maxFps),
    requestRender: input.requestRender,
    dispose: input.dispose,
  }
  setWidgets((list) => [...list.filter((item) => item.id !== id), next].toSorted((a, b) => a.order - b.order || a.id.localeCompare(b.id)))
  upsertActiveCustomization({
    surface,
    source: id,
    trust: next.trust,
    detail: placement,
  })
  return true
}

export function clearMendWidget(id: string) {
  return setMendWidget(id)
}

export function listMendWidgets(placement?: MendWidgetPlacement) {
  const list = widgets()
  return placement ? list.filter((item) => item.placement === placement) : list
}

export function focusMendWidget(id: string) {
  const item = widgets().find((entry) => entry.id === id && entry.interactive)
  if (!item) return false
  try {
    item.onFocus?.()
  } catch {
    return false
  }
  setFocusedWidgetID(id)
  return true
}

export function notifyMendWidgetVisible(id: string) {
  const item = widgets().find((entry) => entry.id === id)
  if (!item) return false
  try {
    item.onVisible?.()
  } catch {
    return false
  }
  return true
}

export function blurMendWidget(id?: string) {
  if (id && focusedWidgetID() !== id) return false
  setFocusedWidgetID(undefined)
  return true
}

export function readFocusedMendWidgetID() {
  return focusedWidgetID()
}

export function mendWidgetRenderContext(item: MendWidgetEntry): MendWidgetRenderContext {
  const maxFps = item.maxFps ?? DEFAULT_WIDGET_MAX_FPS
  return {
    requestRender: () => {
      const requestRender = item.requestRender
      if (!requestRender) return
      const now = Date.now()
      const interval = 1000 / maxFps
      const previous = lastWidgetRenderRequest.get(item.id) ?? 0
      if (now - previous < interval) return
      lastWidgetRenderRequest.set(item.id, now)
      requestRender()
    },
    maxFps,
  }
}
