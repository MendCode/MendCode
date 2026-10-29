import { z } from "zod"
import { ItemId } from "./ids"
import { lazySchema } from "./lazy"

/** Donor payload names, validated before routing into the native shell turn. */
export const SessionShellPayload = lazySchema(() => z.strictObject({
  agent: z.string().min(1).max(100),
  messageID: ItemId.optional(),
  command: z.string().min(1).max(8000),
  model: z.strictObject({ providerID: z.string().min(1).max(100), modelID: z.string().min(1).max(200) }).optional(),
}))
export type SessionShellPayload = z.infer<typeof SessionShellPayload>
