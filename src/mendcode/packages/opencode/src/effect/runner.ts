import { Cause, Deferred, Effect, Exit, Fiber, Latch, Schema, Scope, SynchronizedRef } from "effect"
import * as Log from "@mendcode/core/util/log"

const trace = Log.create({ service: "runner" })

export interface Runner<A, E = never> {
  readonly state: State<A, E>
  readonly busy: boolean
  readonly ensureRunning: (
    work: Effect.Effect<A, E>,
    options?: EnsureRunningOptions,
  ) => Effect.Effect<A, E>
  readonly startShell: (work: Effect.Effect<A, E>, ready?: Latch.Latch) => Effect.Effect<A, E>
  readonly interruptCurrent: (options?: NonNullable<EnsureRunningOptions["interrupt"]>) => Effect.Effect<void>
  readonly interruptQueued: (options?: NonNullable<EnsureRunningOptions["interrupt"]>) => Effect.Effect<boolean>
  readonly cancelPending: (predicate: (key?: string) => boolean) => Effect.Effect<boolean>
  readonly setInterruptible: (interruptible: boolean) => Effect.Effect<void>
  readonly interrupt: Effect.Effect<void>
  readonly cancelCurrent: (options?: { before?: Effect.Effect<void>; cancelPending?: boolean }) => Effect.Effect<void>
  readonly cancel: Effect.Effect<void>
}

export interface EnsureRunningOptions {
  queue?: boolean
  queueKey?: string
  interrupt?: {
    before?: Effect.Effect<void>
    after?: Effect.Effect<void>
  }
}

export class Cancelled extends Schema.TaggedErrorClass<Cancelled>()("RunnerCancelled", {}) {}

interface RunHandle<A, E> {
  id: number
  done: Deferred.Deferred<A, E | Cancelled>
  fiber: Fiber.Fiber<A, E>
  key?: string
  interruptible: boolean
}

interface ShellHandle<A, E> {
  id: number
  cancelled: Deferred.Deferred<void>
  ready?: Latch.Latch
  fiber: Fiber.Fiber<A, E>
}

interface PendingHandle<A, E> {
  id: number
  done: Deferred.Deferred<A, E | Cancelled>
  work: Effect.Effect<A, E>
  key?: string
}

export type State<A, E> =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Running"; readonly run: RunHandle<A, E> }
  | { readonly _tag: "RunningThenRun"; readonly run: RunHandle<A, E>; readonly next: readonly PendingHandle<A, E>[] }
  | { readonly _tag: "Shell"; readonly shell: ShellHandle<A, E> }
  | { readonly _tag: "ShellThenRun"; readonly shell: ShellHandle<A, E>; readonly run: readonly PendingHandle<A, E>[] }

export const make = <A, E = never>(
  scope: Scope.Scope,
  opts?: {
    onIdle?: Effect.Effect<void>
    onBusy?: Effect.Effect<void>
    onInterrupt?: Effect.Effect<A, E>
    busy?: () => never
  },
): Runner<A, E> => {
  const ref = SynchronizedRef.makeUnsafe<State<A, E>>({ _tag: "Idle" })
  const idle = opts?.onIdle ?? Effect.void
  const busy = opts?.onBusy ?? Effect.void
  const onInterrupt = opts?.onInterrupt
  let ids = 0

  const state = () => SynchronizedRef.getUnsafe(ref)
  const next = () => {
    ids += 1
    return ids
  }

  const complete = (done: Deferred.Deferred<A, E | Cancelled>, exit: Exit.Exit<A, E>) =>
    Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
      ? Deferred.fail(done, new Cancelled()).pipe(Effect.asVoid)
      : Deferred.done(done, exit).pipe(Effect.asVoid)

  const awaitDone = (done: Deferred.Deferred<A, E | Cancelled>) =>
    Deferred.await(done).pipe(Effect.catchTag("RunnerCancelled", (e) => onInterrupt ?? Effect.die(e)))

  const idleIfCurrent = () =>
    SynchronizedRef.modify(ref, (st) => [st._tag === "Idle" ? idle : Effect.void, st] as const).pipe(Effect.flatten)

  const finishRun = (id: number, done: Deferred.Deferred<A, E | Cancelled>, exit: Exit.Exit<A, E>): Effect.Effect<void> =>
    SynchronizedRef.modifyEffect(
      ref,
      (st) => Effect.gen(function* () {
        trace.trace("finish", { id, state: st._tag, success: Exit.isSuccess(exit) })
        if (st._tag === "Running" && st.run.id === id) {
          return [
            Effect.gen(function* () {
              yield* idle
              yield* complete(done, exit)
            }),
            { _tag: "Idle" } as const,
          ] as const
        }
        if (st._tag === "RunningThenRun" && st.run.id === id) {
          const [next, ...remaining] = st.next
          if (!next) {
            return [
              Effect.gen(function* () {
                yield* idle
                yield* complete(done, exit)
              }),
              { _tag: "Idle" } as const,
            ] as const
          }
          const run = yield* startRun(next.work, next.done, next.key)
          return [
            complete(done, exit),
            remaining.length ? { _tag: "RunningThenRun", run, next: remaining } : { _tag: "Running", run },
          ] as const
        }
        return [complete(done, exit), st] as const
      }),
    ).pipe(Effect.flatten) as Effect.Effect<void>

  const startRun = (
    work: Effect.Effect<A, E>,
    done: Deferred.Deferred<A, E | Cancelled>,
    key?: string,
  ): Effect.Effect<RunHandle<A, E>> =>
    Effect.gen(function* () {
      const id = next()
      const fiber = yield* (Effect.yieldNow.pipe(Effect.andThen(work))).pipe(
        Effect.onExit((exit) => finishRun(id, done, exit)),
        Effect.forkIn(scope),
      )
      return { id, done, fiber, key, interruptible: true } satisfies RunHandle<A, E>
    }) as Effect.Effect<RunHandle<A, E>>

  const finishShell = (id: number): Effect.Effect<void> =>
    SynchronizedRef.modifyEffect(
      ref,
      (st) => Effect.gen(function* () {
        if (st._tag === "Shell" && st.shell.id === id) {
          return [idle, { _tag: "Idle" }] as const
        }
        if (st._tag === "ShellThenRun" && st.shell.id === id) {
          const [next, ...remaining] = st.run
          if (!next) return [idle, { _tag: "Idle" }] as const
          const run = yield* startRun(next.work, next.done, next.key)
          return [Effect.void, remaining.length ? { _tag: "RunningThenRun", run, next: remaining } : { _tag: "Running", run }] as const
        }
        return [Effect.void, st] as const
      }),
    ).pipe(Effect.flatten) as Effect.Effect<void>

  const stopShell = (shell: ShellHandle<A, E>) =>
    Effect.gen(function* () {
      if (shell.ready) yield* shell.ready.await.pipe(Effect.exit, Effect.asVoid)
      yield* Deferred.succeed(shell.cancelled, undefined).pipe(Effect.asVoid)
      yield* Fiber.interrupt(shell.fiber)
    })

  const queueRun = (work: Effect.Effect<A, E>, key?: string) =>
    Effect.gen(function* () {
      return {
        id: next(),
        done: yield* Deferred.make<A, E | Cancelled>(),
        work,
        key,
      } satisfies PendingHandle<A, E>
    })

  const cancelPendingHandles = (pending: readonly PendingHandle<A, E>[]) =>
    Effect.forEach(pending, (item) => Deferred.fail(item.done, new Cancelled()).pipe(Effect.asVoid), {
      concurrency: "unbounded",
      discard: true,
    })

  const interruptThenAwait = (
    fiber: Fiber.Fiber<A, E>,
    done: Deferred.Deferred<A, E | Cancelled>,
    options: NonNullable<EnsureRunningOptions["interrupt"]>,
  ) =>
    Effect.gen(function* () {
      yield* options.before ?? Effect.void
      yield* Fiber.interrupt(fiber).pipe(Effect.ensuring(options.after ?? Effect.void))
      return yield* awaitDone(done)
    })

  const ensureRunning = (work: Effect.Effect<A, E>, options?: EnsureRunningOptions): Effect.Effect<A, E> =>
    SynchronizedRef.modifyEffect(
      ref,
      (st) => Effect.gen(function* () {
        trace.trace("ensure", { state: st._tag, queue: options?.queue ?? false, interrupt: Boolean(options?.interrupt) })
        switch (st._tag) {
          case "Running":
            if (options?.queue) {
              if (options.queueKey !== undefined && st.run.key === options.queueKey) {
                return [awaitDone(st.run.done), st] as const
              }
              const next = yield* queueRun(work, options?.queueKey)
              return [
                st.run.interruptible && options.interrupt
                  ? interruptThenAwait(st.run.fiber, next.done, options.interrupt)
                  : awaitDone(next.done),
                { _tag: "RunningThenRun", run: st.run, next: [next] },
              ] as const
            }
            return [awaitDone(st.run.done), st] as const
          case "RunningThenRun":
            if (options?.queue) {
              if (options.queueKey !== undefined) {
                if (st.run.key === options.queueKey) return [awaitDone(st.run.done), st] as const
                const queued = st.next.find((item) => item.key === options.queueKey)
                if (queued) return [awaitDone(queued.done), st] as const
              }
              const next = yield* queueRun(work, options?.queueKey)
              return [
                st.run.interruptible && options.interrupt
                  ? interruptThenAwait(st.run.fiber, next.done, options.interrupt)
                  : awaitDone(next.done),
                { ...st, next: [...st.next, next] },
              ] as const
            }
            return [awaitDone(st.run.done), st] as const
          case "ShellThenRun":
            if (options?.queue) {
              if (options.queueKey !== undefined) {
                const queued = st.run.find((item) => item.key === options.queueKey)
                if (queued) return [awaitDone(queued.done), st] as const
              }
              const next = yield* queueRun(work, options?.queueKey)
              return [awaitDone(next.done), { ...st, run: [...st.run, next] }] as const
            }
            return [awaitDone(st.run[0].done), st] as const
          case "Shell": {
            const run = yield* queueRun(work, options?.queueKey)
            return [awaitDone(run.done), { _tag: "ShellThenRun", shell: st.shell, run: [run] }] as const
          }
          case "Idle": {
            const done = yield* Deferred.make<A, E | Cancelled>()
            const run = yield* startRun(work, done, options?.queueKey)
            return [awaitDone(done), { _tag: "Running", run }] as const
          }
        }
      }),
    ).pipe(Effect.flatten) as Effect.Effect<A, E>

  const startShell = (work: Effect.Effect<A, E>, ready?: Latch.Latch): Effect.Effect<A, E> =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        if (st._tag !== "Idle") {
          return [
            Effect.sync(() => {
              if (opts?.busy) opts.busy()
              throw new Error("Runner is busy")
            }),
            st,
          ] as const
        }
        yield* busy
        const id = next()
        const cancelled = yield* Deferred.make<void>()
        const fiber = yield* work.pipe(Effect.ensuring(finishShell(id)), Effect.forkIn(scope))
        const shell = { id, cancelled, ready, fiber } satisfies ShellHandle<A, E>
        return [
          Effect.gen(function* () {
            const exit = yield* Fiber.await(fiber)
            if (Exit.isSuccess(exit)) return exit.value
            if (
              Cause.hasInterruptsOnly(exit.cause) ||
              ((yield* Deferred.isDone(cancelled)) && Cause.hasInterrupts(exit.cause) && !Cause.hasDies(exit.cause))
            ) {
              if (onInterrupt) return yield* onInterrupt
              return yield* Effect.die(new Cancelled())
            }
            return yield* Effect.failCause(exit.cause)
          }),
          { _tag: "Shell", shell },
        ] as const
      }),
    ).pipe(Effect.flatten) as Effect.Effect<A, E>

  const cancelCurrent = (options?: { before?: Effect.Effect<void>; cancelPending?: boolean }) => SynchronizedRef.modify(ref, (st) => {
    switch (st._tag) {
      case "Idle":
        return [Effect.void, st] as const
      case "Running":
        return [
          Effect.gen(function* () {
            yield* options?.before ?? Effect.void
            yield* Fiber.interrupt(st.run.fiber)
            // The interrupted work normally completes this in finishRun. Close
            // it here as well so callers cannot hang if cancellation wins the
            // brief race before the forked work begins its on-exit path.
            yield* Deferred.fail(st.run.done, new Cancelled()).pipe(Effect.asVoid)
            yield* idleIfCurrent()
          }),
          { _tag: "Idle" } as const,
        ] as const
      case "RunningThenRun":
        return [
          Effect.gen(function* () {
            if (options?.cancelPending) yield* cancelPendingHandles(st.next)
            yield* options?.before ?? Effect.void
            yield* Fiber.interrupt(st.run.fiber)
            yield* Deferred.fail(st.run.done, new Cancelled()).pipe(Effect.asVoid)
          }),
          options?.cancelPending ? { _tag: "Running", run: st.run } as const : st,
        ] as const
      case "Shell":
        return [
          Effect.gen(function* () {
            yield* options?.before ?? Effect.void
            yield* stopShell(st.shell)
            yield* idleIfCurrent()
          }),
          { _tag: "Idle" } as const,
        ] as const
      case "ShellThenRun":
        return [
          Effect.gen(function* () {
            yield* options?.before ?? Effect.void
            yield* stopShell(st.shell)
            yield* cancelPendingHandles(st.run)
            yield* idleIfCurrent()
          }),
          { _tag: "Idle" } as const,
        ] as const
    }
  }).pipe(Effect.flatten)

  const cancel = cancelCurrent()

  const cancelPending = (predicate: (key?: string) => boolean) =>
    SynchronizedRef.modifyEffect(ref, (st) =>
      Effect.gen(function* () {
        if (st._tag === "RunningThenRun") {
          const removed = st.next.filter((item) => predicate(item.key))
          if (removed.length === 0) return [false, st] as const
          const remaining = st.next.filter((item) => !predicate(item.key))
          yield* cancelPendingHandles(removed)
          return [
            true,
            remaining.length > 0 ? { _tag: "RunningThenRun", run: st.run, next: remaining } : { _tag: "Running", run: st.run },
          ] as const
        }
        if (st._tag === "ShellThenRun") {
          const removed = st.run.filter((item) => predicate(item.key))
          if (removed.length === 0) return [false, st] as const
          const remaining = st.run.filter((item) => !predicate(item.key))
          yield* cancelPendingHandles(removed)
          return [
            true,
            remaining.length > 0 ? { _tag: "ShellThenRun", shell: st.shell, run: remaining } : { _tag: "Shell", shell: st.shell },
          ] as const
        }
        return [false, st] as const
      }),
    )

  const setInterruptible = (interruptible: boolean) =>
    SynchronizedRef.update(ref, (st) => {
      if (st._tag === "Running") return { ...st, run: { ...st.run, interruptible } }
      if (st._tag === "RunningThenRun") return { ...st, run: { ...st.run, interruptible } }
      return st
    })

  const interruptRun = (run: RunHandle<A, E>, options?: NonNullable<EnsureRunningOptions["interrupt"]>) =>
      Effect.gen(function* () {
        yield* options?.before ?? Effect.void
        yield* Fiber.interrupt(run.fiber).pipe(Effect.ensuring(options?.after ?? Effect.void))
        yield* Deferred.await(run.done).pipe(Effect.exit, Effect.asVoid)
      })
  const interruptShell = (shell: ShellHandle<A, E>, options?: NonNullable<EnsureRunningOptions["interrupt"]>) =>
      Effect.gen(function* () {
        yield* options?.before ?? Effect.void
        yield* stopShell(shell).pipe(Effect.ensuring(options?.after ?? Effect.void))
      })

  const interruptCurrent = (options?: NonNullable<EnsureRunningOptions["interrupt"]>) => SynchronizedRef.modify(ref, (st) => {
    switch (st._tag) {
      case "Idle":
        return [Effect.void, st] as const
      case "Running":
        return [interruptRun(st.run, options), st] as const
      case "RunningThenRun":
        return [interruptRun(st.run, options), st] as const
      case "Shell":
        return [interruptShell(st.shell, options), st] as const
      case "ShellThenRun":
        return [interruptShell(st.shell, options), st] as const
    }
  }).pipe(Effect.flatten)

  const interruptQueued = (options?: NonNullable<EnsureRunningOptions["interrupt"]>) =>
    SynchronizedRef.modify(ref, (st) => {
      if (st._tag === "RunningThenRun") return [interruptRun(st.run, options).pipe(Effect.as(true)), st] as const
      if (st._tag === "ShellThenRun") return [interruptShell(st.shell, options).pipe(Effect.as(true)), st] as const
      return [Effect.succeed(false), st] as const
    }).pipe(Effect.flatten)

  const interrupt = interruptQueued().pipe(Effect.asVoid)

  return {
    get state() {
      return state()
    },
    get busy() {
      return state()._tag !== "Idle"
    },
    ensureRunning,
    startShell,
    interruptCurrent,
    interruptQueued,
    cancelPending,
    setInterruptible,
    interrupt,
    cancelCurrent,
    cancel,
  }
}

export * as Runner from "./runner"
