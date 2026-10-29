import { z } from "zod"
import { ClientId, CommandId } from "./ids"
import { CatalogProvider, McpConfigInput } from "./catalog"
import { lazySchema } from "./lazy"

const text = z.string().min(1).max(4096)
const method = z.int().min(0).max(63)
const token = z.string().min(1).max(16384)
export const RestCredential = lazySchema(() => z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("api"), key: token, metadata: z.record(z.string(), z.string()).optional() }),
  z.strictObject({ type: z.literal("oauth"), access: token, refresh: z.string().max(16384), expires: z.number().finite().nonnegative(), accountId: text.optional(), enterpriseUrl: text.optional() }),
  z.strictObject({ type: z.literal("wellknown"), key: text, token: text }),
]))
export type RestCredential = z.infer<typeof RestCredential>
export const RestProviderAuthorize = lazySchema(() => z.strictObject({ method, inputs: z.record(z.string().max(64), z.string().max(4096)).optional() }))
export const RestProviderCallback = lazySchema(() => z.strictObject({ method, code: text.optional() }))
const common = { enabled: z.boolean().optional(), timeout: z.int().min(1).max(600_000).optional() }
export const RestMcpConfig = lazySchema(() => z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("local"), command: z.array(text).min(1).max(101), cwd: text.optional(), environment: z.record(z.string(), z.string()).optional(), ...common }),
  z.strictObject({ type: z.literal("remote"), url: z.string().url().max(2048), headers: z.record(z.string(), z.string()).optional(), oauth: McpConfigInput.shape.oauth, ...common }),
]))
export type RestMcpConfig = z.infer<typeof RestMcpConfig>
export const RestMcpAdd =z.strictObject({ name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/), config: RestMcpConfig })
export const RestMcpCallback = lazySchema(() => z.strictObject({ code: text }))
export const RestTool = lazySchema(() => z.strictObject({ id: z.string(), description: z.string(), parameters: z.record(z.string(), z.unknown()) }))
export type RestTool = z.infer<typeof RestTool>
export const RestLspStatus = lazySchema(() => z.strictObject({ id: z.string(), name: z.string(), root: z.string(), status: z.enum(["connected", "error"]) }))
export type RestLspStatus = z.infer<typeof RestLspStatus>

export const CatalogRestInput = lazySchema(() => z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.enum(["providers", "config-providers", "auth-methods", "lsp", "commands"]) }),
  z.strictObject({ operation: z.enum(["tools", "tool-ids"]), provider: CatalogProvider.optional(), model: z.string().min(1).max(100).optional() }),
  z.strictObject({ operation: z.literal("auth-set"), provider: CatalogProvider, credential: RestCredential }),
  z.strictObject({ operation: z.literal("auth-remove"), provider: CatalogProvider }),
  RestProviderAuthorize.extend({ operation: z.literal("oauth-authorize"), provider: CatalogProvider }),
  RestProviderCallback.extend({ operation: z.literal("oauth-callback"), provider: CatalogProvider }),
  z.strictObject({ operation: z.enum(["mcp-connect", "mcp-disconnect", "mcp-authenticate"]), server: text }),
  RestMcpCallback.extend({ operation: z.literal("mcp-callback"), server: text }),
]))
export type CatalogRestInput = z.infer<typeof CatalogRestInput>
/** Full authority: catalogs can load extensions/contact MCP, and auth commands handle credentials. */
export const CatalogRest = lazySchema(() => z.strictObject({ id: CommandId, clientId: ClientId, type: z.literal("catalog.rest"), directory: text, input: CatalogRestInput }))
