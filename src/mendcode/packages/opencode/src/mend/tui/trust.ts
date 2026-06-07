export type MendTrustTier = "trusted" | "experimental" | "blocked"

export type MendCapabilityStatus = "available" | "experimental" | "blocked"

export function allowsCapability(status: MendCapabilityStatus, trust: MendTrustTier = "trusted") {
  if (status === "blocked") return false
  if (status === "experimental") return trust !== "blocked"
  return trust === "trusted" || trust === "experimental"
}

export function capabilityTrustLabel(trust: MendTrustTier) {
  if (trust === "trusted") return "trusted runtime"
  if (trust === "experimental") return "experimental"
  return "blocked"
}
