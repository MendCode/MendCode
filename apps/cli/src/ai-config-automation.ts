import path from "node:path"
import type { CommandInput } from "@mendcode/client"
import type { AIConfigInput, AIConfigPlan, SessionId } from "@mendcode/protocol"
import type { AIConfigAutomation } from "./ai-config-args"

type Reply = { ok: true; result: Record<string, unknown> } | { ok: false; message: string; code: string }
export function createAIConfigAutomation(ctx: {
  directory: string
  readJson?(file: string): Promise<unknown>
  request(command: CommandInput): Promise<Reply>
  result(data: Record<string, unknown>, human: string): number
  fail(message: string, exit?: number, code?: string): number
}) {
  return async (command: AIConfigAutomation) => {
    try {
      let body: Record<string, unknown> = {}
      if (command.input || command.file) {
        const value: unknown = command.input ? JSON.parse(command.input) : await (ctx.readJson ?? ((file) => Bun.file(file).json()))(path.resolve(ctx.directory, command.file!))
        if (!value || typeof value !== "object" || Array.isArray(value)) return ctx.fail("AI configuration input must be a JSON object", 64, "usage")
        body = value as Record<string, unknown>
      }
      const saved = body as unknown as AIConfigPlan
      const target = command.target ?? (typeof body.target === "string" ? body.target : saved.target?.path)
      const scope = command.scope ?? body.scope ?? saved.target?.scope ?? "project"
      const expectedHash = command.expectedHash ?? body.expectedHash
      let config: AIConfigInput
      if (command.action === "inspect") config = { action: "inspect" }
      else if (command.action === "plan") config = { ...body, scope, ...(target ? { target } : {}), action: "plan" } as AIConfigInput
      else config = { action: "validate", scope, target, ...(expectedHash ? { expectedHash } : {}), patch: body.patch ?? body } as AIConfigInput
      if (command.action === "apply") {
        if (!command.yes || !expectedHash || !target) return ctx.fail("Apply requires --yes, target and expectedHash from the preview", 64, "usage")
        const checked = await ctx.request({ type: "ai.config", directory: ctx.directory, input: config })
        if (!checked.ok) return ctx.fail(checked.message, 1, checked.code)
        if (!checked.result.valid) return ctx.fail(JSON.stringify(checked.result.issues), 1, "validation")
        const created = await ctx.request({ type: "session.create", directory: ctx.directory, title: "AI configuration change" })
        if (!created.ok) return ctx.fail(created.message, 1, created.code)
        config = { ...config, action: "apply", sessionId: created.result.sessionId as SessionId, expectedHash, confirm: true } as AIConfigInput
      }
      const reply = await ctx.request({ type: "ai.config", directory: ctx.directory, input: config })
      if (!reply.ok) return ctx.fail(reply.message, 1, reply.code)
      const exit = ctx.result(reply.result, JSON.stringify(reply.result, null, 2) + "\n")
      return reply.result.action === "validate" && reply.result.valid === false ? 1 : exit
    } catch (error) { return ctx.fail(error instanceof Error ? error.message : String(error), 64, "usage") }
  }
}
