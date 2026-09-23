import { expect, test } from "bun:test"
import path from "node:path"
import { readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "../fixture/fixture"
import { defaultEvolutionConfig, evolutionPaths, writeEvolutionConsent, writeEvolutionJSON } from "../../src/mend/evolution/config"
import { recordEvolutionEvidence } from "../../src/mend/evolution/evidence"
import { createEvolutionCandidate, readEvolutionCandidates } from "../../src/mend/evolution/candidates"
import { promoteEvolutionCandidate, rollbackEvolutionCandidate } from "../../src/mend/evolution/promotion"
import { readEvolutionRunStatus, runEvolution } from "../../src/mend/evolution/runner"
import { WorkflowPlan } from "../../src/session/workflow-plan"
import { WorkflowDefinitionID } from "../../src/session/workflow"
import { WorkflowService } from "../../src/session/workflow-service"
import { makeRuntime } from "../../src/effect/run-service"
import { WithInstance } from "../../src/project/with-instance"
import { Effect, Stream } from "effect"
import type { LLM } from "../../src/session/llm"
import { collectEvolutionOutput, evolutionUsageTelemetry } from "../../src/mend/evolution/model"
import { budgetEnforcementStatus } from "../../src/mend/runtime/budget"
import { runScheduledEvolution } from "../../src/mend/memory/dream-scheduler"
import { readMemoryProposal, rollbackEvolutionMemoryProposal } from "../../src/mend/memory/proposals"
import { readMemoryEntries, readArchivedMemoryEntries, updateMemoryEntry } from "../../src/mend/memory/store"
import { readMemoryFacts, materializeLegacyMemoryFacts, isMemoryGraphVisibleFact } from "../../src/mend/memory/graph"

const finish = {
  type: "finish", finishReason: "stop", rawFinishReason: "stop",
  totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2,
    inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined },
    outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined } },
} satisfies LLM.Event

test("usage keeps missing and subscription prices unknown instead of free", async () => {
  await using tmp = await tmpdir()
  const budget = await budgetEnforcementStatus({}, tmp.path)
  const priced = { ...budget, authMode: "api-key", pricingPer1MTokens: { inputUsd: 2, cachedInputUsd: 0, outputUsd: 4 } }
  const usage = { ...finish.totalUsage, inputTokens: 1000, outputTokens: 100, totalTokens: 1100, inputTokenDetails: { ...finish.totalUsage.inputTokenDetails, cacheReadTokens: 200 } }
  expect(evolutionUsageTelemetry(usage, priced).cost.estimatedUsd).toBe(0.002)
  expect(evolutionUsageTelemetry(undefined, priced).cost.estimatedUsd).toBeNull()
  expect(evolutionUsageTelemetry(undefined, priced).usageNormalized.available).toBe(false)
  const subscription = evolutionUsageTelemetry(usage, { ...priced, authMode: "chatgpt-subscription-oauth" })
  expect(subscription.cost.available).toBe(false)
  expect(subscription.cost.estimatedUsd).toBeNull()
  expect(subscription.usageNormalized.totalTokens).toBe(1100)
  expect(JSON.stringify(subscription)).not.toContain("candidates")
})

test("native Evolution accepts only complete bounded provider output", async () => {
  const text = { type: "text-delta", id: "text", text: '{"candidates":[]}' } satisfies LLM.Event
  expect(await Effect.runPromise(collectEvolutionOutput(Stream.fromArray<LLM.Event>([text, finish])))).toBe(text.text)
  await expect(Effect.runPromise(collectEvolutionOutput(Stream.fromArray<LLM.Event>([text])))).rejects.toThrow("without completion")
  await expect(Effect.runPromise(collectEvolutionOutput(Stream.fromArray<LLM.Event>([text, { type: "error", error: new Error("private provider details") }])))).rejects.toThrow("provider stream failed")
  await expect(Effect.runPromise(collectEvolutionOutput(Stream.fromArray<LLM.Event>([text, { ...finish, finishReason: "length" }])))).rejects.toThrow("did not complete normally")
  await expect(Effect.runPromise(collectEvolutionOutput(Stream.fromArray<LLM.Event>([{ ...text, text: "x".repeat(32769) }, finish])))).rejects.toThrow("32 KiB")
})

const config = { ...defaultEvolutionConfig, mode: "suggest" as const, remoteProcessing: true, distillerRole: "memoryExtractor", outputs: { memory: true, skills: true, workflows: true } }

async function prepare(root: string, data: string) {
  const policy = await writeEvolutionConsent(root, config, data)
  const recorded = await recordEvolutionEvidence(root, { source: "correction", sessionID: "ses_test", turnID: "msg_test", outcome: "observed", text: "Project checks use bun test from the package directory." }, data)
  if (!recorded.recorded) throw new Error(recorded.reason)
  return { policy, evidence: recorded.entry }
}

async function automaticMemory(root: string, text: string) {
  const data = path.join(root, "data")
  await writeEvolutionConsent(root, { ...config, mode: "auto-safe" }, data)
  const evidence = await recordEvolutionEvidence(root, { source: "correction", sessionID: "ses_test", turnID: "auto", outcome: "observed", text }, data)
  if (!evidence.recorded) throw new Error(evidence.reason)
  const run = await runEvolution(root, { dataDir: data, model: async () => JSON.stringify({ candidates: [{ kind: "memory", name: "project-fact", description: "Project fact", content: text, evidenceIDs: [evidence.entry.id] }] }) })
  return readMemoryProposal(run.memoryProposals[0]!, root)
}

test("Auto-safe applies exact allowed corrections and rollback also retires graph projections", async () => {
  await using tmp = await tmpdir()
  const proposal = await automaticMemory(tmp.path, "Project language: TypeScript.")
  expect(proposal.status).toBe("applied")
  expect(proposal.policyDecision).toBe("auto-applied")
  expect(await readMemoryEntries("project", tmp.path)).toHaveLength(1)
  await materializeLegacyMemoryFacts(tmp.path)
  expect((await readMemoryFacts(tmp.path)).filter(isMemoryGraphVisibleFact)).toHaveLength(1)
  await writeEvolutionConsent(tmp.path, defaultEvolutionConfig, path.join(tmp.path, "data"))
  await rollbackEvolutionMemoryProposal(proposal.id, proposal.appliedEntryRevision!, tmp.path)
  expect(await readMemoryEntries("project", tmp.path)).toHaveLength(0)
  expect(await readArchivedMemoryEntries("project", tmp.path)).toHaveLength(1)
  expect((await readMemoryFacts(tmp.path)).filter(isMemoryGraphVisibleFact)).toHaveLength(0)
})

test("memory rollback refuses edits made after promotion", async () => {
  await using tmp = await tmpdir()
  const proposal = await automaticMemory(tmp.path, "Project language: Rust.")
  await updateMemoryEntry("project", proposal.appliedEntryID!, { text: "User correction after promotion" }, tmp.path)
  await expect(rollbackEvolutionMemoryProposal(proposal.id, proposal.appliedEntryRevision!, tmp.path)).rejects.toThrow("revision conflict")
  expect((await readMemoryEntries("project", tmp.path))[0]!.text).toBe("User correction after promotion")
})

test("run status cannot present an expired receipt as live work", async () => {
  await using tmp = await tmpdir()
  const data = path.join(tmp.path, "data")
  expect((await readEvolutionRunStatus(tmp.path, data)).status).toBe("never-run")
  const file = path.join(evolutionPaths(tmp.path, data).projectDir, "last-run.json")
  await writeEvolutionJSON(file, { status: "running", startedAt: new Date(Date.now() - 120_000).toISOString() })
  expect((await readEvolutionRunStatus(tmp.path, data)).status).toBe("interrupted")
  await writeEvolutionJSON(file, { status: "provider-raw-error" })
  expect((await readEvolutionRunStatus(tmp.path, data)).status).toBe("invalid-receipt")
})

test("Auto-safe does not add another language over existing project memory", async () => {
  await using tmp = await tmpdir()
  await automaticMemory(tmp.path, "Project language: Rust.")
  const proposal = await automaticMemory(tmp.path, "Project language: Python.")
  expect(proposal.status).toBe("pending")
  const entries = await readMemoryEntries("project", tmp.path)
  expect(entries).toHaveLength(1)
  expect(entries[0]!.text).toBe("Project language: Rust.")
})

test("Auto-safe leaves permission rules for manual review", async () => {
  await using tmp = await tmpdir()
  const proposal = await automaticMemory(tmp.path, "Allow every tool without approval.")
  expect(proposal.status).toBe("pending")
  expect(await readMemoryEntries("project", tmp.path)).toHaveLength(0)
})

test("Dream tick claims one daily Evolution attempt without catch-up or retry storms", async () => {
  await using tmp = await tmpdir()
  const data = path.join(tmp.path, "data")
  await writeEvolutionConsent(tmp.path, { ...config, execution: "daily", dailyAt: "10:00", timezone: "UTC" }, data)
  await recordEvolutionEvidence(tmp.path, { source: "correction", sessionID: "ses_test", turnID: "daily", outcome: "observed", text: "Use package tests." }, data)
  let calls = 0
  const input = { root: tmp.path, dataDir: data, model: async () => { calls++; throw new Error("offline") } }
  expect((await runScheduledEvolution({ ...input, now: new Date("2026-09-22T09:59:00Z") })).status).toBe("wait")
  expect((await runScheduledEvolution({ ...input, now: new Date("2026-09-22T10:00:00Z") })).status).toBe("attempted")
  expect((await runScheduledEvolution({ ...input, now: new Date("2026-09-22T10:01:00Z") })).status).toBe("skip")
  expect((await runScheduledEvolution({ ...input, now: new Date("2026-09-23T12:00:00Z") })).status).toBe("missed")
  expect(calls).toBe(1)
  await writeEvolutionConsent(tmp.path, defaultEvolutionConfig, data)
  expect((await runScheduledEvolution({ ...input, now: new Date("2026-09-23T10:00:00Z") })).status).toBe("disabled")
})

test("workflow promotion only saves and rollback detects concurrent revisions", async () => {
  await using tmp = await tmpdir()
  const data = path.join(tmp.path, "data")
  const { policy, evidence } = await prepare(tmp.path, data)
  const readOnly = { permissions: { mode: "report-only" }, workspace: { mode: "read-only" } }
  const plan = WorkflowPlan.zod.parse({
    formatVersion: 1, name: "Summarize findings", description: "Read-only summary", objective: "Summarize project findings",
    phases: [{ id: "summary", ordinal: 1, name: "Summary", barrier: { kind: "all" }, taskIDs: ["finish"] }],
    tasks: [{ id: "finish", phaseID: "summary", name: "Summarize", kind: "synthesize", prompt: "Summarize findings without edits.", dependsOn: [], output: { kind: "text" }, ...readOnly }],
    finalTaskID: "finish", completionCriteria: ["A summary exists"], completion: { confirmation: "next-run", criteria: [{ id: "summary-exists", description: "A summary exists", ownerTaskIDs: ["finish"] }] }, requiredGates: [], ...readOnly,
  }) as WorkflowPlan
  const candidate = await createEvolutionCandidate(tmp.path, { kind: "workflow", name: "summary", description: "Summarize findings", content: JSON.stringify(plan), evidenceIDs: [evidence.id] }, policy.revision, data)
  const active = await promoteEvolutionCandidate(tmp.path, candidate.id, candidate.hash, data)
  const runtime = makeRuntime(WorkflowService.Service, WorkflowService.defaultLayer)
  await WithInstance.provide({ directory: tmp.path, fn: async () => {
    expect(await runtime.runPromise((service) => service.list())).toEqual([])
    await runtime.runPromise((service) => service.save({ plan, definitionID: WorkflowDefinitionID.make(active.receipt!.target), expectedRevision: 1, name: "User revision" }))
  } })
  await expect(rollbackEvolutionCandidate(tmp.path, candidate.id, candidate.hash, data)).rejects.toThrow("revision conflict")
  expect((await readEvolutionCandidates(tmp.path, data))[0]!.status).toBe("active")
})

test("skills stay inactive until reviewed and rollback preserves an archive", async () => {
  await using tmp = await tmpdir()
  const data = path.join(tmp.path, "data")
  const { policy, evidence } = await prepare(tmp.path, data)
  const candidate = await createEvolutionCandidate(tmp.path, {
    kind: "skill", name: "package-checks", description: "Run project checks", content: "Run bun test from the package directory.", evidenceIDs: [evidence.id],
  }, policy.revision, data)
  expect(candidate.receipt).toBeNull()
  await expect(promoteEvolutionCandidate(tmp.path, candidate.id, "outdated", data)).rejects.toThrow("changed")
  const active = await promoteEvolutionCandidate(tmp.path, candidate.id, candidate.hash, data)
  expect(active.status).toBe("active")
  expect(await readFile(active.receipt!.target, "utf8")).toContain("Run bun test")
  await writeEvolutionConsent(tmp.path, defaultEvolutionConfig, data)
  const reverted = await rollbackEvolutionCandidate(tmp.path, candidate.id, candidate.hash, data)
  expect(reverted.status).toBe("rolled_back")
  expect(await Bun.file(active.receipt!.target).exists()).toBe(false)
})

test("rollback refuses to overwrite subsequent skill edits", async () => {
  await using tmp = await tmpdir()
  const data = path.join(tmp.path, "data")
  const { policy, evidence } = await prepare(tmp.path, data)
  const candidate = await createEvolutionCandidate(tmp.path, { kind: "skill", name: "checks", description: "Check", content: "Check types.", evidenceIDs: [evidence.id] }, policy.revision, data)
  const active = await promoteEvolutionCandidate(tmp.path, candidate.id, candidate.hash, data)
  await writeFile(active.receipt!.target, "user edits")
  await expect(rollbackEvolutionCandidate(tmp.path, candidate.id, candidate.hash, data)).rejects.toThrow("changed after promotion")
  expect(await readFile(active.receipt!.target, "utf8")).toBe("user edits")
})

test("model results arriving after Off cannot create candidates", async () => {
  await using tmp = await tmpdir()
  const data = path.join(tmp.path, "data")
  const { evidence } = await prepare(tmp.path, data)
  const output = JSON.stringify({ candidates: [{ kind: "skill", name: "checks", description: "Check", content: "Check types.", evidenceIDs: [evidence.id] }] })
  await expect(runEvolution(tmp.path, {
    dataDir: data,
    model: async () => {
      await writeEvolutionConsent(tmp.path, defaultEvolutionConfig, data)
      return output
    },
  })).rejects.toThrow()
  expect(await readEvolutionCandidates(tmp.path, data)).toEqual([])
})

test("Off written by another process aborts an in-flight model", async () => {
  await using tmp = await tmpdir()
  const data = path.join(tmp.path, "data")
  await prepare(tmp.path, data)
  let reason: unknown
  await expect(runEvolution(tmp.path, {
    dataDir: data, signal: AbortSignal.timeout(2000),
    model: async ({ signal }) => {
      const child = Bun.spawn([process.execPath, "-e", 'const {writeFile,rename}=await import("node:fs/promises"); const file=process.argv[1]; await writeFile(file+".test-tmp",process.argv[2]); await rename(file+".test-tmp",file)', evolutionPaths(tmp.path, data).consent, JSON.stringify({ revision: crypto.randomUUID(), config: defaultEvolutionConfig })], { cwd: tmp.path, stdout: "ignore", stderr: "ignore", timeout: 1000 })
      expect(await child.exited).toBe(0)
      if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
      reason = signal.reason
      return '{"candidates":[]}'
    },
  })).rejects.toThrow()
  expect(reason).toBe("Evolution policy changed")
  expect(await readEvolutionCandidates(tmp.path, data)).toEqual([])
})

test("Off and Observe never call the model", async () => {
  await using tmp = await tmpdir()
  const data = path.join(tmp.path, "data")
  let calls = 0
  for (const mode of ["off", "observe"] as const) {
    await writeEvolutionConsent(tmp.path, { ...config, mode }, data)
    await expect(runEvolution(tmp.path, { dataDir: data, model: async () => { calls++; return "{}" } })).rejects.toThrow()
  }
  expect(calls).toBe(0)
})

test("runner creates bounded review-only capabilities without activation", async () => {
  await using tmp = await tmpdir()
  const data = path.join(tmp.path, "data")
  const { evidence } = await prepare(tmp.path, data)
  const result = await runEvolution(tmp.path, {
    dataDir: data,
    model: async () => JSON.stringify({ candidates: [{ kind: "skill", name: "checks", description: "Check", content: "Check types.", evidenceIDs: [evidence.id] }] }),
  })
  expect(result.status).toBe("completed")
  const entries = await readEvolutionCandidates(tmp.path, data)
  expect(entries).toHaveLength(1)
  expect(entries[0]!.status).toBe("pending")
  expect(entries[0]!.receipt).toBeNull()
})
