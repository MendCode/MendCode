import { describe, expect, test } from "bun:test"
import { LruCache } from "../src/lru"

function clock(start = 1_000) {
  let current = start
  return { now: () => current, advance: (ms: number) => void (current += ms) }
}

describe("LruCache without ttl (unchanged behaviour)", () => {
  test("never expires and still evicts by recency", () => {
    const time = clock()
    const cache = new LruCache<string, number>({ max: 2, now: time.now })
    cache.set("a", 1).set("b", 2)
    time.advance(10 ** 9)
    expect(cache.get("a")).toBe(1)
    cache.set("c", 3)
    expect(cache.keys()).toEqual(["a", "c"])
  })

  test("the original constructor shape keeps working", () => {
    const cache = new LruCache<string, number>({ max: 1 })
    cache.set("x", 1)
    expect(cache.size).toBe(1)
  })
})

describe("LruCache ttl", () => {
  test("a default ttl expires entries", () => {
    const time = clock()
    const cache = new LruCache<string, string>({ max: 5, ttlMs: 100, now: time.now })
    cache.set("a", "A")
    time.advance(99)
    expect(cache.get("a")).toBe("A")
    time.advance(2)
    expect(cache.get("a")).toBeUndefined()
    expect(cache.has("a")).toBe(false)
  })

  test("a per-entry ttl overrides the default", () => {
    const time = clock()
    const cache = new LruCache<string, string>({ max: 5, ttlMs: 100, now: time.now })
    cache.set("short", "s", 10)
    cache.set("long", "l", 1_000)
    cache.set("default", "d")
    time.advance(50)
    expect(cache.has("short")).toBe(false)
    expect(cache.has("default")).toBe(true)
    time.advance(100)
    expect(cache.has("default")).toBe(false)
    expect(cache.has("long")).toBe(true)
  })

  test("a per-entry ttl works without a default", () => {
    const time = clock()
    const cache = new LruCache<string, number>({ max: 5, now: time.now })
    cache.set("a", 1, 20)
    cache.set("b", 2)
    time.advance(30)
    expect(cache.has("a")).toBe(false)
    expect(cache.has("b")).toBe(true)
  })

  test("writing a key again restarts its clock", () => {
    const time = clock()
    const cache = new LruCache<string, number>({ max: 5, ttlMs: 100, now: time.now })
    cache.set("a", 1)
    time.advance(80)
    cache.set("a", 2)
    time.advance(80)
    expect(cache.get("a")).toBe(2)
  })

  test("reading a key does not extend its life", () => {
    const time = clock()
    const cache = new LruCache<string, number>({ max: 5, ttlMs: 100, now: time.now })
    cache.set("a", 1)
    time.advance(60)
    expect(cache.get("a")).toBe(1)
    time.advance(60)
    expect(cache.get("a")).toBeUndefined()
  })

  test("expired entries are absent from size and keys", () => {
    const time = clock()
    const cache = new LruCache<string, number>({ max: 5, now: time.now })
    cache.set("old", 1, 10)
    cache.set("new", 2, 1_000)
    time.advance(50)
    expect(cache.size).toBe(1)
    expect(cache.keys()).toEqual(["new"])
  })

  test("an expired entry never pushes a live one out", () => {
    const time = clock()
    const cache = new LruCache<string, number>({ max: 2, now: time.now })
    cache.set("a", 1, 10)
    cache.set("b", 2)
    time.advance(50)
    cache.set("c", 3)
    expect(cache.has("b")).toBe(true)
    expect(cache.has("c")).toBe(true)
    expect(cache.size).toBe(2)
  })

  test("delete reports whether a live entry was removed", () => {
    const time = clock()
    const cache = new LruCache<string, number>({ max: 2, now: time.now })
    cache.set("a", 1, 10)
    time.advance(20)
    expect(cache.delete("a")).toBe(false)
  })

  test("falls back to Date.now when no clock is given", async () => {
    const cache = new LruCache<string, number>({ max: 2, ttlMs: 20 })
    cache.set("a", 1)
    expect(cache.get("a")).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(cache.get("a")).toBeUndefined()
  })
})
