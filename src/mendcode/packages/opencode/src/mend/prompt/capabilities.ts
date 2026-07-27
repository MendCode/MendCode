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
    "- Live session chrome: Ctrl+P -> Customize TUI or /customize opens one grouped modal; Space/Enter applies toggles without restarting the TUI. Home/profile entries are actions opened with Enter, not toggles.",
    "- Public plugin API: api.ui.runtime.customization controls terminal title templates, deterministic session accents, diff file visibility, and reset; api.ui.runtime.setWidget controls plugin-owned widgets.",
    "- Rollback: use Reset TUI customization or api.ui.runtime.customization.reset(); this does not alter profiles, sessions, messages, or project data.",
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
  lines.push(
    "- When a requested capability is blocked or unsupported, name the blocker and route to the nearest safe surface instead of implying Pi-style arbitrary control.",
  )
  return lines.join("\n")
}
