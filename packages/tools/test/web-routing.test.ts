import { expect, test } from "bun:test"
import { createWebRouting } from "../src/web-routing"

test("hosted fallback is off, explicit, separately authorized and never inherits auth", async () => {
  const seen: Array<{ endpoint: string; credential?: string }> = []
  const grants: string[] = []
  const routing = createWebRouting({ primary: { id: "primary", endpoint: "https://primary.invalid/search", credential: "primary-key" }, fallback: { id: "fallback", endpoint: "https://fallback.invalid/search", credential: "fallback-key" }, authorize: async (route) => { grants.push(route.endpoint); return true }, request: async (route) => { seen.push(route); if (route.id === "primary") throw new Error("primary-key"); return { text: "result" } } })
  const signal = new AbortController().signal
  await expect(routing.fetch("query", signal)).rejects.toThrow("fallback disabled")
  expect(seen).toHaveLength(1)
  expect(await routing.fetch("query", signal, { fallbackConsent: { endpoint: "https://fallback.invalid/search", shareQuery: true } })).toEqual({ text: "result", route: "fallback", fallback: true })
  expect(seen.at(-1)?.credential).toBe("fallback-key")
  expect(grants.at(-1)).toBe("https://fallback.invalid/search")
  await expect(routing.fetch("‹secret:1›", signal)).rejects.toThrow("private query")
  const controller = new AbortController(); controller.abort()
  await expect(routing.fetch("query", controller.signal)).rejects.toThrow("denied")
})
test("missing credential and destination denial cannot trigger fallback", async () => {
  let calls = 0
  const routing = createWebRouting({ primary: { id: "primary", endpoint: "https://primary.invalid" }, authorize: async () => false, request: async () => { calls++; return { text: "" } } })
  await expect(routing.fetch("query", new AbortController().signal)).rejects.toThrow("credential missing")
  expect(calls).toBe(0)
})

test("abort during approval prevents a request and redaction precedes truncation", async () => {
  const controller = new AbortController()
  let calls = 0
  const route = { id: "one", endpoint: "https://one.invalid", credential: "boundary-secret" }
  const cancelled = createWebRouting({ primary: route, authorize: async () => { controller.abort(); return true }, request: async () => { calls++; return { text: "" } } })
  await expect(cancelled.fetch("query", controller.signal)).rejects.toThrow("denied")
  expect(calls).toBe(0)
  const routing = createWebRouting({ primary: route, authorize: async () => true, request: async () => ({ text: "x".repeat(64 * 1024 - 5) + route.credential }) })
  const result = await routing.fetch("query", new AbortController().signal)
  expect(result.text).not.toContain("bound")
  expect(result.text.length).toBeLessThanOrEqual(64 * 1024)
})
