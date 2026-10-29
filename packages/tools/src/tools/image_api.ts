import type { ImageGenerationSettings } from "@mendcode/protocol"
import { isRecord, requestJson, type FetchLike } from "./api_http"
import { detectMediaMime } from "../media"
import { arch, platform, release } from "node:os"

export type ImageApiCredentials = { baseUrl: string; headers: Record<string, string> }
export type ImageApiInput = { prompt: string; count: number; size: string; references: Array<{ mime: string; bytes: Uint8Array }>; signal: AbortSignal }
export type ImageApi = (input: ImageApiInput) => Promise<{ ok: true; images: Array<{ bytes: Uint8Array; type: "png" | "jpeg" | "gif" | "webp" }>; model: string } | { ok: false; message: string }>

export const DEFAULT_CODEX_IMAGE_MODEL = "gpt-image-2"

export function imageModelRef(value: string) {
  const colon = value.indexOf(":")
  const slash = value.indexOf("/")
  const split = colon >= 0 ? colon : slash
  return split < 1 ? undefined : { provider: value.slice(0, split), model: value.slice(split + 1) }
}

/** Subscription credentials can only go to the official backend or an explicit local adapter. */
export function codexImagesBase(base?: string) {
  const url = new URL(base ?? "https://chatgpt.com/backend-api/codex/images")
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  if (url.username || url.password || url.search || url.hash || !(local && ["http:", "https:"].includes(url.protocol) || url.origin === "https://chatgpt.com" && url.pathname.startsWith("/backend-api/codex/"))) throw new Error("Codex image endpoint must be the ChatGPT backend or loopback")
  return url.toString().replace(/\/+$/, "").replace(/\/responses$/, "/images")
}

export function createImageApi(input: {
  settings: ImageGenerationSettings
  fetch: FetchLike
  subscriptionHeaders?(): Promise<Record<string, string>>
  credentials?(provider: string): ImageApiCredentials | undefined
}): ImageApi {
  return async (request) => {
    const cfg = input.settings
    const ref = imageModelRef(cfg.model ?? `openai/${DEFAULT_CODEX_IMAGE_MODEL}`)
    if (!ref?.model) return { ok: false, message: "image_generation.model requires provider:model or provider/model" }
    const adapter = cfg.adapter && cfg.adapter !== "auto" ? cfg.adapter : ref.provider === "openrouter" ? "openrouter" : ref.provider === "openai" && !input.credentials?.("openai") ? "codex-oauth" : ref.provider === "openai" ? "openai-compatible" : undefined
    if (!adapter) return { ok: false, message: `No automatic image adapter for ${ref.provider}; configure image_generation.adapter` }
    if (adapter === "codex-oauth" && ref.provider !== "openai") return { ok: false, message: "codex-oauth requires the openai image provider" }
    if (adapter === "openrouter" && ref.provider !== "openrouter") return { ok: false, message: "openrouter adapter requires the openrouter image provider" }
    if (request.signal.aborted) return { ok: false, message: "cancelled" }
    let headers: Record<string, string>
    let base: string
    try {
      if (adapter === "codex-oauth") {
        base = codexImagesBase(cfg.base_url)
        if (!input.subscriptionHeaders) return { ok: false, message: "Codex subscription adapter is unavailable" }
        headers = { ...await input.subscriptionHeaders(), originator: "codex_cli_rs", "user-agent": `codex_cli_rs/0.0.0 (MendCode; ${platform()} ${release()}; ${arch()})`, origin: "https://chatgpt.com", "x-codex-image-turn-id": crypto.randomUUID() }
      } else {
        const credentials = input.credentials?.(ref.provider)
        if (!credentials) return { ok: false, message: `No image API credentials for ${ref.provider}` }
        headers = credentials.headers
        base = (cfg.base_url ?? credentials.baseUrl).replace(/\/+$/, "")
      }
    } catch {
      return { ok: false, message: "Codex login unavailable or expired; run codex login or refresh with codex" }
    }
    const secrets = [...Object.values(headers), ...Object.values(headers).map((value) => value.replace(/^Bearer\s+/i, ""))]
    const operation = request.references.length ? "edits" : "generations"
    const urls = request.references.map((image) => `data:${image.mime};base64,${Buffer.from(image.bytes).toString("base64")}`)
    let url: string
    let body: BodyInit
    const options = { size: request.size, ...cfg.options }
    if (adapter === "openrouter") {
      url = base.endsWith("/images") ? base : `${base.endsWith("/api/v1") ? base : `${base}/api/v1`}/images`
      body = JSON.stringify({ ...options, model: ref.model, prompt: request.prompt, n: request.count, ...(urls.length ? { input_references: urls.map((url) => ({ type: "image_url", image_url: { url } })) } : {}) })
    } else {
      const root = base.endsWith("/images") ? base : `${base}/images`
      url = `${root}/${operation}`
      if (operation === "edits" && adapter === "openai-compatible") {
        const form = new FormData()
        for (const [key, value] of Object.entries(options)) if (value !== undefined && value !== null && typeof value !== "object") form.set(key, String(value))
        form.set("model", ref.model)
        form.set("prompt", request.prompt)
        form.set("n", String(request.count))
        request.references.forEach((image, index) => form.append("image[]", new Blob([new Uint8Array(image.bytes)], { type: image.mime }), `reference-${index + 1}.${image.mime.slice(6).replace("jpeg", "jpg")}`))
        body = form
      } else body = JSON.stringify({ ...options, model: ref.model, prompt: request.prompt, n: request.count, ...(urls.length ? { images: urls.map((image_url) => ({ image_url })) } : {}) })
    }
    const call = await requestJson({ fetch: input.fetch, url, init: { method: "POST", redirect: "error", headers: { ...headers, ...(typeof body === "string" ? { "content-type": "application/json" } : {}) }, body }, provider: adapter, secrets, signal: request.signal, timeoutMs: cfg.timeout_ms ?? 180_000, maxBytes: 140 * 1024 * 1024 })
    if (!call.ok) return call
    const data = isRecord(call.json) && Array.isArray(call.json.data) ? call.json.data : []
    const images: Array<{ bytes: Uint8Array; type: "png" | "jpeg" | "gif" | "webp" }> = []
    for (const item of data.slice(0, request.count)) {
      if (!isRecord(item)) return { ok: false, message: "Image API returned invalid image data" }
      let bytes: Uint8Array
      if (typeof item.b64_json === "string") {
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(item.b64_json) || item.b64_json.length % 4) return { ok: false, message: "Image API returned invalid inline image data" }
        bytes = new Uint8Array(Buffer.from(item.b64_json, "base64"))
      } else {
        try {
          const imageUrl = new URL(String(item.url))
          if (imageUrl.username || imageUrl.password || !(imageUrl.protocol === "https:" || imageUrl.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(imageUrl.hostname))) return { ok: false, message: "Image API returned an unsafe image URL" }
          const signal = AbortSignal.any([request.signal, AbortSignal.timeout(cfg.timeout_ms ?? 180_000)])
          const response = await input.fetch(imageUrl.toString(), { signal, redirect: "error" })
          if (!response.ok || !response.body) return { ok: false, message: `Image download failed with HTTP ${response.status}` }
          if (Number(response.headers.get("content-length")) > 50 * 1024 * 1024) return { ok: false, message: "Image download exceeds 50 MB" }
          const reader = response.body.getReader()
          const chunks: Uint8Array[] = []
          let total = 0
          try {
            for (;;) {
              const next = await reader.read()
              if (next.done) break
              total += next.value.length
              if (total > 50 * 1024 * 1024) { await reader.cancel(); return { ok: false, message: "Image download exceeds 50 MB" } }
              chunks.push(next.value)
            }
          } finally { reader.releaseLock() }
          bytes = new Uint8Array(Buffer.concat(chunks, total))
        } catch { return { ok: false, message: request.signal.aborted ? "cancelled" : "Image download failed" } }
      }
      if (bytes.length > 50 * 1024 * 1024) return { ok: false, message: "Image API output exceeds 50 MB" }
      const mime = detectMediaMime(bytes)
      const type = mime === "image/png" ? "png" : mime === "image/jpeg" ? "jpeg" : mime === "image/gif" ? "gif" : mime === "image/webp" ? "webp" : undefined
      if (!type || item.media_type && item.media_type !== mime) return { ok: false, message: "Image API output is not a supported raster image" }
      images.push({ bytes, type })
    }
    return images.length ? { ok: true, images, model: ref.model } : { ok: false, message: "Image API returned no image" }
  }
}
