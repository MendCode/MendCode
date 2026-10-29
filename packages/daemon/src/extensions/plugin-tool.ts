import { z } from "zod"
import type { PluginTool } from "@mendcode/extension-api/plugin"

/** Runtime helper for the legacy package name; the implementation and schemas stay daemon-side. */
export const tool = Object.assign(<T extends PluginTool>(definition: T): T => definition, { schema: z })

let registered = false
export function registerPluginToolImports() {
  if (registered) return
  registered = true
  Bun.plugin({ name: "mendcode-plugin-tool", target: "bun", setup(builder) {
    for (const name of ["@mendcode/plugin", "@mendcode/plugin/tool", "@opencode-ai/plugin", "@opencode-ai/plugin/tool"]) builder.module(name, () => ({ exports: { tool }, loader: "object" }))
  } })
}
