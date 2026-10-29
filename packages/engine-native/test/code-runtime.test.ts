import { describe, expect, test } from "bun:test"
import { CODE_LIMITS, executeCode } from "../src/code-runtime"

const run = (code: string, extra: Partial<Parameters<typeof executeCode>[0]> = {}) => executeCode({ code, names: ["echo"], invoke: async (_, args) => args, ...extra })

describe("confined Code Mode interpreter", () => {
  test("selects tool data without retaining intermediate results; declarations, destructuring and console", async () => {
    const calls: unknown[] = []
    const result = await run('const {selected} = await tools.echo({selected: 7, large: "intermediate"}); console.log("selected", selected); return selected', { invoke: async (name, args) => { calls.push({ name, args }); return args } })
    expect(result).toMatchObject({ ok: true, value: 7, logs: ["selected 7"], toolCalls: [{ name: "echo" }] })
    expect(calls).toEqual([{ name: "echo", args: { selected: 7, large: "intermediate" } }])
    expect(JSON.stringify(result)).not.toContain("intermediate")
  })

  test("runs loops, scoped functions, branching, arrays, object access and JSON transforms", async () => {
    const result = await run(`
      function twice(n) { return n * 2 }
      let total = 0
      const values = [1, 2, 3, 4].filter(n => n % 2 === 0).map(twice)
      for (const value of values) { if (value === 4) continue; total += value }
      for (let i = 0; i < 3; i++) { total += i }
      let count = 0
      while (count < 2) { count++ }
      const obj = {total, count, ...JSON.parse('{"active":true}')}
      obj.count += 1
      return {obj, keys: Object.keys(obj), values, sum: values.reduce((a, b) => a + b, 0), label: " READY ".trim().toLowerCase(), ranked: [10, 2, 5].sort((a, b) => a - b), number: Number("42"), finite: Number.isFinite(42)}
    `)
    expect(result).toMatchObject({ ok: true, value: { obj: { total: 11, count: 3, active: true }, keys: ["total", "count", "active"], values: [4, 8], sum: 12, label: "ready", ranked: [2, 5, 10], number: 42, finite: true } })
  })

  test("awaited async maps run host calls concurrently and join selected results", async () => {
    let active = 0, peak = 0
    const result = await run('const values = await Promise.all([1, 2, 3].map(async n => { const value = await tools.echo({n}); return value.n * 2 })); return values', {
      invoke: async (_, args) => { active++; peak = Math.max(peak, active); await Bun.sleep(5); active--; return args },
    })
    expect(result).toMatchObject({ ok: true, value: [2, 4, 6] })
    expect(peak).toBe(3)
    expect(active).toBe(0)
  })

  test("the implicit async body selects its last expression, adopts returned promises and allows builtin shadowing", async () => {
    expect(await run('const input = {selected: 7}; tools.echo(input)')).toMatchObject({ ok: true, value: { selected: 7 } })
    expect(await run('return tools.echo({selected: 8})')).toMatchObject({ ok: true, value: { selected: 8 } })
    expect(await run('const JSON = {selected: 9}; JSON.selected')).toMatchObject({ ok: true, value: 9 })
    expect(await run('const result = tools.echo({selected: 1}); return {result}')).toMatchObject({ ok: false, error: { kind: "InvalidDataValue" } })
  })

  test("assignment resolves side-effecting receivers and keys once, before the incoming value", async () => {
    expect(await run('const values = [1, 2, 3]; let i = 0; values[i++] += i; values[i++]++; return {values, i}')).toMatchObject({ ok: true, value: { values: [2, 3, 3], i: 2 } })
    expect(await run('const value = {n: 1}; let calls = 0; function receiver() { calls++; return value } receiver().n++; return {value, calls}')).toMatchObject({ ok: true, value: { value: { n: 2 }, calls: 1 } })
  })

  test("tool failures can be handled locally; no implicit retry", async () => {
    let calls = 0
    const result = await run('try { await tools.echo({}); return 1 } catch (error) { return error.message } finally { console.log("closed") }', { invoke: async () => { calls++; throw new Error("Permission denied") } })
    expect(result).toMatchObject({ ok: true, value: "Permission denied", logs: ["closed"] })
    expect(calls).toBe(1)
  })

  test("process, filesystem, network, code generation and prototype escapes are unavailable", async () => {
    for (const code of [
      "return process.env", "return Bun.file('/tmp/x')", "return fetch('https://example.com')", "return globalThis.process", "return require('fs')", "return eval('1')", "return Function('return process')()",
      "return tools.echo.constructor('return process')()", "return [].constructor", "return ({}).__proto__", 'return tools["con" + "structor"]', 'return {"__proto__": {x: 1}}', "import fs from 'node:fs'", "return new Function('return 1')()",
    ]) expect((await run(code)).ok).toBe(false)
    expect(await run("return typeof process")).toMatchObject({ ok: true, value: "undefined" })
    expect(await run("const x = {}; x.x = x; return x")).toMatchObject({ ok: false, error: { kind: "InvalidDataValue" } })
  })

  test("syntax errors, empty source, unknown tools and malformed JSON fail as data", async () => {
    for (const code of ["", "const =", "return {", "/*", "return JSON.parse('bad')", "return tools.missing({})", "break"]) expect((await run(code)).ok).toBe(false)
    expect(await run('return "a".repeat(1000000000)')).toMatchObject({ ok: false, error: { kind: "ValueLimitExceeded" } })
    expect(await run("return ".repeat(10_000))).toMatchObject({ ok: false, error: { kind: "ParseError" } })
  })

  test("empty synchronous loops yield to the deadline and do not block the host event loop", async () => {
    let heartbeat = false
    const timer = setTimeout(() => { heartbeat = true }, 5)
    const started = Date.now()
    const result = await run("while (true) {}", { timeoutMs: 30 })
    clearTimeout(timer)
    expect(result).toMatchObject({ ok: false, error: { kind: "TimeoutExceeded" } })
    expect(heartbeat).toBe(true)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  test("cancellation awaits host cleanup and never admits the next call", async () => {
    const abort = new AbortController()
    let calls = 0, cleaned = false
    const result = await run("await tools.echo({}); await tools.echo({}); return 1", {
      signal: abort.signal,
      invoke: async (_, __, signal) => {
        calls++
        setTimeout(() => abort.abort(), 5)
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => setTimeout(resolve, 10), { once: true }))
        cleaned = true
        throw signal.reason
      },
    })
    expect(result).toMatchObject({ ok: false, error: { kind: "Cancelled" } })
    expect(calls).toBe(1)
    expect(cleaned).toBe(true)
  })

  test("unawaited work is interrupted and finalized before delivering the receipt", async () => {
    let cleaned = false
    const result = await run("tools.echo({}); return 7", { invoke: async (_, __, signal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => setTimeout(resolve, 5), { once: true }))
      cleaned = true
      throw signal.reason
    } })
    expect(result).toMatchObject({ ok: true, value: 7, warnings: [{ kind: "Interrupted" }] })
    expect(cleaned).toBe(true)
    expect(await run("return tools.echo({})")).toMatchObject({ ok: true, value: {} })
  })

  test("16-call and UTF-8 result/log budgets hold independently on every invocation", async () => {
    let calls = 0
    const result = await run("for (let i = 0; i < 17; i++) { await tools.echo({i}) } return 1", { invoke: async () => { calls++; return null } })
    expect(result).toMatchObject({ ok: false, error: { kind: "ToolCallLimitExceeded" } })
    expect(result.toolCalls).toHaveLength(16)
    expect(calls).toBe(16)
    for (const code of ['return "x".repeat(100000)', 'console.log("界".repeat(30000)); return "😀".repeat(10000)', 'return "\\\\".repeat(100000)']) {
      const bounded = await run(code)
      expect(bounded).toMatchObject({ ok: true, truncated: true })
      expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(CODE_LIMITS.maxOutputBytes)
      expect(JSON.stringify(bounded)).not.toContain("�")
    }
    const longName = "界".repeat(10_000)
    const receipt = await run('await tools["界".repeat(10000)]({}); return 7', { names: [longName] })
    expect(receipt).toMatchObject({ ok: true, value: 7, truncated: true })
    expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThanOrEqual(CODE_LIMITS.maxOutputBytes)
    expect(await run("return 7")).toMatchObject({ ok: true, value: 7, toolCalls: [] })
  })

  test("local schema search rejects oversized, extra and malformed inputs before touching the catalog", async () => {
    let lookups = 0
    for (const code of ['return search({query: "x".repeat(501)})', 'return search({query: "x", limit: 9})', 'return search({query: "x", extra: true})', 'return search([])']) {
      expect(await run(code, { search: () => { lookups++; return { tools: [] } } })).toMatchObject({ ok: false, error: { kind: "InvalidToolInput" } })
    }
    expect(lookups).toBe(0)
    expect(await run('return search({query: "echo", limit: 1})', { search: (query) => ({ tools: [{ name: query }] }) })).toMatchObject({ ok: true, value: { tools: [{ name: "echo" }] } })
  })
})
