import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/mflow"

export const MflowActivatePayload = Schema.Struct({
  relayMode: Schema.Literals(["local", "public", "legacy-public", "remote", "custom"]),
  signaling: Schema.optional(Schema.String),
  room: Schema.optional(Schema.String),
  secret: Schema.optional(Schema.String),
  generateSecret: Schema.optional(Schema.Boolean),
  storeSecret: Schema.optional(Schema.Boolean),
  hookPriority: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(9)),
  ),
  publicRelayNoticeAccepted: Schema.optional(Schema.Boolean),
})

export const MflowPaths = {
  status: root,
  activate: `${root}/activate`,
  scan: `${root}/scan`,
  relayGuide: `${root}/relay-guide`,
  deactivate: `${root}/deactivate`,
  remove: `${root}/remove`,
} as const

export const MflowApi = HttpApi.make("mflow")
  .add(
    HttpApiGroup.make("mflow")
      .add(
        HttpApiEndpoint.get("status", MflowPaths.status, {
          success: described(Schema.Unknown, "mflow status"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mflow.status",
            summary: "Get mflow status",
            description: "Get MendCode's mflow activation, config, daemon, and lock status.",
          }),
        ),
        HttpApiEndpoint.post("activate", MflowPaths.activate, {
          payload: MflowActivatePayload,
          success: described(Schema.Unknown, "mflow activation status"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mflow.activate",
            summary: "Activate mflow",
            description: "Configure mflow, MCP, and pre-edit lock scaffolding for the active project.",
          }),
        ),
        HttpApiEndpoint.get("scan", MflowPaths.scan, {
          success: described(Schema.Unknown, "detected relays"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mflow.scan",
            summary: "Scan mflow relays",
            description: "Scan localhost and local LAN candidates for visible mflow relays.",
          }),
        ),
        HttpApiEndpoint.get("relayGuide", MflowPaths.relayGuide, {
          success: described(Schema.Unknown, "local relay guide"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mflow.relayGuide",
            summary: "Get local mflow relay guide",
            description: "Get local relay command guidance until mflow ships a packaged relay start command.",
          }),
        ),
        HttpApiEndpoint.post("deactivate", MflowPaths.deactivate, {
          success: described(Schema.Unknown, "mflow status"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mflow.deactivate",
            summary: "Deactivate mflow",
            description: "Disable MendCode mflow integration without deleting local configuration.",
          }),
        ),
        HttpApiEndpoint.post("remove", MflowPaths.remove, {
          success: described(Schema.Unknown, "mflow status"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mflow.remove",
            summary: "Remove mflow config",
            description: "Remove local mflow config and generated MendCode integration files.",
          }),
        ),
      )
      .annotateMerge(OpenApi.annotations({ title: "mflow", description: "MendCode mflow routes." }))
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
