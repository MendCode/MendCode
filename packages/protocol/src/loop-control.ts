import { z } from "zod"
import { ClientId, CommandId, LoopId } from "./ids"
import { Loop, LoopBudget, LoopJournalEvent, LoopTrigger } from "./loops"
import { lazySchema } from "./lazy"

const base = { id: CommandId, clientId: ClientId }
export const LoopDraft = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("loop.draft"),
  directory: z.string().min(1).max(4096),
  name: z.string().min(1).max(120).optional(),
  objective: z.string().min(1).max(8_000).optional(),
  template: z.string().min(1).max(40).optional(),
  trigger: LoopTrigger.optional(),
  budget: LoopBudget.optional(),
  reportOnly: z.boolean().optional(),
}).refine((input) => input.template !== undefined || Boolean(input.name && input.objective), { message: "a draft needs a template or name and objective" }))
export const LoopSnapshotQuery = lazySchema(() => z.strictObject({ ...base, type: z.literal("loop.snapshot"), loopId: LoopId }))
export const LoopEventsQuery = lazySchema(() => z.strictObject({ ...base, type: z.literal("loop.events"), loopId: LoopId, limit: z.number().int().min(1).max(200).default(50) }))
export const LoopActivate = lazySchema(() => z.strictObject({ ...base, type: z.literal("loop.activate"), loopId: LoopId, reason: z.string().min(1).max(500).optional() }))
export const LoopTick = lazySchema(() => z.strictObject({
  ...base,
  type: z.literal("loop.tick"),
  directory: z.string().min(1).max(4096),
  loopId: LoopId.optional(),
  limit: z.number().int().min(1).max(100).default(1),
  execute: z.boolean().default(false),
  reportOnly: z.boolean().default(false),
}))

export type LoopSnapshot = { loop: z.infer<typeof Loop>; events: z.infer<typeof LoopJournalEvent>[]; children: Array<{ sessionId: string; title: string; state: string }>; scheduler: { kind: "integrated"; nextWakeAt?: number; overdue: boolean } }
export type LoopTickResult = { loopId: z.infer<typeof LoopId>; state: string; summary: string; run?: number; timedOut?: boolean }
