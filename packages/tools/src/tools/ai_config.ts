import { AIConfigInput } from "@mendcode/protocol"
import { z } from "zod"
import { defineTool } from "../tool"
import { fail, truncateText } from "../util"

export const aiConfigTool = defineTool({
  name: "ai_config",
  description: "Inspect configured models and roles, plan a no-write recipe preview, validate its exact diff, or explicitly apply it with expectedHash. Never calls providers, activates a recipe, changes the session model, or starts a workflow. Targets are project/global recipe files; cascade/critic require compound execution.",
  permission: "write",
  args: z.discriminatedUnion("action", [
    AIConfigInput.options[0], AIConfigInput.options[1], AIConfigInput.options[2],
    AIConfigInput.options[3].omit({ sessionId: true, confirm: true }),
  ]),
  permissionFor: (args) => args.action === "apply" ? args.scope === "global" ? "execute" : "write" : "read",
  async preview(args, context) {
    if (args.action !== "apply" || !context.aiConfig) return undefined
    try {
      const checked = await context.aiConfig.run({ ...args, action: "validate" })
      if (checked.action !== "validate") return undefined
      return `${checked.target.scope} recipe: ${checked.target.path}\n${checked.valid ? checked.diff.join("\n") : checked.issues.map((issue) => issue.message).join("\n")}`
    } catch { return undefined }
  },
  async execute(args, context) {
    const title = `AI configuration ${args.action}`
    if (!context.aiConfig) return fail({ title, message: "AI configuration is unavailable here" })
    if (context.signal.aborted) return fail({ title, message: "AI configuration cancelled" })
    try {
      const report = await context.aiConfig.run(args)
      const output = truncateText({ text: JSON.stringify(report, null, 2) })
      return { title, output: output.text, truncated: output.truncated, isError: report.action === "validate" && !report.valid, meta: { action: args.action } }
    } catch (error) { return fail({ title, message: error instanceof Error ? error.message : String(error) }) }
  },
})
