import { PlanReview } from "@/plan-review"
import { PlanReviewID } from "@/plan-review/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/plan-review"

export const PlanReviewApi = HttpApi.make("planReview")
  .add(
    HttpApiGroup.make("planReview")
      .add(
        HttpApiEndpoint.get("list", root, {
          success: described(Schema.Array(PlanReview.Request), "List of pending plan reviews"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "planReview.list",
            summary: "List pending plan reviews",
            description: "Get all pending plan review requests across all sessions.",
          }),
        ),
        HttpApiEndpoint.post("reply", `${root}/:requestID/reply`, {
          params: { requestID: PlanReviewID },
          payload: PlanReview.Reply,
          success: described(Schema.Boolean, "Plan review answered successfully"),
          error: [HttpApiError.BadRequest, HttpApiError.NotFound],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "planReview.reply",
            summary: "Reply to plan review",
            description: "Apply, edit, reject, or close a plan review request from the AI assistant.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "planReview",
          description: "Plan review routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "MendCode HttpApi",
      version: "0.0.1",
      description: "Effect HttpApi surface for instance routes.",
    }),
  )
