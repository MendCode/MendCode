import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { Effect } from "effect"
import { Instance } from "@/project/instance"
import { lazy } from "@/util/lazy"
import { jsonRequest } from "./trace"
import { activateMflow, deactivateMflow, mflowControlStatus, removeMflowConfig } from "@/mend/config/mflow"

const ActivatePayload = z.object({
  relayMode: z.enum(["public", "custom"]),
  signaling: z.string().optional(),
  room: z.string().optional(),
  secret: z.string().optional(),
  generateSecret: z.boolean().optional(),
  storeSecret: z.boolean().optional(),
  hookPriority: z.number().int().min(0).max(9).optional(),
  publicRelayNoticeAccepted: z.boolean().optional(),
})

export const MflowRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "Get mflow status",
        description: "Get MendCode's mflow activation, config, daemon, and lock status.",
        operationId: "mflow.status",
        responses: {
          200: {
            description: "mflow status",
            content: { "application/json": { schema: resolver(z.any()) } },
          },
        },
      }),
      async (c) =>
        jsonRequest("MflowRoutes.status", c, function* () {
          return yield* Effect.promise(() => mflowControlStatus(Instance.directory))
        }),
    )
    .post(
      "/activate",
      describeRoute({
        summary: "Activate mflow",
        description: "Configure mflow, MCP, and pre-edit lock scaffolding for the active project.",
        operationId: "mflow.activate",
        responses: {
          200: {
            description: "mflow activation status",
            content: { "application/json": { schema: resolver(z.any()) } },
          },
        },
      }),
      validator("json", ActivatePayload),
      async (c) =>
        jsonRequest("MflowRoutes.activate", c, function* () {
          return yield* Effect.promise(() => activateMflow(c.req.valid("json"), Instance.directory))
        }),
    )
    .post(
      "/deactivate",
      describeRoute({
        summary: "Deactivate mflow",
        description: "Disable MendCode mflow integration without deleting local configuration.",
        operationId: "mflow.deactivate",
        responses: {
          200: {
            description: "mflow status",
            content: { "application/json": { schema: resolver(z.any()) } },
          },
        },
      }),
      async (c) =>
        jsonRequest("MflowRoutes.deactivate", c, function* () {
          return yield* Effect.promise(() => deactivateMflow(Instance.directory))
        }),
    )
    .post(
      "/remove",
      describeRoute({
        summary: "Remove mflow config",
        description: "Remove local mflow config and generated MendCode integration files.",
        operationId: "mflow.remove",
        responses: {
          200: {
            description: "mflow status",
            content: { "application/json": { schema: resolver(z.any()) } },
          },
        },
      }),
      async (c) =>
        jsonRequest("MflowRoutes.remove", c, function* () {
          return yield* Effect.promise(() => removeMflowConfig(Instance.directory))
        }),
    ),
)
