import { describe, expect, test } from "bun:test"
import { executeCode } from "../src/code-runtime"

const run = (code: string, extra: Partial<Parameters<typeof executeCode>[0]> = {}) => executeCode({ code, names: ["echo"], invoke: async (_, args) => args, timeoutMs: 5000, ...extra })
const value = async (code: string) => {
  const result = await run(code)
  if (!result.ok) throw new Error(`${result.error?.kind}: ${result.error?.message}`)
  return result.value
}
const failure = async (code: string) => (await run(code)).error

describe("classes", () => {
  test("constructors, fields, methods and this", async () => {
    expect(await value(`
      class Counter {
        count = 0
        step: number
        constructor(step = 1) { this.step = step }
        inc() { this.count += this.step; return this }
        get double() { return this.count * 2 }
      }
      const c = new Counter(3)
      c.inc().inc()
      return { count: c.count, double: c.double, keys: Object.keys(c), json: JSON.stringify(c), is: c instanceof Counter }
    `)).toEqual({ count: 6, double: 12, keys: ["count", "step"], json: '{"count":6,"step":3}', is: true })
  })

  test("static members, static blocks, static getters and inherited statics", async () => {
    expect(await value(`
      class Base {
        static count = 0
        static #secret = 7
        static make() { Base.count++; return new this() }
        static get secret() { return Base.#secret }
        static { Base.count = 10 }
      }
      class Child extends Base { static label = "child" }
      const made = Child.make()
      return { count: Base.count, secret: Child.secret, label: Child.label, inherited: Child.count, kind: made instanceof Child, base: made instanceof Base, name: Child.name }
    `)).toEqual({ count: 11, secret: 7, label: "child", inherited: 11, kind: true, base: true, name: "Child" })
  })

  test("extends, super calls, super methods and field order", async () => {
    expect(await value(`
      const log: string[] = []
      class Animal {
        kind = (log.push("animal field"), "animal")
        constructor(public name: string) { log.push("animal ctor") }
        speak() { return this.name + " makes a sound" }
        get label() { return "A:" + this.name }
      }
      class Dog extends Animal {
        trick = (log.push("dog field"), "sit")
        constructor(name: string) { super(name); log.push("dog ctor") }
        speak() { return super.speak() + " (woof)" }
        get label() { return "D/" + super.label }
      }
      const d = new Dog("Rex")
      return { speak: d.speak(), label: d.label, log, own: Object.keys(d) }
    `)).toEqual({ speak: "Rex makes a sound (woof)", label: "D/A:Rex", log: ["animal field", "animal ctor", "dog field", "dog ctor"], own: ["kind", "name", "trick"] })
  })

  test("derived class without constructor forwards arguments; this before super is a ReferenceError", async () => {
    expect(await value("class A { constructor(a, b) { this.sum = a + b } } class B extends A {} return new B(2, 3).sum")).toBe(5)
    expect(await failure("class A {} class B extends A { constructor() { this.x = 1; super() } } new B()")).toMatchObject({ kind: "ReferenceError" })
    expect(await failure("class A {} class B extends A { constructor() {} } new B()")).toMatchObject({ kind: "ReferenceError" })
    expect(await failure("class A {} A()")).toMatchObject({ kind: "TypeError" })
  })

  test("extending Error keeps instanceof, name and message", async () => {
    expect(await value(`
      class HttpError extends Error {
        constructor(public status: number, message: string) { super(message); this.name = "HttpError" }
      }
      try { throw new HttpError(404, "missing") } catch (error) {
        return { is: error instanceof HttpError, err: error instanceof Error, name: error.name, message: error.message, status: error.status }
      }
    `)).toEqual({ is: true, err: true, name: "HttpError", message: "missing", status: 404 })
  })

  test("setters, getters-only and accessors on instances", async () => {
    expect(await value(`
      class Temp {
        #c = 0
        get f() { return this.#c * 9 / 5 + 32 }
        set f(v) { this.#c = (v - 32) * 5 / 9 }
        get c() { return this.#c }
      }
      const t = new Temp()
      t.f = 212
      t.f += 18
      return { c: t.c, f: Math.round(t.f), keys: Object.keys(t) }
    `)).toEqual({ c: 110, f: 230, keys: [] })
    expect(await failure("class T { get c() { return 1 } } const t = new T(); t.c = 2")).toMatchObject({ kind: "TypeError" })
  })

  test("private fields and methods are not reachable from outside", async () => {
    expect(await value(`
      class Vault {
        #items = []
        #count() { return this.#items.length }
        add(x) { this.#items.push(x); return this.#count() }
      }
      const v = new Vault()
      v.add(1)
      return { n: v.add(2), json: JSON.stringify(v), peek: v["#items"] === undefined }
    `)).toEqual({ n: 2, json: "{}", peek: true })
    expect(await failure("class A { #x = 1; static read(o) { return o.#x } } A.read({})")).toMatchObject({ kind: "TypeError" })
  })

  test("class expressions, computed names, async and generator methods, arrows capturing this", async () => {
    expect(await value(`
      const key = "dyn"
      const Box = class Inner {
        items = [1, 2, 3];
        [key]() { return "computed" }
        async load() { const r = await tools.echo({v: this.items.length}); return r.v }
        *each() { for (const i of this.items) yield i * 2 }
        mapped() { return this.items.map(i => i + this.items.length) }
        static create() { return new Inner() }
      }
      const b = Box.create()
      return { c: b.dyn(), load: await b.load(), each: [...b.each()], mapped: b.mapped() }
    `)).toEqual({ c: "computed", load: 3, each: [2, 4, 6], mapped: [4, 5, 6] })
  })

  test("TypeScript class syntax is erased: modifiers, overloads, index signatures, implements, abstract, generics", async () => {
    expect(await value(`
      interface Shape { area(): number }
      abstract class Base<T> implements Shape {
        [key: string]: any
        protected readonly tag?: string
        declare ghost: number
        abstract area(): number
        describe(): string { return "area=" + this.area() }
      }
      class Rect<T = number> extends Base<T> implements Shape {
        constructor(private readonly w: number, public h: number = 2) { super() }
        area(): number
        area(scale?: number): number { return this.w * this.h * (scale ?? 1) }
      }
      const r = new Rect(3)
      return { d: r.describe(), keys: Object.keys(r) }
    `)).toEqual({ d: "area=6", keys: ["w", "h"] })
  })

  test("instances cross the JSON boundary as plain data; classes and cycles do not", async () => {
    expect(await value("class P { constructor() { this.a = 1; this.nested = { b: [2] } } } return [new P(), {...new P()}]")).toEqual([{ a: 1, nested: { b: [2] } }, { a: 1, nested: { b: [2] } }])
    expect(await failure("class P {} return P")).toMatchObject({ kind: "InvalidDataValue" })
    expect(await failure("class N { constructor() { this.me = this } } return new N()")).toMatchObject({ kind: "InvalidDataValue" })
  })

  test("tools are callable from methods and the tool-call budget still applies", async () => {
    const result = await run("class R { async go(n) { for (let i = 0; i < n; i++) await tools.echo({ i }) } } await new R().go(20)")
    expect(result.ok).toBe(false)
    expect(result.error?.kind).toBe("ToolCallLimitExceeded")
    expect(result.toolCalls.length).toBe(16)
  })

  test("the step budget and function depth still stop runaway classes", async () => {
    const loop = await run("class A { spin() { while (true) {} } } new A().spin()", { limits: { maxOperations: 5000 } })
    expect(loop.error?.kind).toBe("OperationLimitExceeded")
    expect((await run("class A { f() { return this.f() } } new A().f()")).error?.kind).toBe("OperationLimitExceeded")
    expect((await run("class A { get x() { return this.x } } return new A().x")).error?.kind).toBe("OperationLimitExceeded")
    expect((await run("class A { constructor() { new A() } } new A()")).error?.kind).toBe("OperationLimitExceeded")
  })

  test("class bodies cannot reach host internals", async () => {
    expect(await failure("class A {} return new A().constructor")).toMatchObject({ kind: "UnsupportedSyntax" })
    expect(await failure("class A { m() { return this.__proto__ } } new A().m()")).toMatchObject({ kind: "UnsupportedSyntax" })
    expect(await failure("class A extends Map {}")).toMatchObject({ kind: "TypeError" })
    expect(await failure("class A extends null {}")).toMatchObject({ kind: "TypeError" })
  })

  test("object literal getters and setters, with this in methods", async () => {
    expect(await value(`
      let hits = 0
      const o = {
        base: 2,
        get double() { hits++; return this.base * 2 },
        set double(v) { this.base = v / 2 },
        scale(n) { return this.base * n },
      }
      o.double = 10
      return { double: o.double, scale: o.scale(3), has: "double" in o, hits, copy: { ...o }.double }
    `)).toEqual({ double: 10, scale: 15, has: true, hits: 1, copy: 10 })
    expect(await failure("return { get x() { return 1 } }")).toMatchObject({ kind: "InvalidDataValue" })
  })

  test("plain functions get undefined this; arrows keep the enclosing this", async () => {
    expect(await value("return typeof this")).toBe("undefined")
    expect(await value("const o = { v: 1, f() { return (() => this.v)() }, g: function () { return typeof this } }; return [o.f(), o.g()]")).toEqual([1, "object"])
    expect(await value("function f() { return typeof this } return f()")).toBe("undefined")
  })
})

describe("labels", () => {
  test("break and continue target outer loops", async () => {
    expect(await value(`
      const seen: string[] = []
      outer: for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
          if (j === 2) continue outer
          if (i === 2) break outer
          seen.push(i + ":" + j)
        }
      }
      return seen
    `)).toEqual(["0:0", "0:1", "1:0", "1:1"])
  })

  test("labels on while, do-while, for-of, for-in and nested labels", async () => {
    expect(await value(`
      let out = 0, n = 0
      a: b: while (true) { n++; do { out += n; if (n < 3) continue a; break b } while (true) }
      const items = [[1, 2], [3, 4], [5, 6]]
      let sum = 0
      rows: for (const row of items) { for (const v of row) { if (v === 4) continue rows; if (v === 5) break rows; sum += v } }
      let keys = ""
      k: for (const key in { x: 1, y: 2, z: 3 }) { for (const _ of [1]) { if (key === "y") continue k } keys += key }
      return { out, n, sum, keys }
    `)).toEqual({ out: 6, n: 3, sum: 6, keys: "xz" })
  })

  test("labelled blocks, switch inside loops and try/finally unwinding", async () => {
    expect(await value(`
      const log: string[] = []
      block: { log.push("a"); if (log.length) break block; log.push("never") }
      loop: for (const v of [1, 2, 3]) {
        switch (v) {
          case 2: continue loop
          case 3: break loop
        }
        try { log.push("v" + v); continue loop } finally { log.push("f" + v) }
      }
      return log
    `)).toEqual(["a", "v1", "f1"])
  })

  test("labelled loops are still bounded by the step budget", async () => {
    expect((await run("l: for (;;) { for (;;) { continue l } }", { limits: { maxOperations: 2000 } })).error?.kind).toBe("OperationLimitExceeded")
  })

  test("undefined, duplicate and cross-function labels are parse errors", async () => {
    expect(await failure("for (;;) { break nowhere }")).toMatchObject({ kind: "ParseError" })
    expect(await failure("a: a: for (;;) { break a }")).toMatchObject({ kind: "ParseError" })
    expect(await failure("a: for (;;) { const f = () => { break a }; f() }")).toMatchObject({ kind: "ParseError" })
  })

  test("object keys and conditionals are not mistaken for labels", async () => {
    expect(await value("const x = true ? 1 : 2; const o = { a: 1, b: x }; switch (x) { case 1: return o; default: return null }")).toEqual({ a: 1, b: 1 })
  })
})
