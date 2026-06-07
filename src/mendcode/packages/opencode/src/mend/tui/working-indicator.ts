import { createSignal } from "solid-js"
import { capabilityAllowed } from "./capabilities"
import { clearActiveCustomization, upsertActiveCustomization } from "./customization-state"
import type { MendTrustTier } from "./trust"

export type MendWorkingIndicator = {
  frames?: string[]
  intervalMs?: number
  messages?: string[]
  messageIntervalMs?: number
  visible?: boolean
  showElapsed?: boolean
  showTokenUsage?: boolean
  trust: MendTrustTier
}

const [workingIndicator, setWorkingIndicator] = createSignal<MendWorkingIndicator>({ trust: "trusted" })

export function readMendWorkingIndicator() {
  return workingIndicator()
}

export function setMendWorkingIndicator(input?: Omit<MendWorkingIndicator, "trust"> & { trust?: MendTrustTier }) {
  if (!input) {
    setWorkingIndicator({ trust: "trusted" })
    clearActiveCustomization("workingIndicator.frames", "workingIndicator.frames")
    clearActiveCustomization("workingIndicator.visibility", "workingIndicator.visibility")
    clearActiveCustomization("workingIndicator.frames", "workingIndicator.text")
    return true
  }
  if (input.frames && !capabilityAllowed("workingIndicator.frames", input.trust)) return false
  if (typeof input.visible === "boolean" && !capabilityAllowed("workingIndicator.visibility", input.trust)) return false
  const trust = input.trust ?? "trusted"
  setWorkingIndicator({ ...input, trust })
  if (input.frames) {
    upsertActiveCustomization({
      surface: "workingIndicator.frames",
      source: "workingIndicator.frames",
      trust,
      detail: input.frames.join(" "),
    })
  }
  if (typeof input.visible === "boolean") {
    upsertActiveCustomization({
      surface: "workingIndicator.visibility",
      source: "workingIndicator.visibility",
      trust,
      detail: String(input.visible),
    })
  }
  if (input.messages?.length) {
    upsertActiveCustomization({
      surface: "workingIndicator.frames",
      source: "workingIndicator.text",
      trust,
      detail: input.messages.join(" | "),
    })
  }
  return true
}
