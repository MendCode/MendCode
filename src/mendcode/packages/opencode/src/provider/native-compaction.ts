import { Hash } from "@mendcode/core/util/hash"

import type { Auth } from "@/auth"
import type { Provider } from "./provider"

export const NATIVE_CHECKPOINT_MAX_BYTES = 4 * 1024 * 1024

export type NativeProtocol = "openai-responses-api-v1" | "codex-oauth-responses-v1"

export type NativeBinding = {
  providerID: string
  apiOrigin: string
  credentialFingerprint: string
  modelID: string
  protocol: NativeProtocol
}

export type NativeCapability = {
  supported: boolean
  protocol?: NativeProtocol
  binding?: NativeBinding
  reason?: string
}

export type NativeCompactionInput = {
  provider: Provider.Info
  model: Provider.Model
  auth?: Auth.Info
  inputItems: unknown[]
  instructions?: string
  tools?: unknown[]
  abort?: AbortSignal
  timeoutMs?: number
}

export type NativeCompactionResult = {
  protocol: NativeProtocol
  outputItems: Record<string, unknown>[]
  /** Exact JSON serialization received from the provider for checkpointing. */
  outputJSON: string
  usage: Record<string, unknown> | null
  requestID: string | null
  inputBytes: number
  outputBytes: number
}

export type NativeCompactionFailureKind = "unsupported" | "cancelled" | "timeout" | "http" | "malformed" | "oversized" | "stale"

export class NativeCompactionError extends Error {
  readonly kind: NativeCompactionFailureKind
  readonly status?: number

  constructor(kind: NativeCompactionFailureKind, message: string, status?: number) {
    super(message)
    this.name = "NativeCompactionError"
    this.kind = kind
    this.status = status
  }
}

function officialOpenAIBaseURL(provider: Provider.Info, model: Provider.Model) {
  const configured = provider.options?.baseURL
  const raw = typeof configured === "string" && configured.trim() ? configured : model.api.url
  if (!raw) return undefined
  try {
    const url = new URL(raw)
    if (url.protocol !== "https:" || url.hostname !== "api.openai.com") return undefined
    const pathname = url.pathname.replace(/\/+$/, "")
    if (pathname === "") url.pathname = "/v1"
    else if (!pathname.endsWith("/v1")) return undefined
    return url
  } catch {
    return undefined
  }
}

function compactURL(base: URL) {
  const url = new URL(base.href)
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/responses/compact`
  return url
}

function credentialFingerprint(provider: Provider.Info, auth: Auth.Info | undefined, protocol: NativeProtocol) {
  // Deliberately hash only public identity/category data. Never include an API
  // key, OAuth access token, refresh token, or provider options in a binding.
  return Hash.fast(`${protocol}:${provider.id}:${auth?.type ?? provider.source}`)
}

function binding(provider: Provider.Info, model: Provider.Model, auth: Auth.Info | undefined, protocol: NativeProtocol, base: URL) {
  return {
    providerID: provider.id,
    apiOrigin: base.origin,
    credentialFingerprint: credentialFingerprint(provider, auth, protocol),
    modelID: model.api.id,
    protocol,
  } satisfies NativeBinding
}

export function nativeCapability(input: {
  provider: Provider.Info
  model: Provider.Model
  auth?: Auth.Info
}): NativeCapability {
  const base = officialOpenAIBaseURL(input.provider, input.model)
  if (!base) return { supported: false, reason: "Native compaction requires the official api.openai.com/v1 origin." }
  if (input.provider.id !== "openai" || input.model.api.npm !== "@ai-sdk/openai") {
    return { supported: false, reason: "No tested native compaction adapter exists for this provider transport." }
  }

  if (input.auth?.type === "oauth") {
    if (typeof input.provider.options?.fetch !== "function") {
      return { supported: false, reason: "Codex OAuth is configured without its authenticated provider transport." }
    }
    const protocol: NativeProtocol = "codex-oauth-responses-v1"
    return { supported: true, protocol, binding: binding(input.provider, input.model, input.auth, protocol, base) }
  }

  if (input.auth?.type === "api" || input.provider.source === "api" || input.provider.source === "env") {
    if (!input.provider.key && typeof input.provider.options?.fetch !== "function") {
      return { supported: false, reason: "The official OpenAI API route has no configured credential in the provider runtime." }
    }
    const protocol: NativeProtocol = "openai-responses-api-v1"
    return { supported: true, protocol, binding: binding(input.provider, input.model, input.auth, protocol, base) }
  }

  return { supported: false, reason: "An explicit OpenAI API or Codex OAuth credential is required." }
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function combinedSignal(signal: AbortSignal | undefined, timeoutMs: number) {
  const timeoutController = new AbortController()
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs)
  if (!signal) return { signal: timeoutController.signal, cancel: () => clearTimeout(timer) }
  if (signal.aborted) return { signal, cancel: () => clearTimeout(timer) }
  return {
    signal: AbortSignal.any([signal, timeoutController.signal]),
    cancel: () => clearTimeout(timer),
  }
}

async function responseError(response: Response) {
  let detail = ""
  try {
    const body = await response.text()
    const parsed = record(JSON.parse(body))
    const error = record(parsed?.error)
    if (typeof error?.message === "string") detail = error.message.slice(0, 240)
  } catch {
    // Do not expose arbitrary provider response bodies in diagnostics.
  }
  return detail ? `Native compaction request failed (${response.status}): ${detail}` : `Native compaction request failed (${response.status}).`
}

export async function compactNative(input: NativeCompactionInput): Promise<NativeCompactionResult> {
  const capability = nativeCapability(input)
  if (!capability.supported || !capability.protocol || !capability.binding) {
    throw new NativeCompactionError("unsupported", capability.reason ?? "Native compaction is unavailable.")
  }
  if (!Array.isArray(input.inputItems)) {
    throw new NativeCompactionError("malformed", "Native compaction input must be an item array.")
  }

  const base = officialOpenAIBaseURL(input.provider, input.model)
  if (!base) throw new NativeCompactionError("unsupported", "Native compaction origin is not supported.")
  const body = JSON.stringify({
    model: input.model.api.id,
    input: input.inputItems,
    ...(input.instructions ? { instructions: input.instructions } : {}),
    ...(input.tools ? { tools: input.tools } : {}),
    store: false,
  })
  const inputBytes = new TextEncoder().encode(body).byteLength
  const timeoutMs = input.timeoutMs ?? 60_000
  const scoped = combinedSignal(input.abort, timeoutMs)
  if (input.abort?.aborted) throw new NativeCompactionError("cancelled", "Native compaction was cancelled.")

  const headers = new Headers({
    accept: "application/json",
    "content-type": "application/json",
  })
  const fetcher = typeof input.provider.options?.fetch === "function" ? input.provider.options.fetch : fetch
  if (input.auth?.type !== "oauth" && input.provider.key) headers.set("authorization", `Bearer ${input.provider.key}`)

  let response: Response
  try {
    response = await fetcher(compactURL(base), {
      method: "POST",
      headers,
      body,
      signal: scoped.signal,
    })
  } catch (error) {
    if (input.abort?.aborted) throw new NativeCompactionError("cancelled", "Native compaction was cancelled.")
    if (scoped.signal.aborted) throw new NativeCompactionError("timeout", "Native compaction timed out.")
    throw new NativeCompactionError("http", "Native compaction transport failed.", undefined)
  } finally {
    scoped.cancel()
  }

  if (!response.ok) throw new NativeCompactionError("http", await responseError(response), response.status)
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new NativeCompactionError("malformed", "Native compaction returned invalid JSON.")
  }
  const object = record(payload)
  if (!object || !Array.isArray(object.output) || object.output.some((item) => !record(item))) {
    throw new NativeCompactionError("malformed", "Native compaction response did not contain canonical output items.")
  }
  const outputItems = object.output as Record<string, unknown>[]
  const outputJSON = JSON.stringify(outputItems)
  const outputBytes = new TextEncoder().encode(outputJSON).byteLength
  if (outputBytes > NATIVE_CHECKPOINT_MAX_BYTES) {
    throw new NativeCompactionError("oversized", "Native compaction output exceeds the 4 MiB checkpoint limit.")
  }
  const usage = record(object.usage) ?? null
  const requestID = response.headers.get("x-request-id") ?? (typeof object.id === "string" ? object.id : null)
  return {
    protocol: capability.protocol,
    outputItems,
    outputJSON,
    usage,
    requestID,
    inputBytes,
    outputBytes,
  }
}
