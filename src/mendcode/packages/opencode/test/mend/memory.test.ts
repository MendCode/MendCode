import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync } from "fs"
import { mkdir, writeFile } from "fs/promises"
import { tmpdir as osTmpdir } from "os"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { appendMemoryEntry, deleteMemoryEntry, memoryStatus, readMemoryEntries, updateMemoryEntry } from "../../src/mend/memory/store"
import { retrieveMemory } from "../../src/mend/memory/retrieve"
import { readMemoryConfig, writeGlobalMemoryConfig, writeProjectMemoryConfig } from "../../src/mend/memory/config"
import { applyMemoryProposal, autoProposeMemoriesFromSession, extractorPrompt, importCodexMemories, listMemoryProposals, memoryExtractorCandidateMessage, memoryExtractorFailureReason, proposeMemoriesFromExtractorText, proposeMemoriesWithExtractor, proposeMemory, readMemoryExtractorContext, rejectMemoryProposal, updateMemoryProposal } from "../../src/mend/memory/proposals"

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

    expect(applied.entry.text).toContain("approval-gated")
    expect(applied.proposal.status).toBe("applied")
    expect(statusAfterApply.entries.project.count).toBe(1)
    expect(statusAfterApply.proposals.applied).toBe(1)
  })

  test("edits pending proposal text and scope before applying", async () => {
    await using dir = await tmpdir()

    const proposal = await proposeMemory({
      scope: "global",
      text: "User prefers concise Spanish responses in MendCode.",
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
    expect(applied.entry.scope).toBe("project")
    expect(applied.entry.text).toContain("approval-gated")
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
    expect(prompt).toContain("future workflow rule")
    expect(prompt).toContain("Para este repo")
    expect(prompt).toContain("Review saved_memory and pending_memory")
    expect(prompt).toContain("Assistant text such as 'I will not save this yet' is not a reason to skip")
    expect(prompt).toContain("If the user repeats or lightly rephrases")
  })

  test("extractor sees saved global/project memory and pending proposals before deciding", async () => {
    await using dir = await tmpdir()
    await appendMemoryEntry({
      scope: "global",
      text: "The user prefers concise Spanish responses.",
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
      text: "USER:\nPara este repo, cuando hagas cambios visibles de TUI, valida con smoke test antes de decir listo.\n\nASSISTANT:\nentendido",
      tags: ["tui", "auto"],
      cwd: dir.path,
      source: "tui-session-auto-extract",
      evidence: "session:test:message:test",
    }, context.existing)

    expect(message).toContain("<saved_memory>")
    expect(message).toContain("[saved][global] The user prefers concise Spanish responses.")
    expect(message).toContain("[saved][project] MendCode setup changes should keep terminal row copy compact.")
    expect(message).toContain("<pending_memory>")
    expect(message).toContain("[pending][project] Visible TUI changes should be validated with a smoke test")
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
