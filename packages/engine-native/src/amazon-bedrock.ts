import type { BedrockOptions } from "@mendcode/protocol"
import { awsEndpoint, awsHost, signAws } from "./aws-signature"
import { awsEvents } from "./aws-eventstream"
import { guardedStream, type Fetch } from "./provider-http"
import { retryAfter } from "./openai-responses"
import { RetryableProviderError, type ModelMessage, type ModelProvider, type ModelRequest } from "./provider"
import type { ResolvedProvider } from "./provider-factory"
import { argsObject, pairToolCalls, withoutUnsupportedImages } from "./history"

/** v1's region routing, expressed independently of its SDK or UI. Explicit inference profiles/ARNs stay exact. */
export function bedrockModelId(model: string, region: string): string {
  if (/^(global|us|eu|jp|apac|au)\./.test(model) || model.startsWith("arn:")) return model
  const has = (names: string[]) => names.some((name) => model.includes(name))
  if (region.startsWith("us-") && !region.startsWith("us-gov-") && has(["nova-micro", "nova-lite", "nova-pro", "nova-premier", "nova-2", "claude", "deepseek"])) return `us.${model}`
  if (["eu-west-1", "eu-west-2", "eu-west-3", "eu-north-1", "eu-central-1", "eu-south-1", "eu-south-2"].includes(region) && has(["claude", "nova-lite", "nova-micro", "llama3", "pixtral"])) return `eu.${model}`
  if (["ap-southeast-2", "ap-southeast-4"].includes(region) && has(["anthropic.claude-sonnet-4-5", "anthropic.claude-haiku"])) return `au.${model}`
  if (region.startsWith("ap-") && has(["claude", "nova-lite", "nova-micro", "nova-pro"])) return `${region === "ap-northeast-1" ? "jp" : "apac"}.${model}`
  return model
}

export const bedrockRegion = (options: BedrockOptions | undefined, env: Record<string, string | undefined>) => options?.region ?? env.AWS_REGION ?? "us-east-1"
export const bedrockBaseUrl = (region: string) => awsHost("bedrock-runtime", region)

function messages(request: ModelRequest, provider: string, model: string): Array<{ role: "user" | "assistant"; content: Record<string, unknown>[] }> {
  const out: Array<{ role: "user" | "assistant"; content: Record<string, unknown>[] }> = []
  for (const entry of pairToolCalls(request.messages)) {
    const role = entry.role === "tool" ? "user" : entry.role
    const content: Record<string, unknown>[] = []
    if (entry.role === "tool") content.push({ toolResult: { toolUseId: entry.callId, content: [{ text: entry.output || "(empty result)" }], status: entry.isError ? "error" : "success" } })
    else {
      if (entry.role === "assistant" && entry.reasoning?.provider === provider && entry.reasoning.model === model) content.push(...entry.reasoning.blocks as Record<string, unknown>[])
      if (entry.content) content.push({ text: entry.content })
      if (entry.role === "user") {
        for (const image of entry.images ?? []) {
          const format = image.mime.split("/")[1] === "jpg" ? "jpeg" : image.mime.split("/")[1]
          if (["png", "jpeg", "gif", "webp"].includes(format ?? "")) content.push({ image: { format, source: { bytes: image.base64 } } })
        }
        for (const [i, document] of (entry.documents ?? []).entries()) content.push({ document: { format: "pdf", name: `Document ${i + 1}`, source: { bytes: document.base64 } } })
      } else for (const call of entry.toolCalls) content.push({ toolUse: { toolUseId: call.callId, name: call.name, input: argsObject(call.args) } })
    }
    if (!content.length) continue
    if (out.at(-1)?.role === role) out.at(-1)!.content.push(...content)
    else out.push({ role, content })
  }
  return out
}

export function bedrockBody(request: ModelRequest, provider: string, model: string): Record<string, unknown> {
  const parameters = { ...request.parameters }
  const maxTokens = request.maxOutputTokens ?? parameters.maxTokens ?? parameters.max_tokens ?? parameters.max_output_tokens ?? 4096
  const inferenceConfig: Record<string, unknown> = { maxTokens }
  if (parameters.temperature !== undefined) inferenceConfig.temperature = parameters.temperature
  if (parameters.topP !== undefined || parameters.top_p !== undefined) inferenceConfig.topP = parameters.topP ?? parameters.top_p
  if (parameters.stopSequences !== undefined || parameters.stop !== undefined) inferenceConfig.stopSequences = parameters.stopSequences ?? (Array.isArray(parameters.stop) ? parameters.stop : [parameters.stop])
  const extra = typeof parameters.additionalModelRequestFields === "object" && parameters.additionalModelRequestFields && !Array.isArray(parameters.additionalModelRequestFields) ? { ...parameters.additionalModelRequestFields } : {}
  if (parameters.thinking !== undefined) extra.thinking = parameters.thinking
  if (request.effort && model.includes("anthropic.claude") && !model.includes("claude-3-5") && !model.includes("claude-3-haiku")) {
    const continuing = request.messages.at(-1)?.role === "tool"
    const lastUser = request.messages.findLastIndex((entry) => entry.role === "user")
    const assistants = request.messages.slice(lastUser + 1).filter((entry: ModelMessage) => entry.role === "assistant")
    const signed = assistants.length > 0 && assistants.every((entry) => entry.role === "assistant" && entry.reasoning?.provider === provider && entry.reasoning.model === model)
    if (request.effort !== "minimal" && request.effort !== "none" && (!continuing || signed)) {
      const budget = request.effort === "low" ? 2048 : request.effort === "medium" ? 8192 : 24576
      if (!request.maxOutputTokens || request.maxOutputTokens > budget) { extra.thinking ??= { type: "enabled", budget_tokens: budget }; inferenceConfig.maxTokens = Math.max(Number(maxTokens), budget + 1024); delete inferenceConfig.temperature; delete inferenceConfig.topP }
    }
  }
  return {
    ...(request.system ? { system: [{ text: request.system }] } : {}),
    messages: messages(request, provider, model),
    inferenceConfig,
    ...(Object.keys(extra).length ? { additionalModelRequestFields: extra } : {}),
    ...(request.tools.length ? { toolConfig: { tools: request.tools.map((tool) => ({ toolSpec: { name: tool.name, description: tool.description, inputSchema: { json: tool.parameters } } })) } } : {}),
  }
}

async function headers(provider: ResolvedProvider, url: string, body: string, region: string, signal: AbortSignal, requestHeaders?: Record<string, string>): Promise<Record<string, string>> {
  const extra = Object.fromEntries(Object.entries({ ...provider.headers, ...requestHeaders }).filter(([name]) => !["authorization", "host", "x-amz-date", "x-amz-content-sha256", "x-amz-security-token"].includes(name.toLowerCase())))
  const base = { ...extra, "content-type": "application/json", accept: "application/vnd.amazon.eventstream" }
  // A bearer always wins over environment/profile/role credentials, matching v1.
  const key = provider.apiKey()
  if (key) return { ...base, authorization: `Bearer ${key}` }
  if (provider.bedrock?.auth === "bearer") throw new Error("[AUTH]: Bedrock bearer token is missing")
  if (!provider.awsCredentials) throw new Error("[AUTH]: AWS credential chain is unavailable")
  return signAws({ url, method: "POST", body, region, service: "bedrock", credentials: await provider.awsCredentials(signal), headers: base })
}

export function createBedrockProvider(input: { provider: ResolvedProvider; fetch?: Fetch; idleTimeoutMs?: number }): ModelProvider {
  const { provider } = input
  return {
    id: provider.id, model: provider.models[0]?.id ?? "",
    async *stream(request) {
      const model = request.model ?? provider.models[0]?.id ?? ""
      const metadata = provider.models.find((entry) => entry.id === model)
      const region = provider.bedrock?.region ?? "us-east-1"
      const target = typeof request.parameters?.bedrockModelId === "string" ? request.parameters.bedrockModelId : model
      const url = `${awsEndpoint(provider.baseUrl)}/model/${encodeURIComponent(bedrockModelId(target, region))}/converse-stream`
      const body = JSON.stringify(bedrockBody({ ...request, messages: withoutUnsupportedImages(request.messages, metadata?.images !== false && (!metadata?.modalities || metadata.modalities.input.includes("image"))) }, provider.id, model))
      const doFetch: Fetch = request.fetch ?? input.fetch ?? ((url, init) => fetch(url, init))
      yield* guardedStream({ providerId: provider.id, signal: request.signal, idleMs: input.idleTimeoutMs ?? (provider.chunkTimeout === false ? 0 : provider.chunkTimeout ?? 60_000), async *run({ watchdog }) {
        if (watchdog.signal.aborted) return
        let auth: Record<string, string>
        try { auth = await headers(provider, url, body, region, watchdog.signal, request.headers) } catch (error) { if (watchdog.signal.aborted) return; throw error }
        let response: Response
        try { response = await doFetch(url, { method: "POST", redirect: "error", headers: auth, body, signal: watchdog.signal }) }
        catch { if (watchdog.signal.aborted) return; throw new RetryableProviderError("[PROVIDER]: Bedrock connection failed", undefined, "network") }
        if (!response.ok || !response.body) {
          await response.body?.cancel().catch(() => {})
          if (response.status === 401 || response.status === 403) throw new Error(`[AUTH]: Bedrock HTTP ${response.status}; check AWS credentials, model access and region`)
          const message = `[PROVIDER]: Bedrock HTTP ${response.status}`
          if ([408, 429].includes(response.status) || response.status >= 500) throw new RetryableProviderError(message, retryAfter(response))
          throw new Error(message)
        }
        const tools = new Map<number, { callId: string; name: string; args: string }>()
        const reasoning = new Map<number, { text: string; signature: string; redacted: Buffer[] }>()
        let stopped: string | undefined
        let metadata = false
        try {
          for await (const event of awsEvents(response.body, watchdog.signal, watchdog.touch)) {
            const { type, payload } = event
            if (event.exception || type.endsWith("Exception")) {
              if (["internalServerException", "modelStreamErrorException", "serviceUnavailableException", "throttlingException"].includes(type)) throw new RetryableProviderError(`[PROVIDER]: Bedrock ${type}`)
              throw new Error(`[PROVIDER]: Bedrock ${type.replace(/[^A-Za-z]/g, "").slice(0, 80)}`)
            }
            const index = payload.contentBlockIndex
            if (type === "contentBlockStart" && payload.start?.toolUse) tools.set(index, { callId: payload.start.toolUse.toolUseId, name: payload.start.toolUse.name, args: "" })
            if (type === "contentBlockDelta") {
              const delta = payload.delta ?? {}
              if (typeof delta.text === "string") yield { type: "text", delta: delta.text }
              if (typeof delta.toolUse?.input === "string") {
                const tool = tools.get(index)
                if (!tool || tool.args.length + delta.toolUse.input.length > 1024 * 1024) throw new Error("[PROVIDER]: invalid Bedrock tool stream")
                tool.args += delta.toolUse.input
              }
              if (delta.reasoningContent) {
                const block = reasoning.get(index) ?? { text: "", signature: "", redacted: [] }
                if (typeof delta.reasoningContent.text === "string") { block.text += delta.reasoningContent.text; yield { type: "reasoning", delta: delta.reasoningContent.text } }
                if (typeof delta.reasoningContent.signature === "string") block.signature += delta.reasoningContent.signature
                if (typeof delta.reasoningContent.redactedContent === "string") block.redacted.push(Buffer.from(delta.reasoningContent.redactedContent, "base64"))
                reasoning.set(index, block)
              }
            }
            if (type === "contentBlockStop") {
              const tool = tools.get(index)
              if (tool) {
                let args: unknown
                try { args = JSON.parse(tool.args || "{}") } catch { throw new Error("[PROVIDER]: Bedrock tool arguments are invalid JSON") }
                yield { type: "tool_call", call: { callId: tool.callId, name: tool.name, args } }
                tools.delete(index)
              }
            }
            if (type === "messageStop") stopped = payload.stopReason
            if (type === "metadata") {
              const usage = payload.usage ?? {}
              const n = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0
              yield { type: "usage", usage: { input: n(usage.inputTokens), output: n(usage.outputTokens), reasoning: 0, cacheRead: n(usage.cacheReadInputTokens), cacheWrite: n(usage.cacheWriteInputTokens) } }
              metadata = true
            }
          }
        } catch (error) { if (watchdog.signal.aborted) return; throw error }
        if (watchdog.signal.aborted) return
        if (!stopped || !metadata || tools.size) throw new RetryableProviderError("[PROVIDER]: Bedrock stream ended before completion", undefined, "network")
        const blocks = [...reasoning.values()].flatMap<Record<string, unknown>>((block) => block.redacted.length ? [{ reasoningContent: { redactedContent: Buffer.concat(block.redacted).toString("base64") } }] : block.signature ? [{ reasoningContent: { reasoningText: { text: block.text, signature: block.signature } } }] : [])
        if (blocks.length) yield { type: "reasoning_state", state: { provider: provider.id, model, blocks } }
        yield { type: "finish", reason: stopped === "tool_use" ? "tool_calls" : stopped === "max_tokens" ? "length" : "stop" }
      } })
    },
  }
}

/** Authenticated control-plane list; only streaming text models enter the catalog. */
export async function fetchBedrockModels(input: { provider: ResolvedProvider; fetch?: Fetch; timeoutMs?: number }): Promise<import("@mendcode/protocol").ProviderModel[]> {
  const provider = input.provider
  const region = provider.bedrock?.region ?? "us-east-1"
  const runtime = new URL(awsEndpoint(provider.baseUrl))
  const standard = new URL(bedrockBaseUrl(region))
  const url = `${runtime.host === standard.host ? awsHost("bedrock", region) : runtime.origin + runtime.pathname.replace(/\/$/, "")}/foundation-models?byOutputModality=TEXT`
  const signal = AbortSignal.timeout(input.timeoutMs ?? 10_000)
  const bearer = provider.apiKey()
  if (!bearer && provider.bedrock?.auth === "bearer") throw new Error("[AUTH]: Bedrock bearer token is missing")
  if (!bearer && !provider.awsCredentials) throw new Error("[AUTH]: AWS credential chain is unavailable")
  const auth = bearer ? { authorization: `Bearer ${bearer}` } : signAws({ url, method: "GET", body: "", region, service: "bedrock", credentials: await provider.awsCredentials!(signal) })
  let response: Response
  try { response = await (input.fetch ?? ((url, init) => fetch(url, init)))(url, { method: "GET", redirect: "error", headers: auth, signal }) } catch { throw new Error("[PROVIDER]: Bedrock model list unavailable") }
  if (!response.ok) throw new Error(`[PROVIDER]: Bedrock model list HTTP ${response.status}`)
  const raw = await response.json() as { modelSummaries?: Array<{ modelId?: string; modelName?: string; responseStreamingSupported?: boolean; inputModalities?: string[]; outputModalities?: string[] }> }
  if (!Array.isArray(raw.modelSummaries)) throw new Error("[PROVIDER]: Bedrock model list is invalid")
  return raw.modelSummaries.filter((model) => model.modelId && model.modelId.length <= 66 && model.responseStreamingSupported && model.outputModalities?.includes("TEXT")).map((model) => ({ id: model.modelId!, ...(model.modelName ? { name: model.modelName.slice(0, 100) } : {}), images: model.inputModalities?.includes("IMAGE") ?? false })).sort((a, b) => a.id.localeCompare(b.id)).slice(0, 400)
}
