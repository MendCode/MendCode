import { createSignal } from "solid-js"
import { capabilityAllowed } from "./capabilities"
import { clearActiveCustomization, upsertActiveCustomization } from "./customization-state"
import type { MendTrustTier } from "./trust"

export type MendOverlayAnchor = "top-center" | "center" | "bottom-center" | "top-left" | "top-right" | "bottom-left" | "bottom-right"
export type MendOverlaySize = number | `${number}%` | "auto"

export type MendOverlayRenderContext = {
  close: () => boolean
  requestRender: () => void
}

export type MendOverlayOptions = {
  anchor?: MendOverlayAnchor
  width?: MendOverlaySize
  height?: MendOverlaySize
  maxHeight?: MendOverlaySize
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
  onClose?: () => void | Promise<void>
  requestRender?: () => void
  trust?: MendTrustTier
}

export type MendOverlayEntry = {
  id: string
  render: (context: MendOverlayRenderContext) => unknown
  anchor: MendOverlayAnchor
  width?: MendOverlaySize
  height?: MendOverlaySize
  maxHeight?: MendOverlaySize
  margin: Required<NonNullable<MendOverlayOptions["margin"]>>
  nonCapturing: boolean
  modal: boolean
  title?: string
  trust: MendTrustTier
  onFocus?: () => boolean | void
  onClose?: () => void | Promise<void>
  requestRender?: () => void
}

const [overlays, setOverlays] = createSignal<MendOverlayEntry[]>([])
const [focusedOverlayID, setFocusedOverlayID] = createSignal<string | undefined>()

function overlaySurface(input: Pick<MendOverlayEntry, "nonCapturing">) {
  return input.nonCapturing ? "overlay.nonCapturing" : "overlay.custom"
}

function normalizeMargin(input: MendOverlayOptions["margin"]): MendOverlayEntry["margin"] {
  return {
    top: Math.max(0, input?.top ?? 1),
    right: Math.max(0, input?.right ?? 2),
    bottom: Math.max(0, input?.bottom ?? 1),
    left: Math.max(0, input?.left ?? 2),
  }
}

function disposeOverlayEntry(item: MendOverlayEntry) {
  const onClose = item.onClose
  if (!onClose) return
  void Promise.resolve(onClose()).catch((error) => {
    console.error("[mend.overlay] close handler failed", {
      id: item.id,
      error,
    })
  })
}

export function setMendOverlay(
  id: string,
  render?: ((context: MendOverlayRenderContext) => unknown) | undefined,
  input: MendOverlayOptions = {},
) {
  const nonCapturing = input.nonCapturing === true
  const surface = overlaySurface({ nonCapturing })
  if (!capabilityAllowed(surface, input.trust)) return false
  if (!render) return clearMendOverlay(id)
  if (!input.allowStack && overlays().some((item) => item.id !== id)) return false
  const previous = overlays().find((item) => item.id === id)
  if (previous) {
    clearActiveCustomization(overlaySurface(previous), id)
    disposeOverlayEntry(previous)
    if (focusedOverlayID() === id && nonCapturing) setFocusedOverlayID(undefined)
  }
  const next: MendOverlayEntry = {
    id,
    render,
    anchor: input.anchor ?? "top-center",
    width: input.width,
    height: input.height,
    maxHeight: input.maxHeight,
    margin: normalizeMargin(input.margin),
    nonCapturing,
    modal: input.modal === true,
    title: input.title,
    trust: input.trust ?? "trusted",
    onFocus: input.onFocus,
    onClose: input.onClose,
    requestRender: input.requestRender,
  }
  setOverlays((list) => [...list.filter((item) => item.id !== id), next])
  upsertActiveCustomization({
    surface,
    source: id,
    trust: next.trust,
    detail: next.anchor,
  })
  return true
}

export function clearMendOverlay(id: string) {
  for (const item of overlays().filter((entry) => entry.id === id)) {
    clearActiveCustomization(overlaySurface(item), id)
    disposeOverlayEntry(item)
  }
  setOverlays((list) => list.filter((item) => item.id !== id))
  if (focusedOverlayID() === id) setFocusedOverlayID(undefined)
  return true
}

export function listMendOverlays() {
  return overlays()
}

export function focusMendOverlay(id: string) {
  const item = overlays().find((entry) => entry.id === id)
  if (!item || item.nonCapturing) return false
  try {
    item.onFocus?.()
  } catch {
    return false
  }
  setFocusedOverlayID(id)
  return true
}

export function readFocusedMendOverlayID() {
  return focusedOverlayID()
}

export function mendOverlayRenderContext(item: MendOverlayEntry): MendOverlayRenderContext {
  return {
    close: () => clearMendOverlay(item.id),
    requestRender: item.requestRender ?? (() => {}),
  }
}
