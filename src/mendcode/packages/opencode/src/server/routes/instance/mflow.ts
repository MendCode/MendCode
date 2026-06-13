import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { Effect } from "effect"
import { Instance } from "@/project/instance"
import { lazy } from "@/util/lazy"
import { jsonRequest } from "./trace"
import { activateMflow, deactivateMflow, mflowControlStatus, mflowLocalRelayGuide, removeMflowConfig, scanMflowRelays } from "@/mend/config/mflow"

const ActivatePayload = z.object({
  relayMode: z.enum(["local", "public", "legacy-public", "remote", "custom"]),
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
    .get(
      "/scan",
      describeRoute({
        summary: "Scan mflow relays",
        description: "Scan localhost and local LAN candidates for visible mflow relays.",
        operationId: "mflow.scan",
        responses: {
          200: {
            description: "detected relays",
            content: { "application/json": { schema: resolver(z.any()) } },
          },
        },
      }),
      async (c) =>
        jsonRequest("MflowRoutes.scan", c, function* () {
          return yield* Effect.promise(() => scanMflowRelays())
        }),
    )
    .get(
      "/relay-guide",
      describeRoute({
        summary: "Get local mflow relay guide",
        description: "Get local relay command guidance until mflow ships a packaged relay start command.",
        operationId: "mflow.relayGuide",
        responses: {
          200: {
            description: "local relay guide",
            content: { "application/json": { schema: resolver(z.any()) } },
          },
        },
      }),
      async (c) =>
        jsonRequest("MflowRoutes.relayGuide", c, function* () {
          return mflowLocalRelayGuide(Instance.directory)
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
