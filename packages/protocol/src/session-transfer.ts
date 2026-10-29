import { z } from "zod"
import { ItemKind, ItemStatus } from "./states"
import { SessionId } from "./ids"
import { RenderNode } from "./render"
import { MAX_FRAME_BYTES } from "./constants"
import { lazySchema } from "./lazy"

export const SESSION_IMPORT_MAX_BYTES = MAX_FRAME_BYTES
const at = z.number().int().nonnegative().max(8_640_000_000_000_000)
const meta = lazySchema(() => z.record(z.string().max(100), z.union([z.string().max(1000), z.number().finite(), z.boolean()])).refine((value) => Object.keys(value).length <= 64))
export const AttachmentDescription = lazySchema(() => z.strictObject({ name: z.string().max(1000), mime: z.string().max(200), bytes: z.number().int().nonnegative() }))
export const SessionTranscriptItem = lazySchema(() => z.strictObject({
  itemId: z.string().min(1).max(200),
  kind: ItemKind,
  text: z.string().max(65_536),
  status: ItemStatus.optional(),
  tool: z.string().max(1000).optional(),
  source: z.enum(["shell", "notice"]).optional(),
  attachments: z.array(AttachmentDescription).max(32).optional(),
  truncated: z.literal(true).optional(),
  input: z.string().max(4000).optional(),
  at: at.optional(),
  meta: meta.optional(),
  resultMeta: z.record(z.string().max(40), z.union([z.string().max(200), z.number().finite(), z.boolean()])).refine((value) => Object.keys(value).length <= 16).optional(),
  render: RenderNode.optional(),
  authorityText: z.string().max(65_536).optional(),
}))
export type SessionTranscriptItem = z.infer<typeof SessionTranscriptItem>
export const TranscriptMetadata = lazySchema(() => z.strictObject({
  provider: z.string().max(200),
  model: z.string().max(200),
  tokens: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative().optional(),
  input: z.number().int().nonnegative().optional(),
  output: z.number().int().nonnegative().optional(),
  reasoning: z.number().int().nonnegative().optional(),
  cacheRead: z.number().int().nonnegative().optional(),
  cacheWrite: z.number().int().nonnegative().optional(),
  costMicros: z.number().int().nonnegative().optional(),
  costComplete: z.boolean().optional(),
}))
export type TranscriptMetadata = z.infer<typeof TranscriptMetadata>
export const SessionTranscriptTurn = lazySchema(() => z.strictObject({
  turnId: z.string().min(1).max(200),
  at,
  outcome: z.enum(["running", "completed", "cancelled", "failed", "interrupted"]),
  error: z.strictObject({ code: z.string().max(64), message: z.string().max(4000) }).optional(),
  items: z.array(SessionTranscriptItem).max(200),
  metadata: TranscriptMetadata.optional(),
}))
export type SessionTranscriptTurn = z.infer<typeof SessionTranscriptTurn>
/** Additive fields on the established native JSON transcript; donor JSON is a separate compatibility decision. */
export const SessionTranscript = lazySchema(() => z.strictObject({
  format: z.literal("mendcode-session@1"),
  sessionId: z.string().min(1).max(200),
  title: z.string().max(200),
  directory: z.string().max(4096),
  exportedAt: at,
  truncated: z.boolean(),
  sanitized: z.boolean().optional(),
  turns: z.array(SessionTranscriptTurn).max(1000),
}).superRefine((value, ctx) => {
  const turns = new Set<string>()
  const items = new Set<string>()
  for (const turn of value.turns) {
    if (turns.has(turn.turnId)) ctx.addIssue({ code: "custom", message: "duplicate turn id" })
    turns.add(turn.turnId)
    for (const item of turn.items) {
      if (items.has(item.itemId)) ctx.addIssue({ code: "custom", message: "duplicate item id" })
      items.add(item.itemId)
    }
  }
  if (items.size > 2000) ctx.addIssue({ code: "custom", message: "at most 2000 items" })
}))
export type SessionTranscript = z.infer<typeof SessionTranscript>
export const SessionImportResult = lazySchema(() => z.strictObject({ sessionId: SessionId, sourceSessionId: z.string(), turns: z.number().int().nonnegative(), items: z.number().int().nonnegative(), truncated: z.boolean(), sanitized: z.boolean(), attachmentFilesOmitted: z.number().int().nonnegative(), from: z.enum(["mendcode", "claude-code", "codex"]).optional() }))
export type SessionImportResult = z.infer<typeof SessionImportResult>
