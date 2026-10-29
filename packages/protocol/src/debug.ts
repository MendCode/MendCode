import { z } from "zod"
import { lazySchema } from "./lazy"

const argument = z.string().min(1).max(4096)
export const DebugInput = lazySchema(() => z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.enum(["config", "info", "paths", "projects", "skills", "startup", "file.status", "snapshot.track"]) }),
  z.strictObject({ operation: z.literal("agent"), name: z.string().min(1).max(100), tool: z.string().min(1).max(100).optional(), params: z.record(z.string(), z.unknown()).optional(), approve: z.boolean().optional() }),
  z.strictObject({ operation: z.enum(["file.read", "file.list", "file.tree", "lsp.diagnostics", "lsp.document-symbols"]), path: argument }),
  z.strictObject({ operation: z.enum(["file.search", "lsp.symbols"]), query: z.string().max(1000) }),
  z.strictObject({ operation: z.enum(["snapshot.patch", "snapshot.diff"]), hash: z.string().regex(/^[a-f0-9]{40,64}$/) }),
]))
export type DebugInput = z.infer<typeof DebugInput>
export type DebugReport = { operation: DebugInput["operation"]; data: unknown; truncated?: boolean }
export type DatabaseReport = { path: string; columns?: string[]; rows?: Record<string, unknown>[]; truncated?: boolean }
