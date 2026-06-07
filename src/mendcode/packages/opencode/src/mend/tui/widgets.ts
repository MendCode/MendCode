import { createSignal } from "solid-js"
import { capabilityAllowed } from "./capabilities"
import { clearActiveCustomization, upsertActiveCustomization } from "./customization-state"
import type { MendTrustTier } from "./trust"

export type MendWidgetPlacement = "aboveEditor" | "belowEditor"

export type MendWidgetEntry = {
  id: string
  placement: MendWidgetPlacement
  order: number
  render: () => unknown
  trust: MendTrustTier
}

const [widgets, setWidgets] = createSignal<MendWidgetEntry[]>([])

export function setMendWidget(
  id: string,
  render?: (() => unknown) | undefined,
  input: { placement?: MendWidgetPlacement; order?: number; trust?: MendTrustTier } = {},
) {
  const placement = input.placement ?? "aboveEditor"
  const surface = placement === "aboveEditor" ? "editor.widget.above" : "editor.widget.below"
  if (!capabilityAllowed(surface, input.trust)) return false
  if (!render) {
    setWidgets((list) => list.filter((item) => item.id !== id))
    clearActiveCustomization(surface, id)
    return true
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
