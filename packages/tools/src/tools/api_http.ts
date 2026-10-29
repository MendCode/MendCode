import { errorMessage } from "../util"

/** The part of `fetch` the API tools use; tests inject a fake so no real network is touched. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export type ApiResult = { ok: true; json: unknown } | { ok: false; message: string }

const ERROR_BODY_CHARS = 200

/** Replace every secret in `text` so a provider echoing a key back never reaches logs or the model. */
export function redact({ text, secrets }: { text: string; secrets: string[] }): string {
  let result = text
  for (const secret of secrets) if (secret.length >= 4) result = result.split(secret).join("***")
  return result
}

async function readBodyCapped({ response, maxBytes }: { response: Response; maxBytes: number }): Promise<{ text: string; capped: boolean }> {
  const reader = response.body?.getReader()
  if (!reader) return { text: "", capped: false }
  const decoder = new TextDecoder()
  let text = ""
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      return { text, capped: true }
    }
    text += decoder.decode(value, { stream: true })
  }
  return { text: text + decoder.decode(), capped: false }
}

/**
 * One JSON API call with a timeout tied to the turn's signal. Never throws; every error message is redacted and names
 * the provider, the HTTP status and a short slice of the body, never a header.
 */
export async function requestJson({
  fetch,
  url,
  init,
  provider,
  secrets,
  signal,
  timeoutMs,
  maxBytes = 2 * 1024 * 1024,
}: {
  fetch: FetchLike
  url: string
  init: RequestInit
  provider: string
  secrets: string[]
  signal: AbortSignal
  timeoutMs: number
  maxBytes?: number
}): Promise<ApiResult> {
  const combined = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
  try {
    const response = await fetch(url, { ...init, signal: combined })
    const body = await readBodyCapped({ response, maxBytes })
    if (!response.ok) {
      const detail = redact({ text: body.text.replace(/\s+/g, " ").trim(), secrets }).slice(0, ERROR_BODY_CHARS)
      return { ok: false, message: `${provider} returned HTTP ${response.status}${detail ? `: ${detail}` : ""}` }
    }
    if (body.capped) return { ok: false, message: `${provider} response is larger than ${Math.round(maxBytes / 1024 / 1024)} MB` }
    try {
      return { ok: true, json: JSON.parse(body.text) as unknown }
    } catch {
      return { ok: false, message: `${provider} returned a response that is not JSON` }
    }
  } catch (error) {
    if (signal.aborted) return { ok: false, message: "cancelled" }
    if (combined.aborted) return { ok: false, message: `${provider} timed out after ${Math.round(timeoutMs / 1000)} s` }
    return { ok: false, message: `${provider} request failed: ${redact({ text: errorMessage(error), secrets })}` }
  }
}

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

export function clip({ text, max }: { text: string; max: number }): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** A non-empty trimmed environment value, or undefined. */
export function envValue({ env, name }: { env: Record<string, string | undefined>; name: string }): string | undefined {
  const value = env[name]?.trim()
  return value ? value : undefined
}
