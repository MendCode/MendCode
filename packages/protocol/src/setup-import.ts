import { z } from "zod"
import { lazySchema } from "./lazy"

/**
 * `/import setup`: what another agent's setup (Claude Code or Codex) holds that MendCode can take over, and with
 * `apply` what was written. The report never carries a secret value: a credential in an env var or header is left out
 * and named in `needs` as the variable the new entry reads (`${NAME}`).
 */
export const SetupImportTool = z.enum(["claude-code", "codex"])
export const SetupImportItem = lazySchema(() => z.strictObject({
  kind: z.enum(["mcp", "command", "instructions"]),
  name: z.string().max(200),
  tool: SetupImportTool,
  scope: z.enum(["user", "project"]),
  /** `new` is what apply would write; `imported` was written; `exists` kept the entry already there; `skipped` cannot be taken over safely. */
  status: z.enum(["new", "imported", "exists", "skipped", "failed"]),
  enabled: z.boolean().optional(),
  note: z.string().max(300).optional(),
  needs: z.array(z.string().max(200)).max(32).optional(),
}))
export type SetupImportItem = z.infer<typeof SetupImportItem>
export const SetupImportReport = lazySchema(() => z.strictObject({
  applied: z.boolean(),
  found: z.array(z.strictObject({ tool: SetupImportTool, file: z.string().max(4096) })).max(32),
  items: z.array(SetupImportItem).max(400),
  /** Folders MendCode already reads from the other tool without a copy (skills, commands, agents, instructions). */
  inPlace: z.array(z.string().max(300)).max(16),
  /** Parts of the other setup that are never taken over, with the reason. */
  notImported: z.array(z.string().max(300)).max(16),
}))
export type SetupImportReport = z.infer<typeof SetupImportReport>
