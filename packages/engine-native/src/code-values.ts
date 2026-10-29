import { CodeError, type CodeNode } from "./code-parser"

/** Runtime value types for Code Mode. Wrapper classes hold native data privately; programs only reach them through whitelisted methods. */
export const blocked = new Set(["__proto__", "constructor", "prototype", "caller", "callee", "arguments"])
export const object = () => Object.create(null) as Record<string, unknown>
export const MAX_ITEMS = 100_000
/** Truncates to a UTF-8 byte budget without splitting a character. */
export const utf8 = (text: string, bytes: number) => {
  const buffer = Buffer.from(text)
  let end = Math.min(buffer.length, bytes)
  while (end > 0 && end < buffer.length && (buffer[end]! & 0xc0) === 0x80) end--
  return buffer.subarray(0, end).toString()
}
const MAX_VISITS = 262_144

/** `self` is the receiver (`this`) of a method call; built-in callables ignore it. */
export class Callable {
  constructor(readonly call: (args: unknown[], depth: number, self?: unknown) => Promise<unknown>, readonly members: Record<string, unknown> = object()) {}
}
/** Marks `this` inside a derived constructor until `super()` returns. */
export const UNINITIALIZED = Symbol("uninitialized this")
export type FieldDefinition = { key: string; private: boolean; init: CodeNode }
export type Construction = { cls: CClass; instance: Record<string, unknown>; scope?: Scope }
/**
 * A confined class. Statics live in `members`; instances are plain records branded with their class in `brands`, so JSON output, spread
 * and Object.* see own fields only, exactly as for JavaScript instances. Accessors of an object literal use an anonymous `literal` class.
 */
export class CClass extends Callable {
  readonly methods = new Map<string, Callable>()
  readonly getters = new Map<string, Callable>()
  readonly setters = new Map<string, Callable>()
  readonly staticGetters = new Map<string, Callable>()
  readonly staticSetters = new Map<string, Callable>()
  readonly fields: FieldDefinition[] = []
  /** Private instance methods and accessors, keyed by name, installed on each instance before its fields. */
  readonly privateMethods = new Map<string, PrivateSlot>()
  constructor(readonly name: string, readonly parent: CClass | Native | undefined, readonly id: number, readonly literal = false) {
    super(async () => { throw new CodeError("TypeError", `Class constructor ${name} cannot be invoked without 'new'`) })
  }
  ctor: { fn: Callable; properties: string[] } | undefined
  /** Lexical scopes of the class body (with the hidden `%home` binding) used for field initializers and static blocks. */
  instanceScope: Scope | undefined
  staticScope: Scope | undefined
}
export type PrivateSlot = { value?: unknown; get?: Callable; set?: Callable; method?: boolean }
export const brands = new WeakMap<object, CClass>()
export const privates = new WeakMap<object, Map<string, PrivateSlot>>()
export const isInstanceOf = (value: unknown, cls: CClass) => {
  if (typeof value !== "object" || value === null) return false
  for (let current: CClass | Native | undefined = brands.get(value); current instanceof CClass; current = current.parent) if (current === cls) return true
  return false
}
/** Globals that can also be constructed with `new` and tested with `instanceof`. */
export class Native extends Callable {
  constructor(readonly label: string, call: Callable["call"], readonly construct: ((args: unknown[], depth: number) => Promise<unknown> | unknown) | undefined, readonly test: (value: unknown) => boolean, members: Record<string, unknown> = object()) { super(call, members) }
}
export class Deferred {
  constructor(readonly promise: Promise<unknown>) { void promise.catch(() => {}) }
}
export class Flow {
  constructor(readonly kind: "return" | "break" | "continue", readonly value?: unknown, readonly label?: string) {}
}
/** A value thrown by the program itself. */
export class Thrown extends CodeError {
  constructor(readonly value: unknown, message: string) { super("ExecutionFailure", message) }
}
export class CMap { readonly inner = new Map<unknown, unknown>() }
export class CSet { readonly inner = new Set<unknown>() }
export class CDate { constructor(public ms: number) {} }
export class CRegExp {
  constructor(readonly native: RegExp, readonly maxInput: number) {}
}
export class CParams { constructor(readonly inner: URLSearchParams) {} }
export class CURL { constructor(readonly url: URL, readonly params: CParams) {} }

type Step = { value: unknown; done: boolean }
type Message = { kind: "next" | "throw" | "return"; value: unknown }
/** Generator coroutine: the body runs only between `next` and the following `yield`, so a consumer and its generator never overlap. */
export class Gen {
  state: "start" | "suspended" | "running" | "done" = "start"
  readonly async: boolean
  private resume: ((message: Message) => void) | undefined
  private step: { resolve(step: Step): void; reject(error: unknown): void } | undefined
  constructor(async: boolean, private readonly body: (gen: Gen) => Promise<unknown>) { this.async = async }
  private wait() { return new Promise<Step>((resolve, reject) => { this.step = { resolve, reject } }) }
  async send(kind: Message["kind"], value?: unknown): Promise<Step> {
    if (this.state === "running") throw new CodeError("ExecutionFailure", "Generator is already running")
    if (this.state === "done" || this.state === "start" && kind !== "next") {
      this.state = "done"
      if (kind === "throw") throw new Thrown(value, describe(value))
      return { value: kind === "return" ? value : undefined, done: true }
    }
    const result = this.wait()
    if (this.state === "start") {
      this.state = "running"
      void this.body(this).then((returned) => { this.state = "done"; this.step!.resolve({ value: returned, done: true }) }, (error) => { this.state = "done"; this.step!.reject(error) })
    } else { this.state = "running"; this.resume!({ kind, value }) }
    return result
  }
  /** Called by the body: publish a value and wait for the consumer's next request. */
  suspend(value: unknown): Promise<Message> {
    return new Promise((resolve) => { this.state = "suspended"; this.resume = resolve; this.step!.resolve({ value, done: false }) })
  }
}

/** `depth` is the logical call depth of the function whose body is running; calls made from it start one level deeper. */
export type Frame = { depth: number; generator?: Gen | undefined }
export class Scope {
  private values = new Map<string, { value: unknown; constant: boolean }>()
  constructor(readonly parent?: Scope, readonly frame?: Frame) {}
  declare(name: string, value: unknown, constant = false, replace = false) {
    if (this.values.has(name) && !replace) throw new CodeError("ExecutionFailure", `Duplicate binding: ${name}`)
    this.values.set(name, { value, constant })
  }
  get(name: string): unknown {
    const binding = this.values.get(name)
    if (binding) return binding.value
    if (this.parent) return this.parent.get(name)
    throw new CodeError("UnsupportedSyntax", `Unknown global or binding: ${name}`)
  }
  set(name: string, value: unknown): void {
    const binding = this.values.get(name)
    if (!binding) { if (this.parent) return this.parent.set(name, value); throw new CodeError("ExecutionFailure", `Unknown binding: ${name}`) }
    if (binding.constant) throw new CodeError("ExecutionFailure", `Cannot assign const: ${name}`)
    binding.value = value
  }
  /** Fresh per-iteration copy of a loop scope, so closures keep the value they saw. */
  copy(): Scope {
    const next = new Scope(this.parent, this.frame)
    for (const [name, binding] of this.values) next.values.set(name, { ...binding })
    return next
  }
  /** Nearest binding without throwing, for hidden names such as `this`. */
  find(name: string): { value: unknown } | undefined {
    for (let scope: Scope | undefined = this; scope; scope = scope.parent) { const binding = scope.values.get(name); if (binding) return binding }
    return undefined
  }
  frameOf(): Frame | undefined {
    for (let scope: Scope | undefined = this; scope; scope = scope.parent) if (scope.frame) return scope.frame
    return undefined
  }
}

const errorBrand = new WeakSet<object>()
export function makeError(name: string, message: string) {
  const error = object()
  error.name = name; error.message = message
  errorBrand.add(error)
  return error
}
/** A class instance whose base class is an Error type is itself an error value. */
export const markError = (value: object) => { errorBrand.add(value) }
export const isError = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && errorBrand.has(value)
export const describe = (value: unknown) => isError(value) ? `${String(value.name)}: ${String(value.message)}` : typeof value === "string" ? value : typeof value === "object" && value !== null ? safeJson(value) : String(value)
function safeJson(value: unknown) { try { return JSON.stringify(data(value, true, true)) ?? "undefined" } catch { return "[object]" } }

export const isWrapper = (value: unknown) => value instanceof CMap || value instanceof CSet || value instanceof CDate || value instanceof CRegExp || value instanceof CURL || value instanceof CParams
export const isRuntime = (value: unknown) => value instanceof Callable || value instanceof Deferred || value instanceof Gen
/** Plain arrays and null-prototype/object-literal records: the only values whose properties programs may read or write directly. */
export const isPlain = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !isRuntime(value) && !isWrapper(value) && (Array.isArray(value) || Object.getPrototypeOf(value) === null || Object.getPrototypeOf(value) === Object.prototype)

/**
 * Copy plain data. `internal` mode is for size accounting of values that stay inside the program: wrappers and runtime references are
 * summarized instead of rejected. Boundary mode (tool input/output, return value, JSON) accepts JSON data plus Date and URL only.
 * Traversal is capped so aliased graphs cannot expand exponentially.
 */
export function data(value: unknown, nullify = false, internal = false): unknown {
  return copy(value, nullify, internal, new Set(), 0, { visits: 0 })
}
function copy(value: unknown, nullify: boolean, internal: boolean, seen: Set<object>, depth: number, context: { visits: number }): unknown {
  if (++context.visits > MAX_VISITS) throw new CodeError("ValueLimitExceeded", "Data traversal limit exceeded")
  if (depth > 32) throw new CodeError("InvalidDataValue", "Data exceeds 32 levels")
  if (value === undefined && nullify) return null
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && (internal || Number.isFinite(value))) return value
  if (typeof value === "number") throw new CodeError("InvalidDataValue", "Numbers must be finite to cross the JSON boundary")
  if (value instanceof CDate) return Number.isFinite(value.ms) ? new Date(value.ms).toISOString() : null
  if (value instanceof CURL) return value.url.href
  if (value instanceof CParams) return value.inner.toString()
  if (isRuntime(value)) {
    if (internal) return null
    throw new CodeError("InvalidDataValue", "Expected plain JSON data; await promises before returning")
  }
  if (value instanceof CRegExp) {
    if (internal) return `/${value.native.source}/${value.native.flags}`
    throw new CodeError("InvalidDataValue", "RegExp values cannot cross the JSON boundary; return a string")
  }
  if (typeof value !== "object" || value === null) throw new CodeError("InvalidDataValue", "Expected plain JSON data; await promises before returning")
  if (value instanceof CMap || value instanceof CSet) {
    if (!internal) throw new CodeError("InvalidDataValue", `${value instanceof CMap ? "Map" : "Set"} values cannot cross the JSON boundary; use ${value instanceof CMap ? "Object.fromEntries(map) or [...map]" : "[...set]"}`)
    if (seen.has(value)) throw new CodeError("InvalidDataValue", "Circular data")
    seen.add(value)
    try { return (value instanceof CMap ? [...value.inner] : [...value.inner]).map((item) => copy(item, nullify, internal, seen, depth + 1, context)) } finally { seen.delete(value) }
  }
  if (!isPlain(value)) throw new CodeError("InvalidDataValue", "Expected plain JSON data")
  if (seen.has(value)) throw new CodeError("InvalidDataValue", "Circular data")
  seen.add(value)
  try {
    if (!internal && brands.get(value)?.literal) throw new CodeError("InvalidDataValue", "Objects with getters or setters cannot cross the JSON boundary; copy their values into a plain object")
    if (Array.isArray(value)) return value.map((item) => copy(item, nullify, internal, seen, depth + 1, context))
    const result = object()
    for (const [key, item] of Object.entries(value)) {
      if (blocked.has(key)) throw new CodeError("InvalidDataValue", `Blocked property: ${key}`)
      result[key] = copy(item, nullify, internal, seen, depth + 1, context)
    }
    return result
  } finally { seen.delete(value) }
}
