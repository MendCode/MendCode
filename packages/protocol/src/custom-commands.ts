import { z } from "zod"
import { lazySchema } from "./lazy"

export const CommandDefinition = lazySchema(() => z.strictObject({
  template: z.string().min(1).max(32_000),
  description: z.string().max(120).optional(),
  "argument-hint": z.string().max(60).optional(),
  agent: z.string().min(1).max(100).optional(),
  model: z.string().min(1).max(200).optional(),
  subtask: z.boolean().optional(),
}))

export type CommandDefinition = z.infer<typeof CommandDefinition>
export type CommandSummary = {
  name: string
  description: string
  argumentHint: string
  source: "project" | "user" | "builtin" | "mcp"
  pkg?: string
  agent?: string
  model?: string
  subtask?: boolean
  /** `allowed-tools` as another tool wrote it: shown, never applied. */
  allowedTools?: string[]
  /** From another tool's folder or a skill: `model` and `agent` apply only when they exist here. */
  foreign?: boolean
  /** A skill run as `/name`; its body is read when the command runs. */
  skill?: boolean
}
