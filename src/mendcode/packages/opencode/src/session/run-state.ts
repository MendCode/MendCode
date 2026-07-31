import { InstanceState } from "@/effect/instance-state"
import { Runner } from "@/effect/runner"
import { Effect, Latch, Layer, Scope, Context } from "effect"
import * as Session from "./session"
import { MessageV2 } from "./message-v2"
import { SessionID } from "./schema"
import { SessionStatus } from "./status"

export interface Interface {
  readonly assertNotBusy: (sessionID: SessionID) => Effect.Effect<void>
  readonly isBusy: (sessionID: SessionID) => Effect.Effect<boolean>
  readonly cancel: (sessionID: SessionID, options?: { before?: Effect.Effect<void> }) => Effect.Effect<void>
  readonly cancelQueued: (sessionID: SessionID, queueKey: string) => Effect.Effect<boolean>
  readonly setInterruptible: (sessionID: SessionID, interruptible: boolean) => Effect.Effect<void>
  readonly ensureRunning: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<MessageV2.WithParts>,
    work: Effect.Effect<MessageV2.WithParts>,
    options?: Runner.EnsureRunningOptions,
  ) => Effect.Effect<MessageV2.WithParts>
  readonly interrupt: (
    sessionID: SessionID,
    options?: NonNullable<Runner.EnsureRunningOptions["interrupt"]>,
  ) => Effect.Effect<void>
  readonly interruptQueued: (
    sessionID: SessionID,
    options?: NonNullable<Runner.EnsureRunningOptions["interrupt"]>,
  ) => Effect.Effect<void>
  readonly startShell: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<MessageV2.WithParts>,
    work: Effect.Effect<MessageV2.WithParts>,
    ready?: Latch.Latch,
  ) => Effect.Effect<MessageV2.WithParts>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRunState") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const status = yield* SessionStatus.Service

    const state = yield* InstanceState.make(
      Effect.fn("SessionRunState.state")(function* () {
        const scope = yield* Scope.Scope
        const runners = new Map<SessionID, Runner.Runner<MessageV2.WithParts>>()
        yield* Effect.addFinalizer(
          Effect.fnUntraced(function* () {
            yield* Effect.forEach(runners.values(), (runner) => runner.cancel, {
              concurrency: "unbounded",
              discard: true,
            })
            runners.clear()
          }),
        )
        return { runners, scope }
      }),
    )

    const runner = Effect.fn("SessionRunState.runner")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<MessageV2.WithParts>,
    ) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (existing) return existing
      const next = Runner.make<MessageV2.WithParts>(data.scope, {
        onIdle: Effect.gen(function* () {
          // Runner keeps its state idle while this callback can still yield.
          // Keep the instance registered so a concurrent caller cannot create a
          // second runner while the existing one is finishing its idle effect.
          // The instance finalizer clears this map when the project closes.
          yield* status.set(sessionID, { type: "idle" })
        }),
        onBusy: status.set(sessionID, { type: "busy" }),
        onInterrupt,
        busy: () => {
          throw new Session.BusyError(sessionID)
        },
      })
      data.runners.set(sessionID, next)
      return next
    })

    const assertNotBusy = Effect.fn("SessionRunState.assertNotBusy")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (existing?.busy) throw new Session.BusyError(sessionID)
    })

    const isBusy = Effect.fn("SessionRunState.isBusy")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      return data.runners.get(sessionID)?.busy ?? false
    })

    const cancel = Effect.fn("SessionRunState.cancel")(function* (
      sessionID: SessionID,
      options?: { before?: Effect.Effect<void> },
    ) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (!existing) {
        yield* options?.before ?? Effect.void
        yield* status.set(sessionID, { type: "idle" })
        return
      }
      yield* existing.cancelCurrent({ ...options, cancelPending: true })
    })

    const cancelQueued = Effect.fn("SessionRunState.cancelQueued")(function* (
      sessionID: SessionID,
      queueKey: string,
    ) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (!existing) return false
      return yield* existing.cancelPending((key) => key === queueKey)
    })

    const setInterruptible = Effect.fn("SessionRunState.setInterruptible")(function* (
      sessionID: SessionID,
      interruptible: boolean,
    ) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (!existing) return
      yield* existing.setInterruptible(interruptible)
    })

    const interrupt = Effect.fn("SessionRunState.interrupt")(function* (
      sessionID: SessionID,
      options?: NonNullable<Runner.EnsureRunningOptions["interrupt"]>,
    ) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (!existing) return
      yield* existing.interruptCurrent(options)
    })

    const interruptQueued = Effect.fn("SessionRunState.interruptQueued")(function* (
      sessionID: SessionID,
      options?: NonNullable<Runner.EnsureRunningOptions["interrupt"]>,
    ) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (!existing) return
      yield* existing.interruptQueued(options)
    })

    const ensureRunning = Effect.fn("SessionRunState.ensureRunning")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<MessageV2.WithParts>,
      work: Effect.Effect<MessageV2.WithParts>,
      options?: Runner.EnsureRunningOptions,
    ) {
      return yield* (yield* runner(sessionID, onInterrupt)).ensureRunning(work, options)
    })

    const startShell = Effect.fn("SessionRunState.startShell")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<MessageV2.WithParts>,
      work: Effect.Effect<MessageV2.WithParts>,
      ready?: Latch.Latch,
    ) {
      return yield* (yield* runner(sessionID, onInterrupt)).startShell(work, ready)
    })

    return Service.of({
      assertNotBusy,
      isBusy,
      cancel,
      cancelQueued,
      setInterruptible,
      ensureRunning,
      interrupt,
      interruptQueued,
      startShell,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(SessionStatus.defaultLayer))

export * as SessionRunState from "./run-state"
