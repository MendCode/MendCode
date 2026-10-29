import { z } from "zod"
import { BlobRef } from "./ids"
import { lazySchema } from "./lazy"

export const ComputerCaptureInput = lazySchema(() => z.strictObject({
  region: z.strictObject({
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int().min(1).max(16384),
    height: z.number().int().min(1).max(16384),
  }).nullable().optional(),
  windowID: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
}).refine((input) => !input.region || input.windowID == null, "Use a region or a window ID, not both"))
export type ComputerCaptureInput = z.infer<typeof ComputerCaptureInput>

export const ComputerKeyInput = lazySchema(() => z.strictObject({
  captureID: z.string().uuid(),
  key: z.enum(["tab", "escape", "enter", "space", "left", "right", "down", "up"]),
}))
export type ComputerKeyInput = z.infer<typeof ComputerKeyInput>

export const ComputerCaptureMetadata = lazySchema(() => z.strictObject({
  captureID: z.string().uuid(),
  filePath: z.string(),
  width: z.number().int().positive().max(1600),
  height: z.number().int().positive().max(1600),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  capturedAt: z.number().int().nonnegative(),
  resized: z.boolean(),
  keyboardControlAvailable: z.boolean(),
  computerSessionBootstrapAvailable: z.boolean().optional(),
  unchangedFrom: z.string().uuid().optional(),
  coordinates: z.literal("Preview pixels; do not assume these match desktop control coordinates."),
}))
export type ComputerCaptureMetadata = z.infer<typeof ComputerCaptureMetadata>
export type ComputerCaptureReport = ComputerCaptureMetadata & { image?: z.infer<typeof BlobRef> }
export type ComputerKeyReport = ComputerKeyInput & { pressed: true }
