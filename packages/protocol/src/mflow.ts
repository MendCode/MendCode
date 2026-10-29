import { z } from "zod"
import { lazySchema } from "./lazy"

const text = z.string().min(1).max(4096).refine((value) => !/[\x00-\x1f\x7f]/.test(value), "control characters are not allowed")
export const MflowActivation = lazySchema(() => z.strictObject({
  room: text.max(200).optional(),
  relayMode: z.literal("local").optional(),
  signaling: text.max(500).optional(),
  tokenFile: text.optional(),
  hookPriority: z.number().int().min(0).max(9).optional(),
}))
export type MflowActivation = z.infer<typeof MflowActivation>
export const MflowRead = lazySchema(() => z.strictObject({ operation: z.enum(["status", "scan", "relay-guide", "doctor", "legacy-status"]) }))
export type MflowRead = z.infer<typeof MflowRead>
export const MflowChange = lazySchema(() => z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.enum(["activate", "setup"]), input: MflowActivation }),
  z.strictObject({ operation: z.enum(["deactivate", "remove", "plan", "start", "stop"]) }),
]))
export type MflowChange = z.infer<typeof MflowChange>
export const MflowLease = lazySchema(() => z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("join"), ttlMs: z.number().int().min(1000).max(120_000).optional() }),
  z.strictObject({ action: z.literal("leave") }),
  z.strictObject({ action: z.literal("acquire"), files: z.array(text).min(1).max(128), mode: z.enum(["read", "write"]).default("write"), ttlMs: z.number().int().min(1000).max(120_000).optional() }),
  z.strictObject({ action: z.enum(["renew", "release"]), leaseId: text.max(100) }),
]))
export type MflowLease = z.infer<typeof MflowLease>
export const MflowLock = lazySchema(() => z.strictObject({ leaseId: text.max(100), owner: text.max(100), files: z.array(text).max(128), mode: z.enum(["read", "write"]), expiresAt: z.number().int().nonnegative() }))
export type MflowLock = z.infer<typeof MflowLock>
export const MflowPeer = lazySchema(() => z.strictObject({ owner: text.max(100), expiresAt: z.number().int().nonnegative() }))
export type MflowPeer = z.infer<typeof MflowPeer>
export const MflowRoom = lazySchema(() => z.strictObject({ peers: z.array(MflowPeer).max(128), locks: z.array(MflowLock).max(512) }))
export const MflowLeaseReply = lazySchema(() => z.strictObject({ ok: z.boolean(), lease: MflowLock.optional(), peers: z.array(MflowPeer).max(128).optional(), locks: z.array(MflowLock).max(512).optional(), conflict: z.strictObject({ files: z.array(text).max(128), expiresAt: z.number().int().nonnegative() }).optional(), message: z.string().max(500).optional() }))
export type MflowReport = {
  operation: string
  ok: boolean
  mode: "disabled" | "enabled-stopped" | "running"
  config: { enabled: boolean; room: string; relayMode: "local"; signaling: string; hookPriority: number; tokenConfigured: boolean }
  daemon: { running: boolean; checked: boolean; output: string }
  peers: MflowPeer[]
  locks: MflowLock[]
  failures: string[]
  warnings: string[]
  statePath: string
  planPath?: string
  plan?: { dryRun: true; startsDaemon: false; syncsFiles: false; neverSync: string[]; commands: string[] }
  relays?: Array<{ url: string; health: "healthy"; roomCount: number; peerCount: number }>
  guide?: { recommendedUrl: string; commands: string[]; note: string }
  legacy?: { enabled: false; liveSync: false; integration: string }
}
export type MflowLeaseResult = z.infer<typeof MflowLeaseReply>

export const MflowRelayHealth = lazySchema(() => z.strictObject({ protocol: z.literal("mendcode-v2-mflow"), roomCount: z.number().int().min(0).max(64), peerCount: z.number().int().min(0).max(8192) }))
