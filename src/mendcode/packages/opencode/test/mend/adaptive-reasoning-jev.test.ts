import { describe, expect, test } from "bun:test"
import { evaluateJev, jevRequest } from "../../src/mend/adaptive-reasoning/jev"
import { defaultAdaptivePolicy } from "../../src/mend/adaptive-reasoning/policy"

const result = {
  model: "typesafe/jev-1.13-20260917", provider: "TypeSafe",
  answers: { effort: { type: "choice", choice: "high" }, lease: { type: "choice", choice: "2" } },
  usage: { input_tokens: 100, output_tokens: 20, cost: 0.01 },
}
const base = () => ({
  context: { goal: "Inspect public fixture", progress: "", tools: [] },
  policy: { ...defaultAdaptivePolicy, mode: "shadow" as const, remoteProcessing: true },
  supportedEfforts: ["low", "high"],
  apiKey: "fixture-key-not-a-real-credential",
  signal: new AbortController().signal,
  isCurrent: async () => true,
  admitAttempt: async () => true,
})

describe("Jev isolated HTTP contract", () => {
  test("sends typed decisions to pinned endpoint and validates observed usage", async () => {
    let calls = 0
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
      calls++
      const body = await request.json()
      expect(body.model).toBe("typesafe/jev-1.13")
      expect(body.provider).toEqual({ only: ["typesafe"], allow_fallbacks: false })
      expect(Object.keys(body.questions.effort.criteria)).toEqual(["low", "high"])
      expect(Object.keys(body.questions.lease.criteria)).toEqual(["1", "2"])
      expect(body.tools).toBeUndefined()
      return Response.json(result)
    } })
    try {
      const decision = await evaluateJev({ ...base(), fetch: (url, init) => {
        expect(url).toBe("https://openrouter.ai/api/alpha/decisions")
        expect(init.redirect).toBe("error")
        return fetch(server.url, init)
      } })
      expect(decision).toMatchObject({ effort: "high", leaseSteps: 2, attempts: 1, usage: { inputTokens: 100, outputTokens: 20, cost: 0.01 } })
      expect(calls).toBe(1)
    } finally { await server.stop(true) }
  })

  test("off, missing consent, missing credential, stale revision and denied budget send nothing", async () => {
    let calls = 0
    const transport = async () => { calls++; return Response.json(result) }
    const variants = [
      { policy: { ...base().policy, mode: "off" as const } },
      { policy: { ...base().policy, remoteProcessing: false } },
      { apiKey: "" },
      { isCurrent: async () => false },
      { admitAttempt: async () => false },
    ]
    for (const variant of variants) await expect(evaluateJev({ ...base(), ...variant, fetch: transport })).rejects.toThrow("blocked")
    expect(calls).toBe(0)
  })

  test("a policy revision change after response rejects the decision", async () => {
    let current = true
    await expect(evaluateJev({ ...base(), isCurrent: async () => current, fetch: async () => {
      current = false
      return Response.json(result)
    } })).rejects.toMatchObject({ code: "stale" })
  })

  test("invalid model/provider/effort/lease/JSON and oversize responses do not retry", async () => {
    const responses = [
      () => Response.json({ ...result, model: "unrequested-model" }),
      () => Response.json({ ...result, provider: "Other" }),
      () => Response.json({ ...result, answers: { ...result.answers, effort: { type: "choice", choice: "none" } } }),
      () => Response.json({ ...result, answers: { ...result.answers, lease: { type: "choice", choice: "5" } } }),
      () => Response.json({ ...result, answers: { ...result.answers, lease: { type: "choice", choice: "02" } } }),
      () => new Response("{"),
      () => new Response("x".repeat(65_537)),
    ]
    for (const response of responses) {
      let count = 0
      await expect(evaluateJev({ ...base(), fetch: async () => { count++; return response() } })).rejects.toMatchObject({ code: "response" })
      expect(count).toBe(1)
    }
  })

  test("missing usage stays unknown, never zero", async () => {
    const { usage, ...withoutUsage } = result
    const decision = await evaluateJev({ ...base(), fetch: async () => Response.json(withoutUsage) })
    expect(decision.usage.cost).toBeUndefined()
    expect(decision.usage.inputTokens).toBeUndefined()
  })

  test("429 and 5xx have at most two separately admitted attempts", async () => {
    for (const status of [429, 503]) {
      let attempts = 0
      let admissions = 0
      const decision = await evaluateJev({ ...base(), admitAttempt: async () => { admissions++; return true }, fetch: async () => {
        attempts++
        return attempts === 1 ? new Response("ignored", { status, headers: { "retry-after": "0" } }) : Response.json(result)
      } })
      expect(decision.attempts).toBe(2)
      expect(admissions).toBe(2)
    }
    let count = 0
    await expect(evaluateJev({ ...base(), fetch: async () => {
      count++
      return new Response("ignored", { status: 503, headers: { "retry-after": "0" } })
    } })).rejects.toMatchObject({ code: "http", status: 503 })
    expect(count).toBe(2)
  })

  test("401, 403, long retry-after and network errors never leak provider text", async () => {
    for (const status of [401, 403, 429]) {
      let count = 0
      await expect(evaluateJev({ ...base(), fetch: async () => {
        count++
        return new Response("sensitive provider response", { status, headers: { "retry-after": "60" } })
      } })).rejects.toMatchObject({ code: "http", message: "Jev evaluation blocked: http" })
      expect(count).toBe(1)
    }
    await expect(evaluateJev({ ...base(), fetch: async () => { throw new Error(base().apiKey) } }))
      .rejects.toMatchObject({ code: "network", message: "Jev evaluation blocked: network" })
  })

  test("budget denial on retry prevents the second request", async () => {
    let admissions = 0
    let calls = 0
    await expect(evaluateJev({ ...base(), admitAttempt: async () => ++admissions === 1, fetch: async () => {
      calls++
      return new Response(null, { status: 429, headers: { "retry-after": "0" } })
    } })).rejects.toMatchObject({ code: "budget" })
    expect(calls).toBe(1)
  })

  test("cancelled and late success cannot commit a decision", async () => {
    const controller = new AbortController()
    await expect(evaluateJev({ ...base(), signal: controller.signal, fetch: async () => {
      controller.abort()
      return Response.json(result)
    } })).rejects.toMatchObject({ code: "cancelled" })
  })

  test("real HTTP body stall obeys the total five-second deadline", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("{")) } })) })
    try {
      const start = performance.now()
      await expect(evaluateJev({ ...base(), fetch: (_url, init) => fetch(server.url, init) })).rejects.toMatchObject({ code: "timeout" })
      expect(performance.now() - start).toBeLessThan(6_500)
    } finally { await server.stop(true) }
  }, 8_000)

  test("redirects are rejected by actual fetch, not followed", async () => {
    let targetCalls = 0
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => {
      if (new URL(request.url).pathname === "/target") { targetCalls++; return Response.json(result) }
      return new Response(null, { status: 302, headers: { location: "/target" } })
    } })
    try {
      await expect(evaluateJev({ ...base(), fetch: (_url, init) => fetch(server.url, init) })).rejects.toMatchObject({ code: "network" })
      expect(targetCalls).toBe(0)
    } finally { await server.stop(true) }
  })

  test("abort releases a stalled admission without sending a request", async () => {
    const controller = new AbortController()
    let calls = 0
    await expect(evaluateJev({ ...base(), signal: controller.signal, admitAttempt: () => {
      queueMicrotask(() => controller.abort())
      return new Promise<boolean>(() => {})
    }, fetch: async () => { calls++; return Response.json(result) } })).rejects.toMatchObject({ code: "cancelled" })
    expect(calls).toBe(0)
  })

  test("caller mutation cannot expand the effort choices after dispatch", async () => {
    const input = base()
    await expect(evaluateJev({ ...input, fetch: async () => {
      input.supportedEfforts.push("max")
      return Response.json({ ...result, answers: { ...result.answers, effort: { type: "choice", choice: "max" } } })
    } })).rejects.toMatchObject({ code: "response" })
  })

  test("known credentials in context and cancellation during retry never send another request", async () => {
    let calls = 0
    await expect(evaluateJev({ ...base(), context: { ...base().context, goal: base().apiKey }, fetch: async () => {
      calls++
      return Response.json(result)
    } })).rejects.toMatchObject({ code: "context" })
    expect(calls).toBe(0)
    const controller = new AbortController()
    await expect(evaluateJev({ ...base(), signal: controller.signal, fetch: async () => {
      calls++
      queueMicrotask(() => controller.abort())
      return new Response(null, { status: 429, headers: { "retry-after": "1" } })
    } })).rejects.toMatchObject({ code: "cancelled" })
    expect(calls).toBe(1)
  })

  test("request context budget and capability intersection reject before dispatch", () => {
    expect(() => jevRequest({ ...base().context, goal: "x".repeat(8_193) }, ["high"], 2)).toThrow("context")
    expect(() => jevRequest(base().context, ["none"], 2)).toThrow("capability")
    expect(() => jevRequest(base().context, [], 2)).toThrow("capability")
    const escaped = { goal: "\u0000".repeat(8_192), progress: "", tools: [] }
    expect(() => jevRequest(escaped, ["high"], 2)).toThrow("context")
  })
})
