import { describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"

import { fingerprintWorkspace } from "../../src/session/completion-auditor"
import {
  compileCompletionCriteria,
  decideCompletionAudit,
  nextCompletionProgress,
  type CompletionAuditReceipt,
  type CompletionProgress,
} from "../../src/session/completion-contract"
import { workflowCompletionAuditReceipt } from "../../src/session/workflow-runner"
import { tmpdir } from "../fixture/fixture"

const progress: CompletionProgress = {
  status: "auditing",
  generation: 2,
  sourceID: "run-2",
  auditAttempts: 1,
  candidateFingerprint: "workspace-a",
  createdAt: 1,
  updatedAt: 2,
}

const receipt = (patch: Partial<CompletionAuditReceipt> = {}): CompletionAuditReceipt => ({
  generation: 2,
  status: "pass",
  summary: "The current workspace satisfies every completion criterion.",
  criteria: [
    {
      id: "criterion-1",
      status: "pass",
      summary: "Focused validation passed.",
      evidence: [{ id: "audit:criterion-1:1", kind: "observation", summary: "Focused validation passed." }],
    },
  ],
  fingerprintBefore: "workspace-a",
  fingerprintAfter: "workspace-a",
  recommendedNextAction: "complete",
  createdAt: 3,
  ...patch,
})

describe("completion contract", () => {
  test("next-run confirmation creates a durable candidate instead of completing", () => {
    const result = nextCompletionProgress({
      confirmation: "next-run",
      workSatisfied: true,
      sourceID: "run-1",
      now: 10,
    })
    expect(result.terminal).toBe(false)
    expect(result.progress).toMatchObject({ status: "candidate", generation: 1, sourceID: "run-1" })
  })

  test("same-run confirmation preserves legacy completion", () => {
    expect(nextCompletionProgress({ confirmation: "same-run", workSatisfied: true, sourceID: "run-1", now: 10 })).toEqual({ terminal: true })
  })

  test("completes only when every criterion has structured evidence", () => {
    expect(decideCompletionAudit({
      progress,
      receipt: receipt(),
      criteria: compileCompletionCriteria(["focused validation passes"]),
      maxAuditAttempts: 2,
    })).toMatchObject({ outcome: "complete" })

    expect(decideCompletionAudit({
      progress,
      receipt: receipt({ criteria: [{ id: "criterion-1", status: "pass", summary: "Claimed only.", evidence: [] }] }),
      criteria: compileCompletionCriteria(["focused validation passes"]),
      maxAuditAttempts: 2,
    })).toMatchObject({ outcome: "retry-work", failedCriteria: ["criterion-1"] })
  })

  test("rejects stale generations and workspace fingerprints", () => {
    expect(decideCompletionAudit({
      progress,
      receipt: receipt({ generation: 1 }),
      criteria: compileCompletionCriteria(["done"]),
      maxAuditAttempts: 2,
    })).toMatchObject({ outcome: "blocked" })

    expect(decideCompletionAudit({
      progress,
      receipt: receipt({ fingerprintAfter: "workspace-b" }),
      criteria: compileCompletionCriteria(["done"]),
      maxAuditAttempts: 2,
    })).toMatchObject({ outcome: "retry-work" })
  })

  test("deterministic failures cannot be overridden by a passing auditor", () => {
    expect(decideCompletionAudit({
      progress,
      receipt: receipt(),
      criteria: compileCompletionCriteria(["done"]),
      gates: [{ id: "validation:focused", status: "fail", summary: "Focused test failed." }],
      maxAuditAttempts: 2,
    })).toMatchObject({ outcome: "retry-work", summary: "Focused test failed." })
  })

  test("blocked and approval gates retain their terminal authority", () => {
    expect(decideCompletionAudit({
      progress,
      receipt: receipt(),
      criteria: compileCompletionCriteria(["done"]),
      gates: [{ id: "validation:environment", status: "blocked", summary: "Validation environment unavailable." }],
      maxAuditAttempts: 2,
    })).toMatchObject({ outcome: "blocked", summary: "Validation environment unavailable." })

    expect(decideCompletionAudit({
      progress,
      receipt: receipt(),
      criteria: compileCompletionCriteria(["done"]),
      gates: [{ id: "approval:release", status: "awaiting_approval", summary: "Release approval required." }],
      maxAuditAttempts: 2,
    })).toMatchObject({ outcome: "needs-input", summary: "Release approval required." })
  })

  test("workflow audit parsing cannot turn evidence-free criterion claims into completion", () => {
    const audit = workflowCompletionAuditReceipt({
      result: {
        state: "completed",
        summary: JSON.stringify({
          status: "pass",
          summary: "Everything passed",
          criteria: [{ id: "criterion-1", status: "pass", summary: "Claimed pass", evidence: [] }],
          recommendedNextAction: "complete",
        }),
      },
      progress: { ...progress, generation: 3, candidateFingerprint: undefined },
      criteria: [{ id: "criterion-1", description: "Must have evidence" }],
      now: 4,
    })

    expect(audit).toMatchObject({ status: "pass", criteria: [{ status: "pass", evidence: [] }] })
    expect(decideCompletionAudit({
      progress: { ...progress, generation: 3, candidateFingerprint: undefined },
      receipt: audit,
      criteria: [{ id: "criterion-1", description: "Must have evidence" }],
      maxAuditAttempts: 2,
    })).toMatchObject({ outcome: "retry-work", failedCriteria: ["criterion-1"] })
  })

  test("workspace fingerprints hash untracked contents correctly from a nested directory", async () => {
    await using tmp = await tmpdir({ git: true })
    const nested = path.join(tmp.path, "nested")
    const file = path.join(nested, "untracked.txt")
    await mkdir(nested, { recursive: true })
    await Bun.write(file, "alpha")
    const first = await fingerprintWorkspace(nested)
    await Bun.write(file, "bravo")
    const second = await fingerprintWorkspace(nested)

    expect(first.status).toBe("ok")
    expect(second.status).toBe("ok")
    if (first.status !== "ok" || second.status !== "ok") throw new Error("Expected Git workspace fingerprints")
    expect(first.value).not.toBe(second.value)
  })
})
