import path from "path"
import { Effect, Schema } from "effect"
import { generateText } from "ai"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { AppFileSystem } from "@mendcode/core/filesystem"
import { Global } from "@mendcode/core/global"
import { Provider } from "@/provider/provider"
import { isImageAttachment, sniffAttachmentMime } from "@/util/media"
import {
  extractAccountId,
  prepareCodexChatGPTOAuthRequest,
  refreshCodexAccessToken,
  type TokenResponse,
} from "@/plugin/codex"
import type { MessageV2 } from "@/session/message-v2"
import { assertExternalDirectoryEffect } from "./external-directory"
import * as Tool from "./tool"

const MAX_EDIT_IMAGES = 5
const MAX_INPUT_IMAGE_BYTES = 50 * 1024 * 1024
const MAX_OUTPUT_IMAGE_BYTES = 50 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 10 * 60_000
const MAX_CAPTION_CHARS = 10_000
const DEFAULT_CODEX_IMAGES_ENDPOINT = "https://chatgpt.com/backend-api/codex/images"
const DEFAULT_OPENROUTER_IMAGES_ENDPOINT = "https://openrouter.ai/api/v1/images"
export const DEFAULT_CODEX_IMAGE_MODEL = "openai/gpt-image-2"
const GENERATED_IMAGES_DIR = "generated_images"

const DESCRIPTION = `Generate a new raster image or edit existing images using the independently configured image generation provider and model.

Use this tool when the user explicitly asks to create or edit a bitmap image such as a photo, illustration, texture, sprite, mockup, concept, meme, or infographic. If image generation is only your optional suggestion, or a missing visual decision would materially change the result, ask one concise question before calling it. Do not reconfirm an explicit, sufficiently detailed image request.

MendCode sends the request only to the configured image provider/model. Put required orientation, aspect ratio, target resolution, exact text, and visual constraints in the prompt; provider-specific options come from config rather than invented tool parameters.

For a new image, omit both reference fields; num_last_images_to_include: 0 is also accepted as an explicit "no reference images" sentinel. For an edit, provide either absolute local paths in referenced_image_paths or num_last_images_to_include from 1 to 5 for recent conversation images, never both. Include only the images required for the edit, up to five.

Generated images are saved in MendCode's persistent generated_images directory, not an OS temp directory. In the full TUI, show the saved path and external open actions without rendering the image inline. Preview-only images may remain there. If the image will be consumed by the current project, copy the selected artifact into the workspace using a stable descriptive filename and do not overwrite an existing asset unless the user explicitly requested replacement.`

export const ImageGenParameters = Schema.Struct({
  prompt: Schema.String.annotate({
    description:
      "A complete production-oriented image prompt, including intended use, composition, orientation or target resolution when important, exact text, constraints, and avoid items.",
  }),
  referenced_image_paths: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Up to five absolute local image paths to edit. Do not combine with num_last_images_to_include.",
  }),
  num_last_images_to_include: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(MAX_EDIT_IMAGES)),
  ).annotate({
    description:
      "Set 0 or omit this field when generating a new image. Set an integer from 1 to 5 only when editing recent conversation images that have no stable local path.",
  }),
})

export type ImageGenArgs = Schema.Schema.Type<typeof ImageGenParameters>
type ImageOperation = "generations" | "edits"
type ImageResponse = {
  data?: Array<{ b64_json?: string; url?: string; media_type?: string }>
  size?: string
  quality?: string
  background?: string
  usage?: { cost?: number; [key: string]: unknown }
}

type ImageAdapter = "codex-oauth" | "openrouter" | "openai-compatible"
type OAuthCredentials = {
  access: string
  refresh: string
  expires: number
  accountId?: string
}

function safePathSegment(value: string) {
  const sanitized = value.replace(/[^A-Za-z0-9_-]/g, "_")
  return sanitized || "generated_image"
}

export function generatedImageRoot() {
  const override = process.env.MENDCODE_OPENAI_CODEX_GENERATED_IMAGES_DIR?.trim()
  return override || path.join(Global.Path.data, GENERATED_IMAGES_DIR)
}

export function generatedImageArtifactPath(root: string, sessionID: string, callID: string, extension = "png") {
  return path.join(root, safePathSegment(sessionID), `${safePathSegment(callID)}.${safePathSegment(extension)}`)
}

export function resolveImageGenerationModel(
  settings: Config.Info["image_generation"],
  openAIAuth: Auth.Info | undefined,
) {
  if (settings?.enabled === false) return undefined
  if (settings?.model) return settings.model
  if (openAIAuth?.type === "oauth") return DEFAULT_CODEX_IMAGE_MODEL
  return undefined
}

export function usesCodexImageAdapter(
  settings: Config.Info["image_generation"],
  openAIAuth: Auth.Info | undefined,
  model: string | undefined,
) {
  const adapter = settings?.adapter ?? "auto"
  return (
    model === DEFAULT_CODEX_IMAGE_MODEL &&
    openAIAuth?.type === "oauth" &&
    (adapter === "auto" || adapter === "codex-oauth")
  )
}

export function codexImageEndpoint(operation: ImageOperation) {
  const explicit = process.env.MENDCODE_OPENAI_CODEX_IMAGES_ENDPOINT?.trim().replace(/\/+$/, "")
  if (explicit) return `${explicit}/${operation}`

  const responses = (
    process.env.MENDCODE_OPENAI_CODEX_RESPONSES_ENDPOINT || process.env.OPENAI_CODEX_RESPONSES_ENDPOINT
  )
    ?.trim()
    .replace(/\/+$/, "")
  if (responses?.endsWith("/responses")) return `${responses.slice(0, -"/responses".length)}/images/${operation}`

  return `${DEFAULT_CODEX_IMAGES_ENDPOINT}/${operation}`
}

export function openRouterImageEndpoint(baseURL?: string) {
  const explicit = baseURL?.trim().replace(/\/+$/, "")
  if (!explicit) return DEFAULT_OPENROUTER_IMAGES_ENDPOINT
  if (explicit.endsWith("/api/v1/images")) return explicit
  if (explicit.endsWith("/api/v1")) return `${explicit}/images`
  return `${explicit}/api/v1/images`
}

function openAIImageEndpoint(baseURL: string | undefined, operation: ImageOperation) {
  const base = (baseURL?.trim() || "https://api.openai.com/v1").replace(/\/+$/, "")
  const root = base.endsWith("/images") ? base : `${base}/images`
  return `${root}/${operation}`
}

function imageUrlsFromMessages(messages: MessageV2.WithParts[], count: number) {
  const urls: string[] = []
  const seen = new Set<string>()

  const add = (part: { mime: string; url: string }) => {
    if (!isImageAttachment(part.mime)) return
    if (!part.url.startsWith("data:image/") && !/^https:\/\//i.test(part.url)) return
    if (seen.has(part.url)) return
    seen.add(part.url)
    urls.push(part.url)
  }

  outer: for (const message of messages.toReversed()) {
    for (const part of message.parts.toReversed()) {
      if (part.type === "file") add(part)
      if (part.type === "tool" && part.state.status === "completed") {
        for (const attachment of (part.state.attachments ?? []).toReversed()) add(attachment)
      }
      if (urls.length === count) break outer
    }
  }

  return urls.toReversed()
}

function validateEditSelection(params: ImageGenArgs) {
  const paths = params.referenced_image_paths ?? []
  const recentCount = params.num_last_images_to_include === 0 ? undefined : params.num_last_images_to_include
  if (paths.length > 0 && recentCount !== undefined) {
    throw new Error("Provide only one of referenced_image_paths or num_last_images_to_include.")
  }
  if (paths.length > MAX_EDIT_IMAGES) {
    throw new Error(`referenced_image_paths must contain at most ${MAX_EDIT_IMAGES} paths.`)
  }
  if (
    recentCount !== undefined &&
    (!Number.isInteger(recentCount) || recentCount < 1 || recentCount > MAX_EDIT_IMAGES)
  ) {
    throw new Error(`num_last_images_to_include must be an integer between 1 and ${MAX_EDIT_IMAGES}.`)
  }
  return { paths, recentCount }
}

function decodeGeneratedImage(encoded: string, declaredMediaType?: string) {
  const compact = encoded.trim()
  if (!compact || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 !== 0) {
    throw new Error("Image generation returned invalid base64 image data.")
  }
  const bytes = Buffer.from(compact, "base64")
  if (bytes.byteLength > MAX_OUTPUT_IMAGE_BYTES) throw new Error("Image generation returned an image larger than 50 MB.")
  const sniffed = sniffAttachmentMime(bytes, "")
  if (!isImageAttachment(sniffed)) throw new Error("Image generation returned data that is not a supported image.")
  if (declaredMediaType?.startsWith("image/") && declaredMediaType !== sniffed) {
    throw new Error(`Image generation returned ${sniffed} bytes while declaring ${declaredMediaType}.`)
  }
  return { bytes: new Uint8Array(bytes), mediaType: sniffed }
}

function generatedPngMetadata(bytes: Uint8Array) {
  if (bytes.length < 24 || bytes[12] !== 73 || bytes[13] !== 72 || bytes[14] !== 68 || bytes[15] !== 82)
    return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset + 16, 8)
  const width = view.getUint32(0)
  const height = view.getUint32(4)
  if (width < 1 || height < 1) return undefined
  return { width, height, size: `${width}x${height}` }
}

function responseError(adapter: ImageAdapter, status: number, text: string) {
  const detail = text
    .trim()
    .slice(0, 1000)
    .replace(/https?:\/\/\S+/gi, "[redacted-url]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]+|Bearer\s+\S+)/gi, "[redacted-secret]")
  return new Error(`${adapter} image request failed with HTTP ${status}${detail ? `: ${detail}` : "."}`)
}

function extensionForMediaType(mediaType: string) {
  if (mediaType === "image/jpeg") return "jpg"
  if (mediaType === "image/webp") return "webp"
  if (mediaType === "image/gif") return "gif"
  if (mediaType === "image/svg+xml") return "svg"
  return "png"
}

function isSafeGeneratedImageURL(value: string) {
  try {
    const url = new URL(value)
    if (url.protocol === "https:") return true
    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1")
    )
  } catch {
    return false
  }
}

async function readBoundedImageBody(response: Response) {
  if (!response.body) throw new Error("Image download response contained no body.")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > MAX_OUTPUT_IMAGE_BYTES) {
        await reader.cancel()
        throw new Error("Image generation returned an image larger than 50 MB.")
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  return new Uint8Array(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total))
}

function refreshedCredentials(current: Auth.Oauth, tokens: TokenResponse): OAuthCredentials {
  return {
    access: tokens.access_token,
    refresh: tokens.refresh_token || current.refresh,
    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    accountId: extractAccountId(tokens) || current.accountId,
  }
}

export const ImageGenTool = Tool.define(
  "image_gen",
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const config = yield* Config.Service
    const fs = yield* AppFileSystem.Service
    const provider = yield* Provider.Service

    const oauthCredentials = Effect.fn("ImageGen.oauthCredentials")(function* () {
      const current = yield* auth.get("openai")
      if (current?.type !== "oauth") {
        return yield* Effect.fail(
          new Error("image_gen requires an active OpenAI Codex/ChatGPT subscription OAuth login."),
        )
      }
      if (current.access && current.expires > Date.now() + 30_000) return current

      const tokens = yield* Effect.tryPromise({
        try: () => refreshCodexAccessToken(current.refresh),
        catch: (cause) => new Error("Failed to refresh the Codex subscription access token.", { cause }),
      })
      const refreshed = refreshedCredentials(current, tokens)
      yield* auth.set(
        "openai",
        new Auth.Oauth({
          type: "oauth",
          ...refreshed,
        }),
      )
      return new Auth.Oauth({ type: "oauth", ...refreshed })
    })

    const localImageUrls = Effect.fn("ImageGen.localImageUrls")(function* (
      paths: readonly string[],
      ctx: Tool.Context,
    ) {
      const urls: string[] = []
      for (const filepath of paths) {
        if (!path.isAbsolute(filepath)) {
          return yield* Effect.fail(new Error(`Referenced image path must be absolute: ${filepath}`))
        }
        yield* assertExternalDirectoryEffect(ctx, filepath, {
          bypass: Boolean(ctx.extra?.["bypassCwdCheck"]),
          kind: "file",
        })
        yield* ctx.ask({
          permission: "read",
          patterns: [filepath],
          always: ["*"],
          metadata: { filepath },
        })
        const stat = yield* fs
          .stat(filepath)
          .pipe(Effect.mapError((cause) => new Error(`Unable to inspect referenced image at ${filepath}.`, { cause })))
        if (stat.type !== "File") {
          return yield* Effect.fail(new Error(`Referenced image is not a file: ${filepath}`))
        }
        if (Number(stat.size) > MAX_INPUT_IMAGE_BYTES) {
          return yield* Effect.fail(new Error(`Referenced image exceeds the 50 MB limit: ${filepath}`))
        }
        const bytes = yield* fs
          .readFile(filepath)
          .pipe(Effect.mapError((cause) => new Error(`Unable to read referenced image at ${filepath}.`, { cause })))
        const mime = sniffAttachmentMime(bytes, AppFileSystem.mimeType(filepath))
        if (!isImageAttachment(mime)) {
          return yield* Effect.fail(new Error(`Referenced file is not a supported raster image: ${filepath}`))
        }
        urls.push(`data:${mime};base64,${Buffer.from(bytes).toString("base64")}`)
      }
      return urls
    })

    const apiKey = Effect.fn("ImageGen.apiKey")(function* (providerID: string) {
      const current = yield* auth.get(providerID)
      if (current?.type === "api") return current.key
      if (current?.type === "wellknown") return current.token || current.key
      const env =
        providerID === "openrouter"
          ? process.env.OPENROUTER_API_KEY
          : providerID === "openai"
            ? process.env.OPENAI_API_KEY
            : undefined
      if (env?.trim()) return env.trim()
      return yield* Effect.fail(new Error(`No API key is configured for image provider ${providerID}.`))
    })

    const requestJSON = Effect.fn("ImageGen.requestJSON")(function* (input: {
      adapter: ImageAdapter
      url: string
      headers: Headers
      body: unknown
      signal: AbortSignal
    }) {
      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(input.url, {
            method: "POST",
            headers: input.headers,
            body: JSON.stringify(input.body),
            signal: input.signal,
          }),
        catch: (cause) => new Error(`${input.adapter} image request failed before receiving a response.`, { cause }),
      })
      if (!response.ok) {
        const text = yield* Effect.promise(() => response.text().catch(() => ""))
        return yield* Effect.fail(responseError(input.adapter, response.status, text))
      }
      return yield* Effect.tryPromise({
        try: () => response.json() as Promise<ImageResponse>,
        catch: (cause) => new Error(`${input.adapter} image response was not valid JSON.`, { cause }),
      })
    })

    const requestCodex = Effect.fn("ImageGen.requestCodex")(function* (input: {
      modelID: string
      operation: ImageOperation
      prompt: string
      images: string[]
      options: Record<string, unknown>
      signal: AbortSignal
    }) {
      const credentials = yield* oauthCredentials()
      const headers = new Headers({
        authorization: `Bearer ${credentials.access}`,
        "content-type": "application/json",
        "x-codex-image-turn-id": crypto.randomUUID(),
      })
      if (credentials.accountId) headers.set("ChatGPT-Account-Id", credentials.accountId)
      const body = {
        ...input.options,
        ...(input.operation === "edits" ? { images: input.images.map((image_url) => ({ image_url })) } : {}),
        prompt: input.prompt,
        model: input.modelID,
      }
      const preparedBody = prepareCodexChatGPTOAuthRequest({
        body: JSON.stringify(body),
        headers,
        responsesLite: false,
      })
      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(codexImageEndpoint(input.operation), {
            method: "POST",
            headers,
            body: preparedBody,
            signal: input.signal,
          }),
        catch: (cause) => new Error("Codex image request failed before receiving a response.", { cause }),
      })
      if (!response.ok) {
        const text = yield* Effect.promise(() => response.text().catch(() => ""))
        return yield* Effect.fail(responseError("codex-oauth", response.status, text))
      }
      return yield* Effect.tryPromise({
        try: () => response.json() as Promise<ImageResponse>,
        catch: (cause) => new Error("Codex image response was not valid JSON.", { cause }),
      })
    })

    const dataURLBlob = (url: string) => {
      const match = url.match(/^data:([^;,]+);base64,(.+)$/s)
      if (!match) throw new Error("OpenAI-compatible image edits require embedded data URL references.")
      const bytes = Buffer.from(match[2], "base64")
      if (bytes.byteLength > MAX_INPUT_IMAGE_BYTES) throw new Error("Referenced image exceeds the 50 MB limit.")
      const sniffed = sniffAttachmentMime(bytes, "")
      if (!isImageAttachment(sniffed) || sniffed !== match[1]) {
        throw new Error("OpenAI-compatible image edit reference is not a valid embedded image.")
      }
      return { blob: new Blob([bytes], { type: sniffed }), extension: extensionForMediaType(sniffed) }
    }

    const requestOpenAICompatible = Effect.fn("ImageGen.requestOpenAICompatible")(function* (input: {
      providerID: string
      modelID: string
      operation: ImageOperation
      prompt: string
      images: string[]
      options: Record<string, unknown>
      baseURL?: string
      signal: AbortSignal
    }) {
      const key = yield* apiKey(input.providerID)
      const headers = new Headers({ authorization: `Bearer ${key}` })
      if (input.operation === "generations") {
        headers.set("content-type", "application/json")
        return yield* requestJSON({
          adapter: "openai-compatible",
          url: openAIImageEndpoint(input.baseURL, input.operation),
          headers,
          body: { ...input.options, prompt: input.prompt, model: input.modelID, n: 1 },
          signal: input.signal,
        })
      }

      const form = new FormData()
      form.set("prompt", input.prompt)
      form.set("model", input.modelID)
      form.set("n", "1")
      for (const [key, value] of Object.entries(input.options)) {
        if (value === undefined || value === null || typeof value === "object") continue
        form.set(key, String(value))
      }
      input.images.forEach((url, index) => {
        const image = dataURLBlob(url)
        form.append("image[]", image.blob, `reference-${index + 1}.${image.extension}`)
      })
      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(openAIImageEndpoint(input.baseURL, input.operation), {
            method: "POST",
            headers,
            body: form,
            signal: input.signal,
          }),
        catch: (cause) => new Error("openai-compatible image request failed before receiving a response.", { cause }),
      })
      if (!response.ok) {
        const text = yield* Effect.promise(() => response.text().catch(() => ""))
        return yield* Effect.fail(responseError("openai-compatible", response.status, text))
      }
      return yield* Effect.tryPromise({
        try: () => response.json() as Promise<ImageResponse>,
        catch: (cause) => new Error("openai-compatible image response was not valid JSON.", { cause }),
      })
    })

    const resolveResponseImage = Effect.fn("ImageGen.resolveResponseImage")(function* (
      payload: ImageResponse,
      signal: AbortSignal,
      adapter: ImageAdapter,
    ) {
      const image = payload.data?.[0]
      if (image?.b64_json) return { encoded: image.b64_json, declaredMediaType: image.media_type }
      if (!image?.url || !isSafeGeneratedImageURL(image.url)) {
        return yield* Effect.fail(new Error(`${adapter} image response contained no image data.`))
      }
      const response = yield* Effect.tryPromise({
        try: () => fetch(image.url!, { signal }),
        catch: (cause) => new Error(`${adapter} image download failed before receiving a response.`, { cause }),
      })
      if (!response.ok) {
        return yield* Effect.fail(new Error(`${adapter} image download failed with HTTP ${response.status}.`))
      }
      const declaredSize = Number(response.headers.get("content-length") || 0)
      if (declaredSize > MAX_OUTPUT_IMAGE_BYTES) {
        return yield* Effect.fail(new Error("Image generation returned an image larger than 50 MB."))
      }
      const bytes = yield* Effect.tryPromise({
        try: () => readBoundedImageBody(response),
        catch: (cause) =>
          cause instanceof Error && cause.message.includes("larger than 50 MB")
            ? cause
            : new Error(`${adapter} image download body could not be read.`, { cause }),
      })
      return {
        encoded: Buffer.from(bytes).toString("base64"),
        declaredMediaType: image.media_type || response.headers.get("content-type")?.split(";", 1)[0],
      }
    })

    const captionImage = Effect.fn("ImageGen.captionImage")(function* (input: {
      modelRef: string
      bytes: Uint8Array
      mediaType: string
      prompt: string
      maxChars: number
      signal: AbortSignal
    }) {
      const ref = Provider.parseModel(input.modelRef)
      const model = yield* provider.getModel(ref.providerID, ref.modelID)
      if (!model.capabilities.input.image || !model.capabilities.output.text) {
        return yield* Effect.fail(
          new Error(`Caption model ${input.modelRef} must advertise image input and text output capabilities.`),
        )
      }
      const language = yield* provider.getLanguage(model)
      const result = yield* Effect.tryPromise({
        try: () =>
          generateText({
            model: language,
            abortSignal: input.signal,
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: input.prompt },
                  { type: "image", image: input.bytes, mediaType: input.mediaType },
                ],
              },
            ],
          }),
        catch: (cause) => new Error(`Caption model ${input.modelRef} failed.`, { cause }),
      })
      const text = result.text.trim()
      if (!text) return yield* Effect.fail(new Error(`Caption model ${input.modelRef} returned no text.`))
      return text.slice(0, input.maxChars)
    })

    return {
      description: DESCRIPTION,
      parameters: ImageGenParameters,
      execute: (params: ImageGenArgs, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const prompt = params.prompt.trim()
          if (!prompt) return yield* Effect.fail(new Error("image_gen requires a non-empty prompt."))

          const cfg = yield* config.get()
          const settings = cfg.image_generation ?? {}
          if (settings.enabled === false) return yield* Effect.fail(new Error("image_gen is disabled in config."))
          const openAIAuth = yield* auth.get("openai")
          const model = resolveImageGenerationModel(settings, openAIAuth)
          if (!model) {
            return yield* Effect.fail(
              new Error(
                "image_gen requires image_generation.model in provider/model format or an active OpenAI ChatGPT subscription OAuth login.",
              ),
            )
          }
          const modelRef = Provider.parseModel(model)
          const requestedAdapter = settings.adapter ?? "auto"
          const codexAdapter = usesCodexImageAdapter(settings, openAIAuth, model)
          const imageModel = codexAdapter ? undefined : yield* provider.getModel(modelRef.providerID, modelRef.modelID)
          if (imageModel && !imageModel.capabilities.output.image) {
            return yield* Effect.fail(
              new Error(`Configured image model ${model} does not advertise image output capability.`),
            )
          }
          const providerAuth = modelRef.providerID === "openai" ? openAIAuth : yield* auth.get(modelRef.providerID)
          const adapter: ImageAdapter =
            requestedAdapter !== "auto"
              ? requestedAdapter
              : modelRef.providerID === "openrouter"
                ? "openrouter"
                : modelRef.providerID === "openai" && providerAuth?.type === "oauth"
                  ? "codex-oauth"
                  : modelRef.providerID === "openai"
                    ? "openai-compatible"
                    : yield* Effect.fail(
                        new Error(
                          `Provider ${modelRef.providerID} advertises image output but has no verified automatic Image API adapter. Configure image_generation.adapter explicitly.`,
                        ),
                      )
          if (adapter === "codex-oauth" && modelRef.providerID !== "openai") {
            return yield* Effect.fail(new Error("The codex-oauth image adapter can only be used with the openai provider."))
          }

          const selection = validateEditSelection(params)
          const operation: ImageOperation =
            selection.paths.length > 0 || selection.recentCount !== undefined ? "edits" : "generations"

          yield* ctx.metadata({
            title: operation === "edits" ? "Editing image" : "Generating image",
            metadata: {
              operation,
              provider: modelRef.providerID,
              model: modelRef.modelID,
              adapter,
              requestedSize: typeof settings.options?.size === "string" ? settings.options.size : "auto",
            },
          })
          yield* ctx.ask({
            permission: "image_gen",
            patterns: [prompt],
            always: ["*"],
            metadata: {
              operation,
              provider: modelRef.providerID,
              model: modelRef.modelID,
              adapter,
              captionModel: settings.caption?.enabled === false ? undefined : settings.caption?.model,
            },
          })

          const images =
            selection.paths.length > 0
              ? yield* localImageUrls(selection.paths, ctx)
              : selection.recentCount !== undefined
                ? imageUrlsFromMessages(ctx.messages, selection.recentCount)
                : []
          if (selection.recentCount !== undefined && images.length !== selection.recentCount) {
            return yield* Effect.fail(
              new Error(
                `Requested ${selection.recentCount} recent conversation images, but only ${images.length} were available. Ask the user to attach the missing images again.`,
              ),
            )
          }

          const timeout = AbortSignal.timeout(settings.timeout_ms ?? DEFAULT_TIMEOUT_MS)
          const signal = AbortSignal.any([ctx.abort, timeout])
          const options = { ...(settings.options ?? {}) }
          const payload =
            adapter === "codex-oauth"
              ? yield* requestCodex({
                  modelID: modelRef.modelID,
                  operation,
                  prompt,
                  images,
                  options,
                  signal,
                })
              : adapter === "openrouter"
                ? yield* Effect.gen(function* () {
                    const key = yield* apiKey(modelRef.providerID)
                    return yield* requestJSON({
                      adapter,
                      url: openRouterImageEndpoint(settings.base_url),
                      headers: new Headers({ authorization: `Bearer ${key}`, "content-type": "application/json" }),
                      body: {
                        ...options,
                        model: modelRef.modelID,
                        prompt,
                        n: 1,
                        ...(images.length
                          ? {
                              input_references: images.map((url) => ({
                                type: "image_url",
                                image_url: { url },
                              })),
                            }
                          : {}),
                      },
                      signal,
                    })
                  })
                : yield* requestOpenAICompatible({
                    providerID: modelRef.providerID,
                    modelID: modelRef.modelID,
                    operation,
                    prompt,
                    images,
                    options,
                    baseURL: settings.base_url || imageModel?.api.url,
                    signal,
                  })
          const responseImage = yield* resolveResponseImage(payload, signal, adapter)
          const encoded = responseImage.encoded

          const decoded = decodeGeneratedImage(encoded, responseImage.declaredMediaType)
          const bytes = decoded.bytes
          const dimensions = decoded.mediaType === "image/png" ? generatedPngMetadata(bytes) : undefined
          const extension = extensionForMediaType(decoded.mediaType)
          const callID = ctx.callID?.trim() || crypto.randomUUID()
          const outputPath = generatedImageArtifactPath(generatedImageRoot(), ctx.sessionID, callID, extension)
          yield* fs
            .writeWithDirs(outputPath, bytes)
            .pipe(Effect.mapError((cause) => new Error(`Failed to save generated image at ${outputPath}.`, { cause })))

          const captionSettings = settings.caption
          const captionEnabled = captionSettings?.enabled !== false && Boolean(captionSettings?.model)
          const captionResult = captionEnabled
            ? yield* captionImage({
                modelRef: captionSettings!.model!,
                bytes,
                mediaType: decoded.mediaType,
                prompt:
                  captionSettings?.prompt?.trim() ||
                  "Describe this generated image accurately and concisely. Preserve visible text, layout, important objects, style, and visual constraints. Do not infer facts that are not visible.",
                maxChars: Math.min(captionSettings?.max_chars ?? 2_000, MAX_CAPTION_CHARS),
                signal,
              }).pipe(
                Effect.catchCause(() =>
                  Effect.fail(new Error(`Caption model ${captionSettings!.model!} could not describe the generated image.`)),
                ),
                Effect.match({
                  onFailure: (error) => ({ status: "error" as const, error: error.message }),
                  onSuccess: (caption) => ({ status: "completed" as const, caption }),
                }),
              )
            : captionSettings?.enabled === true
              ? { status: "error" as const, error: "Caption is enabled but image_generation.caption.model is not configured." }
              : { status: "disabled" as const }
          if (captionResult.status === "error" && captionSettings?.required) {
            return yield* Effect.fail(
              new Error(`Generated image was saved to ${outputPath}, but required caption generation failed: ${captionResult.error}`),
            )
          }

          const dataUrl = `data:${decoded.mediaType};base64,${encoded.trim()}`
          const captionLine =
            captionResult.status === "completed"
              ? `Visual caption: ${captionResult.caption}`
              : captionResult.status === "error"
                ? `Visual caption unavailable: ${captionResult.error}`
                : "Visual caption disabled."
          return {
            title: operation === "edits" ? "Edited image" : "Generated image",
            output: [
              `Generated image saved to ${outputPath}.`,
              captionLine,
              "The full TUI shows the saved path and external open actions; do not repeat the image as a Markdown image or file link.",
              "For preview-only work, leave the managed original in place.",
              "For project-bound work, copy the selected image into the workspace using a stable descriptive filename. Do not overwrite an existing asset unless the user explicitly requested replacement.",
            ].join("\n"),
            metadata: {
              operation,
              provider: modelRef.providerID,
              model: modelRef.modelID,
              adapter,
              path: outputPath,
              mediaType: decoded.mediaType,
              format: extension.toUpperCase(),
              size: payload.size ?? dimensions?.size ?? "unknown",
              width: dimensions?.width,
              height: dimensions?.height,
              bytes: bytes.byteLength,
              requestedSize: typeof options.size === "string" ? options.size : "auto",
              reportedSize: payload.size ?? "auto",
              quality: payload.quality ?? "auto",
              cost: typeof payload.usage?.cost === "number" ? payload.usage.cost : null,
              caption: {
                ...captionResult,
                model: captionSettings?.model,
              },
            },
            attachments: [
              {
                type: "file" as const,
                mime: decoded.mediaType,
                filename: path.basename(outputPath),
                url: dataUrl,
              },
            ],
          }
        }).pipe(Effect.orDie),
    }
  }),
)
