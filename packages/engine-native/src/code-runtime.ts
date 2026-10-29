import { CodeError, parseCode, type CodeNode } from "./code-parser"
import { compileRegExp } from "./code-regex"
import { CClass, Callable, CDate, CMap, CParams, CSet, CURL, Deferred, Flow, Gen, MAX_ITEMS, Native, Scope, Thrown, UNINITIALIZED, blocked, brands, data, describe, isError, isInstanceOf, isPlain, isRuntime, isWrapper, makeError, markError, object, privates, utf8, type Construction, type PrivateSlot } from "./code-values"
import { installGlobals, libraryMember } from "./code-library"

export const CODE_LIMITS = { maxCodeBytes: 32_768, maxToolCalls: 16, maxOutputBytes: 24_576, timeoutMs: 30_000, maxValueBytes: 1_048_576, maxOperations: 500_000, maxAllocatedBytes: 8_388_608 } as const
export type CodeLimits = { -readonly [K in keyof typeof CODE_LIMITS]: number }
export type CodeResult = {
  ok: boolean
  value?: unknown
  error?: { kind: string; message: string }
  logs?: string[]
  warnings?: Array<{ kind: string; message: string }>
  toolCalls: Array<{ name: string }>
  truncated?: boolean
}
type Invoke = (name: string, args: unknown, signal: AbortSignal) => Promise<unknown>
/** Marks an optional chain that hit null/undefined; the enclosing `chain` node turns it back into undefined. */
const SHORT = object()
const patternKinds = new Set(["id", "member", "arrayBinding", "objectBinding", "default", "rest", "hole"])
const ERROR_TYPES = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError"])
type Home = { cls: CClass; static: boolean }
type Reference = { get(): unknown; set(value: unknown): void | Promise<void>; remove?(): boolean }

export class Runtime {
  readonly logs: string[] = []
  readonly toolCalls: Array<{ name: string }> = []
  readonly pending = new Set<Promise<unknown>>()
  private operations = 0
  private allocated = 0
  private classes = 0
  private lastYield = performance.now()
  logBytes = 0
  truncated = false
  constructor(readonly signal: AbortSignal, readonly invoke: Invoke, readonly limits: CodeLimits = { ...CODE_LIMITS }) {}
  async tick() {
    this.signal.throwIfAborted()
    if (++this.operations > this.limits.maxOperations) throw new CodeError("OperationLimitExceeded", "Code operation budget exhausted")
    // Every path through the AST checkpoints; an empty synchronous loop still yields to cancellation/deadline.
    if (this.operations % 128 === 0 && performance.now() - this.lastYield >= 8) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      this.lastYield = performance.now()
      this.signal.throwIfAborted()
    }
  }
  budget<T>(value: T): T {
    const bytes = Buffer.byteLength(JSON.stringify(data(value, true, true)) ?? "null")
    this.allocated += bytes
    if (bytes > this.limits.maxValueBytes || this.allocated > this.limits.maxAllocatedBytes) throw new CodeError("ValueLimitExceeded", "Code data budget exhausted")
    return value
  }
  tracked(promise: Promise<unknown>) {
    this.pending.add(promise)
    void promise.finally(() => this.pending.delete(promise)).catch(() => {})
    return new Deferred(promise)
  }
  async settle(value: unknown): Promise<unknown> {
    while (value instanceof Deferred) value = await value.promise
    this.signal.throwIfAborted()
    return value
  }
  key(value: unknown) {
    if (typeof value !== "string" && typeof value !== "number") throw new CodeError("InvalidDataValue", "Property key must be a string or number")
    const key = String(value)
    if (blocked.has(key)) throw new CodeError("UnsupportedSyntax", `Blocked property: ${key}`)
    return key
  }
  text(value: unknown): string {
    if (isRuntime(value)) throw new CodeError("InvalidDataValue", "Cannot coerce a runtime reference")
    if (value instanceof CDate) return Number.isFinite(value.ms) ? new Date(value.ms).toISOString() : "Invalid Date"
    if (value instanceof CURL) return value.url.href
    if (value instanceof CParams) return value.inner.toString()
    if (value instanceof CMap) return "[object Map]"
    if (value instanceof CSet) return "[object Set]"
    if (isWrapper(value)) return `/${(value as { native: RegExp }).native.source}/${(value as { native: RegExp }).native.flags}`
    if (isError(value)) return describe(value)
    if (typeof value === "object" && value !== null) return JSON.stringify(data(value, true, true))
    return String(value)
  }
  number(value: unknown) {
    if (value instanceof CDate) return value.ms
    if (value !== null && value !== undefined && !["string", "number", "boolean"].includes(typeof value)) throw new CodeError("InvalidDataValue", "Expected a primitive number")
    return Number(value)
  }
  /** Console rendering: strings verbatim, plain data as JSON, wrappers summarized. */
  inspect(value: unknown, depth = 0): string {
    if (typeof value === "string") return depth ? JSON.stringify(value) : value
    if (value instanceof CClass) return `[class ${value.name || "(anonymous)"}]`
    if (value instanceof Callable) return "[Function]"
    if (value instanceof Deferred) return "Promise {}"
    if (value instanceof Gen) return "Generator {}"
    if (value instanceof CMap) return depth > 3 ? "Map {…}" : `Map(${value.inner.size}) {${[...value.inner].slice(0, 100).map(([k, v]) => `${this.inspect(k, depth + 1)} => ${this.inspect(v, depth + 1)}`).join(", ")}}`
    if (value instanceof CSet) return depth > 3 ? "Set {…}" : `Set(${value.inner.size}) {${[...value.inner].slice(0, 100).map((item) => this.inspect(item, depth + 1)).join(", ")}}`
    if (isWrapper(value) || isError(value)) return this.text(value)
    if (Array.isArray(value)) return depth > 3 ? "[…]" : `[${value.slice(0, 100).map((item) => this.inspect(item, depth + 1)).join(",")}]`
    if (value && typeof value === "object") {
      if (depth > 3) return "{…}"
      return `{${Object.entries(value).slice(0, 100).map(([key, item]) => `${JSON.stringify(key)}:${this.inspect(item, depth + 1)}`).join(",")}}`
    }
    return String(value)
  }
  globals(names: readonly string[], search?: (query: string, limit?: number) => unknown): Scope {
    const scope = new Scope(undefined, { depth: 0 }), tools = object()
    for (const name of names) {
      if (blocked.has(name)) continue
      tools[name] = new Callable(async (args) => {
        this.signal.throwIfAborted()
        if (this.toolCalls.length >= this.limits.maxToolCalls) throw new CodeError("ToolCallLimitExceeded", `Code tool-call budget exhausted (${this.limits.maxToolCalls})`)
        if (args.length !== 1) throw new CodeError("InvalidToolInput", "Tools take exactly one JSON input")
        const input = this.budget(data(args[0]))
        const retained = utf8(name, 256)
        this.toolCalls.push({ name: retained })
        this.truncated ||= retained !== name
        return this.tracked(this.invoke(name, input, this.signal).then((value) => this.budget(data(value, true))))
      })
    }
    scope.declare("tools", tools, true)
    installGlobals(this, scope, search)
    return scope
  }
  async call(callable: unknown, args: unknown[], depth: number) {
    if (!(callable instanceof Callable)) throw new CodeError("InvalidDataValue", "Expected a function")
    return callable.call(args, depth)
  }

  /** Lazy iteration over arrays, strings, Map, Set, URLSearchParams and generators. Breaking out closes a suspended generator. */
  async *iterate(value: unknown): AsyncGenerator<unknown> {
    let count = 0
    const check = () => { if (++count > MAX_ITEMS) throw new CodeError("ValueLimitExceeded", "Iteration exceeds budget") }
    if (Array.isArray(value)) { for (let index = 0; index < value.length; index++) { check(); yield value[index] } return }
    if (typeof value === "string") { for (const char of value) { check(); yield char } return }
    if (value instanceof CSet) { for (const item of [...value.inner]) { check(); yield item } return }
    if (value instanceof CMap) { for (const [key, item] of [...value.inner]) { check(); yield [key, item] } return }
    if (value instanceof CParams) { for (const pair of [...value.inner]) { check(); yield pair } return }
    if (value instanceof Gen) {
      try {
        while (true) {
          const step = await value.send("next")
          if (step.done) return
          check(); yield step.value
        }
      } finally { if (value.state === "suspended") await value.send("return").catch(() => {}) }
    }
    throw new CodeError("InvalidDataValue", "Value is not iterable")
  }
  async collect(value: unknown, count?: number): Promise<unknown[]> {
    if (Array.isArray(value) && count === undefined) return [...value]
    const items: unknown[] = []
    if (count === 0) return items
    for await (const item of this.iterate(value)) { items.push(item); if (count !== undefined && items.length >= count) break }
    return items
  }

  async member(value: unknown, key: string, depth = 0): Promise<unknown> {
    if (value === null || value === undefined) throw new CodeError("ExecutionFailure", `Cannot read ${key} of ${value}`)
    if (value instanceof CClass) return this.staticMember(value, key, value, depth)
    if (value instanceof Callable) return Object.hasOwn(value.members, key) ? value.members[key] : undefined
    if (isRuntime(value) || isWrapper(value) || Array.isArray(value) || typeof value !== "object") return libraryMember(this, value, key)
    if (Object.hasOwn(value, key)) return (value as Record<string, unknown>)[key]
    const cls = brands.get(value)
    return cls ? this.inherited(cls, key, value, depth) : undefined
  }
  /** Prototype-chain lookup for a class instance: methods, then getters (called with the instance as `this`). */
  private async inherited(cls: CClass, key: string, self: unknown, depth: number): Promise<unknown> {
    for (let current: CClass | Native | undefined = cls; current instanceof CClass; current = current.parent) {
      const method = current.methods.get(key)
      if (method) return method
      const getter = current.getters.get(key)
      if (getter) return getter.call([], depth, self)
      if (current.setters.has(key)) return undefined
    }
    return undefined
  }
  private async staticMember(cls: CClass, key: string, self: unknown, depth: number): Promise<unknown> {
    for (let current: CClass | Native | undefined = cls; current instanceof CClass; current = current.parent) {
      if (Object.hasOwn(current.members, key)) return current.members[key]
      const getter = current.staticGetters.get(key)
      if (getter) return getter.call([], depth, self)
      if (current.staticSetters.has(key)) return undefined
    }
    return key === "name" ? cls.name : undefined
  }
  /** True when `key` is reachable through the class chain of an instance (for `in`). */
  hasInherited(value: object, key: string) {
    for (let current: CClass | Native | undefined = brands.get(value); current instanceof CClass; current = current.parent) if (current.methods.has(key) || current.getters.has(key) || current.setters.has(key)) return true
    return false
  }
  private accessorFor(cls: CClass | undefined, key: string, isStatic: boolean): { setter?: Callable } | undefined {
    for (let current: CClass | Native | undefined = cls; current instanceof CClass; current = current.parent) {
      const setter = (isStatic ? current.staticSetters : current.setters).get(key)
      if (setter) return { setter }
      if ((isStatic ? current.staticGetters : current.getters).has(key)) return {}
      if (!isStatic && current.methods.has(key)) return undefined
    }
    return undefined
  }
  private thisValue(scope: Scope) {
    const binding = scope.find("this")
    if (!binding) return undefined
    if (binding.value === UNINITIALIZED) throw new CodeError("ReferenceError", "Must call super constructor in derived class before accessing 'this'")
    return binding.value
  }
  private async superMember(key: string, scope: Scope, depth: number) {
    const home = scope.find("%home")?.value as Home | undefined
    if (!home) throw new CodeError("SyntaxError", "'super' is only valid inside a class")
    const self = this.thisValue(scope), parent = home.cls.parent
    if (!(parent instanceof CClass)) return undefined
    return home.static ? this.staticMember(parent, key, self, depth) : this.inherited(parent, key, self, depth)
  }
  private privateKey(name: string, scope: Scope) {
    const home = scope.find("%home")?.value as Home | undefined
    if (!home) throw new CodeError("SyntaxError", `Private name ${name} is not defined here`)
    return `${home.cls.id}:${name}`
  }
  private privateSlot(receiver: unknown, name: string, scope: Scope): PrivateSlot {
    const slot = typeof receiver === "object" && receiver !== null ? privates.get(receiver)?.get(this.privateKey(name, scope)) : undefined
    if (!slot) throw new CodeError("TypeError", `Cannot access private member ${name} on an object that does not declare it`)
    return slot
  }
  private async privateReference(target: CodeNode, scope: Scope): Promise<Reference> {
    return this.privateReferenceOf(await this.eval(target.children[0]!, scope), String(target.children[1]!.value), scope)
  }
  private privateReferenceOf(receiver: unknown, name: string, scope: Scope): Reference {
    const slot = this.privateSlot(receiver, name, scope), depth = this.depthOf(scope)
    return {
      get: () => slot.get ? slot.get.call([], depth, receiver) : slot.value,
      set: async (value: unknown) => {
        if (slot.set) await slot.set.call([value], depth, receiver)
        else if (slot.method || slot.get) throw new CodeError("TypeError", `Private member ${name} is not writable`)
        else slot.value = this.budget(value)
      },
    }
  }
  private installPrivate(target: object, key: string, slot: PrivateSlot) {
    let table = privates.get(target)
    if (!table) privates.set(target, table = new Map())
    if (table.has(key)) throw new CodeError("TypeError", "Cannot initialize a private member twice")
    table.set(key, slot)
  }

  /** Binds a declaration, parameter or assignment pattern. */
  async bind(target: CodeNode, value: unknown, scope: Scope, mode: "const" | "let" | "var" | "assign", replace = false): Promise<void> {
    await this.tick()
    const [first, second] = target.children
    switch (target.kind) {
      case "id": {
        if (mode === "assign") return scope.set(String(target.value), value)
        if (mode === "var") { let home = scope; while (!home.frame && home.parent) home = home.parent; return home.declare(String(target.value), value, false, true) }
        return scope.declare(String(target.value), value, mode === "const", replace)
      }
      case "member": case "privateMember": if (mode === "assign") { await (await this.reference(target, scope)).set(value); return } break
      case "default": return this.bind(first!, value === undefined ? await this.eval(second!, scope) : value, scope, mode, replace)
      case "hole": return
      case "arrayBinding": {
        if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean" || value instanceof Callable || value instanceof Deferred) throw new CodeError("InvalidDataValue", "Expected an iterable for destructuring")
        const rest = target.children.at(-1)?.kind === "rest"
        const items = await this.collect(value, rest ? undefined : target.children.length)
        for (const [index, child] of target.children.entries()) {
          if (child.kind === "rest") await this.bind(child.children[0]!, items.slice(index), scope, mode, replace)
          else await this.bind(child, items[index], scope, mode, replace)
        }
        return
      }
      case "objectBinding": {
        if (value === null || value === undefined) throw new CodeError("ExecutionFailure", `Cannot destructure ${value}`)
        const used = new Set<string>()
        for (const entry of target.children) {
          if (entry.kind === "rest") {
            if (!isPlain(value) || Array.isArray(value)) throw new CodeError("InvalidDataValue", "Object rest needs a plain object")
            const rest = object()
            for (const [key, item] of Object.entries(value)) if (!used.has(key)) rest[this.key(key)] = item
            await this.bind(entry.children[0]!, this.budget(rest), scope, mode, replace)
            continue
          }
          const key = this.key(entry.value as string | number)
          used.add(key)
          await this.bind(entry.children[0]!, await this.member(value, key), scope, mode, replace)
        }
        return
      }
    }
    throw new CodeError("UnsupportedSyntax", "Invalid binding")
  }
  async bindParams(params: CodeNode, args: unknown[], scope: Scope) {
    for (const [index, param] of params.children.entries()) {
      if (param.kind === "rest") await this.bind(param.children[0]!, args.slice(index), scope, "let")
      else await this.bind(param, args[index], scope, "let")
    }
  }

  async reference(target: CodeNode, scope: Scope): Promise<Reference> {
    if (target.kind === "id") return { get: () => scope.get(String(target.value)), set: (value: unknown) => scope.set(String(target.value), value) }
    if (target.kind === "privateMember") return this.privateReference(target, scope)
    if (target.kind !== "member" || target.children[0]!.kind === "super") throw new CodeError("UnsupportedSyntax", "Invalid assignment target")
    const receiver = await this.eval(target.children[0]!, scope), key = this.key(await this.eval(target.children[1]!, scope)), depth = this.depthOf(scope)
    if (receiver instanceof CClass) {
      const set = async (value: unknown) => {
        const accessor = this.accessorFor(receiver, key, true)
        if (accessor?.setter) return void await accessor.setter.call([value], depth, receiver)
        if (accessor) throw new CodeError("TypeError", `Cannot set static property ${key} which has only a getter`)
        receiver.members[key] = this.budget(value)
      }
      return { get: () => this.staticMember(receiver, key, receiver, depth), set }
    }
    if (!isPlain(receiver)) throw new CodeError("InvalidDataValue", isWrapper(receiver) ? "Built-in objects are read-only; build a new value instead" : "Expected data object")
    if (Array.isArray(receiver) && (!/^\d+$/.test(key) || Number(key) >= MAX_ITEMS)) throw new CodeError("ValueLimitExceeded", "Invalid array index")
    const record = receiver as Record<string, unknown>
    return {
      get: () => Object.hasOwn(record, key) ? record[key] : this.member(receiver, key, depth),
      set: async (value: unknown) => {
        if (value === receiver) throw new CodeError("InvalidDataValue", "Circular assignment")
        if (!Object.hasOwn(record, key)) {
          const accessor = this.accessorFor(brands.get(receiver), key, false)
          if (accessor?.setter) return void await accessor.setter.call([value], depth, receiver)
          if (accessor) throw new CodeError("TypeError", `Cannot set property ${key} which has only a getter`)
        }
        record[key] = this.budget(value)
      },
      remove: () => {
        if (Array.isArray(receiver)) throw new CodeError("InvalidDataValue", "delete is not supported on arrays; use splice")
        return delete record[key]
      },
    }
  }

  private async arguments(nodes: CodeNode[], scope: Scope) {
    const args: unknown[] = []
    for (const child of nodes) {
      if (child.kind === "spread") args.push(...await this.collect(await this.eval(child.children[0]!, scope)))
      else args.push(await this.eval(child, scope))
      if (args.length > MAX_ITEMS) throw new CodeError("ValueLimitExceeded", "Too many arguments")
    }
    return args
  }
  private depthOf(scope: Scope) { return scope.frameOf()?.depth ?? 0 }
  /** Resolves a call target together with its receiver, so methods see `this`. */
  private async callee(target: CodeNode, scope: Scope): Promise<{ callable: unknown; self: unknown } | typeof SHORT> {
    const [owner, property] = target.children
    if (target.kind === "member" && owner!.kind === "super") return { callable: await this.superMember(this.key(await this.eval(property!, scope)), scope, this.depthOf(scope)), self: this.thisValue(scope) }
    if (target.kind === "member" || target.kind === "optionalMember" || target.kind === "privateMember") {
      const receiver = await this.eval(owner!, scope)
      if (receiver === SHORT || target.kind === "optionalMember" && (receiver === undefined || receiver === null)) return SHORT
      const callable = target.kind === "privateMember" ? await this.privateReferenceOf(receiver, String(property!.value), scope).get() : await this.member(receiver, this.key(await this.eval(property!, scope)), this.depthOf(scope))
      return { callable, self: receiver }
    }
    const callable = await this.eval(target, scope)
    return callable === SHORT ? SHORT : { callable, self: undefined }
  }
  private async run(children: CodeNode[], local: Scope, program: boolean) {
    for (const child of children) if (child.kind === "declare" && child.value === "function") await this.eval(child, local)
    for (const [index, child] of children.entries()) {
      if (child.kind === "declare" && child.value === "function") continue
      const value = await this.eval(child, local)
      if (program && index === children.length - 1 && child.kind === "expression") return value
    }
    return undefined
  }
  /** Loop bodies: `break`/`continue` end or skip an iteration; `return` and errors propagate. Returns true when the loop should stop. */
  private async iteration(body: CodeNode, scope: Scope, labels: readonly string[]) {
    try { await this.eval(body, scope) } catch (flow) {
      if (!(flow instanceof Flow) || flow.kind === "return") throw flow
      // A labelled break/continue that names an outer statement keeps unwinding.
      if (flow.label !== undefined && !labels.includes(flow.label)) throw flow
      if (flow.kind === "break") return true
    }
    return false
  }

  /** Builds a confined function. `this` is the call receiver unless the function is an arrow; hooks serve constructors. */
  private makeFunction(ast: CodeNode, scope: Scope, hooks: { before?: (local: Scope, self: unknown) => void; after?: (local: Scope, self: unknown) => Promise<void> } = {}): Callable {
    const [params, body] = ast.children
    const isAsync = ast.kind.startsWith("async"), isGenerator = ast.kind.endsWith("enerator"), arrow = ast.value === "arrow"
    const run = async (args: unknown[], depth: number, self: unknown, gen?: Gen) => {
      const local = new Scope(scope, { depth, generator: gen })
      if (!arrow) local.declare("this", self, false, true)
      hooks.before?.(local, self)
      await this.bindParams(params!, args, local)
      await hooks.after?.(local, self)
      try { await this.eval(body!, local) } catch (flow) { if (flow instanceof Flow && flow.kind === "return") return flow.value; throw flow }
      return undefined
    }
    return new Callable(async (args, depth, self) => {
      if (depth >= 64) throw new CodeError("OperationLimitExceeded", "Function depth exceeds 64")
      if (isGenerator) return new Gen(isAsync, (gen) => run(args, depth + 1, self, gen))
      if (isAsync) return this.tracked(run(args, depth + 1, self).then((value) => this.settle(value)))
      return run(args, depth + 1, self)
    })
  }

  /** Evaluates a class definition: methods, accessors and constructor first, then static fields and blocks in source order. */
  private async defineClass(ast: CodeNode, scope: Scope): Promise<CClass> {
    const [heritage, ...members] = ast.children
    const title = String(ast.value ?? "")
    let parent: CClass | Native | undefined
    if (heritage!.kind !== "empty") {
      const base = await this.eval(heritage!, scope)
      if (base instanceof CClass) parent = base
      else if (base instanceof Native && base.construct && ERROR_TYPES.has(base.label)) parent = base
      else throw new CodeError("TypeError", "A class can only extend another class or an Error type")
    }
    const outer = new Scope(scope), cls = new CClass(title, parent, ++this.classes)
    if (title) outer.declare(title, cls, true)
    const instanceScope = new Scope(outer), staticScope = new Scope(outer)
    instanceScope.declare("%home", { cls, static: false } satisfies Home, true)
    staticScope.declare("%home", { cls, static: true } satisfies Home, true)
    cls.instanceScope = instanceScope; cls.staticScope = staticScope
    const initializers: Array<() => Promise<void>> = []
    const staticLocal = () => { const local = new Scope(staticScope, { depth: 0 }); local.declare("this", cls, false, true); return local }
    for (const member of members) {
      const [keyNode, valueNode, flagNode] = member.children
      const flags = String(flagNode!.value ?? ""), isStatic = flags.includes("s"), isPrivate = flags.includes("p")
      if (member.value === "block") { initializers.push(async () => { await this.eval(valueNode!, staticLocal()) }); continue }
      if (member.value === "ctor") {
        const derived = parent !== undefined
        cls.ctor = {
          properties: member.children[3]!.children.map((entry) => String(entry.value)),
          fn: this.makeFunction(valueNode!, instanceScope, {
            before: (local, self) => {
              const state = self as Construction
              state.scope = local
              local.declare("%construct", state, true, true)
              local.declare("this", derived ? UNINITIALIZED : state.instance, false, true)
            },
            after: async (local, self) => {
              if (derived) return
              const state = self as Construction
              await this.initFields(cls, state.instance, local.frameOf()?.depth ?? 0)
              this.assignProperties(cls, state.instance, local)
            },
          }),
        }
        continue
      }
      const key = isPrivate ? String(keyNode!.value) : this.key(await this.eval(keyNode!, outer))
      const composite = `${cls.id}:${key}`
      if (member.value === "field") {
        if (isStatic) initializers.push(async () => {
          const value = await this.eval(valueNode!, staticLocal())
          if (isPrivate) this.installPrivate(cls, composite, { value })
          else cls.members[key] = this.budget(value)
        })
        else cls.fields.push({ key, private: isPrivate, init: valueNode! })
        continue
      }
      const fn = this.makeFunction(valueNode!, isStatic ? staticScope : instanceScope)
      const kind = String(member.value)
      if (isPrivate) {
        const table = isStatic ? (privates.get(cls) ?? privates.set(cls, new Map()).get(cls)!) : cls.privateMethods
        const slot: PrivateSlot = table.get(composite) ?? { method: true }
        if (kind === "get") { slot.get = fn; delete slot.method } else if (kind === "set") { slot.set = fn; delete slot.method } else slot.value = fn
        table.set(composite, slot)
      } else if (kind === "get") (isStatic ? cls.staticGetters : cls.getters).set(key, fn)
      else if (kind === "set") (isStatic ? cls.staticSetters : cls.setters).set(key, fn)
      else if (isStatic) cls.members[key] = fn
      else cls.methods.set(key, fn)
    }
    for (const initialize of initializers) await initialize()
    return cls
  }
  private async initFields(cls: CClass, instance: Record<string, unknown>, depth: number) {
    for (const [composite, slot] of cls.privateMethods) this.installPrivate(instance, composite, slot)
    for (const field of cls.fields) {
      await this.tick()
      const local = new Scope(cls.instanceScope!, { depth })
      local.declare("this", instance, false, true)
      const value = await this.eval(field.init, local)
      if (field.private) this.installPrivate(instance, `${cls.id}:${field.key}`, { value })
      else instance[field.key] = this.budget(value)
    }
  }
  /** TypeScript parameter properties (`constructor(private x: number)`) become own fields. */
  private assignProperties(cls: CClass, instance: Record<string, unknown>, scope: Scope) {
    for (const name of cls.ctor?.properties ?? []) instance[this.key(name)] = this.budget(scope.get(name))
  }
  private async superConstruct(cls: CClass, args: unknown[], instance: Record<string, unknown>, depth: number) {
    const parent = cls.parent!
    if (parent instanceof CClass) return this.construct(parent, args, instance, depth)
    const made = await parent.construct!(args, depth)
    if (!isError(made)) throw new CodeError("TypeError", "Unsupported base class")
    for (const [key, value] of Object.entries(made)) instance[key] = value
    markError(instance)
  }
  private async construct(cls: CClass, args: unknown[], instance: Record<string, unknown>, depth: number) {
    const derived = cls.parent !== undefined
    if (cls.ctor) {
      const state: Construction = { cls, instance }
      await cls.ctor.fn.call(args, depth, state)
      if (derived && state.scope?.get("this") === UNINITIALIZED) throw new CodeError("ReferenceError", "Must call super constructor in derived class before returning from derived constructor")
      return
    }
    if (depth >= 64) throw new CodeError("OperationLimitExceeded", "Function depth exceeds 64")
    if (derived) await this.superConstruct(cls, args, instance, depth + 1)
    await this.initFields(cls, instance, depth + 1)
  }
  caught(error: unknown) {
    if (error instanceof Thrown) return error.value
    const name = error instanceof CodeError ? error.kind : error instanceof SyntaxError ? "SyntaxError" : error instanceof RangeError ? "RangeError" : error instanceof TypeError ? "TypeError" : "Error"
    return makeError(name, error instanceof Error ? error.message : String(error))
  }
  private async delegate(gen: Gen, target: unknown) {
    if (target instanceof Gen) {
      let step = await target.send("next")
      while (!step.done) {
        const message = await gen.suspend(step.value)
        if (message.kind === "return") { await target.send("return", message.value); throw new Flow("return", message.value) }
        step = await target.send(message.kind, message.value)
      }
      return step.value
    }
    for await (const item of this.iterate(target)) {
      const message = await gen.suspend(item)
      if (message.kind === "throw") throw new Thrown(message.value, describe(message.value))
      if (message.kind === "return") throw new Flow("return", message.value)
    }
    return undefined
  }

  /** `labels` are the labels directly attached to this statement; only loops use them. */
  async eval(ast: CodeNode, scope: Scope, labels: readonly string[] = []): Promise<unknown> {
    await this.tick()
    const [a, b, c, d] = ast.children
    switch (ast.kind) {
      case "empty": return undefined
      case "this": return this.thisValue(scope)
      case "super": throw new CodeError("SyntaxError", "'super' must be followed by a call or member access")
      case "class": return this.defineClass(ast, scope)
      case "label": {
        try { return await this.eval(a!, scope, [...labels, String(ast.value)]) } catch (flow) {
          if (flow instanceof Flow && flow.kind === "break" && flow.label === ast.value) return undefined
          throw flow
        }
      }
      case "superCall": {
        const state = scope.find("%construct")?.value as Construction | undefined
        if (!state || !state.cls.parent) throw new CodeError("SyntaxError", "'super()' is only valid in the constructor of a derived class")
        if (state.scope!.get("this") !== UNINITIALIZED) throw new CodeError("ReferenceError", "Super constructor may only be called once")
        const depth = this.depthOf(scope)
        await this.superConstruct(state.cls, await this.arguments(ast.children, scope), state.instance, depth)
        state.scope!.set("this", state.instance)
        await this.initFields(state.cls, state.instance, depth)
        this.assignProperties(state.cls, state.instance, state.scope!)
        return undefined
      }
      case "privateMember": {
        const receiver = await this.eval(a!, scope)
        return receiver === SHORT ? SHORT : this.privateReferenceOf(receiver, String(b!.value), scope).get()
      }
      case "literal": return ast.value
      case "id": return scope.get(String(ast.value))
      case "template": {
        let out = String(ast.children[0]!.value)
        for (let index = 1; index < ast.children.length; index += 2) {
          out += this.text(await this.eval(ast.children[index]!, scope)) + String(ast.children[index + 1]!.value)
          if (out.length > this.limits.maxValueBytes) throw new CodeError("ValueLimitExceeded", "String exceeds budget")
        }
        return this.budget(out)
      }
      case "regex": return compileRegExp(String(ast.value), String(a!.value))
      case "program": case "block": return this.run(ast.children, ast.kind === "block" ? new Scope(scope) : scope, ast.kind === "program")
      case "expression": return this.eval(a!, scope)
      case "sequence": { let value: unknown; for (const child of ast.children) value = await this.eval(child, scope); return value }
      case "declarations": for (const child of ast.children) await this.eval(child, scope); return undefined
      case "declare": await this.bind(a!, await this.eval(b!, scope), scope, ast.value === "const" ? "const" : ast.value === "var" ? "var" : "let", ast.value === "function"); return undefined
      case "return": throw new Flow("return", await this.eval(a!, scope))
      case "break": throw new Flow("break", undefined, ast.value === undefined ? undefined : String(ast.value))
      case "continue": throw new Flow("continue", undefined, ast.value === undefined ? undefined : String(ast.value))
      case "throw": { const value = await this.eval(a!, scope); throw new Thrown(value, describe(value)) }
      case "if": case "conditional": return this.eval(await this.eval(a!, scope) ? b! : c!, scope)
      case "while": {
        const local = new Scope(scope)
        while (await this.eval(a!, local)) if (await this.iteration(b!, local, labels)) break
        return undefined
      }
      case "doWhile": {
        do { if (await this.iteration(a!, scope, labels)) break } while (await this.eval(b!, scope))
        return undefined
      }
      case "for": {
        let local = new Scope(scope)
        await this.eval(a!, local)
        while (await this.eval(b!, local)) {
          if (await this.iteration(d!, local, labels)) break
          local = local.copy()
          await this.eval(c!, local)
        }
        return undefined
      }
      case "forOf": case "forIn": {
        const subject = await this.eval(b!, scope)
        const items: AsyncIterable<unknown> = ast.kind === "forOf" ? this.iterate(subject) : this.keysOf(subject)
        for await (let item of items) {
          await this.tick()
          if (ast.value === "await") item = await this.settle(item)
          const local = new Scope(scope)
          if (a!.kind === "declarations") { const entry = a!.children[0]!; await this.bind(entry.children[0]!, item, local, entry.value === "const" ? "const" : entry.value === "var" ? "var" : "let") } else await this.bind(a!, item, local, "assign")
          if (await this.iteration(c!, local, labels)) break
        }
        return undefined
      }
      case "switch": {
        const subject = await this.eval(a!, scope), local = new Scope(scope), cases = ast.children.slice(1)
        let start = -1
        for (const [index, entry] of cases.entries()) {
          const test = entry.children[0]!
          if (test.kind !== "default" && await this.eval(test, local) === subject) { start = index; break }
        }
        if (start < 0) start = cases.findIndex((entry) => entry.children[0]!.kind === "default")
        if (start < 0) return undefined
        try {
          for (const entry of cases.slice(start)) for (const statement of entry.children.slice(1)) await this.eval(statement, local)
        } catch (flow) { if (!(flow instanceof Flow) || flow.kind !== "break" || flow.label !== undefined) throw flow }
        return undefined
      }
      case "try": {
        try { return await this.eval(a!, scope) } catch (error) {
          this.signal.throwIfAborted()
          if (error instanceof Flow || c!.kind === "empty") throw error
          const local = new Scope(scope)
          if (b!.kind !== "empty") await this.bind(b!, this.caught(error), local, "let")
          return await this.eval(c!, local)
        } finally { await this.eval(d!, scope) }
      }
      case "function": case "asyncFunction": case "generator": case "asyncGenerator": return this.makeFunction(ast, scope)
      case "member": case "optionalMember": {
        if (a!.kind === "super") return this.superMember(this.key(await this.eval(b!, scope)), scope, this.depthOf(scope))
        const value = await this.eval(a!, scope)
        if (value === SHORT || ast.kind === "optionalMember" && (value === undefined || value === null)) return SHORT
        return this.member(value, this.key(await this.eval(b!, scope)), this.depthOf(scope))
      }
      case "chain": { const value = await this.eval(a!, scope); return value === SHORT ? undefined : value }
      case "array": {
        const result: unknown[] = []
        for (const child of ast.children) {
          if (child.kind === "spread") result.push(...await this.collect(await this.eval(child.children[0]!, scope)))
          else result.push(child.kind === "hole" ? undefined : await this.eval(child, scope))
          if (result.length > MAX_ITEMS) throw new CodeError("ValueLimitExceeded", "Array exceeds budget")
        }
        return result
      }
      case "object": {
        const result = object()
        let accessors: CClass | undefined
        for (const child of ast.children) {
          if (child.kind === "spread") {
            const source = await this.eval(child.children[0]!, scope)
            if (source === null || source === undefined) continue
            if (typeof source === "string") { [...source].forEach((char, index) => { result[String(index)] = char }); continue }
            if (!isPlain(source)) throw new CodeError("InvalidDataValue", "Object spread needs a plain object, array or string")
            for (const [key, item] of Object.entries(source)) result[this.key(key)] = item
            const literal = brands.get(source)
            if (literal?.literal) for (const [key, getter] of literal.getters) result[key] = await getter.call([], this.depthOf(scope), source)
          } else if (child.kind === "accessor") {
            const key = this.key(await this.eval(child.children[0]!, scope))
            accessors ??= new CClass("", undefined, ++this.classes, true)
            ;(child.value === "get" ? accessors.getters : accessors.setters).set(key, this.makeFunction(child.children[1]!, scope))
          } else if (child.kind === "computed") result[this.key(await this.eval(child.children[0]!, scope))] = await this.eval(child.children[1]!, scope)
          else result[this.key(child.value as string | number)] = await this.eval(child.children[0]!, scope)
        }
        if (accessors) brands.set(result, accessors)
        return result
      }
      case "call": case "optionalCall": {
        const target = await this.callee(a!, scope)
        if (target === SHORT) return SHORT
        const { callable, self } = target
        if (ast.kind === "optionalCall" && (callable === undefined || callable === null)) return SHORT
        if (!(callable instanceof Callable)) throw new CodeError("UnsupportedSyntax", "Only confined functions and registered tools can be called")
        return callable.call(await this.arguments(ast.children.slice(1), scope), this.depthOf(scope), self)
      }
      case "new": {
        const constructor = await this.eval(a!, scope)
        if (constructor instanceof CClass) {
          const instance = object()
          brands.set(instance, constructor)
          await this.construct(constructor, await this.arguments(ast.children.slice(1), scope), instance, this.depthOf(scope))
          return this.budget(instance)
        }
        if (!(constructor instanceof Native) || !constructor.construct) throw new CodeError("UnsupportedSyntax", "Only classes defined in the program and built-in constructors can be used with new")
        return constructor.construct(await this.arguments(ast.children.slice(1), scope), this.depthOf(scope))
      }
      case "unary": {
        if (ast.value === "typeof" && a!.kind === "id") { try { return this.typeOf(scope.get(String(a!.value))) } catch { return "undefined" } }
        if (ast.value === "delete") {
          const reference = await this.reference(a!, scope)
          return reference.remove ? reference.remove() : false
        }
        const value = await this.eval(a!, scope)
        switch (ast.value) {
          case "await": return this.settle(value)
          case "!": return !value
          case "typeof": return this.typeOf(value)
          case "void": return undefined
          case "~": return ~this.number(value)
          case "-": return -this.number(value)
          default: return this.number(value)
        }
      }
      case "update": case "preUpdate": {
        const reference = await this.reference(a!, scope), old = this.number(await reference.get()), next = old + (ast.value === "++" ? 1 : -1)
        await reference.set(next)
        return ast.kind === "update" ? old : next
      }
      case "assign": {
        if (patternKinds.has(a!.kind) && a!.kind !== "id" && a!.kind !== "member") { const value = await this.eval(b!, scope); await this.bind(a!, value, scope, "assign"); return value }
        const reference = await this.reference(a!, scope), op = String(ast.value)
        if (op === "=") { const value = await this.eval(b!, scope); await reference.set(value); return value }
        const old = await reference.get()
        if (op === "??=" || op === "||=" || op === "&&=") {
          const keep = op === "??=" ? old !== null && old !== undefined : op === "||=" ? !!old : !old
          if (keep) return old
          const value = await this.eval(b!, scope); await reference.set(value); return value
        }
        const value = this.binary(op.slice(0, -1), old, await this.eval(b!, scope))
        await reference.set(value)
        return value
      }
      case "binary": {
        const left = await this.eval(a!, scope)
        if (ast.value === "&&") return left ? this.eval(b!, scope) : left
        if (ast.value === "||") return left ? left : this.eval(b!, scope)
        if (ast.value === "??") return left === null || left === undefined ? this.eval(b!, scope) : left
        return this.binary(String(ast.value), left, await this.eval(b!, scope))
      }
      case "yield": {
        const gen = scope.frameOf()?.generator
        if (!gen) throw new CodeError("UnsupportedSyntax", "yield is only valid inside a generator function")
        if (ast.value === "*") return this.delegate(gen, await this.settle(await this.eval(a!, scope)))
        const message = await gen.suspend(await this.settle(await this.eval(a!, scope)))
        if (message.kind === "throw") throw new Thrown(message.value, describe(message.value))
        if (message.kind === "return") throw new Flow("return", message.value)
        return message.value
      }
      case "coverDefault": throw new CodeError("ParseError", "Invalid shorthand property initializer")
    }
    throw new CodeError("UnsupportedSyntax", `Unsupported syntax: ${ast.kind}`)
  }
  private async *keysOf(value: unknown): AsyncGenerator<unknown> {
    if (value === null || value === undefined) return
    if (typeof value === "string") { for (let index = 0; index < value.length; index++) yield String(index); return }
    if (!isPlain(value)) throw new CodeError("InvalidDataValue", "for…in needs a plain object, array or string")
    for (const key of Object.keys(value)) yield key
  }
  typeOf(value: unknown) { return value instanceof Callable ? "function" : typeof value }
  binary(op: string, left: unknown, right: unknown): unknown {
    switch (op) {
      case "===": return left === right
      case "!==": return left !== right
      case "==": case "!=": {
        let equal = left === right
        if (!equal) {
          if (left === null || left === undefined || right === null || right === undefined) equal = (left === null || left === undefined) && (right === null || right === undefined)
          else if (typeof left !== "object" && typeof right !== "object" && !(left instanceof Callable) && !(right instanceof Callable)) equal = this.number(left) === this.number(right)
        }
        return op === "==" ? equal : !equal
      }
      case "instanceof":
        if (right instanceof CClass) return isInstanceOf(left, right)
        if (!(right instanceof Native)) throw new CodeError("InvalidDataValue", "Right-hand side of instanceof must be a built-in constructor")
        return right.test(left)
      case "in": {
        const key = this.key(left)
        if (right instanceof CMap || right instanceof CSet || !isPlain(right)) throw new CodeError("InvalidDataValue", "`in` needs a plain object or array")
        return Object.hasOwn(right, key) || this.hasInherited(right, key)
      }
    }
    if (op === "+" && (typeof left === "string" || typeof right === "string")) return this.budget(this.text(left) + this.text(right))
    if (["<", ">", "<=", ">="].includes(op) && typeof left === "string" && typeof right === "string") return op === "<" ? left < right : op === ">" ? left > right : op === "<=" ? left <= right : left >= right
    const a = this.number(left), b = this.number(right)
    switch (op) {
      case "+": return a + b
      case "-": return a - b
      case "*": return a * b
      case "/": return a / b
      case "%": return a % b
      case "**": return a ** b
      case "<": return a < b
      case ">": return a > b
      case "<=": return a <= b
      case ">=": return a >= b
      case "&": return a & b
      case "|": return a | b
      case "^": return a ^ b
      case "<<": return a << b
      case ">>": return a >> b
      case ">>>": return a >>> b
    }
    throw new CodeError("UnsupportedSyntax", `Unsupported operator: ${op}`)
  }
}

export type CodeInput = { code: string; names: readonly string[]; invoke: Invoke; signal?: AbortSignal; timeoutMs?: number; limits?: Partial<CodeLimits>; search?: (query: string, limit?: number) => unknown }

/** Confined cooperative interpreter, with deadlines even for empty loops and cleanup of every admitted host call. */
export async function executeCode(input: CodeInput): Promise<CodeResult> {
  const limits: CodeLimits = { ...CODE_LIMITS, ...input.limits }
  const controller = new AbortController()
  const abort = () => controller.abort(new CodeError("Cancelled", "Code execution cancelled"))
  input.signal?.addEventListener("abort", abort, { once: true })
  if (input.signal?.aborted) abort()
  const timeoutMs = input.timeoutMs ?? limits.timeoutMs
  const timer = setTimeout(() => controller.abort(new CodeError("TimeoutExceeded", `Code execution timed out after ${timeoutMs}ms`)), timeoutMs)
  const runtime = new Runtime(controller.signal, input.invoke, limits)
  let result: CodeResult
  try {
    controller.signal.throwIfAborted()
    if (Buffer.byteLength(input.code) > limits.maxCodeBytes) throw new CodeError("ParseError", `Code exceeds ${limits.maxCodeBytes / 1024} KiB`)
    const ast = parseCode(input.code)
    let value: unknown
    try { value = await runtime.eval(ast, new Scope(runtime.globals(input.names, input.search), { depth: 0 })) } catch (flow) { if (flow instanceof Flow && flow.kind === "return") value = flow.value; else throw flow }
    value = await runtime.settle(value)
    result = { ok: true, value: data(value, true), toolCalls: runtime.toolCalls }
    if (runtime.pending.size) result.warnings = [{ kind: "Interrupted", message: "Unawaited work interrupted; await all started promises" }]
  } catch (error) {
    result = { ok: false, error: { kind: error instanceof CodeError ? error.kind : "ExecutionFailure", message: utf8(error instanceof Error ? error.message : String(error), 2000) }, toolCalls: runtime.toolCalls }
  } finally {
    clearTimeout(timer)
    input.signal?.removeEventListener("abort", abort)
    controller.abort(new CodeError("Cancelled", "Code execution ended"))
    await Promise.allSettled([...runtime.pending])
  }
  if (runtime.logs.length) result.logs = runtime.logs
  if (runtime.truncated) result.truncated = true
  // Result, logs and envelope share one UTF-8 budget, keeping the response valid JSON.
  while (Buffer.byteLength(JSON.stringify(result)) > limits.maxOutputBytes) {
    result.truncated = true
    if (result.logs?.length) { result.logs.pop(); continue }
    const text = typeof result.value === "string" ? result.value : JSON.stringify(result.value)
    result.value = utf8(text ?? "", Math.floor(limits.maxOutputBytes / 2))
    if (Buffer.byteLength(JSON.stringify(result)) > limits.maxOutputBytes) result.value = "[result truncated]"
  }
  return result
}
