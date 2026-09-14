import { Permission } from "@/permission"
import { PermissionID } from "@/permission/schema"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

export const permissionHandlers = HttpApiBuilder.group(InstanceHttpApi, "permission", (handlers) =>
  Effect.gen(function* () {
    const svc = yield* Permission.Service

    const list = Effect.fn("PermissionHttpApi.list")(function* () {
      return yield* svc.list()
    })

    const reply = Effect.fn("PermissionHttpApi.reply")(function* (ctx: {
      params: { requestID: PermissionID }
      payload: Permission.ReplyBody
    }) {
      const released = yield* svc.reply({
        requestID: ctx.params.requestID,
        reply: ctx.payload.reply,
        message: ctx.payload.message,
        smart: ctx.payload.smart,
      })
      return released
    })

    const reviews = Effect.fn("PermissionHttpApi.reviews")(function* (ctx: {
      query: { sessionID?: string; cursor?: string; limit?: number }
    }) {
      return yield* svc.listReviews(ctx.query)
    })

    const revokeGrant = Effect.fn("PermissionHttpApi.revokeGrant")(function* (ctx: { params: { grantID: string } }) {
      const revoked = yield* svc.revokeGrant(ctx.params.grantID)
      if (!revoked) return yield* new HttpApiError.NotFound({})
      return { revoked: true }
    })

    return handlers
      .handle("list", list)
      .handle("reply", reply)
      .handle("reviews", reviews)
      .handle("revokeGrant", revokeGrant)
  }),
)
