import { createSignal } from "solid-js"
import { capabilityAllowed } from "./capabilities"
import { clearActiveCustomization, upsertActiveCustomization } from "./customization-state"
import type { MendTrustTier } from "./trust"

export type MendStatusEntry = {
  id: string
  value?: string
  order: number
  trust: MendTrustTier
}

const [statusEntries, setStatusEntries] = createSignal<MendStatusEntry[]>([])

export function listMendStatusEntries() {
  return statusEntries()
}

export function setMendStatus(id: string, value?: string, input: { order?: number; trust?: MendTrustTier } = {}) {
  if (!capabilityAllowed("footer.entry", input.trust)) return false
  if (!value) {
    setStatusEntries((list) => list.filter((item) => item.id !== id))
    clearActiveCustomization("footer.entry", id)
    return true
  }
  const next = { id, value, order: input.order ?? 0, trust: input.trust ?? "trusted" }
  setStatusEntries((list) => [...list.filter((item) => item.id !== id), next].toSorted((a, b) => a.order - b.order || a.id.localeCompare(b.id)))
  upsertActiveCustomization({
    surface: "footer.entry",
    source: id,
    trust: next.trust,
    detail: value,
  })
  return true
}

export function clearMendStatus(id: string) {
  return setMendStatus(id)
}
