import { z } from "zod"
import { ClientId, CommandId } from "./ids"
import { lazySchema } from "./lazy"

export const HttpServerConfig = lazySchema(() => z.strictObject({
  enabled: z.boolean().default(false),
  port: z.number().int().min(0).max(65535).default(0),
  hostname: z.enum(["127.0.0.1", "::1", "localhost"]).default("127.0.0.1"),
  cors: z.array(z.string().url().max(2048)).max(64).default([]),
  mdns: z.boolean().default(false),
  mdnsDomain: z.string().regex(/^[a-zA-Z0-9-]+\.local$/).max(253).default("mendcode.local"),
  username: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/).default("mendcode"),
  pty: z.boolean().default(false),
  /** Browser editor saves (`file.edit`); off by default, full tokens only. */
  edit: z.boolean().default(false),
}))
export type HttpServerConfig = z.infer<typeof HttpServerConfig>

const base = { id: CommandId, clientId: ClientId }
export const WorkspaceQuery = lazySchema(() => z.strictObject({ ...base, type: z.literal("workspace.query"), operation: z.enum(["list", "adapters", "status"]).default("list") }))
export const WorkspaceCreate = lazySchema(() => z.strictObject({ ...base, type: z.literal("workspace.create"), name: z.string().min(1).max(100), directory: z.string().min(1).max(4096), adapter: z.literal("local").default("local") }))
export const WorkspaceRemove = lazySchema(() => z.strictObject({ ...base, type: z.literal("workspace.remove"), workspaceId: z.string().regex(/^ws_[a-f0-9]{24}$/) }))

export type WorkspaceInfo = { id: string; name: string; directory: string; type: "local" }
