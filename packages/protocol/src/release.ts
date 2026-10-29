import { z } from "zod"
import { RELEASE_CHANNELS } from "./release-data"
import { lazySchema } from "./lazy"
export const ReleaseChannel = z.enum(RELEASE_CHANNELS)
export const ReleaseReport = lazySchema(() => z.strictObject({
  channel: ReleaseChannel,
  current: z.string().max(100),
  autoupdate: z.union([z.boolean(), z.literal("notify")]),
  lastCheckAt: z.number().int().nonnegative().nullable(),
  latest: z.string().max(100).nullable(),
  status: z.enum(["unchecked", "up-to-date", "ahead", "update-available", "installed"]),
  recovery: z.strictObject({ current: z.string().max(100), previous: z.string().max(100).nullable() }).nullable(),
}))
