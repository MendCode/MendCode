import { z } from "zod"
import { lazySchema } from "./lazy"

export const LspOperation = z.enum([
  "goToDefinition", "findReferences", "hover", "documentSymbol", "workspaceSymbol",
  "goToImplementation", "prepareCallHierarchy", "incomingCalls", "outgoingCalls",
])
export type LspOperation = z.infer<typeof LspOperation>

/** Editor coordinates are 1-based; LSP wire coordinates remain 0-based. */
export const LspInput = lazySchema(() => z.strictObject({
  operation: LspOperation,
  filePath: z.string().min(1).max(4096),
  line: z.number().int().positive(),
  character: z.number().int().positive(),
  query: z.string().max(4096).optional(),
}))
export type LspInput = z.infer<typeof LspInput>

export const LspReport = lazySchema(() => z.strictObject({
  result: z.array(z.unknown()),
  unavailable: z.string().optional(),
  issues: z.array(z.strictObject({ server: z.string(), message: z.string() })).optional(),
}))
export type LspReport = z.infer<typeof LspReport>
