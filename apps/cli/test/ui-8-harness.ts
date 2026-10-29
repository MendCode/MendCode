import type { CommandReply } from "@mendcode/client"
import type { ContextReport } from "@mendcode/protocol"
import { DEFAULT_TUI_PROFILE, writeTuiProfile } from "../src/view/tui-profile"
import { appHarness, ids, tempDir, type HarnessOptions } from "./session-ui-harness"
import { usageFixture } from "./ui-5-harness"

export const SCRATCH_TEXT = "A scratchpad keeps project notes together. Review the reconnect behavior and preserve pending requests. ".repeat(24)
export const UI8_SIZES = [[60, 20], [100, 30], [180, 50], [220, 60]] as const

export function contextFixture(large = false): ContextReport {
  const counts = large ? [5400, 11000, 8000, 2800, 3400, 2100, 143300] : [2000, 3000, 600, 100, 200, 300, 1200]
  const categories = ["system", "tools", "mcp", "agents", "memory", "skills", "messages"].map((id, i) => ({ id, label: id, tokens: counts[i]!, chars: counts[i]! * 4, count: [1, 18, 3, 2, 4, 6, large ? 120 : 4][i]! }))
  const largest = large ? [
    { role: "tool" as const, chars: 192000, tokens: 48000, preview: "shell: test run with verbose coverage and thousands of successful checks" },
    { role: "tool" as const, chars: 64000, tokens: 16000, preview: "read: src/reconnect.ts repeated full file contents" },
    { role: "assistant" as const, chars: 48000, tokens: 12000, preview: "Review of connection state and queued requests" },
    { role: "user" as const, chars: 8000, tokens: 2000, preview: "Preserve local changes and verify reconnect behavior" },
    { role: "tool" as const, chars: 4000, tokens: 1000, preview: "search: context report callers" },
  ] : [{ role: "user" as const, chars: 1600, tokens: 400, preview: "Check reconnection and preserve pending requests." }]
  return { model: "local/dev-model", sessionId: ids("session"), contextWindow: 200000, compactAtTokens: 160000, estimatedTokens: counts.reduce((a, b) => a + b, 0), measuredTokens: large ? 175400 : 7350, images: 0, categories, sections: categories, largest,
    mcpTools: ["search", "symbols", "callers"].map((name, i) => ({ id: `mcp__local__${name}`, label: `mcp__local__${name}`, tokens: i < 2 ? Math.floor(counts[2]! / 3) : counts[2]! - Math.floor(counts[2]! / 3) * 2, chars: 400, count: 1 })),
    repeatedReads: large ? [{ path: "src/reconnect.ts", count: 3, tokens: 24000 }] : [],
  }
}

export function ui8Harness(width = 180, height = 50, large = false, terminal = false, screen?: HarnessOptions["screen"]) {
  const dataDir = tempDir("mend-ui8-data-")
  const directory = tempDir("mend-ui8-project-")
  const sessionId = ids("session")
  const context = { ...contextFixture(large), sessionId }
  let scratch = SCRATCH_TEXT
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, theme: terminal ? "terminal" : "mend", pet: "off", images: "off", logoKind: "both" })
  const h = appHarness({ width, height, sessionId, dataDir, directory, version: "0.4.2", ...(screen ? { screen } : {}), reply(command) {
    let result: unknown
    switch (command.type) {
      case "context.query": result = context; break
      case "usage.query": result = usageFixture(); break
      case "scratchpad.get": result = { text: scratch }; break
      case "scratchpad.set": scratch = command.text; break
      case "models.list": result = { engine: "faux", selectable: false, models: [], defaults: { model: "local/dev-model", effort: "medium" }, effective: { model: "local/dev-model", effort: "medium" }, roles: {} }; break
      case "git.branch": result = { branch: "main" }; break
      case "session.list": result = { sessions: [] }; break
      case "background.list": result = { tasks: [] }; break
      case "mcp.status": result = { servers: [], issues: [] }; break
      case "agents.list": result = { current: "build", agents: [] }; break
      case "sidebar.get": result = { widgets: [] }; break
      case "recipes.list": result = { recipes: [] }; break
    }
    return { ok: true, ...(result ? { result } : {}) } as CommandReply
  } })
  h.app.applySettings({ onboarded: true, reducedMotion: true })
  return { ...h, context }
}
