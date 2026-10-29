import { z } from "zod"
import { lazySchema } from "./lazy"

const ModelRef = z.string().trim().min(1).max(200).regex(/^[a-z0-9][a-z0-9_-]*[:/][^\s]+$/)
const BaseUrl = z.string().url().max(2048).refine((value) => {
  const url = new URL(value)
  return !url.username && !url.password && !url.search && !url.hash && (url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
}, "Image API URLs require HTTPS or loopback HTTP, without credentials, query or fragment")

/** Independent image/caption roles; no change to the active conversation model. */
export const ImageGenerationSettings = lazySchema(() => z.strictObject({
  enabled: z.boolean().optional(),
  model: ModelRef.optional(),
  adapter: z.enum(["auto", "codex-oauth", "openrouter", "openai-compatible"]).optional(),
  base_url: BaseUrl.optional(),
  timeout_ms: z.number().int().min(1).max(600_000).optional(),
  options: z.record(z.string().min(1).max(100), z.unknown()).refine((value) => JSON.stringify(value).length <= 16_000 && !Object.keys(value).some((key) => /^(model|prompt|n|images|image|input_references|headers|authorization|api_key|token|url|base_url)$/i.test(key)), "Image options must be bounded generation parameters, without routing, credentials or references").optional(),
  caption: z.strictObject({
    enabled: z.boolean().optional(),
    model: ModelRef.optional(),
    required: z.boolean().optional(),
    prompt: z.string().trim().min(1).max(10_000).optional(),
    max_chars: z.number().int().min(1).max(10_000).optional(),
  }).optional(),
}))
export type ImageGenerationSettings = z.infer<typeof ImageGenerationSettings>
