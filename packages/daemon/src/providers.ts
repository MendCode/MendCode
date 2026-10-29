import { modelAllowed } from "./models"
import type { ModelsDev } from "./models-dev"
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { PROVIDER_ID, ProviderBaseUrl, ProviderId, ProviderModel, ProviderType, ProviderSdkModule, type ModelInfo, type ProviderInfo, type ProviderTestResult, type ProviderAdapter, ProviderOptions, ProviderConfig, ModelParameters, redactSecrets, type ModelChoice, type Settings } from "@mendcode/protocol"
import {
  DEFAULT_PROVIDER_EFFORT,
  PROVIDER_PRESETS,
  modelEfforts,
  type ReasoningStyle,
  createApiProvider,
  fetchProviderModels,
  namespacedModel,
  safeMessage,
  testProvider,
  type Fetch,
  type ModelProvider,
  type ResolvedProvider,
  createCopilotAuth,
  copilotUrl,
  type CopilotAuth,
  azureBaseUrl,
  createAzureEntraCredential,
  createAwsCredentialChain,
  bedrockRegion,
  bedrockBaseUrl,
  awsEndpoint,
  vertexRouting,
  vertexAnthropicRouting,
  isVertexType,
  VERTEX_ANTHROPIC_MODEL,
  vertexBaseUrl,
  vertexEndpoint,
  createGoogleAdcCredential,
  xaiBaseUrl,
  xaiVariants,
  mistralBaseUrl,
  mistralVariants,
  deepinfraBaseUrl,
  deepinfraVariants,
  isDeepInfra,
  perplexityUrl,
  alibabaUrl,
  zenUrl,
  llmgatewayUrl,
  nvidiaUrl,
  sapAiRoot,
  sapAiConfig,
  parseSapServiceKey,
  zenmuxUrl,
  geminiUrl,
  gitlabUrl,
  gitlabConfig,
  cerebrasUrl,
  cerebrasVariants,
  isCerebras,
  cohereUrl,
  isCohere,
  isTogetherAI,
  togetheraiUrl,
  togetheraiVariants,
  kiloUrl,
  GATEWAY_PRESETS,
  gatewayUrl,
  isGatewayPreset,
  cloudflareWorkersAccount,
  cloudflareWorkersBaseUrl,
  cloudflareGatewayBaseUrl,
  CLOUDFLARE_GATEWAY_MODEL,
} from "@mendcode/engine-native"
import { z } from "zod"
import { CompactionOverride } from "@mendcode/protocol"
import { AzureOptions } from "@mendcode/protocol"
import { BedrockOptions } from "@mendcode/protocol"
import { gatewayConfig, gatewayInfo } from "./cloudflare-ai-gateway"
import { VertexOptions, CloudflareAIGatewayConfig, CloudflareWorkersAIConfig } from "@mendcode/protocol"
import { ModelHeaders } from "@mendcode/protocol"

/** `<dataDir>/providers.json`: the user's API-key providers. Written with mode 0600; keys never leave this module except into requests. */
export const PROVIDERS_FILE = "providers.json"

/** The shared outbound policy (`outboundEndpoint` in engine-native), worded for a provider that rejected its URL. */
const endpointRule = (label: string) => `${label} endpoint requires HTTPS, or HTTP only on loopback, without credentials, query or fragment`

const HEADER_NAME = /^[A-Za-z0-9-]{1,100}$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
/** Visible ASCII only: a key with a space or a newline would break the header it travels in. */
const KEY = /^[\x21-\x7E]{1,4096}$/

/** Loose on purpose: fields this version does not know survive a rewrite. */
const Entry = z.looseObject({
  ...ProviderConfig.shape,
  npm: ProviderSdkModule.optional(),
  type: ProviderType.optional(),
  baseUrl: ProviderBaseUrl.optional(),
  apiKey: z.string().optional(),
  apiKeyEnv: z.string().regex(ENV_NAME).optional(),
  headers: z.record(z.string().regex(HEADER_NAME), z.string().max(2048)).optional(),
  models: z.array(ProviderModel).max(1000).optional(),
  enabled: z.boolean().optional(),
  /** When `models` was last fetched by providers.refresh (epoch ms). */
  refreshedAt: z.number().optional(),
  compaction: CompactionOverride.optional(),
})
type Entry = z.infer<typeof Entry>

type Env = Record<string, string | undefined>

export type ProviderSetInput = {
  id: string
  providerType?: ProviderType | undefined
  baseUrl?: string | undefined
  apiKey?: string | undefined
  apiKeyEnv?: string | undefined
  headers?: Record<string, string> | undefined
  enabled?: boolean | undefined
  models?: ProviderModel[] | undefined
  parameters?: NonNullable<ModelChoice["parameters"]> | undefined
  timeout?: number | false | undefined
  chunkTimeout?: number | false | undefined
  whitelist?: string[] | undefined
  blacklist?: string[] | undefined
  compaction?: import("@mendcode/protocol").CompactionOverride | null | undefined
  npm?: string | undefined
  azure?: AzureOptions | undefined
  bedrock?: BedrockOptions | undefined
  vertex?: VertexOptions | undefined
  sapAi?: import("@mendcode/protocol").SapAIConfig | undefined
  gitlab?: import("@mendcode/protocol").GitLabConfig | undefined
  cloudflareWorkersAi?: CloudflareWorkersAIConfig | undefined
  cloudflareAiGateway?: CloudflareAIGatewayConfig | undefined
}

type Failure = { ok: false; message: string; code: "invalid_command" | "target_mismatch" | "internal" }

/** What the daemon asks of the provider store; `startDaemon` only ever sees this shape. */
export interface ProviderService {
  copilotAuth?: CopilotAuth
  list(readOnly?: boolean): ProviderInfo[]
  set(input: ProviderSetInput): { ok: true; provider: ProviderInfo } | Failure
  remove(id: string): { ok: true; providers: ProviderInfo[] } | Failure
  test(id: string, model?: string): Promise<ProviderTestResult | undefined>
  refresh(id: string): Promise<{ ok: true; provider: ProviderInfo } | Failure>
  /** Models of usable providers (enabled, with a key or needing none), ids namespaced `<provider>:<model>`. */
  models(readOnly?: boolean): ModelInfo[]
  /** One adapter per provider, for the router; asked on every model call, so edits apply at once. */
  runtime(): Record<string, ModelProvider>
  inventory?(options?: { readOnly?: boolean }): ProviderAdapter[]
  /** Internal image transport; credentials never enter reports or protocol replies. */
  imageTransport?(id: string): { baseUrl: string; headers: Record<string, string> } | undefined
  logout?(id: string): { ok: true; provider: ProviderInfo } | Failure
  /** Available models, including unconfigured presets, without provider calls or credentials. */
  catalog?(): ProviderInfo[]
}

type Resolved = {
  id: string
  name: string
  type: ProviderType
  baseUrl: string
  enabled: boolean
  source: ProviderInfo["source"]
  key: string | undefined
  keyRequired: boolean
  headers: Record<string, string> | undefined
  reasoningStyle: ReasoningStyle | undefined
  models: ProviderModel[]
  error: string | undefined
  parameters?: NonNullable<ModelChoice["parameters"]>
  timeout?: number | false
  chunkTimeout?: number | false
  compaction: import("@mendcode/protocol").CompactionOverride | undefined
  npm?: string
  nativeSdk?: boolean
  azure?: AzureOptions
  authReady?: boolean
  bedrock?: BedrockOptions
  vertex?: VertexOptions
  sapAi?: import("@mendcode/protocol").SapAIConfig
  gitlab?: import("@mendcode/protocol").GitLabConfig
  cloudflareWorkersAi?: CloudflareWorkersAIConfig
  cloudflareAiGateway?: CloudflareAIGatewayConfig
}

/** A model of OpenCode Zen's free tier, which Zen serves only to OpenCode's own client (`FreeTierError`): it runs through the opencode ACP agent, not here. */
const zenFree = (model: ProviderModel) => (model.cost ? !model.cost.input && !model.cost.output : /-free$/.test(model.id))

const maskTail = (key: string) => (key.length >= 16 ? `…${key.slice(-4)}` : undefined)
const publicModel = (model: ProviderModel, gateway = false): ProviderModel => ({ ...model, ...(model.headers ? { headers: Object.fromEntries(Object.entries(model.headers).map(([name, value]) => [name, (/authorization|api[-_]?key|token|cookie|secret/i.test(name) || gateway && /cf-aig-(?:metadata|cache-key)/i.test(name)) ? "[redacted]" : redactSecrets(value).text])) } : {}) })

export function createProviderService(options: { dir: string; env?: Env; fetch?: Fetch; idleTimeoutMs?: number; log?(message: string): void; settings?(): Settings; copilot?: CopilotAuth; keyForEnv?(name: string): string | undefined; gitlabSocket?: import("@mendcode/engine-native").GitLabSocketFactory; /** Providers that user extensions registered, by id, as `providers.json` entries; asked on every lookup. */ extensions?(): Record<string, unknown>; /** models.dev's reasoning controls and prices for the models a provider lists (`models-dev.ts`). */ modelsDev?: Pick<ModelsDev, "facts"> }): ProviderService {
  const file = path.join(options.dir, PROVIDERS_FILE)
  const env = () => options.env ?? process.env
  const awsChains = new Map<string, ReturnType<typeof createAwsCredentialChain>>()
  const aws = (bedrock: BedrockOptions) => {
    const signature = JSON.stringify(bedrock)
    let chain = awsChains.get(signature)
    if (!chain) { chain = createAwsCredentialChain({ env, options: bedrock, region: bedrockRegion(bedrock, env()), ...(options.fetch ? { fetch: options.fetch } : {}) }); awsChains.set(signature, chain) }
    return chain
  }
  const bedrockOptions = (entry?: Entry) => BedrockOptions.safeParse({
    ...Object.fromEntries(Object.entries(entry?.options ?? {}).filter(([name]) => ["region", "profile", "auth", "allowCredentialProcess", "allowMetadata"].includes(name))),
    ...entry?.bedrock,
  })
  const entraCredentials = new Map<string, ReturnType<typeof createAzureEntraCredential>>()
  const entra = (tokenEnv?: string) => {
    const name = tokenEnv ?? "AZURE_OPENAI_AUTH_TOKEN"
    let credential = entraCredentials.get(name)
    if (!credential) { credential = createAzureEntraCredential({ env, tokenEnv: name, ...(options.fetch ? { fetch: options.fetch } : {}) }); entraCredentials.set(name, credential) }
    return credential
  }
  const azureOptions = (entry?: Entry) => AzureOptions.safeParse({
    ...Object.fromEntries(Object.entries(entry?.options ?? {}).filter(([name]) => ["resourceName", "apiVersion", "useCompletionUrls", "useDeploymentBasedUrls"].includes(name))),
    ...entry?.azure,
  })
  const googleCredentials = new Map<string, ReturnType<typeof createGoogleAdcCredential>>()
  const adc = (vertex: VertexOptions = {}) => {
    const signature = JSON.stringify([vertex.tokenEnv, vertex.allowMetadata])
    let credential = googleCredentials.get(signature)
    if (!credential) { credential = createGoogleAdcCredential({ env, ...(vertex.tokenEnv ? { tokenEnv: vertex.tokenEnv } : {}), ...(vertex.allowMetadata !== undefined ? { allowMetadata: vertex.allowMetadata } : {}), ...(options.fetch ? { fetch: options.fetch } : {}) }); googleCredentials.set(signature, credential) }
    return credential
  }
  const vertexOptions = (entry?: Entry) => VertexOptions.safeParse({
    ...Object.fromEntries(Object.entries(entry?.options ?? {}).filter(([name]) => ["project", "location", "tokenEnv", "quotaProject", "allowMetadata"].includes(name))),
    ...entry?.vertex,
  })
  const copilotAuth = options.copilot ?? createCopilotAuth({ dir: options.dir, clientId: env().MENDCODE_GITHUB_COPILOT_CLIENT_ID, clientSecret: env().MENDCODE_GITHUB_COPILOT_CLIENT_SECRET, issuer: env().MENDCODE_GITHUB_COPILOT_ISSUER, ...(options.fetch ? { fetch: options.fetch } : {}) })
  let cache: { stamp: string; entries: Record<string, Entry>; fileError?: string } | undefined

  function load(readOnly = false) {
    let stamp = "missing"
    let insecure = false
    try {
      const stat = statSync(file)
      stamp = `${stat.mtimeMs}:${stat.size}`
      insecure = (stat.mode & 0o077) !== 0
    } catch {
      cache = { stamp, entries: {} }
      return cache
    }
    if (!readOnly) try {
      // A file with wider permissions than the owner's is tightened: it may hold keys.
      if (!readOnly && insecure) chmodSync(file, 0o600)
    } catch {}
    if (cache?.stamp === stamp) return cache
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { providers?: unknown }
      const raw = parsed && typeof parsed === "object" && parsed.providers && typeof parsed.providers === "object" ? (parsed.providers as Record<string, unknown>) : {}
      const entries: Record<string, Entry> = {}
      const problems: string[] = []
      for (const [id, value] of Object.entries(raw)) {
        const entry = Entry.safeParse(value)
        if (entry.success && PROVIDER_ID.test(id)) entries[id] = entry.data
        else problems.push(id)
      }
      cache = { stamp, entries, ...(problems.length ? { fileError: `providers.json: ignored invalid entries (${problems.join(", ")})` } : {}) }
    } catch (error) {
      cache = { stamp, entries: {}, fileError: `providers.json could not be read (${error instanceof Error ? error.message : String(error)}); only environment keys apply` }
    }
    return cache
  }

  function save(entries: Record<string, Entry>) {
    mkdirSync(options.dir, { recursive: true })
    const temporary = `${file}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify({ providers: entries }, null, 2)}\n`, { mode: 0o600 })
    chmodSync(temporary, 0o600)
    renameSync(temporary, file)
    cache = undefined
  }

  function metadataModels(id: string): ProviderModel[] | undefined {
    try {
      const file = path.join(options.dir, "models.dev.json")
      if (statSync(file).size > 8 * 1024 * 1024) return undefined
      const raw = JSON.parse(readFileSync(file, "utf8"))
      const models = raw[id]?.models
      if (!models || typeof models !== "object") return undefined
      return Object.entries(models).slice(0, 1000).flatMap(([id, value]) => {
        // models.dev writes `null` for a field it has no value for (`interleaved`, `status`, `reasoning_options`): absent, not invalid.
        const parsed = ProviderModel.safeParse({ ...Object.fromEntries(Object.entries(value as object).filter(([key, field]) => key in ProviderModel.shape && field !== null)), id })
        return parsed.success ? [parsed.data] : []
      })
    } catch { return undefined }
  }

  function keyOf(id: string, entry: Entry | undefined): string | undefined {
    entry = { ...entry, ...options.settings?.().provider?.[id] } as Entry
    const preset = PROVIDER_PRESETS[id]
    if ((entry?.type ?? preset?.type) === "amazon-bedrock" && env().AWS_BEARER_TOKEN_BEDROCK?.trim()) return env().AWS_BEARER_TOKEN_BEDROCK!.trim()
    if (isVertexType(entry?.type ?? preset?.type) || ["@ai-sdk/google-vertex", "@ai-sdk/google-vertex/anthropic"].includes(entry?.npm ?? "")) return undefined
    const legacyKey = id === "kilo" || (entry?.type ?? preset?.type) === "mistral" || entry?.npm === "@ai-sdk/mistral" || isDeepInfra({ id, npm: entry?.npm }) || isCerebras({ id, npm: entry?.npm }) || isCohere({ id, type: entry?.type, npm: entry?.npm }) || isTogetherAI({ id, npm: entry?.npm }) ? entry?.options?.apiKey : undefined
    const keyEnv = preset?.keyEnv ?? (entry?.type === "mistral" || entry?.npm === "@ai-sdk/mistral" ? "MISTRAL_API_KEY" : isDeepInfra({ id, npm: entry?.npm }) ? "DEEPINFRA_API_KEY" : isCerebras({ id, npm: entry?.npm }) ? "CEREBRAS_API_KEY" : isCohere({ id, type: entry?.type, npm: entry?.npm }) ? "COHERE_API_KEY" : isTogetherAI({ id, npm: entry?.npm }) ? "TOGETHER_API_KEY" : undefined)
    const candidates = [...(id === "cloudflare-ai-gateway" ? [env().CLOUDFLARE_API_TOKEN, env().CF_AIG_TOKEN] : []), entry?.apiKey, entry?.apiKeyEnv ? env()[entry.apiKeyEnv] ?? options.keyForEnv?.(entry.apiKeyEnv) : undefined, typeof legacyKey === "string" ? legacyKey : undefined, keyEnv ? env()[keyEnv] : undefined, id === "azure" ? env().AZURE_OPENAI_API_KEY : undefined]
    return candidates.map((value) => value?.trim()).find((value): value is string => Boolean(value))
  }

  function resolveOne(id: string, entry: Entry | undefined, source: ProviderInfo["source"], fileError: string | undefined): Resolved {
    const preset = PROVIDER_PRESETS[id]
    const deepinfra = isDeepInfra({ id, npm: entry?.npm })
    const cerebras = isCerebras({ id, npm: entry?.npm })
    const togetherai = isTogetherAI({ id, npm: entry?.npm })
    const npmType = entry?.npm === "@ai-sdk/anthropic" ? "anthropic" : entry?.npm === "@ai-sdk/openai" ? "openai" : (["@ai-sdk/openai-compatible", "@ai-sdk/deepinfra", "@ai-sdk/cerebras", "@ai-sdk/togetherai"].includes(entry?.npm ?? "") || id === "perplexity" && entry?.npm === "@ai-sdk/perplexity" || id === "alibaba" && entry?.npm === "@ai-sdk/alibaba") ? "openai-compatible" : entry?.npm === "@ai-sdk/azure" ? "azure" : entry?.npm === "@ai-sdk/amazon-bedrock" ? "amazon-bedrock" : entry?.npm === "@ai-sdk/google-vertex" ? "google-vertex" : entry?.npm === "@ai-sdk/google-vertex/anthropic" ? "google-vertex-anthropic" : undefined
    const type = isCohere({ id, type: entry?.type, npm: entry?.npm }) ? "cohere" : deepinfra || cerebras || togetherai || ["perplexity", "alibaba", "opencode", "llmgateway", "nvidia", "sap-ai-core", "zenmux", "gitlab", "kilo", "cloudflare-workers-ai", "cloudflare-ai-gateway"].includes(id) ? "openai-compatible" : entry?.type ?? (entry?.npm === "@ai-sdk/xai" ? "xai" : entry?.npm === "@ai-sdk/mistral" ? "mistral" : npmType) ?? preset?.type ?? "openai-compatible"
    const parsedAzure = type === "azure" ? azureOptions(entry) : undefined
    const azure = parsedAzure?.success ? parsedAzure.data : type === "azure" ? {} : undefined
    const parsedBedrock = type === "amazon-bedrock" ? bedrockOptions(entry) : undefined
    const bedrock = parsedBedrock?.success ? { ...parsedBedrock.data, region: bedrockRegion(parsedBedrock.data, env()), ...(parsedBedrock.data.profile ?? env().AWS_PROFILE ? { profile: parsedBedrock.data.profile ?? env().AWS_PROFILE } : {}) } : type === "amazon-bedrock" ? { region: "us-east-1" } : undefined
    const parsedVertex = isVertexType(type) ? vertexOptions(entry) : undefined
    const vertex: VertexOptions | undefined = parsedVertex?.success ? { ...parsedVertex.data, ...(type === "google-vertex-anthropic" ? vertexAnthropicRouting : vertexRouting)(parsedVertex.data, env()) } : isVertexType(type) ? {} : undefined
    const resource = azure?.resourceName ?? env().AZURE_RESOURCE_NAME
    const regionalVertexUrl = vertex && /^(global|[a-z]+(?:-[a-z0-9]+)+)$/.test(vertex.location ?? "") ? vertexBaseUrl(vertex.location!) : ""
    const vertexUrl = vertex ? vertex.endpoint === null ? regionalVertexUrl : vertex.endpoint ?? entry?.baseUrl ?? entry?.options?.baseURL ?? entry?.api ?? regionalVertexUrl : undefined
    let baseUrl = (vertexUrl ?? (bedrock?.endpoint === null ? bedrockBaseUrl(bedrock.region) : bedrock?.endpoint ?? (type === "amazon-bedrock" && typeof entry?.options?.endpoint === "string" ? entry.options.endpoint : undefined) ?? entry?.baseUrl ?? entry?.options?.baseURL ?? entry?.api ?? (id === "gitlab" ? env().GITLAB_INSTANCE_URL : undefined) ?? (bedrock ? bedrockBaseUrl(bedrock.region) : type === "azure" ? env().AZURE_OPENAI_ENDPOINT ?? (resource && /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(resource) ? `https://${resource}.openai.azure.com/openai` : "") : undefined) ?? preset?.baseUrl ?? (type === "mistral" ? PROVIDER_PRESETS.mistral!.baseUrl : deepinfra ? PROVIDER_PRESETS.deepinfra!.baseUrl : cerebras ? PROVIDER_PRESETS.cerebras!.baseUrl : togetherai ? PROVIDER_PRESETS.togetherai!.baseUrl : ""))).replace(/\/+$/, "")
    const credential = (id === "github-copilot" ? copilotAuth.token() : undefined) ?? keyOf(id, entry)
    const key = id === "opencode" && credential === "public" ? undefined : credential
    const keyRequired = type === "cohere" || deepinfra || cerebras || togetherai || Boolean(preset?.keyEnv) || type === "google" || type === "github-copilot" || type === "azure" || type === "xai" || type === "mistral"
    const authReady = vertex ? adc(vertex).ready() : bedrock ? Boolean(key) || bedrock.auth !== "bearer" && aws(bedrock).ready() : type === "azure" && azure?.auth === "entra" ? entra(azure.tokenEnv).ready() : Boolean(key) || !keyRequired
    const nativeSdk = Boolean(type === "cohere" && entry?.npm === "@ai-sdk/cohere" || type === "xai" && entry?.npm === "@ai-sdk/xai" || type === "mistral" && entry?.npm === "@ai-sdk/mistral" || npmType && (entry?.enabled === undefined || isVertexType(type)))
    const unsupportedSdk = !["sap-ai-core", "gitlab", "kilo", "cloudflare-workers-ai", "cloudflare-ai-gateway"].includes(id) && entry?.npm && !npmType && !nativeSdk && !entry.type && entry.enabled !== true
    const enabled = (entry?.enabled ?? (!deepinfra && !cerebras && !togetherai && !["perplexity", "alibaba", "opencode", "llmgateway", "nvidia", "sap-ai-core", "zenmux", "gitlab", "kilo", "cloudflare-workers-ai", "cloudflare-ai-gateway"].includes(id) && !["azure", "amazon-bedrock", "google-vertex", "google-vertex-anthropic", "xai", "mistral", "cohere"].includes(type) && (nativeSdk || !entry?.npm && (preset?.defaultEnabled ?? !["google", "github-copilot"].includes(type))))) && !unsupportedSdk && (!options.settings?.().enabled_providers || options.settings().enabled_providers!.includes(id))
    let deepinfraError: string | undefined
    if (deepinfra) try { baseUrl = deepinfraBaseUrl(baseUrl, Boolean(!entry?.baseUrl && !entry?.api && entry?.npm === "@ai-sdk/deepinfra" && entry.options?.baseURL)) } catch { deepinfraError = endpointRule("DeepInfra") }
    if (cerebras) try { baseUrl = cerebrasUrl(baseUrl) } catch { deepinfraError = endpointRule("Cerebras") }
    if (type === "cohere") try { baseUrl = cohereUrl(baseUrl) } catch { deepinfraError = endpointRule("Cohere") }
    let azureError = deepinfraError ?? (parsedAzure && !parsedAzure.success ? "invalid Azure settings" : undefined)
    if (type === "xai" && baseUrl) try { xaiBaseUrl(baseUrl) } catch { azureError = "xAI endpoint requires HTTPS or loopback HTTP without credentials, query or fragment" }
    if (type === "mistral" && baseUrl) try { mistralBaseUrl(baseUrl) } catch { azureError = "Mistral endpoint requires HTTPS or loopback HTTP without credentials, query or fragment" }
    if (type === "azure" && baseUrl) try { azureBaseUrl(baseUrl) } catch { azureError = "Azure endpoint must use HTTPS or loopback HTTP, without credentials, query or fragment" }
    if (bedrock) {
      if (!parsedBedrock?.success || !BedrockOptions.safeParse(bedrock).success) azureError = "invalid Bedrock settings"
      else try { awsEndpoint(baseUrl) } catch { azureError = "AWS endpoint requires HTTPS or loopback HTTP without credentials, query or fragment" }
    }
    if (vertex) {
      if (!parsedVertex?.success || !VertexOptions.safeParse(vertex).success) azureError = "invalid Vertex settings"
      else if (!vertex.project) azureError = "Vertex needs GOOGLE_CLOUD_PROJECT, GCP_PROJECT, GCLOUD_PROJECT or vertex.project"
      else try { vertexEndpoint(baseUrl) } catch { azureError = "Vertex endpoint requires HTTPS or loopback HTTP without credentials, query or fragment" }
    }
    let endpointError = azureError
    let cloudflareAiGateway: CloudflareAIGatewayConfig | undefined
    if (id === "cloudflare-ai-gateway") try {
      cloudflareAiGateway = gatewayConfig(entry)
      if (!baseUrl) cloudflareAiGateway = CloudflareAIGatewayConfig.parse({ ...cloudflareAiGateway, accountId: env().CLOUDFLARE_ACCOUNT_ID || cloudflareAiGateway.accountId, gatewayId: env().CLOUDFLARE_GATEWAY_ID || cloudflareAiGateway.gatewayId })
      baseUrl = cloudflareGatewayBaseUrl(baseUrl, cloudflareAiGateway)
    } catch (error) { endpointError = error instanceof Error && error.message.startsWith("[") ? error.message : "Invalid Cloudflare AI Gateway configuration" }
    let cloudflareWorkersAi: CloudflareWorkersAIConfig | undefined
    if (id === "cloudflare-workers-ai") try {
      const config = CloudflareWorkersAIConfig.parse({ ...(entry?.options?.accountId ? { accountId: entry.options.accountId } : {}), ...entry?.cloudflareWorkersAi })
      const accountId = cloudflareWorkersAccount(config, env())
      cloudflareWorkersAi = accountId ? { accountId } : {}
      baseUrl = cloudflareWorkersBaseUrl(baseUrl, accountId)
    } catch (error) { endpointError = error instanceof Error && !error.message.startsWith("[") ? "Invalid Cloudflare Workers AI configuration" : error instanceof Error ? error.message : "Invalid Cloudflare Workers AI configuration" }
    let sapAi: import("@mendcode/protocol").SapAIConfig | undefined
    let gitlab: import("@mendcode/protocol").GitLabConfig | undefined
    if (id === "gitlab") try {
      gitlabUrl(baseUrl)
      gitlab = gitlabConfig({ ...entry?.gitlab, ...(entry?.gitlab?.aiGatewayUrl ? {} : env().GITLAB_AI_GATEWAY_URL ? { aiGatewayUrl: env().GITLAB_AI_GATEWAY_URL! } : {}) })
    } catch { endpointError = `${endpointRule("GitLab instance and AI Gateway")}; set GITLAB_INSTANCE_URL or baseUrl, and check the gitlab configuration` }
    if (id === "sap-ai-core") try {
      sapAi = sapAiConfig({ ...(entry?.sapAi ?? {}), ...(entry?.sapAi?.deploymentId ? {} : env().AICORE_DEPLOYMENT_ID ? { deploymentId: env().AICORE_DEPLOYMENT_ID! } : {}), ...(entry?.sapAi?.resourceGroup ? {} : env().AICORE_RESOURCE_GROUP ? { resourceGroup: env().AICORE_RESOURCE_GROUP! } : {}) })
      baseUrl = sapAiRoot(baseUrl, key)
    } catch (error) { endpointError = error instanceof Error ? error.message : "Invalid SAP AI Core configuration" }
    if (type === "google" && baseUrl) try { geminiUrl(baseUrl) } catch { endpointError = endpointRule("Gemini") }
    if (id === "perplexity") try { perplexityUrl(baseUrl) } catch { endpointError = endpointRule("Perplexity Sonar") }
    if (id === "alibaba") try { alibabaUrl(baseUrl) } catch { endpointError = endpointRule("Alibaba") }
    if (id === "opencode") try { zenUrl(baseUrl) } catch { endpointError = endpointRule("OpenCode Zen") }
    if (id === "llmgateway") try { llmgatewayUrl(baseUrl) } catch { endpointError = endpointRule("LLMGateway") }
    if (id === "nvidia") try { nvidiaUrl(baseUrl) } catch { endpointError = endpointRule("NVIDIA") }
    if (id === "zenmux") try { zenmuxUrl(baseUrl) } catch { endpointError = endpointRule("Zenmux") }
    if (togetherai) try { togetheraiUrl(baseUrl) } catch { endpointError = endpointRule("TogetherAI") }
    if (id === "kilo") try { kiloUrl(baseUrl) } catch { endpointError = endpointRule("Kilo") }
    if (isGatewayPreset(id) && baseUrl) try { gatewayUrl(id, baseUrl) } catch { endpointError = endpointRule(GATEWAY_PRESETS[id]!.label) }
    if (id === "opencode" && credential === "public") endpointError = "OpenCode Zen requires an API key; anonymous public access is disabled"
    const { baseURL: _base, timeout: _timeout, chunkTimeout: _chunk, resourceName: _resource, apiVersion: _version, useCompletionUrls: _completion, useDeploymentBasedUrls: _deployment, region: _region, profile: _profile, endpoint: _endpoint, auth: _auth, allowCredentialProcess: _process, allowMetadata: _metadata, project: _project, location: _location, tokenEnv: _tokenEnv, quotaProject: _quota, ...generation } = entry?.options ?? {}
    if (type === "mistral" || type === "cohere" || deepinfra || cerebras || togetherai || id === "kilo") delete generation.apiKey
    const togetheraiHeaders = togetherai && entry?.options?.headers !== undefined ? ModelHeaders.safeParse(entry.options.headers) : undefined
    const kiloOptionsHeaders = id === "kilo" && entry?.options?.headers !== undefined ? ModelHeaders.safeParse(entry.options.headers) : undefined
    if (kiloOptionsHeaders && !kiloOptionsHeaders.success) endpointError = "invalid Kilo headers"
    if (togetherai || id === "kilo") delete generation.headers
    if (togetheraiHeaders && !togetheraiHeaders.success) endpointError = "invalid TogetherAI headers"
    const problem = endpointError ?? (unsupportedSdk ? `unsupported SDK ${entry.npm}; configure an explicit wire type` : !baseUrl ? `${id} needs a baseUrl (set it with providers.set)` : enabled && !authReady ? vertex ? "Google ADC credentials are missing; metadata is off by default" : bedrock ? "AWS credentials or Bedrock bearer token are missing" : azure?.auth === "entra" ? "Azure Entra credentials are missing" : `no API key (set ${entry?.apiKeyEnv ?? preset?.keyEnv ?? "the provider's environment variable"} or use providers.set apiKey)` : fileError)
    if (id === "cloudflare-workers-ai") { delete generation.accountId; delete generation.apiKey }
    if (id === "cloudflare-ai-gateway") for (const name of ["accountId", "gatewayId", "gateway", "metadata", "cacheTtl", "cacheKey", "skipCache", "collectLog", "headers", "apiKey"]) delete generation[name]
    const parsedOptions = ModelParameters.safeParse({ ...generation, ...entry?.parameters })
    const timeout = entry?.timeout ?? entry?.options?.timeout
    const chunkTimeout = entry?.chunkTimeout ?? entry?.options?.chunkTimeout
    const offline = metadataModels(id)
    const listed = type === "azure" ? entry?.models ?? [] : offline && entry?.models?.length ? [...offline.filter((model) => !entry.models!.some((override) => override.id === model.id)), ...entry.models.map((model) => ({ ...offline.find((base) => base.id === model.id), ...model }))] : entry?.models?.length ? entry.models : offline ?? preset?.models ?? []
    // models.dev's facts fill what the provider's own listing leaves out (its reasoning levels, its price); a configured field wins.
    const models = options.modelsDev ? listed.map((model) => ({ ...options.modelsDev!.facts(id, model.id), ...Object.fromEntries(Object.entries(model).filter(([, value]) => value !== undefined)) }) as ProviderModel) : listed
    // Read once for the provider, not once per model: a provider listing hundreds of models made every catalog listing hundreds of settings reads.
    const settings = options.settings?.() ?? {}
    return {
      id,
      name: entry?.name ?? preset?.name ?? id,
      type,
      baseUrl: azureError ? "" : baseUrl,
      enabled: enabled && parsedOptions.success && !endpointError,
      source,
      key,
      keyRequired,
      headers: togetherai ? { ...(togetheraiHeaders?.success ? togetheraiHeaders.data : {}), ...entry?.headers } : id === "kilo" ? { ...(kiloOptionsHeaders?.success ? kiloOptionsHeaders.data : {}), ...entry?.headers } : entry?.headers,
      reasoningStyle: preset?.reasoningStyle,
      models: models.map((model) => togetherai ? { ...model, variants: model.variants ?? togetheraiVariants(model) } : cerebras ? { ...model, variants: { ...cerebrasVariants(model), ...model.variants } } : deepinfra ? { ...model, variants: { ...deepinfraVariants(model), ...model.variants } } : type === "xai" ? { ...model, variants: model.variants ?? xaiVariants(model.id) } : type === "mistral" ? { ...model, variants: model.variants ?? (model.effort === false || model.reasoning === false ? {} : mistralVariants(model.id)) } : id === "perplexity" ? { ...model, images: false, tool_call: false } : model).filter((model) => (!entry?.whitelist || entry.whitelist.includes(model.id)) && !entry?.blacklist?.includes(model.id) && !(id === "opencode" && zenFree(model)) && modelAllowed(namespacedModel(id, model.id), settings, id)),
      ...(parsedOptions.success ? { parameters: parsedOptions.data } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
      ...(chunkTimeout !== undefined ? { chunkTimeout } : {}),
      error: parsedOptions.success ? problem : "invalid provider generation options",
      compaction: entry?.compaction,
      ...(entry?.npm ? { npm: entry.npm, nativeSdk } : {}),
      ...(azure ? { azure, authReady } : {}),
      ...(bedrock ? { bedrock, authReady } : {}),
      ...(vertex ? { vertex, authReady } : {}),
      ...(sapAi ? { sapAi } : {}),
      ...(gitlab ? { gitlab } : {}),
      ...(cloudflareWorkersAi ? { cloudflareWorkersAi } : {}),
      ...(cloudflareAiGateway ? { cloudflareAiGateway } : {}),
    }
  }

  /** Providers with a config entry, then presets enabled by an environment key alone. */
  function resolveAll(readOnly = false): Resolved[] {
    const { entries, fileError } = load(readOnly)
    const configured = { ...entries }
    for (const [id, entry] of Object.entries(options.settings?.().provider ?? {})) configured[id] = Entry.parse({ ...entries[id], ...entry })
    const out = Object.entries(configured).map(([id, entry]) => resolveOne(id, entry, "config", fileError))
    // Providers that user extensions register (`api.registerProvider` with a baseUrl): the user's own entry of the same id wins.
    for (const [id, raw] of Object.entries(options.extensions?.() ?? {})) {
      if (configured[id] || PROVIDER_PRESETS[id] || !PROVIDER_ID.test(id)) continue
      const entry = Entry.safeParse(raw)
      if (entry.success) out.push(resolveOne(id, entry.data, "extension", undefined))
    }
    for (const [id, preset] of Object.entries(PROVIDER_PRESETS)) {
      if (configured[id] || !(isVertexType(preset?.type) && (vertexRouting({}, env()).project || adc().ready()) || preset.keyEnv && env()[preset.keyEnv]?.trim() || id === "cloudflare-ai-gateway" && env().CF_AIG_TOKEN?.trim() || id === "azure" && (env().AZURE_OPENAI_ENDPOINT || env().AZURE_RESOURCE_NAME || env().AZURE_OPENAI_API_KEY || entra().ready()) || id === "amazon-bedrock" && (env().AWS_PROFILE || env().AWS_ACCESS_KEY_ID || env().AWS_WEB_IDENTITY_TOKEN_FILE || aws({ region: bedrockRegion(undefined, env()) }).ready()))) continue
      out.push(resolveOne(id, undefined, "env", fileError))
    }
    if (!out.some((provider) => provider.id === "github-copilot") && copilotAuth.status().source === "v2") out.push(resolveOne("github-copilot", undefined, "config", fileError))
    return out
  }

  const find = (id: string) => resolveAll().find((provider) => provider.id === id)

  const info = (provider: Resolved): ProviderInfo => ({
    id: provider.id,
    type: provider.type,
    baseUrl: provider.baseUrl,
    enabled: provider.enabled,
    hasKey: !provider.vertex && provider.azure?.auth !== "entra" && provider.key !== undefined,
    ...(!isVertexType(provider.type) && provider.type !== "amazon-bedrock" && provider.type !== "github-copilot" && !["sap-ai-core", "gitlab", "cloudflare-workers-ai", "cloudflare-ai-gateway"].includes(provider.id) && provider.azure?.auth !== "entra" && provider.key && maskTail(provider.key) ? { keyTail: maskTail(provider.key)! } : {}),
    source: provider.source,
    models: provider.models.map((model) => publicModel(model, provider.id === "cloudflare-ai-gateway")),
    ...(provider.npm ? { npm: provider.npm } : {}),
    ...(provider.error ? { error: provider.error } : {}),
    ...(provider.compaction ? { compaction: provider.compaction } : {}),
    ...(provider.azure ? { azure: provider.azure } : {}),
    ...(provider.bedrock ? { bedrock: provider.bedrock, authReady: provider.authReady } : {}),
    ...(provider.vertex ? { vertex: provider.vertex, authReady: provider.authReady } : {}),
    ...(provider.sapAi ? { sapAi: provider.sapAi } : {}),
    ...(provider.gitlab ? { gitlab: provider.gitlab } : {}),
    ...(provider.cloudflareWorkersAi ? { cloudflareWorkersAi: provider.cloudflareWorkersAi } : {}),
    ...(provider.cloudflareAiGateway ? { cloudflareAiGateway: gatewayInfo(provider.cloudflareAiGateway) } : {}),
  })

  /** The adapter's view of a provider: the key is fetched per request through `keyOf`, never copied. */
  const forAdapter = (provider: Resolved): ResolvedProvider => ({
    id: provider.id,
    type: provider.type,
    baseUrl: provider.baseUrl,
    apiKey: () => keyOf(provider.id, load().entries[provider.id]),
    keyRequired: provider.keyRequired,
    ...(isDeepInfra(provider) ? { deepinfra: true } : {}),
    ...(isCerebras(provider) ? { cerebras: true } : {}),
    ...(isTogetherAI(provider) ? { togetherai: true } : {}),
    ...(provider.headers ? { headers: provider.headers } : {}),
    ...(provider.reasoningStyle ? { reasoningStyle: provider.reasoningStyle } : {}),
    models: provider.models,
    ...(provider.parameters ? { parameters: provider.parameters } : {}),
    // `/fast` applies to OpenAI's own host only; other "openai"-typed endpoints may reject the field.
    ...(provider.id === "openai" && provider.type === "openai" ? { serviceTier: () => options.settings?.().serviceTier === "fast" ? "priority" as const : undefined } : {}),
    ...(provider.timeout !== undefined ? { timeout: provider.timeout } : {}),
    ...(provider.chunkTimeout !== undefined ? { chunkTimeout: provider.chunkTimeout } : {}),
    ...(provider.compaction ? { compaction: provider.compaction } : {}),
    ...(provider.npm && !provider.nativeSdk ? { npm: provider.npm } : {}),
    ...(provider.id === "github-copilot" ? { copilotToken: () => copilotAuth.tokenForRequest() } : {}),
    ...(provider.azure ? { azure: provider.azure, azureToken: (signal: AbortSignal) => entra(provider.azure?.tokenEnv).token(signal) } : {}),
    ...(provider.bedrock ? { bedrock: provider.bedrock, awsCredentials: (signal: AbortSignal) => aws(provider.bedrock!).get(signal) } : {}),
    ...(provider.vertex ? { vertex: provider.vertex, googleToken: (signal: AbortSignal) => adc(provider.vertex).token(signal), googleQuotaProject: () => adc(provider.vertex).quotaProject() } : {}),
    ...(provider.sapAi ? { sapAi: provider.sapAi } : {}),
    ...(provider.gitlab ? { gitlab: provider.gitlab } : {}),
    ...(provider.cloudflareAiGateway ? { cloudflareAiGateway: provider.cloudflareAiGateway } : {}),
  })

  const adapters = new Map<string, { signature: string; provider: ModelProvider }>()

  function validateSet(input: ProviderSetInput, current: Entry | undefined): string | undefined {
    const parsedId = ProviderId.safeParse(input.id)
    if (!parsedId.success) return `invalid provider id "${input.id}" (lowercase letters, digits, - and _, starting with a letter; "chatgpt" is reserved)`
    const preset = PROVIDER_PRESETS[input.id]
    const deepinfra = isDeepInfra({ id: input.id, npm: input.npm ?? current?.npm })
    const cerebras = isCerebras({ id: input.id, npm: input.npm ?? current?.npm })
    const togetherai = isTogetherAI({ id: input.id, npm: input.npm ?? current?.npm })
    const cohere =isCohere({ id: input.id, type: input.providerType ?? current?.type, npm: input.npm ?? current?.npm })
    if (cohere && input.providerType && input.providerType !== "cohere") return "Cohere requires the cohere wire format"
    if (cohere && (input.enabled === true || input.baseUrl !== undefined)) try { cohereUrl(input.baseUrl ?? current?.baseUrl ?? current?.options?.baseURL ?? current?.api ?? preset?.baseUrl ?? "") } catch { return endpointRule("Cohere") }
    if (cohere && input.enabled === true && !keyOf(input.id, { ...current, type: "cohere", ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}), ...(input.apiKeyEnv ? { apiKeyEnv: input.apiKeyEnv } : {}) } as Entry)) return "Cohere requires an API key before enablement"
    if (cerebras && input.providerType && input.providerType !== "openai-compatible") return "Cerebras requires the openai-compatible wire format"
    if (cerebras && (input.enabled === true || input.baseUrl !== undefined)) try { cerebrasUrl(input.baseUrl ?? current?.baseUrl ?? current?.options?.baseURL ?? current?.api ?? preset?.baseUrl ?? "") } catch { return endpointRule("Cerebras") }
    if (deepinfra && input.providerType && input.providerType !== "openai-compatible") return "DeepInfra requires the openai-compatible wire format"
    if (deepinfra && (input.enabled === true || input.baseUrl !== undefined)) try { deepinfraBaseUrl(input.baseUrl ?? current?.baseUrl ?? current?.options?.baseURL ?? current?.api ?? preset?.baseUrl ?? "") } catch { return endpointRule("DeepInfra") }
    if (togetherai) {
      if (input.providerType && input.providerType !== "openai-compatible") return "TogetherAI requires providerType openai-compatible"
      if (input.enabled === true || input.baseUrl !== undefined) try { togetheraiUrl(input.baseUrl ?? current?.baseUrl ?? current?.options?.baseURL ?? current?.api ?? preset?.baseUrl ?? "") } catch { return endpointRule("TogetherAI") }
      if (input.enabled === true && !(input.apiKey !== undefined ? input.apiKey.trim() : keyOf(input.id, { ...current, ...(input.apiKeyEnv ? { apiKeyEnv: input.apiKeyEnv } : {}) } as Entry))) return "TogetherAI requires an API key before enablement"
    }
    if (preset && input.providerType && input.providerType !== preset.type) return `${input.id} is a ${preset.type} provider; its type cannot change`
    if ((preset?.type ?? input.providerType ?? current?.type) === "xai" && input.baseUrl !== undefined) try { xaiBaseUrl(input.baseUrl) } catch { return "xAI endpoint requires HTTPS or loopback HTTP without credentials, query or fragment" }
    if ((preset?.type ?? input.providerType ?? current?.type ?? (current?.npm === "@ai-sdk/mistral" ? "mistral" : undefined)) === "mistral") try { mistralBaseUrl(input.baseUrl ?? current?.baseUrl ?? current?.options?.baseURL ?? preset?.baseUrl ?? "") } catch { return "Mistral endpoint requires HTTPS or loopback HTTP without credentials, query or fragment" }
    if (!preset && !deepinfra && !cerebras && !cohere && !togetherai && !(input.providerType ?? current?.type)) return `${input.id} is not a built-in provider: give it a providerType (openai, anthropic, openai-compatible or google)`
    if (!preset && !deepinfra && !cerebras && !cohere && !togetherai && !(input.baseUrl ?? current?.baseUrl)) return `${input.id} is not a built-in provider: give it a baseUrl`
    if (input.apiKey && input.id !== "sap-ai-core" && !KEY.test(input.apiKey.trim())) return "the API key must be visible ASCII without spaces"
    if ((preset?.type ?? input.providerType ?? current?.type) === "google" && input.baseUrl !== undefined) try { geminiUrl(input.baseUrl) } catch { return endpointRule("Gemini") }
    if (input.id === "perplexity" && (input.enabled === true || input.baseUrl !== undefined)) {
      try { perplexityUrl(input.baseUrl ?? current?.baseUrl ?? current?.options?.baseURL ?? current?.api ?? preset?.baseUrl ?? "") } catch { return endpointRule("Perplexity Sonar") }
    }
    if (input.id === "alibaba" && (input.enabled === true || input.baseUrl !== undefined)) {
      try { alibabaUrl(input.baseUrl ?? current?.baseUrl ?? current?.options?.baseURL ?? current?.api ?? preset?.baseUrl ?? "") } catch { return endpointRule("Alibaba") }
    }
    if (input.id === "opencode" && (input.enabled === true || input.baseUrl !== undefined)) {
      try { zenUrl(input.baseUrl ?? current?.baseUrl ?? current?.options?.baseURL ?? current?.api ?? preset?.baseUrl ?? "") } catch { return endpointRule("OpenCode Zen") }
    }
    if (input.id === "opencode" && input.apiKey?.trim() === "public") return "OpenCode Zen requires an API key; anonymous public access is disabled"
    if (input.id === "llmgateway" && (input.enabled === true || input.baseUrl !== undefined)) {
      try { llmgatewayUrl(input.baseUrl ?? current?.baseUrl ?? current?.options?.baseURL ?? current?.api ?? preset?.baseUrl ?? "") } catch { return endpointRule("LLMGateway") }
    }
    if (input.id === "nvidia" && (input.enabled === true || input.baseUrl !== undefined)) {
      try { nvidiaUrl(input.baseUrl ?? current?.baseUrl ?? current?.options?.baseURL ?? current?.api ?? preset?.baseUrl ?? "") } catch { return endpointRule("NVIDIA") }
    }
    if (input.id === "zenmux" && (input.enabled === true || input.baseUrl !== undefined)) {
      try { zenmuxUrl(input.baseUrl ?? current?.baseUrl ?? current?.options?.baseURL ?? current?.api ?? preset?.baseUrl ?? "") } catch { return endpointRule("Zenmux") }
    }
    if (isGatewayPreset(input.id) && (input.enabled === true || input.baseUrl !== undefined)) {
      try { gatewayUrl(input.id, input.baseUrl ?? current?.baseUrl ?? current?.options?.baseURL ?? current?.api ?? preset?.baseUrl ?? "") } catch { return endpointRule(GATEWAY_PRESETS[input.id]!.label) }
    }
    if (input.id === "kilo") {
      if (input.enabled === true || input.baseUrl !== undefined) try { kiloUrl(input.baseUrl ?? current?.baseUrl ?? current?.options?.baseURL ?? current?.api ?? preset?.baseUrl ?? "") } catch { return endpointRule("Kilo") }
      const credentials = {
        ...current,
        apiKey: input.apiKey !== undefined ? input.apiKey : input.apiKeyEnv !== undefined ? undefined : current?.apiKey,
        apiKeyEnv: input.apiKeyEnv ?? current?.apiKeyEnv,
        options: input.apiKey !== undefined || input.apiKeyEnv !== undefined ? { ...current?.options, apiKey: undefined } : current?.options,
      } as Entry
      if (input.enabled === true && !keyOf(input.id, credentials)) return "Kilo requires an API key before enablement"
    }
    // Opt-in providers never switch on without a credential. Excluded: those that authenticate through their own flows (device login, AWS chain, Entra, service key) and those with their own, earlier check.
    if (input.enabled === true && preset?.keyEnv && preset.defaultEnabled === false && !["github-copilot", "amazon-bedrock", "azure", "sap-ai-core", "gitlab", "cloudflare-workers-ai", "cloudflare-ai-gateway", "cohere", "togetherai", "kilo"].includes(input.id) && !(input.apiKey !== undefined ? input.apiKey.trim() : keyOf(input.id, { ...current, ...(input.apiKeyEnv ? { apiKeyEnv: input.apiKeyEnv } : {}) } as Entry))) return `${preset.name} requires an API key before enablement`
    if (input.cloudflareAiGateway && input.id !== "cloudflare-ai-gateway") return "cloudflareAiGateway settings require the Cloudflare AI Gateway provider"
    if (input.id === "cloudflare-ai-gateway") try {
      const config = gatewayConfig({ ...current, cloudflareAiGateway: { ...current?.cloudflareAiGateway, ...input.cloudflareAiGateway } })
      const endpoint = input.baseUrl ?? current?.baseUrl ?? current?.options?.baseURL ?? current?.api ?? ""
      if (input.enabled === true || input.baseUrl !== undefined) cloudflareGatewayBaseUrl(endpoint, { ...config, accountId: env().CLOUDFLARE_ACCOUNT_ID || config.accountId, gatewayId: env().CLOUDFLARE_GATEWAY_ID || config.gatewayId })
      const candidate = { ...current, ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}), ...(input.apiKeyEnv !== undefined ? { apiKeyEnv: input.apiKeyEnv } : {}) } as Entry
      if (input.enabled === true && !keyOf(input.id, candidate)) return "Cloudflare AI Gateway requires a token before enablement"
      if (input.models?.some((model) => !CLOUDFLARE_GATEWAY_MODEL.test(model.id))) return "Cloudflare AI Gateway model must use provider/model"
    } catch (error) { return error instanceof Error && error.message.startsWith("[") ? error.message : "Invalid Cloudflare AI Gateway configuration" }
    if (input.cloudflareWorkersAi && input.id !== "cloudflare-workers-ai") return "cloudflareWorkersAi settings require the Cloudflare Workers AI provider"
    if (input.id === "cloudflare-workers-ai") try {
      const config = CloudflareWorkersAIConfig.parse({ ...(current?.options?.accountId ? { accountId: current.options.accountId } : {}), ...current?.cloudflareWorkersAi, ...input.cloudflareWorkersAi })
      const accountId = cloudflareWorkersAccount(config, env())
      if (input.enabled === true || input.baseUrl !== undefined) cloudflareWorkersBaseUrl(input.baseUrl ?? current?.baseUrl ?? current?.options?.baseURL ?? current?.api ?? "", accountId)
      const candidate = { ...current, ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}), ...(input.apiKeyEnv !== undefined ? { apiKeyEnv: input.apiKeyEnv } : {}) } as Entry
      if (input.enabled === true && !keyOf(input.id, candidate)) return "Cloudflare Workers AI requires a Bearer token before enablement"
    } catch (error) { return error instanceof Error && error.message.startsWith("[") ? error.message : "Invalid Cloudflare Workers AI configuration" }
    if (input.sapAi && input.id !== "sap-ai-core") return "sapAi settings require the SAP AI Core provider"
    if (input.gitlab && input.id !== "gitlab") return "gitlab settings require the GitLab provider"
    if (input.id === "gitlab") try {
      const config = input.gitlab ?? current?.gitlab
      gitlabConfig({ ...config, ...(config?.aiGatewayUrl ? {} : env().GITLAB_AI_GATEWAY_URL ? { aiGatewayUrl: env().GITLAB_AI_GATEWAY_URL! } : {}) })
      if (input.enabled === true || input.baseUrl !== undefined) gitlabUrl(input.baseUrl ?? current?.baseUrl ?? current?.options?.baseURL ?? current?.api ?? env().GITLAB_INSTANCE_URL ?? "")
      if (input.enabled === true && !(input.apiKey?.trim() || keyOf(input.id, { ...current, ...(input.apiKeyEnv ? { apiKeyEnv: input.apiKeyEnv } : {}) } as Entry))) return "GitLab requires a token before enablement"
    } catch { return `${endpointRule("GitLab instance and AI Gateway")}, and a valid namespace` }
    if (input.id === "sap-ai-core") try {
      sapAiConfig(input.sapAi ?? current?.sapAi)
      const key = input.apiKey || keyOf(input.id, { ...current, ...(input.apiKeyEnv ? { apiKeyEnv: input.apiKeyEnv } : {}) } as Entry)
      if (input.apiKey) parseSapServiceKey(input.apiKey)
      if (input.enabled === true || input.baseUrl !== undefined) sapAiRoot(input.baseUrl ?? current?.baseUrl ?? "", key)
    } catch (error) { return error instanceof Error ? error.message : "Invalid SAP AI Core configuration" }
    if ((preset?.type ?? input.providerType ?? current?.type) === "amazon-bedrock") {
      const parsed = BedrockOptions.safeParse({ ...current?.bedrock, ...input.bedrock })
      if (!parsed.success) return "invalid Bedrock settings"
      if (input.baseUrl) try { awsEndpoint(input.baseUrl) } catch { return "AWS endpoint requires HTTPS or loopback HTTP without credentials, query or fragment" }
    } else if (input.bedrock) return "Bedrock settings require providerType amazon-bedrock"
    if ((preset?.type ?? input.providerType ?? current?.type) === "azure") {
      const parsed = AzureOptions.safeParse({ ...current?.azure, ...input.azure })
      if (!parsed.success) return "invalid Azure settings"
      const endpoint = input.baseUrl ?? current?.baseUrl ?? current?.options?.baseURL ?? env().AZURE_OPENAI_ENDPOINT
      if (endpoint) try { azureBaseUrl(endpoint) } catch { return "Azure endpoint must use HTTPS or loopback HTTP, without credentials, query or fragment" }
    } else if (input.azure) return "Azure settings require providerType azure"
    if ((preset?.type ?? input.providerType ?? current?.type) === "github-copilot") {
      try { copilotUrl(input.baseUrl ?? current?.baseUrl ?? preset?.baseUrl ?? "") } catch { return "Copilot endpoint must use HTTPS or loopback HTTP" }
    }
    if (isVertexType(preset?.type ?? input.providerType ?? current?.type)) {
      if (!vertexOptions({ ...current, vertex: { ...current?.vertex, ...input.vertex } } as Entry).success) return "invalid Vertex settings"
      if (input.apiKey || input.apiKeyEnv) return "Vertex uses ADC or vertex.tokenEnv, not an API key"
      const endpoint = input.vertex?.endpoint === null ? undefined : input.vertex?.endpoint ?? input.baseUrl ?? (current?.vertex?.endpoint === null ? undefined : current?.vertex?.endpoint ?? current?.baseUrl ?? current?.options?.baseURL)
      for (const value of [input.baseUrl, endpoint]) if (value) try { vertexEndpoint(value) } catch { return "Vertex endpoint requires HTTPS or loopback HTTP without credentials, query or fragment" }
      const anthropic = (preset?.type ?? input.providerType ?? current?.type) === "google-vertex-anthropic"
      if (input.models?.some((model) => !(anthropic ? VERTEX_ANTHROPIC_MODEL : /^(?:models\/)?[A-Za-z0-9._-]+$/).test(model.id))) return `invalid Vertex ${anthropic ? "Anthropic" : "Gemini"} model id`
    } else if (input.vertex) return "Vertex settings require providerType google-vertex or google-vertex-anthropic"
    if (input.npm && !ProviderSdkModule.safeParse(input.npm).success) return "SDK module must be installed or local"
    if (input.headers) for (const [name, value] of Object.entries(input.headers)) if (!HEADER_NAME.test(name) || /[\r\n]/.test(value)) return `invalid header ${name}`
    if (input.models) {
      const ids = new Set<string>()
      for (const model of input.models) {
        if (ids.has(model.id)) return `duplicate model ${model.id}`
        ids.add(model.id)
      }
    }
    return undefined
  }

  const service: ProviderService = {
    catalog() {
      const { entries, fileError } = load()
      const configured = { ...entries }
      for (const [id, entry] of Object.entries(options.settings?.().provider ?? {})) configured[id] = { ...configured[id], ...entry }
      return [...new Set([...Object.keys(PROVIDER_PRESETS), ...Object.keys(configured)])].sort().map((id) => info(resolveOne(id, configured[id], configured[id] ? "config" : "env", fileError)))
    },
    copilotAuth,
    list: (readOnly) => resolveAll(readOnly).map(info),
    imageTransport(id) {
      const provider = find(id)
      if (!provider?.enabled || !provider.baseUrl || provider.keyRequired && !provider.key || provider.type === "anthropic") return undefined
      return { baseUrl: provider.baseUrl, headers: { ...provider.headers, ...(provider.key ? { authorization: `Bearer ${provider.key}` } : {}) } }
    },
    inventory(options) {
      const { entries, fileError } = load(options?.readOnly)
      const ids = [...new Set([...Object.keys(PROVIDER_PRESETS), ...Object.keys(entries)])].sort()
      return ids.map((id) => {
        const owned = id === "github-copilot" && copilotAuth.status().source === "v2"
        const configured = Boolean(isVertexType(PROVIDER_PRESETS[id]?.type) && (vertexRouting({}, env()).project || adc().ready()) || entries[id] || keyOf(id, undefined) || owned || id === "azure" && (env().AZURE_OPENAI_ENDPOINT || env().AZURE_RESOURCE_NAME || entra().ready()) || id === "amazon-bedrock" && (env().AWS_PROFILE || env().AWS_ACCESS_KEY_ID || env().AWS_WEB_IDENTITY_TOKEN_FILE || aws({ region: bedrockRegion(undefined, env()) }).ready()))
        const provider = resolveOne(id, entries[id], entries[id] ? "config" : "env", fileError)
        const requiredEnv = id === "cloudflare-ai-gateway" ? [...new Set([entries[id]?.apiKeyEnv, "CLOUDFLARE_API_TOKEN", "CF_AIG_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_GATEWAY_ID"].filter((name): name is string => Boolean(name)))] : id === "cloudflare-workers-ai" ? [...new Set([entries[id]?.apiKeyEnv, "CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID"].filter((name): name is string => Boolean(name)))] : provider.vertex ? [provider.vertex.tokenEnv ?? "GOOGLE_OAUTH_ACCESS_TOKEN", "GOOGLE_APPLICATION_CREDENTIALS", "CLOUDSDK_CONFIG", "GOOGLE_CLOUD_PROJECT", "GCP_PROJECT", "GCLOUD_PROJECT", ...(provider.type === "google-vertex-anthropic" ? [] : ["GOOGLE_VERTEX_LOCATION"]), "GOOGLE_CLOUD_LOCATION", "VERTEX_LOCATION"] : provider.bedrock ? ["AWS_BEARER_TOKEN_BEDROCK", "AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_ROLE_ARN", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_CONTAINER_CREDENTIALS_FULL_URI"] : provider.azure?.auth === "entra" ? [provider.azure.tokenEnv ?? "AZURE_OPENAI_AUTH_TOKEN", "AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"] : [...new Set([entries[id]?.apiKeyEnv, PROVIDER_PRESETS[id]?.keyEnv ?? (isCerebras(provider) ? "CEREBRAS_API_KEY" : isCohere(provider) ? "COHERE_API_KEY" : undefined)].filter((name): name is string => Boolean(name)))]
        return { id, name: provider.name, type: provider.type, configured, enabled: configured && provider.enabled, authReady: owned ? ["authorized", "expired"].includes(copilotAuth.status().state) : provider.authReady ?? (!provider.keyRequired || Boolean(provider.key)), authMode: provider.vertex ? "google-adc" : provider.bedrock && !provider.key ? "aws-chain" : provider.azure?.auth === "entra" ? "azure-entra" : provider.type === "github-copilot" ? "github-copilot-oauth" : "api-key", models: provider.models.length, requiredEnv, presentEnv: requiredEnv.filter((name) => Boolean(env()[name]?.trim())), credentialStored: owned || Boolean(entries[id]?.apiKey || (provider.type === "mistral" || isDeepInfra(provider) || isCerebras(provider) || isCohere(provider) || isTogetherAI(provider) || id === "kilo") && entries[id]?.options?.apiKey), ...(provider.error ? { error: provider.error } : {}) }
      })
    },
    logout(id) {
      const { entries } = load()
      const entry = entries[id]
      const provider = find(id)
      const legacyKey = provider && (provider.type === "mistral" || isDeepInfra(provider) || isCerebras(provider) || isCohere(provider) || isTogetherAI(provider) || id === "kilo") && entry?.options?.apiKey
      if (!entry?.apiKey && !legacyKey) return { ok: false, code: "target_mismatch", message: `[DAEMON]: no stored credential for ${id}; environment credentials must be unset in the environment` }
      const { apiKey: _key, ...rest } = entry
      if (legacyKey && rest.options) {
        const { apiKey: _legacyKey, ...remaining } = rest.options
        rest.options = remaining
      }
      save({ ...entries, [id]: rest })
      return { ok: true, provider: info(find(id)!) }
    },
    set(input) {
      const { entries } = load()
      const current = entries[input.id]
      const problem = validateSet(input, current)
      if (problem) return { ok: false, code: "invalid_command", message: `[DAEMON]: ${problem}` }
      const next: Record<string, unknown> = { ...current }
      if (input.npm !== undefined) {
        next.npm = input.npm
        if (input.enabled === undefined && input.npm !== current?.npm) next.enabled = false
      }
      const assign = (field: string, value: unknown, clear: boolean) => (clear ? delete next[field] : (next[field] = value))
      if (input.providerType && !PROVIDER_PRESETS[input.id]) next.type = input.providerType
      if (input.baseUrl !== undefined) next.baseUrl = input.baseUrl.replace(/\/+$/, "")
      if (input.apiKey !== undefined || input.id === "kilo" && input.apiKeyEnv !== undefined) {
        const key = input.apiKey?.trim() ?? ""
        assign("apiKey", key, key === "")
        const legacyOptions = (next as Entry).options
        if (((next.type ?? PROVIDER_PRESETS[input.id]?.type) === "mistral" || next.npm === "@ai-sdk/mistral" || isDeepInfra({ id: input.id, npm: next.npm as string | undefined }) || isCerebras({ id: input.id, npm: next.npm as string | undefined }) || isCohere({ id: input.id, type: next.type as string | undefined, npm: next.npm as string | undefined }) || isTogetherAI({ id: input.id, npm: next.npm as string | undefined }) || input.id === "kilo") && legacyOptions?.apiKey !== undefined) {
          const { apiKey: _legacyKey, ...remaining } = legacyOptions
          next.options = remaining
        }
      }
      if (input.apiKeyEnv !== undefined) next.apiKeyEnv = input.apiKeyEnv
      if (input.headers !== undefined) assign("headers", input.headers, Object.keys(input.headers).length === 0)
      if (input.enabled !== undefined) next.enabled = input.enabled
      if (input.baseUrl !== undefined && isVertexType(PROVIDER_PRESETS[input.id]?.type ?? input.providerType ?? current?.type) && input.vertex?.endpoint === undefined) next.vertex = { ...current?.vertex, ...input.vertex, endpoint: input.baseUrl }
      if (input.vertex !== undefined) next.vertex = { ...current?.vertex, ...(typeof next.vertex === "object" ? next.vertex : {}), ...input.vertex }
      if (input.cloudflareAiGateway !== undefined) next.cloudflareAiGateway = { ...current?.cloudflareAiGateway, ...input.cloudflareAiGateway }
      if (input.azure !== undefined) next.azure = { ...current?.azure, ...input.azure }
      if (input.bedrock !== undefined) next.bedrock = { ...current?.bedrock, ...input.bedrock }
      if (input.baseUrl !== undefined && (PROVIDER_PRESETS[input.id]?.type ?? input.providerType ?? current?.type) === "amazon-bedrock" && input.bedrock?.endpoint === undefined) next.bedrock = { ...current?.bedrock, ...input.bedrock, endpoint: input.baseUrl }
      for (const key of ["parameters", "timeout", "chunkTimeout", "whitelist", "blacklist", "sapAi", "gitlab", "cloudflareWorkersAi"] as const) if (input[key] !== undefined) next[key] = input[key]
      if (input.compaction !== undefined) assign("compaction", input.compaction, input.compaction === null)
      if (input.models !== undefined) {
        assign("models", input.models, input.models.length === 0)
        delete next.refreshedAt
      }
      const entry = Entry.parse(next)
      save({ ...entries, [input.id]: entry })
      return { ok: true, provider: info(find(input.id)!) }
    },
    remove(id) {
      const { entries } = load()
      if (!entries[id]) {
        const envOnly = find(id)
        if (envOnly) return { ok: false, code: "invalid_command", message: `[DAEMON]: ${id} comes from ${PROVIDER_PRESETS[id]?.keyEnv ?? "the environment"}; unset it, or use providers.set with enabled: false to hide it` }
        return { ok: false, code: "target_mismatch", message: `[DAEMON]: no provider named ${id}` }
      }
      const { [id]: _removed, ...rest } = entries
      save(rest)
      return { ok: true, providers: resolveAll().map(info) }
    },
    async test(id, model) {
      const provider = find(id)
      if (!provider) return undefined
      if (isCerebras(provider) && (!provider.enabled || provider.error)) return { ok: false, latencyMs: 0, error: provider.error ?? "Cerebras is disabled; connect it with an API key and explicitly enable it before testing" }
      if (isDeepInfra(provider) && (!provider.enabled || provider.error)) return { ok: false, latencyMs: 0, error: provider.enabled ? provider.error! : "DeepInfra is disabled; connect it with an API key and explicitly enable it before testing" }
      if (provider.id === "kilo" && (!provider.enabled || provider.error)) return { ok: false, latencyMs: 0, error: provider.error ?? "Kilo is disabled; explicitly enable it before testing" }
      if (isTogetherAI(provider) && (!provider.enabled || provider.error)) return { ok: false, latencyMs: 0, error: provider.error ?? "TogetherAI is disabled; explicitly enable it before testing" }
      if (isCohere(provider) && (!provider.enabled || provider.error)) return { ok: false, latencyMs: 0, error: provider.error ?? "Cohere is disabled; explicitly enable it before testing" }
      if (id === "cloudflare-ai-gateway" && (!provider.enabled || provider.error)) return { ok: false, latencyMs: 0, error: provider.error ?? "Cloudflare AI Gateway is disabled; explicitly enable it before testing" }
      if (id === "cloudflare-workers-ai" && (!provider.enabled || provider.error)) return { ok: false, latencyMs: 0, error: provider.error ?? "Cloudflare Workers AI is disabled; explicitly enable it before testing" }
      if (provider.type === "xai" && !provider.enabled) return { ok: false, latencyMs: 0, error: "xAI is disabled; explicitly enable it before testing" }
      if (provider.type === "xai" && provider.error) return { ok: false, latencyMs: 0, error: provider.error }
      if (provider.type === "mistral" && !provider.enabled) return { ok: false, latencyMs: 0, error: provider.error ?? "Mistral is disabled; explicitly enable it before testing" }
      if (provider.type === "mistral" && provider.error) return { ok: false, latencyMs: 0, error: provider.error }
      if (isVertexType(provider.type) && !provider.enabled) return { ok: false, latencyMs: 0, error: "Vertex is disabled; explicitly enable it before testing" }
      if (isVertexType(provider.type) && provider.error) return { ok: false, latencyMs: 0, error: provider.error }
      if (provider.type === "azure" && !provider.enabled) return { ok: false, latencyMs: 0, error: "Azure is disabled; explicitly enable it before testing" }
      if (provider.type === "amazon-bedrock" && !provider.enabled) return { ok: false, latencyMs: 0, error: "Bedrock is disabled; explicitly enable it before testing" }
      return testProvider({ provider: forAdapter(provider), model, ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.gitlabSocket ? { gitlabSocket: options.gitlabSocket } : {}) })
    },
    async refresh(id) {
      const provider = find(id)
      if (!provider) return { ok: false, code: "target_mismatch", message: `[DAEMON]: no provider named ${id}` }
      if (isCerebras(provider) && (!provider.enabled || provider.error)) return { ok: false, code: "invalid_command", message: `[DAEMON]: ${provider.error ?? "Cerebras is disabled; connect it with an API key and explicitly enable it before refreshing"}` }
      if (isDeepInfra(provider) && (!provider.enabled || provider.error)) return { ok: false, code: "invalid_command", message: `[DAEMON]: ${provider.enabled ? provider.error : "DeepInfra is disabled; connect it with an API key and explicitly enable it before refreshing"}` }
      if (id === "cloudflare-ai-gateway" && (!provider.enabled || provider.error)) return { ok: false, code: "invalid_command", message: provider.error ?? "Cloudflare AI Gateway is disabled; explicitly enable it before refreshing" }
      if (id === "cloudflare-workers-ai" && (!provider.enabled || provider.error)) return { ok: false, code: "invalid_command", message: provider.error ?? "Cloudflare Workers AI is disabled; explicitly enable it before refreshing" }
      if (provider.type === "xai" && !provider.enabled) return { ok: false, code: "invalid_command", message: "[DAEMON]: xAI is disabled; explicitly enable it before refreshing" }
      if (provider.type === "mistral" && (!provider.enabled || provider.error)) return { ok: false, code: "invalid_command", message: `[DAEMON]: ${provider.error ?? "Mistral is disabled; explicitly enable it before refreshing"}` }
      if (provider.type === "amazon-bedrock" && !provider.enabled) return { ok: false, code: "invalid_command", message: "[DAEMON]: Bedrock is disabled; explicitly enable it before refreshing" }
      if (id === "cloudflare-ai-gateway") return provider.models.length ? { ok: true, provider: info(provider) } : { ok: false, code: "invalid_command", message: "[DAEMON]: configure Cloudflare AI Gateway provider/model ids in models" }
      if (isVertexType(provider.type)) return provider.models.length ? { ok: true, provider: info(provider) } : { ok: false, code: "invalid_command", message: "[DAEMON]: configure Vertex publisher model ids in models" }
      if (provider.id === "kilo" && (!provider.enabled || provider.error)) return { ok: false, code: "invalid_command", message: `[DAEMON]: ${provider.error ?? "Kilo is disabled; explicitly enable it before refreshing"}` }
      if (isTogetherAI(provider) && (!provider.enabled || provider.error)) return { ok: false, code: "invalid_command", message: `[DAEMON]: ${provider.error ?? "TogetherAI is disabled; explicitly enable it before refreshing"}` }
      if (isCohere(provider) && (!provider.enabled || provider.error)) return { ok: false, code: "invalid_command", message: `[DAEMON]: ${provider.error ?? "Cohere is disabled; explicitly enable it before refreshing"}` }
      if (provider.type === "azure") return provider.models.length ? { ok: true, provider: info(provider) } : { ok: false, code: "invalid_command", message: "[DAEMON]: configure Azure deployment ids in models; refresh does not discover deployments" }
      try {
        const models = await fetchProviderModels({ provider: forAdapter(provider), ...(options.fetch ? { fetch: options.fetch } : {}) })
        if (models.length === 0) return { ok: false, code: "internal", message: `[DAEMON]: ${id} listed no models; the current list is unchanged` }
        const { entries } = load()
        const configured = new Map((entries[id]?.models ?? (isDeepInfra(provider) || isCerebras(provider) || isCohere(provider) || isTogetherAI(provider) ? provider.models : [])).map((model) => [model.id, model]))
        const refreshed = models.map((model) => {
          const previous = configured.get(model.id)
          if (provider.type === "amazon-bedrock" || provider.type === "xai" || provider.type === "mistral" || isDeepInfra(provider) || isCerebras(provider) || isCohere(provider) || isTogetherAI(provider) || id === "kilo") return { ...model, ...previous, id: model.id }
          return { ...model, ...(["opencode", "nvidia", "sap-ai-core"].includes(id) && previous ? { ...previous, ...model, provider: { ...previous.provider, ...model.provider } } : {}), ...(id === "gitlab" && previous ? previous : {}), ...(previous?.compaction ? { compaction: previous.compaction } : {}), ...(previous?.inputLimit ? { inputLimit: previous.inputLimit } : {}), ...(previous?.outputLimit ? { outputLimit: previous.outputLimit } : {}) }
        })
        if (provider.type === "amazon-bedrock") for (const model of configured.values()) if (typeof model.options?.bedrockModelId === "string" && !refreshed.some((entry) => entry.id === model.id)) refreshed.push(model)
        save({ ...entries, [id]: Entry.parse({ ...entries[id], models: refreshed, refreshedAt: Date.now() }) })
        return { ok: true, provider: info(find(id)!) }
      } catch (error) {
        return { ok: false, code: "internal", message: `[DAEMON]: ${safeMessage(error, provider.key, 500)}` }
      }
    },
    models(readOnly) {
      return resolveAll(readOnly)
        .filter((provider) => provider.enabled && provider.baseUrl && (provider.authReady ?? (!provider.keyRequired || provider.key)))
        .flatMap((provider) =>
          provider.models.map((model): ModelInfo => {
            const efforts: ModelInfo["efforts"] = isCerebras(provider) ? Object.values(cerebrasVariants(model)).flatMap((variant) => variant.effort ? [variant.effort] : []) : isDeepInfra(provider) ? Object.values(deepinfraVariants(model)).flatMap((variant) => variant.effort ? [variant.effort] : []) : provider.type === "xai" ? model.id.includes("grok-3-mini") ? ["low", "high"] : [] : provider.type === "mistral" ? model.effort !== false && model.reasoning !== false && mistralVariants(model.id).high ? ["high"] : [] : modelEfforts(model, provider.reasoningStyle)
            const preferred = model.effort || model.reasoning ? DEFAULT_PROVIDER_EFFORT[provider.type] : undefined
            const defaultEffort = preferred && efforts.includes(preferred) ? preferred : undefined
            return {
              ...Object.fromEntries(Object.entries(publicModel(model, provider.id === "cloudflare-ai-gateway")).filter(([key]) => !["id", "name", "provider", "context", "effort", "images", "variants"].includes(key))),
              id: namespacedModel(provider.id, model.id),
              name: provider.type === "github-copilot" || provider.id === "kilo" ? model.name ?? model.id : `${model.name ?? model.id} · ${provider.name}`,
              efforts,
              ...(defaultEffort ? { defaultEffort } : {}),
              ...(model.context ?? model.limit?.context ? { contextWindow: model.context ?? model.limit!.context } : {}),
              provider: provider.id,
              ...(model.images === false ? { images: false as const } : {}),
              ...(model.variants ? { variants: Object.fromEntries(Object.entries(model.variants).filter(([, variant]) => !variant.disabled)) } : {}),
              ...(model.compoundPricing ? { compoundPricing: model.compoundPricing } : {}),
            }
          }),
        )
    },
    runtime() {
      const table: Record<string, ModelProvider> = {}
      for (const provider of resolveAll()) {
        if (!provider.baseUrl && !isDeepInfra(provider)) continue
        if (!provider.enabled) {
          table[provider.id] = {
            id: provider.id,
            model: "",
            async *stream() {
              throw new Error(`[PROVIDER]: ${provider.id} is disabled (providers.set enabled: true turns it on)`)
            },
          }
          continue
        }
        const signature = JSON.stringify([provider.type, provider.baseUrl, provider.headers, provider.models, provider.reasoningStyle, provider.keyRequired, provider.parameters, provider.timeout, provider.chunkTimeout, provider.compaction, provider.npm, provider.nativeSdk, provider.azure, provider.bedrock, provider.vertex, provider.sapAi, provider.gitlab, provider.cloudflareAiGateway])
        let cached = adapters.get(provider.id)
        if (cached?.signature !== signature) {
          cached = { signature, provider: createApiProvider({ provider: forAdapter(provider), ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.idleTimeoutMs ? { idleTimeoutMs: options.idleTimeoutMs } : {}), ...(options.gitlabSocket ? { gitlabSocket: options.gitlabSocket } : {}) }) }
          adapters.set(provider.id, cached)
        }
        const adapter = cached.provider
        table[provider.id] = { ...adapter, async *stream(request) {
          const name = request.model ?? adapter.model
          if (!provider.models.some((model) => model.id === name)) throw new Error(`[PROVIDER]: ${provider.id}:${name} is excluded from the model catalog`)
          yield* adapter.stream(request)
        } }
      }
      return table
    },
  }
  copilotAuth.onAuthorized(() => {
    service.set({ id: "github-copilot", enabled: true })
    void service.refresh("github-copilot").catch(() => {})
  })
  return service
}
