import { describe, expect, test } from "bun:test"
import { createClient } from "../src/client"
import { config } from "../src/config"
import { healthProbe } from "../src/health"
import { buildUrl, requestOptions } from "../src/http"
import { retry } from "../src/retry"
import { deliverWebhook, webhookEndpoint } from "../src/webhooks"

describe("config", () => {
  test("exposes the shared values", () => {
    expect(config.baseUrl).toBe("https://api.example.test/v2")
    expect(config.timeoutMs).toBe(5000)
    expect(config.retries).toBe(3)
    expect(config.retryDelayMs).toBe(250)
  })
})

describe("urls", () => {
  test("buildUrl joins the base", () => {
    expect(buildUrl("users")).toBe("https://api.example.test/v2/users")
    expect(buildUrl("/users")).toBe("https://api.example.test/v2/users")
  })
  test("request options carry the timeout", () => {
    expect(requestOptions("/x")).toEqual({ url: "https://api.example.test/v2/x", timeoutMs: 5000 })
  })
  test("health probe and webhook endpoints", () => {
    expect(healthProbe()).toEqual({ url: "https://api.example.test/v2/health", timeoutMs: 5000 })
    expect(webhookEndpoint("a b")).toBe("https://api.example.test/v2/hooks/a%20b")
  })
})

describe("retry", () => {
  test("gives up after the first call plus three retries", async () => {
    let calls = 0
    const sleeps: number[] = []
    await expect(
      retry(async () => { calls++; throw new Error("nope") }, { sleep: async (ms) => void sleeps.push(ms) }),
    ).rejects.toThrow("nope")
    expect(calls).toBe(4)
    expect(sleeps).toEqual([250, 250, 250])
  })

  test("explicit options still win over the defaults", async () => {
    let calls = 0
    const sleeps: number[] = []
    await expect(
      retry(async () => { calls++; throw new Error("x") }, { retries: 1, delayMs: 9, sleep: async (ms) => void sleeps.push(ms) }),
    ).rejects.toThrow("x")
    expect(calls).toBe(2)
    expect(sleeps).toEqual([9])
  })
})

describe("client and webhooks", () => {
  test("client retries a flaky read", async () => {
    let calls = 0
    const client = createClient({
      transport: async () => (++calls < 3 ? { status: 503, body: null } : { status: 200, body: { ok: true } }),
      sleep: async () => {},
    })
    expect(await client.get("/ping")).toEqual({ ok: true })
    expect(calls).toBe(3)
    expect(client.describe()).toEqual({ base: "https://api.example.test/v2", timeoutMs: 5000, retries: 3 })
  })

  test("client gives up after four attempts", async () => {
    let calls = 0
    const client = createClient({ transport: async () => (calls++, { status: 500, body: null }), sleep: async () => {} })
    await expect(client.get("/down")).rejects.toThrow("server error 500")
    expect(calls).toBe(4)
  })

  test("webhook delivery retries server errors", async () => {
    const statuses = [500, 502, 200]
    const seen: string[] = []
    const status = await deliverWebhook("paid", async (url) => (seen.push(url), statuses.shift() ?? 200), async () => {})
    expect(status).toBe(200)
    expect(seen).toHaveLength(3)
  })
})
