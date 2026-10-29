import { z } from "zod"
import { ModelMetadata, ModelVariants, SapAIConfig } from "./model-config"
import { CompactionOverride } from "./compaction"
import { CompoundPricing } from "./compound"
import { AzureOptions } from "./azure"
import { BedrockOptions } from "./bedrock"
import { VertexOptions } from "./vertex"
import { GitLabConfig } from "./gitlab"
import { CloudflareWorkersAIConfig } from "./cloudflare-workers-ai"
import { CloudflareAIGatewayInfo } from "./cloudflare-ai-gateway"
import { lazySchema } from "./lazy"

/** API wire formats the native engine speaks, including Gemini GenerateContent. */
export const PROVIDER_TYPES = ["openai", "anthropic", "openai-compatible", "google", "github-copilot", "azure", "amazon-bedrock", "google-vertex", "google-vertex-anthropic", "xai", "mistral", "cohere"] as const
export const ProviderType = z.enum(PROVIDER_TYPES)
export type ProviderType = z.infer<typeof ProviderType>

/** Namespace of a provider's models (`<id>:<model>`); never contains a colon, so the first colon splits namespace from model. */
export const PROVIDER_ID = /^[a-z][a-z0-9_-]{0,31}$/
/** The ChatGPT subscription's own namespace-free models; no API-key provider may take this id. */
export const RESERVED_PROVIDER_IDS = ["chatgpt"] as const

export const ProviderId = z.string().regex(PROVIDER_ID).refine((id) => !(RESERVED_PROVIDER_IDS as readonly string[]).includes(id), { message: "reserved provider id" })

/** One model a provider offers, as configured (`id` is the provider's own, without namespace). */
export const ProviderModel = lazySchema(() => z.strictObject({
  ...ModelMetadata.shape,
  /** At most 66 characters so `<provider>:<id>` (provider id up to 32) fits a ModelChoice's 100. */
  id: z.string().min(1).max(66),
  name: z.string().min(1).max(100).optional(),
  /** Context window in tokens. */
  context: z.number().int().positive().optional(),
  /** Takes a reasoning effort (thinking budget / reasoning_effort). */
  effort: z.boolean().optional(),
  /** Accepts image input; images are left out (with a note) when false. */
  images: z.boolean().optional(),
  variants: ModelVariants.optional(),
  compaction: CompactionOverride.optional(),
  inputLimit: z.number().int().positive().optional(),
  outputLimit: z.number().int().positive().optional(),
  compoundPricing: CompoundPricing.optional(),
  /** Copilot advertises its wire endpoint per model; absent uses v1's GPT routing rule. */
  copilotEndpoint: z.enum(["/chat/completions", "/responses", "/v1/messages"]).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
}))
export type ProviderModel = z.infer<typeof ProviderModel>

export const ProviderBaseUrl = z
  .string()
  .max(2048)
  .refine((value) => /^https?:\/\/[^\s]+$/i.test(value), { message: "baseUrl must be an http(s) URL" })

/** Already installed package or absolute local module; never a downloaded URL. */
export const ProviderSdkModule = z.string().min(1).max(4096).refine((value) => {
  if (value.startsWith("file:")) { try { const url = new URL(value); return !url.hostname && !url.search && !url.hash && url.pathname.startsWith("/") } catch { return false } }
  return value.startsWith("/") || /^(@[a-z0-9_-]+\/)?[a-z0-9_-]+(?:\/[a-zA-Z0-9._/-]+)?$/.test(value)
}, { message: "SDK module must be an installed package or absolute local path" })

/** What `providers.list` says about one provider. The key itself never appears: only `hasKey` and a masked tail. */
export const ProviderInfo = lazySchema(() => z.strictObject({
  id: z.string(),
  npm: ProviderSdkModule.optional(),
  type: ProviderType,
  baseUrl: z.string(),
  enabled: z.boolean(),
  hasKey: z.boolean(),
  /** `…3f2a`: the last characters of the key, only for keys long enough that this reveals nothing useful. */
  keyTail: z.string().optional(),
  /** `config`: an entry in providers.json (possibly with a key from the environment); `env`: enabled by an environment key alone; `extension`: registered by a user extension (`api.registerProvider` with a baseUrl). */
  source: z.enum(["config", "env", "extension"]),
  models: z.array(ProviderModel),
  /** Why the provider cannot be used right now (no key, unreadable file). */
  error: z.string().optional(),
  compaction: CompactionOverride.optional(),
  azure: AzureOptions.optional(),
  bedrock: BedrockOptions.optional(),
  authReady: z.boolean().optional(),
  vertex: VertexOptions.optional(),
  sapAi: SapAIConfig.optional(),
  gitlab: GitLabConfig.optional(),
  cloudflareWorkersAi: CloudflareWorkersAIConfig.optional(),
  cloudflareAiGateway: CloudflareAIGatewayInfo.optional(),
}))
export type ProviderInfo = z.infer<typeof ProviderInfo>

export const ProviderTestResult = lazySchema(() => z.strictObject({
  ok: z.boolean(),
  latencyMs: z.number().int().nonnegative(),
  model: z.string().optional(),
  error: z.string().optional(),
}))
export type ProviderTestResult = z.infer<typeof ProviderTestResult>
