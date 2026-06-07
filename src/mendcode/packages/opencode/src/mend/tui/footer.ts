import { createSignal } from "solid-js"
import { capabilityAllowed } from "./capabilities"
import { clearActiveCustomization, upsertActiveCustomization } from "./customization-state"
import type { MendTrustTier } from "./trust"

export type MendFooterEntry = {
  id: string
  render: () => unknown
  order: number
  trust: MendTrustTier
}

const [footerRenderer, setFooterRenderer] = createSignal<(() => unknown) | undefined>()
const [footerEntries, setFooterEntries] = createSignal<MendFooterEntry[]>([])

export function setMendFooter(renderer?: (() => unknown) | undefined, trust: MendTrustTier = "trusted") {
  if (renderer && !capabilityAllowed("footer.replace", trust)) return false
  setFooterRenderer(() => renderer)
  if (!renderer) clearActiveCustomization("footer.replace", "footer.replace")
  else upsertActiveCustomization({ surface: "footer.replace", source: "footer.replace", trust, detail: "replacement" })
  return true
}

export function getMendFooter() {
  return footerRenderer()
}

export function setMendFooterEntry(id: string, render?: (() => unknown) | undefined, input: { order?: number; trust?: MendTrustTier } = {}) {
  if (render && !capabilityAllowed("footer.entry", input.trust)) return false
  if (!render) {
    setFooterEntries((list) => list.filter((item) => item.id !== id))
    clearActiveCustomization("footer.entry", id)
    return true
  }
  const next = { id, render, order: input.order ?? 0, trust: input.trust ?? "trusted" }
  setFooterEntries((list) => [...list.filter((item) => item.id !== id), next].toSorted((a, b) => a.order - b.order || a.id.localeCompare(b.id)))
  upsertActiveCustomization({
    surface: "footer.entry",
    source: id,
    trust: next.trust,
    detail: "footer-entry",
  })
  return true
}

export function listMendFooterEntries() {
  return footerEntries()
}
