import { describe, expect, test } from "bun:test"
import { executeCode } from "../src/code-runtime"

const run = (code: string, extra: Partial<Parameters<typeof executeCode>[0]> = {}) => executeCode({ code, names: ["echo"], invoke: async (_, args) => args, timeoutMs: 5000, ...extra })
const value = async (code: string) => {
  const result = await run(code)
  if (!result.ok) throw new Error(`${result.error?.kind}: ${result.error?.message}`)
  return result.value
}
const failure = async (code: string) => (await run(code)).error

describe("TypeScript type stripping", () => {
  test("annotations, generics, assertions, interfaces and aliases are skipped without being executed", async () => {
    expect(await value(`
      interface Entry { id: string; name?: string; tags: Array<Record<string, number[]>> }
      type Id = string | number
      type Pair<T> = [T, T] | { first: T; second?: T }
      declare const ignored: number
      const entries: Entry[] = [{ id: "a", tags: [] }, { id: "b", name: "Save", tags: [] }]
      function pick<T extends { id: string }>(items: T[], id: string): T | undefined { return items.find((item): boolean => item.id === id) }
      function overload(x: number): number
      function overload(x: string): string
      const found = pick<Entry>(entries, "b")!
      const count = (entries as Array<Entry>).length satisfies number
      const twice = async (x: number, label?: string): Promise<number> => x * 2
      const identity = <T,>(x: T): T => x
      const callback = (fn: (x: number) => void, map: Record<string, Map<string, number[]>>): void => {}
      let maybe: number | null = null
      const typed = new Map<string, number[]>()
      return { name: found.name, count, doubled: await twice(4), maybe, id: identity<string>("q"), typed: typed.size }
    `)).toEqual({ name: "Save", count: 2, doubled: 8, maybe: null, id: "q", typed: 0 })
  })

  test("comparisons are not mistaken for generic calls and unsupported TypeScript runtime features are diagnosed", async () => {
    expect(await value("const a = 1, b = 2; return [a < b, a < b && b > (a), (a) < b]")).toEqual([true, true, true])
    expect(await value("let i = 0; for (; i < 3; i++) {} return i")).toBe(3)
    for (const code of ["enum Color { Red }", "namespace N {}", "const x = <number>1"]) expect((await run(code)).ok).toBe(false)
    expect(await failure("enum Color { Red }")).toMatchObject({ kind: "UnsupportedSyntax" })
  })
})

describe("destructuring and functions", () => {
  test("defaults, rest, nesting, swaps, parameters and loop patterns", async () => {
    expect(await value(`
      const { a, b: { c = 5, ...others }, ...rest } = { a: 1, b: { d: 2, e: 3 }, x: 9, y: 8 }
      let [p, q = 7, ...tail] = [1, undefined, 3, 4]
      ;[p, q] = [q, p]
      const spread = ({ x, y = 2 }, [z, ...w] = [0]) => [x, y, z, w]
      const out = []
      for (const [k, v] of Object.entries({ m: 1, n: 2 })) out.push(k + v)
      const holes = [, 2, , 4]
      const [, second] = holes
      return { a, c, others, rest, p, q, tail, spread: spread({ x: 1 }, [5, 6, 7]), out, second }
    `)).toEqual({ a: 1, c: 5, others: { d: 2, e: 3 }, rest: { x: 9, y: 8 }, p: 7, q: 1, tail: [3, 4], spread: [1, 2, 5, [6, 7]], out: ["m1", "n2"], second: 2 })
    expect(await failure("const [a] = null")).toMatchObject({ kind: "InvalidDataValue" })
    expect(await failure("const { a } = null")).toMatchObject({ kind: "ExecutionFailure" })
  })

  test("hoisting, closures per iteration, defaults, rest parameters, recursion and var scoping", async () => {
    expect(await value(`
      const first = total(4)
      function total(n) { return n < 1 ? 0 : n + total(n - 1) }
      const fns = []
      for (let i = 0; i < 3; i++) fns.push(() => i)
      const defaults = (a, b = a + 1, ...more) => [a, b, more]
      if (true) { var hoisted = "visible" }
      return { first, results: fns.map((fn) => fn()), d1: defaults(1), d2: defaults(1, 5, 6, 7), hoisted }
    `)).toEqual({ first: 10, results: [0, 1, 2], d1: [1, 2, []], d2: [1, 5, [6, 7]], hoisted: "visible" })
    expect(await failure("function f(n) { return f(n + 1) } return f(0)")).toMatchObject({ kind: "OperationLimitExceeded" })
    expect(await failure("function f(n) { return [1].map(() => f(n + 1)) } return f(0)")).toMatchObject({ kind: "OperationLimitExceeded" })
  })

  test("operators, switch, do-while, for-in, optional chains and logical assignment", async () => {
    expect(await value(`
      const o = { a: null, f: () => 1 }
      let a = null; a ??= 5
      let b = 0; b ||= 7
      let c = 1; c &&= 9
      const r = []
      switch (2) { case 1: r.push(1); case 2: r.push(2); case 3: r.push(3); break; default: r.push(4) }
      const keys = []
      for (const key in { x: 1, y: 2 }) keys.push(key)
      let n = 0
      do { n++ } while (n < 3)
      return { chain: [o.a?.b.c, o.f?.(), o.g?.(), o?.["a"]?.length], a, b, c, bits: [7 >>> 1, 5 & 3, ~1, 2 ** 3 ** 2, 1 << 4], r, keys, n, has: ["a" in o, "z" in o] }
    `)).toEqual({ chain: [null, 1, null, null], a: 5, b: 7, c: 9, bits: [3, 1, -2, 512, 16], r: [2, 3], keys: ["x", "y"], n: 3, has: [true, false] })
  })
})

describe("generators", () => {
  test("lazy sequences, early close runs finally, delegation, destructuring and async generators", async () => {
    expect(await value(`
      const log = []
      function* count(n) { let i = 0; try { while (i < n) yield i++ } finally { log.push("closed") } return "done" }
      const all = [...count(3)]
      for (const v of count(100)) { if (v === 2) break }
      const g = count(2)
      const steps = [g.next(), g.next(), g.next(), g.next()]
      function* delegating() { const result = yield* count(2); yield result }
      async function* gen() { yield 1; yield await Promise.resolve(2) }
      const got = []
      for await (const v of gen()) got.push(v)
      const [x, y] = count(5)
      const echoed = function* () { const received = yield "ready"; yield received }()
      echoed.next()
      return { all, log, steps, delegated: [...delegating()], got, x, y, echo: echoed.next("pong").value }
    `)).toEqual({
      all: [0, 1, 2], log: ["closed", "closed", "closed", "closed", "closed"],
      steps: [{ value: 0, done: false }, { value: 1, done: false }, { value: "done", done: true }, { value: null, done: true }],
      delegated: [0, 1, "done"], got: [1, 2], x: 0, y: 1, echo: "pong",
    })
  })

  test("generators are bounded: infinite spreads, runaway consumers and re-entrancy fail instead of hanging", async () => {
    expect(await failure("function* g() { while (true) yield 1 } return [...g()].length")).toMatchObject({ kind: "ValueLimitExceeded" })
    expect(await value("function* g() { while (true) yield 1 } let n = 0; for (const x of g()) { if (++n > 5) break } return n")).toBe(6)
    expect(await failure("return yield 1")).toMatchObject({ kind: "UnsupportedSyntax" })
    expect(await failure("let it; function* g() { it.next() } it = g(); it.next()")).toMatchObject({ message: expect.stringContaining("already running") })
  })
})

describe("promises", () => {
  test("then/catch/finally chains, new Promise, race, any, allSettled and many concurrent async functions", async () => {
    expect(await value(`
      const log = []
      const chained = await Promise.resolve(1).then((v) => v + 1).then((v) => { throw new Error("boom " + v) }).catch((e) => e.message).finally(() => log.push("finally"))
      const made = await new Promise((resolve) => resolve(5))
      const rejected = await new Promise((_, reject) => reject({ code: 7 })).catch((e) => e.code)
      const race = await Promise.race([Promise.resolve("first"), Promise.resolve("second")])
      const any = await Promise.any([Promise.reject(1), Promise.resolve(2)])
      const settled = await Promise.allSettled([Promise.resolve(1), Promise.reject(new TypeError("x"))])
      const many = await Promise.all(Array.from({ length: 200 }, async (_, i) => { await Promise.resolve(); return i * 2 }))
      return { chained, log, made, rejected, race, any, settled, many: many.length, last: many[199] }
    `)).toEqual({ chained: "boom 2", log: ["finally"], made: 5, rejected: 7, race: "first", any: 2, settled: [{ status: "fulfilled", value: 1 }, { status: "rejected", reason: { name: "TypeError", message: "x" } }], many: 200, last: 398 })
  })

  test("started host calls can be collected in arrays and awaited together, with the call budget still enforced", async () => {
    let active = 0, peak = 0
    const slow = { invoke: async (_: string, args: unknown) => { active++; peak = Math.max(peak, active); await Bun.sleep(5); active--; return args } }
    expect(await run("const pending = []; for (let i = 0; i < 4; i++) pending.push(tools.echo({ i })); return (await Promise.all(pending)).map(({ i }) => i)", slow)).toMatchObject({ ok: true, value: [0, 1, 2, 3] })
    expect(peak).toBe(4)
    expect(await run("const pending = Array.from({ length: 20 }, (_, i) => tools.echo({ i })); return (await Promise.all(pending)).length", slow)).toMatchObject({ ok: false, error: { kind: "ToolCallLimitExceeded" } })
    expect(active).toBe(0)
    expect(await run("return await Promise.race([])")).toMatchObject({ ok: false })
  })
})

describe("template literals", () => {
  test("substitutions, nesting, escapes and multi-line text; tagged templates are unsupported", async () => {
    expect(await value("const n = 3; const o = { a: [1, 2] }; return `n=${n} sum=${o.a[0] + o.a[1]} nested=${`in${n}`} esc=\\`x\\` brace=${'}'}\\n2`")).toBe("n=3 sum=3 nested=in3 esc=`x` brace=}\n2")
    expect(await value("return `a\nb`")).toBe("a\nb")
    expect(await failure("const tag = (s) => s; return tag`x`")).toBeDefined()
    expect(await failure("return `${}`")).toMatchObject({ kind: "ParseError" })
    expect(await failure("return " + "`${".repeat(20) + "1" + "}`".repeat(20))).toMatchObject({ kind: "ParseError" })
  })
})

describe("standard library", () => {
  test("Map, Set, Date, RegExp, URL, URLSearchParams and Error values", async () => {
    expect(await value(`
      const m = new Map([["a", 1], ["b", 2]]); m.set("c", 3)
      const s = new Set([1, 2, 2, 3])
      const d = new Date("2024-03-05T10:20:30.000Z")
      const text = "12-ab 34-cd"
      const re = /(\\d+)-(?<word>\\w+)/g
      const u = new URL("https://user@example.com:8080/a/b?x=1&y=2#h")
      u.searchParams.append("z", "3")
      const e = new RangeError("bad")
      return {
        map: [m.size, m.get("b"), [...m.keys()], [...m], Object.fromEntries(m), m.has("z"), m.delete("a"), m.size],
        set: [s.size, [...s], s.union(new Set([9])).size, s.has(2)],
        date: [d.toISOString(), d.getFullYear(), d.getUTCMonth(), d.getTime() + 1, new Date(d.getTime() + 1000) - d, new Date(0) < new Date(1), JSON.stringify({ d }), Date.UTC(2020, 1, 1)],
        regexp: [text.match(re), [...text.matchAll(re)].map((x) => x.groups.word), text.replace(re, "$2:$1"), text.replace(/\\d+/g, (x) => x * 2), /ab/.test(text), "a1b2c".split(/\\d/), re.source, re.flags],
        url: [u.hostname, u.port, u.pathname, u.searchParams.get("y"), u.href, new URLSearchParams({ a: "1", b: "x y" }).toString()],
        kinds: [m instanceof Map, s instanceof Set, d instanceof Date, re instanceof RegExp, [] instanceof Array, e instanceof Error, e instanceof RangeError, e instanceof TypeError],
        error: [e.name, e.message, String(e)],
        text: ["5".padStart(3, "0"), (3.14159).toFixed(2), "aXb".replaceAll("X", "$&$&"), "abc".at(-1), [3, 1, 2].toSorted((a, b) => b - a)],
        clone: structuredClone({ a: new Map([[1, { b: 2 }]]) }).a.get(1).b,
      }
    `)).toEqual({
      map: [3, 2, ["a", "b", "c"], [["a", 1], ["b", 2], ["c", 3]], { a: 1, b: 2, c: 3 }, false, true, 2],
      set: [3, [1, 2, 3], 4, true],
      date: ["2024-03-05T10:20:30.000Z", 2024, 2, 1709634030001, 1000, true, '{"d":"2024-03-05T10:20:30.000Z"}', 1580515200000],
      regexp: [["12-ab", "34-cd"], ["ab", "cd"], "ab:12 cd:34", "24-ab 68-cd", true, ["a", "b", "c"], "(\\d+)-(?<word>\\w+)", "g"],
      url: ["example.com", "8080", "/a/b", "2", "https://user@example.com:8080/a/b?x=1&y=2&z=3#h", "a=1&b=x+y"],
      kinds: [true, true, true, true, true, true, true, false],
      error: ["RangeError", "bad", "RangeError: bad"],
      text: ["005", "3.14", "aXXb", "c", [3, 2, 1]],
      clone: 2,
    })
  })

  test("built-in objects cannot cross the JSON boundary silently, are read-only and expose no host internals", async () => {
    expect(await failure("return new Map()")).toMatchObject({ kind: "InvalidDataValue" })
    expect(await failure("return { set: new Set([1]) }")).toMatchObject({ kind: "InvalidDataValue" })
    expect(await failure("return /x/")).toMatchObject({ kind: "InvalidDataValue" })
    expect(await failure("await tools.echo({ at: new Map() })")).toMatchObject({ kind: "InvalidDataValue" })
    expect(await value("return [new Date(0), new URL('http://a.b/c')]")).toEqual(["1970-01-01T00:00:00.000Z", "http://a.b/c"])
    expect(await failure("const u = new URL('http://a.b/'); u.pathname = '/x'")).toMatchObject({ kind: "InvalidDataValue" })
    for (const code of ["new Map().constructor", "new Date().__proto__", "new Set().get.constructor", "(() => 1).constructor('return process')()", "new URL('http://a.b').searchParams.constructor", "return process", "return new (class {})().constructor"]) expect((await run(code)).ok).toBe(false)
    expect(await value("const m = new Map(); return [typeof m.inner, typeof m.native, typeof m.url]")).toEqual(["undefined", "undefined", "undefined"])
    expect(await failure("function F() {} return new F()")).toMatchObject({ kind: "UnsupportedSyntax" })
    expect(await failure("new URL('not a url')")).toMatchObject({ kind: "InvalidDataValue" })
    expect(await failure("Map()")).toMatchObject({ message: expect.stringContaining("requires new") })
  })

  test("thrown values keep their identity through catch and surface as diagnostics when uncaught", async () => {
    expect(await value(`
      try { null.x } catch (e) { var read = e.message }
      try { throw new TypeError("bad") } catch (e) { var typed = [e.name, e.message, e instanceof TypeError, e instanceof RangeError] }
      try { throw { code: 7 } } catch (e) { var plain = e.code }
      try { JSON.parse("{") } catch (e) { var syntax = e.name }
      return { read, typed, plain, syntax }
    `)).toEqual({ read: "Cannot read x of null", typed: ["TypeError", "bad", true, false], plain: 7, syntax: "SyntaxError" })
    expect(await failure("throw new RangeError('r')")).toMatchObject({ kind: "ExecutionFailure", message: "RangeError: r" })
  })
})

describe("sandbox guarantees for the larger language", () => {
  test("regular expressions with unbounded backtracking are rejected before they can block the daemon", async () => {
    for (const pattern of ["(a+)+$", "(a|aa)+$", "(a*)*b", "(\\w+)\\1", "(?:x+x+)+y"]) expect(await failure(`return new RegExp(${JSON.stringify(pattern)}).test("aaaa")`)).toMatchObject({ kind: "UnsafeRegExp" })
    expect(await failure('return /.*.*.*.*x/.test("a".repeat(500))')).toMatchObject({ kind: "ValueLimitExceeded" })
    expect(await failure('return /\\d+\\d+\\d+x/.test("1".repeat(300))')).toMatchObject({ kind: "ValueLimitExceeded" })
    expect(await failure('return /a.*b/.test("a".repeat(100000))')).toMatchObject({ kind: "ValueLimitExceeded" })
    expect(await failure("return new RegExp('a'.repeat(501))")).toMatchObject({ kind: "UnsafeRegExp" })
    expect(await failure("return new RegExp('(', 'g')")).toMatchObject({ kind: "InvalidDataValue" })
    expect(await failure("return new RegExp('a', 'gg')")).toMatchObject({ kind: "InvalidDataValue" })
    expect(await value('return /^\\s*(\\w+)\\s*=\\s*(.*)$/.exec("  key = some value")[2]')).toBe("some value")
    expect(await value('return "a,b;c".split(/[,;]/)')).toEqual(["a", "b", "c"])
  })

  test("parser, graph and size budgets bound hostile programs", async () => {
    expect(await failure("return " + "(a = ".repeat(40) + "1" + ")".repeat(40))).toBeDefined()
    expect(await failure("return " + "(".repeat(300) + "1" + ")".repeat(300))).toMatchObject({ kind: "ParseError" })
    expect(await failure("return " + "[".repeat(300) + "]".repeat(300))).toMatchObject({ kind: "ParseError" })
    expect(await failure("let d = [1]; for (let i = 0; i < 40; i++) d = [d, d]; return d")).toMatchObject({ kind: "InvalidDataValue" })
    expect(await failure("let d = [1]; for (let i = 0; i < 40; i++) d = [d, d]; return JSON.stringify(d)")).toMatchObject({ kind: "InvalidDataValue" })
    expect(await failure("let s = 'abcdefgh'; for (let i = 0; i < 30; i++) s = s + s; return s.length")).toMatchObject({ kind: "ValueLimitExceeded" })
    expect(await failure("return new Array(1e9)")).toMatchObject({ kind: "RangeError" })
    expect(await failure("return 'x'.repeat(1e9)")).toMatchObject({ kind: "ValueLimitExceeded" })
    expect(await failure("return 1n")).toMatchObject({ kind: "UnsupportedSyntax" })
    expect(await failure("const m = new Map(); for (let i = 0; i < 200000; i++) m.set(i, i)")).toBeDefined()
    expect(await failure("return NaN")).toMatchObject({ kind: "InvalidDataValue" })
  })

  test("limits can be tightened per caller and tools stay restricted to the names provided", async () => {
    const tight = await run("let n = 0; for (let i = 0; i < 1000; i++) n += i; return n", { limits: { maxOperations: 100 } })
    expect(tight).toMatchObject({ ok: false, error: { kind: "OperationLimitExceeded" } })
    expect(await run("await tools.echo({}); await tools.echo({}); return 1", { limits: { maxToolCalls: 1 } })).toMatchObject({ ok: false, error: { kind: "ToolCallLimitExceeded" } })
    expect(await run("return 'x'.repeat(5000)", { limits: { maxOutputBytes: 1024 } })).toMatchObject({ ok: true, truncated: true })
    expect(await run("return tools.other({})")).toMatchObject({ ok: false })
  })
})
