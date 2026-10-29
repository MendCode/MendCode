import { z } from "zod"
import { ClientId, SessionId } from "./ids"
import { SESSION_COLORS } from "./constants"
import { lazySchema } from "./lazy"

export const AgentViewMetadataPatch = lazySchema(() => z.strictObject({
  title: z.string().max(120).nullable().optional(),
  tags: z.array(z.string().max(40)).max(20).nullable().optional(),
  /** A color mark the session list draws beside the title; null takes it off. */
  color: z.enum(SESSION_COLORS).nullable().optional(),
  group: z.string().max(80).nullable().optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
  pinned: z.boolean().nullable().optional(),
  archived: z.boolean().nullable().optional(),
}))
export const AgentViewMetadata = lazySchema(() => z.strictObject({
  sessionId: SessionId,
  title: z.string().max(120).optional(),
  tags: z.array(z.string().max(40)).max(20),
  color: z.enum(SESSION_COLORS).optional(),
  group: z.string().max(80).optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  notes: z.string().max(4000).optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
  createdAt: z.number().int().nonnegative().optional(),
  updatedAt: z.number().int().nonnegative().optional(),
}))
export const SessionBackgroundPatch = lazySchema(() => z.strictObject({
  state: z.enum(["queued", "working", "needs_input", "completed", "failed", "stopped"]).optional(),
  summary: z.string().max(4000).optional(),
  error: z.string().max(4000).optional(),
  pinned: z.boolean().optional(),
  process: z.strictObject({ pid: z.number().int().nonnegative(), startedAt: z.number().int().nonnegative() }).optional(),
}))
export const SessionBackground = lazySchema(() => z.strictObject({
  ...SessionBackgroundPatch.shape,
  sessionId: SessionId,
  state: SessionBackgroundPatch.shape.state.unwrap(),
  pinned: z.boolean(),
  writer: z.strictObject({ clientId: ClientId, acquiredAt: z.number().int().nonnegative(), expiresAt: z.number().int().nonnegative() }).optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}))
export const SessionBackgroundEntry = lazySchema(() => SessionBackground.extend({
  session: z.strictObject({ sessionId: SessionId, title: z.string(), directory: z.string(), parentId: SessionId.optional(), agent: z.string().optional() }),
  metadata: AgentViewMetadata.optional(),
}))
export type AgentViewMetadataPatch = z.infer<typeof AgentViewMetadataPatch>
export type AgentViewMetadata = z.infer<typeof AgentViewMetadata>
export type SessionBackgroundPatch = z.infer<typeof SessionBackgroundPatch>
export type SessionBackground = z.infer<typeof SessionBackground>
export type SessionBackgroundEntry = z.infer<typeof SessionBackgroundEntry>
