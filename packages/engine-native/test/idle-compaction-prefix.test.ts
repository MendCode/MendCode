import { describe, expect, test } from "bun:test"
import type { TurnOutcome } from "@mendcode/kernel"
import { createNativeEngine, memoryHistory } from "../src"
import { ids, scriptedProvider, stop, turn } from "./harness"
import { ADAPTERS, CONVERSATION, comparePrefix, recordLineage } from "./prefix-harness"

/**
 * A compaction while idle is only worth its call when the provider reads the history from its prompt cache, so its request must
 * begin with the whole last main request (tools, system prompt, every message) and only append. Checked on the exact bodies the
 * real adapters send to a local fake host.
 */
const compactInput = (sessionId: ReturnType<typeof ids<"session">>, idle: boolean) => ({ sessionId, turnId: ids("turn"), signal: new AbortController().signal, newItemId: () => ids("item"), emit: () => {}, ...(idle ? { idle: true as const } : {}) })
const SUMMARY = "## Goal\nFix pagination and test the empty page."

describe("compaction while idle repeats the last main request, so the provider reads it from the cache", () => {
  for (const adapter of ADAPTERS) for (const promptCache of ["legacy", "smart"] as const) {
    test(`${adapter} (${promptCache}): tools, system prompt and every earlier message are unchanged; only the prompt is appended`, async () => {
      let outcome: TurnOutcome | undefined
      const calls = await recordLineage({ adapter, turns: CONVERSATION, promptCache, after: { steps: [{ text: SUMMARY, usage: { input: 300, output: 60, cacheRead: 4700 } }], run: async (engine, sessionId) => { outcome = await engine.compact(compactInput(sessionId, true)) } } })
      expect(calls).toHaveLength(6)
      expect(outcome).toMatchObject({ status: "ok", compacted: true })
      const [last, compaction] = [calls[4]!, calls[5]!]
      expect(comparePrefix(adapter, last.body, compaction.body)).toMatchObject({ share: 1, firstDifference: "none" })
      // The same cache route too, where the adapter sends one.
      expect(compaction.body.prompt_cache_key).toBe(last.body.prompt_cache_key)
      expect(JSON.stringify(compaction.body)).toContain("Do not call any tool")
    })
  }

  test("a compaction on a model of its own (the `compaction` role) keeps its own request (no tools): that one does not share the prefix", async () => {
    const calls = await recordLineage({ adapter: "responses", turns: CONVERSATION, engineOptions: { modelFor: (_sessionId, role) => ({ model: role === "compaction" ? "gpt-small" : "gpt-test" }) }, after: { steps: [{ text: SUMMARY }], run: async (engine, sessionId) => void await engine.compact(compactInput(sessionId, false)) } })
    expect(calls[5]!.body.model).toBe("gpt-small")
    expect(comparePrefix("responses", calls[4]!.body, calls[5]!.body)).toMatchObject({ firstDifference: "tools" })
  })

  test("a reply that calls a tool instead of summarising installs nothing", async () => {
    let outcome: TurnOutcome | undefined
    const history = memoryHistory()
    let sessionId!: ReturnType<typeof ids<"session">>
    await recordLineage({ adapter: "anthropic", turns: CONVERSATION, history, after: { steps: [{ calls: [{ name: "read", args: { path: "src/paginate.ts" } }] }], run: async (engine, id) => { sessionId = id; outcome = await engine.compact(compactInput(id, true)) } } })
    expect(outcome).toEqual({ status: "ok" })
    expect((await history.load(sessionId))!.some((message) => message.role === "user" && message.content.startsWith("Summary of the conversation"))).toBe(false)
  })
})

describe("a manual and an automatic compaction repeat the last main request too", () => {
  for (const adapter of ADAPTERS) for (const kind of ["manual", "automatic"] as const) {
    test(`${adapter} (${kind}): tools, system prompt and every earlier message are unchanged; only the prompt is appended`, async () => {
      let outcome: TurnOutcome | undefined
      const cards: Array<Record<string, unknown> | undefined> = []
      const calls = await recordLineage({
        adapter, turns: CONVERSATION, promptCache: "smart",
        // The last call left 4,720 tokens of context: over this threshold, so the automatic compaction is due.
        engineOptions: kind === "automatic" ? { compactAtTokens: 4_000 } : {},
        after: { steps: [{ text: SUMMARY, usage: { input: 300, output: 60, cacheRead: 4700 } }], run: async (engine, sessionId) => {
          if (kind === "automatic") expect(engine.needsCompaction(sessionId)).toBe(true)
          outcome = await engine.compact({ ...compactInput(sessionId, false), emit: (event) => { if (event.type === "item.started" && event.kind === "compaction") cards.push(event.meta) }, ...(kind === "manual" ? { instructions: "Keep the failing test names." } : {}) })
        } },
      })
      expect(calls).toHaveLength(6)
      expect(outcome).toMatchObject({ status: "ok", compacted: true })
      const [last, compaction] = [calls[4]!, calls[5]!]
      expect(comparePrefix(adapter, last.body, compaction.body)).toMatchObject({ share: 1, firstDifference: "none" })
      expect(compaction.body.prompt_cache_key).toBe(last.body.prompt_cache_key)
      const sent = JSON.stringify(compaction.body)
      expect(sent).toContain("Do not call any tool")
      // `/compact <instructions>` is in the prompt the request ends with.
      expect(sent.includes("Keep the failing test names.")).toBe(kind === "manual")
      expect(cards).toEqual([expect.objectContaining({ cachedPrefix: true })])
    })
  }
})

describe("compaction while idle is skipped when it could not read the cache", () => {
  const engineFor = (options: Partial<Parameters<typeof createNativeEngine>[0]> = {}) => {
    const scripted = scriptedProvider([stop("answer"), stop(SUMMARY)])
    const history = memoryHistory()
    return { ...scripted, history, engine: createNativeEngine({ provider: scripted.provider, tools: [], history, cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "Summarize", ...options }) }
  }

  test("no main call on record in this process (a restarted daemon): no model call, nothing replaced", async () => {
    const first = engineFor()
    const sessionId = ids("session")
    await first.engine.runTurn(turn({ text: "hello", sessionId }).input)
    const restarted = engineFor({ history: first.history })
    expect(await restarted.engine.compact(compactInput(sessionId, true))).toEqual({ status: "ok" })
    expect(restarted.requests).toHaveLength(0)
  })

  test("compaction.strategy native: not run", async () => {
    const { engine, requests } = engineFor({ compaction: () => ({ strategy: "native" }) })
    const sessionId = ids("session")
    await engine.runTurn(turn({ text: "hello", sessionId }).input)
    expect(await engine.compact(compactInput(sessionId, true))).toEqual({ status: "ok" })
    expect(requests).toHaveLength(1)
  })

  test("with the call on record it runs on the main call's model, as an automatic compaction", async () => {
    const reasons: string[] = []
    const { engine, requests } = engineFor({ hooks: { has: (name: string) => name === "compact.before", compactBefore: async (event: { reason: string }) => { reasons.push(event.reason); return undefined } } as never })
    const sessionId = ids("session")
    await engine.runTurn(turn({ text: "hello", sessionId }).input)
    expect(await engine.compact(compactInput(sessionId, true))).toMatchObject({ status: "ok", compacted: true })
    expect(reasons).toEqual(["auto"])
    expect(requests).toHaveLength(2)
    expect(requests[1]!.system).toBe(requests[0]!.system)
    expect(requests[1]!.messages.slice(0, requests[0]!.messages.length)).toEqual(requests[0]!.messages)
    expect(requests[1]!.messages.at(-1)).toMatchObject({ role: "user" })
  })
})
