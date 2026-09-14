import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import { rm, symlink } from "node:fs/promises"
import path from "node:path"

import { tmpdir } from "../fixture/fixture"
import {
  createCompoundSnapshot,
  fingerprintCompoundCandidate,
  snapshotFingerprintChanged,
} from "../../src/session/compound-snapshot"
import { compoundRecoveryResult, compoundReceiptOutcome } from "../../src/session/workflow-runner"
import { WorkflowPhaseID, WorkflowTaskID, type WorkflowTask } from "../../src/session/workflow"

const phaseID = WorkflowPhaseID.make("isolation-phase")
const taskID = WorkflowTaskID.make("isolation-task")

const compoundTask = (): Pick<WorkflowTask, "compound"> & { readonly compoundReceipt?: unknown } => ({
  compound: {
    profile: "fixture",
    validationChecks: [{ id: "check", command: "git diff --check" }],
  },
})

const receipt = (outcome: "accepted" | "blocked") => ({
  version: 1,
  profile: "fixture",
  strategy: "single",
  outcome,
  validation: [],
  legs: [],
  reviewLimitations: [],
  ledger: {
    version: 1,
    limits: { maxModelRequests: 1, maxTotalTokens: 100, maxRuntimeMs: 60_000, unknownCost: "block" },
    records: [],
  },
})

describe("compound candidate isolation", () => {
  test("freezes added, modified and deleted text files and detects later mutations", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "modified.txt"), "baseline\n")
    await Bun.write(path.join(tmp.path, "deleted.txt"), "to be deleted\n")
    await $`git add modified.txt deleted.txt`.cwd(tmp.path).quiet()
    await $`git commit -m baseline`.cwd(tmp.path).quiet()
    await Bun.write(path.join(tmp.path, "modified.txt"), "candidate\n")
    await Bun.write(path.join(tmp.path, "added.txt"), "new candidate\n")
    await rm(path.join(tmp.path, "deleted.txt"))

    const result = await createCompoundSnapshot({ cwd: tmp.path })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.snapshot.files.map((file) => [file.path, file.state])).toEqual([
      ["added.txt", "added"],
      ["deleted.txt", "deleted"],
      ["modified.txt", "modified"],
    ])
    expect(result.snapshot.files.find((file) => file.path === "deleted.txt")).toMatchObject({ content: "", byteLength: 0 })
    expect(result.snapshot.diff).toContain("candidate")
    expect(result.snapshot.patchDigest).toMatch(/^[0-9a-f]{64}$/)

    const before = result.snapshot.candidateFingerprint
    await Bun.write(path.join(tmp.path, "modified.txt"), "mutated after review\n")
    const after = await fingerprintCompoundCandidate(tmp.path)
    expect(snapshotFingerprintChanged(before, after)).toBe(true)
  })

  test("fails closed for unsupported links, file-count overflow and oversized text", async () => {
    await using links = await tmpdir({ git: true })
    await Bun.write(path.join(links.path, "target.txt"), "target\n")
    await symlink("target.txt", path.join(links.path, "link.txt"))
    const linkResult = await createCompoundSnapshot({ cwd: links.path })
    expect(linkResult).toMatchObject({ ok: false, code: "unsupported-link" })

    await using many = await tmpdir({ git: true })
    await Promise.all(Array.from({ length: 33 }, (_, index) => Bun.write(path.join(many.path, `file-${index}.txt`), `${index}\n`)))
    const countResult = await createCompoundSnapshot({ cwd: many.path, maxFiles: 32 })
    expect(countResult).toMatchObject({ ok: false, code: "too-many-files" })

    await using large = await tmpdir({ git: true })
    await Bun.write(path.join(large.path, "large.txt"), "0123456789")
    const sizeResult = await createCompoundSnapshot({ cwd: large.path, maxBytes: 8 })
    expect(sizeResult).toMatchObject({ ok: false, code: "too-large" })
  })

  test("blocks restart reconciliation without a terminal compound receipt", () => {
    const task = compoundTask()
    const ordinaryTerminal = { state: "completed" as const, summary: "provider said done" }

    expect(compoundReceiptOutcome(undefined)).toBeUndefined()
    expect(compoundRecoveryResult({ task })).toBeUndefined()
    const blocked = compoundRecoveryResult({ task, terminalResult: ordinaryTerminal })
    expect(blocked).toMatchObject({ state: "blocked", failureClass: "environment" })
    expect(blocked?.error).toContain("automatic replay is disabled")

    expect(compoundReceiptOutcome(receipt("accepted"))).toBe("accepted")
    expect(compoundRecoveryResult({ task: { ...task, compoundReceipt: receipt("accepted") }, terminalResult: ordinaryTerminal })).toMatchObject({
      state: "completed",
      summary: "provider said done",
    })
    expect(compoundRecoveryResult({ task: { ...task, compoundReceipt: receipt("blocked") } })).toMatchObject({
      state: "blocked",
      failureClass: "policy",
    })
  })
})
