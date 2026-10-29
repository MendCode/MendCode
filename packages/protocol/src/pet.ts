import { z } from "zod"
import { lazySchema } from "./lazy"
import { PET_ART_KINDS, PET_GENERATED_STATES, PET_MAX_FRAMES } from "./pet-data"

export const PetInput = lazySchema(() => z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("plan"), description: z.string().trim().min(1).max(600), unitUsd: z.number().positive().max(100).optional(), optional: z.boolean().optional(), frames: z.number().int().min(1).max(PET_MAX_FRAMES).optional() }),
  z.strictObject({ action: z.literal("plan-state"), petId: z.string().uuid(), state: z.enum(PET_GENERATED_STATES), unitUsd: z.number().positive().max(100).optional() }),
  z.strictObject({ action: z.literal("generate"), planId: z.string().uuid(), confirmed: z.literal(true) }),
  z.strictObject({ action: z.literal("status"), planId: z.string().uuid() }),
  z.strictObject({ action: z.literal("rename"), petId: z.string().uuid(), name: z.string().trim().min(1).max(80).regex(/^[^\x00-\x1f\x7f]+$/) }),
  z.strictObject({ action: z.literal("delete"), petId: z.string().uuid(), confirmed: z.literal(true) }),
  z.strictObject({ action: z.literal("export"), petId: z.string().uuid() }),
  // A local picture as a pet: one PNG, a sprite sheet (`frames`), an animated GIF, or a folder of frames or of state folders. Spends nothing.
  z.strictObject({
    action: z.literal("import"), path: z.string().min(1).max(4096).regex(/^[^\x00]+$/), name: z.string().trim().min(1).max(80).regex(/^[^\x00-\x1f\x7f]+$/).optional(),
    frames: z.strictObject({ columns: z.number().int().min(1).max(64), rows: z.number().int().min(1).max(PET_GENERATED_STATES.length) }).optional(),
    key: z.boolean().optional(), filter: z.enum(PET_ART_KINDS).optional(), ms: z.number().int().min(20).max(10_000).optional(),
  }),
]))
