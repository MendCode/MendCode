import { expect, test } from "bun:test"
import type { TurnInput } from "@mendcode/kernel"
import { createIdFactory, type TraceMetadata, type TracePort, type TraceSpan } from "@mendcode/protocol"
import { createNativeEngine, memoryHistory, RetryableProviderError, type ModelProvider } from "../src"

test("model retry attempts and compaction finish their own spans without provider text", async () => {
  const spans: Array<{ name: TraceSpan["name"]; metadata: TraceMetadata; status?: TraceSpan["status"] }> = []
  const trace: TracePort = { start(name, metadata = {}) {
    const span: typeof spans[number] = { name, metadata }
    spans.push(span)
    return { end(status = "ok", extra = {}) { span.status = status; span.metadata = { ...metadata, ...extra } } }
  } }
  let calls = 0
  const provider: ModelProvider = { id: "private-provider", model: "private-model", async *stream() {
    if (++calls === 1) throw new RetryableProviderError("private failure", undefined, "network")
    yield { type: "text", delta: calls === 2 ? "private output" : "private summary" }
    yield { type: "usage", usage: { input: 100, output: 10, reasoning: 0, cacheRead: 20, cacheWrite: 3 } }
    yield { type: "finish", reason: "stop" }
  } }
  const engine = createNativeEngine({ trace, provider, tools: [], history: memoryHistory(), cwdFor: () => "/private-project", system: () => "private system", compactionPrompt: "private compaction", sleep: async () => {}, retries: 1 })
  const ids = createIdFactory()
  const input: TurnInput = { sessionId: ids("session"), turnId: ids("turn"), text: "private prompt", attachments: [], signal: new AbortController().signal, newItemId: () => ids("item"), emit: () => {}, ask: async () => ({ kind: "deny" }), permissionMode: () => "ask", setPermissionMode: () => {} }
  expect(await engine.runTurn(input)).toEqual({ status: "ok" })
  const compactionTurn = ids("turn")
  expect(await engine.compact({ ...input, turnId: compactionTurn })).toMatchObject({ status: "ok", compacted: true })
  expect(spans.map((span) => [span.name, span.metadata.role, span.metadata.attempt, span.status])).toEqual([["session.llm", "main", 0, "error"], ["session.llm", "main", 1, "ok"], ["session.llm", "compaction", 0, "ok"]])
  expect(spans[1]!.metadata).toMatchObject({ sessionId: input.sessionId, turnId: input.turnId, inputTokens: 100, outputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 3 })
  expect(spans[2]!.metadata.turnId).toBe(compactionTurn)
  expect(JSON.stringify(spans)).not.toContain("private")
})
