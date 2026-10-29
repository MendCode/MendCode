import type { CommandReply } from "@mendcode/client"
import type { UsageReport } from "@mendcode/protocol"
import { appHarness, conversation, ids, NOW, tempDir } from "./session-ui-harness"

export const UI5_PAGES = ["context", "storage", "changes", "memory", "mcps", "tools", "packages", "loops", "workflows", "agents", "status", "extensions", "providers", "connect", "secrets", "timeline", "permissions", "model", "settings", "help", "sessions", "diagram"] as const
export const UI5_RELAID = ["context", "storage", "agents", "status", "extensions", "providers", "connect", "secrets", "timeline", "model", "settings"] as const

export function usageFixture(): UsageReport {
  const days = Array.from({ length: 365 }, (_, index) => {
    const at = new Date(2026, 8, 30 - index, 12)
    const day = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`
    const n = index % 7 === 0 ? 0 : (index % 11 + 1) * 1000
    return { day, input: n, output: n / 5, reasoning: n / 10, cacheRead: n * 2, cacheWrite: 0, costMicros: n, costUnknownCalls: 0, calls: n / 1000, sessions: n ? 1 : 0 }
  })
  const sessionId = ids("session")
  const topSessions = [{ sessionId, title: "Review reconnection", directory: "/work/project", tokens: 92_400, ms: 480_000, turns: 12 }]
  return { from: days.at(-1)!.day, to: days[0]!.day, days, models: [
    { provider: "local", model: "dev-model", input: 82_000, output: 14_000, calls: 24, costMicros: 0, costUnknownCalls: 24 },
    { provider: "fixture", model: "priced-model", input: 10_000, output: 2400, calls: 6, costMicros: 120_000, costUnknownCalls: 0 },
  ], quotas: [{ type: "quota.snapshot", gseq: 1, at: NOW, provider: "local", windows: [{ id: "5h", label: "5h", windowMinutes: 300, usedPercent: 24, resetsAt: NOW + 3_600_000 }, { id: "7d", label: "7d", windowMinutes: 10_080, usedPercent: 62, resetsAt: NOW + 86_400_000 }], fetchedAt: NOW, source: "local fake" }],
    sessions: 36, activity: days.filter((day) => day.input > 0).map((day) => ({ day: day.day, prompts: 3, words: 72, aiMs: 12_000, toolMs: 4_000, longestAiMs: 8000 })), tools: [{ tool: "read", calls: 76, ms: 1800, errors: 0 }, { tool: "shell", calls: 24, ms: 42_000, errors: 1 }], insights: { streak: { current: 4, longest: 6 }, efforts: [{ effort: "medium", turns: 30 }], skills: [{ skill: "review", runs: 8 }], topSessions, longestSession: topSessions[0]! } }
}

export function ui5Harness(width = 160, height = 45) {
  const dataDir = tempDir("mend-ui5-data-")
  const directory = tempDir("mend-ui5-project-")
  const sessionId = ids("session")
  const other = ids("session")
  const models = { engine: "native", selectable: true, models: [{ id: "local/dev-model", name: "Development model", provider: "local", efforts: ["low", "medium", "high"], defaultEffort: "medium", contextWindow: 272_000 }], defaults: { model: "local/dev-model", effort: "medium" }, effective: { model: "local/dev-model", effort: "medium" }, roles: {} }
  const sessions = [sessionId, other].map((id, i) => ({ sessionId: id, directory, title: i ? "Check local tests" : "Review reconnection", createdAt: NOW - 3_600_000, updatedAt: NOW - i * 60_000, state: i ? "generating" : "idle", queued: 0, lastSeq: 0 }))
  const memories = [{ memoryId: ids("memory"), scope: "project", directory, text: "Tests use isolated temporary directories and local provider fakes.", category: "testing", status: "pending", source: "agent", createdAt: NOW - 1000, updatedAt: NOW }]
  const loops = [{ loopId: ids("loop"), sessionId, name: "Watch local checks", directory, objective: "Inspect local check results", state: "active", trigger: { kind: "interval", everyMs: 60_000 }, budget: { mode: "fixed", maxRuns: 4 }, runs: 1, history: [], nextWakeAt: NOW + 45_000, createdAt: NOW - 60_000, updatedAt: NOW }]
  const workflows = [{ workflowId: ids("workflow"), rootSessionId: sessionId, name: "Review release", directory, objective: "Review the local release", planHash: "0".repeat(64), permission: "edits", state: "running", tasks: [{ id: "review", title: "Review source", kind: "agent", mode: "work", needs: [], state: "running", attempt: 1 }], rounds: 0, repairs: 0, startedAt: NOW - 10_000, updatedAt: NOW }]
  const report = usageFixture()
  const h = appHarness({ width, height, sessionId, dataDir, directory, version: "0.4.2", reply: (command) => {
    let result: unknown
    switch (command.type) {
      case "settings.get": result = { settings: { onboarded: true } }; break
      case "usage.query": result = report; break
      case "session.list": result = { sessions }; break
      case "models.list": result = models; break
      case "agents.list": result = { current: "build", agents: [{ name: "build", description: "Build and verify", mode: "primary", source: "builtin", trusted: true }] }; break
      case "recipes.list": result = { recipes: [] }; break
      case "daemon.info": result = { engine: "native", pid: 1, dataDir, buildId: "ui5-fixture", version: "0.4.2" }; break
      case "git.branch": result = { branch: "main" }; break
      case "context.query": result = { model: "local/dev-model", estimatedTokens: 8200, measuredTokens: 8400, compactAtTokens: 24_000, images: 0, sections: [{ id: "system", label: "System instructions", chars: 8000, tokens: 2000 }, { id: "history", label: "History", chars: 24000, tokens: 6000, count: 12 }, { id: "tools", label: "Tools", chars: 800, tokens: 200, count: 4 }], largest: [{ role: "user", chars: 1400, tokens: 350, preview: "Review the reconnection path and preserve pending requests." }, { role: "tool", chars: 800, tokens: 200, preview: "Local checks passed." }] }; break
      case "storage.report": result = { dbBytes: 4_000_000, walBytes: 200_000, blobBytes: 2_000_000, blobs: 6, orphanBlobs: 1, orphanBytes: 100_000, sessions: 36, events: 4200, eventBytes: 2_400_000, engineBytes: 800_000, otherBytes: 800_000, freeBytes: 200_000, autoVacuum: "incremental", topSessions: sessions.map((session, i) => ({ ...session, bytes: 800_000 - i * 200_000 })) }; break
      case "changes.query": result = { root: directory, branch: "main", files: [{ path: "src/reconnect.ts", status: "modified", additions: 2, deletions: 1, binary: false, truncated: false, diff: "@@ -1,2 +1,3 @@\n const connected = true\n-oldRetry()\n+await retry()\n+preserveRequests()" }], omittedFiles: 0 }; break
      case "memory.list": result = { memories }; break
      case "memory.graph": result = { facts: [], links: [], categories: [], partial: false }; break
      case "mcp.status": result = { servers: [{ name: "local-search", command: "./local-mcp", enabled: true, state: "running", tools: 4, pid: 42, stderr: ["Ready"] }], issues: [] }; break
      case "tools.list": result = { directory, tools: [{ name: "checks", toolName: "custom__checks", source: "project", file: `${directory}/checks.json`, command: ["./checks"], description: "Run local checks", trusted: true }], issues: [] }; break
      case "packages.list": result = { directory, packages: [{ name: "local-tools", key: "project:local-tools", source: "project", dir: `${directory}/local-tools`, enabled: true, manifest: { name: "local-tools", version: "1.0.0", description: "Local development tools" }, contents: { tools: 2, skills: 1, commands: 0, themes: 0, mcp: false } }] }; break
      case "loop.list": result = { loops }; break
      case "workflow.list": result = { workflows }; break
      case "background.list": result = { tasks: [{ sessionId, id: "bg-checks", cwd: directory, command: "bun test", status: "running", startedAt: NOW - 1000 }] }; break
      case "extensions.list": result = { directory, extensions: [{ name: "local-review", source: "user", file: `${directory}/review.ts`, trusted: true, daemon: true, tui: false, hooks: ["tool.after"], tools: ["review"], commands: [], errors: [] }] }; break
      case "providers.list": result = { providers: [{ id: "local", type: "openai-compatible", source: "config", enabled: true, hasKey: false, models: [{ id: "dev-model" }], baseUrl: "http://127.0.0.1:9999/v1" }] }; break
      case "secrets.list": result = { secrets: [{ n: 1, kind: "test token", tail: "TEST", createdAt: NOW - 60_000 }] }; break
      case "session.timeline": result = { entries: [{ turnId: ids("turn"), itemId: ids("item"), at: NOW - 60_000, preview: "Review reconnection and preserve pending requests.", reverted: false }, { turnId: ids("turn"), itemId: ids("item"), at: NOW, preview: "Check the local test results.", reverted: false }] }; break
      case "permissions.list": result = { grants: [] }; break
      case "sidebar.get": result = { widgets: [], scope: "user" }; break
      case "session.events": result = { events: [], firstSeq: 0, lastSeq: 0, sessionLastSeq: 0, more: false }; break
    }
    return { ok: true, ...(result ? { result } : {}) } as CommandReply
  } })
  h.app.applySettings({ onboarded: true, compactAtTokens: 24_000, models: { main: { model: "local/dev-model" } } })
  const chat = conversation(sessionId, (event) => h.app.onEvent(event))
  chat.exchange("Review reconnection", "The connection preserves pending requests.\n\n```mermaid\nflowchart LR\n  Prompt --> Agent\n  Agent --> Tools\n```")
  h.app.onGlobal({ type: "session.activity", gseq: 1, at: NOW, ...sessions[1]! } as never)
  return { ...h, report, chat }
}
