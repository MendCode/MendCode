import { z } from "zod"
import { lazySchema } from "./lazy"

/** Ephemeral, local-only playback owned by this socket, never replayed after reconnect. */
export const ActivityAudioInput = lazySchema(() => z.strictObject({
  action: z.enum(["start", "stop", "pulse"]),
  scale: z.number().min(0).max(1).optional(),
}))
