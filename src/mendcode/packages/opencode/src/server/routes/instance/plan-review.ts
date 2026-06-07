import { Hono } from "hono"
import { describeRoute, validator } from "hono-openapi"
import { resolver } from "hono-openapi"
import { PlanReview } from "@/plan-review"
import { PlanReviewID } from "@/plan-review/schema"
import z from "zod"
import { errors } from "../../error"
import { lazy } from "@/util/lazy"
import { jsonRequest } from "./trace"

const Reply = PlanReview.Reply.zod

export const PlanReviewRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List pending plan reviews",
        description: "Get all pending plan review requests across all sessions.",
        operationId: "planReview.list",
        responses: {
          200: {
            description: "List of pending plan reviews",
            content: {
              "application/json": {
                schema: resolver(PlanReview.Request.zod.array()),
              },
            },
          },
        },
      }),
      async (c) =>
        jsonRequest("PlanReviewRoutes.list", c, function* () {
          const svc = yield* PlanReview.Service
          return yield* svc.list()
        }),
    )
    .post(
      "/:requestID/reply",
      describeRoute({
        summary: "Reply to plan review",
        description: "Apply, edit, reject, or close a plan review request from the AI assistant.",
        operationId: "planReview.reply",
        responses: {
          200: {
            description: "Plan review answered successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          requestID: PlanReviewID.zod,
        }),
      ),
      validator("json", Reply),
      async (c) =>
        jsonRequest("PlanReviewRoutes.reply", c, function* () {
          const params = c.req.valid("param")
          const json = c.req.valid("json")
          const svc = yield* PlanReview.Service
          yield* svc.reply({
            requestID: params.requestID,
            reply: json,
          })
          return true
        }),
    ),
)
