import { describe, expect, test } from "bun:test"
import { LruCache } from "../src/lru"

describe("LruCache", () => {
  test("stores and reads values", () => {
    const cache = new LruCache<string, number>({ max: 2 })
    cache.set("a", 1)
    expect(cache.get("a")).toBe(1)
    expect(cache.get("missing")).toBeUndefined()
  })

  test("evicts the least recently used key", () => {
    const cache = new LruCache<string, number>({ max: 2 })
    cache.set("a", 1).set("b", 2)
    cache.get("a")
    cache.set("c", 3)
    expect(cache.keys()).toEqual(["a", "c"])
    expect(cache.has("b")).toBe(false)
  })

  test("rejects an invalid max", () => {
    expect(() => new LruCache({ max: 0 })).toThrow(RangeError)
  })
})
