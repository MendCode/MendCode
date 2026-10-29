import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createIdFactory, type ReasoningPolicy } from "@mendcode/protocol"
import type { TurnInput } from "@mendcode/kernel"
import { createLoopbackJevEvaluator, createNativeEngine, createReasoningController, jevBody, memoryHistory, reasoningContext, type ModelMessage, type ModelProvider, type ModelRequest, type ReasoningEvaluator, type ReasoningGeneration, type ReasoningSnapshot } from "../src"

const ids = createIdFactory()
const defaults: ReasoningPolicy = { version: 1, mode: "off", remoteProcessing: false, provider: "openrouter", maxLeaseSteps: 2, maxDecisionsPerTurn: 8, failureMode: "pause" }
const messages: ModelMessage[] = [{ role: "user", content: "Fix the parser" }]
type Transport = NonNullable<Parameters<typeof createLoopbackJevEvaluator>[0]["transport"]>

function setup(config: Partial<ReasoningPolicy> = {}, evaluate?: ReasoningEvaluator) {
  const policy = { ...defaults, ...config }
  const snapshot: ReasoningSnapshot = { report: { config: policy, consent: policy, revision: "revision-1", valid: true, evaluatorReady: true, reasoningAuto: false }, choice: { model: "local:main", effort: "low" }, binding: "binding-1", efforts: ["low", "medium", "high", "xhigh"], manual: false }
  let calls = 0
  const port = createReasoningController({ snapshot: () => snapshot, evaluate: async (input) => {
    calls++
    return evaluate ? evaluate(input) : { effort: "high", leaseSteps: 2 }
  } })
  const input: ReasoningGeneration = { sessionId: ids("session"), turnId: ids("turn"), choice: snapshot.choice, messages, role: "main", signal: new AbortController().signal, manual: false }
  return { port, input, snapshot, calls: () => calls }
}

describe("B25 reasoning runtime", () => {
  test("JEV is capped at high while manual xhigh and max remain available", async () => {
    const harness = setup({ mode: "adaptive", remoteProcessing: true }, async (input) => {
      expect(input.efforts).toEqual(["low", "medium", "high"])
      return { effort: "high", leaseSteps: 2 }
    })
    harness.snapshot.efforts.push("max")
    expect((await harness.port.prepare(harness.input)).effort).toBe("high")
    for (const effort of ["xhigh", "max"] as const) {
      expect((await harness.port.prepare({ ...harness.input, manual: true, choice: { model: "local:main", effort } })).effort).toBe(effort)
    }
    expect(harness.calls()).toBe(1)
    for (const effort of ["xhigh", "max"] as const) {
      const invalid = setup({ mode: "adaptive", remoteProcessing: true }, async () => ({ effort, leaseSteps: 2 }))
      invalid.snapshot.efforts.push("max")
      await expect(invalid.port.prepare(invalid.input)).rejects.toMatchObject({ code: "response" })
    }
  })

  test("bounded reasoning slots never interrupt off or manual baseline turns", async () => {
    const harness = setup()
    for (let index = 0; index < 70; index++) {
      const prepared = await harness.port.prepare({ ...harness.input, sessionId: ids("session"), generationId: `generation-${index}` })
      expect(prepared.effort).toBe("low")
      prepared.dispatch()
    }
    harness.snapshot.report.config = { ...defaults, mode: "adaptive", remoteProcessing: true }
    expect((await harness.port.prepare({ ...harness.input, manual: true })).effort).toBe("low")
    await expect(harness.port.prepare(harness.input)).rejects.toMatchObject({ code: "capability" })
    expect(harness.calls()).toBe(0)
    harness.port.dispose()
  })

  test("off, missing consent, unsupported and manual bindings never evaluate", async () => {
    for (const config of [{}, { mode: "adaptive" as const }, { mode: "shadow" as const }]) {
      const harness = setup(config)
      expect((await harness.port.prepare(harness.input)).effort).toBe("low")
      expect(harness.calls()).toBe(0)
    }
    const harness = setup({ mode: "adaptive", remoteProcessing: true })
    harness.snapshot.report.evaluatorReady = false
    expect((await harness.port.prepare(harness.input)).effort).toBe("low")
    expect(harness.port.receipt(harness.input.sessionId)?.status).toBe("unsupported")
    harness.snapshot.report.evaluatorReady = true
    harness.snapshot.manual = true
    harness.input.choice = { model: "local:main", effort: "xhigh" }
    expect((await harness.port.prepare(harness.input)).effort).toBe("xhigh")
    expect(harness.calls()).toBe(0)
  })

  test("leases count dispatched generations once, not tools or preparation", async () => {
    const harness = setup({ mode: "adaptive", remoteProcessing: true })
    const first = await harness.port.prepare(harness.input)
    expect(first.effort).toBe("high")
    expect(harness.port.receipt(harness.input.sessionId)?.leaseRemaining).toBe(2)
    first.dispatch()
    first.dispatch()
    expect(harness.port.receipt(harness.input.sessionId)?.leaseRemaining).toBe(1)
    const second = await harness.port.prepare(harness.input)
    second.dispatch()
    expect(harness.port.receipt(harness.input.sessionId)?.status).toBe("reused")
    expect(harness.calls()).toBe(1)
    const third = await harness.port.prepare(harness.input)
    third.dispatch()
    expect(harness.calls()).toBe(2)
    harness.port.release(harness.input.sessionId)
    expect(harness.port.receipt(harness.input.sessionId)?.leaseRemaining).toBe(0)
  })

  test("shadow observes decisions without changing baseline effort", async () => {
    const harness = setup({ mode: "shadow", remoteProcessing: true })
    const prepared = await harness.port.prepare(harness.input)
    expect(prepared.effort).toBe("low")
    prepared.dispatch()
    expect(harness.port.receipt(harness.input.sessionId)).toMatchObject({ status: "proposed", effort: "low", suggestedEffort: "high", leaseRemaining: 1 })
  })

  test("repeated preparation of the same generation shares one decision and dispatch receipt", async () => {
    const harness = setup({ mode: "adaptive", remoteProcessing: true })
    const input = { ...harness.input, generationId: "generation-1" }
    const first = harness.port.prepare(input)
    const second = harness.port.prepare(input)
    expect(first).toBe(second)
    const prepared = await first
    prepared.dispatch()
    const duplicate = await second
    duplicate.dispatch()
    expect(harness.calls()).toBe(1)
    expect(harness.port.receipt(input.sessionId)?.leaseRemaining).toBe(1)
    harness.port.dispose()
  })

  test("pause and baseline bound failures and decision exhaustion to this turn", async () => {
    for (const failureMode of ["pause", "baseline"] as const) {
      const harness = setup({ mode: "adaptive", remoteProcessing: true, failureMode }, async () => { throw new Error("secret upstream detail") })
      if (failureMode === "pause") await expect(harness.port.prepare(harness.input)).rejects.toMatchObject({ code: "response" })
      else expect((await harness.port.prepare(harness.input)).effort).toBe("low")
      expect(harness.port.receipt(harness.input.sessionId)?.status).toBe(failureMode === "pause" ? "paused" : "fallback")
      expect(JSON.stringify(harness.port.receipt(harness.input.sessionId))).not.toContain("secret upstream detail")
      if (failureMode === "baseline") await harness.port.prepare(harness.input)
      expect(harness.calls()).toBe(1)
      harness.input.turnId = ids("turn")
      if (failureMode === "pause") await expect(harness.port.prepare(harness.input)).rejects.toMatchObject({ code: "response" })
      else await harness.port.prepare(harness.input)
      expect(harness.calls()).toBe(2)
    }
    const limited = setup({ mode: "adaptive", remoteProcessing: true, maxDecisionsPerTurn: 1, maxLeaseSteps: 1 }, async () => ({ effort: "medium", leaseSteps: 1 }))
    const prepared = await limited.port.prepare(limited.input)
    prepared.dispatch()
    await expect(limited.port.prepare(limited.input)).rejects.toMatchObject({ code: "budget" })
    expect(limited.calls()).toBe(1)
  })

  test("cancellation and binding, consent or compaction changes reject stale dispatch", async () => {
    for (const change of ["binding", "revision", "manual", "compact"] as const) {
      const harness = setup({ mode: "adaptive", remoteProcessing: true })
      const prepared = await harness.port.prepare(harness.input)
      if (change === "binding") harness.snapshot.binding = "another-model"
      if (change === "revision") harness.snapshot.report.revision = "another-policy"
      if (change === "manual") harness.port.manual(harness.input.sessionId)
      if (change === "compact") harness.port.invalidate(harness.input.sessionId)
      expect(() => prepared.dispatch()).toThrow("stale")
    }
    const harness = setup({ mode: "adaptive", remoteProcessing: true }, () => new Promise(() => {}))
    const abort = new AbortController()
    const pending = harness.port.prepare({ ...harness.input, signal: abort.signal })
    abort.abort()
    await expect(pending).rejects.toMatchObject({ code: "cancelled" })
    harness.port.dispose()
  })

  test("reasoning_auto starts balanced, increases once to high, works without remote consent and respects manual", async () => {
    const harness = setup()
    harness.snapshot.report.reasoningAuto = true
    const balanced = await harness.port.prepare(harness.input)
    expect(balanced.effort).toBe("medium")
    balanced.dispatch()
    expect(harness.port.requestIncrease(harness.input.sessionId, "network_failed", "429").status).toBe("unchanged")
    expect(harness.port.requestIncrease(harness.input.sessionId, "verification_failed", "parser regression at line 10")).toMatchObject({ status: "requested", effort: "high" })
    expect((await harness.port.prepare(harness.input)).effort).toBe("high")
    expect(harness.port.requestIncrease(harness.input.sessionId, "technical_block", "cannot resolve types").status).toBe("unchanged")
    expect(harness.calls()).toBe(0)
    harness.port.manual(harness.input.sessionId)
    expect((await harness.port.prepare({ ...harness.input, choice: { model: "local:main", effort: "low" } })).effort).toBe("low")
    expect(harness.port.requestIncrease(harness.input.sessionId, "technical_block", "cannot resolve types").status).toBe("unchanged")
  })

  test("a noncooperative evaluator is bounded by the five-second deadline", async () => {
    const harness = setup({ mode: "adaptive", remoteProcessing: true }, () => new Promise(() => {}))
    await expect(harness.port.prepare(harness.input)).rejects.toMatchObject({ code: "response" })
    expect(harness.calls()).toBe(1)
    expect(harness.port.receipt(harness.input.sessionId)?.status).toBe("paused")
    harness.port.dispose()
  }, 7000)

  test("native provider generations receive escalation, retain the model, and release the turn lease", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mend-b25-engine-"))
    try {
      const harness = setup()
      harness.snapshot.report.reasoningAuto = true
      const requests: ModelRequest[] = []
      const provider: ModelProvider = { id: "local", model: "local:main", async *stream(request) {
        requests.push(request)
        if (requests.length === 1) {
          yield { type: "tool_call", call: { callId: "auto-call", name: "reasoning_auto", args: { reason: "verification_failed", evidence: "local parser test failed" } } }
          yield { type: "finish", reason: "tool_calls" }
        } else { yield { type: "text", delta: "Fixed" }; yield { type: "finish", reason: "stop" } }
      } }
      const engine = createNativeEngine({ provider, tools: [], history: memoryHistory(), cwdFor: () => dir, system: () => "private system", compactionPrompt: "summary", modelFor: () => harness.snapshot.choice, reasoning: harness.port })
      const input: TurnInput = { sessionId: harness.input.sessionId, turnId: ids("turn"), text: "Fix parser", attachments: [], signal: new AbortController().signal, permissionMode: () => "full", setPermissionMode() {}, newItemId: () => ids("item"), emit() {}, ask: async () => ({ kind: "deny" }) }
      expect(await engine.runTurn(input)).toEqual({ status: "ok" })
      expect(requests.map((request) => [request.model, request.effort])).toEqual([["local:main", "medium"], ["local:main", "high"]])
      expect(harness.port.receipt(input.sessionId)).toMatchObject({ status: "requested", leaseRemaining: 0 })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test("context is paired, bounded, redacted and excludes instructions, attachments, arguments and reasoning", () => {
    const history: ModelMessage[] = [{ role: "user", content: "old" }, { role: "tool", callId: "old", name: "old", output: "old private", isError: false },
      { role: "user", content: "expanded file private", loadedInstructions: ["private instruction"], images: [{ mime: "image/png", base64: "PRIVATE_IMAGE" }] },
      { role: "assistant", content: "password=hunter2", toolCalls: [{ callId: "paired", name: "read", args: { private: "PRIVATE_ARGS" } }], reasoning: { provider: "local", model: "local", blocks: ["PRIVATE_REASONING"] } },
      { role: "tool", callId: "paired", name: "read", output: "Bearer abcdefghijkl\n" + "text ".repeat(1000), isError: false },
      { role: "tool", callId: "unpaired", name: "read", output: "UNPAIRED_PRIVATE", isError: false }]
    const context = reasoningContext(history, "Fix bug api_key=supersecret")
    const text = JSON.stringify(context)
    for (const secret of ["supersecret", "hunter2", "abcdefghijkl", "PRIVATE", "old private", "expanded file"]) expect(text).not.toContain(secret)
    expect(context.tools).toHaveLength(1)
    expect(Buffer.byteLength(context.tools[0]!.result)).toBeLessThanOrEqual(2048)
    expect(() => reasoningContext(messages, "x".repeat(8193))).toThrow("context")
  })
})

describe("B25 loopback JEV adapter", () => {
  const policy = { ...defaults, mode: "adaptive" as const, remoteProcessing: true }
  const evaluation = () => ({ context: { goal: "Fix parser", progress: "", tools: [] }, policy, efforts: ["low", "medium", "high"] as const, signal: new AbortController().signal, current: () => true, admit: () => true })
  const response = { model: "typesafe/jev-1.13", provider: "TypeSafe", answers: { effort: { type: "choice", choice: "high" }, lease: { type: "choice", choice: "2" } }, usage: { input_tokens: 12, output_tokens: 3, cost: 0.002 } }

  test("the adapter rejects automatic effort options above high", () => {
    for (const effort of ["xhigh", "max"] as const) {
      expect(() => jevBody({ ...evaluation(), efforts: [...evaluation().efforts, effort] })).toThrow("capability")
    }
  })

  test("only literal loopback and a nonempty auth token are accepted", () => {
    for (const endpoint of ["https://openrouter.ai/api/v1", "http://localhost:8080", "http://127.0.0.1.evil/", "http://127.0.0.1/?token=secret", "http://user:secret@127.0.0.1/"]) expect(() => createLoopbackJevEvaluator({ endpoint, token: "test-token" })).toThrow()
    expect(() => createLoopbackJevEvaluator({ endpoint: "http://127.0.0.1/", token: "" })).toThrow("credential")
    expect(createLoopbackJevEvaluator({ endpoint: "http://[::1]:8080/", token: "test-token" })).toBeFunction()
  })

  test("pinned providers, auth, bounded retries and both usage formats use an injected transport", async () => {
    for (const provider of ["openrouter", "vercel-ai-gateway"] as const) {
      const requests: RequestInit[] = []
      let admits = 0
      const transport = (async (_url: unknown, init: RequestInit) => {
        requests.push(init)
        if (requests.length === 1) return new Response("busy", { status: 429 })
        return Response.json(provider === "openrouter" ? response : { ...response, model: "typesafe-ai/jev", usage: { inputTokens: 12, outputTokens: 3, cost: 0.002 } })
      }) as Transport
      const evaluator = createLoopbackJevEvaluator({ endpoint: "http://127.0.0.1:8080/jev", token: "b25-test-token", transport })
      expect(await evaluator({ ...evaluation(), efforts: [...evaluation().efforts], policy: { ...policy, provider }, admit: () => { admits++; return true } })).toEqual({ effort: "high", leaseSteps: 2, inputTokens: 12, outputTokens: 3, costMicros: 2000 })
      expect(requests).toHaveLength(2)
      expect(admits).toBe(2)
      expect(requests[0]!.headers).toMatchObject({ authorization: "Bearer b25-test-token" })
      expect(requests[0]!.redirect).toBe("error")
      expect(JSON.parse(String(requests[0]!.body))).toMatchObject(provider === "openrouter" ? { provider: { only: ["typesafe"], allow_fallbacks: false } } : { providerOptions: { gateway: { only: ["typesafe-ai"] } } })
    }
  })

  test("invalid receipts, oversized responses, budget denial, revoked consent and leaked auth fail closed", async () => {
    for (const raw of [{ ...response, provider: "Wrong" }, { ...response, model: "other" }, { ...response, answers: { ...response.answers, lease: { type: "choice", choice: "5" } } }, "x".repeat(65537)]) {
      const evaluator = createLoopbackJevEvaluator({ endpoint: "http://127.0.0.1/", token: "b25-token", transport: (async () => typeof raw === "string" ? new Response(raw) : Response.json(raw)) as Transport })
      await expect(evaluator({ ...evaluation(), efforts: [...evaluation().efforts] })).rejects.toMatchObject({ code: "response" })
    }
    let calls = 0
    const evaluator = createLoopbackJevEvaluator({ endpoint: "http://127.0.0.1/", token: "b25-token", transport: (async () => { calls++; return Response.json(response) }) as Transport })
    for (const patch of [{ admit: () => false }, { current: () => false }, { policy: { ...policy, remoteProcessing: false } }, { context: { goal: "b25-token", progress: "", tools: [] } }]) await expect(evaluator({ ...evaluation(), efforts: [...evaluation().efforts], ...patch })).rejects.toThrow()
    expect(calls).toBe(0)
    const body = jevBody({ ...evaluation(), efforts: [...evaluation().efforts], context: { goal: "api_key=credential", progress: "", tools: [] } })
    expect(body).not.toContain("credential")
  })

  test("a hung injected transport and response body cancel without waiting for it", async () => {
    for (const transport of [(async () => new Promise(() => {})) as Transport, (async () => new Response(new ReadableStream({ start() {} }))) as Transport]) {
      const abort = new AbortController()
      const evaluator = createLoopbackJevEvaluator({ endpoint: "http://127.0.0.1/", token: "b25-token", transport })
      const pending = evaluator({ ...evaluation(), efforts: [...evaluation().efforts], signal: abort.signal })
      await Promise.resolve()
      abort.abort()
      await expect(pending).rejects.toMatchObject({ code: "cancelled" })
    }
  })
})
