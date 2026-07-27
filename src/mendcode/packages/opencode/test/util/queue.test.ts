import { describe, expect, test } from "bun:test"
import { AsyncQueue } from "../../src/util/queue"

describe("AsyncQueue", () => {
  test("rejects items beyond the configured item limit", async () => {
    const queue = new AsyncQueue<number>({ maxItems: 2 })
    expect(queue.push(1)).toBe(true)
    expect(queue.push(2)).toBe(true)
    expect(queue.push(3)).toBe(false)
    expect(await queue.next()).toBe(1)
    expect(queue.push(3)).toBe(true)
    expect(await queue.next()).toBe(2)
    expect(await queue.next()).toBe(3)
  })

  test("rejects items beyond the configured byte limit", async () => {
    const queue = new AsyncQueue<string>({ maxBytes: 3, sizeOf: (value) => Buffer.byteLength(value) })
    expect(queue.push("ab")).toBe(true)
    expect(queue.push("cd")).toBe(false)
    expect(await queue.next()).toBe("ab")
    expect(queue.push("cd")).toBe(true)
    expect(await queue.next()).toBe("cd")
  })

  test("closes pending readers and rejects future writes", async () => {
    const queue = new AsyncQueue<string | null>()
    const pending = queue.next()
    queue.close(null)
    expect(await pending).toBeNull()
    expect(queue.push("late")).toBe(false)
    expect(await queue.next()).toBeNull()
  })
})
