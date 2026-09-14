import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { Permission } from "@/permission"
import { PermissionID } from "@/permission/schema"
import { errors } from "../../error"
import { lazy } from "@/util/lazy"
import { jsonRequest } from "./trace"
import { NotFoundError } from "@/storage/storage"

export const PermissionRoutes = lazy(() =>
  new Hono()
    .post(
      "/:requestID/reply",
      describeRoute({
        summary: "Respond to permission request",
        description: "Approve or deny a permission request from the AI assistant.",
        operationId: "permission.reply",
        responses: {
          200: {
            description: "Permission processed successfully",
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
          requestID: PermissionID.zod,
        }),
      ),
      validator("json", Permission.ReplyBody.zod),
      async (c) =>
        jsonRequest("PermissionRoutes.reply", c, function* () {
          const params = c.req.valid("param")
          const json = c.req.valid("json")
          const svc = yield* Permission.Service
          const released = yield* svc.reply({
            requestID: params.requestID,
            reply: json.reply,
            message: json.message,
            smart: json.smart,
          })
          return released
        }),
    )
    .get(
      "/",
      describeRoute({
        summary: "List pending permissions",
        description: "Get all pending permission requests across all sessions.",
        operationId: "permission.list",
        responses: {
          200: {
            description: "List of pending permissions",
            content: {
              "application/json": {
                schema: resolver(Permission.Request.zod.array()),
              },
            },
          },
        },
      }),
      async (c) =>
        jsonRequest("PermissionRoutes.list", c, function* () {
          const svc = yield* Permission.Service
          return yield* svc.list()
        }),
    )
    .get(
      "/reviews",
      describeRoute({
        summary: "List Smart Approval review history",
        description: "Return bounded Smart Approval review records for the current project.",
        operationId: "permission.reviews",
        responses: {
          200: {
            description: "Smart Approval review history",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    items: z.array(z.record(z.string(), z.unknown())),
                    nextCursor: z.string().optional(),
                  }),
                ),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          sessionID: z.string().optional(),
          cursor: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(100).optional(),
        }),
      ),
      async (c) =>
        jsonRequest("PermissionRoutes.reviews", c, function* () {
          const query = c.req.valid("query")
          const svc = yield* Permission.Service
          return yield* svc.listReviews(query)
        }),
    )
    .post(
      "/grants/:grantID/revoke",
      describeRoute({
        summary: "Revoke a Smart Approval task grant",
        operationId: "permission.grants.revoke",
        responses: {
          200: {
            description: "Grant revocation result",
            content: { "application/json": { schema: resolver(z.object({ revoked: z.boolean() })) } },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ grantID: z.string().min(1) })),
      async (c) =>
        jsonRequest("PermissionRoutes.revokeGrant", c, function* () {
          const params = c.req.valid("param")
          const svc = yield* Permission.Service
          const revoked = yield* svc.revokeGrant(params.grantID)
          if (!revoked) throw new NotFoundError({ message: "Smart Approval grant not found" })
          return { revoked: true }
        }),
    ),
)
