import { z } from "zod"
import { TUI_OPERATIONS, tuiProblems } from "./tui-data"
import { lazySchema } from "./lazy"

export const TuiProfilePatch = lazySchema(() => z.record(z.string().max(64), z.json()).superRefine((value, ctx) => {
  for (const issue of tuiProblems(value)) ctx.addIssue({ code: "custom", message: issue })
}))
export const TuiControlInput = lazySchema(() => z.strictObject({
  operation: z.enum(TUI_OPERATIONS),
  argument: z.string().max(4096).optional(),
  profile: TuiProfilePatch.optional(),
  state: z.enum(["home", "session"]).optional(),
  dryRun: z.boolean().optional(),
  check: z.boolean().optional(),
  frames: z.array(z.strictObject({ name: z.string().regex(/^[a-z0-9-]{1,80}$/), lines: z.array(z.string().max(1000).refine((line) => !/[\x00-\x1f\x7f]/.test(line))).max(200) })).max(8).optional(),
}))
