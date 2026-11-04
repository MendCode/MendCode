import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { ContextReport, type ModelInfo } from "@mendcode/protocol"
import { harnessContextReport } from "../src/harness-context"
import { claudeCompactEnv } from "../src/claude-models"
import { boot, openSession, say, type NativeHarness } from "./native-harness"

const usageStep = [{ type: "text", delta: "ok" }, { type: "usage", usage: { input: 106, output: 20, reasoning: 0, cacheRead: 331_392, cacheWrite: 0 } }, { type: "finish", reason: "stop" }] as never

describe("/context says one true number", () => {
  const cleanups: Array<() => void> = []
  let h: NativeHarness | undefined
  afterEach(async () => { await h?.cleanup(); h = undefined; for (const cleanup of cleanups.splice(0)) cleanup() })

  test("1a: after a daemon restart /context reports the provider's last count, derived from the stored usage", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mendd-ctx-truth-"))
    const project = mkdtempSync(path.join(tmpdir(), "mendd-ctx-truth-proj-"))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => rmSync(project, { recursive: true, force: true }))
    h = await boot({ dir, project, steps: [usageStep] })
    const id = await openSession(h)
    await say(h, id, "hello")
    await h.cleanup()
    h = await boot({ dir, project })
    const reply = await h.client.send({ type: "context.query", sessionId: id })
    if (!reply.ok) throw new Error(reply.error.message)
    expect(ContextReport.parse(reply.result).measuredTokens).toBe(106 + 331_392 + 20)
  }, 20_000)

  test("1b: every image in the history counts in the estimate, in the harness report too", () => {
    const turns = [{ turnId: "trn_1", outcome: "completed", items: [{ itemId: "itm_1", kind: "user_message", text: "look", attachments: Array.from({ length: 60 }, (_, i) => ({ id: `a${i}` })) }] }] as never
    const report = harnessContextReport({ harness: "Codex", model: "gpt", turns, compactAtTokens: 475_000 })
    expect(report.images).toBe(60)
    expect(report.estimatedTokens).toBeGreaterThanOrEqual(60 * 1_500)
  })

  test("2: Claude Code's compaction point is the window it is handed, before and after the first message", () => {
    const settings = { compactAtTokens: 475_000 }
    expect(claudeCompactEnv({ model: "claude-sonnet", settings, on: true, environment: {} })).toEqual({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: "475000" })
    const claude: ModelInfo = { id: "claude-test", name: "Claude test", efforts: [], contextWindow: 200_000, engine: "claude" }
    expect(claude.contextWindow).toBe(200_000)
    const unmeasured = harnessContextReport({ harness: "Claude Code", model: "claude-sonnet", turns: [], contextWindow: 1_000_000, compactAtTokens: 475_000 })
    expect(unmeasured).toMatchObject({ compactAtTokens: 475_000, contextWindow: 1_000_000, harness: "Claude Code" })
    expect(unmeasured.measuredTokens).toBeUndefined()
    expect(unmeasured.categories?.some((entry) => entry.id === "harness")).toBe(false)
  })
})
