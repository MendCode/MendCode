import { GitLabConfig } from "@mendcode/protocol"
import { outboundEndpoint } from "./endpoint-policy"
import { RetryableProviderError } from "./provider"
import { retryAfter } from "./openai-responses"
import type { Fetch } from "./provider-http"
import type { ResolvedProvider } from "./provider-factory"

export const GITLAB_TOKEN_PATTERN = /^[\x21-\x7e]{1,4096}$/
export const GITLAB_HEADER_PATTERN = /^[A-Za-z0-9-]{1,100}$/
/** The instance (gitlab.com or self-managed) and the optional AI Gateway URL are both user-supplied. */
export const gitlabUrl = (value: string): URL => outboundEndpoint(value, "GitLab")

export function gitlabConfig(value: unknown) {
  const config = GitLabConfig.parse(value ?? {})
  if (config.aiGatewayUrl) gitlabUrl(config.aiGatewayUrl)
  return config
}

export function gitlabKey(provider: ResolvedProvider) {
  const key = provider.apiKey()
  if (!key || !GITLAB_TOKEN_PATTERN.test(key)) throw new Error("[AUTH]: GitLab requires a token; set GITLAB_TOKEN or use providers.set")
  return key
}

export function gitlabFailure(response: Response, action: string): Error {
  const message = `[${response.status === 401 || response.status === 403 ? "AUTH" : "PROVIDER"}]: GitLab ${action} failed (${response.status})`
  return response.status === 408 || response.status === 429 || response.status >= 500 ? new RetryableProviderError(message, retryAfter(response)) : new Error(message)
}

export async function gitlabJson(doFetch: Fetch, url: string, init: RequestInit, action: string): Promise<Record<string, unknown>> {
  gitlabUrl(url)
  const response = await doFetch(url, { ...init, redirect: "error" })
  if (!response.ok) { await response.body?.cancel(); throw gitlabFailure(response, action) }
  const reader = response.body?.getReader()
  if (!reader) throw new Error(`[PROVIDER]: GitLab ${action} returned no body`)
  const chunks: Uint8Array[] = []
  let size = 0
  const signal = init.signal
  const abort = () => { void reader.cancel().catch(() => {}) }
  signal?.addEventListener("abort", abort, { once: true })
  try {
    if (signal?.aborted) throw signal.reason
    while (true) {
      const { value, done } = await reader.read()
      if (signal?.aborted) throw signal.reason
      if (done) break
      size += value.byteLength
      if (size > 1_000_000) throw new Error(`[PROVIDER]: GitLab ${action} response is too large`)
      chunks.push(value)
    }
  } finally { signal?.removeEventListener("abort", abort); await reader.cancel().catch(() => {}); reader.releaseLock() }
  try {
    const body = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength }
    const value = JSON.parse(new TextDecoder().decode(body))
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error()
    return value
  } catch { throw new Error(`[PROVIDER]: GitLab ${action} returned invalid JSON`) }
}
