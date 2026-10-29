import path from "node:path"
import type { CacheStatus } from "@mendcode/protocol"
import type { CacheAutomation } from "./cache-args"
import type { AutomationDeps } from "./automation"

const clean = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
export function cacheText(report: CacheStatus) {
  return [`Prompt cache: ${report.mode}`, `Project: ${clean(report.project)}`, `Scope: ${report.scope}`, `Selection: ${report.source} · ${report.reason}`, "Active keeper: disabled", `Configuration: ${report.configured ? JSON.stringify(report.configured) : "legacy provider behavior (no cache override)"}`].join("\n") + "\n"
}
export function createCacheAutomation(ctx: Pick<AutomationDeps, "client"> & { directory: string; result(data: Record<string, unknown>, human: string): number; fail(message: string, exit?: number, code?: string): number }) {
  return async (command: CacheAutomation) => {
    const target = { ...command.target, directory: ctx.directory, ...(command.target.projectPath ? { projectPath: path.resolve(ctx.directory, command.target.projectPath) } : {}) }
    const reply = await ctx.client.send(command.operation === "status" ? { type: "cache.status", ...target } : { type: "cache.set", input: { ...target, action: command.operation } })
    if (!reply.ok) return ctx.fail(reply.error.message, 1, reply.error.code)
    const report = reply.result as CacheStatus
    return ctx.result(reply.result ?? {}, `${command.operation === "status" ? "" : command.operation === "enable" ? "Enabled prompt cache policy.\n" : "Disabled prompt cache policy.\n"}${cacheText(report)}`)
  }
}
