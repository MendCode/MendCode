import type { ModelsReport, ProviderInfo, ProviderType, ProviderAuthMethod, ProviderAuthStatus, ProviderAuthorization } from "@mendcode/protocol"
import { glyphs as defaultGlyphs, type Glyphs, type Line, type Span } from "../ui/theme"
import { panelGrid, clip, spread, fit } from "./deck"
import { BASE_URL_PATTERN, CONNECT_PRESETS, ENV_NAME_PATTERN, GATEWAY_CHOICES, PROVIDER_ID_PATTERN, PROVIDER_TYPE_CHOICES, RESERVED_IDS, isOutboundEndpoint, isVertexPreset, OPENCODE_AGENT, OPENCODE_FREE, presetOf, providerName, type ConnectPreset } from "./provider-presets"
import { truncateEnd } from "./session-list"
import { wrap } from "./wrap"

/**
 * `/connect`: pick a preset (or a custom endpoint), give its key (masked; or the environment variable that holds it), then
 * the terminal asks the daemon to save it (`providers.set`) and to test it (`providers.test`, a user action). The key is typed
 * or pasted into `values.key`, is never drawn (only bullets), and leaves the state the moment it is submitted: the action
 * carries it to the app, which sends it once and keeps nothing.
 */

export type FieldId = "name" | "type" | "baseUrl" | "key" | "keyEnv" | "models" | "azureAuth" | "apiVersion" | "azureTransport" | "azureUrls" | "awsAuth" | "awsRegion" | "awsProfile" | "awsMetadata" | "awsProcess" | "vertexProject" | "vertexLocation" | "vertexMetadata" | "vertexQuotaProject" | "deploymentId" | "resourceGroup" | "rootNamespaceId" | "cloudflareAccountId" | "cloudflareGatewayId"

export type ConnectField = { id: FieldId; label: string; secret?: true; choice?: true; hint: string; placeholder?: string }

export type ConnectResult = { provider: string; ok: boolean; latencyMs?: number; model?: string; error?: string; refreshed?: number; note?: string }

export type ConnectState = {
  step: "pick" | "form" | "busy" | "result" | "methods" | "oauth"
  /** Cursor of the pick list. */
  selected: number
  /** A preset id or `custom`. */
  target?: string
  focus: number
  values: Record<Exclude<FieldId, "deploymentId" | "resourceGroup" | "rootNamespaceId" | "cloudflareAccountId" | "cloudflareGatewayId">, string> & Partial<Record<"deploymentId" | "resourceGroup" | "rootNamespaceId" | "cloudflareAccountId" | "cloudflareGatewayId", string>>
  /** Take the key from an environment variable instead of typing it. */
  viaEnv: boolean
  error?: string | undefined
  /** What the daemon is doing, while `step` is `busy`. */
  phase?: string
  result?: ConnectResult
  methods?: Record<string, ProviderAuthMethod[]> | undefined
  authorization?: ProviderAuthorization | undefined
  authStatus?: ProviderAuthStatus
  authStatuses?: Record<string, ProviderAuthStatus>
  confirmLogout?: boolean
  /** The pick list's filter: providers whose name or id contains it. */
  query?: string
  /** `/` was pressed: typed keys edit `query` instead of acting. */
  searching?: boolean
}

/** Indexes into `CONNECT_CHOICES` that the pick list shows for `query`, in their order. */
export function connectMatches(query: string | undefined): number[] {
  const wanted = query?.trim().toLowerCase() ?? ""
  return CONNECT_CHOICES.flatMap((id, index) => !wanted || id.includes(wanted) || choiceName(id).toLowerCase().includes(wanted) ? [index] : [])
}

/** What `providers.set` gets; `apiKey` is the only secret and lives in this object for one call. */
export type ConnectSubmit = { provider: string; providerType?: ProviderType; baseUrl?: string; apiKey?: string; apiKeyEnv?: string; models?: Array<{ id: string }>; azure?: import("@mendcode/protocol").AzureOptions; bedrock?: import("@mendcode/protocol").BedrockOptions; vertex?: import("@mendcode/protocol").VertexOptions; sapAi?: import("@mendcode/protocol").SapAIConfig; gitlab?: import("@mendcode/protocol").GitLabConfig; cloudflareWorkersAi?: import("@mendcode/protocol").CloudflareWorkersAIConfig; cloudflareAiGateway?: import("@mendcode/protocol").CloudflareAIGatewayConfig; enabled: true }

export type ConnectAction =
  | { type: "none" }
  | { type: "close" }
  | { type: "submit"; submit: ConnectSubmit }
  | { type: "test"; provider: string }
  | { type: "refresh"; provider: string }
  | { type: "model" }
  | { type: "authorize"; provider: string; method: string }
  | { type: "auth"; action: "cancel" | "refresh" | "logout" }
  | { type: "auth-status" }
  | { type: "copy-auth" }
  | { type: "add-opencode" }

const NONE: ConnectAction = { type: "none" }
/** Presets that ship a public HTTPS endpoint: the form's endpoint is an optional override, blank uses the preset's. */
const DEFAULT_ENDPOINT_PRESETS: readonly string[] = ["deepinfra", "cerebras", "cohere", "togetherai", "perplexity", "alibaba", "opencode", "llmgateway", "nvidia", "zenmux", "kilo", ...GATEWAY_CHOICES.filter((id) => id !== "atomic-chat")]
export const CUSTOM = "custom"
/** Preserve existing numeric shortcuts; newly added providers follow the original choices. */
export const CONNECT_CHOICES: readonly string[] = [...CONNECT_PRESETS.filter((preset) => !["google", "github-copilot", "azure", "amazon-bedrock", "google-vertex", "google-vertex-anthropic", "xai", "mistral", "deepinfra", "perplexity", "alibaba", "opencode", "llmgateway", "nvidia", "sap-ai-core", "zenmux", "gitlab", "cerebras", "cohere", "cloudflare-workers-ai", "cloudflare-ai-gateway", "togetherai", "kilo", ...GATEWAY_CHOICES].includes(preset.id)).map((preset) => preset.id), CUSTOM, "chatgpt", "google", "github-copilot", "azure", "amazon-bedrock", "google-vertex", "google-vertex-anthropic", "xai", "mistral", "deepinfra", "perplexity", "alibaba", "opencode", "llmgateway", "nvidia", "sap-ai-core", "zenmux", "gitlab", "cerebras", "cohere", "cloudflare-workers-ai", "cloudflare-ai-gateway", "togetherai", "kilo", ...GATEWAY_CHOICES, OPENCODE_FREE]

const UP = new Set(["\x1b[A", "\x1bOA", "\x10", "k"])
const DOWN = new Set(["\x1b[B", "\x1bOB", "\x0e", "j"])
const LEFT = new Set(["\x1b[D", "\x1bOD"])
const RIGHT = new Set(["\x1b[C", "\x1bOC", " "])
const BACKSPACE = new Set(["\x7f", "\b"])
const SHIFT_TAB = "\x1b[Z"
const CTRL_E = "\x05"
const CTRL_U = "\x15"
const MAX_LENGTH: Record<FieldId, number> = { name: 32, type: 40, baseUrl: 2048, key: 4096, keyEnv: 64, models: 4000, azureAuth: 16, apiVersion: 32, azureTransport: 16, azureUrls: 16, awsAuth: 16, awsRegion: 32, awsProfile: 128, awsMetadata: 3, awsProcess: 3, vertexProject: 128, vertexLocation: 64, vertexMetadata: 3, vertexQuotaProject: 128, deploymentId: 128, resourceGroup: 128, rootNamespaceId: 100, cloudflareAccountId: 64, cloudflareGatewayId: 64 }
const MAX_MODELS = 50
const MASK = "•"
const MASK_SHOWN = 32

const emptyValues = (): Record<FieldId, string> => ({ name: "", type: PROVIDER_TYPE_CHOICES[0]!, baseUrl: "", key: "", keyEnv: "", models: "", azureAuth: "api-key", apiVersion: "v1", azureTransport: "responses", azureUrls: "v1", awsAuth: "chain", awsRegion: "", awsProfile: "", awsMetadata: "off", awsProcess: "off", vertexProject: "", vertexLocation: "", vertexMetadata: "off", vertexQuotaProject: "", deploymentId: "", resourceGroup: "", rootNamespaceId: "", cloudflareAccountId: "", cloudflareGatewayId: "" })

/** `target` opens that provider's form at once (`/connect anthropic`); anything else starts at the pick list. */
export function createConnectState(target?: string): ConnectState {
  const raw = target?.trim().toLowerCase()
  const wanted = raw === "cloudflare" ? "cloudflare-workers-ai" : raw === "cloudflare gateway" ? "cloudflare-ai-gateway" : raw === "vertex anthropic" ? "google-vertex-anthropic" : raw === "vertex" ? "google-vertex" : raw === "bedrock" ? "amazon-bedrock" : raw === "zen" || raw === "opencode/zen" ? "opencode" : raw
  const match = wanted ? CONNECT_CHOICES.find((id) => id === wanted || presetOf(id)?.name.toLowerCase() === wanted) : undefined
  const base: ConnectState = { step: "pick", selected: 0, focus: 0, values: emptyValues(), viaEnv: false }
  return match ? openForm(base, match) : base
}

function openForm(from: ConnectState, target: string): ConnectState {
  const preset = presetOf(target)
  const values = emptyValues()
  if (preset?.keyless) values.baseUrl = preset.baseUrl
  const status = from.authStatuses?.[target === "openai" ? "chatgpt" : target] ?? (from.authStatus?.provider === target ? from.authStatus : undefined)
  const oauth = ["chatgpt", "github-copilot"].includes(target)
  return { step: oauth && (status?.source === "v2" || status?.state === "pending") ? "oauth" : oauth || (from.methods?.[target]?.length ?? 0) > 1 ? "methods" : "form", selected: Math.max(0, CONNECT_CHOICES.indexOf(target)), target, focus: 0, values, viaEnv: false, ...(from.methods ? { methods: from.methods } : {}), ...(status ? { authStatus: status } : {}), ...(from.authStatuses ? { authStatuses: from.authStatuses } : {}) }
}

export function connectWithMethods(state: ConnectState, methods: Record<string, ProviderAuthMethod[]>): ConnectState {
  return { ...state, methods, ...(state.target && state.step === "form" && !state.values.key && (methods[state.target]?.length ?? 0) > 1 ? { step: "methods" as const } : {}) }
}

/** The inputs of a target's form. Keyed presets need the key alone; a local server the URL; a custom endpoint everything. */
export function connectFields(target: string, viaEnv: boolean, azureAuth = "api-key", awsAuth = "chain"): ConnectField[] {
  const preset = presetOf(target)
  const models: ConnectField = { id: "models", label: "Models", hint: "model ids, comma separated (optional)", placeholder: "the provider's own list" }
  if (target === "foundry") return [
    { id: "baseUrl", label: "Endpoint", hint: "HTTPS OpenAI v1 root of your Foundry resource (required)", placeholder: "https://RESOURCE.services.ai.azure.com/openai/v1" },
    ...(viaEnv ? [] : [{ id: "key" as const, label: "API key", secret: true as const, hint: "Bearer key; masked and sent once to the daemon" }]),
  ]
  if (DEFAULT_ENDPOINT_PRESETS.includes(target)) return [
    { id: "baseUrl", label: "Endpoint", hint: `optional HTTPS override; blank uses ${preset!.baseUrl}`, placeholder: preset!.baseUrl },
    ...(viaEnv ? [] : [{ id: "key" as const, label: "API key", secret: true as const, hint: "Bearer key; masked and sent once to the daemon" }]),
  ]
  if (isVertexPreset(target)) return [
    { id: "vertexProject", label: "Project", hint: "config overrides GOOGLE_CLOUD_PROJECT, GCP_PROJECT, GCLOUD_PROJECT", placeholder: "$GOOGLE_CLOUD_PROJECT" },
    { id: "vertexLocation", label: "Location", hint: "regional endpoint or global; config overrides environment", placeholder: target === "google-vertex-anthropic" ? "$GOOGLE_CLOUD_LOCATION or global" : "$GOOGLE_VERTEX_LOCATION or us-central1" },
    { id: "baseUrl", label: "Endpoint", hint: "optional HTTPS or loopback HTTP override", placeholder: "regional Vertex endpoint" },
    { id: "keyEnv", label: "Token env", hint: "optional access-token variable; otherwise read ADC", placeholder: "GOOGLE_OAUTH_ACCESS_TOKEN" },
    { id: "vertexQuotaProject", label: "Quota project", hint: "optional x-goog-user-project for billing/quota", placeholder: "ADC quota project" },
    { id: "vertexMetadata", label: "Metadata", choice: true, hint: "opt in to Google instance service-account credentials" },
    { ...models, hint: target === "google-vertex-anthropic" ? "Claude publisher ids, e.g. claude-haiku-4-5@20251001" : "publisher model ids, comma separated (optional)" },
  ]
  if (target === "amazon-bedrock") return [
    { id: "awsRegion", label: "Region", hint: "config overrides AWS_REGION; fallback us-east-1", placeholder: "$AWS_REGION or us-east-1" },
    { id: "awsProfile", label: "Profile", hint: "config overrides AWS_PROFILE; blank uses the default chain", placeholder: "$AWS_PROFILE or default" },
    { id: "baseUrl", label: "Endpoint", hint: "optional HTTPS or loopback HTTP override", placeholder: "regional Bedrock endpoint" },
    { id: "awsAuth", label: "Auth", choice: true, hint: "AWS chain or Bedrock bearer token; a present token wins" },
    { id: "awsMetadata", label: "Metadata", choice: true, hint: "opt in to container/instance role credential requests" },
    { id: "awsProcess", label: "Cred. process", choice: true, hint: "opt in to executing credential_process from AWS config" },
    ...(awsAuth === "bearer" && !viaEnv ? [{ id: "key" as const, label: "Bearer token", secret: true as const, hint: "masked; sent once to the daemon" }] : []),
    { ...models, hint: "model ids or inference profile ids, comma separated (optional)" },
  ]
  if (target === "azure") return [
    { id: "baseUrl", label: "Resource/URL", hint: "Azure resource name or HTTPS endpoint", placeholder: "my-resource" },
    { id: "azureAuth", label: "Auth", choice: true, hint: "API key or Microsoft Entra ID" },
    { id: "apiVersion", label: "API version", hint: "v1 or the version required by your deployment" },
    { id: "azureTransport", label: "API", choice: true, hint: "Responses (v1 default) or Chat Completions" },
    { id: "azureUrls", label: "URLs", choice: true, hint: "v1 paths or legacy deployment-based paths" },
    ...(azureAuth === "entra" ? [{ id: "keyEnv" as const, label: "Token env", hint: "access token, or AZURE_TENANT_ID + AZURE_CLIENT_ID + AZURE_CLIENT_SECRET", placeholder: "AZURE_OPENAI_AUTH_TOKEN" }] : viaEnv ? [] : [{ id: "key" as const, label: "API key", secret: true as const, hint: "paste or type; it is sent once and never shown again" }]),
    { ...models, label: "Deployments", hint: "deployment ids, comma separated (required)", placeholder: "my-deployment" },
  ]
  if (target === "cloudflare-ai-gateway") return [
    { id: "baseUrl", label: "Endpoint", hint: "optional full Unified API root; blank routes through your account and gateway IDs", placeholder: "https://gateway.ai.cloudflare.com/v1/ACCOUNT/GATEWAY/compat" },
    ...(viaEnv ? [] : [{ id: "key" as const, label: "Gateway token", secret: true as const, hint: "masked; sent once to the daemon" }]),
    { id: "cloudflareAccountId", label: "Account ID", hint: "required unless you give a full endpoint", placeholder: "your Cloudflare account ID" },
    { id: "cloudflareGatewayId", label: "Gateway ID", hint: "required unless you give a full endpoint", placeholder: "your AI Gateway ID" },
    { ...models, hint: "provider/model ids, comma separated", placeholder: "configured/offline catalog" },
  ]
  if (target === "cloudflare-workers-ai") return [
    { id: "baseUrl", label: "Endpoint", hint: "optional full endpoint; blank routes through your account ID", placeholder: "https://api.cloudflare.com/client/v4/accounts/ACCOUNT/ai/v1" },
    ...(viaEnv ? [] : [{ id: "key" as const, label: "Bearer token", secret: true as const, hint: "masked; sent once to the daemon" }]),
    { id: "cloudflareAccountId", label: "Account ID", hint: "required unless you give a full endpoint; CLOUDFLARE_ACCOUNT_ID takes precedence", placeholder: "$CLOUDFLARE_ACCOUNT_ID or your account ID" },
    { ...models, hint: "Workers AI ids; blank keeps the configured/offline catalog", placeholder: "configured/offline catalog" },
  ]
  if (target === "gitlab") return [
    { id: "baseUrl", label: "GitLab URL", hint: "HTTPS URL of gitlab.com or your self-managed instance (required)", placeholder: "https://gitlab.example.com" },
    ...(viaEnv ? [] : [{ id: "key" as const, label: "Token", secret: true as const, hint: "GitLab access token; masked and sent once" }]),
    { id: "rootNamespaceId", label: "Namespace", hint: "optional Group ID for Duo Workflow models", placeholder: "gid://gitlab/Group/123" },
  ]
  if (target === "sap-ai-core") return [
    { id: "baseUrl", label: "AI Core URL", hint: "optional API root including /v2; blank uses the service key's AI_API_URL", placeholder: "https://api.ai.EXAMPLE.ondemand.com/v2" },
    ...(viaEnv ? [] : [{ id: "key" as const, label: "Service key", secret: true as const, hint: "JSON service key from your SAP BTP instance; masked and sent once" }]),
    { id: "deploymentId", label: "Deployment", hint: "optional; AICORE_DEPLOYMENT_ID or latest running orchestration deployment", placeholder: "automatic" },
    { id: "resourceGroup", label: "Resource group", hint: "optional; AICORE_RESOURCE_GROUP or default", placeholder: "default" },
    models,
  ]
  if (preset?.keyless) return [{ id: "baseUrl", label: "Base URL", hint: "where the server listens" }, models]
  if (preset) return viaEnv ? [] : [{ id: "key", label: "API key", secret: true, hint: "paste or type; it is sent once and never shown again" }]
  return [
    { id: "name", label: "Name", hint: "a short id for your models: corp:model-name", placeholder: "corp" },
    { id: "type", label: "Format", choice: true, hint: "← → the API the endpoint speaks" },
    { id: "baseUrl", label: "Base URL", hint: "the endpoint root, http(s)", placeholder: "https://llm.example.com/v1" },
    viaEnv
      ? { id: "keyEnv", label: "Key variable", hint: "environment variable the daemon reads on every request", placeholder: "MY_PROVIDER_KEY" }
      : { id: "key", label: "API key", secret: true, hint: "paste or type; it is sent once and never shown again" },
    models,
  ]
}

const canUseEnv = (target: string) => !isVertexPreset(target) && presetOf(target)?.keyless !== true
const fieldChoices = (field: FieldId): readonly string[] => field === "awsAuth" ? ["chain", "bearer"] : field === "vertexMetadata" || field === "awsMetadata" || field === "awsProcess" ? ["off", "on"] : field === "azureAuth" ? ["api-key", "entra"] : field === "azureTransport" ? ["responses", "chat"] : field === "azureUrls" ? ["v1", "deployment"] : PROVIDER_TYPE_CHOICES

const printable = (key: string) => key.length > 0 && !key.startsWith("\x1b") && [...key].every((char) => char >= " " && char !== "\x7f")

/** Text for a field from typed or pasted input: whitespace goes (keys, URLs and ids have none), model lists keep their separators. */
function clean(field: FieldId, text: string, serviceKey = false): string {
  // eslint-disable-next-line no-control-regex
  const plain = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, field === "models" ? "," : "")
  if (field === "models") return plain.replace(/[\r\n\t]+/g, ",")
  if (serviceKey && field === "key") return plain.replace(/[\r\n\t]+/g, " ")
  const joined = plain.replace(/\s+/g, "")
  return field === "name" ? joined.toLowerCase() : joined
}

function withValue(state: ConnectState, field: ConnectField, next: string): ConnectState {
  const { error: _error, ...rest } = state
  return { ...rest, values: { ...state.values, [field.id]: next.slice(0, MAX_LENGTH[field.id]) } }
}

function typeInto(state: ConnectState, text: string): ConnectState {
  if (state.step !== "form" || !state.target) return state
  const field = connectFields(state.target, state.viaEnv, state.values.azureAuth, state.values.awsAuth)[state.focus]
  if (!field || field.choice) return state
  const added = clean(field.id, text, state.target === "sap-ai-core")
  return added ? withValue(state, field, (state.values[field.id] ?? "") + added) : state
}

/** The daemon is working on `phase` ("Testing anthropic"); the form's values stay (the key is already gone). */
export function connectBusy(state: ConnectState, phase: string): ConnectState {
  const { error: _error, ...rest } = state
  return { ...rest, step: "busy", phase }
}

/** The save was refused: back to the form with the reason, on the field that holds the secret (empty again). */
export function connectFailed(state: ConnectState, error: string): ConnectState {
  const target = state.target ?? ""
  const at = connectFields(target, state.viaEnv, state.values.azureAuth, state.values.awsAuth).findIndex((field) => field.secret || field.id === "keyEnv")
  const { phase: _phase, ...rest } = state
  return { ...rest, step: "form", focus: Math.max(0, at), error, values: { ...state.values, key: "" } }
}

/** The test (or a refresh) finished: what to show and which keys follow. */
export function connectDone(state: ConnectState, result: ConnectResult): ConnectState {
  const { phase: _phase, error: _error, ...rest } = state
  return { ...rest, step: "result", result }
}

/** A bracketed paste: goes into the focused text field (masked when it is the key); ignored anywhere else. */
export function connectPaste(state: ConnectState, text: string): ConnectState {
  return typeInto(state, text)
}

function modelIds(raw: string): string[] {
  return [...new Set(raw.split(/[\s,]+/).filter(Boolean))]
}

/** The `providers.set` payload for a filled-in form, or what is wrong and which field to show. */
export function validateConnect(state: ConnectState): { ok: true; submit: ConnectSubmit } | { ok: false; error: string; focus: number } {
  const target = state.target ?? ""
  const preset = presetOf(target)
  const fields = connectFields(target, state.viaEnv, state.values.azureAuth, state.values.awsAuth)
  const at = (id: FieldId) => Math.max(0, fields.findIndex((field) => field.id === id))
  const { values } = state
  const models = modelIds(values.models)
  if (models.length > MAX_MODELS) return { ok: false, error: `at most ${MAX_MODELS} model ids`, focus: at("models") }
  if (models.some((id) => id.length > 66)) return { ok: false, error: "a model id is at most 66 characters", focus: at("models") }
  const modelList = models.length ? { models: models.map((id) => ({ id })) } : {}

  if (isVertexPreset(target)) {
    for (const field of ["vertexProject", "vertexQuotaProject"] as const) if (values[field] && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(values[field])) return { ok: false, error: "invalid GCP project", focus: at(field) }
    if (values.vertexLocation && !/^(global|[a-z]+(?:-[a-z0-9]+)+)$/.test(values.vertexLocation)) return { ok: false, error: "invalid Vertex location", focus: at("vertexLocation") }
    if (values.keyEnv && !ENV_NAME_PATTERN.test(values.keyEnv)) return { ok: false, error: "invalid token variable name", focus: at("keyEnv") }
    const anthropic = target === "google-vertex-anthropic"
    if (models.some((model) => !(anthropic ? /^[A-Za-z0-9][A-Za-z0-9._-]*(?:@[A-Za-z0-9._-]+)?$/ : /^(?:models\/)?[A-Za-z0-9._-]+$/).test(model))) return { ok: false, error: `invalid ${anthropic ? "Anthropic" : "Gemini"} model id`, focus: at("models") }
    if (values.baseUrl && !isOutboundEndpoint(values.baseUrl)) return { ok: false, error: "endpoint requires HTTPS or loopback HTTP", focus: at("baseUrl") }
    return { ok: true, submit: { provider: target, enabled: true, apiKey: "", ...modelList, vertex: { project: values.vertexProject || null, location: values.vertexLocation || null, endpoint: values.baseUrl || null, tokenEnv: values.keyEnv || "GOOGLE_OAUTH_ACCESS_TOKEN", quotaProject: values.vertexQuotaProject || null, allowMetadata: values.vertexMetadata === "on" } } }
  }

  if (target === "amazon-bedrock") {
    if (values.awsRegion && !/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(values.awsRegion)) return { ok: false, error: "invalid AWS region", focus: at("awsRegion") }
    if (values.awsProfile && !/^[A-Za-z0-9_.@-]{1,128}$/.test(values.awsProfile)) return { ok: false, error: "invalid AWS profile name", focus: at("awsProfile") }
    if (values.baseUrl && !isOutboundEndpoint(values.baseUrl)) return { ok: false, error: "endpoint requires HTTPS or loopback HTTP", focus: at("baseUrl") }
    if (values.awsAuth === "bearer" && !state.viaEnv && !values.key) return { ok: false, error: "enter a bearer token, or ctrl+e for AWS_BEARER_TOKEN_BEDROCK", focus: at("key") }
    return { ok: true, submit: {
      provider: target, enabled: true, ...modelList,
      bedrock: { region: values.awsRegion || null, profile: values.awsProfile || null, endpoint: values.baseUrl || null, auth: values.awsAuth === "bearer" ? "bearer" : "chain", allowMetadata: values.awsMetadata === "on", allowCredentialProcess: values.awsProcess === "on" },
      ...(values.awsAuth === "bearer" ? state.viaEnv ? { apiKeyEnv: "AWS_BEARER_TOKEN_BEDROCK", apiKey: "" } : { apiKey: values.key } : { apiKey: "" }),
    } }
  }

  if (target === "azure") {
    const resource = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(values.baseUrl)
    if (!resource && !isOutboundEndpoint(values.baseUrl)) return { ok: false, error: "enter an Azure resource name or HTTPS endpoint", focus: at("baseUrl") }
    if (!/^(v1|preview|\d{4}-\d{2}-\d{2}(?:-preview)?)$/.test(values.apiVersion)) return { ok: false, error: "API version: v1, preview or YYYY-MM-DD[-preview]", focus: at("apiVersion") }
    if (!models.length) return { ok: false, error: "enter at least one Azure deployment id", focus: at("models") }
    const auth = values.azureAuth === "entra" ? "entra" : "api-key"
    if (auth === "api-key" && !state.viaEnv && !values.key) return { ok: false, error: "enter the API key, or press ctrl+e to use AZURE_API_KEY", focus: at("key") }
    if (auth === "entra" && values.keyEnv && !ENV_NAME_PATTERN.test(values.keyEnv)) return { ok: false, error: "invalid token variable name", focus: at("keyEnv") }
    return { ok: true, submit: {
      provider: "azure", enabled: true, ...modelList,
      ...(resource ? { baseUrl: `https://${values.baseUrl}.openai.azure.com/openai` } : { baseUrl: values.baseUrl }),
      azure: { ...(resource ? { resourceName: values.baseUrl } : {}), apiVersion: values.apiVersion, useCompletionUrls: values.azureTransport === "chat", useDeploymentBasedUrls: values.azureUrls === "deployment", auth, ...(auth === "entra" ? { tokenEnv: values.keyEnv || "AZURE_OPENAI_AUTH_TOKEN" } : {}) },
      ...(auth === "entra" ? { apiKey: "" } : state.viaEnv ? { apiKeyEnv: "AZURE_API_KEY" } : { apiKey: values.key }),
    } }
  }

  if (target === "cloudflare-ai-gateway") {
    if (values.baseUrl && !isOutboundEndpoint(values.baseUrl)) return { ok: false, error: "endpoint requires HTTPS or loopback HTTP", focus: at("baseUrl") }
    for (const id of ["cloudflareAccountId", "cloudflareGatewayId"] as const) {
      if (!values[id] && !values.baseUrl) return { ok: false, error: `enter your Cloudflare ${id === "cloudflareAccountId" ? "account" : "gateway"} ID, or a full endpoint`, focus: at(id) }
      if (values[id] && !/^[A-Za-z0-9_-]{1,64}$/.test(values[id]!)) return { ok: false, error: "invalid Cloudflare routing id", focus: at(id) }
    }
    if (!models.length || models.some((id) => !/^[A-Za-z0-9_-]+\/[^\s]+$/.test(id))) return { ok: false, error: "enter at least one provider/model id", focus: at("models") }
    if (!state.viaEnv && !values.key) return { ok: false, error: "enter a gateway token, or ctrl+e for CLOUDFLARE_API_TOKEN", focus: at("key") }
    return { ok: true, submit: { provider: target, ...(values.baseUrl ? { baseUrl: values.baseUrl } : {}), enabled: true, cloudflareAiGateway: { accountId: values.cloudflareAccountId || null, gatewayId: values.cloudflareGatewayId || null }, ...(state.viaEnv ? { apiKeyEnv: "CLOUDFLARE_API_TOKEN", apiKey: "" } : { apiKey: values.key }), ...modelList } }
  }
  if (target === "cloudflare-workers-ai") {
    if (values.baseUrl && !isOutboundEndpoint(values.baseUrl)) return { ok: false, error: "endpoint requires HTTPS or loopback HTTP", focus: at("baseUrl") }
    if (!values.cloudflareAccountId && !values.baseUrl) return { ok: false, error: "enter your Cloudflare account ID, or a full endpoint", focus: at("cloudflareAccountId") }
    if (values.cloudflareAccountId && !/^[A-Za-z0-9_-]{1,64}$/.test(values.cloudflareAccountId)) return { ok: false, error: "invalid Cloudflare account id", focus: at("cloudflareAccountId") }
    if (!state.viaEnv && !values.key) return { ok: false, error: "enter a Bearer token, or ctrl+e for CLOUDFLARE_API_KEY", focus: at("key") }
    return { ok: true, submit: { provider: target, ...(values.baseUrl ? { baseUrl: values.baseUrl } : {}), enabled: true, cloudflareWorkersAi: { accountId: values.cloudflareAccountId || null }, ...(state.viaEnv ? { apiKeyEnv: "CLOUDFLARE_API_KEY", apiKey: "" } : { apiKey: values.key }), ...modelList } }
  }
  if (target === "gitlab") {
    if (!isOutboundEndpoint(values.baseUrl)) return { ok: false, error: "enter your GitLab instance as an HTTPS URL", focus: at("baseUrl") }
    if (values.rootNamespaceId && !/^gid:\/\/gitlab\/Group\/[1-9][0-9]*$/.test(values.rootNamespaceId)) return { ok: false, error: "namespace must be gid://gitlab/Group/<id>", focus: at("rootNamespaceId") }
    if (!state.viaEnv && !values.key) return { ok: false, error: "enter a token, or ctrl+e for GITLAB_TOKEN", focus: at("key") }
    return { ok: true, submit: { provider: "gitlab", baseUrl: values.baseUrl, ...(state.viaEnv ? { apiKeyEnv: "GITLAB_TOKEN" } : { apiKey: values.key }), gitlab: { ...(values.rootNamespaceId ? { rootNamespaceId: values.rootNamespaceId } : {}) }, enabled: true } }
  }

  if (target === "sap-ai-core") {
    if (values.baseUrl && !isOutboundEndpoint(values.baseUrl)) return { ok: false, error: "AI Core URL requires HTTPS or loopback HTTP", focus: at("baseUrl") }
    for (const id of ["deploymentId", "resourceGroup"] as const) if (values[id] && !/^[A-Za-z0-9_.-]{1,128}$/.test(values[id])) return { ok: false, error: `invalid ${id === "deploymentId" ? "deployment" : "resource group"}`, focus: at(id) }
    if (!state.viaEnv) try {
      const key = JSON.parse(values.key)
      if (![key.clientid, key.clientsecret].every((field) => typeof field === "string" && field.length > 0) || !isOutboundEndpoint(key.url) || !isOutboundEndpoint(key.serviceurls?.AI_API_URL)) throw new Error()
    } catch { return { ok: false, error: "enter a JSON service key with clientid, clientsecret and HTTPS OAuth/API URLs", focus: at("key") } }
    const sapAi = { ...(values.deploymentId ? { deploymentId: values.deploymentId } : {}), ...(values.resourceGroup ? { resourceGroup: values.resourceGroup } : {}) }
    return { ok: true, submit: { provider: target, ...(values.baseUrl ? { baseUrl: values.baseUrl } : {}), ...(state.viaEnv ? { apiKeyEnv: "AICORE_SERVICE_KEY" } : { apiKey: values.key }), sapAi, ...modelList, enabled: true } }
  }

  if (preset?.keyless) {
    if (!BASE_URL_PATTERN.test(values.baseUrl)) return { ok: false, error: "base URL must start with http:// or https://", focus: at("baseUrl") }
    return { ok: true, submit: { provider: preset.id, enabled: true, ...(values.baseUrl !== preset.baseUrl ? { baseUrl: values.baseUrl } : {}), ...modelList } }
  }
  if (preset) {
    let endpoint: { baseUrl?: string } = {}
    if (target === "foundry" && !values.baseUrl) return { ok: false, error: "enter your Foundry endpoint as an HTTPS URL", focus: at("baseUrl") }
    if (DEFAULT_ENDPOINT_PRESETS.includes(target) && values.baseUrl) {
      if (!isOutboundEndpoint(values.baseUrl)) return { ok: false, error: `${preset.name} endpoint requires HTTPS or loopback HTTP`, focus: at("baseUrl") }
      endpoint = { baseUrl: values.baseUrl }
    }
    if (state.viaEnv) return { ok: true, submit: { provider: preset.id, ...endpoint, apiKeyEnv: preset.keyEnv!, enabled: true } }
    if (!values.key) return { ok: false, error: "enter the API key, or press ctrl+e to use the environment variable", focus: at("key") }
    if (target === "opencode" && values.key === "public") return { ok: false, error: "enter an API key; anonymous access is disabled", focus: at("key") }
    return { ok: true, submit: { provider: preset.id, ...endpoint, apiKey: values.key, enabled: true } }
  }
  if (!PROVIDER_ID_PATTERN.test(values.name)) return { ok: false, error: "name: lowercase letters, digits, - or _, starting with a letter (32 max)", focus: at("name") }
  if (RESERVED_IDS.includes(values.name)) return { ok: false, error: `"${values.name}" is reserved`, focus: at("name") }
  if (presetOf(values.name)) return { ok: false, error: `"${values.name}" is a preset: pick it from the list`, focus: at("name") }
  if (!BASE_URL_PATTERN.test(values.baseUrl)) return { ok: false, error: "base URL must start with http:// or https://", focus: at("baseUrl") }
  const providerType = PROVIDER_TYPE_CHOICES.find((choice) => choice === values.type) ?? PROVIDER_TYPE_CHOICES[0]!
  const common = { provider: values.name, providerType, baseUrl: values.baseUrl, enabled: true as const, ...modelList }
  if (state.viaEnv) {
    if (!ENV_NAME_PATTERN.test(values.keyEnv)) return { ok: false, error: "key variable: letters, digits and _, not starting with a digit", focus: at("keyEnv") }
    return { ok: true, submit: { ...common, apiKeyEnv: values.keyEnv } }
  }
  if (!values.key) return { ok: false, error: "enter the API key, or press ctrl+e to use an environment variable", focus: at("key") }
  return { ok: true, submit: { ...common, apiKey: values.key } }
}

function formKey(state: ConnectState, key: string): { state: ConnectState; action: ConnectAction } {
  const target = state.target!
  const fields = connectFields(target, state.viaEnv, state.values.azureAuth, state.values.awsAuth)
  const focus = Math.max(0, Math.min(state.focus, fields.length - 1))
  const field = fields[focus]
  const stay = (next: ConnectState) => ({ state: next, action: NONE })
  const go = (index: number) => stay({ ...state, focus: Math.max(0, Math.min(index, fields.length - 1)) })

  if (key === "\x1b") return stay({ ...createConnectState(), selected: Math.max(0, CONNECT_CHOICES.indexOf(target)), methods: state.methods, ...(state.authStatuses ? { authStatuses: state.authStatuses } : {}) })
  if (key === CTRL_E && canUseEnv(target) && !(target === "azure" && state.values.azureAuth === "entra") && !(target === "amazon-bedrock" && state.values.awsAuth !== "bearer")) {
    const { error: _error, ...rest } = state
    // The focus follows the key: its field is replaced by the variable's (or back), wherever it sits in the form.
    const at = connectFields(target, !state.viaEnv, state.values.azureAuth, state.values.awsAuth).findIndex((candidate) => candidate.secret || candidate.id === "keyEnv" || ["azure", "amazon-bedrock"].includes(target) && candidate.id === "models")
    return stay({ ...rest, viaEnv: !state.viaEnv, focus: Math.max(0, at), values: { ...state.values, key: "" } })
  }
  if (key === "\r") {
    if (focus < fields.length - 1) return go(focus + 1)
    const checked = validateConnect(state)
    if (!checked.ok) return stay({ ...state, focus: checked.focus, error: checked.error })
    // The key goes with the action and is gone from the state from here on.
    const { error: _error, ...rest } = state
    return { state: { ...rest, step: "busy", phase: `Saving ${providerName(checked.submit.provider)}`, values: { ...state.values, key: "" } }, action: { type: "submit", submit: checked.submit } }
  }
  if (key === "\t" || DOWN.has(key)) return go(focus + 1)
  if (key === SHIFT_TAB || UP.has(key)) return go(focus - 1)
  if (!field) return stay(state)
  if (field.choice) {
    if (!LEFT.has(key) && !RIGHT.has(key)) return stay(state)
    const choices = fieldChoices(field.id)
    const at = Math.max(0, choices.indexOf(state.values[field.id] ?? ""))
    const count = choices.length
    const next = withValue(state, field, choices[(at + (LEFT.has(key) ? count - 1 : 1)) % count]!)
    return stay(["azureAuth", "awsAuth"].includes(field.id) ? { ...next, values: { ...next.values, key: "", keyEnv: "" } } : next)
  }
  if (BACKSPACE.has(key)) return stay(withValue(state, field, [...state.values[field.id] ?? ""].slice(0, -1).join("")))
  if (key === CTRL_U) return stay(withValue(state, field, ""))
  if (printable(key)) return stay(typeInto(state, key))
  return stay(state)
}

/** Handles one raw key. Returns the same state object when nothing changed. */
export function connectKey(state: ConnectState, key: string): { state: ConnectState; action: ConnectAction } {
  if (state.step === "methods") {
    if (key === "s" && !["azure", "amazon-bedrock"].includes(state.target ?? "")) return { state, action: { type: "auth-status" } }
    const methods = state.methods?.[state.target ?? ""] ?? []
    if (key === "\x1b") return { state: { ...createConnectState(), methods: state.methods, ...(state.authStatuses ? { authStatuses: state.authStatuses } : {}) }, action: NONE }
    if (UP.has(key) || DOWN.has(key)) return { state: { ...state, focus: Math.max(0, Math.min(methods.length - 1, state.focus + (UP.has(key) ? -1 : 1))) }, action: NONE }
    const method = methods[state.focus]
    if (key !== "\r" || !method) return { state, action: NONE }
    if (!method.available) return { state: { ...state, error: method.reason ?? "Method unavailable" }, action: NONE }
    if (method.type === "api") return { state: { ...state, step: "form", focus: 0, error: undefined, ...(state.target === "azure" ? { values: { ...state.values, azureAuth: method.id === "entra" ? "entra" : "api-key", key: "" } } : state.target === "amazon-bedrock" ? { values: { ...state.values, awsAuth: method.id === "aws-chain" ? "chain" : "bearer", key: "" } } : {}) }, action: NONE }
    return { state: { ...state, step: "busy", phase: "Starting authorization" }, action: { type: "authorize", provider: state.target!, method: method.id } }
  }
  if (state.step === "oauth") {
    if (state.confirmLogout) return key === "y" ? { state: { ...state, confirmLogout: false }, action: { type: "auth", action: "logout" } } : { state: { ...state, confirmLogout: false }, action: NONE }
    if (key === "\x1b") return { state, action: { type: "close" } }
    if (key === "c") return { state, action: { type: "copy-auth" } }
    if (key === "s") return { state, action: { type: "auth-status" } }
    if (key === "x" && state.authStatus?.state === "pending") return { state, action: { type: "auth", action: "cancel" } }
    if (key === "d" && state.authStatus?.source === "v2") return { state: { ...state, confirmLogout: true }, action: NONE }
    if (key === "r" && state.authStatus?.source === "v2") return { state, action: { type: "auth", action: "refresh" } }
    if (key === "m" && state.authStatus?.state === "authorized") return { state, action: { type: "model" } }
    if (key === "e" && state.authStatus?.state !== "pending") return { state: { ...state, step: "methods", authorization: undefined, error: undefined }, action: NONE }
    return { state, action: NONE }
  }
  if (state.step === "form" && state.target) return formKey(state, key)
  if (state.step === "busy") return { state, action: key === "\x1b" ? { type: "close" } : NONE }
  if (state.step === "pick") {
    const searched = searchKey(state, key)
    if (searched) return searched
  }
  if (key === "\x1b" || key === "q") return { state, action: { type: "close" } }
  if (state.step === "result") {
    const result = state.result
    if (!result) return { state, action: NONE }
    if (result.provider === OPENCODE_FREE) return { state, action: key === "m" && result.ok ? { type: "model" } : NONE }
    if (key === "t") return { state, action: { type: "test", provider: result.provider } }
    if (key === "r" && (result.ok || ["github-copilot", "llmgateway", "nvidia", "sap-ai-core", "zenmux", "gitlab", "kilo", "cloudflare-workers-ai", "cloudflare-ai-gateway"].includes(result.provider))) return { state, action: { type: "refresh", provider: result.provider } }
    if (key === "m" && result.ok) return { state, action: { type: "model" } }
    if (key === "e" && state.target) return { state: { ...state, step: "form", focus: 0, values: { ...state.values, key: "" } }, action: NONE }
    return { state, action: NONE }
  }
  const last = CONNECT_CHOICES.length - 1
  const go = (index: number) => {
    const next = Math.max(0, Math.min(index, last))
    return next === state.selected ? { state, action: NONE } : { state: { ...state, selected: next }, action: NONE }
  }
  if (UP.has(key)) return go(state.selected - 1)
  if (DOWN.has(key)) return go(state.selected + 1)
  if (/^[1-9]$/.test(key) && Number(key) - 1 <= last) return choose(state, CONNECT_CHOICES[Number(key) - 1]!)
  if (key === "\r") return choose(state, CONNECT_CHOICES[Math.max(0, Math.min(state.selected, last))]!)
  return { state, action: NONE }
}

/**
 * The pick list's search: `/` starts it, typed text filters the providers, ↑↓ move among the matches, enter connects the
 * selected one and esc ends the search (a second esc closes the page). Undefined: the key is the list's own.
 */
function searchKey(state: ConnectState, key: string): { state: ConnectState; action: ConnectAction } | undefined {
  const filtered = (query: string, searching: boolean): { state: ConnectState; action: ConnectAction } => {
    const matches = connectMatches(query)
    const selected = matches.includes(state.selected) ? state.selected : matches[0] ?? state.selected
    return { state: { ...state, query, searching, selected }, action: NONE }
  }
  if (!state.searching) return key === "/" ? filtered("", true) : undefined
  const query = state.query ?? ""
  const matches = connectMatches(query)
  // While searching, letters are text: j, k and q are typed, not moves or close.
  const typed = /^[\x20-\x7e]+$/.test(key)
  if (key === "\x1b") return { state: { ...state, query: "", searching: false }, action: NONE }
  if ((UP.has(key) || DOWN.has(key)) && !typed) {
    const at = Math.max(0, matches.indexOf(state.selected))
    const next = matches[Math.max(0, Math.min(matches.length - 1, at + (UP.has(key) ? -1 : 1)))]
    return { state: next === undefined ? state : { ...state, selected: next }, action: NONE }
  }
  if (key === "\r") return matches.includes(state.selected) ? choose({ ...state, query: "", searching: false }, CONNECT_CHOICES[state.selected]!) : { state, action: NONE }
  if (BACKSPACE.has(key)) return filtered(query.slice(0, -1), true)
  if (key === CTRL_U) return filtered("", true)
  if (typed) return filtered(`${query}${key}`.slice(0, 40), true)
  return { state, action: NONE }
}

/** A choice opens its form; OpenCode (free) has nothing to type and is added at once. */
function choose(state: ConnectState, target: string): { state: ConnectState; action: ConnectAction } {
  if (target !== OPENCODE_FREE) return { state: openForm(state, target), action: NONE }
  return { state: connectBusy({ ...state, selected: CONNECT_CHOICES.indexOf(target), target }, "Adding OpenCode"), action: { type: "add-opencode" } }
}

/** The OpenCode (free) row: added or not, and how many of its models `/model` lists. */
function opencodeMark(models: ModelsReport | undefined): { text: string; tone: "success" | "muted" } {
  const ids = models?.models.map((model) => model.id) ?? []
  const agent = `acp:${OPENCODE_AGENT.name}`
  if (!ids.includes(agent)) return { text: "no key · runs your opencode CLI", tone: "muted" }
  const offered = ids.filter((id) => id.startsWith(`${agent}/`)).length
  return { text: offered ? `added · ${offered} ${offered === 1 ? "model" : "models"}` : "added · models listed after its first turn", tone: "success" }
}

const OPENCODE_ABOUT = [
  "OpenCode's free Zen models through OpenCode's own agent (opencode acp), with no key.",
  "Requests go to opencode.ai under OpenCode's terms; the free tier can be rate limited.",
  "Needs opencode on the daemon's PATH: pnpm add -g opencode-ai",
]

// ---------------------------------------------------------------------------------------------
// Rendering

const LABEL_WIDTH = 14

export type ConnectPageInput = {
  state: ConnectState
  /** `providers.list`, for the pick list's marks. */
  providers?: readonly ProviderInfo[] | undefined
  /** `models.list`, for the subscription and Claude Code rows. */
  models?: ModelsReport | undefined
  width: number
  height: number
  glyphs?: Glyphs
}

const hintsFor = (state: ConnectState): string => {
  if (state.confirmLogout) return "y remove saved login · any other key cancel"
  if (state.step === "methods") return ["azure", "amazon-bedrock"].includes(state.target ?? "") ? "↑↓ method · enter select · esc back" : "↑↓ method · enter select · s login status · esc back"
  if (state.step === "oauth") return state.authStatus?.state === "pending" ? "c copy · s status · x cancel · esc close" : state.authStatus?.source === "v2" ? `${state.authStatus.state === "authorized" ? "m models" : "e login"} · r refresh · d logout · esc close` : "e retry · esc close"
  if (state.step === "pick") return state.searching ? "type to filter · ↑↓ select · enter connect · esc end search" : "↑↓ select · enter connect · / search · 1-9 jump · esc back"
  if (state.step === "busy") return "esc close"
  if (state.step === "result" && state.result?.provider === OPENCODE_FREE) return state.result.ok ? "m open model page · esc close" : "esc close"
  if (state.step === "result") return state.result?.ok ? "r refresh models · m open model page · t test again · esc close" : `${["github-copilot", "llmgateway", "nvidia", "sap-ai-core", "zenmux", "gitlab", "kilo", "cloudflare-ai-gateway"].includes(state.target ?? "") ? "r refresh models · " : ""}e edit details · t test again · esc close`
  const target = state.target ?? ""
  const fields = connectFields(target, state.viaEnv, state.values.azureAuth, state.values.awsAuth)
  const env = canUseEnv(target) && !(target === "azure" && state.values.azureAuth === "entra") && !(target === "amazon-bedrock" && state.values.awsAuth !== "bearer") ? (state.viaEnv ? " · ctrl+e type a key instead" : " · ctrl+e use env var") : ""
  const edit = fields.some((field) => !field.choice) && !state.viaEnv ? " · ctrl+u clear" : ""
  const move = fields.length > 1 ? " · tab next field" : ""
  return `enter ${state.focus >= fields.length - 1 ? "connect" : "next"}${move}${env}${edit} · esc back`
}

/** Bullets for a secret: at most `MASK_SHOWN` of them, then the length. */
export function maskSecret(value: string, width = Infinity): string {
  const length = [...value].length
  if (length === 0) return ""
  const suffix = `  ${length} chars`
  const shown = Math.max(1, Math.min(length, MASK_SHOWN, width - suffix.length - 1))
  return `${MASK.repeat(shown)}${length > shown ? "…" : ""}${suffix}`
}

function providerMark(preset: ConnectPreset, providers: readonly ProviderInfo[] | undefined): { text: string; tone: "success" | "warning" | "muted" } {
  const info = providers?.find((provider) => provider.id === preset.id)
  if (preset.id === "sap-ai-core" && !info) return { text: "service key required · off until enabled", tone: "muted" }
  if (preset.id === "foundry" && !info) return { text: "resource endpoint + key required · off until enabled", tone: "muted" }
  if (preset.id === "gitlab" && !info) return { text: "instance URL + token required · off until enabled", tone: "muted" }
  if (["cloudflare-workers-ai", "cloudflare-ai-gateway"].includes(preset.id) && !info) return { text: "account ID + token required · off until enabled", tone: "muted" }
  if (!info) return isVertexPreset(preset.id) ? { text: "GCP project + ADC · off until enabled", tone: "muted" } : preset.id === "amazon-bedrock" ? { text: "AWS chain / bearer token · off until enabled", tone: "muted" } : preset.id === "azure" ? { text: "API key / Entra · resource + deployments", tone: "muted" } : preset.id === "github-copilot" ? { text: "device login · or $GITHUB_COPILOT_TOKEN", tone: "muted" } : preset.keyless ? { text: "local server · no key", tone: "muted" } : { text: `needs a key · or $${preset.keyEnv}`, tone: "muted" }
  if (!info.enabled) return { text: "saved · off", tone: "warning" }
  if (info.error) return { text: info.error, tone: "warning" }
  if (preset.id === "github-copilot" && !info.hasKey) return { text: "device login required", tone: "muted" }
  const key = info.vertex ? info.authReady ? "Google ADC" : "ADC missing" : info.bedrock ? info.hasKey ? "bearer token" : info.authReady ? "AWS chain" : "AWS credentials missing" : info.azure?.auth === "entra" ? "Entra from env" : info.source === "env" ? "key from env" : info.keyTail ? `key ${info.keyTail}` : info.hasKey ? "key set" : "no key"
  return { text: `connected · ${key} · ${info.models.length} ${info.models.length === 1 ? "model" : "models"}`, tone: "success" }
}

const choiceName = (id: string) => (id === "chatgpt" ? "ChatGPT" : id === CUSTOM ? "Custom endpoint" : providerName(id))

function pickBody(input: ConnectPageInput, inner: number, glyphs: Glyphs): { body: Line[]; focus: number; summary: string } {
  const { state, providers, models } = input
  const rows: Line[] = []
  const nameWidth = Math.max(...CONNECT_CHOICES.map((id) => choiceName(id).length)) + 2
  const shown = state.searching ? connectMatches(state.query) : CONNECT_CHOICES.map((_, index) => index)
  if (state.searching) {
    rows.push(fit([{ text: "/ ", fg: "primary", bold: true }, { text: state.query ?? "", fg: "text" }, { text: "▏", fg: "primary" }, { text: `  ${shown.length} of ${CONNECT_CHOICES.length}`, fg: "muted" }], inner), [])
    if (shown.length === 0) rows.push([{ text: `  No provider matches "${state.query}" · backspace edits · esc ends the search`, fg: "muted" }])
  }
  shown.forEach((index) => {
    const id = CONNECT_CHOICES[index]!
    const on = index === state.selected
    const preset = presetOf(id)
    const mark = preset ? providerMark(preset, providers) : id === OPENCODE_FREE ? opencodeMark(models) : { text: id === "chatgpt" ? "browser or device login" : "Responses, Messages, Chat Completions or Gemini", tone: "muted" as const }
    rows.push(
      fit(
        [
          on ? { text: `${glyphs.user} `, fg: "primary", bold: true } : { text: "  " },
          { text: `${index + 1} `, fg: "muted" },
          { text: choiceName(id).padEnd(nameWidth), fg: on ? "primary" : "text", bold: on },
          { text: truncateEnd(mark.text, Math.max(1, inner - nameWidth - 6)), fg: mark.tone },
        ],
        inner,
      ),
    )
  })
  const focus = (state.searching ? 2 + Math.max(0, shown.indexOf(state.selected)) : state.selected) + 5
  const count = (predicate: (model: ModelsReport["models"][number]) => boolean) => (models ? models.models.filter(predicate).length : 0)
  const info = (name: string, n: number): Line =>
    fit([{ text: "  " }, { text: glyphs.ok, fg: n > 0 ? "success" : "muted" }, { text: " " }, { text: name.padEnd(Math.max(nameWidth, "ChatGPT subscription".length) + 1), fg: "text" }, { text: n > 0 ? `${n} ${n === 1 ? "model" : "models"}` : "not available here", fg: "muted" }], inner)
  rows.unshift([{ text: "Model catalogs", fg: "text", bold: true }], info("ChatGPT subscription", count((model) => !model.provider && !model.engine)), info("Claude Code", count((model) => model.engine === "claude")), [], [])
  const connected = CONNECT_PRESETS.filter((preset) => providerMark(preset, providers).tone === "success").length
  return { body: rows, focus, summary: connected ? `${connected} connected` : "" }
}

function formBody(input: ConnectPageInput, inner: number, glyphs: Glyphs): { body: Line[]; focus: number } {
  const { state } = input
  const target = state.target ?? ""
  const preset = presetOf(target)
  const fields = connectFields(target, state.viaEnv, state.values.azureAuth, state.values.awsAuth)
  const labelWidth = target === "sap-ai-core" ? 16 : LABEL_WIDTH
  const title = preset ? `Connect ${preset.name}` : "Connect a custom endpoint"
  const endpoint = target === "google-vertex-anthropic" ? "Vertex Claude Messages · Google ADC" : target === "google-vertex" ? "Vertex GenerateContent · Google ADC" : target === "amazon-bedrock" ? "AWS ConverseStream" : target === "azure" ? "Azure resource · deployment ids" : target === "cloudflare-ai-gateway" ? "AI Gateway · Unified API · account + gateway IDs" : target === "cloudflare-workers-ai" ? "Workers AI · Chat Completions · account ID" : target === "gitlab" ? "GitLab Duo · chat + workflows · your instance" : target === "sap-ai-core" ? "SAP AI Core · Orchestration · service key" : target === "opencode" ? "https://opencode.ai/zen/v1 · per-model format" : preset ? `${preset.baseUrl} · ${preset.type}` : "an endpoint that speaks one of the supported formats"
  const rows: Line[] = [[{ text: title, fg: "text", bold: true }], ...wrap(endpoint, inner).map((text): Line => [{ text, fg: "muted" }]), []]
  let focusRow = 0
  if (preset && !preset.keyless && state.viaEnv && state.values.azureAuth !== "entra" && !(target === "amazon-bedrock" && state.values.awsAuth !== "bearer")) {
    rows.push(
      ...wrap(`Uses the environment variable ${preset.keyEnv!}${target === "cloudflare-ai-gateway" ? " or CF_AIG_TOKEN" : ""}`, inner).map((text): Line => [{ text, fg: "primary" }]),
      ...wrap("The daemon reads it on every request, so it must be set where the daemon runs.", inner).map((text): Line => [{ text, fg: "muted" }]),
    )
  }
  fields.forEach((field, index) => {
    const on = index === Math.max(0, Math.min(state.focus, fields.length - 1))
    const value = state.values[field.id] ?? ""
    const shown: Line = field.choice
      ? [{ text: "‹ ", fg: "muted" }, { text: value, fg: "text", bold: on }, { text: " ›", fg: "muted" }]
      : field.secret
        ? value
          ? [{ text: maskSecret(value, Math.max(1, inner - labelWidth - 3)), fg: "text" }]
          : [{ text: "required", fg: "muted", dim: true }]
        : value
          ? [{ text: truncateEnd(value, Math.max(1, inner - LABEL_WIDTH - 4)), fg: "text" }]
          : field.placeholder
            ? [{ text: field.placeholder, fg: "muted", dim: true }]
            : []
    if (on) focusRow = rows.length
    rows.push(fit([on ? { text: `${glyphs.user} `, fg: "primary", bold: true } : { text: "  " }, { text: field.label.padEnd(labelWidth), fg: on ? "primary" : "text", bold: on }, ...shown, ...(on && !field.choice ? [{ text: "▏", fg: "primary" as const }] : [])], inner))
    if (on && state.error && isVertexPreset(target)) rows.push(...wrap(state.error, inner).slice(0, 3).map((text): Line => [{ text, fg: "error" }]))
    else if (on) rows.push(...wrap(field.hint, Math.max(1, inner - labelWidth - 2)).map((text): Line => [{ text: " ".repeat(labelWidth + 2) }, { text, fg: "muted", dim: true }]))
  })
  if (state.error && !isVertexPreset(target)) rows.push([], ...wrap(state.error, Math.max(1, inner)).slice(0, 3).map((text): Line => [{ text, fg: "error" }]))
  return { body: rows, focus: focusRow }
}

function resultBody(input: ConnectPageInput, inner: number, glyphs: Glyphs): Line[] {
  const { state } = input
  const result = state.result
  const preset = presetOf(result?.provider ?? "")
  const name = preset?.name ?? result?.provider ?? "provider"
  if (!result) return []
  if (result.provider === OPENCODE_FREE) return [
    (result.ok ? [{ text: glyphs.ok, fg: "success", bold: true }, { text: ` OpenCode added${result.note ? ` · ${result.note}` : ""}`, fg: "text", bold: true }] : [{ text: glyphs.fail, fg: "error", bold: true }, { text: " OpenCode not added", fg: "text", bold: true }]) as Line,
    ...(result.ok ? [`  Pick acp:${OPENCODE_AGENT.name} in /model; its free models are listed there after its first turn.`, ...OPENCODE_ABOUT.slice(1).map((text) => `  ${text}`)] : [`  ${result.error ?? "no reply"}`]).flatMap((text) => wrap(text, Math.max(1, inner - 2))).map((text): Line => [{ text, fg: result.ok ? "muted" : "error" }]),
  ].map((row) => clip(row, inner))
  const refreshFailed = ["opencode", "llmgateway", "nvidia", "sap-ai-core", "zenmux", "gitlab", "kilo"].includes(result.provider) && result.note === "Model refresh failed"
  const rows: Line[] = []
  if (result.ok) {
    rows.push([{ text: glyphs.ok, fg: "success", bold: true }, { text: ` ${name} connected`, fg: "text", bold: true }])
    rows.push([{ text: `  test ok · ${result.latencyMs ?? 0} ms${result.model ? ` · ${result.model}` : ""}`, fg: "muted" }])
    if (result.refreshed !== undefined) rows.push([{ text: `  ${result.refreshed} ${isVertexPreset(result.provider) ? result.refreshed === 1 ? "publisher model retained" : "publisher models retained" : result.provider === "cloudflare-ai-gateway" ? `${result.refreshed === 1 ? "gateway model" : "gateway models"} retained` : result.provider === "cloudflare-workers-ai" ? `${result.refreshed === 1 ? "Workers AI model" : "Workers AI models"} retained` : result.provider === "azure" ? result.refreshed === 1 ? "deployment configured" : "deployments configured" : result.provider === "gitlab" ? `${result.refreshed === 1 ? "model" : "models"} in catalog · tools use local permissions` : `${result.refreshed === 1 ? "model" : "models"} loaded from the provider`}`, fg: "muted" }])
  } else {
    rows.push([{ text: glyphs.fail, fg: "error", bold: true }, { text: ` ${name} saved, ${refreshFailed ? "model refresh" : "test"} failed`, fg: "text", bold: true }])
    for (const text of wrap(result.error ?? "no reply", Math.max(1, inner - 2)).slice(0, 4)) rows.push([{ text: `  ${text}`, fg: "error" }])
  }
  if (result.note && !refreshFailed) rows.push([], [{ text: result.note, fg: "warning" }])
  return rows.map((row) => clip(row, inner))
}

function authBody(state: ConnectState, width: number, glyphs: Glyphs): Line[] {
  if (state.step === "methods") {
    const methods = state.methods?.[state.target ?? ""]
    return [
      ...(methods ? methods.map((method, index): Line => [{ text: index === state.focus ? `${glyphs.user} ` : "  ", fg: "primary" }, { text: method.label, fg: method.available ? "text" : "muted", bold: index === state.focus }]) : [[{ text: "Loading methods…", fg: "muted" } as Span]]),
      ...(methods?.[state.focus]?.reason ? [[], ...wrap(methods[state.focus]!.reason!, width).map((text): Line => [{ text, fg: "warning" }])] : []),
      ...(state.error && state.error !== methods?.[state.focus]?.reason ? [[], ...wrap(state.error, width).map((text): Line => [{ text, fg: "error" }])] : []),
    ]
  }
  const status = state.authStatus
  const pending = status?.state === "pending"
  const name = providerName(status?.provider ?? (state.target === "github-copilot" ? state.target : "chatgpt"))
  return [
    [{ text: `${name === "chatgpt" ? "ChatGPT" : name} · ${status?.state ?? "checking"}`, fg: status?.state === "authorized" ? "success" : "primary", bold: true }],
    [],
    ...(state.confirmLogout ? [[{ text: `Remove v2 ${name === "chatgpt" ? "ChatGPT" : name} login?`, fg: "warning" } as Span], []] : []),
    ...(pending && state.authorization ? [
      ...wrap(state.authorization.instructions, width).map((text): Line => [{ text, fg: "text" }]),
      [],
      ...wrap(state.authorization.url, width).map((text): Line => [{ text, fg: "primary" }]),
    ] : []),
    ...(status?.source === "v2" ? [[{ text: "v2 credentials saved", fg: "muted" } as Span]] : []),
    ...(status?.error || state.error ? [[], ...wrap(status?.error ?? state.error!, width).map((text): Line => [{ text, fg: "error" }])] : []),
  ]
}

/** Renders exactly `height` lines of at most `width` cells. */
export function renderConnectPage(input: ConnectPageInput): Line[] {
  const { state, width, height } = input
  if (height <= 0) return []
  const glyphs = input.glyphs ?? defaultGlyphs()
  const inner = Math.max(1, width - 2)
  const hints = hintsFor(state)
  const room = Math.max(0, height - 4)
  const frame = (body: Line[]) => {
    const title = `Connect${state.target ? ` · ${state.target === "chatgpt" ? "ChatGPT" : providerName(state.target)}` : ""}`
    const short = state.confirmLogout ? "y logout · esc cancel" : state.step === "pick" ? state.searching ? "type · ↑↓ · enter · esc" : "↑↓ · enter · / search · esc" : state.step === "methods" ? "↑↓ select · enter · esc back" : state.step === "form" ? isVertexPreset(state.target) || state.target === "azure" && state.values.azureAuth === "entra" || state.target === "amazon-bedrock" && state.values.awsAuth === "chain" ? "enter · tab next · esc" : "enter · ctrl+e env · esc" : state.step === "oauth" ? state.authStatus?.state === "pending" ? "c copy · x cancel · esc" : state.authStatus?.source === "v2" ? `${state.authStatus.state === "authorized" ? "m models" : "e login"} · r · d · esc` : "e retry · esc" : "esc back"
    const compactHints = isVertexPreset(state.target) && state.step === "result" ? state.result?.ok ? "r models · m · t · esc" : "e edit · t test · esc" : state.target === "amazon-bedrock" && state.step === "result" ? state.result?.ok ? "r models · m pick · t test · esc" : "e edit · t test · esc" : short
    const fallback = ["cloudflare-workers-ai", "cloudflare-ai-gateway"].includes(state.target ?? "") && state.step === "result" ? state.result?.ok ? "r · m · t · esc" : "e · t · r · esc" : ["llmgateway", "nvidia", "zenmux", "gitlab", "togetherai", "kilo"].includes(state.target ?? "") && state.step === "result" ? state.result?.ok ? "r models · m select · t test · esc" : "r models · t test · e edit · esc" : compactHints
    const shownHints = title.length + hints.length + 4 <= width ? hints : fallback
    const rows: Line[] = [spread([{ text: title, fg: "primary", bold: true }], [{ text: shownHints, fg: "muted" }], inner), [{ text: "─".repeat(inner), fg: "border" }], [], ...body.slice(0, room)]
    while (rows.length < height) rows.push([])
    return rows.slice(0, height).map((line) => fit([{ text: " " }, ...line], width))
  }
  let body: Line[]
  let focus = 0
  let summary = ""
  if (state.step === "methods" || state.step === "oauth") {
    body = panelGrid({ width: inner, compact: false, maxColumns: 1, padding: true, heights: [room], rows: [[{ title: state.step === "methods" ? "Select auth method" : `${state.target === "github-copilot" ? "GitHub Copilot" : "ChatGPT"} authorization`, body: (w) => authBody(state, w, glyphs), scroll: state.step === "methods" ? Math.max(0, state.focus + 2 - (room - 4)) : 0 }]] })
    return frame(body)
  }
  if (state.step === "pick") ({ body, focus, summary } = pickBody(input, inner, glyphs))
  else if (state.step === "form") ({ body, focus } = formBody(input, inner, glyphs))
  else if (state.step === "busy") body = [[{ text: `${state.phase ?? "Working"}…`, fg: "muted" }]]
  else body = resultBody(input, inner, glyphs)
  if (width >= 110 && state.step === "form" && state.target === "cloudflare-ai-gateway") {
    body = panelGrid({ width: inner, padding: true, heights: [room], rows: [[
      { title: "Connection details", weight: 3, body: (w) => formBody(input, w, glyphs).body, scroll: Math.max(0, focus + 2 - (room - 4)) },
      { title: "AI Gateway", weight: 2, body: (w) => [
        ...wrap(`Endpoint: ${state.values.baseUrl || "built from the account and gateway IDs"}`, w).map((text): Line => [{ text, fg: "text" }]), [],
        ...wrap(`Token: ${state.viaEnv ? "$CLOUDFLARE_API_TOKEN or $CF_AIG_TOKEN" : "masked input"}`, w).map((text): Line => [{ text, fg: "text" }]), [],
        ...wrap(`Account: ${state.values.cloudflareAccountId || "required without an endpoint"}\nGateway: ${state.values.cloudflareGatewayId || "required without an endpoint"}`, w).map((text): Line => [{ text, fg: "text" }]), [],
        ...wrap(`Models: ${state.values.models || "provider/model ids required"}`, w).map((text): Line => [{ text, fg: "text" }]),
      ] },
    ]] })
    focus = 0
  } else if (width >= 110 && state.step === "form" && state.target === "cloudflare-workers-ai") {
    body = panelGrid({ width: inner, padding: true, heights: [room], rows: [[
      { title: "Connection details", weight: 3, body: (w) => formBody(input, w, glyphs).body, scroll: Math.max(0, focus + 2 - (room - 4)) },
      { title: "Workers AI", weight: 2, body: (w) => [
        ...wrap(`Endpoint: ${state.values.baseUrl || "built from the account ID"}`, w).map((text): Line => [{ text, fg: "text" }]), [],
        ...wrap(`Token: ${state.viaEnv ? "$CLOUDFLARE_API_KEY" : "masked input"}`, w).map((text): Line => [{ text, fg: "text" }]), [],
        ...wrap(`Account: ${state.values.cloudflareAccountId || "$CLOUDFLARE_ACCOUNT_ID or required without an endpoint"}`, w).map((text): Line => [{ text, fg: "text" }]), [],
        ...wrap(`Models: ${state.values.models || "configured/offline catalog"}`, w).map((text): Line => [{ text, fg: "text" }]),
      ] },
    ]] })
    focus = 0
  } else if (width >= 110 && state.step === "form" && isVertexPreset(state.target)) {
    body = panelGrid({ width: inner, padding: true, heights: [room], rows: [[
      { title: "Connection details", weight: 3, body: (w) => formBody(input, w, glyphs).body, scroll: Math.max(0, focus + 2 - (room - 4)) },
      { title: "Google ADC", weight: 2, body: (w) => [
        ...wrap(`Project: ${state.values.vertexProject || "$GOOGLE_CLOUD_PROJECT"}\nLocation: ${state.values.vertexLocation || (state.target === "google-vertex-anthropic" ? "$GOOGLE_CLOUD_LOCATION or global" : "$GOOGLE_VERTEX_LOCATION or us-central1")}`, w).map((text): Line => [{ text, fg: "text" }]), [],
        ...wrap(`Token: $${state.values.keyEnv || "GOOGLE_OAUTH_ACCESS_TOKEN"}\nOr $GOOGLE_APPLICATION_CREDENTIALS\nOr gcloud application default credentials`, w).map((text): Line => [{ text, fg: "text" }]), [],
        [{ text: `Metadata: ${state.values.vertexMetadata}`, fg: "text" }], [],
        ...wrap(`Models: ${state.values.models || "configured catalog or preset"}`, w).map((text): Line => [{ text, fg: "text" }]),
      ] },
    ]] })
    focus = 0
  } else if (width >= 110 && state.step === "form" && state.target === "amazon-bedrock") {
    body = panelGrid({ width: inner, padding: true, heights: [room], rows: [[
      { title: "Connection details", weight: 3, body: (w) => formBody(input, w, glyphs).body, scroll: Math.max(0, focus + 2 - (room - 4)) },
      { title: "AWS", weight: 2, body: (w) => [
        [{ text: state.values.awsAuth === "chain" ? "AWS credential chain" : "Bedrock bearer token", fg: "primary", bold: true }], [],
        ...wrap(`Region: ${state.values.awsRegion || "$AWS_REGION or us-east-1"}\nProfile: ${state.values.awsProfile || "$AWS_PROFILE or default"}\nEndpoint: ${state.values.baseUrl || "regional Bedrock"}`, w).map((text): Line => [{ text, fg: "text" }]), [],
        [{ text: `Metadata: ${state.values.awsMetadata}`, fg: "text" }],
        [{ text: `Credential process: ${state.values.awsProcess}`, fg: "text" }],
        ...(state.values.awsAuth === "bearer" ? [[], [{ text: state.viaEnv ? "Token: $AWS_BEARER_TOKEN_BEDROCK" : "Token: masked input", fg: "text" } as Span]] : []), [],
        ...wrap(`Models: ${state.values.models || "configured catalog or preset"}`, w).map((text): Line => [{ text, fg: "text" }]),
      ] },
    ]] })
    focus = 0
  } else if (width >= 110 && state.step === "form" && state.target === "azure") {
    body = panelGrid({ width: inner, padding: true, heights: [room], rows: [[
      { title: "Connection details", weight: 3, body: (w) => formBody(input, w, glyphs).body, scroll: Math.max(0, focus + 2 - (room - 4)) },
      { title: "Azure", weight: 2, body: (w) => [
        [{ text: state.values.azureAuth === "entra" ? "Microsoft Entra ID" : "API key", fg: "primary", bold: true }], [],
        ...wrap(state.values.azureAuth === "entra" ? `Token: $${state.values.keyEnv || "AZURE_OPENAI_AUTH_TOKEN"}\nOr client credentials:\n$AZURE_TENANT_ID\n$AZURE_CLIENT_ID\n$AZURE_CLIENT_SECRET` : state.viaEnv ? "Key: $AZURE_API_KEY" : "Key: masked input", w).map((text): Line => [{ text, fg: "text" }]), [],
        [{ text: `API: ${state.values.azureTransport === "chat" ? "Chat Completions" : "Responses"}`, fg: "text" }],
        [{ text: `Version: ${state.values.apiVersion}`, fg: "text" }],
        [{ text: `URLs: ${state.values.azureUrls}`, fg: "text" }], [],
        ...wrap(state.values.models ? `Deployments: ${modelIds(state.values.models).join(", ")}` : "Deployment ids required", w).map((text): Line => [{ text, fg: state.values.models ? "text" : "warning" }]),
      ] },
    ]] })
    focus = 0
  } else if (width >= 110 && state.target === "kilo" && state.step !== "pick") {
    const info = input.providers?.find((provider) => provider.id === "kilo")
    body = panelGrid({ width: inner, padding: true, heights: [room], rows: [[
      { title: state.step === "form" ? "Connection details" : "Connection", weight: 3, body: (w) => state.step === "form" ? formBody(input, w, glyphs).body : state.step === "result" ? resultBody(input, w, glyphs) : body },
      { title: "Kilo", weight: 2, body: (w) => [
        [{ text: info?.enabled ? "Provider: on" : "Provider: off", fg: info?.enabled ? "success" : "muted" }], [],
        ...wrap(`Proxy: ${state.values.baseUrl || info?.baseUrl || "unset"}`, w).map((text): Line => [{ text, fg: "text" }]), [],
        [{ text: state.viaEnv ? "Input: $KILO_API_KEY" : "Input: masked token", fg: "text" }],
        [{ text: `Saved token: ${info?.hasKey ? "set" : "missing"}`, fg: info?.hasKey ? "text" : "warning" }], [],
        [{ text: `${info?.models.length ?? 0} configured models`, fg: "primary", bold: true }], [],
        ...(info?.models ?? []).flatMap((model) => wrap(model.id, w).map((text): Line => [{ text, fg: "text" }])),
      ] },
    ]] })
    focus = 0
  } else if (width >= 110 && state.step === "pick") {
    const id = CONNECT_CHOICES[state.selected] ?? CONNECT_CHOICES[0]!
    const preset = presetOf(id)
    const info = input.providers?.find((provider) => provider.id === id)
    body = panelGrid({ width: inner, padding: true, heights: [room], rows: [[
      { title: "Connect a provider", weight: 3, body: (w) => pickBody(input, w, glyphs).body, scroll: Math.max(0, state.selected + 7 - (room - 4)) },
      { title: choiceName(id), weight: 2, body: (w) => [
        ...wrap(id === "chatgpt" ? `OAuth · ${state.authStatus?.state ?? "none"}` : preset ? providerMark(preset, input.providers).text : id === OPENCODE_FREE ? opencodeMark(input.models).text : "Responses, Messages, Chat Completions or Gemini", w).map((text): Line => [{ text, fg: "muted" }]),
        ...(id === OPENCODE_FREE ? OPENCODE_ABOUT.flatMap((text) => [[] as Line, ...wrap(text, w).map((line): Line => [{ text: line, fg: "text" }])]) : []),
        ...(info ? [[{ text: `${info.type} · ${info.models.length} models`, fg: "text" } as Span]] : []),
        ...(id === "chatgpt" ? (state.methods?.chatgpt ?? []).map((method): Line => [{ text: method.label, fg: method.available ? "text" : "muted" }]) : []),
      ] },
    ]] })
    focus = 0
  } else {
    body = panelGrid({ width: inner, compact: false, maxColumns: 1, padding: true, heights: [room], rows: [[{ title: state.step === "pick" ? "Connect a provider" : state.step === "form" ? "Connection details" : "Connection", body: (w) => state.step === "form" ? formBody(input, w, glyphs).body : state.step === "pick" ? pickBody(input, w, glyphs).body : state.step === "result" ? resultBody(input, w, glyphs) : body, scroll: Math.max(0, focus + 2 - (room - 4)) }]] })
    focus = 0
  }
  return frame(body)
}
