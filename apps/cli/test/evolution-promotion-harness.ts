import type { EvolutionSuggestion, EvolutionMode } from "@mendcode/protocol"
import { appHarness, NOW, tempDir } from "./session-ui-harness"
import { run } from "./dream-fixtures"

const plan = {
  name: "Survey checks", objective: "Report the test strategy before changes",
  permission: "ask", tasks: [{ kind: "agent", id: "survey", title: "Survey", prompt: "Read test scripts and report gaps", mode: "read", needs: [] }],
  contract: { criteria: [{ id: "evidence", text: "Report cites inspected scripts", owners: ["survey"] }], checks: [], audit: "independent" },
}
export const WORKFLOW_CANDIDATE: EvolutionSuggestion = { suggestionId: 46, directory: "/work/app", kind: "workflow", name: "survey-checks", description: "Review the project's checks before changing code", content: JSON.stringify(plan, null, 2), evidence: 2, status: "pending", hash: "a".repeat(64), policyRevision: "review-1", createdAt: NOW - 60_000 }
const SKILL: EvolutionSuggestion = { ...WORKFLOW_CANDIDATE, suggestionId: 45, kind: "skill", name: "read-checks", description: "Inspect the configured checks", content: "Read package scripts and existing tests.\nReport their scope before editing.\nRun only the checks that cover the change.", hash: "b".repeat(64) }

export function evolutionHarness(width: number, height: number) {
  let suggestions = [structuredClone(WORKFLOW_CANDIDATE), structuredClone(SKILL)]
  let mode: EvolutionMode = "suggest", workflows = true, failure = false
  const report = { read: { sessions: [], memories: 0, promptChars: 840 }, proposed: [], refused: [], redactions: { evidence: 0, proposals: 0 }, model: { calls: 2, inputTokens: 210, outputTokens: 500, estimated: true }, budget: { limit: 60_000, used: 710, stopped: false }, failures: [], evolution: { mode: "suggest" as const, observed: { corrections: 2, preferences: 1, recurring: 1 }, suggested: { memories: 0, skills: 0, instructions: 0, workflows: 1 }, applied: 0 } }
  const h = appHarness({ width, height, directory: "/work/app", dataDir: tempDir(), reply: (command) => {
    if (command.type === "memory.list") return { ok: true, result: { memories: [] } }
    if (command.type === "memory.workspaces") return { ok: true, result: { workspaces: [], omitted: 0 } }
    if (command.type === "evolution.list") return { ok: true, result: { mode, workflows, policyRevision: "review-1", suggestions: structuredClone(suggestions), observed: { corrections: 2, preferences: 1, recurring: 1 } } }
    if (command.type === "settings.set") {
      if (command.patch.evolution) mode = command.patch.evolution as EvolutionMode
      if (typeof command.patch.evolutionWorkflows === "boolean") workflows = command.patch.evolutionWorkflows
      return { ok: true, result: { settings: { onboarded: true, evolution: mode, evolutionWorkflows: workflows } } }
    }
    if (command.type === "dream.list") return { ok: true, result: { runs: [run({ proposed: 1, report })] } }
    if (command.type === "evolution.promote" || command.type === "evolution.rollback" || command.type === "evolution.resolve") {
      if (failure) { failure = false; return { ok: false, error: { code: "invalid_command", message: "Artifact changed after promotion; manual review required" } } }
      const suggestion = suggestions.find((item) => item.suggestionId === command.suggestionId)!
      if (command.type === "evolution.promote") {
        const target = suggestion.kind === "workflow" ? "/work/app/.mendcode/workflows/evo-survey-checks-46.json" : "/work/app/.mendcode/skills/read-checks/SKILL.md"
        suggestion.status = "accepted"
        suggestion.receipt = { kind: suggestion.kind as "skill" | "workflow", target, hash: "c".repeat(64), revision: 1, promotedAt: NOW }
        return { ok: true, result: { suggestion: structuredClone(suggestion), path: target } }
      }
      if (command.type === "evolution.rollback") {
        suggestion.status = "rolled_back"
        suggestion.receipt = { ...suggestion.receipt!, revision: 2, rolledBackAt: NOW, archive: "/tmp/mendcode/evolution/retired/46/definition.json" }
      } else suggestion.status = command.decision === "reject" ? "rejected" : "accepted"
      return { ok: true, result: { suggestion: structuredClone(suggestion) } }
    }
    return undefined
  } })
  h.app.applySettings({ onboarded: true, evolution: mode, evolutionWorkflows: workflows })
  return { ...h, failNext: () => { failure = true }, empty: () => { suggestions = [] } }
}
