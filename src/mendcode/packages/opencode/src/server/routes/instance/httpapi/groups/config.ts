import { Config } from "@/config/config"
import * as AIConfiguration from "@/mend/runtime/ai-configuration"
import { Provider } from "@/provider/provider"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware } from "../middleware/workspace-routing"
import { described } from "./metadata"
import { ApiBadRequestError, ApiConflictError, ApiForbiddenError, ApiUnprocessableError } from "../errors"

const root = "/config"

export const ConfigApi = HttpApi.make("config")
  .add(
    HttpApiGroup.make("config")
      .add(
        HttpApiEndpoint.get("get", root, {
          success: described(Config.Info, "Get config info"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.get",
            summary: "Get configuration",
            description: "Retrieve the current MendCode configuration settings and preferences.",
          }),
        ),
        HttpApiEndpoint.patch("update", root, {
          payload: Config.Info,
          success: described(Config.Info, "Successfully updated config"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.update",
            summary: "Update configuration",
            description: "Update MendCode configuration settings and preferences.",
          }),
        ),
        HttpApiEndpoint.get("providers", `${root}/providers`, {
          success: described(Provider.ConfigProvidersResult, "List of providers"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.providers",
            summary: "List config providers",
            description: "Get a list of all configured AI providers and their default models.",
          }),
        ),
        HttpApiEndpoint.get("aiInspect", `${root}/ai`, {
          success: described(AIConfiguration.InspectResponse, "Actual providers, models, roles and AI configuration metadata"),
          error: ApiBadRequestError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.ai.inspect",
            summary: "Inspect AI configuration",
            description: "Inspect configured provider/model metadata without provider inference calls or writes.",
          }),
        ),
        HttpApiEndpoint.post("aiPlan", `${root}/ai/plan`, {
          payload: AIConfiguration.PlanRequest,
          success: described(AIConfiguration.PlanResponse, "Evidence-backed no-write AI configuration preview"),
          error: [ApiBadRequestError, ApiUnprocessableError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.ai.plan",
            summary: "Plan AI configuration",
            description: "Prepare bounded model/compaction alternatives from an explicit caller allowlist without writing.",
          }),
        ),
        HttpApiEndpoint.post("aiValidate", `${root}/ai/validate`, {
          payload: AIConfiguration.ValidateRequest,
          success: described(AIConfiguration.ValidateResponse, "Validated AI configuration preview"),
          error: [ApiBadRequestError, ApiUnprocessableError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.ai.validate",
            summary: "Validate AI configuration",
            description: "Validate schemas, roles, auth, limits and native binding without provider calls or writes.",
          }),
        ),
        HttpApiEndpoint.post("aiApply", `${root}/ai/apply`, {
          payload: AIConfiguration.ApplyRequest,
          success: described(AIConfiguration.ApplyResponse, "Applied scoped AI configuration patch"),
          error: [ApiBadRequestError, ApiForbiddenError, ApiConflictError, ApiUnprocessableError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.ai.apply",
            summary: "Apply AI configuration",
            description: "Apply an exact validated ai/compaction JSONC patch after digest and permission checks.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "config",
          description: "Experimental HttpApi config routes.",
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
