import { PlanReview } from "@/plan-review"
import { PlanReviewID } from "@/plan-review/schema"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

export const planReviewHandlers = HttpApiBuilder.group(InstanceHttpApi, "planReview", (handlers) =>
  Effect.gen(function* () {
    const svc = yield* PlanReview.Service

    const list = Effect.fn("PlanReviewHttpApi.list")(function* () {
      return yield* svc.list()
    })

    const reply = Effect.fn("PlanReviewHttpApi.reply")(function* (ctx: {
      params: { requestID: PlanReviewID }
      payload: PlanReview.Reply
    }) {
      yield* svc.reply({
        requestID: ctx.params.requestID,
        reply: ctx.payload,
      })
      return true
    })

    return handlers.handle("list", list).handle("reply", reply)
  }),
)
