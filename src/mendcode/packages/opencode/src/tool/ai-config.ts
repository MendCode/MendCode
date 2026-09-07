import { Effect, Schema } from "effect"
import * as AIConfig from "@/config/ai"
import * as AIConfiguration from "@/mend/runtime/ai-configuration"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  action: Schema.Literals(["inspect", "plan", "validate", "apply"]),
  candidates: Schema.optional(Schema.Array(AIConfig.ModelRef)),
  intent: Schema.optional(Schema.Literals(["economical", "balanced", "quality"])),
  taskKind: Schema.optional(Schema.Literals(["repair", "terminal", "frontend", "architecture", "review", "general"])),
  selectedRoles: Schema.optional(Schema.Array(Schema.String)),
  profileName: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.Literals(["project", "global"])),
  target: Schema.optional(Schema.String),
  patch: Schema.optional(Schema.Unknown),
  expectedHash: Schema.optional(Schema.String),
})

export const AIConfigTool = Tool.define(
  "ai_config",
  Effect.gen(function* () {
    const service = yield* AIConfiguration.Service

    return {
      description:
        "Inspect actual provider/model configuration, prepare a no-write plan, validate a preview, or explicitly apply an exact ai/compaction patch. Inspect, plan and validate never call providers or write files. Apply never starts a workflow or changes the active session model.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const action: string = params.action
          if (params.action === "inspect") {
            const result = yield* service.inspect()
            return { title: "AI configuration inventory", metadata: { action }, output: JSON.stringify(result, null, 2) }
          }

          if (params.action === "plan") {
            if (!params.intent || !params.taskKind) throw new Error("ai_config plan requires intent and taskKind")
            const result = yield* service.plan({
              candidates: params.candidates ?? [],
              intent: params.intent,
              taskKind: params.taskKind,
              ...(params.selectedRoles ? { selectedRoles: params.selectedRoles } : {}),
              ...(params.scope ? { scope: params.scope } : {}),
              ...(params.target ? { target: params.target } : {}),
              ...(params.profileName ? { profileName: params.profileName } : {}),
            })
            return { title: "AI configuration preview", metadata: { action }, output: JSON.stringify(result, null, 2) }
          }

          if (params.patch === undefined) throw new Error(`ai_config ${params.action} requires patch`)
          if (params.action === "validate") {
            const result = yield* service.validate({
              patch: params.patch,
              ...(params.scope ? { scope: params.scope } : {}),
              ...(params.target ? { target: params.target } : {}),
              ...(params.expectedHash ? { expectedHash: params.expectedHash } : {}),
            })
            return { title: "AI configuration validation", metadata: { action }, output: JSON.stringify(result, null, 2) }
          }

          if (!params.scope || !params.expectedHash) throw new Error("ai_config apply requires scope and expectedHash")
          const result = yield* service.apply({
            scope: params.scope,
            ...(params.target ? { target: params.target } : {}),
            patch: params.patch,
            expectedHash: params.expectedHash,
            causalSessionID: ctx.sessionID,
          }, ctx.ask)
          return { title: "AI configuration applied", metadata: { action }, output: JSON.stringify(result, null, 2) }
        }).pipe(Effect.orDie),
    }
  }),
)
