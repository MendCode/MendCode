import { createSignal } from "solid-js"
import { capabilityAllowed } from "./capabilities"
import { clearActiveCustomization, upsertActiveCustomization } from "./customization-state"
import type { MendTrustTier } from "./trust"

export type MendWidgetPlacement = "aboveEditor" | "belowEditor" | "sessionBottomDock"

export type MendWidgetEntry = {
  id: string
  placement: MendWidgetPlacement
  order: number
  render: () => unknown
  trust: MendTrustTier
}

const [widgets, setWidgets] = createSignal<MendWidgetEntry[]>([])

function widgetSurface(placement: MendWidgetPlacement) {
  if (placement === "belowEditor") return "editor.widget.below"
  if (placement === "sessionBottomDock") return "session.bottomDock"
  return "editor.widget.above"
}

export function setMendWidget(
  id: string,
  render?: (() => unknown) | undefined,
  input: { placement?: MendWidgetPlacement; order?: number; trust?: MendTrustTier } = {},
) {
  const placement = input.placement ?? "aboveEditor"
  const surface = widgetSurface(placement)
  if (!capabilityAllowed(surface, input.trust)) return false
  if (!render) {
    for (const item of widgets().filter((entry) => entry.id === id)) {
      clearActiveCustomization(widgetSurface(item.placement), id)
    }
    setWidgets((list) => list.filter((item) => item.id !== id))
    return true
  }
  for (const item of widgets().filter((entry) => entry.id === id && entry.placement !== placement)) {
    clearActiveCustomization(widgetSurface(item.placement), id)
  }
  const next = { id, render, placement, order: input.order ?? 0, trust: input.trust ?? "trusted" }
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
