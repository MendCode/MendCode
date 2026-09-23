import { describe, expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"
import { defaultEvolutionConfig, evolutionPaths, readEvolutionPolicy, writeEvolutionConsent, writeEvolutionJSON } from "../../src/mend/evolution/config"
import { authorizeEvolutionAction } from "../../src/mend/evolution/policy"
import { listEvolutionEvidence, recordEvolutionEvidence, recordEvolutionToolEvidence } from "../../src/mend/evolution/evidence"

describe("Evolution consent and evidence", () => {
  test("missing consent preserves legacy; repository cannot opt in", async () => {
    await using tmp = await tmpdir()
    const data = path.join(tmp.path, "data")
    expect((await readEvolutionPolicy(tmp.path, data)).adopted).toBe(false)
    await writeEvolutionJSON(evolutionPaths(tmp.path, data).restriction, { mode: "auto-safe", remoteProcessing: true })
    const policy = await readEvolutionPolicy(tmp.path, data)
    expect(policy.origin).toBe("legacy")
    expect(authorizeEvolutionAction(policy, "provider").allowed).toBe(false)
    expect(authorizeEvolutionAction(policy, "legacy-learning").allowed).toBe(true)
  })

  test("all modes have separate provider, proposal and promotion permissions", async () => {
    await using tmp = await tmpdir()
    const data = path.join(tmp.path, "data")
    for (const mode of ["off", "observe", "suggest", "auto-safe"] as const) {
      const policy = await writeEvolutionConsent(tmp.path, { ...defaultEvolutionConfig, mode, remoteProcessing: true }, data)
      expect(authorizeEvolutionAction(policy, "capture").allowed).toBe(mode !== "off")
      expect(authorizeEvolutionAction(policy, "provider").allowed).toBe(mode === "suggest" || mode === "auto-safe")
      expect(authorizeEvolutionAction(policy, "propose").allowed).toBe(mode === "suggest" || mode === "auto-safe")
      expect(authorizeEvolutionAction(policy, "auto-apply").allowed).toBe(mode === "auto-safe")
      expect(authorizeEvolutionAction(policy, "legacy-learning").allowed).toBe(false)
    }
  })

  test("repository restrictions cannot elevate consent and malformed files fail closed", async () => {
    await using tmp = await tmpdir()
    const data = path.join(tmp.path, "data")
    await writeEvolutionConsent(tmp.path, { ...defaultEvolutionConfig, mode: "suggest" }, data)
    await writeEvolutionJSON(evolutionPaths(tmp.path, data).restriction, { mode: "auto-safe", remoteProcessing: true, outputs: { skills: true } })
    const policy = await readEvolutionPolicy(tmp.path, data)
    expect(policy.config.mode).toBe("suggest")
    expect(policy.config.remoteProcessing).toBe(false)
    expect(policy.config.outputs.skills).toBe(false)
    await writeEvolutionJSON(evolutionPaths(tmp.path, data).restriction, { mode: "off" })
    expect((await readEvolutionPolicy(tmp.path, data)).config.mode).toBe("off")
    await writeEvolutionJSON(evolutionPaths(tmp.path, data).consent, { mode: "suggest" })
    expect((await readEvolutionPolicy(tmp.path, data)).origin).toBe("invalid")
  })

  test("project consent cannot lift global restrictions or revive previous revisions", async () => {
    await using tmp = await tmpdir()
    const data = path.join(tmp.path, "data")
    const globalFile = evolutionPaths(tmp.path, data).globalConfig
    const globalConfig = { ...defaultEvolutionConfig, mode: "observe" as const }
    await writeEvolutionJSON(globalFile, { revision: crypto.randomUUID(), config: globalConfig })
    const policy = await writeEvolutionConsent(tmp.path, {
      ...defaultEvolutionConfig, mode: "auto-safe", remoteProcessing: true,
      outputs: { memory: true, skills: true, workflows: true },
      sources: { corrections: true, toolResults: true, testResults: true },
      execution: "daily", dailyAt: "10:00", timezone: "UTC",
    }, data)
    expect(policy.config.mode).toBe("observe")
    expect(policy.config.remoteProcessing).toBe(false)
    expect(policy.config.outputs).toEqual(globalConfig.outputs)
    expect(policy.config.sources).toEqual(globalConfig.sources)
    expect(policy.config.execution).toBe("manual")
    await writeEvolutionJSON(globalFile, { revision: crypto.randomUUID(), config: globalConfig })
    const changed = await readEvolutionPolicy(tmp.path, data)
    expect(changed.revision).not.toBe(policy.revision)
    expect(authorizeEvolutionAction(changed, "capture", policy.revision).allowed).toBe(false)
  })

  test("off/on changes revision, so old work cannot resume", async () => {
    await using tmp = await tmpdir()
    const data = path.join(tmp.path, "data")
    const config = { ...defaultEvolutionConfig, mode: "suggest" as const, remoteProcessing: true }
    const before = await writeEvolutionConsent(tmp.path, config, data)
    await writeEvolutionConsent(tmp.path, defaultEvolutionConfig, data)
    const after = await writeEvolutionConsent(tmp.path, config, data)
    expect(authorizeEvolutionAction(after, "propose", before.revision).allowed).toBe(false)
  })

  test("Observe retains metadata only; deduplicates and isolates projects", async () => {
    await using tmp = await tmpdir()
    const data = path.join(tmp.path, "data")
    await writeEvolutionConsent(tmp.path, { ...defaultEvolutionConfig, mode: "observe" }, data)
    const input = { source: "correction" as const, sessionID: "ses_1", turnID: "msg_1", outcome: "observed" as const, text: "password=never-store-this" }
    await recordEvolutionEvidence(tmp.path, input, data)
    await recordEvolutionEvidence(tmp.path, input, data)
    const entries = await listEvolutionEvidence(tmp.path, data)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.text).toBeNull()
    expect(JSON.stringify(entries)).not.toContain("never-store-this")
    expect(await listEvolutionEvidence(path.join(tmp.path, "other"), data)).toEqual([])
  })

  test("host tool evidence records process status without arguments or stdout", async () => {
    await using tmp = await tmpdir()
    const data = path.join(tmp.path, "data")
    await writeEvolutionConsent(tmp.path, { ...defaultEvolutionConfig, mode: "suggest", sources: { corrections: false, toolResults: true, testResults: true } }, data)
    const base = { sessionID: "ses_test", tool: "bash" }
    await recordEvolutionToolEvidence(tmp.path, { ...base, turnID: "one", command: "bun test test/unit.ts", exitCode: 0 }, data)
    await recordEvolutionToolEvidence(tmp.path, { ...base, turnID: "two", command: "bun test test/unit.ts", exitCode: 1 }, data)
    await recordEvolutionToolEvidence(tmp.path, { ...base, turnID: "three", command: "bun test; echo private-data" }, data)
    const entries = await listEvolutionEvidence(tmp.path, data)
    expect(entries.map((item) => [item.source, item.outcome])).toEqual([["test-result", "passed"], ["test-result", "failed"], ["tool-result", "observed"]])
    expect(JSON.stringify(entries)).not.toContain("private-data")
    await writeEvolutionConsent(tmp.path, { ...defaultEvolutionConfig, mode: "observe", sources: { corrections: false, toolResults: true, testResults: true } }, data)
    await recordEvolutionToolEvidence(tmp.path, { ...base, turnID: "four", command: "bun test", exitCode: 0 }, data)
    expect((await listEvolutionEvidence(tmp.path, data)).at(-1)!.text).toBeNull()
  })

  test("Suggest rejects sensitive and oversized evidence without persisting it", async () => {
    await using tmp = await tmpdir()
    const data = path.join(tmp.path, "data")
    await writeEvolutionConsent(tmp.path, { ...defaultEvolutionConfig, mode: "suggest" }, data)
    const input = { source: "correction" as const, sessionID: "ses_1", turnID: "msg_1", outcome: "observed" as const }
    await expect(recordEvolutionEvidence(tmp.path, { ...input, text: "password=do-not-store" }, data)).rejects.toThrow("sensitive")
    await expect(recordEvolutionEvidence(tmp.path, { ...input, text: "é".repeat(4096) }, data)).rejects.toThrow("4 KiB")
    expect(await listEvolutionEvidence(tmp.path, data)).toEqual([])
  })
})
