import { appHarness, ids, NOW, tempDir } from "./session-ui-harness"
import type { Loop } from "@mendcode/protocol"

export function loopBudgetExample(over: Partial<Loop> = {}): Loop {
  return {
    loopId: ids("loop"), sessionId: ids("session"), directory: "/work/mendcode", name: "CI repair", objective: "Repair failing CI and verify the regression tests", criteria: "Tests pass and the fix is documented",
    trigger: { kind: "manual" }, budget: { mode: "goal", maxRuns: 5 }, audit: "independent", checks: ["bun test"], state: "blocked", runs: 1, createdAt: NOW - 60_000, updatedAt: NOW,
    costBudget: { maxTokens: 50_000, maxCost: 2, unknownCost: "block" }, usage: { tokens: 12_345, costMicros: 120_000, unknownCostCalls: 0 }, approvalPolicy: { requireApprovalFor: ["push", "deploy"] },
    rubric: { name: "Release evidence", passThreshold: 0.85, criteria: [{ id: "tests", description: "Regression tests pass", weight: 3, minScore: 5, evidenceRequired: ["success checks", "validation output"] }, { id: "docs", description: "Change documented", weight: 1, evidenceRequired: ["README.md"] }] },
    reason: "Completion claim rejected: documentation evidence missing",
    history: [{ run: 1, startedAt: NOW - 60_000, endedAt: NOW, outcome: "completed", checkpoint: { status: "complete", summary: "Fixed CI and added the regression test", evidence: ["test/client.test.ts:42"] }, checkpointHash: "a".repeat(64), usage: { tokens: 12_345, costMicros: 120_000, unknownCostCalls: 0 }, gates: [{ id: "bun test", status: "pass", detail: "12 tests passed" }, { id: "independent-audit", status: "pass", detail: "Regression test exercises the reconnect path" }, { id: "rubric", status: "fail", failureClass: "quality", detail: "75% / 85%" }], rubricResult: { status: "fail", score: 0.75, threshold: 0.85, criteria: [{ id: "tests", score: 5, maxScore: 5, passed: true, reason: "Required runtime evidence is present.", evidence: ["success checks", "validation output"] }, { id: "docs", score: 0, maxScore: 5, passed: false, reason: "Missing required evidence: README.md.", evidence: [] }], blockers: [] } }],
    ...over,
  }
}

export function loopBudgetHarness(width = 100, height = 30, loop = loopBudgetExample()) {
  const h = appHarness({ width, height, dataDir: tempDir("mendcode-b44-ui-"), directory: loop.directory, reply: (command) => command.type === "loop.list" ? { ok: true, result: { loops: [loop] } } : undefined })
  return { ...h, loop }
}
