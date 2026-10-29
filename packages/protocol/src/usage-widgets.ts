import { z } from "zod"
import { lazySchema } from "./lazy"

const terminalText = z.string().min(1).max(120).refine((text) => !/[\x00-\x1f\x7f-\x9f]/.test(text))
export const UsageWeatherReading = lazySchema(() => z.strictObject({
  location: terminalText,
  label: terminalText,
  temperatureC: z.number().finite().min(-100).max(100),
  windKmh: z.number().finite().min(0).max(500).optional(),
  code: z.number().int().min(0).max(99).optional(),
  observedAt: z.number().int().nonnegative(),
}))
export type UsageWeatherReading = z.infer<typeof UsageWeatherReading>
export const UsageWeatherReport = lazySchema(() => z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("ready"), region: terminalText, reading: UsageWeatherReading }),
  z.strictObject({ status: z.enum(["off", "unavailable", "error"]), region: terminalText.optional() }),
]))
export type UsageWeatherReport = z.infer<typeof UsageWeatherReport>
