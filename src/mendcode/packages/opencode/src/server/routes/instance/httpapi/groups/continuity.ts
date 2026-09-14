import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { SessionID } from "@/session/schema"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware } from "../middleware/workspace-routing"
import { ApiBadRequestError, ApiNotFoundError } from "../errors"

export const ContinuityApi = HttpApi.make("continuity").add(
  HttpApiGroup.make("continuity")
    .add(
      HttpApiEndpoint.post("resolveModel", "/continuity/:sessionID/model-resolution", {
        params: { sessionID: SessionID },
        payload: Schema.Struct({
          explicitAgent: Schema.optional(Schema.String),
          explicitModel: Schema.optional(Schema.String),
          explicitVariant: Schema.optional(Schema.String),
        }),
        success: Schema.Unknown,
        error: [ApiNotFoundError, ApiBadRequestError],
      }),
      HttpApiEndpoint.get("list", "/continuity/:sessionID", {
        params: { sessionID: SessionID },
        success: Schema.Unknown,
        error: ApiNotFoundError,
      }),
      HttpApiEndpoint.post("cancel", "/continuity/:sessionID/:jobID/cancel", {
        params: { sessionID: SessionID, jobID: Schema.String },
        success: Schema.Unknown,
        error: [ApiNotFoundError, ApiBadRequestError],
      }),
      HttpApiEndpoint.get("usage", "/usage", {
        query: { days: Schema.optional(Schema.String), project: Schema.optional(Schema.String) },
        success: Schema.Unknown,
        error: ApiBadRequestError,
      }),
    )
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
