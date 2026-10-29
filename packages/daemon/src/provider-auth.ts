import type { ProviderAuthMethod, ProviderAuthStatus, ProviderLoginPlan } from "@mendcode/protocol"
import { createChatgptAuth, createCopilotAuth, type ChatgptAuth, type CopilotAuth } from "@mendcode/engine-native"
import type { ProviderService } from "./providers"
import { createProviderMetadataAuth, type ProviderMetadataAuth } from "./provider-metadata-auth"
import { openUrl } from "./open-url"

const openBrowser = (url: string) => openUrl(url).catch(() => { throw new Error("Could not open browser; retry without --open") })

/** Provider method dispatch stays in the daemon; the UI never handles tokens or OAuth HTTP. */
export function createProviderAuth(options: { dir: string; providers?: ProviderService | undefined; chatgpt?: ChatgptAuth; copilot?: CopilotAuth; metadata?: ProviderMetadataAuth; env?: Record<string, string | undefined>; openBrowser?(url: string): Promise<void> }) {
  const env = options.env ?? process.env
  const chatgpt = options.chatgpt ?? createChatgptAuth({ dir: options.dir, clientId: env.MENDCODE_OPENAI_OAUTH_CLIENT_ID ?? env.OPENAI_OAUTH_CLIENT_ID, issuer: env.MENDCODE_OPENAI_OAUTH_ISSUER })
  const copilot = options.copilot ?? options.providers?.copilotAuth ?? createCopilotAuth({ dir: options.dir, clientId: env.MENDCODE_GITHUB_COPILOT_CLIENT_ID, clientSecret: env.MENDCODE_GITHUB_COPILOT_CLIENT_SECRET, issuer: env.MENDCODE_GITHUB_COPILOT_ISSUER })
  const api: ProviderAuthMethod = { id: "api-key", type: "api", label: "API key", available: true }
  const inventory = () => options.providers?.inventory?.({ readOnly: true }) ?? []
  const known = (provider: string) => ["chatgpt", "openai", "github-copilot"].includes(provider) || inventory().some((entry) => entry.id === provider)
  function methods(provider?: string): Record<string, ProviderAuthMethod[]> {
    const oauth = ["browser", "headless"].map((id): ProviderAuthMethod => ({ id, type: "oauth", label: `ChatGPT Pro/Plus (${id})`, available: chatgpt.available(), ...(!chatgpt.available() ? { reason: "Set MENDCODE_OPENAI_OAUTH_CLIENT_ID" } : {}) }))
    const all: Record<string, ProviderAuthMethod[]> = Object.fromEntries(inventory().map((entry) => [entry.id, [api]]))
    for (const entry of inventory().filter((entry) => entry.type === "azure")) all[entry.id] = [api, { id: "entra", type: "api", label: "Microsoft Entra ID (environment)", available: true }]
    for (const entry of inventory().filter((entry) => entry.type === "amazon-bedrock")) all[entry.id] = [{ id: "aws-chain", type: "api", label: "AWS credential chain", available: true }, { ...api, label: "Bedrock bearer token" }]
    for (const entry of inventory().filter((entry) => entry.type === "google-vertex" || entry.type === "google-vertex-anthropic")) all[entry.id] = [{ id: "adc", type: "api", label: "Google Application Default Credentials", available: true }]
    all.openai = [...oauth, api]
    all.chatgpt = oauth
    all["github-copilot"] = [{ id: "device", type: "oauth", label: "Login with GitHub Copilot", available: copilot.available(), ...(!copilot.available() ? { reason: "Set MENDCODE_GITHUB_COPILOT_CLIENT_ID" } : {}) }, { ...api, label: "GitHub token" }]
    all["sap-ai-core"] = [{ ...api, label: "Service key (JSON)" }]
    all.gitlab = [{ ...api, label: "GitLab token (PAT or OAuth access token)" }]
    all["cloudflare-workers-ai"] = [{ ...api, label: "Cloudflare Bearer token" }]
    all["cloudflare-ai-gateway"] = [{ ...api, label: "Cloudflare Gateway token" }]
    if (provider && !known(provider)) throw new Error("Unknown provider")
    return provider ? { [provider]: all[provider]! } : all
  }
  function methodFor(provider: string, name?: string) {
    const available = methods(provider)[provider]!
    const wanted = name?.toLowerCase()
    const method = wanted ? available.find((entry) => entry.id === wanted || entry.label.toLowerCase() === wanted) : available.find((entry) => entry.id === (available.some((entry) => entry.id === "adc") ? "adc" : available.some((entry) => entry.id === "aws-chain") ? "aws-chain" : provider === "github-copilot" ? "device" : ["chatgpt", "openai"].includes(provider) ? "browser" : "api-key"))
    if (!method) throw new Error(`Unknown method; choose ${available.map((entry) => entry.id).join(", ")}`)
    return method
  }
  function status(provider?: string): ProviderAuthStatus[] {
    if (provider && !known(provider)) throw new Error("Unknown provider")
    const oauth = chatgpt.status()
    if (provider === "chatgpt") return [oauth]
    if (provider === "github-copilot") return [copilot.status()]
    const apiStatus = inventory().filter((entry) => entry.id !== "github-copilot" && (!provider || entry.id === provider)).map((entry): ProviderAuthStatus => ({ provider: entry.id, state: entry.authReady && entry.configured ? "authorized" : "none", source: entry.credentialStored ? "v2" : "none", accessTokenPresent: entry.credentialStored, refreshTokenPresent: false, accountIdPresent: false }))
    return provider === "openai" ? [...apiStatus, oauth] : provider ? apiStatus : [...apiStatus, oauth, copilot.status()]
  }
  return {
    methods, status, chatgpt, copilot, metadata: options.metadata ?? createProviderMetadataAuth({ dir: options.dir, env }),
    plan(provider: string, name?: string): ProviderLoginPlan {
      const method = methodFor(provider, name)
      return { provider, method, executesNow: false, callsProvider: false, writesSecrets: false, credentialSource: "v2", callback: method.type === "api" ? "none" : method.id === "browser" ? "loopback" : "device" }
    },
    async authorize(provider: string, name?: string, open = false) {
      const method = methodFor(provider, name)
      if (method.type !== "oauth") throw new Error("API keys use providers.set")
      if (!method.available) throw new Error(method.reason)
      if (open && method.id !== "browser") throw new Error("--open requires browser method")
      const authorization = await (provider === "github-copilot" ? copilot : chatgpt).authorize(method.id)
      if (open) {
        try { await (options.openBrowser ?? openBrowser)(authorization.url) }
        catch { chatgpt.cancel(); throw new Error("Could not open browser; retry without --open") }
      }
      return authorization
    },
    async action(provider: string, action: "cancel" | "refresh" | "logout") {
      if (!["chatgpt", "github-copilot"].includes(provider)) throw new Error("OAuth actions require provider chatgpt or github-copilot")
      const auth = provider === "github-copilot" ? copilot : chatgpt
      if (action === "cancel") auth.cancel()
      else if (action === "logout") auth.logout()
      else await auth.refresh()
      return auth.status()
    },
    stop: () => { chatgpt.stop(); copilot.stop() },
  }
}
export type ProviderAuthService = ReturnType<typeof createProviderAuth>
