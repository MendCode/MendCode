import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { Bus, INTERNAL_EVENT_BUFFER_CAPACITY } from "../../src/bus"
import { BusEvent } from "../../src/bus/bus-event"
import { CrossSpawnSpawner } from "@mendcode/core/cross-spawn-spawner"
import { disposeAllInstances, provideInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const TestEvent = {
  Ping: BusEvent.define("test.effect.ping", Schema.Struct({ value: Schema.Number })),
  Pong: BusEvent.define("test.effect.pong", Schema.Struct({ message: Schema.String })),
}

const node = CrossSpawnSpawner.defaultLayer

const live = Layer.mergeAll(Bus.layer, node)

const it = testEffect(live)

describe("Bus (Effect-native)", () => {
  it.instance("publish + subscribe stream delivers events", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const received: number[] = []
      const done = yield* Deferred.make<void>()

      yield* Stream.runForEach(bus.subscribe(TestEvent.Ping), (evt) =>
        Effect.sync(() => {
          received.push(evt.properties.value)
          if (received.length === 2) Deferred.doneUnsafe(done, Effect.void)
        }),
      ).pipe(Effect.forkScoped)

      yield* Effect.sleep("10 millis")
      yield* bus.publish(TestEvent.Ping, { value: 1 })
      yield* bus.publish(TestEvent.Ping, { value: 2 })
      yield* Deferred.await(done)

      expect(received).toEqual([1, 2])
    }),
  )

  it.instance("subscribe filters by event type", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const pings: number[] = []
      const done = yield* Deferred.make<void>()

      yield* Stream.runForEach(bus.subscribe(TestEvent.Ping), (evt) =>
        Effect.sync(() => {
          pings.push(evt.properties.value)
          Deferred.doneUnsafe(done, Effect.void)
        }),
      ).pipe(Effect.forkScoped)

      yield* Effect.sleep("10 millis")
      yield* bus.publish(TestEvent.Pong, { message: "ignored" })
      yield* bus.publish(TestEvent.Ping, { value: 42 })
      yield* Deferred.await(done)

      expect(pings).toEqual([42])
    }),
  )

  it.instance("subscribeAll receives all types", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const types: string[] = []
      const done = yield* Deferred.make<void>()

      yield* Stream.runForEach(bus.subscribeAll(), (evt) =>
        Effect.sync(() => {
          types.push(evt.type)
          if (types.length === 2) Deferred.doneUnsafe(done, Effect.void)
        }),
      ).pipe(Effect.forkScoped)

      yield* Effect.sleep("10 millis")
      yield* bus.publish(TestEvent.Ping, { value: 1 })
      yield* bus.publish(TestEvent.Pong, { message: "hi" })
      yield* Deferred.await(done)

      expect(types).toContain("test.effect.ping")
      expect(types).toContain("test.effect.pong")
    }),
  )

  it.instance("multiple subscribers each receive the event", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const a: number[] = []
      const b: number[] = []
      const doneA = yield* Deferred.make<void>()
      const doneB = yield* Deferred.make<void>()

      yield* Stream.runForEach(bus.subscribe(TestEvent.Ping), (evt) =>
        Effect.sync(() => {
          a.push(evt.properties.value)
          Deferred.doneUnsafe(doneA, Effect.void)
        }),
      ).pipe(Effect.forkScoped)

      yield* Stream.runForEach(bus.subscribe(TestEvent.Ping), (evt) =>
        Effect.sync(() => {
          b.push(evt.properties.value)
          Deferred.doneUnsafe(doneB, Effect.void)
        }),
      ).pipe(Effect.forkScoped)

      yield* Effect.sleep("10 millis")
      yield* bus.publish(TestEvent.Ping, { value: 99 })
      yield* Deferred.await(doneA)
      yield* Deferred.await(doneB)

      expect(a).toEqual([99])
      expect(b).toEqual([99])
    }),
  )

  it.instance("bounds a slow subscriber instead of retaining an unbounded event backlog", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const drained = yield* Deferred.make<void>()
      const received: number[] = []

      yield* Stream.runForEach(bus.subscribe(TestEvent.Ping), (evt) =>
        Effect.gen(function* () {
          if (evt.properties.value === 0) {
            Deferred.doneUnsafe(entered, Effect.void)
            yield* Deferred.await(release)
          }
          received.push(evt.properties.value)
          if (evt.properties.value === INTERNAL_EVENT_BUFFER_CAPACITY + 1) {
            Deferred.doneUnsafe(drained, Effect.void)
          }
        }),
      ).pipe(Effect.forkScoped)

      yield* Effect.sleep("10 millis")
      yield* bus.publish(TestEvent.Ping, { value: 0 })
      yield* Deferred.await(entered)

      let publishFinished = false
      const publishFiber = yield* Effect.forEach(
        Array.from({ length: INTERNAL_EVENT_BUFFER_CAPACITY + 1 }, (_, value) => value + 1),
        (value) => bus.publish(TestEvent.Ping, { value }),
        { discard: true },
      ).pipe(
        Effect.tap(() => Effect.sync(() => (publishFinished = true))),
        Effect.forkScoped,
      )
      yield* Effect.sleep("20 millis")
      expect(publishFinished).toBe(false)

      Deferred.doneUnsafe(release, Effect.void)
      yield* Fiber.join(publishFiber)
      yield* Deferred.await(drained).pipe(Effect.timeout("2 seconds"))
      expect(received).toHaveLength(INTERNAL_EVENT_BUFFER_CAPACITY + 2)
    }),
  )

  it.live("subscribeAll stream sees InstanceDisposed on disposal", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const types: string[] = []
      const seen = yield* Deferred.make<void>()
      const disposed = yield* Deferred.make<void>()

      // Set up subscriber inside the instance
      yield* Effect.gen(function* () {
        const bus = yield* Bus.Service

        yield* Stream.runForEach(bus.subscribeAll(), (evt) =>
          Effect.sync(() => {
            types.push(evt.type)
            if (evt.type === TestEvent.Ping.type) Deferred.doneUnsafe(seen, Effect.void)
            if (evt.type === Bus.InstanceDisposed.type) Deferred.doneUnsafe(disposed, Effect.void)
          }),
        ).pipe(Effect.forkScoped)

        yield* Effect.sleep("10 millis")
        yield* bus.publish(TestEvent.Ping, { value: 1 })
        yield* Deferred.await(seen)
      }).pipe(provideInstance(dir))

      // Dispose from OUTSIDE the instance scope
      yield* Effect.promise(disposeAllInstances)
      yield* Deferred.await(disposed).pipe(Effect.timeout("2 seconds"))

      expect(types).toContain("test.effect.ping")
      expect(types).toContain(Bus.InstanceDisposed.type)
    }),
  )
})
