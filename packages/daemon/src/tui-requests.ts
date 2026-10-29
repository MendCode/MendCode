import type { CommandId, ErrorCode, TuiRequest, TuiRequestInput } from "@mendcode/protocol"

type OwnerKey = object | string
type Outcome = { ok: true; result: Record<string, unknown> } | { ok: false; code: ErrorCode; message: string }
type Pending = TuiRequest & { finish(value: Outcome): void }
type Owner = {
  key: OwnerKey
  push?: (request: TuiRequest) => void
  queue: Pending[]
  current?: Pending | undefined
  poll?: ((request: TuiRequest | null) => void) | undefined
  lease?: ReturnType<typeof setTimeout>
  active?: (() => boolean) | undefined
}
const bad = (code: ErrorCode, message: string): Outcome => ({ ok: false, code, message })

/** One opted-in terminal (or polling token) per project. Content never enters a durable/global event log. */
export function createTuiRequests(options: { deadlineMs?: number; leaseMs?: number } = {}) {
  const owners = new Map<string, Owner>()
  let stopped = false
  function remove(directory: string) {
    const owner = owners.get(directory)
    if (!owner) return
    owners.delete(directory)
    clearTimeout(owner.lease)
    owner.poll?.(null)
    owner.current?.finish(bad("busy", "TUI owner disconnected"))
    for (const entry of owner.queue) entry.finish(bad("busy", "TUI owner disconnected"))
  }
  function renew(directory: string, owner: Owner) {
    if (owner.push) return
    clearTimeout(owner.lease)
    owner.lease = setTimeout(() => remove(directory), options.leaseMs ?? 30_000)
    owner.lease.unref()
  }
  function deliver(owner: Owner) {
    if (owner.current || !owner.queue.length || !owner.push && !owner.poll) return
    const entry = owner.queue.shift()!
    owner.current = entry
    const request = { requestID: entry.requestID, request: entry.request }
    if (owner.push) owner.push(request)
    else owner.poll?.(request)
  }
  function sweep() { for (const [directory, owner] of owners) if (owner.active && !owner.active()) remove(directory) }
  return {
    register(directory: string, key: OwnerKey, enabled: boolean, push: (request: TuiRequest) => void): Outcome {
      if (stopped) return bad("busy", "TUI control stopped")
      sweep()
      const owner = owners.get(directory)
      if (owner && owner.key !== key) return bad("busy", "Project already has a TUI owner")
      if (!enabled) { remove(directory); return { ok: true, result: { enabled: false } } }
      if (!owner && owners.size >= 128) return bad("busy", "TUI owner limit reached")
      if (!owner) owners.set(directory, { key, push, queue: [] })
      return { ok: true, result: { enabled: true } }
    },
    send(directory: string, requestID: CommandId, request: TuiRequestInput, signal?: AbortSignal): Promise<Outcome> {
      sweep()
      const owner = owners.get(directory)
      if (stopped || !owner) return Promise.resolve(bad("busy", "No opted-in TUI owner for project"))
      if (owner.queue.length + (owner.current ? 1 : 0) >= 32) return Promise.resolve(bad("busy", "TUI request queue full"))
      return new Promise((resolve) => {
        let done = false
        const entry: Pending = { requestID, request, finish(value) {
          if (done) return
          done = true
          clearTimeout(timer)
          signal?.removeEventListener("abort", abort)
          owner.queue = owner.queue.filter((item) => item !== entry)
          if (owner.current === entry) owner.current = undefined
          resolve(value)
          if (owners.get(directory) === owner) deliver(owner)
        } }
        const abort = () => entry.finish(bad("busy", "TUI request cancelled"))
        const timer = setTimeout(() => entry.finish(bad("busy", "TUI response deadline exceeded")), options.deadlineMs ?? 15_000)
        timer.unref()
        if (signal?.aborted) return abort()
        signal?.addEventListener("abort", abort, { once: true })
        owner.queue.push(entry)
        deliver(owner)
      })
    },
    next(directory: string, key: OwnerKey, timeoutMs: number, signal?: AbortSignal, active?: () => boolean): Promise<Outcome> {
      if (stopped) return Promise.resolve(bad("busy", "TUI control stopped"))
      sweep()
      let owner = owners.get(directory)
      if (owner && (owner.key !== key || owner.push || owner.poll || owner.current)) return Promise.resolve(bad("busy", "TUI owner has a pending request or belongs to another client"))
      if (!owner && owners.size >= 128) return Promise.resolve(bad("busy", "TUI owner limit reached"))
      if (!owner) { owner = { key, queue: [] }; owners.set(directory, owner) }
      const selected = owner
      selected.active = active
      renew(directory, selected)
      return new Promise((resolve) => {
        const finish = (request: TuiRequest | null) => {
          if (selected.poll !== finish) return
          selected.poll = undefined
          clearTimeout(timer)
          signal?.removeEventListener("abort", abort)
          resolve({ ok: true, result: { request } })
        }
        const abort = () => remove(directory)
        const timer = setTimeout(() => finish(null), timeoutMs)
        timer.unref()
        selected.poll = finish
        if (signal?.aborted) return abort()
        signal?.addEventListener("abort", abort, { once: true })
        deliver(selected)
      })
    },
    respond(directory: string, key: OwnerKey, requestID: CommandId | undefined, response: boolean): Outcome {
      sweep()
      const owner = owners.get(directory)
      if (!owner || owner.key !== key) return bad("forbidden", "TUI response requires project ownership")
      const current = owner.current
      if (!current || requestID && requestID !== current.requestID) return bad("invalid_command", "No matching pending TUI request")
      renew(directory, owner)
      current.finish({ ok: true, result: { processed: response } })
      return { ok: true, result: { processed: true } }
    },
    forget(key: OwnerKey) { for (const [directory, owner] of owners) if (owner.key === key) remove(directory) },
    sweep,
    stop() { stopped = true; for (const directory of owners.keys()) remove(directory) },
  }
}
