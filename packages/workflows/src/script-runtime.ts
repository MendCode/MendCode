/**
 * The evaluator of a workflow script body and the whole API a script sees. It is transport-agnostic: every effect is a
 * message to the daemon (`call` for something with an answer, `post` for a notification), so the same code runs in the
 * sandboxed host process and, for tests of the orchestration, in-process. It imports nothing: the host loads it alone.
 *
 * What a script can name: `meta`, `args`, `agent`, `parallel`, `pipeline`, `phase`, `check`, `ask`, `merge`, `memo`, `log`,
 * `sleep`, `setTimeout`/`clearTimeout` (journaled), a deterministic `Date`, a seeded `Math.random`, and the language's own
 * built-ins. Everything else that a JavaScript host normally offers is shadowed to `undefined`.
 */

export type CallReply = { ok: true; value?: unknown; at: number } | { ok: false; error: string; at: number }
export type RuntimeTransport = {
  call(message: Record<string, unknown>): Promise<CallReply>
  post(message: Record<string, unknown>): void
}

export type RuntimeInput = {
  body: string
  meta: unknown
  args: unknown
  /** Seeds `Math.random`; the same seed replays the same sequence. */
  seed: number
  /** The virtual clock's start (the run's start time); every reply moves it to that event's time. */
  now: number
  transport: RuntimeTransport
}

/** Names a script must not reach as variables. Parameters shadow them; the host also deletes the real ones. */
export const SHADOWED_GLOBALS = [
  "process", "Bun", "require", "module", "exports", "fetch", "WebSocket", "Worker", "XMLHttpRequest", "EventSource", "BroadcastChannel", "MessageChannel", "MessagePort",
  "Response", "Request", "Headers", "navigator", "performance", "crypto", "Function", "globalThis", "self", "global", "window", "setInterval", "setImmediate", "clearInterval",
  "clearImmediate", "queueMicrotask", "Atomics", "SharedArrayBuffer", "WebAssembly", "Intl", "console", "postMessage", "onmessage", "addEventListener", "removeEventListener",
  "dispatchEvent", "alert", "prompt", "confirm", "Buffer", "__dirname", "__filename", "FinalizationRegistry", "WeakRef",
] as const

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<unknown>

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key])
  }
  return value
}

/** Detaches a value from the script's objects (functions, getters, cycles are refused) before it crosses to the daemon. */
function plain(value: unknown, what: string): unknown {
  let text: string | undefined
  try {
    text = JSON.stringify(value)
  } catch {
    throw new TypeError(`${what} must be plain JSON (no cycles, functions or BigInt)`)
  }
  return text === undefined ? undefined : JSON.parse(text)
}

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export type AgentOptions = Record<string, unknown>

/** Runs a script body to completion. Resolves with its `return` value, or rejects with what it threw. */
export async function runScriptBody(input: RuntimeInput): Promise<unknown> {
  const { transport } = input
  let clock = input.now
  let nextId = 1
  let logCount = 0
  let currentPhase: string | undefined
  const RealDate = Date
  const RealMath = Math

  async function call(message: Record<string, unknown>): Promise<unknown> {
    const reply = await transport.call({ ...message, id: nextId++ })
    if (reply.at > clock) clock = reply.at
    if (!reply.ok) throw new Error(reply.error)
    return reply.value
  }

  class VirtualDate extends RealDate {
    constructor(...parts: unknown[]) {
      if (parts.length === 0) super(clock)
      else super(...(parts as [number]))
    }
    static override now() {
      return clock
    }
  }
  const random = mulberry32(input.seed)
  const VirtualMath = Object.create(null) as Record<string, unknown>
  for (const key of Object.getOwnPropertyNames(RealMath)) if (key !== "random") VirtualMath[key] = (RealMath as unknown as Record<string, unknown>)[key]
  VirtualMath.random = random
  Object.freeze(VirtualMath)

  const timers = new Map<number, boolean>()
  let timerId = 0
  const sleep = async (ms: number): Promise<void> => {
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) throw new RangeError("sleep(ms): ms must be a non-negative number")
    await call({ kind: "sleep", ms: Math.min(Math.floor(ms), 300_000) })
  }
  const virtualSetTimeout = (callback: (...rest: unknown[]) => void, ms?: number, ...rest: unknown[]): number => {
    if (typeof callback !== "function") throw new TypeError("setTimeout needs a function")
    const id = ++timerId
    timers.set(id, true)
    void sleep(ms ?? 0).then(() => {
      if (timers.get(id)) {
        timers.delete(id)
        callback(...rest)
      }
    })
    return id
  }
  const virtualClearTimeout = (id: number) => void timers.delete(id)

  const text = (parts: unknown[]) => parts.map((part) => (typeof part === "string" ? part : (() => { try { return JSON.stringify(part) ?? String(part) } catch { return String(part) } })())).join(" ")
  const log = (...parts: unknown[]) => {
    transport.post({ t: "log", n: logCount++, message: text(parts).slice(0, 200) })
  }

  const agent = async (prompt: unknown, options: AgentOptions = {}): Promise<unknown> => {
    if (typeof prompt !== "string" || !prompt.trim()) throw new TypeError("agent(prompt, opts): prompt must be a non-empty string")
    if (options === null || typeof options !== "object" || Array.isArray(options)) throw new TypeError("agent(prompt, opts): opts must be an object")
    const opts = plain(options, "agent options") as AgentOptions
    if (opts.phase === undefined && currentPhase !== undefined) opts.phase = currentPhase
    return call({ kind: "agent", prompt, opts })
  }
  const check = async (command: unknown, options: AgentOptions = {}): Promise<unknown> => {
    if (typeof command !== "string" || !command.trim()) throw new TypeError("check(command): command must be a non-empty string")
    const opts = plain(options, "check options") as AgentOptions
    if (opts.phase === undefined && currentPhase !== undefined) opts.phase = currentPhase
    return call({ kind: "check", command, opts })
  }
  const ask = async (question: unknown, options?: unknown): Promise<unknown> => {
    if (typeof question !== "string" || !question.trim()) throw new TypeError("ask(question, options): question must be a non-empty string")
    if (options !== undefined && (!Array.isArray(options) || options.some((entry) => typeof entry !== "string"))) throw new TypeError("ask(question, options): options must be an array of strings")
    return call({ kind: "ask", question, ...(options ? { options } : {}) })
  }
  /**
   * Brings worktree results together on a reviewed integration branch (the host runs git; nothing touches your checkout):
   * `strategy: "branch"` (default) stops there; `"apply"` asks you, and merges that branch into your checkout only if you approve.
   */
  const merge = async (results: unknown, options: { strategy?: string; message?: string } = {}): Promise<unknown> => {
    if (!Array.isArray(results) || !results.length) throw new TypeError("merge(results, opts): results must be a non-empty array of agent({ worktree: true, detail: true }) results")
    const opts = plain(options ?? {}, "merge options") as { strategy?: string; message?: string }
    const strategy = opts.strategy ?? "branch"
    if (strategy !== "branch" && strategy !== "apply") throw new TypeError('merge: strategy must be "branch" or "apply"')
    const picked = results.map((entry) => ({ taskId: (entry as { taskId?: unknown } | null)?.taskId, workspace: (entry as { workspace?: unknown } | null)?.workspace }))
    const prepared = (await call({ kind: "merge", step: "prepare", results: plain(picked, "merge results"), ...(opts.message !== undefined ? { message: opts.message } : {}) })) as { branch: string; files: number; insertions: number; deletions: number; merged: unknown[] }
    if (strategy === "branch") return { ...prepared, applied: false }
    const answer = await ask(`Merge ${prepared.branch} into your checkout? ${prepared.merged.length} worktree(s), ${prepared.files} file(s), +${prepared.insertions} -${prepared.deletions}`, ["merge", "keep the branch"])
    if (answer !== "merge") return { ...prepared, applied: false }
    return { ...prepared, ...((await call({ kind: "merge", step: "apply", branch: prepared.branch })) as object), applied: true }
  }
  const memo = async (key: unknown, fn: unknown): Promise<unknown> => {
    if (typeof key !== "string" || !key || key.length > 120) throw new TypeError("memo(key, fn): key must be a short string")
    if (typeof fn !== "function") throw new TypeError("memo(key, fn): fn must be a function")
    const got = (await call({ kind: "memo", step: "get", key })) as { hit: boolean; value?: unknown }
    if (got.hit) return got.value
    const value = await (fn as () => unknown)()
    await call({ kind: "memo", step: "set", key, value: plain(value, "memo value") })
    return value
  }
  const phase = (title: unknown): void => {
    if (typeof title !== "string" || !title.trim()) throw new TypeError("phase(title): title must be a non-empty string")
    currentPhase = title.slice(0, 80)
    transport.post({ t: "phase", title: currentPhase })
  }
  const parallel = async (thunks: unknown, options?: { settled?: boolean }): Promise<unknown[]> => {
    if (!Array.isArray(thunks)) throw new TypeError("parallel(thunks): thunks must be an array of functions")
    const start = (entry: unknown) => (typeof entry === "function" ? (entry as () => unknown)() : entry)
    if (options?.settled) return Promise.all(thunks.map((entry) => Promise.resolve().then(() => start(entry)).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }))))
    return Promise.all(thunks.map((entry) => Promise.resolve().then(() => start(entry))))
  }
  const pipeline = async (items: unknown, ...stages: unknown[]): Promise<unknown[]> => {
    if (!Array.isArray(items)) throw new TypeError("pipeline(items, ...stages): items must be an array")
    if (stages.some((stage) => typeof stage !== "function")) throw new TypeError("pipeline(items, ...stages): every stage must be a function")
    const out = await Promise.all(items.map(async (item, index) => {
      let value: unknown = item
      for (const stage of stages as Array<(value: unknown, index: number) => unknown>) {
        value = await stage(value, index)
        if (value === undefined) return undefined
      }
      return value
    }))
    return out.filter((value) => value !== undefined)
  }

  const names = [...SHADOWED_GLOBALS, "meta", "args", "agent", "check", "ask", "merge", "memo", "phase", "log", "sleep", "parallel", "pipeline", "setTimeout", "clearTimeout", "Date", "Math"]
  const empty = Object.freeze(Object.create(null))
  const values = [...SHADOWED_GLOBALS.map((name) => (name === "globalThis" || name === "self" || name === "global" || name === "window" ? empty : name === "console" ? Object.freeze({ log, info: log, warn: log, error: log, debug: log }) : undefined)), deepFreeze(plain(input.meta, "meta")), deepFreeze(plain(input.args ?? {}, "args")), agent, check, ask, merge, memo, phase, log, sleep, parallel, pipeline, virtualSetTimeout, virtualClearTimeout, VirtualDate, Object.freeze(VirtualMath)]
  const script = new AsyncFunction(...names, `"use strict";\n${input.body}`)
  return await script.call(empty, ...values)
}
