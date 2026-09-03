import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { existsSync, mkdtempSync } from "fs"
import { mkdir, rm, writeFile } from "fs/promises"
import { tmpdir as osTmpdir } from "os"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { appendMemoryEntry, archiveMemoryEntries, deleteMemoryEntry, memoryStatus, readArchivedMemoryEntries, readMemoryEntries, restoreArchivedMemoryEntries, updateMemoryEntry } from "../../src/mend/memory/store"
import { retrieveMemory } from "../../src/mend/memory/retrieve"
import { memoryPaths, readGlobalMemoryConfig, readMemoryConfig, resolveProjectMemoryRoot, writeGlobalMemoryConfig, writeProjectMemoryConfig } from "../../src/mend/memory/config"
import { applyMemoryProposal, autoProposeMemoriesFromSession, extractorPrompt, importCodexMemories, listMemoryProposals, memoryExtractorCandidateMessage, memoryExtractorFailureReason, proposeMemoriesFromExtractorText, proposeMemoriesWithExtractor, proposeMemory, readMemoryExtractorContext, rejectMemoryProposal, updateMemoryProposal } from "../../src/mend/memory/proposals"
import { DEFAULT_MEMORY_CATEGORIES, inferMemoryCategoryIDs, normalizeMemoryCategoryPolicies, readMemoryCategoryPolicies, readMemoryCategoryPolicyLayers, resetMemoryCategoryPolicy, scopeReasonForMemory, writeMemoryCategoryPolicy } from "../../src/mend/memory/categories"
import { materializeLegacyMemoryFacts, readMemoryFacts, readMemoryGraph, repairMemoryGraph, upsertMemoryFact, upsertMemoryFactLink, validateMemoryGraph } from "../../src/mend/memory/graph"
import { registerMemoryWorkspace, memoryWorkspaceOverview, writeWorkspaceRegistry } from "../../src/mend/memory/workspaces"
import { allowedDreamGitCommands, collectDreamFileEvidence, isDreamFileAllowed } from "../../src/mend/memory/dream-sources"
import { applyDreamGraphProposal, latestDreamStatus, parseDreamCandidates, readDreamRunDetail, readDreamRuns, rejectDreamGraphProposal, resolveMemoryDreamRole, runMemoryDream, type DreamGraphProposal } from "../../src/mend/memory/dream"
import { listMemorySessionDigests, writeMemorySessionDigestFromSession } from "../../src/mend/memory/session-digests"
import { cleanupGeneratedMemoryEntries, deterministicDreamConsolidator, isMemoryMaintenanceInstruction, parseDreamConsolidationOutput, readDreamConsolidationRun } from "../../src/mend/memory/dream-consolidation"
import { dreamScheduleWindowFromText, evaluateDreamSchedule, readDreamScheduleState, runGlobalDreamSchedulerTick, runScheduledMemoryDream } from "../../src/mend/memory/dream-scheduler"
import { listMemorySideChats, memoryAssistantFailureReason, parseMemorySideChatResponse, resolveMemoryAssistantRole, resolveMemoryAssistantRuntimeRole, sendMemorySideChatMessage, startMemorySideChat } from "../../src/mend/memory/side-chat"
import { memoryGraphOverview, memoryOverview } from "../../src/mend/memory/overview"
import { GlobalBus } from "../../src/bus/global"
import { writeModelsConfig } from "../../src/mend/config/models"
import { dreamServicePlan } from "../../src/mend/runtime/dream-service"
import { MemorySideChatResponse } from "../../src/server/routes/instance/httpapi/groups/memory"

async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

describe("mend memory", () => {
  const originalMemoryDir = process.env.MENDCODE_MEMORY_DIR

  beforeEach(() => {
    process.env.MENDCODE_MEMORY_DIR = mkdtempSync(path.join(osTmpdir(), "mend-memory-test-"))
  })

  afterEach(() => {
    if (originalMemoryDir === undefined) delete process.env.MENDCODE_MEMORY_DIR
    else process.env.MENDCODE_MEMORY_DIR = originalMemoryDir
  })

  test("defaults are safe and do not enable prompt memory", async () => {
    await using dir = await tmpdir()

    const config = await readMemoryConfig(dir.path)
    const status = await memoryStatus(dir.path)

    expect(config.enabled).toBe(false)
    expect(config.use).toBe(false)
    expect(config.generate).toBe(false)
    expect(config.memoryWritePolicy).toBe("pending")
    expect(config.dreamWritePolicy).toBe("pending")
    expect(config.dreamConsolidationPolicy).toBe("auto-consolidate")
    expect(config.dreamAutoApplyMinConfidence).toBe(0.9)
    expect(config.dreamGraphAutoApplyMinConfidence).toBe(0.75)
    expect(config.dreamGraphAutoApplyMinDurability).toBe(0.7)
    expect(status.input).toBe(false)
    expect(status.output).toBe(false)
    expect(status.promptModeIndependent).toBe(true)
    expect(status.callsProviders).toBe(false)
    expect(status.retrievalCallsProviders).toBe(false)
    expect(status.outputCallsProviders).toBe(false)
    expect(status.readsSecrets).toBe(false)
  })

  test("concurrent memory appends preserve every complete JSONL entry", async () => {
    await using dir = await tmpdir()
    const texts = Array.from({ length: 32 }, (_, index) => `Concurrent memory ${index}`)

    await Promise.all(texts.map((text) => appendMemoryEntry({ scope: "project", text }, dir.path)))

    const entries = await readMemoryEntries("project", dir.path)
    expect(entries.map((entry) => entry.text).sort()).toEqual(texts.sort())
  })

  test("normalizes Dream write policy settings", async () => {
    await using dir = await tmpdir()

    const written = await writeProjectMemoryConfig({
      memoryWritePolicy: "auto-safe",
      memoryAutoApplyMinConfidence: 0.92,
      memoryAutoApplyMinDurability: 0.88,
      memoryAutoApplyMaxChangeRisk: 0.12,
      memoryAutoApplyAllowedCategories: ["memory.policy"],
      memoryAutoApplyBlockedSensitivity: ["medium", "high"],
      dreamWritePolicy: "disabled",
      dreamAutoApplyMinConfidence: 0.95,
      dreamAutoApplyMinDurability: 0.9,
      dreamGraphAutoApplyMinConfidence: 0.8,
      dreamGraphAutoApplyMinDurability: 0.72,
      dreamAutoApplyMaxChangeRisk: 0.1,
      dreamAutoApplyAllowedCategories: ["memory.policy"],
      dreamAutoApplyBlockedSensitivity: ["high"],
    }, dir.path)
    const config = await readMemoryConfig(dir.path)

    expect(written.config.memoryWritePolicy).toBe("auto-safe")
    expect(config.memoryAutoApplyMinConfidence).toBe(0.92)
    expect(config.memoryAutoApplyMinDurability).toBe(0.88)
    expect(config.memoryAutoApplyMaxChangeRisk).toBe(0.12)
    expect(config.memoryAutoApplyAllowedCategories).toEqual(["memory.policy"])
    expect(config.memoryAutoApplyBlockedSensitivity).toEqual(["medium", "high"])
    expect(written.config.dreamWritePolicy).toBe("disabled")
    expect(config.dreamWritePolicy).toBe("disabled")
    expect(config.dreamAutoApplyMinConfidence).toBe(0.95)
    expect(config.dreamAutoApplyMinDurability).toBe(0.9)
    expect(config.dreamGraphAutoApplyMinConfidence).toBe(0.8)
    expect(config.dreamGraphAutoApplyMinDurability).toBe(0.72)
    expect(config.dreamAutoApplyMaxChangeRisk).toBe(0.1)
    expect(config.dreamAutoApplyAllowedCategories).toEqual(["memory.policy"])
    expect(config.dreamAutoApplyBlockedSensitivity).toEqual(["high"])
  })

  test("parses Dream model candidates from strict JSON and fenced output", () => {
    const candidates = parseDreamCandidates(`\`\`\`json
{"candidates":[{"text":"Keep Dream runs auditable.","reason":"Durable memory policy","confidence":0.95,"durability":0.9,"changeRisk":0.1,"categoryIDs":["memory.policy"],"scope":"global","evidenceRefs":["file:AGENTS.md"],"recommendedDisposition":"pending"}]}
\`\`\``)

    expect(candidates).toEqual([{
      text: "Keep Dream runs auditable.",
      reason: "Durable memory policy",
      confidence: 0.95,
      durability: 0.9,
      changeRisk: 0.1,
      categoryIDs: ["memory.policy"],
      scope: "global",
      evidenceRefs: ["file:AGENTS.md"],
      recommendedDisposition: "pending",
    }])
  })

  test("Dream resolves the configured memoryDream role instead of silently skipping the model", async () => {
    await using dir = await tmpdir()
    await writeProjectMemoryConfig({ memoryDreamRole: "memoryDream" }, dir.path)
    await writeModelsConfig({
      version: 0,
      enabled: true,
      roles: {
        memoryDream: {
          providerID: "openai",
          modelID: "gpt-5.6-sol",
          authMode: "provider-oauth-or-token",
        },
      },
    }, dir.path)

    expect(await resolveMemoryDreamRole(dir.path)).toEqual({
      ok: true,
      roleName: "memoryDream",
      providerID: "openai",
      modelID: "gpt-5.6-sol",
      authMode: "provider-oauth-or-token",
    })
  })

  test("normalizes legacy Dream window times and rejects invalid ranges", async () => {
    await using dir = await tmpdir()
    await writeJson(memoryPaths(dir.path).globalConfig, {
      version: 0,
      configScope: "global",
      dreamWindow: {
        enabled: true,
        start: "6:00",
        end: "23:00",
        timezone: "America/New_York",
      },
    })

    expect((await readGlobalMemoryConfig()).dreamWindow).toMatchObject({
      enabled: true,
      start: "06:00",
      end: "23:00",
      timezone: "America/New_York",
    })

    await writeJson(memoryPaths(dir.path).globalConfig, {
      version: 0,
      configScope: "global",
      dreamWindow: {
        enabled: true,
        start: "25:00",
        end: "23:00",
      },
    })

    expect((await readGlobalMemoryConfig()).dreamWindow).toBeNull()
  })

  test("project memory root falls back from filesystem root to cwd", async () => {
    await using dir = await tmpdir()

    expect(resolveProjectMemoryRoot("/", dir.path)).toBe(path.resolve(dir.path))
    expect(resolveProjectMemoryRoot("/", "/")).toBeUndefined()
  })

  test("retrieves project memory by query without provider calls", async () => {
    await using dir = await tmpdir()
    await writeJson(path.join(dir.path, ".mendcode", "memory", "config.json"), {
      version: 0,
      configScope: "project",
      enabled: true,
      use: true,
      generate: false,
      scopes: ["project"],
      maxPromptTokens: 120,
      maxEntries: 2,
    })
    await writeFile(path.join(dir.path, ".mendcode", "memory", "memory_summary.md"), "User prefers local-only security workflows.\n")
    await appendMemoryEntry({
      scope: "project",
      text: "For MendCode provider work, do not run auth flows or print tokens.",
      tags: ["provider", "security"],
      cwd: dir.path,
      confidence: 0.9,
    }, dir.path)

    const result = await retrieveMemory({ root: dir.path, query: "provider auth", cwd: dir.path })

    expect(result.callsProviders).toBe(false)
    expect(result.lines?.join("\n")).toContain("local-only security")
    expect(result.lines?.join("\n")).toContain("provider work")
  })

  test("runtime request memory injects global memories plus capped project memories", async () => {
    await using dir = await tmpdir()
    await writeProjectMemoryConfig({
      enabled: true,
      use: true,
      generate: false,
      maxEntries: 2,
      projectMaxEntries: 2,
      globalCompactionMaxEntries: 4,
      maxPromptTokens: 1_000,
    }, dir.path)
    for (const text of [
      "Global memory one.",
      "Global memory two.",
      "Global memory three.",
    ]) {
      await appendMemoryEntry({ scope: "global", text }, dir.path)
    }
    for (const text of [
      "Project memory one.",
      "Project memory two.",
      "Project memory three.",
    ]) {
      await appendMemoryEntry({ scope: "project", text }, dir.path)
    }

    const result = await retrieveMemory({ root: dir.path, query: "nothing matches", cwd: dir.path, mode: "request" })
    const lines = result.lines?.join("\n") ?? ""

    expect(result.entries.filter((entry) => entry.scope === "global").length).toBe(2)
    expect(result.entries.filter((entry) => entry.scope === "project").length).toBe(2)
    expect(lines).toContain("Global memory")
    expect(lines).toContain("Project memory")
  })

  test("post-compaction memory injects capped global memories plus project cap", async () => {
    await using dir = await tmpdir()
    await writeProjectMemoryConfig({
      enabled: true,
      use: true,
      generate: false,
      projectMaxEntries: 2,
      globalCompactionMaxEntries: 3,
      maxPromptTokens: 1_000,
    }, dir.path)
    for (const text of [
      "Global memory one.",
      "Global memory two.",
      "Global memory three.",
      "Global memory four.",
    ]) {
      await appendMemoryEntry({ scope: "global", text }, dir.path)
    }
    for (const text of [
      "Project memory one.",
      "Project memory two.",
      "Project memory three.",
    ]) {
      await appendMemoryEntry({ scope: "project", text }, dir.path)
    }

    const result = await retrieveMemory({ root: dir.path, query: "compacted resume", cwd: dir.path, mode: "after-compaction" })

    expect(result.entries.filter((entry) => entry.scope === "global").length).toBe(3)
    expect(result.entries.filter((entry) => entry.scope === "project").length).toBe(2)
  })

  test("project config writer keeps generation approval gated", async () => {
    await using dir = await tmpdir()

    const result = await writeProjectMemoryConfig({ enabled: true, use: true, generate: true }, dir.path)

    expect(result.config.enabled).toBe(true)
    expect(result.config.configScope).toBe("project")
    expect(result.config.use).toBe(true)
    expect(result.config.generate).toBe(true)
    expect(result.config.requireApprovalForGenerated).toBe(true)
  })

  test("global config writer does not create repo-local memory config", async () => {
    await using dir = await tmpdir()
    const result = await writeGlobalMemoryConfig({ enabled: true, use: true, generate: true }, dir.path)
    const config = await readMemoryConfig(dir.path)

    expect(result.path).toContain("mend-memory-test-")
    expect(config.configScope).toBe("global")
    expect(config.enabled).toBe(true)
    expect(config.use).toBe(true)
    expect(config.generate).toBe(true)
    expect(existsSync(path.join(dir.path, ".mendcode", "memory", "config.json"))).toBe(false)
  })

  test("legacy repo-local memory config is ignored unless marked as a project override", async () => {
    await using dir = await tmpdir()
    const localConfig = path.join(dir.path, ".mendcode", "memory", "config.json")
    await writeJson(localConfig, {
      version: 0,
      enabled: true,
      use: true,
      generate: true,
      maxPromptTokens: 800,
      maxEntries: 6,
    })

    const ignored = await readMemoryConfig(dir.path)
    expect(ignored.enabled).toBe(false)
    expect(ignored.use).toBe(false)
    expect(ignored.generate).toBe(false)
    expect(ignored.maxPromptTokens).toBe(10_000)
    expect(ignored.maxEntries).toBe(50)

    await writeJson(localConfig, {
      version: 0,
      configScope: "project",
      enabled: true,
      use: true,
      generate: true,
      maxPromptTokens: 800,
      maxEntries: 6,
    })

    const explicit = await readMemoryConfig(dir.path)
    expect(explicit.configScope).toBe("project")
    expect(explicit.enabled).toBe(true)
    expect(explicit.use).toBe(true)
    expect(explicit.generate).toBe(true)
    expect(explicit.maxPromptTokens).toBe(800)
    expect(explicit.maxEntries).toBe(6)
  })

  test("edits and deletes memory entries by scope", async () => {
    await using dir = await tmpdir()
    const entry = await appendMemoryEntry({ scope: "project", text: "Old memory text.", tags: ["old"] }, dir.path)

    const edited = await updateMemoryEntry("project", entry.id, { text: "New memory text.", tags: ["new"] }, dir.path)
    const afterEdit = await readMemoryEntries("project", dir.path)
    const deleted = await deleteMemoryEntry("project", entry.id, dir.path)
    const afterDelete = await readMemoryEntries("project", dir.path)

    expect(edited.text).toBe("New memory text.")
    expect(afterEdit[0]?.tags).toContain("new")
    expect(deleted.ok).toBe(true)
    expect(afterDelete.length).toBe(0)
  })

  test("proposes memory without writing entries until approved", async () => {
    await using dir = await tmpdir()

    const proposal = await proposeMemory({
      scope: "project",
      text: "User prefers approval-gated memory updates for MendCode.",
      tags: ["memory", "approval"],
      cwd: dir.path,
      confidence: 0.91,
      durability: 0.95,
      changeRisk: 0.1,
      reason: "Stable product behavior.",
    }, dir.path)
    const statusBeforeApply = await memoryStatus(dir.path)

    expect(proposal.status).toBe("pending")
    expect(proposal.confidence).toBe(0.91)
    expect(proposal.durability).toBe(0.95)
    expect(proposal.changeRisk).toBe(0.1)
    expect(proposal.reason).toBe("Stable product behavior.")
    expect(statusBeforeApply.entries.project.count).toBe(0)
    expect(statusBeforeApply.proposals.pending).toBe(1)

    const applied = await applyMemoryProposal(proposal.id, dir.path)
    const statusAfterApply = await memoryStatus(dir.path)

    expect(applied.entry?.text).toContain("approval-gated")
    expect(applied.proposal.status).toBe("applied")
    expect(statusAfterApply.entries.project.count).toBe(1)
    expect(statusAfterApply.proposals.applied).toBe(1)
  })

  test("applies pending update and remove memory proposals", async () => {
    await using dir = await tmpdir()
    const stale = await appendMemoryEntry({
      scope: "project",
      text: "MendCode memory learning only creates add proposals.",
      tags: ["memory"],
    }, dir.path)

    const update = await proposeMemory({
      operation: "update",
      scope: "project",
      targetEntryID: stale.id,
      targetEntryScope: "project",
      text: "MendCode memory learning can create approval-gated add, update, and remove proposals.",
      tags: ["memory", "approval"],
      confidence: 0.9,
      durability: 0.92,
      changeRisk: 0.1,
      reason: "User corrected the durable memory behavior.",
    }, dir.path)
    const appliedUpdate = await applyMemoryProposal(update.id, dir.path)
    const afterUpdate = await readMemoryEntries("project", dir.path)

    expect(appliedUpdate.proposal.operation).toBe("update")
    expect(appliedUpdate.entry?.id).toBe(stale.id)
    expect(afterUpdate).toHaveLength(1)
    expect(afterUpdate[0]?.text).toContain("add, update, and remove")

    const remove = await proposeMemory({
      operation: "remove",
      scope: "project",
      targetEntryID: stale.id,
      targetEntryScope: "project",
      text: "Remove obsolete memory about MendCode memory learning.",
      tags: ["memory"],
      confidence: 0.88,
      durability: 0.9,
      changeRisk: 0.05,
      reason: "User said the prior memory is obsolete.",
    }, dir.path)
    const appliedRemove = await applyMemoryProposal(remove.id, dir.path)
    const afterRemove = await readMemoryEntries("project", dir.path)

    expect(appliedRemove.proposal.operation).toBe("remove")
    expect(appliedRemove.entry).toBeNull()
    expect(afterRemove).toHaveLength(0)
  })

  test("edits pending proposal text and scope before applying", async () => {
    await using dir = await tmpdir()

    const proposal = await proposeMemory({
      scope: "global",
      text: "User prefers concise responses in their chosen language in MendCode.",
      tags: ["style"],
      confidence: 0.9,
      durability: 0.9,
      changeRisk: 0.05,
      reason: "Durable communication preference.",
    }, dir.path)

    const edited = await updateMemoryProposal(proposal.id, {
      scope: "project",
      text: "In this repo, keep MendCode memory proposals approval-gated and concise.",
      tags: ["memory", "approval"],
    }, dir.path)
    const applied = await applyMemoryProposal(proposal.id, dir.path)

    expect(edited.scope).toBe("project")
    expect(edited.text).toContain("approval-gated")
    expect(edited.reason).toBe("Durable communication preference.")
    expect(applied.entry?.scope).toBe("project")
    expect(applied.entry?.text).toContain("approval-gated")
  })

  test("redacts sensitive proposal text and allows rejection", async () => {
    await using dir = await tmpdir()

    const proposal = await proposeMemory({
      text: "OPENAI_API_KEY=REDACTION_TEST_SECRET should never be memorized raw.",
      tags: ["security"],
    }, dir.path)

    expect(proposal.text).toContain("[REDACTED:")
    expect(proposal.sensitivity).toBe("high")
    expect(proposal.redactions.length).toBeGreaterThan(0)

    const rejected = await rejectMemoryProposal(proposal.id, dir.path)
    const pending = await listMemoryProposals(dir.path, "pending")

    expect(rejected.status).toBe("rejected")
    expect(pending.length).toBe(0)
  })

  test("legacy proposal files normalize missing write-policy metadata and stay applicable", async () => {
    await using dir = await tmpdir()
    const proposalID = "memprop_legacy"
    await writeJson(path.join(memoryPaths(dir.path).proposalsDir, `${proposalID}.json`), {
      id: proposalID,
      version: 0,
      operation: "add",
      scope: "project",
      text: "Legacy memory proposal files should default to pending review metadata.",
      createdAt: "2026-07-02T18:00:00.000Z",
    })

    const proposals = await listMemoryProposals(dir.path, "all")
    const applied = await applyMemoryProposal(proposalID, dir.path)

    expect(proposals).toEqual([expect.objectContaining({
      id: proposalID,
      status: "pending",
      policyDecision: "pending",
      targetEntryIDs: [],
      source: "manual-proposal",
    })])
    expect(applied.proposal.status).toBe("applied")
    expect(applied.entry?.text).toContain("Legacy memory proposal files")
  })

  test("editing a pending proposal re-applies redaction and sensitivity metadata", async () => {
    await using dir = await tmpdir()

    const proposal = await proposeMemory({
      scope: "project",
      text: "Keep memory proposals concise and reviewable.",
      tags: ["memory"],
    }, dir.path)

    const edited = await updateMemoryProposal(proposal.id, {
      text: "OPENAI_API_KEY=REDACTION_TEST_SECRET should never be stored in memory.",
      tags: ["security"],
    }, dir.path)
    const applied = await applyMemoryProposal(proposal.id, dir.path)

    expect(edited.text).toContain("[REDACTED:")
    expect(edited.sensitivity).toBe("high")
    expect(edited.redactions.length).toBeGreaterThan(0)
    expect(applied.entry?.text).toContain("[REDACTED:")
    expect(applied.entry?.sensitivity).toBe("high")
  })

  test("auto extraction is gated by memory output config", async () => {
    await using dir = await tmpdir()
    const session = {
      id: "safe",
      messages: [
        { role: "user", content: "Decision: MendCode should keep memory output approval gated." },
        { role: "assistant", content: "Confirmed." },
      ],
    }

    const disabled = await autoProposeMemoriesFromSession(session, dir.path)
    expect(disabled.skipped).toBe(true)
    expect(disabled.proposals.length).toBe(0)

    await writeProjectMemoryConfig({ enabled: true, generate: true, extractorRole: "none" }, dir.path)
    const enabled = await autoProposeMemoriesFromSession(session, dir.path)
    const duplicate = await autoProposeMemoriesFromSession(session, dir.path)

    expect(enabled.skipped).toBe(true)
    expect(enabled.reason).toContain("disabled")
    expect(enabled.proposals.length).toBe(0)
    expect(enabled.writesMemory).toBe(false)
    expect(duplicate.skipped).toBe(true)
  })

  test("model extractor skips cleanly when disabled", async () => {
    await using dir = await tmpdir()
    await writeProjectMemoryConfig({ enabled: true, generate: true, extractorRole: "none" }, dir.path)

    const result = await proposeMemoriesWithExtractor({
      text: "Decision: MendCode should keep generated memory proposals approval-gated.",
      tags: ["session"],
      cwd: dir.path,
    }, dir.path)
    const status = await memoryStatus(dir.path)

    expect(result.skipped).toBe(true)
    expect(result.reason).toContain("disabled")
    expect(result.callsProviders).toBe(false)
    expect(result.proposals.length).toBe(0)
    expect(status.outputCallsProviders).toBe(false)
  })

  test("extractor policy covers durable preferences without explicit remember wording", () => {
    const prompt = extractorPrompt()

    expect(prompt).toContain("Do not require explicit memory wording")
    expect(prompt).toContain("categoryIDs")
    expect(prompt).toContain("future workflow rule")
    expect(prompt).toContain("recurring event/condition/action instructions")
    expect(prompt).toContain("Review saved_memory and pending_memory")
    expect(prompt).toContain("operation=update")
    expect(prompt).toContain("operation=remove")
    expect(prompt).toContain("Assistant text such as 'I will not save this yet' is not a reason to skip")
    expect(prompt).toContain("If the user repeats or lightly rephrases")
    expect(prompt).toContain("Allowed memory categories")
    expect(prompt).toContain("project.commands: Recurring commands, validation gates, and release commands.")
    expect(prompt).toContain("this extractor cannot create categories")
    expect(prompt).toContain("uncategorized: compatibility fallback only")
    expect(prompt).not.toContain("mflow live test")
    expect(prompt).not.toContain("smoke test before saying done")
  })

  test("extractor sees saved global/project memory and pending proposals before deciding", async () => {
    await using dir = await tmpdir()
    await appendMemoryEntry({
      scope: "global",
      text: "The user prefers concise responses in their chosen language.",
      tags: ["language"],
    }, dir.path)
    await appendMemoryEntry({
      scope: "project",
      text: "MendCode setup changes should keep terminal row copy compact.",
      tags: ["setup"],
    }, dir.path)
    await proposeMemory({
      scope: "project",
      text: "Visible TUI changes should be validated with a smoke test before saying done.",
      tags: ["tui"],
      cwd: dir.path,
      source: "test",
      evidence: "test",
    }, dir.path)

    const context = await readMemoryExtractorContext(dir.path)
    const message = memoryExtractorCandidateMessage({
      text: "USER:\nFor this repo, when you make visible TUI changes, run a smoke test before saying done.\n\nASSISTANT:\nunderstood",
      tags: ["tui", "auto"],
      cwd: dir.path,
      source: "tui-session-auto-extract",
      evidence: "session:test:message:test",
    }, context.existing)

    expect(message).toContain("<saved_memory>")
    expect(message).toContain("[saved][global]")
    expect(message).toContain("The user prefers concise responses in their chosen language.")
    expect(message).toContain("[saved][project]")
    expect(message).toContain("MendCode setup changes should keep terminal row copy compact.")
    expect(message).toContain("<pending_memory>")
    expect(message).toContain("[pending][project]")
    expect(message).toContain("[add] Visible TUI changes should be validated with a smoke test")
    expect(message).toContain("<candidate_turn>")
    expect(message).toContain("USER:")
    expect(message).toContain("ASSISTANT:")
  })

  test("extractor provider failures are classified for TUI status", () => {
    expect(memoryExtractorFailureReason(new Error("MENDCODE_OPENAI_OAUTH_CLIENT_ID is required for ChatGPT subscription OAuth."))).toBe("memory extractor auth missing")
    expect(memoryExtractorFailureReason("OPENAI_API_KEY is required")).toBe("memory extractor API key missing")
    expect(memoryExtractorFailureReason("provider adapter registered but auth mode is not implemented: provider-oauth-or-token")).toBe("memory extractor auth unsupported")
  })

  test("extractor output dedupes equivalent proposals from one turn", async () => {
    await using dir = await tmpdir()
    const output = JSON.stringify({
      proposals: [
        {
          shouldRemember: true,
          scope: "project",
          text: "The user wants memory learning to create at most one approval-gated proposal per completed assistant turn.",
          tags: ["memory", "tui"],
          durability: 0.95,
          confidence: 0.9,
          changeRisk: 0.1,
          reason: "Stable workflow preference.",
        },
        {
          shouldRemember: true,
          scope: "project",
          text: "Memory learning should create at most one approval gated proposal per completed assistant turn for this user.",
          tags: ["memory", "tui"],
          durability: 0.95,
          confidence: 0.9,
          changeRisk: 0.1,
          reason: "Same stable workflow preference.",
        },
      ],
    })

    const result = await proposeMemoriesFromExtractorText({
      text: "USER: do not create duplicate memory proposals\nASSISTANT: understood",
      tags: ["tui", "auto"],
      cwd: dir.path,
      source: "tui-session-auto-extract",
      evidence: "session:test:message:test",
      maxProposals: 2,
    }, output, dir.path)
    const pending = await listMemoryProposals(dir.path, "pending")

    expect(result.proposals.length).toBe(1)
    expect(result.candidates).toBe(1)
    expect(pending.length).toBe(1)
  })

  test("extractor recovers from unknown categories using the fixed catalog", async () => {
    await using dir = await tmpdir()
    const result = await proposeMemoriesFromExtractorText({
      text: "USER: Cuando el usuario indique que no hace falta testear y el trabajo esté listo, se puede ejecutar shipit directamente.",
      tags: ["chat", "auto"],
      cwd: dir.path,
      source: "tui-session-auto-extract",
      evidence: "session:test:message:category-fallback",
      maxProposals: 1,
    }, JSON.stringify({
      proposals: [{
        shouldRemember: true,
        operation: "add",
        scope: "project",
        categoryIDs: ["workflow.rules"],
        text: "Cuando el usuario indique que no hace falta testear y el trabajo esté listo, se puede ejecutar shipit directamente.",
        tags: ["workflow", "shipit"],
        durability: 0.95,
        confidence: 0.9,
        changeRisk: 0.1,
        recommendedDisposition: "pending",
        reason: "Regla durable del flujo del proyecto.",
      }],
    }), dir.path)

    expect(result.proposals).toHaveLength(1)
    expect(result.proposals[0]?.categoryIDs).toContain("project.commands")
    expect(result.proposals[0]?.categoryIDs).toContain("project.release")
    expect(result.proposals[0]?.categoryIDs).not.toContain("uncategorized")
  })

  test("extractor auto-safe policy applies obvious safe adds and leaves risky adds pending", async () => {
    await using dir = await tmpdir()
    await writeProjectMemoryConfig({
      memoryWritePolicy: "auto-safe",
      memoryAutoApplyMinConfidence: 0.9,
      memoryAutoApplyMinDurability: 0.85,
      memoryAutoApplyMaxChangeRisk: 0.2,
      memoryAutoApplyAllowedCategories: ["memory.policy"],
      memoryAutoApplyBlockedSensitivity: ["medium", "high"],
    }, dir.path)
    const related = await upsertMemoryFact({
      text: "Memory extraction policies should keep automatic writes conservative and auditable.",
      categoryIDs: ["memory.policy"],
      confidence: 0.95,
      durability: 0.9,
      changeRisk: 0.1,
    }, dir.path)

    const result = await proposeMemoriesFromExtractorText({
      text: "USER: For this repo, always keep the memory extractor auto policy conservative for obvious adds only. Also keep security notes reviewed.",
      tags: ["memory", "auto"],
      cwd: dir.path,
      source: "tui-session-auto-extract",
      evidence: "session:test:message:auto-safe",
      maxProposals: 2,
    }, JSON.stringify({
      proposals: [
        {
          shouldRemember: true,
          operation: "add",
          scope: "project",
          categoryIDs: ["memory.policy"],
          text: "For this repo, memory extractor auto policy should only auto-apply obvious durable low-risk add memories.",
          tags: ["memory", "auto"],
          durability: 0.94,
          confidence: 0.96,
          changeRisk: 0.05,
          recommendedDisposition: "auto-apply",
          reason: "Explicit durable memory policy.",
        },
        {
          shouldRemember: true,
          operation: "add",
          scope: "project",
          categoryIDs: ["project.security"],
          text: "Security-sensitive memory involving secret handling should stay review-gated even when useful.",
          tags: ["security"],
          durability: 0.96,
          confidence: 0.97,
          changeRisk: 0.05,
          recommendedDisposition: "auto-apply",
          reason: "Security-sensitive policy needs review.",
        },
      ],
    }), dir.path)
    const proposals = await listMemoryProposals(dir.path, "all")
    const entries = await readMemoryEntries("project", dir.path)
    const graph = await readMemoryGraph(dir.path)

    expect(result.writesMemory).toBe(true)
    expect(result.proposals).toHaveLength(2)
    expect(proposals.find((proposal) => proposal.text.includes("obvious durable"))?.status).toBe("applied")
    expect(proposals.find((proposal) => proposal.text.includes("obvious durable"))?.policyDecision).toBe("auto-applied")
    expect(proposals.find((proposal) => proposal.text.includes("Security-sensitive"))?.status).toBe("pending")
    expect(proposals.find((proposal) => proposal.text.includes("Security-sensitive"))?.policyDecision).toBe("manual-only")
    expect(entries).toHaveLength(1)
    expect(entries[0]?.text).toContain("obvious durable")
    expect(graph.links).toEqual([expect.objectContaining({
      from: `legacy_${entries[0]?.id}`,
      to: related.id,
      kind: "related",
    })])
  })

  test("extractor model-decides policy skips or auto-applies based on safe model disposition", async () => {
    await using dir = await tmpdir()
    await writeProjectMemoryConfig({
      memoryWritePolicy: "model-decides",
      memoryAutoApplyAllowedCategories: ["memory.policy"],
    }, dir.path)

    const result = await proposeMemoriesFromExtractorText({
      text: "USER: For this repo, memory model-decides mode should let obvious durable facts apply and skip slop.",
      tags: ["memory", "auto"],
      cwd: dir.path,
      source: "tui-session-auto-extract",
      evidence: "session:test:message:model-decides",
      maxProposals: 2,
    }, JSON.stringify({
      proposals: [
        {
          shouldRemember: true,
          operation: "add",
          scope: "project",
          categoryIDs: ["memory.policy"],
          text: "For this repo, memory model-decides mode may auto-apply obvious low-risk memory policy facts.",
          tags: ["memory", "auto"],
          durability: 0.95,
          confidence: 0.95,
          changeRisk: 0.05,
          recommendedDisposition: "auto-apply",
          reason: "Obvious durable policy.",
        },
        {
          shouldRemember: true,
          operation: "add",
          scope: "project",
          categoryIDs: ["memory.policy"],
          text: "This transient implementation note should be skipped by the model-decides policy.",
          tags: ["memory"],
          durability: 0.9,
          confidence: 0.9,
          changeRisk: 0.1,
          recommendedDisposition: "skip",
          reason: "Model recommends skip.",
        },
      ],
    }), dir.path)

    expect(result.proposals).toHaveLength(1)
    expect(result.proposals[0]?.status).toBe("applied")
    expect(result.proposals[0]?.policyDecision).toBe("auto-applied")
    expect(await readMemoryEntries("project", dir.path)).toHaveLength(1)
  })

  test("extractor fallback proposes explicit repo-scoped future workflow rules", async () => {
    await using dir = await tmpdir()

    const result = await proposeMemoriesFromExtractorText({
      text: "USER:\nFor this repo, in the mflow live test folder, when you make visible TUI or interactive-flow changes, run a real smoke test before saying done. Do not use memory commands; respond only: understood.\n\nASSISTANT:\nUnderstood.",
      tags: ["tui", "auto"],
      cwd: dir.path,
      source: "tui-session-auto-extract",
      evidence: "session:test:message:fallback",
      maxProposals: 1,
    }, "{\"proposals\":[]}", dir.path)

    expect(result.proposals).toHaveLength(1)
    expect(result.proposals[0]?.operation).toBe("add")
    expect(result.proposals[0]?.scope).toBe("project")
    expect(result.proposals[0]?.text).toContain("mflow live test")
    expect(result.proposals[0]?.text).not.toContain("Do not use memory commands")
  })

  test("extractor parses strict JSON even when the model wraps it in prose", async () => {
    await using dir = await tmpdir()
    const output = [
      "Sure, here is the JSON:",
      JSON.stringify({
        proposals: [{
          shouldRemember: true,
          operation: "add",
          scope: "project",
          text: "For this repo, smoke-test visible TUI changes before saying done.",
          tags: ["workflow", "tui"],
          durability: 0.91,
          confidence: 0.87,
          changeRisk: 0.1,
          reason: "Durable repo workflow rule.",
        }],
      }),
    ].join("\n")

    const result = await proposeMemoriesFromExtractorText({
      text: "USER: For this repo, smoke-test visible TUI changes before saying done.\nASSISTANT: understood",
      tags: ["tui", "auto"],
      cwd: dir.path,
      source: "tui-session-auto-extract",
      evidence: "session:test:message:wrapped-json",
      maxProposals: 1,
    }, output, dir.path)

    expect(result.proposals).toHaveLength(1)
    expect(result.proposals[0]?.text).toContain("smoke-test visible TUI")
  })

  test("extractor reports why empty output creates no proposal", async () => {
    await using dir = await tmpdir()

    const result = await proposeMemoriesFromExtractorText({
      text: "USER: thanks\nASSISTANT: gladly",
      tags: ["tui", "auto"],
      cwd: dir.path,
      source: "tui-session-auto-extract",
      evidence: "session:test:message:empty",
      maxProposals: 1,
    }, "{\"proposals\":[]}", dir.path)

    expect(result.proposals).toHaveLength(0)
    expect(result.candidates).toBe(0)
    expect(result.reason).toBe("no durable memory candidates")
  })

  test("extractor output can propose targeted memory updates and removals", async () => {
    await using dir = await tmpdir()
    const outdated = await appendMemoryEntry({
      scope: "project",
      text: "MendCode should never create automatic memory proposals.",
      tags: ["memory"],
    }, dir.path)
    const context = await readMemoryExtractorContext(dir.path)
    const output = JSON.stringify({
      proposals: [
        {
          shouldRemember: true,
          operation: "update",
          scope: "project",
          targetEntryID: outdated.id,
          targetEntryScope: "project",
          text: "MendCode should create approval-gated automatic memory proposals for durable add, update, and remove candidates.",
          tags: ["memory"],
          durability: 0.93,
          confidence: 0.88,
          changeRisk: 0.1,
          reason: "User corrected the existing memory policy.",
        },
      ],
    })

    const result = await proposeMemoriesFromExtractorText({
      text: "USER: actually memory should make pending updates too\nASSISTANT: understood",
      tags: ["tui", "auto"],
      cwd: dir.path,
      source: "tui-session-auto-extract",
      evidence: "session:test:message:update",
      maxProposals: 2,
    }, output, dir.path, context.existingFingerprints)
    const applied = await applyMemoryProposal(result.proposals[0]!.id, dir.path)
    const entries = await readMemoryEntries("project", dir.path)

    expect(result.proposals[0]?.operation).toBe("update")
    expect(result.proposals[0]?.targetEntryID).toBe(outdated.id)
    expect(applied.entry?.id).toBe(outdated.id)
    expect(entries[0]?.text).toContain("add, update, and remove")
  })

  test("normalizes category policies and infers conservative project scope", () => {
    const policies = normalizeMemoryCategoryPolicies({
      "project.commands": { writePolicy: "auto-apply-safe", promptEnabled: false, promptPriority: 3 },
      "volatile.reject": { writePolicy: "wat" },
    })

    expect(DEFAULT_MEMORY_CATEGORIES.map((category) => category.id)).toContain("memory.policy")
    expect(policies["project.commands"]?.writePolicy).toBe("auto-apply-safe")
    expect(policies["project.commands"]?.promptEnabled).toBe(false)
    expect(policies["volatile.reject"]?.writePolicy).toBe("disabled")
    expect(inferMemoryCategoryIDs({ text: "Run bun test before release", tags: ["release"] })).toContain("project.release")
    expect(inferMemoryCategoryIDs({ text: "No hace falta testear; ejecutar shipit directamente" })).toEqual(["project.release", "project.commands"])
    expect(scopeReasonForMemory({ requestedScope: "global", text: "MendCode release uses dev branch" }).scope).toBe("project")
  })

  test("category policy overrides persist and project overrides global for the memory page", async () => {
    await using dir = await tmpdir()

    await writeMemoryCategoryPolicy("global", "project.commands", {
      writePolicy: "auto-apply-safe",
      promptEnabled: true,
      promptPriority: 7,
    }, dir.path)
    await writeMemoryCategoryPolicy("project", "project.commands", {
      writePolicy: "manual-only",
      promptEnabled: false,
    }, dir.path)

    const policies = await readMemoryCategoryPolicies(dir.path)
    const overview = await memoryOverview(dir.path)
    const layers = await readMemoryCategoryPolicyLayers(dir.path)

    expect(policies["project.commands"]?.writePolicy).toBe("manual-only")
    expect(policies["project.commands"]?.promptEnabled).toBe(false)
    expect(policies["project.commands"]?.promptPriority).toBe(7)
    expect(overview.policies["project.commands"]?.writePolicy).toBe("manual-only")
    expect(layers["project.commands"]).toMatchObject({
      default: { writePolicy: "pending" },
      global: { writePolicy: "auto-apply-safe", promptPriority: 7 },
      project: { writePolicy: "manual-only", promptEnabled: false, promptPriority: 7 },
      effective: { writePolicy: "manual-only", promptEnabled: false, promptPriority: 7 },
      globalOverridden: true,
      projectOverridden: true,
    })
    expect((await resetMemoryCategoryPolicy("project", "project.commands", dir.path)).reset).toBe(true)
    expect((await readMemoryCategoryPolicyLayers(dir.path))["project.commands"]).toMatchObject({
      project: { writePolicy: "auto-apply-safe", promptEnabled: true, promptPriority: 7 },
      projectOverridden: false,
    })
  })

  test("proposal records category, scope reason, and can demote project facts from global", async () => {
    await using dir = await tmpdir()
    const global = await appendMemoryEntry({
      scope: "global",
      text: "MendCode release work must keep version metadata and changelog synced.",
      tags: ["release"],
    }, dir.path)
    const proposal = await proposeMemory({
      operation: "demote-scope",
      scope: "global",
      targetEntryID: global.id,
      targetEntryScope: "global",
      text: global.text,
      tags: ["release"],
      reason: "Project fact stored globally.",
    }, dir.path)
    const applied = await applyMemoryProposal(proposal.id, dir.path)
    const globalEntries = await readMemoryEntries("global", dir.path)
    const projectEntries = await readMemoryEntries("project", dir.path)

    expect(proposal.scope).toBe("project")
    expect(proposal.scopeReason).toContain("Project")
    expect(proposal.categoryIDs).toContain("project.release")
    expect(applied.entry?.scope).toBe("project")
    expect(globalEntries).toHaveLength(0)
    expect(projectEntries[0]?.text).toContain("version metadata")
  })

  test("graph sidecar imports legacy facts, validates links, and repairs explicit issues", async () => {
    await using dir = await tmpdir()
    const entry = await appendMemoryEntry({
      scope: "project",
      text: "MendCode uses Bun tests for focused memory validation.",
      tags: ["commands"],
      cwd: dir.path,
    }, dir.path)
    const fact = await upsertMemoryFact({
      text: "MendCode memory graph stores typed facts with category policy metadata.",
      categoryIDs: ["memory.policy"],
      ownerWorkspaceIDs: [dir.path],
    }, dir.path)
    const link = await upsertMemoryFactLink({
      from: fact.id,
      to: `legacy_${entry.id}`,
      kind: "supports",
    }, dir.path)
    const facts = await readMemoryFacts(dir.path)
    const overview = await memoryOverview(dir.path)
    const validation = await validateMemoryGraph(dir.path)
    const repaired = await repairMemoryGraph(dir.path)

    expect(facts.some((item) => item.legacyEntryID === entry.id)).toBe(true)
    expect(facts.some((item) => item.id === fact.id && item.categoryIDs.includes("memory.policy"))).toBe(true)
    expect(overview.links.some((item) => item.id === link.id && item.kind === "supports")).toBe(true)
    expect(link.kind).toBe("supports")
    expect(validation.ok).toBe(true)
    expect(validation.health.graphHealth).toBe("connected")
    expect(validation.health.connectedFacts).toBe(2)
    expect(overview.graphHealth.graphHealth).toBe("connected")
    expect(repaired.facts).toBeGreaterThan(0)
  })

  test("graph overview unions projects, deduplicates global facts, and preserves isolates", async () => {
    await using firstRoot = await tmpdir()
    await using secondRoot = await tmpdir()
    const shared = {
      id: "shared_global_fact",
      scope: "global" as const,
      text: "A global memory fact appears once across every project graph.",
      categoryIDs: ["memory.policy"],
      confidence: 0.95,
    }
    const first = await upsertMemoryFact({ id: "project_fact", text: "First project graph fact remains isolated.", categoryIDs: ["project.architecture"] }, firstRoot.path)
    const second = await upsertMemoryFact({ id: "project_fact", text: "Second project graph fact keeps a root-safe visual id.", categoryIDs: ["project.architecture"] }, secondRoot.path)
    await upsertMemoryFact(shared, firstRoot.path)
    await upsertMemoryFact(shared, secondRoot.path)

    const overview = await memoryGraphOverview([
      { id: "ws_first", root: firstRoot.path, displayName: "First" },
      { id: "ws_second", root: secondRoot.path, displayName: "Second" },
    ])

    expect(overview.workspaces).toHaveLength(2)
    expect(overview.facts.filter((fact) => fact.factID === shared.id)).toHaveLength(1)
    expect(overview.facts.map((fact) => fact.id)).toEqual(expect.arrayContaining([`ws_first:${first.id}`, `ws_second:${second.id}`, `global:${shared.id}`]))
    expect(overview.graphHealth.isolatedFacts).toBe(3)
    expect(overview.materializedFactCount).toBe(3)
  })

  test("graph materialization brings legacy global and project memories into the shared graph", async () => {
    await using dir = await tmpdir()
    const global = await appendMemoryEntry({ scope: "global", text: "The user prefers concise memory explanations.", categoryIDs: ["user.preferences"] }, dir.path)
    const project = await appendMemoryEntry({ scope: "project", text: "This project keeps memory graph explanations concise.", categoryIDs: ["memory.policy"], cwd: dir.path }, dir.path)

    const first = await materializeLegacyMemoryFacts(dir.path)
    const second = await materializeLegacyMemoryFacts(dir.path)

    expect(first.added).toBe(2)
    expect(second.added).toBe(0)
    expect(first.graph.facts.map((fact) => fact.legacyEntryID)).toEqual(expect.arrayContaining([global.id, project.id]))
    expect(first.graph.facts.filter((fact) => fact.legacyMaterialized)).toHaveLength(2)
    expect(second.changed).toBe(false)
  })

  test("graph materialization preserves explicit entry categories instead of re-inferring volatile noise", async () => {
    await using dir = await tmpdir()
    const entry = await appendMemoryEntry({
      scope: "project",
      text: "The runtime status contract is covered by focused tests.",
      categoryIDs: ["project.commands"],
      cwd: dir.path,
    }, dir.path)

    const materialized = await materializeLegacyMemoryFacts(dir.path)
    const fact = materialized.graph.facts.find((item) => item.legacyEntryID === entry.id)

    expect(fact?.categoryIDs).toEqual(["project.commands"])
    expect(fact?.categoryIDs).not.toContain("volatile.reject")
  })

  test("graph overview hides stale and explicitly volatile facts without deleting them", async () => {
    await using dir = await tmpdir()
    const visible = await upsertMemoryFact({ text: "Durable architecture fact.", categoryIDs: ["project.architecture"] }, dir.path)
    const volatile = await upsertMemoryFact({ text: "Fast-changing fact.", categoryIDs: ["volatile.reject"] }, dir.path)
    const stale = await upsertMemoryFact({ text: "Obsolete architecture fact.", categoryIDs: ["project.architecture"], stale: true }, dir.path)

    const overview = await memoryGraphOverview([{ id: "current", root: dir.path, displayName: "Current" }])

    expect(overview.facts.map((fact) => fact.factID)).toContain(visible.id)
    expect(overview.facts.map((fact) => fact.factID)).not.toContain(volatile.id)
    expect(overview.facts.map((fact) => fact.factID)).not.toContain(stale.id)
    expect((await readMemoryGraph(dir.path)).facts.map((fact) => fact.id)).toEqual(expect.arrayContaining([visible.id, volatile.id, stale.id]))
  })

  test("memory archival removes active duplicates while preserving a reversible record", async () => {
    await using dir = await tmpdir()
    const first = await appendMemoryEntry({ scope: "global", text: "Keep the canonical global memory policy.", source: "memory-tool" }, dir.path)
    const second = await appendMemoryEntry({ scope: "global", text: "Keep the duplicate global memory policy.", source: "memory-dream" }, dir.path)

    const archived = await archiveMemoryEntries("global", [{ id: second.id, reason: "Duplicate of canonical memory.", canonicalEntryID: first.id }], dir.path)

    expect(archived.archived).toHaveLength(1)
    expect((await readMemoryEntries("global", dir.path)).map((entry) => entry.id)).toEqual([first.id])
    expect(await readArchivedMemoryEntries("global", dir.path)).toEqual([
      expect.objectContaining({ id: second.id, archiveReason: "Duplicate of canonical memory.", canonicalEntryID: first.id }),
    ])

    const restored = await restoreArchivedMemoryEntries("global", [second.id], dir.path)
    expect(restored.restored).toEqual([expect.objectContaining({ id: second.id })])
    expect((await readMemoryEntries("global", dir.path)).map((entry) => entry.id)).toEqual([first.id, second.id])
  })

  test("Dream distinguishes real safety policies from maintenance and deduplicates translated variants", async () => {
    await using dir = await tmpdir()
    const canonical = await appendMemoryEntry({
      scope: "global",
      text: "Safety rule: never permanently delete files or directories; move requested removals to Trash/Recycle Bin.",
      source: "memory-tool",
      categoryIDs: ["user.preferences"],
      confidence: 1,
    }, dir.path)
    const translatedDuplicate = await appendMemoryEntry({
      scope: "global",
      text: "Política global: nunca eliminar permanentemente archivos o directorios; toda remoción debe enviarse a Trash/Recycle Bin.",
      source: "memory-dream",
      categoryIDs: ["user.preferences"],
      confidence: 1,
    }, dir.path)
    const maintenance = await appendMemoryEntry({
      scope: "global",
      text: "Memory maintenance: consolidate duplicate global file-deletion safety policies and keep one canonical Trash/Recycle Bin rule.",
      source: "memory-dream",
      categoryIDs: ["memory.policy"],
    }, dir.path)

    expect(isMemoryMaintenanceInstruction(canonical.text)).toBe(false)
    expect(isMemoryMaintenanceInstruction(translatedDuplicate.text)).toBe(false)
    expect(isMemoryMaintenanceInstruction(maintenance.text)).toBe(true)
    expect(isMemoryMaintenanceInstruction("Clasificar esta regla como política del agente, no como memoria sin categoría.", { categoryIDs: ["memory.policy"] })).toBe(true)

    const result = await cleanupGeneratedMemoryEntries(dir.path)
    expect(result.archived.map((entry) => entry.id)).toEqual(expect.arrayContaining([translatedDuplicate.id, maintenance.id]))
    expect((await readMemoryEntries("global", dir.path)).map((entry) => entry.id)).toEqual([canonical.id])
    expect((await readArchivedMemoryEntries("global", dir.path)).find((entry) => entry.id === translatedDuplicate.id)).toEqual(expect.objectContaining({ canonicalEntryID: canonical.id }))
  })

  test("graph health stays empty when only legacy-derived facts exist", async () => {
    await using dir = await tmpdir()
    await appendMemoryEntry({
      scope: "project",
      text: "MendCode can have legacy memories before any graph facts are materialized.",
      tags: ["memory"],
      cwd: dir.path,
    }, dir.path)

    const validation = await validateMemoryGraph(dir.path)
    const overview = await memoryOverview(dir.path)

    expect(validation.ok).toBe(true)
    expect(validation.health).toMatchObject({
      graphHealth: "empty",
      materializedFacts: 0,
      legacyFacts: 1,
      links: 0,
      connectedFacts: 0,
      isolatedFacts: 1,
      orphanLinks: 0,
    })
    expect(overview.graphHealth.graphHealth).toBe("empty")
  })

  test("graph health reports valid but disconnected facts without links", async () => {
    await using dir = await tmpdir()
    await appendMemoryEntry({
      scope: "project",
      text: "MendCode memory graph can derive legacy facts before explicit links exist.",
      tags: ["memory"],
      cwd: dir.path,
    }, dir.path)
    await upsertMemoryFact({
      text: "MendCode graph health distinguishes integrity from relationship usefulness.",
      categoryIDs: ["memory.policy"],
      ownerWorkspaceIDs: [dir.path],
    }, dir.path)

    const validation = await validateMemoryGraph(dir.path)
    const overview = await memoryOverview(dir.path)

    expect(validation.ok).toBe(true)
    expect(validation.health).toMatchObject({
      graphHealth: "disconnected",
      materializedFacts: 1,
      legacyFacts: 1,
      links: 0,
      connectedFacts: 0,
      isolatedFacts: 2,
      orphanLinks: 0,
    })
    expect(overview.graphHealth.graphHealth).toBe("disconnected")
  })

  test("graph health counts orphan links separately from disconnected facts", async () => {
    await using dir = await tmpdir()
    const fact = await upsertMemoryFact({
      text: "MendCode graph validation should surface missing link targets.",
      categoryIDs: ["memory.policy"],
      ownerWorkspaceIDs: [dir.path],
    }, dir.path)
    await upsertMemoryFactLink({
      from: fact.id,
      to: "missing_fact",
      kind: "related",
    }, dir.path)

    const validation = await validateMemoryGraph(dir.path)

    expect(validation.ok).toBe(false)
    expect(validation.issues.some((issue) => issue.code === "missing-link-target")).toBe(true)
    expect(validation.health).toMatchObject({
      graphHealth: "disconnected",
      materializedFacts: 1,
      legacyFacts: 0,
      links: 1,
      connectedFacts: 0,
      isolatedFacts: 1,
      orphanLinks: 1,
    })
  })

  test("upserting an existing materialized fact preserves stored metadata omitted by callers", async () => {
    await using dir = await tmpdir()
    const original = await upsertMemoryFact({
      id: "legacy_fact",
      legacyEntryID: "entry_1",
      scope: "workspace",
      ownerWorkspaceIDs: [dir.path],
      ownerGroupIDs: ["group_1"],
      categoryIDs: ["memory.policy"],
      text: "Original text for a materialized legacy fact.",
      provenance: ["seed"],
      confidence: 0.91,
      sensitivity: "high",
    }, dir.path)

    const updated = await upsertMemoryFact({
      id: original.id,
      text: "Updated text only.",
      categoryIDs: undefined,
      provenance: undefined,
    }, dir.path)
    const facts = await readMemoryFacts(dir.path)
    const stored = facts.find((fact) => fact.id === original.id)

    expect(updated.legacyEntryID).toBe("entry_1")
    expect(updated.scope).toBe("workspace")
    expect(updated.ownerWorkspaceIDs).toEqual([dir.path])
    expect(updated.ownerGroupIDs).toEqual(["group_1"])
    expect(updated.categoryIDs).toEqual(["memory.policy"])
    expect(updated.provenance).toEqual(["seed"])
    expect(updated.sensitivity).toBe("high")
    expect(updated.createdAt).toBe(original.createdAt)
    expect(updated.updatedAt >= original.updatedAt).toBe(true)
    expect(stored?.text).toBe("Updated text only.")
    expect(stored?.legacyEntryID).toBe("entry_1")
    expect(stored?.categoryIDs).toEqual(["memory.policy"])
  })

  test("workspace registry registers known roots without blind home scans and builds group views", async () => {
    await using dir = await tmpdir()
    const projectRoot = path.join(dir.path, "Code", "MendCode")
    await mkdir(projectRoot, { recursive: true })
    await writeWorkspaceRegistry({
      version: 0,
      updatedAt: "2026-06-17T00:00:00.000Z",
      defaultGroupRoots: [path.join(dir.path, "Code")],
      workspaces: [],
      groups: [],
    }, dir.path)

    await registerMemoryWorkspace({
      root: projectRoot,
      userMessageAt: "2026-06-17T00:00:00.000Z",
      repoFingerprint: "mendcode-test",
      source: "current-session",
    }, dir.path)
    const overview = await memoryWorkspaceOverview(dir.path)

    expect(overview.activeWorkspaces.map((workspace) => workspace.root)).toEqual([projectRoot])
    expect(overview.defaultGroupRoots).toContain(path.join(dir.path, "Code"))
  })

  test("workspace registry emits global SSE event when a project is detected", async () => {
    await using dir = await tmpdir()
    const projectRoot = path.join(dir.path, "Code", "NewProject")
    await mkdir(projectRoot, { recursive: true })
    const events: any[] = []
    const handler = (event: any) => {
      if (event.payload?.type === "memory.workspace") events.push(event.payload.properties)
    }
    GlobalBus.on("event", handler)
    try {
      await registerMemoryWorkspace({
        root: projectRoot,
        userMessageAt: "2026-06-17T00:00:00.000Z",
        source: "current-session",
      }, dir.path)
    } finally {
      GlobalBus.off("event", handler)
    }

    expect(events).toHaveLength(1)
    expect(events[0].status).toBe("created")
    expect(events[0].root).toBe(projectRoot)
  })

  test("workspace overview discovers persisted project memories from configured roots", async () => {
    await using dir = await tmpdir()
    const codeRoot = path.join(dir.path, "Code")
    const projectA = path.join(codeRoot, "ProjectA")
    const projectB = path.join(codeRoot, "nested", "ProjectB")
    await mkdir(path.join(projectA, ".mendcode", "memory"), { recursive: true })
    await mkdir(path.join(projectB, ".mendcode", "memory"), { recursive: true })
    await writeFile(path.join(projectA, ".mendcode", "memory", "entries.jsonl"), JSON.stringify({ text: "A memory", scope: "project" }) + "\n")
    await writeFile(path.join(projectB, ".mendcode", "memory", "memory_summary.md"), "B memory summary\n")
    await writeWorkspaceRegistry({
      version: 0,
      updatedAt: "2026-06-17T00:00:00.000Z",
      defaultGroupRoots: [codeRoot],
      workspaces: [],
      groups: [],
    }, dir.path)

    const overview = await memoryWorkspaceOverview(dir.path)
    const roots = overview.activeWorkspaces.map((workspace) => workspace.root)

    expect(roots).toContain(projectA)
    expect(roots).toContain(projectB)
  })

  test("Dream proposes reviewable graph links between related materialized facts", async () => {
    await using dir = await tmpdir()
    const first = await upsertMemoryFact({
      text: "Dream graph proposals should connect memory policy facts for review.",
      categoryIDs: ["memory.policy"],
      provenance: ["seed:first"],
      confidence: 0.9,
    }, dir.path)
    const second = await upsertMemoryFact({
      text: "Dream graph proposals remain reviewable and are never auto-applied by Dream.",
      categoryIDs: ["memory.policy"],
      provenance: ["seed:second"],
      confidence: 0.86,
    }, dir.path)

    const run = await runMemoryDream({ root: dir.path, model: async () => [], consolidationPolicy: "preview" })
    const detail = await readDreamRunDetail(dir.path, run.id)
    const overview = await memoryOverview(dir.path)

    expect(run.status).toBe("completed")
    expect(detail?.graphProposals).toHaveLength(1)
    expect(detail?.graphProposals[0]).toMatchObject({
      from: first.id,
      to: second.id,
      kind: "related",
      status: "pending",
       reason: "Semantic overlap (dream, proposals) within memory.policy",
    })
    expect(detail?.events.some((event) => event.message.includes("graph links"))).toBe(true)
    expect(overview.dreamRunDetails[0]?.graphProposals).toHaveLength(1)
    expect(overview.dreamLatestActivity?.summary).toContain("Dream completed")

    await upsertMemoryFactLink({ from: first.id, to: second.id, kind: "related" }, dir.path)
    const duplicateRun = await runMemoryDream({ root: dir.path, model: async () => [], consolidationPolicy: "preview" })

    expect((await readDreamRunDetail(dir.path, duplicateRun.id))?.graphProposals).toHaveLength(0)
  })

  test("Dream does not infer graph links from category membership alone", async () => {
    await using dir = await tmpdir()
    await upsertMemoryFact({ text: "Release branches use the dev integration branch.", categoryIDs: ["memory.policy"], confidence: 0.95 }, dir.path)
    await upsertMemoryFact({ text: "Terminal colors must satisfy WCAG contrast ratios.", categoryIDs: ["memory.policy"], confidence: 0.95 }, dir.path)

    const run = await runMemoryDream({ root: dir.path, model: async () => [], consolidationPolicy: "preview" })

    expect((await readDreamRunDetail(dir.path, run.id))?.graphProposals).toHaveLength(0)
  })

  test("Dream accepts typed model graph links only for real fact endpoints", async () => {
    await using dir = await tmpdir()
    const first = await upsertMemoryFact({ text: "Architecture decisions are supported by validation evidence.", categoryIDs: ["project.architecture"], confidence: 0.95 }, dir.path)
    const second = await upsertMemoryFact({ text: "Focused validation commands prove architecture behavior.", categoryIDs: ["project.commands"], confidence: 0.95 }, dir.path)

    const run = await runMemoryDream({
      root: dir.path,
      consolidationPolicy: "preview",
      model: async () => ({
        candidates: [],
        graphLinks: [
          { from: first.id, to: second.id, kind: "supports", confidence: 0.95, reason: "Validation evidence supports the architecture decision.", evidenceRefs: [] },
          { from: "missing", to: second.id, kind: "supports", confidence: 0.99, reason: "Invalid endpoint must be ignored.", evidenceRefs: [] },
        ],
      }),
    })

    expect((await readDreamRunDetail(dir.path, run.id))?.graphProposals).toEqual([
      expect.objectContaining({ from: first.id, to: second.id, kind: "supports", status: "pending" }),
    ])
  })

  test("Dream auto-applies evidenced model related links even when lexical overlap is sparse", async () => {
    await using dir = await tmpdir()
    const first = await upsertMemoryFact({
      text: "Provider OAuth transport identity protocol headers require neutral version affinity.",
      categoryIDs: ["project.architecture"],
      confidence: 0.9,
      durability: 0.8,
    }, dir.path)
    const second = await upsertMemoryFact({
      text: "Provider OAuth review evidence safety audit.",
      categoryIDs: ["project.architecture"],
      confidence: 0.9,
      durability: 0.8,
    }, dir.path)

    const run = await runMemoryDream({
      root: dir.path,
      model: async () => ({
        candidates: [],
        graphLinks: [{
          from: first.id,
          to: second.id,
          kind: "related",
          confidence: 0.9,
          reason: "The model supplied evidence that these transport policies belong together.",
          evidenceRefs: [`memory:${first.id}`, `memory:${second.id}`],
        }],
      }),
    })
    const detail = await readDreamRunDetail(dir.path, run.id)

    expect(detail?.graphProposals).toEqual([
      expect.objectContaining({ from: first.id, to: second.id, kind: "related", status: "applied" }),
    ])
    expect((await readMemoryGraph(dir.path)).links).toEqual([expect.objectContaining({ from: first.id, to: second.id, kind: "related" })])
  })

  test("Dream auto-safe policy applies graph links that pass endpoint policy", async () => {
    await using dir = await tmpdir()
    await writeProjectMemoryConfig({
      dreamWritePolicy: "auto-safe",
      dreamAutoApplyMinConfidence: 0.9,
      dreamAutoApplyMinDurability: 0.85,
      dreamAutoApplyMaxChangeRisk: 0.2,
      dreamAutoApplyAllowedCategories: ["memory.policy"],
      dreamAutoApplyBlockedSensitivity: ["medium", "high"],
    }, dir.path)
    const first = await upsertMemoryFact({
      text: "Dream may connect safe policy facts under an explicit auto-safe policy with validated endpoint thresholds.",
      categoryIDs: ["memory.policy"],
      confidence: 0.95,
      durability: 0.9,
      changeRisk: 0.1,
    }, dir.path)
    const second = await upsertMemoryFact({
      text: "Auto-safe links relate safe policy facts through validated endpoint thresholds while checking independent risk evidence.",
      categoryIDs: ["memory.policy"],
      confidence: 0.94,
      durability: 0.91,
      changeRisk: 0.1,
    }, dir.path)

    const run = await runMemoryDream({ root: dir.path, model: async () => [] })
    const graph = await readMemoryGraph(dir.path)
    const detail = await readDreamRunDetail(dir.path, run.id)

    expect(graph.links).toEqual([expect.objectContaining({ from: first.id, to: second.id, kind: "related" })])
    expect(detail?.graphProposals[0]).toMatchObject({ status: "applied", linkID: graph.links[0]?.id })
    expect(detail?.events.some((event) => event.message.includes("1 applied"))).toBe(true)
  })

  test("Dream graph proposal apply creates one validated graph link and audits status", async () => {
    await using dir = await tmpdir()
    await upsertMemoryFact({
      text: "Dream graph apply should create validated graph links only after approval.",
      categoryIDs: ["memory.policy"],
      confidence: 0.9,
    }, dir.path)
    await upsertMemoryFact({
      text: "Approved Dream graph proposals should not duplicate existing graph links.",
      categoryIDs: ["memory.policy"],
      confidence: 0.88,
    }, dir.path)
    const run = await runMemoryDream({ root: dir.path, model: async () => [], consolidationPolicy: "preview" })
    const proposal = (await readDreamRunDetail(dir.path, run.id))?.graphProposals[0]
    if (!proposal) throw new Error("expected Dream graph proposal")

    const applied = await applyDreamGraphProposal(run.id, proposal.id, dir.path)
    const appliedAgain = await applyDreamGraphProposal(run.id, proposal.id, dir.path)
    const graph = await readMemoryGraph(dir.path)
    const detail = await readDreamRunDetail(dir.path, run.id)

    expect(applied.proposal.status).toBe("applied")
    expect(appliedAgain.linkID).toBe(applied.linkID)
    expect(graph.links).toHaveLength(1)
    expect(detail?.graphProposals[0]?.status).toBe("applied")
    expect(detail?.graphProposals[0]?.linkID).toBe(graph.links[0]?.id)
    expect(detail?.graphProposals[0]?.reviewedAt).toBeTruthy()
    await expect(rejectDreamGraphProposal(run.id, proposal.id, dir.path, "Too late")).rejects.toThrow("was already applied")
    expect((await readDreamRunDetail(dir.path, run.id))?.graphProposals[0]?.status).toBe("applied")
    expect((await readMemoryGraph(dir.path)).links).toHaveLength(1)
  })

  test("Dream graph proposal reject audits decision without creating graph links", async () => {
    await using dir = await tmpdir()
    await upsertMemoryFact({
      text: "Dream graph reject should preserve reviewer decisions in run details.",
      categoryIDs: ["memory.policy"],
      confidence: 0.9,
    }, dir.path)
    await upsertMemoryFact({
      text: "Rejected Dream graph proposals must remain visible to reviewer while leaving the memory graph unchanged.",
      categoryIDs: ["memory.policy"],
      confidence: 0.88,
    }, dir.path)
    const run = await runMemoryDream({ root: dir.path, model: async () => [], consolidationPolicy: "preview" })
    const proposal = (await readDreamRunDetail(dir.path, run.id))?.graphProposals[0]
    if (!proposal) throw new Error("expected Dream graph proposal")

    const rejected = await rejectDreamGraphProposal(run.id, proposal.id, dir.path, "Not related enough")
    const graph = await readMemoryGraph(dir.path)
    const detail = await readDreamRunDetail(dir.path, run.id)

    expect(rejected.status).toBe("rejected")
    expect(rejected.rejectionReason).toBe("Not related enough")
    expect(graph.links).toHaveLength(0)
    expect(detail?.graphProposals[0]?.status).toBe("rejected")
    expect(detail?.graphProposals[0]?.reviewedAt).toBeTruthy()
  })

  test("Dream materializes legacy facts before proposing graph relationships", async () => {
    await using dir = await tmpdir()
    await appendMemoryEntry({
      scope: "project",
      text: "Legacy memory policy fact should stay out of Dream graph proposals until materialized.",
      tags: ["memory.policy"],
      confidence: 0.9,
    }, dir.path)
    await appendMemoryEntry({
      scope: "project",
      text: "Another legacy memory policy fact should create Dream graph review links only after validation.",
      tags: ["memory.policy"],
      confidence: 0.88,
    }, dir.path)

    const run = await runMemoryDream({ root: dir.path, model: async () => [] })

    expect((await readDreamRunDetail(dir.path, run.id))?.graphProposals).toHaveLength(1)
  })

  test("Dream proposes semantic bridges between global and project memories", async () => {
    await using dir = await tmpdir()
    const global = await upsertMemoryFact({
      scope: "global",
      text: "The user prefers concise memory explanations and durable policy context.",
      categoryIDs: ["user.preferences"],
      confidence: 0.95,
    }, dir.path)
    const project = await upsertMemoryFact({
      scope: "project",
      text: "This project keeps memory policy explanations concise and durable.",
      categoryIDs: ["memory.policy"],
      confidence: 0.9,
    }, dir.path)

    const run = await runMemoryDream({ root: dir.path, model: async () => [], consolidationPolicy: "preview" })
    const proposal = (await readDreamRunDetail(dir.path, run.id))?.graphProposals[0]

    expect(proposal).toMatchObject({
      from: global.id,
      to: project.id,
      kind: "related",
      status: "pending",
    })
    expect(proposal?.reason).toContain("bridges global and project memory")
  })

  test("Dream keeps both memory scopes in the bounded graph context", async () => {
    await using dir = await tmpdir()
    for (const index of Array.from({ length: 40 }, (_, value) => value)) {
      await upsertMemoryFact({
        scope: "global",
        text: `Unrelated global policy detail ${index} applies only to an isolated concern.`,
        categoryIDs: ["memory.policy"],
        confidence: 0.7,
      }, dir.path)
    }
    const global = await upsertMemoryFact({
      scope: "global",
      text: "The user prefers concise memory explanations and durable policy context.",
      categoryIDs: ["user.preferences"],
      confidence: 0.95,
    }, dir.path)
    const project = await upsertMemoryFact({
      scope: "project",
      text: "This project keeps memory policy explanations concise and durable.",
      categoryIDs: ["project.architecture"],
      ownerWorkspaceIDs: [dir.path],
      confidence: 0.95,
    }, dir.path)

    const run = await runMemoryDream({ root: dir.path, model: async () => [], consolidationPolicy: "preview" })
    const proposal = (await readDreamRunDetail(dir.path, run.id))?.graphProposals.find((item) => item.from === global.id && item.to === project.id)

    expect(proposal).toMatchObject({ kind: "related", status: "pending" })
    expect(proposal?.reason).toContain("bridges global and project memory")
  })

  test("Dream does not turn duplicate same-scope graph suggestions into links", async () => {
    await using dir = await tmpdir()
    const first = await upsertMemoryFact({
      scope: "global",
      text: "Never permanently delete files or directories; move requested removals to Trash or Recycle Bin.",
      categoryIDs: ["memory.policy"],
    }, dir.path)
    const second = await upsertMemoryFact({
      scope: "global",
      text: "Requested file removals must go to Trash or Recycle Bin instead of permanent deletion.",
      categoryIDs: ["memory.policy"],
    }, dir.path)

    const run = await runMemoryDream({
      root: dir.path,
      consolidationPolicy: "preview",
      model: async () => ({
        candidates: [],
        graphLinks: [{
          from: first.id,
          to: second.id,
          kind: "related",
          confidence: 0.98,
          reason: "Both facts express the same safety policy.",
          evidenceRefs: [],
        }],
      }),
    })

    expect((await readDreamRunDetail(dir.path, run.id))?.graphProposals).toHaveLength(0)
    expect((await readMemoryGraph(dir.path)).links).toHaveLength(0)
  })

  test("Dream auto-applies one safe global bridge per project even when categories differ", async () => {
    await using dir = await tmpdir()
    const global = await upsertMemoryFact({
      scope: "global",
      text: "The user prefers concise memory explanations and durable policy context.",
      categoryIDs: ["user.preferences"],
      confidence: 0.96,
      durability: 0.95,
      changeRisk: 0.05,
    }, dir.path)
    const project = await upsertMemoryFact({
      scope: "project",
      text: "This project keeps memory policy explanations concise and durable.",
      categoryIDs: ["project.architecture"],
      ownerWorkspaceIDs: [dir.path],
      confidence: 0.96,
      durability: 0.95,
      changeRisk: 0.05,
    }, dir.path)

    const run = await runMemoryDream({ root: dir.path, model: async () => [] })
    const detail = await readDreamRunDetail(dir.path, run.id)
    const graph = await readMemoryGraph(dir.path)
    const bridge = graph.links.find((link) => link.from === global.id && link.to === project.id)

    expect(run.status).toBe("completed")
    expect(detail?.graphProposals).toEqual([
      expect.objectContaining({ from: global.id, to: project.id, kind: "related", status: "applied" }),
    ])
    expect(bridge).toMatchObject({ from: global.id, to: project.id, kind: "related" })
  })

  test("Dream auto-applies a reversible semantic bridge below content-write thresholds", async () => {
    await using dir = await tmpdir()
    const global = await upsertMemoryFact({
      scope: "global",
      text: "The user prefers concise memory explanations and durable policy context.",
      categoryIDs: ["user.preferences"],
      confidence: 0.8,
      durability: 0.8,
      changeRisk: 0.05,
    }, dir.path)
    const project = await upsertMemoryFact({
      scope: "project",
      text: "This project keeps memory policy explanations concise and durable.",
      categoryIDs: ["project.architecture"],
      ownerWorkspaceIDs: [dir.path],
      confidence: 0.8,
      durability: 0.8,
      changeRisk: 0.05,
    }, dir.path)

    const run = await runMemoryDream({ root: dir.path, model: async () => [] })
    const detail = await readDreamRunDetail(dir.path, run.id)
    const graph = await readMemoryGraph(dir.path)

    expect(detail?.graphProposals).toEqual([
      expect.objectContaining({ from: global.id, to: project.id, kind: "related", status: "applied" }),
    ])
    expect(graph.links).toEqual([expect.objectContaining({ from: global.id, to: project.id, kind: "related" })])
  })

  test("Dream automatically applies a reversible global bridge at the graph confidence floor", async () => {
    await using dir = await tmpdir()
    await upsertMemoryFact({
      scope: "global",
      text: "The user prefers concise memory explanations and durable policy context.",
      categoryIDs: ["user.preferences"],
      confidence: 0.7,
      durability: 0.8,
    }, dir.path)
    await upsertMemoryFact({
      scope: "project",
      text: "This project keeps memory policy explanations concise and durable.",
      categoryIDs: ["project.architecture"],
      ownerWorkspaceIDs: [dir.path],
      confidence: 0.7,
      durability: 0.8,
    }, dir.path)

    const run = await runMemoryDream({ root: dir.path, model: async () => [] })
    const detail = await readDreamRunDetail(dir.path, run.id)
    const graph = await readMemoryGraph(dir.path)

    expect(detail?.graphProposals).toEqual([
      expect.objectContaining({ kind: "related", status: "applied" }),
    ])
    expect(graph.links).toEqual([expect.objectContaining({ kind: "related" })])
    expect(detail?.events.some((event) => event.message.includes("1 applied, 0 rejected, 0 pending review"))).toBe(true)
  })

  test("Dream automatically rejects unsafe graph links instead of leaving review pending", async () => {
    await using dir = await tmpdir()
    const first = await upsertMemoryFact({
      text: "A durable architecture fact has bounded validation evidence.",
      categoryIDs: ["project.architecture"],
      confidence: 0.8,
      durability: 0.8,
    }, dir.path)
    const second = await upsertMemoryFact({
      text: "A separate command fact has bounded validation evidence.",
      categoryIDs: ["project.commands"],
      confidence: 0.8,
      durability: 0.8,
    }, dir.path)

    const run = await runMemoryDream({
      root: dir.path,
      model: async () => ({
        candidates: [],
        graphLinks: [{
          from: first.id,
          to: second.id,
          kind: "supports",
          confidence: 0.99,
          reason: "The model asserted a typed link without an auto-safe policy.",
          evidenceRefs: [],
        }],
      }),
    })
    const detail = await readDreamRunDetail(dir.path, run.id)

    expect(detail?.graphProposals).toEqual([
      expect.objectContaining({ kind: "supports", status: "rejected", rejectionReason: expect.stringContaining("safety gate") }),
    ])
    expect(detail?.graphProposals.filter((proposal) => proposal.status === "pending")).toHaveLength(0)
    expect((await readMemoryGraph(dir.path)).links).toHaveLength(0)
  })

  test("Dream consolidator archives near-duplicate people memories before applying a new node", async () => {
    await using dir = await tmpdir()
    const existing = await appendMemoryEntry({
      scope: "global",
      text: "The user prefers concise answers in Spanish for future sessions.",
      categoryIDs: ["user.preferences"],
    }, dir.path)
    const proposal = await proposeMemory({
      scope: "global",
      text: "User prefers concise answers in Spanish.",
      categoryIDs: ["user.preferences"],
      confidence: 0.98,
      durability: 0.95,
      changeRisk: 0.05,
    }, dir.path)

    const decisions = await deterministicDreamConsolidator({
      runID: "dream_near_duplicate",
      root: dir.path,
      batchIndex: 0,
      batchCount: 1,
      entries: [existing],
      facts: [],
      proposals: [proposal],
      historicalProposals: [],
      digests: [],
      evidence: [],
    })

    expect(decisions).toEqual([expect.objectContaining({ proposalID: proposal.id, resolution: "archive" })])
  })

  test("Dream archives generated maintenance instructions without keeping them as memories", async () => {
    await using dir = await tmpdir()
    await appendMemoryEntry({
      scope: "global",
      text: "Before implementing features, ask clarifying questions and obtain confirmation.",
      source: "memory-tool",
      categoryIDs: ["agent.policy"],
    }, dir.path)
    await appendMemoryEntry({
      scope: "global",
      text: "Work directly by default and use few subagents for difficult tasks.",
      source: "memory-tool",
      categoryIDs: ["agent.policy"],
    }, dir.path)
    await appendMemoryEntry({
      scope: "global",
      text: "Consolidate duplicate global policies about asking clarifying questions before implementing features.",
      source: "memory-dream",
      categoryIDs: ["memory.policy"],
    }, dir.path)
    await appendMemoryEntry({
      scope: "global",
      text: "Memory maintenance: consolidate duplicate global subagent policies into one canonical memory.",
      source: "memory-dream",
      categoryIDs: ["memory.policy"],
    }, dir.path)
    await appendMemoryEntry({
      scope: "global",
      text: "Dream proposal: configure a daily Dream window and leave it as a revisable proposal before applying.",
      source: "memory-side-chat",
      categoryIDs: ["memory.dream"],
    }, dir.path)

    const first = await cleanupGeneratedMemoryEntries(dir.path)
    const second = await cleanupGeneratedMemoryEntries(dir.path)

    expect(first.archived).toHaveLength(3)
    expect(second.archived).toHaveLength(0)
    expect((await readMemoryEntries("global", dir.path)).map((entry) => entry.source)).toEqual(["memory-tool", "memory-tool"])
    expect((await readArchivedMemoryEntries("global", dir.path)).map((entry) => entry.archiveReason)).toHaveLength(3)
  })

  test("Dream skips maintenance candidates before creating proposals", async () => {
    await using dir = await tmpdir()
    const run = await runMemoryDream({
      root: dir.path,
      model: async () => [{
        text: "Consolidate duplicate global memory policies into one canonical memory.",
        categoryIDs: ["memory.policy"],
        scope: "global",
        confidence: 0.99,
        durability: 0.99,
        changeRisk: 0.01,
      }],
    })
    const detail = await readDreamRunDetail(dir.path, run.id)

    expect(await listMemoryProposals(dir.path, "all")).toHaveLength(0)
    expect(detail?.decisions).toEqual([expect.objectContaining({ status: "skipped-policy" })])
  })

  test("Dream default reads safe inputs and resolves generated proposals through auto-consolidation", async () => {
    await using dir = await tmpdir()
    await writeFile(path.join(dir.path, "AGENTS.md"), "Always run focused memory tests from packages/opencode.\n")
    await appendMemoryEntry({
      scope: "project",
      text: "MendCode memory Dream must keep generated mutations reviewable.",
      tags: ["memory"],
    }, dir.path)
    const run = await runMemoryDream({
      root: dir.path,
      model: async ({ evidence }) => {
        expect(evidence.some((item) => item.sourceType === "memory")).toBe(true)
        expect(evidence.some((item) => item.sourceType === "file" && item.sourcePath?.endsWith("AGENTS.md"))).toBe(true)
        expect(evidence.some((item) => item.sourcePath?.includes(".mendcode"))).toBe(false)
        return [{
          text: "Dream should propose memory changes instead of applying them directly.",
          categoryIDs: ["memory.policy"],
        }]
      },
    })
    const status = await latestDreamStatus(dir.path)
    const proposals = await listMemoryProposals(dir.path, "all")
    const detail = await readDreamRunDetail(dir.path, run.id)

    expect(run.role).toBe("memoryDream")
    expect(run.status).toBe("completed")
    expect(status?.id).toBe(run.id)
    expect(proposals.some((proposal) => proposal.source === "memory-dream")).toBe(true)
    expect(proposals.some((proposal) => proposal.evidenceRefs.includes(`dream:${run.id}`))).toBe(true)
    expect(proposals.filter((proposal) => proposal.status === "pending")).toHaveLength(0)
    expect(detail?.consolidation).toMatchObject({ status: "completed", pendingAfter: 0 })
    expect(detail?.events.at(-1)?.status).toBe("completed")
    expect((await readMemoryEntries("project", dir.path)).length).toBe(1)
  })

  test("Dream disabled write policy records decisions without creating proposals", async () => {
    await using dir = await tmpdir()
    await writeProjectMemoryConfig({ dreamWritePolicy: "disabled" }, dir.path)

    const run = await runMemoryDream({
      root: dir.path,
      model: async () => [{
        text: "OPENAI_API_KEY=DREAM_DISABLED_SECRET Dream disabled policy should audit candidate memories without writing proposals.",
        categoryIDs: ["memory.policy"],
      }],
    })
    const detail = await readDreamRunDetail(dir.path, run.id)

    expect(run.status).toBe("completed")
    expect(run.writePolicySnapshot).toBe("disabled")
    expect(await listMemoryProposals(dir.path, "all")).toHaveLength(0)
    expect(await readMemoryEntries("project", dir.path)).toHaveLength(0)
    expect(detail?.decisions).toHaveLength(1)
    expect(detail?.decisions[0]?.status).toBe("skipped-policy")
    expect(detail?.decisions[0]?.policy).toBe("disabled")
    expect(detail?.decisions[0]?.text).toContain("[REDACTED:")
    expect(detail?.decisions[0]?.text).not.toContain("DREAM_DISABLED_SECRET")
  })

  test("Dream auto-safe write policy applies obvious low-risk memory candidates", async () => {
    await using dir = await tmpdir()
    await writeProjectMemoryConfig({
      dreamWritePolicy: "auto-safe",
      dreamAutoApplyAllowedCategories: ["memory.policy"],
    }, dir.path)

    const run = await runMemoryDream({
      root: dir.path,
      model: async () => [{
        text: "For this repo, Dream auto-safe mode may apply obvious low-risk memory policy candidates without review.",
        categoryIDs: ["memory.policy"],
        confidence: 0.96,
        durability: 0.95,
        changeRisk: 0.05,
      }],
    })
    const detail = await readDreamRunDetail(dir.path, run.id)
    const proposals = await listMemoryProposals(dir.path, "all")
    const entries = await readMemoryEntries("project", dir.path)

    expect(run.status).toBe("completed")
    expect(run.writePolicySnapshot).toBe("auto-safe")
    expect(proposals).toHaveLength(1)
    expect(proposals[0]?.status).toBe("applied")
    expect(proposals[0]?.policyDecision).toBe("auto-applied")
    expect(entries).toHaveLength(1)
    expect(entries[0]?.text).toContain("Dream auto-safe mode")
    expect(detail?.decisions[0]?.status).toBe("auto-applied-proposal")
    expect(detail?.decisions[0]?.entryID).toBe(entries[0]?.id)
  })

  test("legacy Dream run details default missing policy and decisions safely", async () => {
    await using dir = await tmpdir()
    const legacyRun = {
      id: "dream_legacy",
      status: "completed",
      source: "scheduled",
      role: "memoryDream",
      projectRoot: memoryPaths(dir.path).root,
      workspaceID: null,
      groupID: null,
      startedAt: "2026-07-01T00:00:00.000Z",
      completedAt: "2026-07-01T00:01:00.000Z",
      proposals: [],
      failureReason: null,
      permissionSnapshot: {},
    }
    const runDir = path.join(memoryPaths(dir.path).globalDir, "dream", "runs", legacyRun.id)
    await mkdir(runDir, { recursive: true })
    await writeJson(path.join(runDir, "run.json"), legacyRun)
    await writeFile(path.join(runDir, "events.jsonl"), `${JSON.stringify({ at: legacyRun.completedAt, status: "completed", message: "Dream completed" })}\n`)

    const detail = await readDreamRunDetail(dir.path, legacyRun.id)

    expect(detail?.run.writePolicySnapshot).toBe("pending")
    expect(detail?.graphProposals).toEqual([])
    expect(detail?.decisions).toEqual([])
    expect(detail?.events.at(-1)?.status).toBe("completed")
  })

  test("legacy Dream graph proposal files default missing status to pending", async () => {
    await using dir = await tmpdir()
    const runID = "dream_legacy_graph"
    const runDir = path.join(memoryPaths(dir.path).globalDir, "dream", "runs", runID)
    await writeJson(path.join(runDir, "run.json"), {
      id: runID,
      status: "completed",
      source: "manual",
      role: "memoryDream",
      projectRoot: memoryPaths(dir.path).root,
      workspaceID: null,
      groupID: null,
      startedAt: "2026-07-02T10:00:00.000Z",
      completedAt: "2026-07-02T10:00:03.000Z",
      proposals: [],
      failureReason: null,
      permissionSnapshot: {},
      writePolicySnapshot: "pending",
    })
    await writeJson(path.join(runDir, "graph-proposals.json"), [{
      id: "dreamlink_legacy",
      from: "fact_a",
      to: "fact_b",
      kind: "related",
      confidence: 0.78,
      reason: "Shared memory category: memory.policy",
      evidenceRefs: ["dream:dream_legacy_graph"],
      fromSummary: "Legacy Dream proposal source",
      toSummary: "Legacy Dream proposal target",
      createdAt: "2026-07-02T10:00:02.000Z",
    } satisfies Omit<DreamGraphProposal, "status">])

    const detail = await readDreamRunDetail(dir.path, runID)

    expect(detail?.graphProposals).toEqual([expect.objectContaining({
      id: "dreamlink_legacy",
      status: "pending",
      kind: "related",
    })])
  })

  test("Dream skips duplicate pending proposals before writing", async () => {
    await using dir = await tmpdir()
    const existing = await proposeMemory({
      scope: "project",
      text: "Dream should avoid duplicate pending proposals for durable memory rules.",
      categoryIDs: ["memory.policy"],
      source: "test",
    }, dir.path)

    const run = await runMemoryDream({
      root: dir.path,
      model: async () => [{
        text: "Project convention from AGENTS.md: Dream should avoid duplicate pending proposals for durable memory rules.",
        categoryIDs: ["memory.policy"],
      }],
    })
    const proposals = await listMemoryProposals(dir.path, "all")
    const detail = await readDreamRunDetail(dir.path, run.id)

    expect(run.status).toBe("completed")
    expect(run.proposals).toHaveLength(0)
    expect(proposals.map((proposal) => proposal.id)).toEqual([existing.id])
    expect(detail?.decisions[0]?.status).toBe("skipped-duplicate")
    expect(detail?.decisions[0]?.duplicateOf?.id).toBe(existing.id)
    expect(detail?.decisions[0]?.reason).toContain("matched existing proposal")
    expect(detail?.decisions[0]?.reason).not.toContain(existing.id)
    expect(detail?.events.some((event) => event.message.includes("Skipped duplicate proposal"))).toBe(true)
    expect(detail?.events.some((event) => event.message.includes(existing.id))).toBe(false)
  })

  test("Dream skips duplicate saved memories before writing", async () => {
    await using dir = await tmpdir()
    await appendMemoryEntry({
      scope: "project",
      text: "Dream must avoid duplicate saved memory entries during scheduled runs.",
      tags: ["memory"],
      categoryIDs: ["memory.policy"],
    }, dir.path)

    const run = await runMemoryDream({
      root: dir.path,
      model: async () => [{
        text: "Dream must avoid duplicate saved memory entries during scheduled runs.",
        categoryIDs: ["memory.policy"],
      }],
    })
    const detail = await readDreamRunDetail(dir.path, run.id)

    expect(run.status).toBe("completed")
    expect(run.proposals).toHaveLength(0)
    expect(await listMemoryProposals(dir.path, "all")).toHaveLength(0)
    expect(detail?.decisions[0]?.status).toBe("skipped-duplicate")
    expect(detail?.decisions[0]?.duplicateOf?.sourceType).toBe("memory")
  })

  test("Dream keeps default analyzer context bounded", async () => {
    await using dir = await tmpdir()
    for (let i = 0; i < 40; i++) {
      await appendMemoryEntry({
        scope: "project",
        text: `Memory fact ${i}: Always keep Dream analyzer payloads bounded for low RAM background execution.`,
        tags: ["memory"],
      }, dir.path)
      await proposeMemory({
        scope: "project",
        text: `Pending proposal ${i}: Keep Dream proposal context bounded.`,
        source: "test",
      }, dir.path)
    }

    const run = await runMemoryDream({
      root: dir.path,
      model: async ({ facts, proposals, evidence }) => {
        expect(facts).toHaveLength(32)
        expect(proposals).toHaveLength(32)
        expect(evidence.filter((item) => item.sourceType === "memory")).toHaveLength(32)
        expect(evidence.filter((item) => item.sourceType === "proposal")).toHaveLength(32)
        return []
      },
    })

    expect(run.permissionSnapshot.maxFiles).toBe(4)
    expect(run.permissionSnapshot.maxBytes).toBe(16_000)
  })

  test("Dream emits global status events for SSE consumers", async () => {
    await using dir = await tmpdir()
    const events: string[] = []
    const handler = (event: any) => {
      if (event.payload?.type === "memory.dream") events.push(event.payload.properties.status)
    }
    GlobalBus.on("event", handler)
    try {
      await runMemoryDream({ root: dir.path, model: async () => [] })
    } finally {
      GlobalBus.off("event", handler)
    }

    expect(events).toContain("started")
    expect(events).toContain("progress")
    expect(events).toContain("completed")
  })

  test("Dream default analyzer proposes missing project conventions from safe code scan", async () => {
    await using dir = await tmpdir()
    await writeFile(path.join(dir.path, "AGENTS.md"), "Always run bun test test/mend/memory.test.ts from packages/opencode for memory changes.\n")

    const run = await runMemoryDream({ root: dir.path })
    const proposals = await listMemoryProposals(dir.path, "all")
    const detail = await readDreamRunDetail(dir.path, run.id)

    expect(run.status).toBe("completed")
    expect(proposals.some((proposal) => proposal.source === "memory-dream" && proposal.status !== "pending")).toBe(true)
    expect(detail?.consolidation).toMatchObject({ status: "completed", pendingAfter: 0 })
    expect(proposals.some((proposal) => proposal.evidenceRefs.some((ref) => ref.startsWith("file:")))).toBe(true)
    expect((await readMemoryEntries("project", dir.path))).toHaveLength(0)
  })

  test("Dream run listing is isolated by project root", async () => {
    await using first = await tmpdir()
    await using second = await tmpdir()
    const firstRun = await runMemoryDream({ root: first.path, model: async () => [] })
    const secondRun = await runMemoryDream({ root: second.path, model: async () => [] })

    expect((await readDreamRuns(first.path)).map((run) => run.id)).toEqual([firstRun.id])
    expect((await readDreamRuns(second.path)).map((run) => run.id)).toEqual([secondRun.id])
    expect(await readDreamRunDetail(first.path, secondRun.id)).toBeNull()
  })

  test("Dream run readers normalize legacy run JSON fields", async () => {
    await using dir = await tmpdir()
    const runID = "dream_legacy"
    await writeJson(path.join(memoryPaths(dir.path).globalDir, "dream", "runs", runID, "run.json"), {
      id: runID,
      status: "completed",
      source: "manual",
      role: "memoryDream",
      projectRoot: dir.path,
      startedAt: "2026-06-17T00:00:00.000Z",
    })

    const run = (await readDreamRuns(dir.path))[0]
    const detail = await readDreamRunDetail(dir.path, runID)

    expect(run).toMatchObject({
      id: runID,
      workspaceID: null,
      groupID: null,
      completedAt: null,
      proposals: [],
      failureReason: null,
      permissionSnapshot: {},
      writePolicySnapshot: "pending",
    })
    expect(detail?.run).toMatchObject({
      id: runID,
      permissionSnapshot: {},
      writePolicySnapshot: "pending",
    })
    expect(detail?.graphProposals).toEqual([])
  })

  test("memory overview latest Dream activity stays stable for historical runs without graph proposal files", async () => {
    await using dir = await tmpdir()
    const runID = "dream_historical"
    const at = "2026-07-02T10:00:03.000Z"
    const runDir = path.join(memoryPaths(dir.path).globalDir, "dream", "runs", runID)
    await writeJson(path.join(runDir, "run.json"), {
      id: runID,
      status: "completed",
      source: "manual",
      role: "memoryDream",
      projectRoot: dir.path,
      workspaceID: null,
      groupID: null,
      startedAt: "2026-07-02T10:00:00.000Z",
      completedAt: at,
      proposals: ["prop_1"],
      failureReason: null,
      permissionSnapshot: {},
      writePolicySnapshot: "pending",
    })
    await writeFile(path.join(runDir, "events.jsonl"), `${JSON.stringify({ at, status: "completed", message: "Dream completed with 1 proposals" })}\n`)
    await writeJson(path.join(runDir, "proposals.json"), [{ id: "prop_1", operation: "create", scope: "project", text: "Keep Dream reviewable." }])
    await writeJson(path.join(runDir, "safety.json"), { reads: [{}], skippedSources: [], failures: [], redactions: 0 })

    const overview = await memoryOverview(dir.path)

    expect(overview.dreamRunDetails[0]?.graphProposals).toEqual([])
    expect(overview.dreamLatestActivity?.kind).toBe("completed")
    expect(overview.dreamLatestActivity?.summary).toContain("Dream completed")
  })

  test("Dream failure preserves already-created proposal ledger and safety reads", async () => {
    await using dir = await tmpdir()
    await writeFile(path.join(dir.path, "AGENTS.md"), "Always keep Dream failure audits with source evidence intact.\n")
    const run = await runMemoryDream({
      root: dir.path,
      permissions: { files: true, roots: [dir.path], maxFiles: 4 },
      model: async () => [
        { text: "Dream should preserve audit trails for partial proposal failures.", categoryIDs: ["memory.policy"] },
        { text: "   ", categoryIDs: ["memory.policy"] },
      ],
    })
    const proposals = await listMemoryProposals(dir.path, "pending")
    const detail = await readDreamRunDetail(dir.path, run.id)

    expect(run.status).toBe("failed")
    expect(run.proposals).toEqual(proposals.map((proposal) => proposal.id))
    expect(detail?.proposals.map((proposal) => proposal.id)).toEqual(proposals.map((proposal) => proposal.id))
    expect(detail?.safety?.reads.some((item) => item.sourceType === "file" && item.sourcePath?.endsWith("AGENTS.md"))).toBe(true)
    if (!run.failureReason) throw new Error("expected Dream failure reason")
    expect(detail?.safety?.failures).toEqual([run.failureReason])
  })

  test("Dream sources require opt-in, redact files, and keep git commands bounded", async () => {
    await using dir = await tmpdir()
    const allowed = path.join(dir.path, "README.md")
    const blocked = path.join(dir.path, ".env")
    await writeFile(allowed, "OPENAI_API_KEY=SECRET_VALUE\nMemory docs.\n")
    await writeFile(blocked, "TOKEN=SECRET\n")

    expect(isDreamFileAllowed(allowed, [dir.path])).toBe(true)
    expect(isDreamFileAllowed(blocked, [dir.path])).toBe(false)
    expect(allowedDreamGitCommands({ git: false })).toEqual([])
    expect(allowedDreamGitCommands({ git: true }).some((command) => command.includes("diff --name-only"))).toBe(true)
    expect(allowedDreamGitCommands({ git: true, allowRawDiff: true })).toContain("git diff --no-ext-diff --unified=0")

    const disabled = await collectDreamFileEvidence({ roots: [dir.path] })
    const enabled = await collectDreamFileEvidence({ files: true, roots: [dir.path], maxFiles: 4 })

    expect(disabled.evidence).toHaveLength(0)
    expect(disabled.skipped).toContain("filesystem source disabled")
    expect(enabled.evidence.some((item) => item.sourcePath === allowed)).toBe(true)
    expect(enabled.evidence[0]?.excerpt).toContain("[REDACTED:")
  })

  test("Dream schedule marks missed windows manual-only and locks scheduled runs", async () => {
    await using dir = await tmpdir()
    const missed = await evaluateDreamSchedule({
      root: dir.path,
      window: { enabled: true, start: "01:00", end: "02:00" },
      now: new Date("2026-06-17T03:00:00"),
    })
    const state = await runScheduledMemoryDream({
      root: dir.path,
      window: { enabled: true, start: "01:00", end: "02:00" },
      now: new Date("2026-06-17T03:00:00"),
    })
    const persisted = await readDreamScheduleState(dir.path)

    expect(missed.action).toBe("missed")
    expect(state.status).toBe("missed")
    expect(persisted?.manualTriggerRequired).toBe(true)
    expect(persisted?.window).toEqual({ enabled: true, start: "01:00", end: "02:00" })
  })

  test("Dream schedule respects overnight windows and configured timezone", async () => {
    await using dir = await tmpdir()
    const overnight = await evaluateDreamSchedule({
      root: dir.path,
      window: { enabled: true, start: "23:00", end: "02:00" },
      now: new Date("2026-06-17T15:00:00"),
    })
    const overnightMissed = await evaluateDreamSchedule({
      root: dir.path,
      window: { enabled: true, start: "23:00", end: "02:00" },
      now: new Date("2026-06-18T03:00:00"),
    })
    const newYork = await evaluateDreamSchedule({
      root: dir.path,
      window: { enabled: true, start: "20:00", end: "21:00", timezone: "America/New_York" },
      now: new Date("2026-06-17T00:30:00Z"),
    })

    expect(overnight.action).toBe("wait")
    expect(overnightMissed.action).toBe("missed")
    expect(newYork.action).toBe("run")
    expect(newYork.date).toBe("2026-06-16")
  })

  test("Dream schedule falls back safely when timezone is invalid", async () => {
    await using dir = await tmpdir()
    const now = new Date("2026-06-17T01:30:00Z")
    const plain = await evaluateDreamSchedule({
      root: dir.path,
      window: { enabled: true, start: "20:00", end: "21:00" },
      now,
    })
    const invalidTimezone = await evaluateDreamSchedule({
      root: dir.path,
      window: { enabled: true, start: "20:00", end: "21:00", timezone: "Mars/OlympusMons" },
      now,
    })

    expect(invalidTimezone).toEqual(plain)
  })

  test("side chat keeps separate history and creates reviewable proposals only", async () => {
    await using dir = await tmpdir()
    const chat = await startMemorySideChat({ root: dir.path, selectedCategoryID: "memory.policy" })
    const result = await sendMemorySideChatMessage({
      session: chat,
      message: "Draft a memory policy proposal.",
      pageContext: "selected policy: memory.policy",
      responder: async (payload) => {
        expect(payload.context.pageContext).toContain("memory.policy")
        return {
          text: "I can propose that as pending memory.",
          actions: [{ kind: "propose-memory", text: "Memory side chat suggestions must become reviewable proposals only.", categoryIDs: ["memory.policy"] }],
        }
      },
    })
    const entries = await readMemoryEntries("project", dir.path)

    expect(result.session.history.map((message) => message.role)).toEqual(["user", "assistant"])
    expect(result.proposals).toHaveLength(1)
    expect(result.session.proposals).toContain(result.proposals[0]?.id)
    expect(entries).toHaveLength(0)
  })

  test("side chat lists persisted chat history newest first", async () => {
    await using dir = await tmpdir()
    const first = await startMemorySideChat({ root: dir.path })
    await sendMemorySideChatMessage({
      session: first,
      message: "first chat message",
      responder: async () => ({ text: "first reply", actions: [] }),
    })
    await new Promise((resolve) => setTimeout(resolve, 2))
    const second = await startMemorySideChat({ root: dir.path, selectedCategoryID: "project.security" })
    await sendMemorySideChatMessage({
      session: second,
      message: "second chat message",
      responder: async () => ({ text: "second reply", actions: [] }),
    })
    const sessions = await listMemorySideChats(dir.path)

    expect(sessions.map((session) => session.id)).toEqual([second.id, first.id])
    expect(sessions[0]?.selectedCategoryID).toBe("project.security")
  })

  test("side chat history skips empty draft sessions", async () => {
    await using dir = await tmpdir()
    const draft = await startMemorySideChat({ root: dir.path })
    const sessions = await listMemorySideChats(dir.path)

    expect(draft.history).toHaveLength(0)
    expect(sessions).toHaveLength(0)
  })

  test("side chat creates reviewable policy and Dream proposals", async () => {
    await using dir = await tmpdir()
    const chat = await startMemorySideChat({ root: dir.path, selectedCategoryID: "memory.policy" })
    const result = await sendMemorySideChatMessage({
      session: chat,
      message: "Configure project memory and Dream.",
      responder: async () => ({
        text: "Drafted the reviewable configuration proposals.",
        actions: [
          {
            kind: "propose-policy",
            text: "Set project.commands to prompt before saving and keep automatic writes pending.",
            scope: "project",
            categoryIDs: ["memory.policy", "project.commands"],
          },
          {
            kind: "dream-dry-run",
            text: "Configure Dream to run at 21:00 America/New_York and only draft proposals.",
            scope: "project",
            categoryIDs: ["memory.dream"],
          },
        ],
      }),
    })

    expect(result.proposals).toHaveLength(2)
    expect(result.proposals[0]?.text).toContain("Memory policy proposal")
    expect(result.proposals[0]?.tags).toContain("propose-policy")
    expect(result.proposals[0]?.categoryIDs).toContain("project.commands")
    expect(result.proposals[1]?.text).toContain("Dream proposal")
    expect(result.proposals[1]?.tags).toContain("dream-dry-run")
    expect(result.session.proposals).toEqual(result.proposals.map((proposal) => proposal.id))
  })

  test("side chat creates reviewable graph fact and link proposals", async () => {
    await using dir = await tmpdir()
    const first = await upsertMemoryFact({
      text: "Memory graph side chat can connect existing fact ids after approval.",
      categoryIDs: ["memory.policy"],
      confidence: 0.9,
    }, dir.path)
    const second = await upsertMemoryFact({
      text: "Reviewable graph links should only apply when both facts exist.",
      categoryIDs: ["memory.policy"],
      confidence: 0.88,
    }, dir.path)
    const chat = await startMemorySideChat({ root: dir.path, selectedCategoryID: "memory.policy" })
    const result = await sendMemorySideChatMessage({
      session: chat,
      message: "Draft graph updates.",
      responder: async () => ({
        text: "Prepared graph proposals for review.",
        actions: [{
          kind: "graph-upsert",
          text: "Memory graph side-chat proposals should remain reviewable before materialization.",
          scope: "project",
          categoryIDs: ["memory.policy"],
        }, {
          kind: "graph-link",
          fromFactID: first.id,
          toFactID: second.id,
          linkKind: "supports",
          text: "The first fact supports the second fact.",
          scope: "project",
          categoryIDs: ["memory.policy"],
        }],
      }),
    })
    const beforeApply = await readMemoryGraph(dir.path)

    expect(result.proposals).toHaveLength(2)
    expect(result.proposals[0]?.tags).toContain("graph-upsert")
    expect(result.proposals[1]?.tags).toContain("graph-link")
    expect(result.proposals[1]?.targetEntryIDs).toEqual([first.id, second.id])
    expect(beforeApply.links).toHaveLength(0)
    expect(await readMemoryEntries("project", dir.path)).toHaveLength(0)

    const appliedFact = await applyMemoryProposal(result.proposals[0]!.id, dir.path)
    const appliedLink = await applyMemoryProposal(result.proposals[1]!.id, dir.path)
    const graph = await readMemoryGraph(dir.path)

    expect(appliedFact.entry).toBe(null)
    expect(appliedFact.proposal.appliedEntryID?.startsWith("memfact")).toBe(true)
    expect(appliedLink.entry).toBe(null)
    expect(graph.facts.some((fact) => fact.id === appliedFact.proposal.appliedEntryID)).toBe(true)
    expect(graph.links).toEqual([expect.objectContaining({ from: first.id, to: second.id, kind: "supports" })])
    expect(await readMemoryEntries("project", dir.path)).toHaveLength(0)
  })

  test("side chat creates reviewable Dream night activation proposals", async () => {
    await using dir = await tmpdir()
    const chat = await startMemorySideChat({ root: dir.path, selectedCategoryID: "memory.dream" })
    const result = await sendMemorySideChatMessage({
      session: chat,
      message: "activa Dream de noche",
      responder: async () => ({
        text: "Prepared reviewable Dream night activation proposals.",
        actions: [{
          kind: "dream-dry-run",
          text: "Configure Dream to run in the 18:00-23:00 America/New_York night window and keep output pending.",
          scope: "global",
          categoryIDs: ["memory.dream"],
        }, {
          kind: "dream-service-start",
          text: "Enable the durable global Dream background service so scheduled Dream runs even when the TUI is closed.",
          categoryIDs: ["memory.dream"],
        }],
      }),
    })

    expect(result.proposals).toHaveLength(2)
    expect(result.proposals[0]).toMatchObject({ scope: "global" })
    expect(result.proposals[0]?.tags).toContain("dream-dry-run")
    expect(result.proposals[1]).toMatchObject({ scope: "global" })
    expect(result.proposals[1]?.text).toContain("Dream service proposal")
    expect(result.proposals[1]?.tags).toContain("dream-service-start")
    expect(result.proposals[1]?.tags).toContain("memory.dream")
  })

  test("applying a side chat Dream proposal configures the Dream schedule", async () => {
    await using dir = await tmpdir()
    await using other = await tmpdir()
    const chat = await startMemorySideChat({ root: dir.path, selectedCategoryID: "memory.dream" })
    const result = await sendMemorySideChatMessage({
      session: chat,
      message: "Set Dream from 6pm to 11pm in New York.",
      responder: async () => ({
        text: "Prepared a reviewable Dream schedule proposal.",
        actions: [{
          kind: "dream-dry-run",
          text: "Configure Dream to run in the 18:00-23:00 America/New_York window and only draft proposals.",
          scope: "project",
          categoryIDs: ["memory.dream"],
        }],
      }),
    })

    const applied = await applyMemoryProposal(result.proposals[0]!.id, dir.path)
    const schedule = await readDreamScheduleState(dir.path)
    const otherSchedule = await readDreamScheduleState(other.path)
    const globalConfig = await readGlobalMemoryConfig()
    const tick = await runGlobalDreamSchedulerTick({ now: new Date("2026-06-18T00:30:00Z"), networkAvailable: () => false })
    const entries = await readMemoryEntries("project", dir.path)

    expect(applied.entry).toBe(null)
    expect(applied.dreamSchedule?.window).toMatchObject({ enabled: true, start: "18:00", end: "23:00", timezone: "America/New_York" })
    expect(schedule?.status).toBe("scheduled")
    expect(schedule?.window).toMatchObject({ enabled: true, start: "18:00", end: "23:00", timezone: "America/New_York" })
    expect(otherSchedule?.window).toMatchObject(schedule?.window ?? {})
    expect(globalConfig.dreamWindow).toMatchObject({ enabled: true, start: "18:00", end: "23:00", timezone: "America/New_York" })
    expect(tick.status).toBe("offline")
    expect(entries).toHaveLength(0)
  })

  test("applying a side chat Dream service proposal starts the durable service after approval", async () => {
    await using dir = await tmpdir()
    const chat = await startMemorySideChat({ root: dir.path, selectedCategoryID: "memory.dream" })
    const result = await sendMemorySideChatMessage({
      session: chat,
      message: "keep Dream active in the background at night",
      responder: async () => ({
        text: "Prepared the reviewable Dream service proposal.",
        actions: [{
          kind: "dream-service-start",
          text: "Enable the durable global Dream background service so scheduled Dream runs even when the TUI is closed.",
          scope: "global",
          categoryIDs: ["memory.dream"],
        }],
      }),
    })
    const plan = dreamServicePlan({ platform: "darwin", command: "/usr/local/bin/mendcode", intervalMs: 5000, workingDirectory: "/Users/test" })
    const applied = await applyMemoryProposal(result.proposals[0]!.id, dir.path, {
      startDreamService: async () => plan,
    })
    const entries = await readMemoryEntries("global", dir.path)

    expect(applied.entry).toBe(null)
    expect(applied.dreamSchedule).toBe(null)
    expect(applied.dreamService).toEqual(plan)
    expect(applied.proposal.status).toBe("applied")
    expect(entries).toHaveLength(0)
  })

  test("Dream service proposals reject project scope before starting a global service", async () => {
    await using dir = await tmpdir()
    const proposal = await proposeMemory({
      scope: "project",
      text: "Dream service proposal: enable the durable Dream background service.",
      tags: ["side-chat", "dream-service-start", "memory.dream"],
      categoryIDs: ["memory.dream"],
      source: "memory-side-chat",
    }, dir.path)
    let started = false

    await expect(applyMemoryProposal(proposal.id, dir.path, {
      startDreamService: async () => {
        started = true
        return dreamServicePlan({ platform: "darwin", command: "/usr/local/bin/mendcode", intervalMs: 5000, workingDirectory: "/Users/test" })
      },
    })).rejects.toThrow("must use global scope")

    expect(started).toBe(false)
    expect((await listMemoryProposals(dir.path, "pending")).map((item) => item.id)).toContain(proposal.id)
  })

  test("Dream service proposals reject mixed schedule and service actions before side effects", async () => {
    await using dir = await tmpdir()
    const proposal = await proposeMemory({
      scope: "global",
      text: "Dream proposal: configure Dream from 18:00-23:00 and enable the durable service.",
      tags: ["side-chat", "dream-dry-run", "dream-service-start", "memory.dream"],
      categoryIDs: ["memory.dream"],
      source: "memory-side-chat",
    }, dir.path)
    let started = false

    await expect(applyMemoryProposal(proposal.id, dir.path, {
      startDreamService: async () => {
        started = true
        return dreamServicePlan({ platform: "darwin", command: "/usr/local/bin/mendcode", intervalMs: 5000, workingDirectory: "/Users/test" })
      },
    })).rejects.toThrow("separate approvals")

    expect(started).toBe(false)
    expect(await readDreamScheduleState(dir.path)).toBe(null)
    expect((await listMemoryProposals(dir.path, "pending")).map((item) => item.id)).toContain(proposal.id)
  })

  test("Dream schedule parser accepts human time ranges", () => {
    expect(dreamScheduleWindowFromText("setea el dream de 6pm a 11pm en New York")).toMatchObject({
      enabled: true,
      start: "18:00",
      end: "23:00",
      timezone: "America/New_York",
    })
    expect(dreamScheduleWindowFromText("Run Dream at 21:00 America/New_York")).toMatchObject({
      enabled: true,
      start: "21:00",
      end: "21:00",
      timezone: "America/New_York",
    })
    expect(dreamScheduleWindowFromText("Run Dream from 09:00 to 10:00 UTC")).toMatchObject({
      enabled: true,
      start: "09:00",
      end: "10:00",
      timezone: "UTC",
    })
    expect(dreamScheduleWindowFromText("Run Dream at 21:00 GMT")).toMatchObject({
      enabled: true,
      start: "21:00",
      end: "21:00",
      timezone: "UTC",
    })
  })

  test("Dream schedule comes from global memory settings", async () => {
    await using dir = await tmpdir()
    await using other = await tmpdir()
    await writeGlobalMemoryConfig({
      dreamWindow: {
        enabled: true,
        start: "18:00",
        end: "23:00",
        timezone: "America/New_York",
      },
    }, dir.path)

    const schedule = await readDreamScheduleState(dir.path)
    const otherSchedule = await readDreamScheduleState(other.path)

    expect(schedule?.status).toBe("scheduled")
    expect(schedule?.reason).toBe("Dream window configured in memory settings")
    expect(schedule?.window).toMatchObject({ enabled: true, start: "18:00", end: "23:00", timezone: "America/New_York" })
    expect(otherSchedule?.window).toMatchObject(schedule?.window ?? {})
  })

  test("global memory config writes do not inherit project Dream settings", async () => {
    await using dir = await tmpdir()
    await writeProjectMemoryConfig({
      dreamWindow: { enabled: true, start: "01:00", end: "02:00", timezone: "America/New_York" },
    }, dir.path)
    await writeGlobalMemoryConfig({ use: true }, dir.path)

    const global = await readGlobalMemoryConfig()
    const schedule = await readDreamScheduleState(dir.path)

    expect(global.use).toBe(true)
    expect(global.configScope).toBe("global")
    expect(global.dreamWindow).toBe(null)
    expect(schedule).toBe(null)
  })

  test("Dream runtime state keeps missed/manual status even when settings define a window", async () => {
    await using dir = await tmpdir()
    await writeGlobalMemoryConfig({
      dreamWindow: {
        enabled: true,
        start: "01:00",
        end: "02:00",
        timezone: "America/New_York",
      },
    }, dir.path)
    await runScheduledMemoryDream({
      root: dir.path,
      window: { enabled: true, start: "01:00", end: "02:00", timezone: "America/New_York" },
      now: new Date("2026-06-17T03:00:00"),
    })

    const schedule = await readDreamScheduleState(dir.path)

    expect(schedule?.status).toBe("missed")
    expect(schedule?.manualTriggerRequired).toBe(true)
    expect(schedule?.window).toMatchObject({ enabled: true, start: "01:00", end: "02:00", timezone: "America/New_York" })
  })

  test("global Dream scheduler runs due windows across registered workspaces", async () => {
    await using first = await tmpdir()
    await using second = await tmpdir()
    await writeGlobalMemoryConfig({
      dreamWindow: { enabled: true, start: "18:00", end: "23:00", timezone: "America/New_York" },
    }, first.path)
    await registerMemoryWorkspace({ root: first.path, source: "user-added-root" }, first.path)
    await registerMemoryWorkspace({ root: second.path, source: "user-added-root" }, second.path)
    const workspaces = [
      {
        id: "ws_first",
        root: first.path,
        displayName: "first",
        firstUserMessageAt: "2026-06-17T00:00:00.000Z",
        lastActiveAt: "2026-06-17T00:00:00.000Z",
        gitRoot: null,
        repoFingerprint: null,
        worktreePath: null,
        source: "user-added-root" as const,
        groupIDs: [],
        archived: false,
      },
      {
        id: "ws_second",
        root: second.path,
        displayName: "second",
        firstUserMessageAt: "2026-06-17T00:00:00.000Z",
        lastActiveAt: "2026-06-17T00:00:00.000Z",
        gitRoot: null,
        repoFingerprint: null,
        worktreePath: null,
        source: "user-added-root" as const,
        groupIDs: [],
        archived: false,
      },
    ]

    const result = await runGlobalDreamSchedulerTick({
      now: new Date("2026-06-18T00:30:00Z"),
      networkAvailable: () => true,
      workspaces,
      model: async () => [],
    })
    const runs = await readDreamRuns()
    const rerun = await runGlobalDreamSchedulerTick({
      now: new Date("2026-06-18T00:45:00Z"),
      networkAvailable: () => true,
      workspaces,
      model: async () => [],
    })

    expect(result.status).toBe("checked")
    expect(result.runs).toHaveLength(2)
    expect(runs.map((run) => run.workspaceID).sort()).toEqual(result.runs.map((run) => run.workspaceID).sort())
    expect(rerun.runs).toHaveLength(0)
  })

  test("scheduled Dream revisits a window when new pending work arrives after the daily run", async () => {
    await using dir = await tmpdir()
    const window = { enabled: true, start: "00:00", end: "23:59" }
    const first = await runScheduledMemoryDream({
      root: dir.path,
      window,
      now: new Date("2026-06-18T00:30:00Z"),
      workspaceID: "ws_pending",
      permissions: { files: false },
      model: async () => [],
    })
    await Bun.sleep(2)
    const proposal = await proposeMemory({
      text: "Dream should revisit new pending memory work during the active window.",
      scope: "project",
      categoryIDs: ["memory.dream"],
      source: "test",
    }, dir.path)
    const evaluation = await evaluateDreamSchedule({
      root: dir.path,
      window,
      now: new Date("2026-06-18T00:45:00Z"),
      workspaceID: "ws_pending",
    })
    const second = await runScheduledMemoryDream({
      root: dir.path,
      window,
      now: new Date("2026-06-18T00:45:00Z"),
      workspaceID: "ws_pending",
      permissions: { files: false },
      model: async () => [],
    })

    expect(first).toMatchObject({ status: "completed" })
    expect(proposal.status).toBe("pending")
    expect(evaluation).toMatchObject({ action: "run", reason: "New pending memory work arrived after the last Dream run" })
    expect(second).toMatchObject({ status: "completed" })
    expect(await readDreamRuns(dir.path)).toHaveLength(2)
  })

  test("scheduled Dream uses an atomic lock for concurrent ticks", async () => {
    await using dir = await tmpdir()
    let release!: () => void
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const calls: string[] = []
    const first = runScheduledMemoryDream({
      root: dir.path,
      window: { enabled: true, start: "00:00", end: "23:59" },
      now: new Date("2026-06-18T00:30:00Z"),
      workspaceID: "ws_first",
      model: async () => {
        calls.push("first")
        await hold
        return []
      },
    })

    for (let attempt = 0; attempt < 50 && calls.length === 0; attempt++) await Bun.sleep(2)
    const second = await runScheduledMemoryDream({
      root: dir.path,
      window: { enabled: true, start: "00:00", end: "23:59" },
      now: new Date("2026-06-18T00:30:00Z"),
      workspaceID: "ws_first",
      model: async () => {
        calls.push("second")
        return []
      },
    })

    release()
    const firstResult = await first
    const runs = await readDreamRuns(dir.path)

    expect("id" in firstResult).toBe(true)
    expect(second).toMatchObject({ status: "locked", reason: "Dream already running" })
    expect(calls).toEqual(["first"])
    expect(runs).toHaveLength(1)
  })

  test("global Dream scheduler records online gating instead of running offline", async () => {
    await using dir = await tmpdir()
    await writeGlobalMemoryConfig({
      dreamWindow: { enabled: true, start: "18:00", end: "23:00", timezone: "America/New_York" },
    }, dir.path)

    const result = await runGlobalDreamSchedulerTick({
      now: new Date("2026-06-18T00:30:00Z"),
      networkAvailable: () => false,
    })
    const schedule = await readDreamScheduleState(dir.path)

    expect(result.status).toBe("offline")
    expect(schedule?.reason).toContain("network")
    expect(await readDreamRuns(dir.path)).toHaveLength(0)
  })

  test("Dream schedule state recovers from already-applied Dream proposals", async () => {
    await using dir = await tmpdir()
    const proposal = await proposeMemory({
      text: "Dream proposal: Configure Dream to run in the 18:00-23:00 America/New_York window and only draft proposals.",
      scope: "project",
      tags: ["side-chat", "dream-dry-run", "memory.dream"],
      categoryIDs: ["memory.dream"],
      source: "memory-side-chat",
    }, dir.path)
    await applyMemoryProposal(proposal.id, dir.path)
    await writeGlobalMemoryConfig({ dreamWindow: null }, dir.path)
    await rm(path.join(memoryPaths(dir.path).globalDir, "dream", "schedule.json"), { force: true })

    const recovered = await readDreamScheduleState(dir.path)

    expect(recovered?.status).toBe("scheduled")
    expect(recovered?.reason).toBe("Recovered from applied Dream proposal")
    expect(recovered?.window).toMatchObject({ enabled: true, start: "18:00", end: "23:00", timezone: "America/New_York" })
  })

  test("side chat default responder is honest when no assistant model is configured", async () => {
    await using dir = await tmpdir()
    const chat = await startMemorySideChat({ root: dir.path })
    const role = await resolveMemoryAssistantRole(dir.path)
    const result = await sendMemorySideChatMessage({
      session: chat,
      message: "What memory context do you see?",
    })

    expect(role.ok).toBe(false)
    expect(result.session.history.map((message) => message.role)).toEqual(["user", "assistant"])
    expect(result.session.history.at(-1)?.text).toContain("memory side chat model not configured")
    expect(result.proposals).toHaveLength(0)
  })

  test("side chat reports configured model auth blockers before calling providers", async () => {
    await using dir = await tmpdir()
    const originalApiKey = process.env.OPENAI_API_KEY
    const originalClientID = process.env.MENDCODE_OPENAI_OAUTH_CLIENT_ID
    const originalOpenAIClientID = process.env.OPENAI_OAUTH_CLIENT_ID
    const originalXdgConfigHome = process.env.XDG_CONFIG_HOME
    delete process.env.OPENAI_API_KEY
    delete process.env.MENDCODE_OPENAI_OAUTH_CLIENT_ID
    delete process.env.OPENAI_OAUTH_CLIENT_ID
    process.env.XDG_CONFIG_HOME = path.join(dir.path, "xdg")
    try {
      await writeModelsConfig({
        version: 0,
        enabled: true,
        roles: {
          memoryAssistant: {
            providerID: "openai",
            modelID: "gpt-5.5",
            authMode: "provider-oauth-or-token",
          },
        },
      }, dir.path)
      const chat = await startMemorySideChat({ root: dir.path })
      const result = await sendMemorySideChatMessage({
        session: chat,
        message: "que sabes sobre mi?",
      })

      expect(result.session.history.at(-1)?.text).toContain("Setup model role is configured")
      expect(result.proposals).toHaveLength(0)
    } finally {
      if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = originalApiKey
      if (originalClientID === undefined) delete process.env.MENDCODE_OPENAI_OAUTH_CLIENT_ID
      else process.env.MENDCODE_OPENAI_OAUTH_CLIENT_ID = originalClientID
      if (originalOpenAIClientID === undefined) delete process.env.OPENAI_OAUTH_CLIENT_ID
      else process.env.OPENAI_OAUTH_CLIENT_ID = originalOpenAIClientID
      if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = originalXdgConfigHome
    }
  })

  test("side chat responder failures return to idle with an assistant error", async () => {
    await using dir = await tmpdir()
    const chat = await startMemorySideChat({ root: dir.path })
    const result = await sendMemorySideChatMessage({
      session: chat,
      message: "activate Dream tonight",
      responder: async () => {
        throw new Error("provider unavailable")
      },
    })
    const persisted = await listMemorySideChats(dir.path)

    expect(result.canceled).toBe(false)
    expect(result.session.status).toBe("idle")
    expect(result.session.history.map((message) => message.role)).toEqual(["user", "assistant"])
    expect(result.session.history.at(-1)?.text).toContain("provider unavailable")
    expect(result.proposals).toHaveLength(0)
    expect(persisted[0]?.status).toBe("idle")
  })

  test("side chat resolves setup model for the server provider runtime", async () => {
    await using dir = await tmpdir()
    const originalApiKey = process.env.OPENAI_API_KEY
    const originalClientID = process.env.MENDCODE_OPENAI_OAUTH_CLIENT_ID
    const originalOpenAIClientID = process.env.OPENAI_OAUTH_CLIENT_ID
    delete process.env.OPENAI_API_KEY
    delete process.env.MENDCODE_OPENAI_OAUTH_CLIENT_ID
    delete process.env.OPENAI_OAUTH_CLIENT_ID
    try {
      await writeModelsConfig({
        version: 0,
        enabled: true,
        roles: {
          memoryAssistant: {
            providerID: "openai",
            modelID: "gpt-5.5",
            authMode: "provider-oauth-or-token",
          },
        },
      }, dir.path)

      const role = await resolveMemoryAssistantRuntimeRole(dir.path)

      expect(role).toMatchObject({
        ok: true,
        providerID: "openai",
        modelID: "gpt-5.5",
        runner: "runtime-provider",
      })
    } finally {
      if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = originalApiKey
      if (originalClientID === undefined) delete process.env.MENDCODE_OPENAI_OAUTH_CLIENT_ID
      else process.env.MENDCODE_OPENAI_OAUTH_CLIENT_ID = originalClientID
      if (originalOpenAIClientID === undefined) delete process.env.OPENAI_OAUTH_CLIENT_ID
      else process.env.OPENAI_OAUTH_CLIENT_ID = originalOpenAIClientID
    }
  })

  test("side chat parses model JSON into reviewable proposal actions", () => {
    const parsed = parseMemorySideChatResponse(JSON.stringify({
      reply: "I can draft that as a proposal.",
      actions: [{
        kind: "propose-memory",
        text: "Memory side chat should create reviewable proposals, not direct writes.",
        scope: "global",
        categoryIDs: ["memory.policy"],
      }, {
        kind: "move-memory",
        text: "Move the KeePassXC memory into Security for review.",
        scope: "project",
        targetID: "mem_keepassxc",
        categoryID: "project.security",
        categoryIDs: ["memory.policy"],
      }, {
        kind: "dream-dry-run",
        text: "Run Dream tonight as a dry-run and keep output pending.",
        scope: "project",
        categoryIDs: ["memory.dream"],
      }, {
        kind: "dream-service-start",
        text: "Enable the durable Dream service.",
        scope: "global",
        categoryIDs: ["memory.dream"],
      }],
    }))

    expect(parsed.text).toBe("I can draft that as a proposal.")
    expect(parsed.actions).toEqual([{
      kind: "propose-memory",
      text: "Memory side chat should create reviewable proposals, not direct writes.",
      scope: "global",
      categoryIDs: ["memory.policy"],
    }, {
      kind: "move-memory",
      text: "Move the KeePassXC memory into Security for review.",
      scope: "project",
      targetID: "mem_keepassxc",
      categoryID: "project.security",
      categoryIDs: ["memory.policy"],
    }, {
      kind: "dream-dry-run",
      text: "Run Dream tonight as a dry-run and keep output pending.",
      scope: "project",
      categoryIDs: ["memory.dream"],
    }, {
      kind: "dream-service-start",
      text: "Enable the durable Dream service.",
      scope: "global",
      categoryIDs: ["memory.dream"],
    }])
  })

  test("side chat HTTP response schema accepts reviewable memory control actions", () => {
    const decoded = Schema.decodeUnknownSync(MemorySideChatResponse)({
      text: "I'll draft that move for review.",
      actions: [{
        kind: "move-memory",
        text: "Move the KeePassXC memory into Security.",
        scope: "project",
        targetID: "mem_keepassxc",
        targetScope: "project",
        categoryID: "project.security",
        categoryIDs: ["memory.policy"],
      }, {
        kind: "dream-service-start",
        text: "Enable durable Dream service.",
        scope: "global",
        categoryIDs: ["memory.dream"],
      }],
    })

    expect(decoded.actions[0]?.kind).toBe("move-memory")
    expect(decoded.actions[0]?.targetID).toBe("mem_keepassxc")
    expect(decoded.actions[0]?.categoryID).toBe("project.security")
    expect(decoded.actions[1]?.kind).toBe("dream-service-start")
  })

  test("side chat HTTP response schema stays aligned with non-Dream action kinds", () => {
    const decoded = Schema.decodeUnknownSync(MemorySideChatResponse)({
      text: "Drafted reviewable actions.",
      actions: [{
        kind: "create-memory",
        text: "Create a durable project memory for the release workflow.",
        scope: "project",
        categoryIDs: ["project.release"],
      }, {
        kind: "edit-memory",
        text: "Refine the existing memory text.",
        scope: "project",
        targetID: "mem_existing",
        targetScope: "project",
        categoryIDs: ["memory.policy"],
      }, {
        kind: "delete-memory",
        text: "Remove the stale memory after review.",
        scope: "project",
        targetID: "mem_stale",
        targetScope: "project",
        categoryIDs: ["memory.policy"],
      }, {
        kind: "create-category",
        text: "Create a category for release procedures.",
        scope: "project",
        categoryID: "project.release",
        categoryIDs: ["memory.policy"],
      }, {
        kind: "edit-category",
        text: "Tighten the write policy for this category.",
        scope: "project",
        categoryID: "project.release",
        categoryIDs: ["memory.policy"],
      }, {
        kind: "delete-category",
        text: "Remove the temporary category after migration.",
        scope: "project",
        categoryID: "project.temporary",
        categoryIDs: ["memory.policy"],
      }, {
        kind: "explain-state",
        text: "Explain the current saved-memory state.",
      }],
    })

    expect(decoded.actions.map((action) => action.kind)).toEqual([
      "create-memory",
      "edit-memory",
      "delete-memory",
      "create-category",
      "edit-category",
      "delete-category",
      "explain-state",
    ])
  })

  test("side chat turns provider bad request into a usable assistant message", () => {
    expect(memoryAssistantFailureReason("Bad Request")).toBe("memory side chat provider rejected the configured model request")
  })

  test("side chat cancellation does not corrupt history", async () => {
    await using dir = await tmpdir()
    const chat = await startMemorySideChat({ root: dir.path })
    const controller = new AbortController()
    controller.abort()
    const result = await sendMemorySideChatMessage({
      session: chat,
      message: "hello",
      signal: controller.signal,
    })

    expect(result.canceled).toBe(true)
    expect(result.session.status).toBe("canceled")
    expect(result.session.history).toHaveLength(0)
  })

  test("retrieval includes category labels and overview exposes real persisted state", async () => {
    await using dir = await tmpdir()
    await writeProjectMemoryConfig({ enabled: true, use: true, generate: false }, dir.path)
    await appendMemoryEntry({
      scope: "project",
      text: "MendCode release validation uses focused Bun tests.",
      tags: ["release", "commands"],
      categoryIDs: ["project.release", "project.commands"],
      cwd: dir.path,
    }, dir.path)
    await proposeMemory({
      text: "Generated memories remain pending by default.",
      tags: ["memory"],
    }, dir.path)
    const retrieved = await retrieveMemory({ root: dir.path, query: "release validation", cwd: dir.path, mode: "request" })
    const overview = await memoryOverview(dir.path)

    expect(retrieved.lines?.join("\n")).toContain("[project][Release, Commands]")
    expect(overview.projectEntries).toHaveLength(1)
    expect(overview.proposals.filter((proposal) => proposal.status === "pending")).toHaveLength(1)
    expect(overview.categories.some((category) => category.id === "project.release" && category.count > 0)).toBe(true)
  })

  test("imports Codex memory through extractor only when applied", async () => {
    await using dir = await tmpdir()
    const codex = path.join(dir.path, "codex-memories")
    await mkdir(codex, { recursive: true })
    await writeFile(path.join(codex, "memory_summary.md"), "User prefers local-only MendCode work.\nNever print tokens.\n")
    await writeProjectMemoryConfig({ extractorRole: "none" }, dir.path)

    const preview = await importCodexMemories({ codexMemoryDir: codex, maxProposals: 5 }, dir.path)
    const applied = await importCodexMemories({ codexMemoryDir: codex, maxProposals: 5, apply: true }, dir.path)
    const pending = await listMemoryProposals(dir.path, "pending")

    expect(preview.candidates.length).toBeGreaterThan(0)
    expect(preview.proposals.length).toBe(0)
    expect(applied.skipped).toBe(true)
    expect(applied.reason).toContain("disabled")
    expect(applied.proposals.length).toBe(0)
    expect(pending.length).toBe(0)
  })

  test("normalizes Dream consolidation policy while preserving the Dream proposal policy", async () => {
    await using dir = await tmpdir()

    await writeProjectMemoryConfig({ dreamConsolidationPolicy: "auto-consolidate" }, dir.path)
    const config = await readMemoryConfig(dir.path)

    expect(config.dreamConsolidationPolicy).toBe("auto-consolidate")
    expect(config.dreamWritePolicy).toBe("pending")
  })

  test("persists bounded redacted session digests for Dream context", async () => {
    await using dir = await tmpdir()

    const digest = await writeMemorySessionDigestFromSession({
      id: "session_digest_test",
      title: "Memory consolidation session",
      directory: dir.path,
      messages: [
        { role: "user", content: "Decision: always keep Dream memory changes conservative. OPENAI_API_KEY=DIGEST_SECRET" },
        { role: "assistant", content: "Validated with bun test and kept the project files unchanged." },
      ],
    }, dir.path)
    const digests = await listMemorySessionDigests(dir.path)

    expect(digest.projectRoot).toBe(dir.path)
    expect(digest.summary).toContain("[REDACTED:")
    expect(digest.summary).not.toContain("DIGEST_SECRET")
    expect(digest.decisions.join("\n")).toContain("always keep Dream")
    expect(digest.validations.join("\n")).toContain("bun test")
    expect(digests.map((item) => item.id)).toContain(digest.id)
  })

  test("Dream auto-consolidation resolves proposals and consumes session digests", async () => {
    await using dir = await tmpdir()
    await writeProjectMemoryConfig({
      dreamConsolidationPolicy: "auto-consolidate",
      dreamAutoApplyAllowedCategories: ["memory.policy"],
      dreamAutoApplyMinConfidence: 0.9,
      dreamAutoApplyMinDurability: 0.85,
      dreamAutoApplyMaxChangeRisk: 0.2,
    }, dir.path)
    const digest = await writeMemorySessionDigestFromSession({
      id: "session_consolidation",
      directory: dir.path,
      messages: [{ role: "user", content: "Decision: keep Dream consolidation conservative." }],
    }, dir.path)
    const accepted = await proposeMemory({
      scope: "project",
      text: "Dream consolidation should preserve durable memory policy decisions.",
      categoryIDs: ["memory.policy"],
      confidence: 0.98,
      durability: 0.96,
      changeRisk: 0.05,
      source: "test",
    }, dir.path)
    const uncertain = await proposeMemory({
      scope: "project",
      text: "This uncertain Dream note should not become canonical memory.",
      categoryIDs: ["memory.policy"],
      confidence: 0.2,
      durability: 0.2,
      changeRisk: 0.9,
      source: "test",
    }, dir.path)
    const firstGraphFact = await upsertMemoryFact({
      text: "Dream pipeline graph validation keeps durable memory decisions connected.",
      categoryIDs: ["memory.policy"],
      confidence: 0.96,
      durability: 0.95,
      changeRisk: 0.05,
    }, dir.path)
    const secondGraphFact = await upsertMemoryFact({
      text: "Dream pipeline graph decisions connect validated durable memories.",
      categoryIDs: ["memory.policy"],
      confidence: 0.96,
      durability: 0.95,
      changeRisk: 0.05,
    }, dir.path)

    const run = await runMemoryDream({
      root: dir.path,
      consolidator: async ({ proposals, digests }) => {
        expect(digests.some((item) => item.id === digest.id)).toBe(true)
        return proposals.map((proposal) => proposal.id === accepted.id
          ? { proposalID: proposal.id, resolution: "apply" as const, reason: "Durable policy confirmed.", evidenceRefs: [digest.id] }
          : { proposalID: proposal.id, resolution: "archive" as const, reason: "Uncertain and too risky to retain as canonical memory.", evidenceRefs: [digest.id] })
      },
    })
    const consolidation = await readDreamConsolidationRun(dir.path, run.id)
    const detail = await readDreamRunDetail(dir.path, run.id)
    const pending = await listMemoryProposals(dir.path, "pending")
    const allProposals = await listMemoryProposals(dir.path, "all")
    const entries = await readMemoryEntries("project", dir.path)
    const consumedDigests = await listMemorySessionDigests(dir.path, { includeConsumed: true })

    expect(run.status).toBe("completed")
    expect(consolidation?.status).toBe("completed")
    expect(consolidation?.pendingBefore).toBe(2)
    expect(consolidation?.pendingAfter).toBe(0)
    expect(consolidation?.applied).toBe(1)
    expect(consolidation?.archived).toBe(1)
    expect(pending).toHaveLength(0)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.text).toContain("durable memory policy")
    expect(allProposals.find((proposal) => proposal.id === accepted.id)?.resolution).toBe("applied")
    expect(allProposals.find((proposal) => proposal.id === uncertain.id)?.resolution).toBe("archived")
    expect(detail?.consolidation?.pendingAfter).toBe(0)
    const graphPair = detail?.graphProposals.find((proposal) =>
      proposal.status === "applied"
      && ((proposal.from === firstGraphFact.id && proposal.to === secondGraphFact.id)
        || (proposal.from === secondGraphFact.id && proposal.to === firstGraphFact.id)))
    expect(graphPair?.status).toBe("applied")
    expect(consumedDigests.find((item) => item.id === digest.id)?.consumedBy).toContain(run.id)
  })

  test("Dream consolidation applies targeted update and remove proposals", async () => {
    await using dir = await tmpdir()
    await writeProjectMemoryConfig({
      dreamConsolidationPolicy: "auto-consolidate",
      dreamAutoApplyAllowedCategories: ["memory.policy"],
    }, dir.path)
    const entry = await appendMemoryEntry({
      scope: "project",
      text: "The old Dream memory behavior is obsolete.",
      categoryIDs: ["memory.policy"],
      tags: ["memory"],
    }, dir.path)
    const update = await proposeMemory({
      operation: "update",
      scope: "project",
      targetEntryID: entry.id,
      targetEntryScope: "project",
      text: "Dream memory behavior is consolidated by a bounded, auditable host pipeline.",
      categoryIDs: ["memory.policy"],
      confidence: 0.98,
      durability: 0.95,
      changeRisk: 0.05,
      source: "test",
    }, dir.path)
    const remove = await proposeMemory({
      operation: "remove",
      scope: "project",
      targetEntryID: entry.id,
      targetEntryScope: "project",
      text: "Remove the obsolete Dream memory after the replacement is applied.",
      categoryIDs: ["memory.policy"],
      confidence: 0.98,
      durability: 0.95,
      changeRisk: 0.05,
      source: "test",
    }, dir.path)

    const run = await runMemoryDream({
      root: dir.path,
      consolidator: async ({ proposals }) => proposals.map((proposal) => ({ proposalID: proposal.id, resolution: "apply" as const, reason: `Apply ${proposal.operation} from Dream consolidation.` })),
    })

    expect(run.status).toBe("completed")
    expect(await listMemoryProposals(dir.path, "pending")).toHaveLength(0)
    expect(await readMemoryEntries("project", dir.path)).toHaveLength(0)
    expect((await listMemoryProposals(dir.path, "all")).find((proposal) => proposal.id === update.id)?.resolution).toBe("applied")
    expect((await listMemoryProposals(dir.path, "all")).find((proposal) => proposal.id === remove.id)?.resolution).toBe("applied")
  })

  test("Dream consolidation processes every pending proposal in bounded batches", async () => {
    await using dir = await tmpdir()
    await writeProjectMemoryConfig({
      dreamConsolidationPolicy: "auto-consolidate",
      dreamAutoApplyAllowedCategories: ["memory.policy"],
    }, dir.path)
    for (let index = 0; index < 25; index++) {
      await proposeMemory({
        scope: "project",
        text: `Durable Dream consolidation policy ${index} should remain auditable.`,
        categoryIDs: ["memory.policy"],
        confidence: 0.98,
        durability: 0.95,
        changeRisk: 0.05,
        source: "test",
      }, dir.path)
    }
    const batches: number[] = []
    const run = await runMemoryDream({
      root: dir.path,
      consolidator: async ({ proposals }) => {
        batches.push(proposals.length)
        return proposals.map((proposal) => ({ proposalID: proposal.id, resolution: "archive" as const, reason: "Fixture proposal is intentionally archived." }))
      },
    })
    const consolidation = await readDreamConsolidationRun(dir.path, run.id)

    expect(run.status).toBe("completed")
    expect(batches).toEqual([24, 1])
    expect(consolidation?.pendingBefore).toBe(25)
    expect(consolidation?.pendingAfter).toBe(0)
    expect(consolidation?.resolved).toBe(25)
    expect(await listMemoryProposals(dir.path, "pending")).toHaveLength(0)
  })

  test("Dream consolidation fails closed when the model omits a pending proposal", async () => {
    await using dir = await tmpdir()
    await writeProjectMemoryConfig({
      dreamConsolidationPolicy: "auto-consolidate",
      dreamAutoApplyAllowedCategories: ["memory.policy"],
    }, dir.path)
    const proposal = await proposeMemory({
      scope: "project",
      text: "A pending proposal must remain visible when consolidation cannot resolve it.",
      categoryIDs: ["memory.policy"],
      source: "test",
    }, dir.path)

    const run = await runMemoryDream({
      root: dir.path,
      consolidator: async () => [],
    })
    const consolidation = await readDreamConsolidationRun(dir.path, run.id)

    expect(run.status).toBe("failed")
    expect(consolidation?.status).toBe("failed")
    expect(consolidation?.failureReason).toContain("did not resolve")
    expect((await listMemoryProposals(dir.path, "pending")).map((item) => item.id)).toEqual([proposal.id])
  })

  test("parses strict Dream consolidation JSON and ignores prose outside decisions", () => {
    const decisions = parseDreamConsolidationOutput(`Here is the result:\n${JSON.stringify({ decisions: [{ proposalID: "proposal_1", resolution: "archive", reason: "Transient note." }] })}`)

    expect(decisions).toEqual([expect.objectContaining({ proposalID: "proposal_1", resolution: "archive", reason: "Transient note." })])
  })
})
