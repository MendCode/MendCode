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
