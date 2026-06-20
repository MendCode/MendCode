import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { existsSync, mkdtempSync } from "fs"
import { mkdir, writeFile } from "fs/promises"
import { tmpdir as osTmpdir } from "os"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { appendMemoryEntry, deleteMemoryEntry, memoryStatus, readMemoryEntries, updateMemoryEntry } from "../../src/mend/memory/store"
import { retrieveMemory } from "../../src/mend/memory/retrieve"
import { readMemoryConfig, writeGlobalMemoryConfig, writeProjectMemoryConfig } from "../../src/mend/memory/config"
import { applyMemoryProposal, autoProposeMemoriesFromSession, extractorPrompt, importCodexMemories, listMemoryProposals, memoryExtractorCandidateMessage, memoryExtractorFailureReason, proposeMemoriesFromExtractorText, proposeMemoriesWithExtractor, proposeMemory, readMemoryExtractorContext, rejectMemoryProposal, updateMemoryProposal } from "../../src/mend/memory/proposals"
import { DEFAULT_MEMORY_CATEGORIES, inferMemoryCategoryIDs, normalizeMemoryCategoryPolicies, readMemoryCategoryPolicies, scopeReasonForMemory, writeMemoryCategoryPolicy } from "../../src/mend/memory/categories"
import { readMemoryFacts, repairMemoryGraph, upsertMemoryFact, validateMemoryGraph } from "../../src/mend/memory/graph"
import { registerMemoryWorkspace, memoryWorkspaceOverview, writeWorkspaceRegistry } from "../../src/mend/memory/workspaces"
import { allowedDreamGitCommands, collectDreamFileEvidence, isDreamFileAllowed } from "../../src/mend/memory/dream-sources"
import { latestDreamStatus, runMemoryDream } from "../../src/mend/memory/dream"
import { evaluateDreamSchedule, readDreamScheduleState, runScheduledMemoryDream } from "../../src/mend/memory/dream-scheduler"
import { listMemorySideChats, memoryAssistantFailureReason, parseMemorySideChatResponse, resolveMemoryAssistantRole, resolveMemoryAssistantRuntimeRole, sendMemorySideChatMessage, startMemorySideChat } from "../../src/mend/memory/side-chat"
import { memoryOverview } from "../../src/mend/memory/overview"
import { GlobalBus } from "../../src/bus/global"
import { writeModelsConfig } from "../../src/mend/config/models"
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
    expect(status.input).toBe(false)
    expect(status.output).toBe(false)
    expect(status.promptModeIndependent).toBe(true)
    expect(status.callsProviders).toBe(false)
    expect(status.retrievalCallsProviders).toBe(false)
    expect(status.outputCallsProviders).toBe(false)
    expect(status.readsSecrets).toBe(false)
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

    expect(policies["project.commands"]?.writePolicy).toBe("manual-only")
    expect(policies["project.commands"]?.promptEnabled).toBe(false)
    expect(policies["project.commands"]?.promptPriority).toBe(7)
    expect(overview.policies["project.commands"]?.writePolicy).toBe("manual-only")
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
    const facts = await readMemoryFacts(dir.path)
    const validation = await validateMemoryGraph(dir.path)
    const repaired = await repairMemoryGraph(dir.path)

    expect(facts.some((item) => item.legacyEntryID === entry.id)).toBe(true)
    expect(facts.some((item) => item.id === fact.id && item.categoryIDs.includes("memory.policy"))).toBe(true)
    expect(validation.ok).toBe(true)
    expect(repaired.facts).toBeGreaterThan(0)
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

  test("Dream default reads memory and proposals only, writes logs and proposals", async () => {
    await using dir = await tmpdir()
    await appendMemoryEntry({
      scope: "project",
      text: "MendCode memory Dream must keep generated mutations reviewable.",
      tags: ["memory"],
    }, dir.path)
    const run = await runMemoryDream({
      root: dir.path,
      model: async ({ evidence }) => {
        expect(evidence.some((item) => item.sourceType === "memory")).toBe(true)
        expect(evidence.some((item) => item.sourceType === "file")).toBe(false)
        return [{
          text: "Dream should propose memory changes instead of applying them directly.",
          categoryIDs: ["memory.policy"],
        }]
      },
    })
    const status = await latestDreamStatus(dir.path)
    const proposals = await listMemoryProposals(dir.path, "pending")

    expect(run.role).toBe("memoryDream")
    expect(run.status).toBe("completed")
    expect(status?.id).toBe(run.id)
    expect(proposals.some((proposal) => proposal.source === "memory-dream")).toBe(true)
    expect((await readMemoryEntries("project", dir.path)).length).toBe(1)
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
            text: "Configure Dream to run at 21:00 America/Panama and only draft proposals.",
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
      }],
    })

    expect(decoded.actions[0]?.kind).toBe("move-memory")
    expect(decoded.actions[0]?.targetID).toBe("mem_keepassxc")
    expect(decoded.actions[0]?.categoryID).toBe("project.security")
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
})
