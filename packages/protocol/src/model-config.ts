import { z } from "zod"
import { REASONING_EFFORTS } from "./constants"
import { AzureOptions } from "./azure"
import { BedrockOptions } from "./bedrock"
import { VertexOptions } from "./vertex"
import { GitLabConfig } from "./gitlab"
import { CloudflareWorkersAIConfig } from "./cloudflare-workers-ai"
import { CloudflareAIGatewayConfig } from "./cloudflare-ai-gateway"
import { lazySchema, lazyValue } from "./lazy"

/** Provider parameters may tune generation, never replace conversation, transport or tools. */
export const ModelParameters = lazySchema(() => z.record(z.string().min(1).max(100), z.json()).refine((value) =>
  Object.keys(value).length <= 32 && JSON.stringify(value).length <= 8_000 &&
  !Object.keys(value).some((key) => ["model", "messages", "input", "instructions", "system", "tools", "tool_choice", "stream", "store", "headers", "url", "apiKey", "authorization", "prompt_cache_key"].includes(key)),
  { message: "invalid generation parameters" }))
const VariantFields = lazySchema(() => z.strictObject({ effort: z.enum(REASONING_EFFORTS).optional(), parameters: ModelParameters.optional(), disabled: z.boolean().optional() }))
// A pipe stays eager: JSON Schema generation looks a wrapper schema up by identity, which a lazy stand-in breaks (lazy.ts).
export const ModelVariant = z.looseObject(VariantFields.shape).transform((raw): z.input<typeof VariantFields> => {
  const { effort, parameters, disabled, ...fields } = raw
  return { ...(effort !== undefined ? { effort } : {}), ...(disabled !== undefined ? { disabled } : {}), ...(parameters !== undefined || Object.keys(fields).length ? { parameters: { ...fields, ...parameters } as z.input<typeof ModelParameters> } : {}) }
}).pipe(VariantFields)
export const ModelVariants = lazySchema(() => z.record(z.string().min(1).max(100), ModelVariant).refine((value) => Object.keys(value).length <= 32 && !("default" in value)))

export const ModelHeaders = lazySchema(() => z.record(z.string().regex(/^[A-Za-z0-9-]{1,100}$/), z.string().max(2048).refine((value) => !/[\r\n]/.test(value))))
const Price = lazySchema(() => z.strictObject({ input: z.number().nonnegative(), output: z.number().nonnegative(), cache_read: z.number().nonnegative().optional(), cache_write: z.number().nonnegative().optional() }))
const Modality = z.enum(["text", "audio", "image", "video", "pdf"])
/**
 * The reasoning controls a model takes, in models.dev's shape: `effort` with the levels it names, `toggle` (thinking on
 * or off) or `budget_tokens`. Present (even empty) means the catalog says which levels are selectable; absent means unknown.
 * Loose: a control type this version does not know is kept and ignored.
 */
export const ReasoningOption = lazySchema(() => z.looseObject({
  type: z.string().min(1).max(40),
  values: z.array(z.string().max(40).nullable()).max(16).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
}))
export type ReasoningOption = z.infer<typeof ReasoningOption>
export const ModelMetadata = lazySchema(() => z.object({
  family: z.string().max(100).optional(),
  release_date: z.string().max(40).optional(),
  attachment: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  reasoning_options: z.array(ReasoningOption).max(8).optional(),
  temperature: z.boolean().optional(),
  tool_call: z.boolean().optional(),
  interleaved: z.union([z.literal(true), z.strictObject({ field: z.enum(["reasoning_content", "reasoning_details"]) })]).optional(),
  cost: Price.extend({ context_over_200k: Price.optional() }).optional(),
  limit: z.strictObject({ context: z.number().int().positive(), input: z.number().int().positive().optional(), output: z.number().int().positive() }).optional(),
  modalities: z.strictObject({ input: z.array(Modality), output: z.array(Modality) }).optional(),
  status: z.enum(["alpha", "beta", "deprecated"]).optional(),
  experimental: z.boolean().optional(),
  provider: z.strictObject({ npm: z.string().max(200).optional(), api: z.string().max(2048).optional() }).optional(),
  options: ModelParameters.optional(),
  headers: ModelHeaders.optional(),
}))
export const SapAIConfig = lazySchema(() => z.strictObject({
  deploymentId: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/).optional(),
  resourceGroup: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/).optional(),
}))
export type SapAIConfig = z.infer<typeof SapAIConfig>

export const ProviderOptions = lazySchema(() => z.strictObject({
  parameters: ModelParameters.optional(),
  timeout: z.union([z.number().int().positive(), z.literal(false)]).optional(),
  chunkTimeout: z.union([z.number().int().positive(), z.literal(false)]).optional(),
  whitelist: z.array(z.string().max(100)).max(1000).optional(),
  blacklist: z.array(z.string().max(100)).max(1000).optional(),
  azure: AzureOptions.optional(),
  bedrock: BedrockOptions.optional(),
  vertex: VertexOptions.optional(),
  sapAi: SapAIConfig.optional(),
  gitlab: GitLabConfig.optional(),
  cloudflareWorkersAi: CloudflareWorkersAIConfig.optional(),
  cloudflareAiGateway: CloudflareAIGatewayConfig.optional(),
}))
export const AgentConfig = lazySchema(() => z.looseObject({
  description: z.string().max(300).optional(), prompt: z.string().max(16000).optional(),
  model: z.string().min(1).max(100).optional(), effort: z.enum(REASONING_EFFORTS).optional(),
  mode: z.enum(["primary", "subagent", "all"]).optional(),
  temperature: z.number().finite().optional(), top_p: z.number().finite().optional(),
  color: z.string().regex(/^(#[0-9a-fA-F]{6}|primary|secondary|accent|success|warning|error|info)$/).optional(),
  hidden: z.boolean().optional(), disable: z.boolean().optional(),
  steps: z.number().int().positive().optional(), maxSteps: z.number().int().positive().optional(),
  variant: z.string().min(1).max(100).optional(), options: ModelParameters.optional(),
  tools: z.union([z.array(z.string().max(100)).max(100), z.record(z.string().max(100), z.boolean())]).optional(),
  deny: z.array(z.string().max(100)).max(100).optional(),
  permission: z.json().optional(), permissionRules: z.array(z.json()).max(500).optional(),
}))

export const ConfiguredModel = lazySchema(() => z.strictObject({
  ...ModelMetadata.shape,
  id: z.string().min(1).max(66), name: z.string().min(1).max(100).optional(),
  context: z.number().int().positive().optional(), effort: z.boolean().optional(), images: z.boolean().optional(),
  variants: ModelVariants.optional(),
}))
// Only ProviderConfig uses it, so it is built with ProviderConfig (one real schema, never a stand-in: it is a transform).
const ConfigModels = lazyValue(() => z.union([z.array(ConfiguredModel).max(1000), z.record(z.string().min(1).max(66), ConfiguredModel.omit({ id: true }).extend({ id: ConfiguredModel.shape.id.optional() }))]).transform((models) => Array.isArray(models) ? models : Object.entries(models).map(([id, model]) => ({ ...model, id: model.id ?? id }))))
export const ProviderConfig = lazySchema(() => ProviderOptions.extend({
  type: z.enum(["openai", "anthropic", "openai-compatible", "azure", "amazon-bedrock", "google-vertex", "google-vertex-anthropic", "xai", "mistral"]).optional(),
  name: z.string().max(100).optional(), npm: z.string().max(200).optional(),
  api: z.string().regex(/^https?:\/\/[^\s]+$/i).optional(),
  baseUrl: z.string().regex(/^https?:\/\/[^\s]+$/i).optional(),
  apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/).optional(),
  headers: ModelHeaders.optional(), models: ConfigModels().optional(),
  options: z.looseObject({
    baseURL: z.string().regex(/^https?:\/\/[^\s]+$/i).optional(),
    timeout: ProviderOptions.shape.timeout, chunkTimeout: ProviderOptions.shape.chunkTimeout,
  }).optional(),
}))
