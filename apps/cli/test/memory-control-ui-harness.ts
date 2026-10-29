import type { DreamRun, MemoryEntry } from "@mendcode/protocol"
import { appHarness, ids, NOW, tempDir } from "./session-ui-harness"

/** CLI-imported records use the existing native Memory Center; no alternate screen renderer. */
export function memoryControlHarness(width: number, height: number) {
  let memories: MemoryEntry[] = [{ memoryId: ids("memory"), scope: "user", profile: "personal", text: "Use pnpm 11 for dependencies", category: "commands", source: "agent", status: "pending", details: { tags: ["codex-import"] }, createdAt: NOW, updatedAt: NOW }]
  const run: DreamRun = { runId: 19, directory: "/work/app", status: "done", trigger: "manual", startedAt: NOW - 20_000, endedAt: NOW - 10_000, proposed: 1, notes: "consolidation preview: 0 applied, 0 archived, 1 pending", report: { read: { sessions: [], memories: 1, promptChars: 0 }, proposed: [], refused: [], redactions: { evidence: 0, proposals: 0 }, model: { calls: 0, inputTokens: 0, outputTokens: 0, estimated: false }, budget: { limit: 60_000, used: 0, stopped: false }, failures: [], consolidation: { policy: "preview", pendingBefore: 1, pendingAfter: 1, applied: 0, archived: 0, decisions: [{ memoryId: memories[0]!.memoryId, outcome: "preview", reason: "Confidence below .9" }] } } }
  const h = appHarness({ width, height, directory: "/work/app", dataDir: tempDir(), reply: (command) => {
    if (command.type === "memory.list") return { ok: true, result: { memories } }
    if (command.type === "memory.update") {
      memories = memories.map((memory) => memory.memoryId === command.memoryId ? { ...memory, ...(command.text ? { text: command.text } : {}), ...(command.status ? { status: command.status } : {}) } : memory)
      h.app.onGlobal({ type: "memory.changed", gseq: NOW, at: NOW, memoryId: command.memoryId, change: "updated" })
      return { ok: true }
    }
    if (command.type === "dream.list") return { ok: true, result: { runs: [run] } }
    if (command.type === "memory.categories") return { ok: true, result: { categories: [{ id: "commands", label: "Commands", description: "Project commands", defaultPolicy: "review", policy: "review" }] } }
    return undefined
  } })
  h.app.applySettings({ onboarded: true, memoryEnabled: true, memoryUse: true })
  return { ...h, setStatus: (status: MemoryEntry["status"]) => { memories = memories.map((memory) => ({ ...memory, status })) } }
}
