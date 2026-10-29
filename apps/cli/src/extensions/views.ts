import { VIEW_BUDGET_MS, VIEW_MAX_STRIKES, VIEW_SLOTS, type ViewSlot } from "@mendcode/extension-api/views"
import type { Line, Span } from "../ui/theme"
import { clip, fit } from "../view/deck"
import type { CustomResult, ViewCallOptions, ViewEnvValues, ViewHit } from "../view/views"
import { textWidth } from "../view/wrap"
import { themeSpan } from "./sanitize"

/**
 * The custom half of the view-slot contract (docs/views.md): registered views, their circuit breaker, time budget,
 * output validation and memo. Loaded with the extension runtime, never in a terminal without extensions.
 *
 * A view is ordinary extension code running in this process with the user's privileges; there is no sandbox. What the
 * registry guarantees is that its faults never reach a frame: a throw, a promise, malformed output or a call over the
 * budget counts as a strike and that frame uses the built-in; the third strike stops calling the view until it is reset
 * or reloaded. A call cannot be interrupted while it runs, so the budget bounds a view across frames, not within one.
 */

const MEMO_LIMIT = 256
/** A memoised "the view had no opinion": the built-in draws and the view is not asked again for the same input. */
const NONE = null

export type ViewEntry = {
  owner: string
  slot: ViewSlot
  render: (input: never) => unknown
  /** The old `api.view("slashMenu", ...)` registration. */
  legacy: boolean
  /** The breaker opened: the view is not called until it is reset or reloaded. */
  disabled: boolean
  strikes: number
  calls: number
  totalMs: number
  lastError?: string
  memo: Map<string, CustomResult | typeof NONE>
}

export type ViewStatus = { slot: ViewSlot; owner: string; legacy: boolean; tripped: boolean; strikes: number; calls: number; avgMs: number; lastError?: string }

export type ViewRegistryOptions = {
  /** One notice, raised when a breaker opens. */
  problem(owner: string, message: string): void
  /** A view was added, removed, tripped or reset: cached rows that used it are stale. */
  changed(): void
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 160)

function freeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) freeze(child)
  }
  return value
}

/** A result the caller may reorder or trim without touching what the memo holds. */
const copy = (result: CustomResult | typeof NONE): CustomResult | undefined => (result === NONE ? undefined : "lines" in result ? { lines: result.lines.slice(), hits: result.hits } : result)

/** FNV-1a over the string: a short memo key for an input that has no explicit key. */
function hash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(36)
}

/** One output row as theme spans plus the hit regions its spans name. Anything but spans is a bug in the view. */
function convertLine(slot: ViewSlot, raw: unknown, row: number, width: number, hits: ViewHit[] | undefined, validArg: ViewCallOptions["validArg"]): Line {
  if (!Array.isArray(raw)) throw new TypeError("a line must be an array of spans")
  const spans: Span[] = []
  let col = 0
  for (const item of raw) {
    const span = themeSpan(item)
    if (!span) throw new TypeError("a span must be an object")
    const { action, arg } = item as { action?: unknown; arg?: unknown }
    if (action !== undefined) {
      if (!hits) throw new TypeError(`${slot} spans cannot carry actions`)
      if (typeof action !== "string" || !VIEW_SLOTS[slot].actions.includes(action)) throw new TypeError(`unknown action ${JSON.stringify(action)} for ${slot} (allowed: ${VIEW_SLOTS[slot].actions.join(", ") || "none"})`)
      if (arg !== undefined && typeof arg !== "string" && typeof arg !== "number") throw new TypeError("arg must be a string or a number")
      if (!validArg(action, arg as string | number | undefined)) throw new RangeError(`${slot}: ${action} cannot target ${JSON.stringify(arg)}`)
      const cells = textWidth(span.text)
      if (cells > 0 && col < width) hits.push({ row, from: col, to: Math.min(width, col + cells), action, ...(arg !== undefined ? { arg: arg as string | number } : {}) })
    }
    col += textWidth(span.text)
    spans.push(span)
  }
  return spans
}

export function createViewRegistry(options: ViewRegistryOptions) {
  const entries: ViewEntry[] = []
  const top = (slot: ViewSlot) => entries.findLast((entry) => entry.slot === slot && !entry.disabled)

  function strike(entry: ViewEntry, reason: string) {
    entry.strikes++
    entry.lastError = reason
    if (entry.strikes < VIEW_MAX_STRIKES) return
    entry.disabled = true
    entry.memo.clear()
    options.problem(entry.owner, `view ${entry.slot} stopped after ${entry.strikes} faults (${reason}); the built-in is drawing again`)
    options.changed()
  }

  function lines(slot: ViewSlot, raw: unknown, env: ViewEnvValues, validArg: ViewCallOptions["validArg"]): { lines: Line[]; hits: ViewHit[] } {
    if (!Array.isArray(raw)) throw new TypeError(`expected lines or undefined, got ${typeof raw}`)
    const info = VIEW_SLOTS[slot]
    const cap = Math.max(0, Math.min(info.maxRows, env.height))
    const hits: ViewHit[] = []
    const out = raw.slice(0, cap).map((line, row) => {
      const spans = convertLine(slot, line, row, env.width, hits, validArg)
      return info.kind === "chrome" ? fit(spans, env.width) : clip(spans, env.width)
    })
    return { lines: out, hits }
  }

  /** `prompt.frame`: rows above and below the prompt and the cells around each prompt row. */
  function frame(raw: unknown, env: ViewEnvValues) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new TypeError("prompt.frame returns { top, bottom, left?, right? }")
    const source = raw as Record<string, unknown>
    const rows = (name: "top" | "bottom") => {
      const value = source[name]
      if (!Array.isArray(value)) throw new TypeError(`${name} must be an array of lines`)
      if (value.length > VIEW_SLOTS["prompt.frame"].maxRows) throw new RangeError(`${name} may have at most ${VIEW_SLOTS["prompt.frame"].maxRows} rows`)
      return value.map((line, row) => fit(convertLine("prompt.frame", line, row, env.width, undefined, () => false), env.width))
    }
    const side = (name: "left" | "right"): Line => {
      if (source[name] === undefined) return []
      const spans = convertLine("prompt.frame", source[name], 0, env.width, undefined, () => false)
      if (spans.reduce((sum, span) => sum + textWidth(span.text), 0) > Math.floor(env.width / 4)) throw new RangeError(`${name} may take at most a quarter of the width`)
      return spans
    }
    return { top: rows("top"), bottom: rows("bottom"), left: side("left"), right: side("right") }
  }

  function call(slot: ViewSlot, model: unknown, env: ViewEnvValues, opts: ViewCallOptions): CustomResult | undefined {
    const entry = top(slot)
    if (!entry) return undefined
    // Finished transcript items are remembered on their model alone (a view must not depend on time there); other slots on the clock too.
    const memoize = opts.memo !== "none"
    const memoKey = memoize ? `${opts.id ?? ""}|${env.width}x${env.height}|${env.ascii ? "a" : "u"}|${env.theme.name}|${hash(JSON.stringify(model))}${opts.memo === "static" ? "" : `|${env.now}`}` : ""
    if (memoize && entry.memo.has(memoKey)) {
      const kept = entry.memo.get(memoKey)!
      entry.memo.delete(memoKey)
      entry.memo.set(memoKey, kept)
      return copy(kept)
    }
    let input: unknown
    try {
      input = freeze(structuredClone({ ...(opts.prepare ? (opts.prepare(model as never) as object) : (model as object)), width: env.width, height: env.height, theme: env.theme, ascii: env.ascii, now: env.now }))
    } catch (error) {
      // The terminal could not build the view's input: not the view's fault, so no strike; the built-in draws.
      entry.lastError = `input not serialisable: ${message(error)}`
      return undefined
    }
    const started = performance.now()
    let raw: unknown
    try {
      raw = entry.render(input as never)
    } catch (error) {
      strike(entry, `threw: ${message(error)}`)
      return undefined
    }
    const elapsed = performance.now() - started
    if (raw && typeof (raw as { then?: unknown }).then === "function") {
      void Promise.resolve(raw).catch(() => {})
      strike(entry, "returned a promise (views are synchronous)")
      return undefined
    }
    entry.calls++
    entry.totalMs += elapsed
    // The first call of a view pays for compiling it; later ones must fit the budget.
    if (entry.calls > 1 && elapsed > VIEW_BUDGET_MS) {
      strike(entry, `over budget: ${elapsed.toFixed(1)} ms of ${VIEW_BUDGET_MS} ms`)
      return undefined
    }
    let result: CustomResult | typeof NONE
    try {
      result = raw === undefined ? NONE : slot === "prompt.frame" ? { frame: frame(raw, env) } : lines(slot, raw, env, opts.validArg)
    } catch (error) {
      strike(entry, `invalid output: ${message(error)}`)
      return undefined
    }
    if (memoize) {
      entry.memo.set(memoKey, result)
      if (entry.memo.size > MEMO_LIMIT) entry.memo.delete(entry.memo.keys().next().value!)
    }
    return copy(result)
  }

  return {
    register(owner: string, slot: ViewSlot, render: (input: never) => unknown, legacy = false) {
      entries.push({ owner, slot, render, legacy, disabled: false, strikes: 0, calls: 0, totalMs: 0, memo: new Map() })
      options.changed()
    },
    /** Whether a view that is not tripped answers for the slot. */
    has: (slot: ViewSlot) => top(slot) !== undefined,
    call,
    status(): ViewStatus[] {
      return entries.map((entry) => ({ slot: entry.slot, owner: entry.owner, legacy: entry.legacy, tripped: entry.disabled, strikes: entry.strikes, calls: entry.calls, avgMs: entry.calls ? entry.totalMs / entry.calls : 0, ...(entry.lastError ? { lastError: entry.lastError } : {}) }))
    },
    /** Clears a slot's strikes, last error and memo and closes its breaker. */
    reset(slot: ViewSlot) {
      for (const entry of entries) if (entry.slot === slot) Object.assign(entry, { disabled: false, strikes: 0, calls: 0, totalMs: 0, lastError: undefined, memo: new Map() })
      options.changed()
    },
    removeOwner(owner: string) {
      for (let index = entries.length - 1; index >= 0; index--) if (entries[index]!.owner === owner) entries.splice(index, 1)
    },
    clear() {
      entries.length = 0
    },
    get size() {
      return entries.length
    },
  }
}

export type ViewRegistry = ReturnType<typeof createViewRegistry>
