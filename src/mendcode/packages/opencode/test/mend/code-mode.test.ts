import { describe, expect, test } from "bun:test"
import { jsonSchema, tool } from "ai"
import { executeCode } from "../../src/mend/codemode/host"

const tools = { echo: tool({ description: "Echo a value", inputSchema: jsonSchema({ type: "object" }), execute: async () => ({}) }) }

describe("confined Code Mode host", () => {
  test("returns selected data from host tools", async () => {
    const calls: unknown[] = []
    const result = await executeCode({ code: 'const value = await tools.echo({value: 7}); return value.selected', tools, invoke: async (name, args) => { calls.push({ name, args }); return { selected: 7, large: "intermediate" } } })
    expect(result).toMatchObject({ ok: true, value: 7 })
    expect(calls).toEqual([{ name: "echo", args: { value: 7 } }])
    expect(JSON.stringify(result)).not.toContain("intermediate")
  })
  test("does not expose process or filesystem globals", async () => {
    const result = await executeCode({ code: 'return process.env', tools: {}, invoke: async () => { throw new Error("unreachable") } })
    expect(result.ok).toBe(false)
  })
  test("enforces hard deadline even for synchronous loops", async () => {
    await expect(executeCode({ code: 'while (true) {}', tools: {}, timeoutMs: 100, invoke: async () => null })).rejects.toThrow("timed out")
  })
  test("cancellation waits for host cleanup and admits no subsequent call", async () => {
    const abort = new AbortController()
    let cleaned = false
    let count = 0
    const run = executeCode({ code: 'await tools.echo({}); await tools.echo({}); return 1', tools, signal: abort.signal,
      invoke: async (_, __, signal) => {
        count++
        setTimeout(() => abort.abort(new Error("cancelled")), 5)
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => setTimeout(resolve, 10), { once: true }))
        cleaned = true
        throw new Error("stopped")
      },
    })
    await expect(run).rejects.toThrow("cancelled")
    expect(cleaned).toBe(true)
    expect(count).toBe(1)
  })
})

test("Code Mode returns a host permission denial without retrying", async () => {
  let calls = 0
  const result = await executeCode({ code: 'await tools.echo({}); return 1', tools, invoke: async () => { calls++; throw new Error("Permission denied") } })
  expect(result.ok).toBe(false)
  expect(JSON.stringify(result)).toContain("Permission denied")
  expect(calls).toBe(1)
})

test("Code Mode validates inputs before invoking the host", async () => {
  let called = false
  const strict = tool({ inputSchema: jsonSchema({ type: "object" }, { validate: () => ({ success: false, error: new Error("invalid input") }) }), execute: async () => ({}) })
  const result = await executeCode({ code: 'return await tools.strict({})', tools: { strict }, invoke: async () => { called = true; return {} } })
  expect(result.ok).toBe(false)
  expect(called).toBe(false)
})

test("Code Mode bounds final output", async () => {
  const result = await executeCode({ code: 'return "x".repeat(100000)', tools: {}, invoke: async () => null })
  expect(result.truncated).toBe(true)
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(26000)
})
