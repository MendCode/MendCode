import type { z } from "zod"

/** How many lazy schemas have been built in this process (tests read it to prove what a code path touches). */
export const lazyStats = { built: 0 }

/**
 * A value computed the first time it is asked for, then the same value every time: for a module's shared field set
 * (`{ trigger: LoopTrigger.optional(), ... }`) that only lazy schemas spread. Written as a plain object it calls
 * `.optional()` at import, which builds every lazy schema it names (about 540 zod schemas when the protocol is imported).
 */
export function lazyValue<T>(build: () => T): () => T {
  let value: { current: T } | undefined
  return () => (value ??= { current: build() }).current
}

/**
 * Builds a zod schema the first time something touches it. The daemon validates with a few schemas out of ~900, and
 * building all of them at import costs about 45 MB of resident memory (docs/performance.md). The value returned forwards
 * every property access to the real schema, so it works wherever the schema does: `schema.parse`, `.extend`, as a field
 * of another object, `z.infer`. Building one schema builds only what its own definition touches; a schema nested in
 * another is built when that one is validated or composed, not before.
 *
 * Do not use it for a wrapper schema (`z.lazy`, `.optional()`, `.nullable()`, `.default()`, `.transform()` or `.pipe()` at
 * the root): zod's JSON Schema output looks wrappers up by identity, which a stand-in breaks. The protocol test that
 * converts every export to JSON Schema fails for one.
 */
export function lazySchema<T extends z.ZodType>(build: () => T): T {
  return new Proxy<Pending>({ build, real: undefined }, STAND_IN) as unknown as T
}

/** What a stand-in forwards to: its builder until first use, then the schema that built. */
type Pending = { build: (() => z.ZodType) | undefined; real: z.ZodType | undefined }

function realOf(pending: Pending) {
  if (!pending.real) {
    pending.real = pending.build!()
    pending.build = undefined
    lazyStats.built++
  }
  return pending.real
}

/** One handler for every stand-in (about 940 when the protocol is imported), not nine closures each. */
const STAND_IN: ProxyHandler<Pending> = {
  // The receiver stays the stand-in: zod binds `optional`, `array` and the like to `this`, and a schema they wrap must be this one, not the real.
  get: (pending, key, receiver) => Reflect.get(realOf(pending), key, receiver),
  has: (pending, key) => Reflect.has(realOf(pending), key),
  set: (pending, key, value) => Reflect.set(realOf(pending), key, value),
  ownKeys: (pending) => Reflect.ownKeys(realOf(pending)),
  getOwnPropertyDescriptor: (pending, key) => {
    const descriptor = Reflect.getOwnPropertyDescriptor(realOf(pending), key)
    return descriptor && { ...descriptor, configurable: true }
  },
  defineProperty: (pending, key, descriptor) => Reflect.defineProperty(realOf(pending), key, descriptor),
  deleteProperty: (pending, key) => Reflect.deleteProperty(realOf(pending), key),
  getPrototypeOf: (pending) => Reflect.getPrototypeOf(realOf(pending)),
}
