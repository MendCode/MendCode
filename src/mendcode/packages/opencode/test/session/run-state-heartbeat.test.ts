import { expect } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { SessionID } from "../../src/session/schema"
import { withBusyStatusHeartbeat } from "../../src/session/run-state"
import { it } from "../lib/effect"

it.effect("keeps a live run fresh and stops heartbeats when the work completes", () =>
  Effect.gen(function* () {
    const sessionID = SessionID.make("ses-heartbeat")
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    let heartbeats = 0
    const status = {
      heartbeat: () => Effect.sync(() => heartbeats++),
    }

    const work = withBusyStatusHeartbeat(
      status,
      sessionID,
      Effect.gen(function* () {
        yield* Deferred.succeed(started, undefined)
        yield* Deferred.await(release)
        return "done"
      }),
      1_000,
    )
    const fiber = yield* work.pipe(Effect.forkChild)
    yield* Deferred.await(started)

    yield* TestClock.adjust("3 seconds")
    expect(heartbeats).toBe(3)

    yield* Deferred.succeed(release, undefined)
    expect(yield* Fiber.join(fiber)).toBe("done")
    yield* TestClock.adjust("3 seconds")
    expect(heartbeats).toBe(3)
  }),
)
