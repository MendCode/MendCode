import { Permission } from "@/permission"
import { PermissionID } from "@/permission/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/permission"
const ReplyPayload = Schema.Struct({
  reply: Permission.Reply,
  message: Schema.optional(Schema.String),
  smart: Schema.optional(Permission.ReplyBody.fields.smart),
})
const ReviewQuery = Schema.Struct({
  sessionID: Schema.optional(Schema.String),
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(100))),
})
const ReviewList = Schema.Struct({
  items: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  nextCursor: Schema.optional(Schema.String),
})

export const PermissionApi = HttpApi.make("permission")
  .add(
    HttpApiGroup.make("permission")
      .add(
        HttpApiEndpoint.get("list", root, {
          success: described(Schema.Array(Permission.Request), "List of pending permissions"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "permission.list",
            summary: "List pending permissions",
            description: "Get all pending permission requests across all sessions.",
          }),
        ),
        HttpApiEndpoint.post("reply", `${root}/:requestID/reply`, {
          params: { requestID: PermissionID },
          payload: ReplyPayload,
          success: described(Schema.Boolean, "Permission processed successfully"),
          error: [HttpApiError.BadRequest, HttpApiError.NotFound],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "permission.reply",
            summary: "Respond to permission request",
            description: "Approve or deny a permission request from the AI assistant.",
          }),
        ),
        HttpApiEndpoint.get("reviews", `${root}/reviews`, {
          query: ReviewQuery,
          success: described(ReviewList, "Smart Approval review history"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "permission.reviews",
            summary: "List Smart Approval review history",
            description: "Return bounded Smart Approval review records for the current project.",
          }),
        ),
        HttpApiEndpoint.post("revokeGrant", `${root}/grants/:grantID/revoke`, {
          params: { grantID: Schema.String.check(Schema.isNonEmpty()) },
          success: described(Schema.Struct({ revoked: Schema.Boolean }), "Grant revocation result"),
          error: HttpApiError.NotFound,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "permission.grants.revoke",
            summary: "Revoke a Smart Approval task grant",
            description: "Revoke a project-scoped exact Smart Approval task grant.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "permission",
          description: "Experimental HttpApi permission routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "MendCode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
