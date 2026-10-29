import type { McpConfigInput, ProviderType } from "@mendcode/protocol"
import type { Common, ParseResult } from "./automation"
import { COMPAT } from "./compat"
import { PROGRAM_NAME } from "@mendcode/program"

export type CatalogAutomation =
  | { kind: "catalog.models"; provider?: string; verbose: boolean; refresh: boolean }
  | { kind: "catalog.models.control"; operation: "status" | "show" | "plan" | "presets" | "set-default" | "use-preset"; provider?: string; model?: string; preset?: string; authMode?: "api-key" | "chatgpt-subscription-oauth"; dryRun: boolean }
  | { kind: "catalog.providers"; operation: "list" | "status" | "auth" | "adapters" | "smoke" | "logout" | "login"; provider?: string; model?: string; execute: boolean; apiKeyEnv?: string; providerType?: ProviderType; baseUrl?: string; method?: string; url?: string; azure?: import("@mendcode/protocol").AzureOptions; deployments?: string[]; bedrock?: import("@mendcode/protocol").BedrockOptions; bedrockModels?: string[]; vertex?: import("@mendcode/protocol").VertexOptions; vertexModels?: string[]; cloudflareAiGateway?: import("@mendcode/protocol").CloudflareAIGatewayConfig; cloudflareGatewayModels?: string[] }
  | { kind: "catalog.mcp"; operation: "list" | "status" | "preview" | "auth.list" | "auth" | "logout" | "debug" | "add"; server?: string; config?: McpConfigInput; scope?: "user" | "project"; replace: boolean; dryRun: boolean }
  | { kind: "catalog.auth"; operation: "status" | "login-plan" | "login" | "refresh" | "logout"; provider?: string; method?: string; execute: boolean; open: boolean }

export const CATALOG_USAGE = {
  models: `usage: ${PROGRAM_NAME} models [provider] [--verbose] [--refresh] [--json]\n  control-plane models status|show|plan|presets\n  control-plane models set-default <provider> <model> [--auth-mode api-key|chatgpt-subscription-oauth] [--enable] [--dry-run]\n  control-plane models use-preset <name> [--enable] [--dry-run]`,
  providers: `usage: ${PROGRAM_NAME} providers list|logout [--provider ID]\n  providers login [url] [--provider ID] [--method LABEL] [--api-key-env VAR] [--provider-type TYPE --base-url URL]\n  control-plane providers auth|status|adapters\n  control-plane providers smoke [--provider ID] [--model ID] [--execute]\n  control-plane auth status [provider]\n  control-plane auth login-plan|login <provider> [--method browser|headless|api-key] [--execute]\n  control-plane auth refresh|logout chatgpt --execute\n  providers login --provider azure [--azure-resource NAME | --base-url URL] --deployments IDS [--entra-token-env VAR] [--api-version VERSION] [--use-completion-urls] [--use-deployment-based-urls]\n  providers login --provider amazon-bedrock [--method aws-chain|api-key] [--aws-region REGION] [--aws-profile PROFILE] [--models IDS] [--aws-metadata] [--aws-credential-process]\n  providers login --provider google-vertex [--gcp-project ID] [--vertex-location LOCATION] [--models IDS] [--google-token-env VAR] [--vertex-quota-project ID] [--google-metadata]`,
  mcp: `usage: ${PROGRAM_NAME} mcp list|auth [name]|auth list|logout [name]|debug <name>\n  mcp add [name] [--scope user|project] [--url URL [--no-oauth] [--client-id ID] [--client-secret-env VAR] [--callback-port PORT] [--redirect-uri URI] | -- COMMAND ARG…] [--replace] [--dry-run]\n  control-plane mcp status|preview|add-local <name> <command> [args…]`,
}

const VALUES = new Set(["dir", "data-dir", "engine", "format", "compat", "provider", "model", "auth-mode", "api-key-env", "provider-type", "base-url", "scope", "url", "client-id", "client-secret-env", "method", "callback-port", "redirect-uri", "azure-resource", "api-version", "deployments", "entra-token-env", "aws-region", "aws-profile", "models", "gcp-project", "vertex-location", "google-token-env", "vertex-quota-project", "cloudflare-account", "cloudflare-gateway"])
const BOOLS = new Set(["json", "help", "verbose", "refresh", "enable", "dry-run", "execute", "replace", "no-oauth", "open", "use-completion-urls", "use-deployment-based-urls", "aws-metadata", "aws-credential-process", "google-metadata"])
const GLOBALS = ["dir", "data-dir", "engine", "format", "compat", "json", "help"]
const PROVIDER = /^[a-z][a-z0-9_-]{0,31}$/
const ENV = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const httpUrl = (value: string) => { try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password } catch { return false } }

/** Isolated parser: B17 flags cannot change the meaning of another lane's commands. */
export function parseCatalog(argv: string[]): ParseResult | undefined {
  const roots: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (token === "--") break
    if (token.startsWith("--")) { if (!token.includes("=") && VALUES.has(token.slice(2))) i++ }
    else if (["-p", "-m"].includes(token)) i++
    else roots.push(token)
    if (roots.length === 2) break
  }
  const control = roots[0] === "control-plane"
  const authControl = control && roots[1] === "auth"
  const topic = authControl ? "providers" : control ? roots[1] : roots[0] === "auth" ? "providers" : roots[0]
  if (!topic || !["models", "providers", "mcp"].includes(topic)) return undefined
  const flags = new Map<string, string | true>()
  const words: string[] = []
  let command: string[] = []
  const bad = (message: string): ParseResult => ({ ok: false, topic, message })
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] === "-p" ? "--provider" : argv[i] === "-m" ? "--method" : argv[i]!
    if (token === "--") { command = argv.slice(i + 1); break }
    if (!token.startsWith("-")) { words.push(token); continue }
    const [name, inline] = token.slice(2).split(/=(.*)/s, 2)
    if (BOOLS.has(name!)) {
      if (inline !== undefined && !["true", "false"].includes(inline)) return bad(`--${name} needs true|false`)
      if (inline !== "false") flags.set(name!, true)
    } else if (VALUES.has(name!)) {
      const value = inline ?? argv[++i]
      if (!value || value.startsWith("--")) return bad(`--${name} needs a value`)
      flags.set(name!, value)
    } else return bad(`unknown flag ${token}`)
  }
  const args = words.slice(control ? 2 : 1)
  if (flags.has("help")) return { ok: true, command: { kind: "help", topic, json: false } }
  const str = (name: string) => typeof flags.get(name) === "string" ? String(flags.get(name)) : undefined
  const common: Common = { json: flags.has("json") || str("format") === "json", ...(str("dir") || str("data-dir") ? { dir: str("data-dir") ?? str("dir")! } : {}) }
  if (str("format") && !["json", "text", "table"].includes(str("format")!)) return bad("--format needs json|text|table")
  if (str("compat")) {
    if (str("compat") !== COMPAT) return bad(`--compat must be ${COMPAT}`)
    common.compat = COMPAT
    common.json = true
  }
  const ok = (input: CatalogAutomation): ParseResult => ({ ok: true, command: { ...common, ...input } })
  const only = (allowed: string[]) => [...flags.keys()].find((name) => !GLOBALS.includes(name) && !allowed.includes(name))
  const invalid = (allowed: string[]) => { const flag = only(allowed); return flag ? bad(`--${flag} is not valid for this operation`) : undefined }
  if (authControl) {
    const operation = args[0] ?? "status"
    if (!["status", "login-plan", "login", "refresh", "logout"].includes(operation)) return bad(`unknown auth operation ${operation}`)
    const error = invalid(operation === "status" ? ["provider"] : ["provider", "method", "execute", ...(operation === "login" ? ["open"] : [])])
    if (error) return error
    const provider = str("provider") ?? args[1]
    if (args.length > 2 || command.length || provider && !PROVIDER.test(provider)) return bad("invalid auth arguments")
    if (operation !== "status" && !provider) return bad(`${operation} needs <provider>`)
    return ok({ kind: "catalog.auth", operation: operation as Extract<CatalogAutomation, { kind: "catalog.auth" }>["operation"], ...(provider ? { provider } : {}), ...(str("method") ? { method: str("method")! } : {}), execute: flags.has("execute"), open: flags.has("open") })
  }
  if (topic === "models") {
    if (!control) {
      const error = invalid(["verbose", "refresh"])
      if (error) return error
      if (args.length > 1 || command.length || args[0] && !PROVIDER.test(args[0])) return bad("models accepts one provider id")
      return ok({ kind: "catalog.models", ...(args[0] ? { provider: args[0] } : {}), verbose: flags.has("verbose"), refresh: flags.has("refresh") })
    }
    const operation = args[0] ?? "status"
    if (!["status", "show", "plan", "presets", "set-default", "use-preset"].includes(operation)) return bad(`unknown models operation ${operation}`)
    const write = ["set-default", "use-preset"].includes(operation)
    const error = invalid(write ? operation === "set-default" ? ["auth-mode", "dry-run", "enable"] : ["dry-run", "enable"] : [])
    if (error) return error
    if (command.length || args.length > (operation === "set-default" ? 3 : operation === "use-preset" ? 2 : 1)) return bad("unexpected models arguments")
    const authMode = str("auth-mode")
    if (authMode && !["api-key", "chatgpt-subscription-oauth"].includes(authMode)) return bad("unsupported --auth-mode")
    if (operation === "set-default" && (!args[1] || !PROVIDER.test(args[1]) || !args[2] || args[2].length > 100)) return bad("set-default needs <provider> <model>")
    if (operation === "use-preset" && !args[1]) return bad("use-preset needs <name>")
    return ok({ kind: "catalog.models.control", operation: operation as Extract<CatalogAutomation, { kind: "catalog.models.control" }>["operation"], ...(operation === "set-default" ? { provider: args[1]!, model: args[2]! } : operation === "use-preset" ? { preset: args[1]! } : {}), ...(authMode ? { authMode: authMode as "api-key" | "chatgpt-subscription-oauth" } : {}), dryRun: flags.has("dry-run") })
  }
  if (topic === "providers") {
    const operation = args[0] === "ls" ? "list" : args[0] ?? (control ? "status" : "list")
    if (!(control ? ["status", "auth", "adapters", "smoke"] : ["list", "login", "logout"]).includes(operation)) return bad(`unknown providers operation ${operation}`)
    const error = invalid(operation === "smoke" ? ["provider", "model", "execute"] : operation === "login" ? ["provider", "api-key-env", "provider-type", "base-url", "method", "execute", "azure-resource", "api-version", "deployments", "entra-token-env", "use-completion-urls", "use-deployment-based-urls", "aws-region", "aws-profile", "models", "aws-metadata", "aws-credential-process", "gcp-project", "vertex-location", "google-token-env", "vertex-quota-project", "google-metadata", "cloudflare-account", "cloudflare-gateway"] : ["provider"])
    if (error) return error
    if (args.length > (["logout", "login"].includes(operation) ? 2 : 1) || command.length) return bad("unexpected providers arguments")
    const url = operation === "login" && args[1] && httpUrl(args[1]) ? args[1] : undefined
    if (operation === "login" && args[1] && !url) return bad("login positional argument must be an http(s) metadata URL")
    if (flags.has("execute") && operation === "login" && !url) return bad("--execute on providers login requires a metadata URL")
    if (url && ["provider", "api-key-env", "provider-type", "base-url", "method", "azure-resource", "api-version", "deployments", "entra-token-env", "use-completion-urls", "use-deployment-based-urls", "aws-region", "aws-profile", "models", "aws-metadata", "aws-credential-process", "gcp-project", "vertex-location", "google-token-env", "vertex-quota-project", "google-metadata", "cloudflare-account", "cloudflare-gateway"].some((name) => flags.has(name))) return bad("metadata URL login cannot combine provider or method flags")
    const provider = str("provider") ?? (operation === "logout" ? args[1] : undefined)
    if (provider && !(PROVIDER.test(provider) || operation === "login" && /^[A-Za-z0-9 _-]{1,100}$/.test(provider))) return bad("invalid provider id")
    const apiKeyEnv = str("api-key-env")
    if (apiKeyEnv && !ENV.test(apiKeyEnv)) return bad("--api-key-env needs an environment variable name")
    if (apiKeyEnv && str("method") && !["api-key", "api key", "bedrock bearer token"].includes(str("method")!.toLowerCase())) return bad("--api-key-env requires the API key method")
    const providerType = str("provider-type")
    if (providerType && !["openai", "anthropic", "openai-compatible", "google", "github-copilot", "azure", "amazon-bedrock", "google-vertex", "google-vertex-anthropic", "xai", "mistral", "cohere"].includes(providerType)) return bad("invalid --provider-type")
    if (str("base-url") && !httpUrl(str("base-url")!)) return bad("--base-url needs an http(s) URL without credentials")
    const azureFlags = ["azure-resource", "api-version", "deployments", "entra-token-env", "use-completion-urls", "use-deployment-based-urls"]
    const isAzure = provider === "azure" || provider?.toLowerCase() === "azure openai" || providerType === "azure"
    if (azureFlags.some((name) => flags.has(name)) && !isAzure) return bad("Azure flags require provider azure or provider-type azure")
    if (str("azure-resource") && !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(str("azure-resource")!)) return bad("--azure-resource needs one DNS label")
    if (str("api-version") && !/^(v1|preview|\d{4}-\d{2}-\d{2}(?:-preview)?)$/.test(str("api-version")!)) return bad("invalid --api-version")
    if (str("entra-token-env") && !ENV.test(str("entra-token-env")!)) return bad("invalid --entra-token-env")
    const deployments = str("deployments") ? [...new Set(str("deployments")!.split(/[\s,]+/).filter(Boolean))] : undefined
    if (deployments && (!deployments.length || deployments.length > 50 || deployments.some((id) => id.length > 66))) return bad("--deployments needs 1–50 deployment ids, each at most 66 characters")
    const azure = isAzure && operation === "login" ? { ...(str("azure-resource") ? { resourceName: str("azure-resource")! } : {}), ...(str("api-version") ? { apiVersion: str("api-version")! } : {}), ...(str("entra-token-env") ? { tokenEnv: str("entra-token-env")!, auth: "entra" as const } : {}), ...(flags.has("use-completion-urls") ? { useCompletionUrls: true } : {}), ...(flags.has("use-deployment-based-urls") ? { useDeploymentBasedUrls: true } : {}) } : undefined
    const isBedrock = provider === "amazon-bedrock" || provider?.toLowerCase() === "amazon bedrock" || providerType === "amazon-bedrock"
    const isVertexAnthropic = provider === "google-vertex-anthropic" || provider?.toLowerCase() === "vertex anthropic" || providerType === "google-vertex-anthropic"
    const isVertex = isVertexAnthropic || provider === "google-vertex" || provider?.toLowerCase() === "google vertex ai" || providerType === "google-vertex"
    const vertexFlags = ["gcp-project", "vertex-location", "google-token-env", "vertex-quota-project", "google-metadata"]
    if (vertexFlags.some((name) => flags.has(name)) && !isVertex) return bad("Vertex flags require a Vertex provider or provider-type")
    if (isVertex && apiKeyEnv) return bad("Vertex uses --google-token-env or ADC, not --api-key-env")
    for (const name of ["gcp-project", "vertex-quota-project"]) if (str(name) && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(str(name)!)) return bad(`invalid --${name}`)
    if (str("vertex-location") && !/^(global|[a-z]+(?:-[a-z0-9]+)+)$/.test(str("vertex-location")!)) return bad("invalid --vertex-location")
    if (str("google-token-env") && !ENV.test(str("google-token-env")!)) return bad("invalid --google-token-env")
    const vertex = isVertex && operation === "login" ? { ...(str("gcp-project") ? { project: str("gcp-project")! } : {}), ...(str("vertex-location") ? { location: str("vertex-location")! } : {}), ...(str("google-token-env") ? { tokenEnv: str("google-token-env")! } : {}), ...(str("vertex-quota-project") ? { quotaProject: str("vertex-quota-project")! } : {}), ...(flags.has("google-metadata") ? { allowMetadata: true } : {}) } : undefined
    const isGateway = ["cloudflare-ai-gateway", "cloudflare ai gateway"].includes(provider?.toLowerCase() ?? "")
    if (["cloudflare-account", "cloudflare-gateway"].some((name) => flags.has(name)) && !isGateway) return bad("Cloudflare routing flags require cloudflare-ai-gateway")
    for (const name of ["cloudflare-account", "cloudflare-gateway"]) if (str(name) && !/^[A-Za-z0-9_-]{1,64}$/.test(str(name)!)) return bad(`invalid --${name}`)
    const cloudflareAiGateway = isGateway && operation === "login" ? { ...(str("cloudflare-account") ? { accountId: str("cloudflare-account")! } : {}), ...(str("cloudflare-gateway") ? { gatewayId: str("cloudflare-gateway")! } : {}) } : undefined
    if (str("models") && !isBedrock && !isVertex && !isGateway) return bad("--models requires Bedrock, Vertex or Cloudflare AI Gateway")
    const awsFlags = ["aws-region", "aws-profile", "aws-metadata", "aws-credential-process"]
    if (awsFlags.some((name) => flags.has(name)) && !isBedrock) return bad("AWS flags require provider amazon-bedrock or provider-type amazon-bedrock")
    if (str("aws-region") && !/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(str("aws-region")!)) return bad("invalid --aws-region")
    if (str("aws-profile") && !/^[A-Za-z0-9_.@-]{1,128}$/.test(str("aws-profile")!)) return bad("invalid --aws-profile")
    const bedrockModels = str("models") ? [...new Set(str("models")!.split(/[\s,]+/).filter(Boolean))] : undefined
    if (isGateway && bedrockModels?.some((id) => !/^[A-Za-z0-9_-]+\/[^\s]+$/.test(id))) return bad("Cloudflare AI Gateway models require provider/model")
    if (isVertex && bedrockModels?.some((id) => !(isVertexAnthropic ? /^[A-Za-z0-9][A-Za-z0-9._-]*(?:@[A-Za-z0-9._-]+)?$/ : /^(?:models\/)?[A-Za-z0-9._-]+$/).test(id))) return bad(`invalid Vertex ${isVertexAnthropic ? "Anthropic" : "Gemini"} model id`)
    if (bedrockModels && (!bedrockModels.length || bedrockModels.length > 50 || bedrockModels.some((id) => id.length > 66))) return bad("--models needs 1–50 ids, each at most 66 characters")
    const bedrock = isBedrock && operation === "login" ? { ...(str("aws-region") ? { region: str("aws-region")! } : {}), ...(str("aws-profile") ? { profile: str("aws-profile")! } : {}), auth: apiKeyEnv || ["api-key", "bedrock bearer token"].includes(str("method")?.toLowerCase() ?? "") ? "bearer" as const : "chain" as const, ...(flags.has("aws-metadata") ? { allowMetadata: true } : {}), ...(flags.has("aws-credential-process") ? { allowCredentialProcess: true } : {}) } : undefined
    return ok({ kind: "catalog.providers", operation: operation as Extract<CatalogAutomation, { kind: "catalog.providers" }>["operation"], ...(provider ? { provider } : {}), ...(str("model") ? { model: str("model")! } : {}), execute: flags.has("execute"), ...(apiKeyEnv ? { apiKeyEnv } : {}), ...(providerType ? { providerType: providerType as ProviderType } : {}), ...(str("base-url") ? { baseUrl: str("base-url")! } : {}), ...(str("method") ? { method: str("method")! } : {}), ...(url ? { url } : {}), ...(azure ? { azure } : {}), ...(deployments ? { deployments } : {}), ...(bedrock ? { bedrock } : {}), ...(bedrockModels && isBedrock ? { bedrockModels } : {}), ...(vertex ? { vertex } : {}), ...(bedrockModels && isVertex ? { vertexModels: bedrockModels } : {}), ...(cloudflareAiGateway ? { cloudflareAiGateway } : {}), ...(bedrockModels && isGateway ? { cloudflareGatewayModels: bedrockModels } : {}) })
  }
  const operation = args[0] === "ls" ? "list" : args[0] ?? (control ? "status" : "list")
  if (!(control ? ["status", "preview", "add-local"] : ["list", "auth", "logout", "debug", "add"]).includes(operation)) return bad(`unknown mcp operation ${operation}`)
  const adding = operation === "add" || operation === "add-local"
  const error = invalid(adding ? ["scope", "url", "no-oauth", "client-id", "client-secret-env", "replace", "dry-run", "callback-port", "redirect-uri"] : [])
  if (error) return error
  if (!adding && (command.length || args.length > (["auth", "logout", "debug"].includes(operation) ? 2 : 1))) return bad("unexpected mcp arguments")
  if (operation === "debug" && !args[1]) return bad("debug needs <name>")
  if (adding && args[1] && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(args[1])) return bad("invalid MCP name")
  if (operation === "add" && args.length > 2) return bad("put the local command after --")
  const scope = str("scope")
  if (scope && !["user", "project"].includes(scope)) return bad("--scope needs user|project")
  const local = operation === "add-local" ? [...args.slice(2), ...command] : command
  if (operation === "add-local" && (!args[1] || !local[0])) return bad("add-local needs <name> <command> [args…]")
  const url = str("url")
  if (url && (!httpUrl(url) || local.length)) return bad("give one http(s) URL or local command")
  const secretEnv = str("client-secret-env")
  if (secretEnv && !ENV.test(secretEnv)) return bad("invalid client secret environment name")
  const callbackPort = str("callback-port")
  const redirectUri = str("redirect-uri")
  if ((secretEnv || str("client-id") || callbackPort || redirectUri) && flags.has("no-oauth")) return bad("OAuth options conflict with --no-oauth")
  if (!url && (secretEnv || str("client-id") || callbackPort || redirectUri || flags.has("no-oauth"))) return bad("OAuth options require --url")
  if (callbackPort && (!/^\d+$/.test(callbackPort) || Number(callbackPort) < 1 || Number(callbackPort) > 65535)) return bad("--callback-port needs 1–65535")
  if (redirectUri) {
    try {
      const redirect = new URL(redirectUri)
      if (!["http:", "https:"].includes(redirect.protocol) || redirect.username || redirect.password || redirect.hash) return bad("--redirect-uri needs an http(s) URL without credentials or fragment")
    } catch { return bad("--redirect-uri needs an http(s) URL") }
  }
  if (secretEnv && !str("client-id")) return bad("--client-secret-env requires --client-id")
  const config: McpConfigInput | undefined = url ? { url, oauth: flags.has("no-oauth") ? false : { ...(str("client-id") ? { clientId: str("client-id")! } : {}), ...(secretEnv ? { clientSecret: `\${${secretEnv}}` } : {}), ...(callbackPort ? { callbackPort: Number(callbackPort) } : {}), ...(redirectUri ? { redirectUri } : {}) } } : local[0] ? { command: local[0], args: local.slice(1) } : undefined
  return ok({ kind: "catalog.mcp", operation: adding ? "add" : operation === "auth" && ["list", "ls"].includes(args[1] ?? "") ? "auth.list" : operation as Extract<CatalogAutomation, { kind: "catalog.mcp" }>["operation"], ...(args[1] ? { server: args[1] } : {}), ...(config ? { config } : {}), ...(scope ? { scope: scope as "user" | "project" } : operation === "add-local" ? { scope: "project" } : {}), replace: flags.has("replace"), dryRun: flags.has("dry-run") })
}
