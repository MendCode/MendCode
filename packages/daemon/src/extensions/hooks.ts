import type { DaemonHookName, DaemonHooks } from "@mendcode/extension-api"
import { BREAKER_THRESHOLD, MAX_EXTENSION_ERRORS, type ExtensionLog, type ExtensionRecord } from "./types"
import { derivedReads } from "./shell-paths"

type Event<K extends DaemonHookName> = DaemonHooks[K]["event"]

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 500)

const MESSAGE_ROLES = new Set(["user", "assistant", "tool"])

/** The shape the engine's history uses; a `context` hook that returns anything else is refused as a whole. */
function isModelMessage(value: unknown): boolean {
  if (!isRecord(value) || typeof value.role !== "string" || !MESSAGE_ROLES.has(value.role)) return false
  if (value.role === "user") return typeof value.content === "string"
  if (value.role === "assistant") return typeof value.content === "string" && Array.isArray(value.toolCalls)
  return typeof value.callId === "string" && typeof value.name === "string" && typeof value.output === "string" && typeof value.isError === "boolean"
}

type Fold = (record: ExtensionRecord, value: unknown) => "stop" | "invalid" | void
const recordFields = (hook: string, value: unknown) => hook === "chat.headers" ? { headers: value } : hook === "shell.env" ? { env: value } : isRecord(value) ? value : {}

/**
 * Runs the handlers of several extensions in load order. Each handler is isolated: one that throws, rejects, returns
 * a value of the wrong shape or exceeds the timeout is skipped, recorded on its extension (first 20) and logged once
 * per extension; the rest still run and the caller never sees an exception.
 */
export function createHookBus({ timeoutMs, log, breakerThreshold = BREAKER_THRESHOLD }: { timeoutMs: number; log: ExtensionLog; breakerThreshold?: number }) {
  function fail(record: ExtensionRecord, label: string, message: string) {
    if (record.errors.length < MAX_EXTENSION_ERRORS) record.errors.push(`${label}: ${message}`)
    if (!record.logged) {
      record.logged = true
      log("warn", `[EXTENSIONS]: ${record.name}: ${label}: ${message} (further errors are listed in /extensions)`)
    }
  }

  /**
   * Circuit breaker: a handler (or command) that fails `breakerThreshold` times in a row is not called again this
   * session, so a broken extension stops costing a timeout on every tool call. It stops new calls only: a callback that
   * is already running cannot be cancelled. A success resets the count; a reload (new records) re-enables everything.
   * Host gates (approvals, plan mode, explicit denies) are not hooks and are never behind a breaker.
   */
  const open = (record: ExtensionRecord, key: string) => record.breaker.get(key)?.open === true
  function strike(record: ExtensionRecord, key: string, label: string) {
    const state = record.breaker.get(key) ?? { fails: 0, open: false }
    record.breaker.set(key, state)
    if (state.open) return
    state.fails++
    if (state.fails < breakerThreshold) return
    state.open = true
    const message = `${label}: stopped for this session after ${state.fails} failures in a row; /extensions reload turns it back on`
    if (record.errors.length < MAX_EXTENSION_ERRORS) record.errors.push(message)
    log("warn", `[EXTENSIONS]: ${record.name}: ${message}`)
  }
  const succeed = (record: ExtensionRecord, key: string) => {
    const state = record.breaker.get(key)
    if (state && !state.open) state.fails = 0
  }

  /** One call under the timeout; the handler keeps running after a timeout (it cannot be stopped) but its answer is ignored. */
  async function guarded<T>(record: ExtensionRecord, label: string, call: () => T | Promise<T>, key?: string): Promise<{ ok: true; value: T } | { ok: false }> {
    if (key !== undefined && open(record, key)) return { ok: false }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      // A handler waiting on the user (`api.ui`, itself bounded) is given that time on top of the limit, and the limit again after it.
      const timeout = new Promise<never>((_, reject) => {
        const arm = (ms: number) => {
          timer = setTimeout(() => {
            if ((record.waiting ?? 0) > 0) return arm(250)
            const since = record.waitEnded === undefined ? Infinity : Date.now() - record.waitEnded
            if (since < timeoutMs) return arm(timeoutMs - since)
            reject(new Error(`timed out after ${timeoutMs} ms`))
          }, ms)
        }
        arm(timeoutMs)
      })
      const value = await Promise.race([Promise.resolve().then(call), timeout])
      return { ok: true, value }
    } catch (error) {
      fail(record, label, label.startsWith("auth.") || label === "chat.headers" ? "plugin auth failed" : messageOf(error))
      if (key !== undefined) strike(record, key, label)
      return { ok: false }
    } finally {
      clearTimeout(timer)
    }
  }

  /** Calls every handler of `hook` in order with a fresh event; `fold` takes each answer and may stop the chain. */
  async function each<K extends DaemonHookName>(records: readonly ExtensionRecord[], hook: K, event: () => Event<K>, fold: Fold) {
    for (const record of records) {
      if (record.disabled) continue
      const handlers = record.handlers.get(hook) ?? []
      for (const [index, handler] of handlers.entries()) {
        const key = `${hook}#${index}`
        if (open(record, key)) continue
        const answer = await guarded(record, hook, () => (handler as (event: Event<K>) => unknown)(event()), key)
        if (!answer.ok) continue
        if (answer.value === undefined || answer.value === null) {
          succeed(record, key)
          continue
        }
        const verdict = fold(record, answer.value)
        if (verdict === "invalid") {
          fail(record, hook, "returned a value of the wrong shape; ignored")
          strike(record, key, hook)
        } else succeed(record, key)
        if (verdict === "stop") return
      }
    }
  }

  return {
    /** Runs anything an extension provides (its `daemon()` setup, a command) under the same timeout and isolation as a hook; `label` names it in the error list. A `key` puts it behind the circuit breaker. */
    guard: <T>(record: ExtensionRecord, label: string, run: () => T | Promise<T>, key?: string) => guarded(record, label, run, key),
    /** Whether the breaker stopped `key` (`tool.before#0`, `/name`, `tool:name`) for this session. */
    stopped: open,
    /** Counts a failure the caller detected itself (a tool that threw) against `key`. */
    strike,
    succeed,

    /** Observer hooks (`session.start`, `turn.start`, `turn.end`, `compact.after`): every handler runs, answers are ignored. */
    async notify<K extends "session.start" | "turn.start" | "turn.end" | "compact.after" | "event">(records: readonly ExtensionRecord[], hook: K, event: Event<K>) {
      await each(records, hook, () => ({ ...event }), () => {})
    },
    async transform<K extends DaemonHookName, T>(records: readonly ExtensionRecord[], hook: K, event: Event<K>, initial: T, valid: (value: unknown) => boolean): Promise<T> {
      let current = initial
      await each(records, hook, () => ({ ...structuredClone(event), ...(typeof current === "string" ? hook === "compact.prompt" ? { prompt: current } : { text: current } : recordFields(hook, current)) }), (_record, value) => {
        if (!valid(value)) return "invalid"
        current = value as T
      })
      return current
    },

    /** `input`: rewrites chain (each handler sees the previous text); the first `handled` ends the chain. */
    async input(records: readonly ExtensionRecord[], event: Event<"input">): Promise<{ handled: true; notice?: string } | { handled: false; text: string }> {
      const state: { text: string; handled?: { notice?: string } } = { text: event.text }
      await each(records, "input", () => ({ ...event, text: state.text }), (_record, value) => {
        if (!isRecord(value)) return "invalid"
        if (value.handled === true) {
          state.handled = typeof value.notice === "string" && value.notice ? { notice: value.notice } : {}
          return "stop"
        }
        if (typeof value.text === "string") state.text = value.text
        else if (value.text !== undefined) return "invalid"
      })
      return state.handled ? { handled: true, ...state.handled } : { handled: false, text: state.text }
    },

    /** `tool.before`: `args` rewrites chain; the first `block` wins and ends the chain. */
    async toolBefore(records: readonly ExtensionRecord[], event: Event<"tool.before">): Promise<{ block?: string; args?: Record<string, unknown> } | undefined> {
      const state: { args: Record<string, unknown>; rewritten: boolean; block?: string } = { args: event.args, rewritten: false }
      await each(records, "tool.before", () => ({ ...event, args: state.args }), (_record, value) => {
        if (!isRecord(value)) return "invalid"
        if (typeof value.block === "string") {
          state.block = value.block
          return "stop"
        }
        if (isRecord(value.args)) {
          state.args = value.args
          state.rewritten = true
        } else if (value.args !== undefined) return "invalid"
      })
      if (state.block !== undefined) return { block: state.block }
      // What the call reads without being a `read` (a shell command's paths, grep's folder) is asked of the same rules as a read of each, so a
      // rule written for reads holds for every tool that reaches the file. Those answers only block: their `args` rewrite nothing.
      for (const file of derivedReads(event.tool, state.args, event.cwd)) {
        const read: Event<"tool.before"> = { ...event, tool: "read", args: { path: file }, via: { tool: event.tool, args: structuredClone(state.args) } }
        await each(records, "tool.before", () => structuredClone(read), (_record, value) => {
          if (!isRecord(value)) return "invalid"
          if (typeof value.block === "string") {
            state.block = value.block
            return "stop"
          }
          if (value.args !== undefined && !isRecord(value.args)) return "invalid"
        })
        if (state.block !== undefined) return { block: state.block }
      }
      return state.rewritten ? { args: state.args } : undefined
    },

    /** `tool.after`: `output` and `isError` rewrites chain. */
    async toolAfter(records: readonly ExtensionRecord[], event: Event<"tool.after">): Promise<{ output?: string; isError?: boolean; title?: string; meta?: Record<string, string | number | boolean> } | undefined> {
      const state = { output: event.output, isError: event.isError, changed: false }
      const extra: { title?: string; meta?: Record<string, string | number | boolean> } = {}
      await each(records, "tool.after", () => ({ ...event, output: state.output, isError: state.isError }), (_record, value) => {
        if (!isRecord(value)) return "invalid"
        if (value.output !== undefined && typeof value.output !== "string") return "invalid"
        if (value.isError !== undefined && typeof value.isError !== "boolean") return "invalid"
        if (value.title !== undefined && typeof value.title !== "string") return "invalid"
        if (value.meta !== undefined && (!isRecord(value.meta) || Object.values(value.meta).some((item) => !["string", "number", "boolean"].includes(typeof item)))) return "invalid"
        if (typeof value.output === "string") ((state.output = value.output), (state.changed = true))
        if (typeof value.isError === "boolean") ((state.isError = value.isError), (state.changed = true))
        if (typeof value.title === "string") { extra.title = value.title; state.changed = true }
        if (isRecord(value.meta)) { extra.meta = value.meta as Record<string, string | number | boolean>; state.changed = true }
      })
      return state.changed ? { output: state.output, isError: state.isError, ...extra } : undefined
    },

    /** `prompt.system`: a returned string, or `{ system }` like the other hooks' results, replaces the prompt and the next handler sees it. */
    async promptSystem(records: readonly ExtensionRecord[], event: Event<"prompt.system">): Promise<string | undefined> {
      const state = { system: event.system, changed: false }
      await each(records, "prompt.system", () => ({ ...event, system: state.system }), (_record, value) => {
        const system = typeof value === "string" ? value : isRecord(value) && typeof value.system === "string" ? value.system : undefined
        if (system === undefined) return "invalid"
        state.system = system
        state.changed = true
      })
      return state.changed ? state.system : undefined
    },

    /** `context`: a returned array of messages replaces them and the next handler sees it. */
    async context(records: readonly ExtensionRecord[], event: Event<"context">): Promise<Array<Record<string, unknown>> | undefined> {
      const state: { messages: ReadonlyArray<Record<string, unknown>>; changed: boolean } = { messages: event.messages, changed: false }
      await each(records, "context", () => ({ ...event, messages: state.messages }), (_record, value) => {
        if (!Array.isArray(value) || !value.every(isModelMessage)) return "invalid"
        state.messages = value as Array<Record<string, unknown>>
        state.changed = true
      })
      return state.changed ? [...state.messages] : undefined
    },

    /** `request.before`: a returned object replaces the request body and the next handler sees it. */
    async requestBefore(records: readonly ExtensionRecord[], event: Event<"request.before">): Promise<Record<string, unknown> | undefined> {
      const state = { body: event.body, changed: false }
      await each(records, "request.before", () => ({ ...event, body: state.body }), (_record, value) => {
        if (!isRecord(value)) return "invalid"
        state.body = value
        state.changed = true
      })
      return state.changed ? state.body : undefined
    },

    /** `compact.before`: the first handler that cancels or supplies a summary decides. */
    async compactBefore(records: readonly ExtensionRecord[], event: Event<"compact.before">): Promise<{ cancel?: true; summary?: string } | undefined> {
      const state: { verdict?: { cancel?: true; summary?: string } } = {}
      await each(records, "compact.before", () => ({ ...event }), (_record, value) => {
        if (!isRecord(value)) return "invalid"
        if (value.cancel === true) state.verdict = { cancel: true }
        else if (typeof value.summary === "string" && value.summary.trim()) state.verdict = { summary: value.summary }
        else return value.cancel === undefined && value.summary === undefined ? undefined : "invalid"
        return "stop"
      })
      return state.verdict
    },
  }
}

export type HookBus = ReturnType<typeof createHookBus>
