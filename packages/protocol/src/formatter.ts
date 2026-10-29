import { z } from "zod"
import { lazySchema } from "./lazy"

export const FormatterEntry = lazySchema(() => z.strictObject({
  disabled: z.boolean().optional(),
  command: z.array(z.string().min(1).max(4096)).min(1).max(64).optional(),
  environment: z.record(z.string(), z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  extensions: z.array(z.string().regex(/^\.[^/\\]+$/)).max(128).optional(),
}))
export const FormatterConfig = lazySchema(() => z.union([z.boolean(), z.record(z.string().min(1).max(100), FormatterEntry)]))
export type FormatterConfig = z.infer<typeof FormatterConfig>

export const FormatterStatus = lazySchema(() => z.strictObject({
  name: z.string(),
  extensions: z.array(z.string()),
  enabled: z.boolean(),
  reason: z.string().optional(),
}))
export type FormatterStatus = z.infer<typeof FormatterStatus>
export const FormatterIssue = lazySchema(() => z.strictObject({ source: z.string(), formatter: z.string().optional(), message: z.string() }))
export type FormatterIssue = z.infer<typeof FormatterIssue>
export const FormatterStatusReport = lazySchema(() => z.strictObject({ formatters: z.array(FormatterStatus), issues: z.array(FormatterIssue) }))
export type FormatterStatusReport = z.infer<typeof FormatterStatusReport>
export const FormatterFileReport = lazySchema(() => z.strictObject({
  file: z.string(),
  formatted: z.boolean(),
  results: z.array(z.strictObject({ name: z.string(), ok: z.boolean(), message: z.string().optional() })),
  issues: z.array(FormatterIssue),
  unavailable: z.string().optional(),
}))
export type FormatterFileReport = z.infer<typeof FormatterFileReport>
