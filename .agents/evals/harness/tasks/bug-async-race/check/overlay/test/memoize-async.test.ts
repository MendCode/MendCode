import { describe, expect, test } from "bun:test"
import { memoizeAsync } from "../src/memoize-async"
import { createProfileService } from "../src/profile-service"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("memoizeAsync", () => {
  test("a finished value is reused", async () => {
    let calls = 0
    const get = memoizeAsync(async (key: string) => {
      calls++
      return key.toUpperCase()
    })
    expect(await get("a")).toBe("A")
    expect(await get("a")).toBe("A")
    expect(calls).toBe(1)
  })

  test("concurrent callers share one load", async () => {
    let calls = 0
    const get = memoizeAsync(async (key: string) => {
      calls++
      await sleep(10)
      return key
    })
    const results = await Promise.all([get("x"), get("x"), get("x")])
    expect(results).toEqual(["x", "x", "x"])
    expect(calls).toBe(1)
  })

  test("different keys load independently", async () => {
    const seen: string[] = []
    const get = memoizeAsync(async (key: string) => {
      seen.push(key)
      await sleep(5)
      return key
    })
    await Promise.all([get("a"), get("b"), get("a")])
    expect(seen.sort()).toEqual(["a", "b"])
  })

  test("a failed load rejects every waiter and is not cached", async () => {
    let calls = 0
    const get = memoizeAsync(async (key: string) => {
      calls++
      await sleep(5)
      if (calls === 1) throw new Error("boom")
      return key
    })
    const first = await Promise.allSettled([get("k"), get("k")])
    expect(first.map((r) => r.status)).toEqual(["rejected", "rejected"])
    expect(calls).toBe(1)
    expect(get.has("k")).toBe(false)
    expect(await get("k")).toBe("k")
    expect(calls).toBe(2)
  })

  test("a call that arrives while another is mid-flight joins it", async () => {
    let calls = 0
    const get = memoizeAsync(async (key: string) => {
      calls++
      await sleep(20)
      return key
    })
    const first = get("m")
    await sleep(5)
    const second = get("m")
    expect(await first).toBe("m")
    expect(await second).toBe("m")
    expect(calls).toBe(1)
  })

  test("clear forgets finished values", async () => {
    let calls = 0
    const get = memoizeAsync(async (key: string) => {
      calls++
      return key
    })
    await get("c")
    get.clear()
    await get("c")
    expect(calls).toBe(2)
  })
})

describe("profile service", () => {
  test("two simultaneous lookups hit the store once", async () => {
    let hits = 0
    const service = createProfileService(async (id) => {
      hits++
      await sleep(5)
      return { id, name: `user-${id}` }
    })
    const [a, b] = await Promise.all([service.profile("7"), service.profile("7")])
    expect(a).toEqual({ id: "7", name: "user-7" })
    expect(b).toBe(a)
    expect(hits).toBe(1)
  })
})
