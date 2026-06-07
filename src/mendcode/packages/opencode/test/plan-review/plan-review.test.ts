import { afterEach, expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { PlanReview } from "../../src/plan-review"
import { PlanReviewID } from "../../src/plan-review/schema"
import { disposeAllInstances } from "../fixture/fixture"
import { SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"
import { CrossSpawnSpawner } from "@mendcode/core/cross-spawn-spawner"

const it = testEffect(Layer.mergeAll(PlanReview.defaultLayer, CrossSpawnSpawner.defaultLayer))

const askEffect = Effect.fn("PlanReviewTest.ask")(function* (input: {
  sessionID: SessionID
  title?: string
  markdown: string
}) {
  const planReview = yield* PlanReview.Service
  return yield* planReview.ask(input)
})

const listEffect = PlanReview.Service.use((svc) => svc.list())

const replyEffect = Effect.fn("PlanReviewTest.reply")(function* (input: {
  requestID: PlanReviewID
  reply: PlanReview.Reply
}) {
  const planReview = yield* PlanReview.Service
  yield* planReview.reply(input)
})

afterEach(async () => {
  await disposeAllInstances()
})

const waitForPending = (count: number) =>
  Effect.gen(function* () {
    for (let i = 0; i < 100; i++) {
      const pending = yield* listEffect
      if (pending.length === count) return pending
      yield* Effect.sleep("10 millis")
    }
    return yield* Effect.fail(new Error(`timed out waiting for ${count} pending plan review request(s)`))
  })

it.instance(
  "ask - resolves with apply reply",
  () =>
    Effect.gen(function* () {
      const fiber = yield* askEffect({
        sessionID: SessionID.make("ses_test"),
        title: "Plan",
        markdown: "# Plan",
      }).pipe(Effect.forkScoped)

      const pending = yield* waitForPending(1)
      expect(pending[0].markdown).toBe("# Plan")
      yield* replyEffect({ requestID: pending[0].id, reply: { action: "apply" } })

      const reply = yield* Fiber.join(fiber)
      expect(reply.action).toBe("apply")
    }),
  { git: true },
)

it.instance(
  "ask - edited markdown is returned",
  () =>
    Effect.gen(function* () {
      const fiber = yield* askEffect({
        sessionID: SessionID.make("ses_test"),
        markdown: "# Original",
      }).pipe(Effect.forkScoped)

      const pending = yield* waitForPending(1)
      yield* replyEffect({
        requestID: pending[0].id,
        reply: { action: "edit", markdown: "# Edited" },
      })

      const reply = yield* Fiber.join(fiber)
      expect(reply.action).toBe("edit")
      expect(reply.markdown).toBe("# Edited")
    }),
  { git: true },
)

it.instance(
  "ask - apply can include edited markdown",
  () =>
    Effect.gen(function* () {
      const fiber = yield* askEffect({
        sessionID: SessionID.make("ses_test"),
        markdown: "# Original",
      }).pipe(Effect.forkScoped)

      const pending = yield* waitForPending(1)
      yield* replyEffect({
        requestID: pending[0].id,
        reply: { action: "apply", markdown: "# Edited and approved" },
      })

      const reply = yield* Fiber.join(fiber)
      expect(reply.action).toBe("apply")
      expect(reply.markdown).toBe("# Edited and approved")
    }),
  { git: true },
)

it.instance(
  "ask - close fails the pending review",
  () =>
    Effect.gen(function* () {
      const fiber = yield* askEffect({
        sessionID: SessionID.make("ses_test"),
        markdown: "# Plan",
      }).pipe(Effect.forkScoped)

      const pending = yield* waitForPending(1)
      yield* replyEffect({ requestID: pending[0].id, reply: { action: "close" } })

      expect((yield* Fiber.await(fiber))._tag).toBe("Failure")
    }),
  { git: true },
)
