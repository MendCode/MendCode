import { Config } from "@/config/config"
import * as AIConfiguration from "@/mend/runtime/ai-configuration"
import { Provider } from "@/provider/provider"
import * as InstanceState from "@/effect/instance-state"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import * as ApiError from "../errors"
import type { ApplyRequest, PlanRequest, ValidateRequest } from "@/mend/runtime/ai-configuration"
import { markInstanceForDisposal } from "../lifecycle"

const toApiError = (error: AIConfiguration.AIConfigurationError) => {
  const details = error.details ?? null
  if (error.code === "permission") return new ApiError.ApiForbiddenError({ code: error.code, message: error.message, details })
  if (error.code === "conflict") return new ApiError.ApiConflictError({ code: error.code, message: error.message, details })
  if (error.code === "unavailable") return new ApiError.ApiUnprocessableError({ code: error.code, message: error.message, details })
  return ApiError.badRequest({ code: error.code, message: error.message, details })
}

const mapAIError = <A>(effect: Effect.Effect<A, AIConfiguration.AIConfigurationError>) =>
  effect.pipe(Effect.catch((error) => Effect.fail(toApiError(error))))

export const configHandlers = HttpApiBuilder.group(InstanceHttpApi, "config", (handlers) =>
  Effect.gen(function* () {
    const providerSvc = yield* Provider.Service
    const configSvc = yield* Config.Service
    const aiConfig = yield* AIConfiguration.Service

    const get = Effect.fn("ConfigHttpApi.get")(function* () {
      return yield* configSvc.get()
    })

    const update = Effect.fn("ConfigHttpApi.update")(function* (ctx) {
      yield* configSvc.update(ctx.payload)
      yield* markInstanceForDisposal(yield* InstanceState.context)
      return ctx.payload
    })

    const providers = Effect.fn("ConfigHttpApi.providers")(function* () {
      const providers = yield* providerSvc.list()
      return {
        providers: Object.values(providers),
        default: Provider.defaultModelIDs(providers),
      }
    })

    const aiInspect = Effect.fn("ConfigHttpApi.aiInspect")(function* () {
      return yield* aiConfig.inspect().pipe(
        Effect.catch((error) =>
          Effect.fail(ApiError.badRequest({ code: error.code, message: error.message, details: error.details ?? null })),
        ),
      )
    })

    const aiPlan = Effect.fn("ConfigHttpApi.aiPlan")(function* (ctx: { payload: typeof PlanRequest.Type }) {
      return yield* mapAIError(aiConfig.plan(ctx.payload))
    })

    const aiValidate = Effect.fn("ConfigHttpApi.aiValidate")(function* (ctx: { payload: typeof ValidateRequest.Type }) {
      return yield* mapAIError(aiConfig.validate(ctx.payload))
    })

    const aiApply = Effect.fn("ConfigHttpApi.aiApply")(function* (ctx: { payload: typeof ApplyRequest.Type }) {
      return yield* mapAIError(aiConfig.apply(ctx.payload))
    })

    return handlers
      .handle("get", get)
      .handle("update", update)
      .handle("providers", providers)
      .handle("aiInspect", aiInspect)
      .handle("aiPlan", aiPlan)
      .handle("aiValidate", aiValidate)
      .handle("aiApply", aiApply)
  }),
)
