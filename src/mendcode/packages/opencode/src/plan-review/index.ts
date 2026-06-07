import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { InstanceState } from "@/effect/instance-state"
import { MessageID, SessionID } from "@/session/schema"
import { zod } from "@/util/effect-zod"
import * as Log from "@mendcode/core/util/log"
import { Deferred, Effect, Layer, Schema, Context } from "effect"
import { PlanReviewID } from "./schema"

const log = Log.create({ service: "plan-review" })

export const Action = Schema.Literals(["apply", "edit", "reject", "close"]).annotate({
  identifier: "PlanReviewAction",
})
export type Action = Schema.Schema.Type<typeof Action>

export class Tool extends Schema.Class<Tool>("PlanReviewTool")({
  messageID: MessageID,
  callID: Schema.String,
}) {
  static readonly zod = zod(this)
}

export class Request extends Schema.Class<Request>("PlanReviewRequest")({
  id: PlanReviewID,
  sessionID: SessionID,
  title: Schema.optional(Schema.String),
  markdown: Schema.String,
  tool: Schema.optional(Tool),
}) {
  static readonly zod = zod(this)
}

export class Reply extends Schema.Class<Reply>("PlanReviewReply")({
  action: Action,
  markdown: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
}) {
  static readonly zod = zod(this)
}

class Replied extends Schema.Class<Replied>("PlanReviewReplied")({
  sessionID: SessionID,
  requestID: PlanReviewID,
  action: Action,
}) {}

export const Event = {
  Asked: BusEvent.define("plan_review.asked", Request),
  Replied: BusEvent.define("plan_review.replied", Replied),
}

export class ClosedError extends Schema.TaggedErrorClass<ClosedError>()("PlanReviewClosedError", {}) {
  override get message() {
    return "The user closed this plan review without a decision"
  }
}

interface PendingEntry {
  info: Request
  deferred: Deferred.Deferred<Reply, ClosedError>
}

interface State {
  pending: Map<PlanReviewID, PendingEntry>
}

export interface Interface {
  readonly ask: (input: {
    sessionID: SessionID
    title?: string
    markdown: string
    tool?: Tool
  }) => Effect.Effect<Reply, ClosedError>
  readonly reply: (input: { requestID: PlanReviewID; reply: Reply }) => Effect.Effect<void>
  readonly list: () => Effect.Effect<ReadonlyArray<Request>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/PlanReview") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const state = yield* InstanceState.make<State>(
      Effect.fn("PlanReview.state")(function* () {
        const state = {
          pending: new Map<PlanReviewID, PendingEntry>(),
        }

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const item of state.pending.values()) {
              yield* Deferred.fail(item.deferred, new ClosedError())
            }
            state.pending.clear()
          }),
        )

        return state
      }),
    )

    const ask = Effect.fn("PlanReview.ask")(function* (input: {
      sessionID: SessionID
      title?: string
      markdown: string
      tool?: Tool
    }) {
      const pending = (yield* InstanceState.get(state)).pending
      const id = PlanReviewID.ascending()
      log.info("asking", { id, title: input.title })

      const deferred = yield* Deferred.make<Reply, ClosedError>()
      const info = Schema.decodeUnknownSync(Request)({
        id,
        sessionID: input.sessionID,
        title: input.title,
        markdown: input.markdown,
        tool: input.tool,
      })
      pending.set(id, { info, deferred })
      yield* bus.publish(Event.Asked, info)

      return yield* Effect.ensuring(
        Deferred.await(deferred),
        Effect.sync(() => {
          pending.delete(id)
        }),
      )
    })

    const reply = Effect.fn("PlanReview.reply")(function* (input: { requestID: PlanReviewID; reply: Reply }) {
      const pending = (yield* InstanceState.get(state)).pending
      const existing = pending.get(input.requestID)
      if (!existing) {
        log.warn("reply for unknown request", { requestID: input.requestID })
        return
      }
      pending.delete(input.requestID)
      log.info("replied", { requestID: input.requestID, action: input.reply.action })
      yield* bus.publish(Event.Replied, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
        action: input.reply.action,
      })
      if (input.reply.action === "close") {
        yield* Deferred.fail(existing.deferred, new ClosedError())
        return
      }
      yield* Deferred.succeed(existing.deferred, input.reply)
    })

    const list = Effect.fn("PlanReview.list")(function* () {
      const pending = (yield* InstanceState.get(state)).pending
      return Array.from(pending.values(), (x) => x.info)
    })

    return Service.of({ ask, reply, list })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))

export * as PlanReview from "."
