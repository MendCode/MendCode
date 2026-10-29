import { describe, expect, test } from "bun:test"
import { retry, settleAll } from "../src/async"

describe("retry", () => {
  test("returns the first success", async () => {
    let calls = 0
    expect(await retry(async () => (++calls, "ok"), 3)).toBe("ok")
    expect(calls).toBe(1)
  })
  test("runs the task `attempts` times in total", async () => {
    let calls = 0
    await expect(retry(async () => { calls++; throw new Error(`fail ${calls}`) }, 3)).rejects.toThrow("fail 3")
    expect(calls).toBe(3)
  })
  test("succeeds on the last allowed attempt", async () => {
    let calls = 0
    expect(await retry(async () => { if (++calls < 3) throw new Error("no"); return calls }, 3)).toBe(3)
  })
  test("one attempt means one run", async () => {
    let calls = 0
    await expect(retry(async () => { calls++; throw new Error("x") }, 1)).rejects.toThrow("x")
    expect(calls).toBe(1)
  })
  test("attempts below 1 are rejected", async () => {
    await expect(retry(async () => 1, 0)).rejects.toThrow(RangeError)
  })
})

describe("settleAll", () => {
  test("splits values and every error, in order", async () => {
    const result = await settleAll([Promise.resolve(1), Promise.reject(new Error("a")), Promise.resolve(2), Promise.reject(new Error("b"))])
    expect(result.values).toEqual([1, 2])
    expect(result.errors.map((error) => (error as Error).message)).toEqual(["a", "b"])
  })
  test("all fulfilled", async () => {
    expect(await settleAll([Promise.resolve("x")])).toEqual({ values: ["x"], errors: [] })
  })
})
