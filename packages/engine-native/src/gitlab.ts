import type { ProviderModel } from "@mendcode/protocol"
import { createAnthropicProvider } from "./anthropic-messages"
import { createChatCompletionsProvider } from "./openai-compatible"
import { createResponsesProvider } from "./openai-responses"
import { RetryableProviderError, type ModelProvider } from "./provider"
import { type Fetch, joinUrl } from "./provider-http"
import { gitlabConfig, gitlabUrl, gitlabKey as keyOf, gitlabJson as json, gitlabFailure as fail } from "./gitlab-http"
import { createGitLabWorkflowProvider, type GitLabSocketFactory } from "./gitlab-workflow"
export { gitlabConfig, gitlabUrl } from "./gitlab-http"
import type { ResolvedProvider } from "./provider-factory"
import { GITLAB_CHAT_MODELS, GITLAB_MODELS, GITLAB_WORKFLOW_REFS } from "./gitlab-models"
import { GITLAB_TOKEN_PATTERN as TOKEN, GITLAB_HEADER_PATTERN as HEADER } from "./gitlab-http"

const FLAGS = { DuoAgentPlatformNext: true, duo_agent_platform_agentic_chat: true, duo_agent_platform: true }
const DISCOVERY_QUERY = `query aiChatAvailableModels($rootNamespaceId: GroupID!) {
  aiChatAvailableModels(rootNamespaceId: $rootNamespaceId) {
    defaultModel { name ref }
    selectableModels { name ref }
    pinnedModel { name ref }
  }
}`

export async function fetchGitLabModels(input: { provider: ResolvedProvider; fetch?: Fetch; timeoutMs?: number }): Promise<ProviderModel[]> {
  const { provider } = input
  gitlabUrl(provider.baseUrl)
  const config = gitlabConfig(provider.gitlab)
  const key = keyOf(provider)
  if (!config.rootNamespaceId) return GITLAB_MODELS.map((model) => ({ ...model }))
  const transport = input.fetch ?? ((url, init) => fetch(url, init))
  let result: Record<string, unknown>
  try {
    result = await json(transport, joinUrl(provider.baseUrl, "/api/graphql"), {
      method: "POST", signal: AbortSignal.timeout(input.timeoutMs ?? 10_000),
      headers: { "content-type": "application/json", ...(config.authType === "oauth" ? { authorization: `Bearer ${key}` } : { "PRIVATE-TOKEN": key }) },
      body: JSON.stringify({ query: DISCOVERY_QUERY, variables: { rootNamespaceId: config.rootNamespaceId } }),
    }, "model discovery")
  } catch (error) {
    if (error instanceof RetryableProviderError || error instanceof Error && /^\[(AUTH|PROVIDER)\]/.test(error.message)) throw error
    throw new Error("[PROVIDER]: GitLab model discovery transport failed")
  }
  if (result.errors) throw new Error("[PROVIDER]: GitLab model discovery returned GraphQL errors")
  const data = result.data as { aiChatAvailableModels?: { defaultModel?: unknown; pinnedModel?: unknown; selectableModels?: unknown } } | undefined
  const available = data?.aiChatAvailableModels
  if (!available) throw new Error("[PROVIDER]: GitLab model discovery returned no catalog")
  const candidates = available.pinnedModel ? [available.pinnedModel] : [...(Array.isArray(available.selectableModels) ? available.selectableModels : []), available.defaultModel]
  const models = new Map<string, ProviderModel>()
  for (const raw of candidates.slice(0, 400)) {
    if (!raw || typeof raw !== "object") continue
    const { name, ref } = raw as { name?: unknown; ref?: unknown }
    if (typeof ref !== "string" || !/^[A-Za-z0-9_/.-]{1,200}$/.test(ref)) continue
    const id = GITLAB_WORKFLOW_REFS[ref] ?? `duo-workflow-${ref.replace(/[/_]/g, "-")}`
    if (id.length > 66 || models.has(id)) continue
    const label = (typeof name === "string" ? name : ref).replace(/[\x00-\x1f\x7f-\x9f]/g, "")
    models.set(id, { id, name: `Agent Platform (${label})`.slice(0, 100), context: 200_000, outputLimit: 64_000, images: true, reasoning: true, temperature: false, tool_call: true, options: { workflowRef: ref } })
  }
  return [...GITLAB_MODELS.filter((model) => !model.id.startsWith("duo-workflow-")).map((model) => ({ ...model })), ...models.values()]
}

export function createGitLabProvider(input: { provider: ResolvedProvider; fetch?: Fetch; idleTimeoutMs?: number; now?: () => number; gitlabSocket?: GitLabSocketFactory }): ModelProvider {
  const { provider } = input
  const config = gitlabConfig(provider.gitlab)
  const baseUrl = gitlabUrl(provider.baseUrl).href.replace(/\/+$/, "")
  const gateway = gitlabUrl(config.aiGatewayUrl ?? baseUrl).href.replace(/\/+$/, "")
  const transport = input.fetch ?? ((url, init) => fetch(url, init))
  const now = input.now ?? Date.now
  const workflow = createGitLabWorkflowProvider(input)
  let cached: { key: string; token: string; headers: Record<string, string>; expires: number } | undefined

  async function access(doFetch: Fetch, signal: AbortSignal, key: string) {
    if (cached?.key === key && cached.expires > now()) return cached
    cached = undefined
    const result = await json(doFetch, joinUrl(baseUrl, "/api/v4/ai/third_party_agents/direct_access"), {
      method: "POST", signal,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ feature_flags: { ...FLAGS, ...config.featureFlags } }),
    }, "token exchange")
    if (typeof result.token !== "string" || !TOKEN.test(result.token) || !result.headers || typeof result.headers !== "object" || Array.isArray(result.headers)) throw new Error("[PROVIDER]: GitLab returned invalid direct-access credentials")
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(result.headers).slice(0, 64)) {
      if (HEADER.test(name) && typeof value === "string" && value.length <= 2048 && !/[\r\n]/.test(value) && !/authorization|api[-_]?key|private-token|cookie|host|connection|location/i.test(name)) headers[name] = value
    }
    const token = { key, token: result.token, headers, expires: now() + 25 * 60_000 }
    cached = token
    return token
  }

  return {
    id: provider.id,
    model: provider.models[0]?.id ?? "duo-chat-sonnet-4-6",
    async *stream(request) {
      const id = request.model ?? provider.models[0]?.id ?? "duo-chat-sonnet-4-6"
      if (id === "duo-workflow" || id.startsWith("duo-workflow-")) { yield* workflow.stream(request); return }
      const mapping = GITLAB_CHAT_MODELS[id]
      if (!mapping) throw new Error(`[PROVIDER]: unknown GitLab agentic model ${id}`)
      const override = request.parameters?.providerModel
      if (override !== undefined && (typeof override !== "string" || !Object.values(GITLAB_CHAT_MODELS).some((entry) => entry.format === mapping.format && entry.model === override))) throw new Error("[PROVIDER]: GitLab providerModel must match the model's native format")
      const model = typeof override === "string" ? override : mapping.model
      const doFetch = request.fetch ?? transport
      const key = keyOf(provider)
      if (request.signal.aborted) return
      const secrets = new Set([key])
      let upstreamError: Error | undefined
      const guarded: Fetch = async (url, init) => {
        gitlabUrl(url)
        if (!url.startsWith(`${gateway}/ai/v1/proxy/`)) throw new Error("[PROVIDER]: GitLab request escaped its AI Gateway")
        const send = async () => {
          let token: Awaited<ReturnType<typeof access>>
          try { token = await access(doFetch, (init.signal as AbortSignal | undefined) ?? request.signal, key) }
          catch (error) { if (error instanceof RetryableProviderError) upstreamError = error; throw error }
          secrets.add(token.token)
          for (const value of Object.values(token.headers)) secrets.add(value)
          const headers = new Headers({ ...token.headers, ...provider.headers })
          new Headers(init.headers).forEach((value, name) => { if (!/authorization|api[-_]?key|private-token|cookie|host|connection/i.test(name)) headers.set(name, value) })
          for (const name of [...headers.keys()]) if (/authorization|api[-_]?key|private-token|cookie|host|connection/i.test(name)) headers.delete(name)
          headers.set("authorization", `Bearer ${token.token}`)
          headers.set("user-agent", "mendcode GitLab")
          if (mapping.format === "anthropic") headers.set("anthropic-beta", "context-1m-2025-08-07")
          return doFetch(url, { ...init, headers, redirect: "error" })
        }
        let response = await send()
        if (response.status === 401 && !request.signal.aborted) {
          await response.body?.cancel()
          cached = undefined
          response = await send()
        }
        if (!response.ok) { await response.body?.cancel(); upstreamError = fail(response, "generation"); throw upstreamError }
        return response
      }
      const common = { id: provider.id, model, fetch: guarded, ...(input.idleTimeoutMs !== undefined ? { idleTimeoutMs: input.idleTimeoutMs } : {}), takesImages: () => provider.models.find((entry) => entry.id === id)?.images !== false }
      const adapter = mapping.format === "anthropic"
        ? createAnthropicProvider({ ...common, baseUrl: `${gateway}/ai/v1/proxy/anthropic/v1`, apiKey: () => undefined })
        : mapping.format === "responses"
          ? createResponsesProvider({ ...common, baseUrl: `${gateway}/ai/v1/proxy/openai/v1`, headers: async () => ({ authorization: "Bearer delegated" }), routingHeader: false, hostedTools: [] })
          : createChatCompletionsProvider({ ...common, baseUrl: `${gateway}/ai/v1/proxy/openai/v1`, apiKey: () => undefined })
      const { providerModel: _override, workflowRef: _workflow, workflowDefinition: _definition, ...parameters } = request.parameters ?? {}
      try {
        for await (const event of adapter.stream({ ...request, model, parameters, headers: { authorization: "Bearer delegated" }, fetch: guarded })) yield event
      } catch (error) {
        if (request.signal.aborted) return
        const failure = upstreamError ?? error
        let message = failure instanceof Error ? failure.message : "[PROVIDER]: GitLab generation failed"
        for (const secret of secrets) if (secret) message = message.split(secret).join("[redacted]")
        if (failure instanceof RetryableProviderError) throw new RetryableProviderError(message, failure.retryAfterMs, failure.kind)
        throw new Error(message)
      }
    },
  }
}
