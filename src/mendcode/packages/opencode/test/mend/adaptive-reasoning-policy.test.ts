import { describe, expect, test } from "bun:test"
import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import type { ModelMessage } from "ai"
import { tmpdir } from "../fixture/fixture"
import { adaptivePaths, defaultAdaptivePolicy, readAdaptivePolicy, writeAdaptiveConsent } from "../../src/mend/adaptive-reasoning/policy"
import { projectEvaluatorContext, redactEvaluatorText } from "../../src/mend/adaptive-reasoning/context"

const shadow = { ...defaultAdaptivePolicy, mode: "shadow" as const, remoteProcessing: true }

describe("adaptive consent", () => {
  test("off by default; host consent is private and CAS protected", async () => {
    await using tmp = await tmpdir()
    const data = path.join(tmp.path, "private")
    const initial = await readAdaptivePolicy(tmp.path, data)
    expect(initial.config).toEqual(defaultAdaptivePolicy)
    const saved = await writeAdaptiveConsent(tmp.path, shadow, initial.revision, data)
    expect(saved.config).toEqual(shadow)
    expect(saved.revision).not.toBe(initial.revision)
    const files = await adaptivePaths(tmp.path, data)
    expect((await stat(files.consent)).mode & 0o777).toBe(0o600)
    expect((await stat(files.directory)).mode & 0o777).toBe(0o700)
    await expect(writeAdaptiveConsent(tmp.path, shadow, initial.revision, data)).rejects.toThrow("changed")
    const off = await writeAdaptiveConsent(tmp.path, { ...shadow, mode: "off" }, saved.revision, data)
    expect(off.config.mode).toBe("off")
  })

  test("repository configuration can restrict but never authorize", async () => {
    await using tmp = await tmpdir()
    const data = path.join(tmp.path, "private")
    const files = await adaptivePaths(tmp.path, data)
    await mkdir(path.dirname(files.restriction), { recursive: true })
    await writeFile(files.restriction, JSON.stringify({ mode: "adaptive", remoteProcessing: true, maxLeaseSteps: 5 }))
    const initial = await readAdaptivePolicy(tmp.path, data)
    expect(initial.config.mode).toBe("off")
    expect(initial.config.remoteProcessing).toBe(false)
    await writeAdaptiveConsent(tmp.path, shadow, initial.revision, data)
    await writeFile(files.restriction, JSON.stringify({ mode: "off", remoteProcessing: false, maxLeaseSteps: 1, maxDecisionsPerTurn: 1 }))
    const narrowed = await readAdaptivePolicy(tmp.path, data)
    expect(narrowed.config).toMatchObject({ mode: "off", remoteProcessing: false, maxLeaseSteps: 1, maxDecisionsPerTurn: 1 })
  })

  test("invalid, oversized, or unknown policy fails closed without overwrite", async () => {
    await using tmp = await tmpdir()
    const data = path.join(tmp.path, "private")
    const files = await adaptivePaths(tmp.path, data)
    await mkdir(files.directory, { recursive: true })
    for (const text of ["{", " ".repeat(65_537), JSON.stringify({ revision: crypto.randomUUID(), config: { ...shadow, version: 2 } })]) {
      await writeFile(files.consent, text)
      const state = await readAdaptivePolicy(tmp.path, data)
      expect(state.valid).toBe(false)
      expect(state.config.mode).toBe("off")
      await expect(writeAdaptiveConsent(tmp.path, shadow, state.revision, data)).rejects.toThrow("changed")
      expect(await readFile(files.consent, "utf8")).toBe(text)
    }
  })

  test("two writers with the same revision cannot both grant consent", async () => {
    await using tmp = await tmpdir()
    const data = path.join(tmp.path, "private")
    const initial = await readAdaptivePolicy(tmp.path, data)
    const results = await Promise.allSettled([
      writeAdaptiveConsent(tmp.path, shadow, initial.revision, data),
      writeAdaptiveConsent(tmp.path, { ...shadow, maxLeaseSteps: 1 }, initial.revision, data),
    ])
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
  })

  test("symlink roots share consent identity and adaptive stays unavailable", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "project")
    const alias = path.join(tmp.path, "alias")
    await mkdir(root)
    await symlink(root, alias)
    expect(await adaptivePaths(root, tmp.path)).toEqual(await adaptivePaths(alias, tmp.path))
    const state = await readAdaptivePolicy(root, tmp.path)
    await expect(writeAdaptiveConsent(root, { ...shadow, mode: "adaptive" }, state.revision, tmp.path)).rejects.toThrow("not verified")
  })
})

describe("bounded public projection", () => {
  test("excludes injected system, previous turns, reasoning, attachments, and tool arguments", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "PRIVATE MEMORY" },
      { role: "user", content: "OLD GOAL" },
      { role: "user", content: [{ type: "text", text: "Fix the public fixture" }, { type: "image", image: "PRIVATE IMAGE" }] },
      { role: "assistant", content: [
        { type: "reasoning", text: "PRIVATE REASONING" },
        { type: "text", text: "Inspecting fixture" },
        { type: "tool-call", toolCallId: "a", toolName: "read", input: { secret: "PRIVATE ARGUMENT" } },
      ] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "a", toolName: "read", output: { type: "text", value: "public fixture output" } }] },
    ]
    expect(projectEvaluatorContext(messages)).toEqual({ goal: "Fix the public fixture", progress: "Inspecting fixture", tools: [{ name: "read", result: "public fixture output" }] })
    expect(JSON.stringify(projectEvaluatorContext(messages))).not.toContain("PRIVATE")
  })

  test("keeps last four paired outputs, bounds UTF8, and omits orphan results", () => {
    const messages: ModelMessage[] = [{ role: "user", content: "Goal" }]
    for (let i = 0; i < 8; i++) {
      messages.push({ role: "assistant", content: [{ type: "tool-call", toolCallId: String(i), toolName: `read${i}`, input: {} }] })
      messages.push({ role: "tool", content: [{ type: "tool-result", toolCallId: String(i), toolName: `read${i}`, output: { type: "text", value: "漢".repeat(2_000) } }] })
    }
    messages.push({ role: "tool", content: [{ type: "tool-result", toolCallId: "orphan", toolName: "read", output: { type: "text", value: "UNPAIRED" } }] })
    const result = projectEvaluatorContext(messages)
    expect(result.tools.map((tool) => tool.name)).toEqual(["read4", "read5", "read6", "read7"])
    expect(result.tools.every((tool) => Buffer.byteLength(tool.result) <= 2_048 && tool.result.includes("truncated"))).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(24_576)
  })

  test("oversized goal is rejected, not truncated; known secrets are redacted", () => {
    expect(() => projectEvaluatorContext([{ role: "user", content: "x".repeat(8_193) }])).toThrow("8192")
    expect(() => projectEvaluatorContext([])).toThrow("goal")
    expect(redactEvaluatorText("Bearer abc123 api_key=hidden sk-or-v1-abcdefghi exact-value", ["exact-value"]))
      .not.toMatch(/abc123|hidden|sk-or-v1|exact-value/)
  })
})
