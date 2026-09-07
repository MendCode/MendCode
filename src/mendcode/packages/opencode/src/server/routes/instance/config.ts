import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import { Config } from "@/config/config"
import * as AIConfiguration from "@/mend/runtime/ai-configuration"
import { InstanceState } from "@/effect/instance-state"
import { InstanceStore } from "@/project/instance-store"
import { Provider } from "@/provider/provider"
import { errors } from "../../error"
import { lazy } from "@/util/lazy"
import { jsonRequest, runRequest } from "./trace"
import { Effect } from "effect"
import * as Log from "@mendcode/core/util/log"
import { zod as effectZod } from "@/util/effect-zod"

const log = Log.create({ service: "server.config" })

function aiErrorResponse(c: Parameters<typeof jsonRequest>[1], error: AIConfiguration.AIConfigurationError) {
  const body = { code: error.code, message: error.message, details: error.details ?? null }
  if (error.code === "permission") return c.json(body, 403)
  if (error.code === "conflict") return c.json(body, 409)
  if (error.code === "unavailable") return c.json(body, 422)
  if (error.code === "io") return c.json(body, 500)
  return c.json(body, 400)
}

export const ConfigRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "Get configuration",
        description: "Retrieve the current MendCode configuration settings and preferences.",
        operationId: "config.get",
        responses: {
          200: {
            description: "Get config info",
            content: {
              "application/json": {
                schema: resolver(Config.Info.zod),
              },
            },
          },
        },
      }),
      async (c) =>
        jsonRequest("ConfigRoutes.get", c, function* () {
          const cfg = yield* Config.Service
          return yield* cfg.get()
        }),
    )
    .patch(
      "/",
      describeRoute({
        summary: "Update configuration",
        description: "Update MendCode configuration settings and preferences.",
        operationId: "config.update",
        responses: {
          200: {
            description: "Successfully updated config",
            content: {
              "application/json": {
                schema: resolver(Config.Info.zod),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", Config.Info.zod),
      async (c) => {
        const result = await runRequest(
          "ConfigRoutes.update",
          c,
          Effect.gen(function* () {
            const config = c.req.valid("json")
            const cfg = yield* Config.Service
            yield* cfg.update(config)
            return { config, ctx: yield* InstanceState.context }
          }),
        )
        const response = c.json(result.config)
        void runRequest(
          "ConfigRoutes.update.dispose",
          c,
          InstanceStore.Service.use((store) => store.dispose(result.ctx)).pipe(
            Effect.uninterruptible,
            Effect.catchCause((cause) => Effect.sync(() => log.warn("instance disposal failed", { cause }))),
          ),
        )
        return response
      },
    )
    .get(
      "/providers",
      describeRoute({
        summary: "List config providers",
        description: "Get a list of all configured AI providers and their default models.",
        operationId: "config.providers",
        responses: {
          200: {
            description: "List of providers",
            content: {
              "application/json": {
                schema: resolver(Provider.ConfigProvidersResult.zod),
              },
            },
          },
        },
      }),
      async (c) =>
        jsonRequest("ConfigRoutes.providers", c, function* () {
          const svc = yield* Provider.Service
          const providers = yield* svc.list()
          return {
            providers: Object.values(providers),
            default: Provider.defaultModelIDs(providers),
          }
        }),
    )
    .get(
      "/ai",
      describeRoute({
        summary: "Inspect AI configuration",
        description: "Inspect actual provider/model metadata without provider inference calls or writes.",
        operationId: "config.ai.inspect",
        responses: {
          200: {
            description: "Actual AI configuration metadata",
            content: { "application/json": { schema: resolver(effectZod(AIConfiguration.InspectResponse)) } },
          },
          ...errors(400),
        },
      }),
      async (c) => {
        try {
          return c.json(
            await runRequest(
              "ConfigRoutes.aiInspect",
              c,
              Effect.gen(function* () {
                const service = yield* AIConfiguration.Service
                return yield* service.inspect()
              }),
            ),
          )
        } catch (error) {
          if (error instanceof AIConfiguration.AIConfigurationError) return aiErrorResponse(c, error)
          throw error
        }
      },
    )
    .post(
      "/ai/plan",
      describeRoute({
        summary: "Plan AI configuration",
        description: "Prepare bounded model and compaction alternatives from an explicit candidate allowlist.",
        operationId: "config.ai.plan",
        responses: {
          200: {
            description: "No-write AI configuration preview",
            content: { "application/json": { schema: resolver(effectZod(AIConfiguration.PlanResponse)) } },
          },
          ...errors(400, 422),
        },
      }),
      validator("json", effectZod(AIConfiguration.PlanRequest)),
      async (c) => {
        try {
          return c.json(
            await runRequest(
              "ConfigRoutes.aiPlan",
              c,
              Effect.gen(function* () {
                const service = yield* AIConfiguration.Service
                return yield* service.plan(c.req.valid("json"))
              }),
            ),
          )
        } catch (error) {
          if (error instanceof AIConfiguration.AIConfigurationError) return aiErrorResponse(c, error)
          throw error
        }
      },
    )
    .post(
      "/ai/validate",
      describeRoute({
        summary: "Validate AI configuration",
        description: "Validate AI schemas, roles, auth, limits and native binding without provider calls or writes.",
        operationId: "config.ai.validate",
        responses: {
          200: {
            description: "Validated AI configuration preview",
            content: { "application/json": { schema: resolver(effectZod(AIConfiguration.ValidateResponse)) } },
          },
          ...errors(400, 422),
        },
      }),
      validator("json", effectZod(AIConfiguration.ValidateRequest)),
      async (c) => {
        try {
          return c.json(
            await runRequest(
              "ConfigRoutes.aiValidate",
              c,
              Effect.gen(function* () {
                const service = yield* AIConfiguration.Service
                return yield* service.validate(c.req.valid("json"))
              }),
            ),
          )
        } catch (error) {
          if (error instanceof AIConfiguration.AIConfigurationError) return aiErrorResponse(c, error)
          throw error
        }
      },
    )
    .post(
      "/ai/apply",
      describeRoute({
        summary: "Apply AI configuration",
        description: "Apply an exact validated ai/compaction patch after digest and permission checks.",
        operationId: "config.ai.apply",
        responses: {
          200: {
            description: "Applied AI configuration",
            content: { "application/json": { schema: resolver(effectZod(AIConfiguration.ApplyResponse)) } },
          },
          ...errors(400, 403, 409, 422),
        },
      }),
      validator("json", effectZod(AIConfiguration.ApplyRequest)),
      async (c) => {
        try {
          return c.json(
            await runRequest(
              "ConfigRoutes.aiApply",
              c,
              Effect.gen(function* () {
                const service = yield* AIConfiguration.Service
                return yield* service.apply(c.req.valid("json"))
              }),
            ),
          )
        } catch (error) {
          if (error instanceof AIConfiguration.AIConfigurationError) return aiErrorResponse(c, error)
          throw error
        }
      },
    ),
)
