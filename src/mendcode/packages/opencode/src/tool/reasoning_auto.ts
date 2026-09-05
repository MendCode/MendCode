import { Effect, Schema } from "effect"
import { Config } from "@/config/config"
import * as Tool from "./tool"

const Parameters = Schema.Struct({
  reason: Schema.Literals(["verification_failed", "technical_block"]),
  evidence: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(1000))),
})

export const ReasoningAutoTool = Tool.define("reasoning_auto", Effect.gen(function* () {
  const config = yield* Config.Service
  return {
    description: "Request one supported reasoning increase, capped at high, for this turn after a relevant verification failure or explicit technical block. Explain concrete evidence. Never use for network failures, permission requests, pending questions or routine work. Manual reasoning selection always wins; this tool never changes model or service tier.",
    parameters: Parameters,
    execute: (args, ctx) => Effect.gen(function* () {
      const cfg = yield* config.get()
      const user = [...ctx.messages].reverse().find((message) => message.info.role === "user")
      const manual = user?.info.role === "user" ? user.info.model.variant : undefined
      const enabled = cfg.experimental?.reasoning_auto === true && !manual
      const result = enabled
        ? { signal: args.reason, evidence: args.evidence, status: "requested" }
        : { status: "unchanged", reason: manual ? "Manual reasoning selection takes precedence." : "Reasoning Auto is disabled." }
      return { title: enabled ? "Reasoning Auto: increase requested" : "Reasoning unchanged", metadata: result, output: JSON.stringify(result) }
    }),
  } satisfies Tool.DefWithoutID<typeof Parameters>
}))
