import path from "node:path"
import type { CommandInput } from "@mendcode/client"
import type { Common } from "./automation"
import type { ThemeAutomation } from "./theme-args"

type Context = {
  directory: string
  allowFiles?: boolean
  request(command: CommandInput): Promise<{ ok: true; result: Record<string, unknown> } | { ok: false; code: string; message: string }>
  result(data: Record<string, unknown>, human: string): number
  fail(message: string, exit?: number, code?: string): number
}

export function createThemeAutomation(ctx: Context) {
  return async (command: ThemeAutomation & Common) => {
    if (ctx.allowFiles === false && command.kind !== "theme.select") return ctx.fail("theme files disabled while remote", 64, "usage")
    const request: CommandInput = command.kind === "theme.select"
      ? { type: command.kind, directory: ctx.directory, name: command.name, scope: command.scope }
      : command.kind === "theme.install"
        ? { type: command.kind, directory: ctx.directory, file: path.resolve(ctx.directory, command.file), ...(command.name ? { name: command.name } : {}), scope: command.scope }
        : { type: command.kind, file: path.resolve(ctx.directory, command.file) }
    const reply = await ctx.request(request)
    if (!reply.ok) return ctx.fail(reply.message, 1, reply.code)
    ctx.result(reply.result, JSON.stringify(reply.result, null, 2) + "\n")
    return reply.result.ok === false ? 1 : 0
  }
}
