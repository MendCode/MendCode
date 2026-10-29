import { afterEach, describe, expect, test } from "bun:test"
import { ContextReport, type ModelInfo, type SessionTranscriptItem, type SessionTranscriptTurn } from "@mendcode/protocol"
import { harnessContextReport } from "../src/harness-context"
import { boot, openSession, say, stop, type NativeHarness } from "./native-harness"

let n = 0
const item = (kind: SessionTranscriptItem["kind"], text: string, extra: Partial<SessionTranscriptItem> = {}): SessionTranscriptItem => ({ itemId: `itm_${n++}`, kind, text, ...extra })
const turn = (...items: SessionTranscriptItem[]): SessionTranscriptTurn => ({ turnId: `trn_${n++}`, items, outcome: "completed" }) as SessionTranscriptTurn
const usage = (context: number) => ({ type: "usage.recorded", provider: "claude", model: "claude-opus", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, context }) as never

describe("/context for a session Claude Code or Codex runs", () => {
  test("the history is MendCode's transcript by role; the rest of the measured context is the harness's own prompt and tools", () => {
    const report = harnessContextReport({
      harness: "Claude Code", model: "claude-opus", contextWindow: 200_000, compactAtTokens: 200_000, lastUsage: usage(30_000),
      turns: [turn(item("user_message", "u".repeat(4_000)), item("tool_call", "o".repeat(8_000), { tool: "Bash", input: "{}" }), item("agent_message", "a".repeat(2_000)))],
    })
    expect(ContextReport.parse(report)).toBeTruthy()
    expect(report.sections.map((entry) => [entry.id, entry.tokens])).toEqual([["system:harness", 26_498], ["history:user", 1_000], ["history:assistant", 500], ["history:tool", 2_002]])
    expect(report.sections[0]!.label).toBe("system · Claude Code's own prompt and tools")
    expect(report).toMatchObject({ measuredTokens: 30_000, estimatedTokens: 30_000, contextWindow: 200_000 })
    expect(report.largest[0]!.role).toBe("tool")
    expect(report.largest[0]!.preview.startsWith("Bash {}")).toBe(true)
  })

  test("a harness that compacted holds less than the transcript: no negative remainder; without a measured call there is none", () => {
    const turns = [turn(item("user_message", "u".repeat(40_000)))]
    expect(harnessContextReport({ harness: "Codex", model: "gpt", turns, lastUsage: usage(2_000), compactAtTokens: 100 }).sections.map((entry) => entry.id)).not.toContain("system:harness")
    expect(harnessContextReport({ harness: "Codex", model: "gpt", turns, compactAtTokens: 100 }).measuredTokens).toBeUndefined()
  })
})

describe("context.query through the daemon", () => {
  let h: NativeHarness | undefined
  afterEach(async () => { await h?.cleanup(); h = undefined })

  test("a session on a Claude Code model gets a report instead of an error", async () => {
    const claude: ModelInfo = { id: "claude-test", name: "Claude test · Claude Code", efforts: [], contextWindow: 200_000, engine: "claude" }
    h = await boot({ steps: [stop("done")], extraModels: [claude] })
    const id = await openSession(h)
    await say(h, id, "what is in the context?")
    expect(await h.client.send({ type: "session.model.set", sessionId: id, choice: { model: "claude-test" } })).toMatchObject({ ok: true })
    const reply = await h.client.send({ type: "context.query", sessionId: id })
    if (!reply.ok) throw new Error(reply.error.message)
    const report = ContextReport.parse(reply.result)
    expect(report).toMatchObject({ model: "claude-test", contextWindow: 200_000 })
    expect(report.sections.find((entry) => entry.id === "history:user")).toMatchObject({ count: 1 })
    expect(report.sections.find((entry) => entry.id === "history:assistant")).toMatchObject({ count: 1 })
  }, 15_000)
})
