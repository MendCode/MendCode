import {
  blockedCustomizationCapabilities,
  mendTuiCapabilityVersion,
  resolveCustomizationIntent,
  visibleCustomizationCapabilities,
} from "../tui/capabilities"

export function composeCustomizationCapabilitySection() {
  const lines = [
    "MendCode TUI customization capabilities:",
    `- Contract version: ${mendTuiCapabilityVersion()}`,
    "- Prefer MendCode-owned seams before hot-path edits.",
  ]
  for (const capability of visibleCustomizationCapabilities()) {
    lines.push(
      `- ${capability.id}: ${capability.status} (${capability.tier}, ${capability.trust}) — runtime ${capability.runtimeIDs.join(", ")} — ${capability.docs}`,
    )
  }
  const routes = [
    resolveCustomizationIntent("add a widget to the status bar"),
    resolveCustomizationIntent("change the chat input border"),
    resolveCustomizationIntent("replace the whole chat editor"),
    resolveCustomizationIntent("override the prompt parser"),
  ]
  lines.push("- Routing examples:")
  for (const item of routes) {
    lines.push(
      `  - ${item.request} -> ${item.surface || "unknown"}${item.operation ? ` (${item.operation})` : ""}; ${item.reason}`,
    )
  }
  lines.push(
    `- Protected/blocked in v1: ${blockedCustomizationCapabilities()
      .map((item) => `${item.id} -> ${item.nearestSafeAlternatives.join("/")}`)
      .join(", ")}`,
  )
  lines.push("- When a requested capability is blocked or unsupported, name the blocker and route to the nearest safe surface instead of implying Pi-style arbitrary control.")
  return lines.join("\n")
}
