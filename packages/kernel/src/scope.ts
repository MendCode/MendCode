import type { Clock, TimerHandle } from "./clock"

/**
 * Every long-lived resource (timer, subscription, process, stream, child session) is created
 * through a Scope and released when the Scope is disposed (P10). Disposal runs in reverse order,
 * is idempotent and never throws past the scope boundary.
 */
export interface Scope {
  readonly name: string
  readonly disposed: boolean
  timer(ms: number, callback: () => void): TimerHandle
  onDispose(release: () => void): () => void
  child(name: string): Scope
  dispose(): void
}

export type ResourceCounters = { scopes: number; timers: number; disposers: number }

export function createResourceRegistry() {
  const counters: ResourceCounters = { scopes: 0, timers: 0, disposers: 0 }
  const failures: Array<{ scope: string; error: unknown }> = []
  return {
    counters,
    failures,
    snapshot: (): ResourceCounters => ({ ...counters }),
  }
}
export type ResourceRegistry = ReturnType<typeof createResourceRegistry>

export function createScope(input: { name: string; clock: Clock; registry: ResourceRegistry; parent?: Scope }): Scope {
  const { name, clock, registry } = input
  const releases = new Set<() => void>()
  let disposed = false
  registry.counters.scopes++

  function register(release: () => void) {
    if (disposed) {
      release()
      return () => {}
    }
    let active = true
    registry.counters.disposers++
    const wrapped = () => {
      if (!active) return
      active = false
      releases.delete(wrapped)
      registry.counters.disposers--
      release()
    }
    releases.add(wrapped)
    return wrapped
  }

  const scope: Scope = {
    name,
    get disposed() {
      return disposed
    },
    timer(ms, callback) {
      if (disposed) throw new Error(`[SCOPE]: timer requested on disposed scope ${name}`)
      let fired = false
      registry.counters.timers++
      const handle = clock.setTimer(ms, () => {
        if (fired) return
        fired = true
        registry.counters.timers--
        release()
        callback()
      })
      const release = register(() => {
        if (!fired) {
          fired = true
          registry.counters.timers--
          handle.cancel()
        }
      })
      return { cancel: release }
    },
    onDispose(release) {
      return register(release)
    },
    child(childName) {
      const child = createScope({ name: `${name}/${childName}`, clock, registry, parent: scope })
      const detach = register(() => child.dispose())
      child.onDispose(() => detach())
      return child
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const release of [...releases].reverse()) {
        try {
          release()
        } catch (error) {
          registry.failures.push({ scope: name, error })
        }
      }
      releases.clear()
      registry.counters.scopes--
    },
  }
  return scope
}
