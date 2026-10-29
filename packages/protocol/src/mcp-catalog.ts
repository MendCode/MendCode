import { z } from "zod"
import { lazySchema } from "./lazy"

const entry = { server: z.string(), id: z.string(), name: z.string(), description: z.string().optional(), mimeType: z.string().optional() }
export const McpResource = lazySchema(() => z.strictObject({ ...entry, uri: z.string() }))
export const McpResourceTemplate = lazySchema(() => z.strictObject({ ...entry, uriTemplate: z.string() }))
export const McpPrompt = lazySchema(() => z.strictObject({ server: z.string(), id: z.string(), name: z.string(), description: z.string().optional(), arguments: z.array(z.strictObject({ name: z.string(), description: z.string().optional(), required: z.boolean().optional() })).optional() }))
export const McpResourceContent = lazySchema(() => z.strictObject({ uri: z.string(), mimeType: z.string().optional(), text: z.string().optional(), blob: z.string().optional() }))
export const McpPromptResult = lazySchema(() => z.strictObject({ description: z.string().optional(), messages: z.array(z.strictObject({ role: z.enum(["user", "assistant"]), content: z.record(z.string(), z.unknown()) })) }))
export const McpCatalogReport = lazySchema(() => z.strictObject({ resources: z.array(McpResource), templates: z.array(McpResourceTemplate), prompts: z.array(McpPrompt), issues: z.array(z.strictObject({ source: z.string(), server: z.string().optional(), message: z.string() })) }))
export type McpCatalogReport = z.infer<typeof McpCatalogReport>
export type McpResourceContent = z.infer<typeof McpResourceContent>
export type McpPromptResult = z.infer<typeof McpPromptResult>
