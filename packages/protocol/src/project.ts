import { z } from "zod"
import { PromptFocusChoice } from "./prompt"
import { lazySchema } from "./lazy"

const text = z.string().max(500)
export const ProjectPackagePatch = lazySchema(() => z.strictObject({
  id: text.optional(), title: text.optional(), description: z.string().max(2000).optional(),
  version: text.optional(), kind: text.optional(), channel: text.optional(),
  sourceType: text.optional(), sourceURL: z.string().max(4096).optional(),
  compatMendcode: text.optional(), compatRuntimePack: text.optional(),
}))
export const ProjectControlInput = lazySchema(() => z.union([
  z.strictObject({ operation: z.enum(["init", "config-show", "context-status", "context-refresh", "context-show", "focus-status", "focus-list", "package-show"]) }),
  z.strictObject({ operation: z.literal("focus-show"), focusID: PromptFocusChoice.optional() }),
  z.strictObject({ operation: z.literal("focus-use"), focusID: PromptFocusChoice }),
  z.strictObject({ operation: z.literal("package-set"), patch: ProjectPackagePatch }),
]))

export type ProjectPackagePatch = z.infer<typeof ProjectPackagePatch>
