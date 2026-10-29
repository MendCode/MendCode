import { z } from "zod"
import { ClientId, CommandId } from "./ids"
import { ProjectRuntimeConfig, Settings } from "./queries"
import { MemoryConfigPatch } from "./memory-control"
import { RestMcpConfig } from "./catalog-rest"
import { lazySchema } from "./lazy"

const base = { id: CommandId, clientId: ClientId }
const directory = z.string().min(1).max(4096)
const model = lazySchema(() => z.string().regex(/^[^/\s]+\/[^\s]+$/).max(300))
const aliases = {
  $schema: z.string().max(2048).optional(),
  model: model.optional(), small_model: model.optional(), subagent_model: model.optional(),
  subagent_variant: z.string().min(1).max(100).optional(),
  default_agent: z.string().min(1).max(64).optional(),
}
/** Donor `mcp` entries: a full local/remote server, or `{enabled}` to toggle one that exists. Secret-looking values read back as REDACTED_VALUE and keep their stored value when sent unchanged. */
export const REDACTED_VALUE = "[redacted:secret]"
export const RestMcpPatch = lazySchema(() => z.union([RestMcpConfig, z.strictObject({ enabled: z.boolean() })]))
const mcp = lazySchema(() => z.record(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/), RestMcpPatch).refine((value) => Object.keys(value).length <= 100, "at most 100 servers"))
/** Donor `plugin`: a specifier, or `[specifier, options]`. New specifiers install through the daemon's offline plugin installer. */
export const RestPluginSpec = lazySchema(() => z.union([
  z.string().min(1).max(1024),
  z.tuple([z.string().min(1).max(1024), z.record(z.string().max(100), z.json()).refine((value) => JSON.stringify(value).length <= 16_384, "options too large")]),
]))
const plugin = lazySchema(() => z.array(RestPluginSpec).max(64))
/** Donor `server`: listener settings stored for the next start. The listener stays opt-in and loopback-only, so hostnames beyond loopback are refused. */
export const RestServerConfig = lazySchema(() => z.strictObject({
  port: z.number().int().min(0).max(65535).optional(),
  hostname: z.enum(["127.0.0.1", "::1", "localhost"]).optional(),
  cors: z.array(z.string().url().max(2048)).max(64).optional(),
  mdns: z.boolean().optional(),
  mdnsDomain: z.string().regex(/^[a-zA-Z0-9-]+\.local$/).max(253).optional(),
}))
export const RestConfig = lazySchema(() => Settings.omit({ projectConfig: true }).extend({
  ...aliases, plan_exit_agent: z.string().min(1).max(64).optional(),
  mcp: mcp.optional(), plugin: plugin.optional(), server: RestServerConfig.optional(),
}))
export type RestConfig = z.infer<typeof RestConfig>
const sourcePaths = lazySchema(() => z.array(z.string().min(1).max(4096)).max(100))
export const RestProjectConfig = lazySchema(() => ProjectRuntimeConfig.extend({
  ...MemoryConfigPatch.shape, ...aliases, instructions: sourcePaths.optional(),
  skills: z.strictObject({ paths: sourcePaths.optional(), urls: z.array(z.string().url().max(4096)).max(100).optional() }).optional(),
  mcp: mcp.optional(), plugin: plugin.optional(),
}))
export const RestLogInput = lazySchema(() => z.strictObject({
  service: z.string().min(1).max(100), level: z.enum(["debug", "info", "warn", "error"]),
  message: z.string().max(32_000), extra: z.record(z.string().max(100), z.unknown()).optional(),
}))
export type RestLogInput = z.infer<typeof RestLogInput>
export const RestUpgradeInput = lazySchema(() => z.strictObject({ target: z.string().min(1).max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/).optional() }))
export type RestUpgradeInput = z.infer<typeof RestUpgradeInput>
export const RestUpgradeResult = lazySchema(() => z.discriminatedUnion("success", [
  z.strictObject({ success: z.literal(true), version: z.string().min(1).max(100) }),
  z.strictObject({ success: z.literal(false), error: z.string().max(1000) }),
]))
export type RestUpgradeResult = z.infer<typeof RestUpgradeResult>
export const ServerHealth = lazySchema(() => z.strictObject({ ...base, type: z.literal("server.health") }))
export const ServerMemory = lazySchema(() => z.strictObject({ ...base, type: z.literal("server.memory") }))
export const ServerConfigGet = lazySchema(() => z.strictObject({ ...base, type: z.literal("server.config.get"), directory: directory.optional() }))
export const ServerConfigUpdate = lazySchema(() => z.strictObject({ ...base, type: z.literal("server.config.update"), directory: directory.optional(), patch: RestConfig }))
export const ServerDispose = lazySchema(() => z.strictObject({ ...base, type: z.literal("server.dispose"), directory: directory.optional() }))
export const AppLog = lazySchema(() => z.strictObject({ ...base, type: z.literal("app.log"), input: RestLogInput }))
export const ServerUpgrade = lazySchema(() => z.strictObject({ ...base, type: z.literal("server.upgrade"), input: RestUpgradeInput }))

export const ProcessMemory = lazySchema(() => z.strictObject({
  pid: z.number().int().positive(), role: z.literal("server"),
  rss: z.number().nonnegative(), heapTotal: z.number().nonnegative(), heapUsed: z.number().nonnegative(),
  external: z.number().nonnegative(), arrayBuffers: z.number().nonnegative(), uptimeSeconds: z.number().nonnegative(),
  memoryGuardrail: z.strictObject({ status: z.enum(["ok", "warning", "critical"]), warnBytes: z.number(), criticalBytes: z.number() }),
}))
export type ProcessMemory = z.infer<typeof ProcessMemory>
export type RestServerEvent = { directory?: string; payload: { id: string; type: string; properties: Record<string, unknown> } }
