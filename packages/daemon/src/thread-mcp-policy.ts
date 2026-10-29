import { featureOn } from "@mendcode/protocol/wire"
import type { Settings } from "@mendcode/protocol"

export type BridgeEngine = "claude" | "codex" | `acp:${string}`
export function threadMcpEnabled(settings: Settings, engine: BridgeEngine, safeMode = false) {
  const optedIn = engine === "claude" || engine === "codex" ? settings.threadMcp?.[engine] : settings.threadMcp?.acp?.[engine.slice(4)]
  return settings.tier === "full" && !safeMode && optedIn === true && featureOn(settings, "mcp") && featureOn(settings, "thread_mcp")
}
