import { describe, expect, test } from "bun:test"
import { backoffMs, continuationStream, isNetworkError, isQuotaBody, isTlsError, overlapLength, probeUrl, stitch, waitToRetry, type Clocks } from "../src"

/** Clocks a test moves by hand: `sleep` advances both, `suspend` advances only the wall clock (a closed lid). */
function fakeClocks() {
  let wall = 1_000_000
  let mono = 0
  const clocks: Clocks = { wall: () => wall, mono: () => mono }
  const slept: number[] = []
  return {
    clocks,
    slept,
    sleep: async (ms: number) => {
      slept.push(ms)
      wall += ms
      mono += ms
    },
    suspend: (ms: number) => void (wall += ms),
  }
}

describe("backoff and classification", () => {
  test("waits double from half a second and settle at 30 s for as long as it takes", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 500].map(backoffMs)).toEqual([500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000])
  })

  test("connection failures are network errors by code, nested cause or message; provider answers are not", () => {
    expect(isNetworkError(Object.assign(new Error("read"), { code: "ECONNRESET" }))).toBe(true)
    expect(isNetworkError(new TypeError("fetch failed", { cause: Object.assign(new Error("dns"), { code: "ENOTFOUND" }) }))).toBe(true)
    expect(isNetworkError(new Error("The socket connection was closed unexpectedly."))).toBe(true)
    expect(isNetworkError(new Error("[PROVIDER]: chatgpt 400 bad request"))).toBe(false)
    expect(isNetworkError("ECONNRESET")).toBe(false)
  })

  test("certificate failures and usage-limit bodies are told apart so they stop the turn", () => {
    expect(isTlsError(Object.assign(new Error("self signed"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }))).toBe(true)
    expect(isTlsError(new Error("connection reset"))).toBe(false)
    expect(isQuotaBody('{"error":{"type":"usage_limit_reached"}}')).toBe(true)
    expect(isQuotaBody("slow down")).toBe(false)
  })

  test("a probe counts any HTTP answer as online and a thrown request as offline", async () => {
    expect(await probeUrl({ url: "https://host/responses", fetch: async () => new Response("", { status: 405 }) })).toBe(true)
    expect(await probeUrl({ url: "https://host/responses", fetch: async () => Promise.reject(new Error("offline")) })).toBe(false)
  })
})

describe("waiting to retry", () => {
  test("a plain wait sleeps its whole delay in one-second slices", async () => {
    const t = fakeClocks()
    expect(await waitToRetry({ delayMs: 2_500, kind: "transient", signal: new AbortController().signal, sleep: t.sleep, clocks: t.clocks })).toBe("elapsed")
    expect(t.slept).toEqual([1_000, 1_000, 500])
  })

  test("a wake from sleep ends the wait as soon as the host answers", async () => {
    const t = fakeClocks()
    let probes = 0
    const sleep = async (ms: number) => {
      await t.sleep(ms)
      if (t.slept.length === 2) t.suspend(3_600_000)
    }
    const outcome = await waitToRetry({ delayMs: 30_000, kind: "transient", signal: new AbortController().signal, sleep, clocks: t.clocks, probe: async () => (probes++, true) })
    expect(outcome).toBe("online")
    expect(t.slept).toHaveLength(2)
    expect(probes).toBe(1)
  })

  test("a wake while still offline keeps waiting", async () => {
    const t = fakeClocks()
    const sleep = async (ms: number) => {
      await t.sleep(ms)
      if (t.slept.length === 1) t.suspend(60_000)
    }
    expect(await waitToRetry({ delayMs: 3_000, kind: "network", signal: new AbortController().signal, sleep, clocks: t.clocks, probe: async () => false })).toBe("elapsed")
    expect(t.slept).toEqual([1_000, 1_000, 1_000])
  })

  test("a long network wait probes every 5 s and stops when the link is back", async () => {
    const t = fakeClocks()
    let probes = 0
    const outcome = await waitToRetry({ delayMs: 30_000, kind: "network", signal: new AbortController().signal, sleep: t.sleep, clocks: t.clocks, probe: async () => ++probes === 2 })
    expect(outcome).toBe("online")
    expect(t.slept.reduce((a, b) => a + b, 0)).toBe(10_000)
  })

  test("a transient failure is not probed early: the provider, not the link, is the problem", async () => {
    const t = fakeClocks()
    let probes = 0
    expect(await waitToRetry({ delayMs: 30_000, kind: "transient", signal: new AbortController().signal, sleep: t.sleep, clocks: t.clocks, probe: async () => (probes++, true) })).toBe("elapsed")
    expect(probes).toBe(0)
  })

  test("cancelling during the wait returns at once", async () => {
    const t = fakeClocks()
    const controller = new AbortController()
    const sleep = async (ms: number) => {
      await t.sleep(ms)
      controller.abort()
    }
    expect(await waitToRetry({ delayMs: 30_000, kind: "network", signal: controller.signal, sleep, clocks: t.clocks })).toBe("cancelled")
    expect(t.slept).toEqual([1_000])
  })
})

describe("continuation", () => {
  test("repeated tail words are trimmed, only past six characters", () => {
    expect(overlapLength("The quick brown fox", "brown fox jumps")).toBe(9)
    expect(stitch("The quick brown fox", "brown fox jumps")).toBe(" jumps")
    expect(stitch("The quick brown fox", "fox jumps")).toBe("fox jumps")
    expect(stitch("The quick brown fox", " jumps over")).toBe(" jumps over")
  })

  test("a model that restarts from the top keeps only what goes past the partial", () => {
    const partial = "Here is the plan for the migration: first copy the tables"
    expect(stitch(partial, `${partial}, then swap the reads.`)).toBe(", then swap the reads.")
    expect(stitch(partial, partial.slice(0, 40))).toBe("")
  })

  test("streamed deltas are held until they stop matching the partial, then flow unchanged", () => {
    const stream = continuationStream("Step one is done. Step two")
    expect(stream.push("Step")).toBe("")
    expect(stream.push(" two")).toBe("")
    expect(stream.push(" is next")).toBe(" is next")
    expect(stream.push(" and three")).toBe(" and three")
    expect(stream.flush()).toBe("")
  })

  test("held text is released on flush when the stream ends early", () => {
    const stream = continuationStream("Step one is done. Step two")
    expect(stream.push(" two")).toBe("")
    expect(stream.flush()).toBe(" two")
  })
})
