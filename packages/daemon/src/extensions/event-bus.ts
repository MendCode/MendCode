import type { ExtensionEvents } from "@mendcode/extension-api"
import type { HookBus } from "./hooks"
import type { ExtensionRecord } from "./types"

const EVENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
/** Emits one extension may make per window; the rest are dropped, so two extensions answering each other cannot spin forever. */
const EMIT_LIMIT = 500
const EMIT_WINDOW_MS = 10_000

/**
 * `api.events`: named messages between extensions in one daemon. A listener is registered during `daemon(api)` (like a hook); an
 * emit reaches, after the current call returns, every listener of that name in the extensions loaded beside the emitter (the user's
 * and those of the projects it serves), the emitter's own included. Each listener runs under the hook time limit and the circuit
 * breaker; a throw is recorded on the listener's extension, never on the emitter.
 */
export function createExtensionEvents(input: { bus: HookBus; peers(record: ExtensionRecord): readonly ExtensionRecord[]; fail(record: ExtensionRecord, message: string): void; now(): number }) {
  const windows = new WeakMap<ExtensionRecord, { since: number; count: number; told: boolean }>()
  function allowed(record: ExtensionRecord) {
    const now = input.now()
    const window = windows.get(record)
    if (!window || now - window.since >= EMIT_WINDOW_MS) { windows.set(record, { since: now, count: 1, told: false }); return true }
    if (window.count < EMIT_LIMIT) { window.count++; return true }
    if (!window.told) { window.told = true; input.fail(record, `events.emit: over ${EMIT_LIMIT} emits in ${EMIT_WINDOW_MS / 1000} s; the rest were dropped`) }
    return false
  }
  async function deliver(from: ExtensionRecord, name: string, data: unknown) {
    for (const record of input.peers(from)) {
      if (record.disabled) continue
      for (const [index, listener] of (record.listeners?.get(name) ?? []).entries()) {
        const key = `events:${name}#${index}`
        await input.bus.guard(record, `events:${name}`, () => listener(data, { from: from.name }), key).then((answer) => { if (answer.ok) input.bus.succeed(record, key) })
      }
    }
  }
  return {
    /** The `api.events` of one extension; `sealed` says whether setup ended (a listener registered after it is refused). */
    for(record: ExtensionRecord, sealed: () => boolean): ExtensionEvents {
      return {
        on(name, listener) {
          if (sealed()) { input.fail(record, `events.on("${String(name)}") after setup finished; register during daemon(api)`); return () => {} }
          if (typeof name !== "string" || !EVENT_NAME.test(name) || typeof listener !== "function") { input.fail(record, "events.on: a name of letters, digits, . _ : - (max 64) and a function"); return () => {} }
          const listeners = record.listeners ??= new Map()
          const list = listeners.get(name) ?? []
          list.push(listener)
          listeners.set(name, list)
          return () => {
            const current = listeners.get(name) ?? []
            const index = current.indexOf(listener)
            if (index >= 0) current.splice(index, 1)
          }
        },
        emit(name, data) {
          if (typeof name !== "string" || !EVENT_NAME.test(name)) return input.fail(record, "events.emit: a name of letters, digits, . _ : - (max 64)")
          if (record.disabled || !allowed(record)) return
          queueMicrotask(() => void deliver(record, name, data))
        },
      }
    },
  }
}
