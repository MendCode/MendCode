import { createSignal } from "solid-js"
import type { MendCapabilityPublicID } from "./capabilities"
import type { MendTrustTier } from "./trust"

export type MendActiveCustomization = {
  surface: MendCapabilityPublicID
  source: string
  trust: MendTrustTier
  detail?: string
}

const [activeCustomizations, setActiveCustomizations] = createSignal<MendActiveCustomization[]>([])

export function listActiveCustomizations(surface?: MendCapabilityPublicID) {
  const list = activeCustomizations()
  return surface ? list.filter((item) => item.surface === surface) : list
}

export function upsertActiveCustomization(input: MendActiveCustomization) {
  setActiveCustomizations((list) => [
    ...list.filter((item) => !(item.surface === input.surface && item.source === input.source)),
    input,
  ].toSorted((a, b) => a.surface.localeCompare(b.surface) || a.source.localeCompare(b.source)))
}

export function clearActiveCustomization(surface: MendCapabilityPublicID, source: string) {
  setActiveCustomizations((list) => list.filter((item) => !(item.surface === surface && item.source === source)))
}

export function clearAllActiveCustomizations() {
  setActiveCustomizations([])
}
