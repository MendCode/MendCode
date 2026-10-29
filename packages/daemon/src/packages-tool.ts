import { defineTool, fail } from "@mendcode/tools"
import { z } from "zod"

export const packageMutation = (action: string) => !["list", "info", "search", "check"].includes(action)

export const packagesTool = defineTool({
  name: "packages",
  tier: "balanced",
  description: "Manage MendCode packages: list, info (contents, capabilities, precedence and overlays), search configured sources, install, enable, disable, switch-look, remove to Trash, new scaffold, check. Local only. Use exact installed key or configured sourceId/name. Mutations always need approval; project mutations require trust. Skill packages coexist; switch-look explicitly replaces the scope's look.",
  permission: "write",
  args: z.strictObject({
    action: z.enum(["list", "info", "search", "install", "enable", "disable", "switch-look", "remove", "new", "check"]),
    name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/).optional(),
    key: z.string().regex(/^(user|project):[a-z0-9][a-z0-9._-]{0,63}$/).optional(),
    sourceId: z.string().min(1).max(80).optional(),
    scope: z.enum(["user", "project"]).optional(),
    query: z.string().max(500).optional(),
    replace: z.boolean().optional(),
  }),
  permissionFor: (input) => packageMutation(input.action) ? "write" : "read",
  approvalFor: (input) => packageMutation(input.action),
  async preview(input, context) {
    if (!context.packages) return "Packages unavailable; no changes will run"
    try { return await context.packages.preview(input) } catch (error) { return `Refused: ${error instanceof Error ? error.message : "package preview failed"}` }
  },
  async execute(input, context) {
    if (!context.packages) return fail({ title: "packages", message: "Packages unavailable or local only" })
    try {
      const result = await context.packages.run(input)
      return { title: `packages ${input.action}`, output: JSON.stringify(result), truncated: false, isError: false }
    } catch (error) { return fail({ title: `packages ${input.action}`, message: error instanceof Error ? error.message : "Package operation failed" }) }
  },
})
