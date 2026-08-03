import path from "path"
import { Effect, Schema } from "effect"
import { Auth } from "@/auth"
import { AppFileSystem } from "@mendcode/core/filesystem"
import { Global } from "@mendcode/core/global"
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

const IMAGE_MODEL = "gpt-image-2"
const MAX_EDIT_IMAGES = 5
const MAX_INPUT_IMAGE_BYTES = 50 * 1024 * 1024
const DEFAULT_CODEX_IMAGES_ENDPOINT = "https://chatgpt.com/backend-api/codex/images"
const GENERATED_IMAGES_DIR = "generated_images"

const DESCRIPTION = `Generate a new raster image or edit existing images using the image generation included with the active Codex/ChatGPT subscription.

Use this tool when the user explicitly asks to create or edit a bitmap image such as a photo, illustration, texture, sprite, mockup, concept, meme, or infographic. If image generation is only your optional suggestion, or a missing visual decision would materially change the result, ask one concise question before calling it. Do not reconfirm an explicit, sufficiently detailed image request.

The built-in subscription path uses gpt-image-2 with the best compatible automatic defaults for quality, background, and size. Put required orientation, aspect ratio, target resolution, exact text, and visual constraints in the prompt; do not invent unsupported raw API parameters.

For a new image, omit both reference fields. For an edit, provide either absolute local paths in referenced_image_paths or num_last_images_to_include for recent conversation images, never both. Include only the images required for the edit, up to five.

Generated PNGs are saved in MendCode's persistent generated_images directory, not an OS temp directory, and the result is displayed inline. Preview-only images may remain there. If the image will be consumed by the current project, copy the selected artifact into the workspace using a stable descriptive filename and do not overwrite an existing asset unless the user explicitly requested replacement.`

export const ImageGenParameters = Schema.Struct({
  prompt: Schema.String.annotate({
    description:
      "A complete production-oriented image prompt, including intended use, composition, orientation or target resolution when important, exact text, constraints, and avoid items.",
  }),
  referenced_image_paths: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Up to five absolute local image paths to edit. Do not combine with num_last_images_to_include.",
  }),
  num_last_images_to_include: Schema.optional(Schema.Number).annotate({
    description:
      "Number of recent conversation images to include for an edit, from 1 to 5. Use only when target images have no stable local path.",
  }),
})

export type ImageGenArgs = Schema.Schema.Type<typeof ImageGenParameters>
type ImageOperation = "generations" | "edits"
type ImageResponse = {
  data?: Array<{ b64_json?: string }>
  size?: string
  quality?: string
  background?: string
}

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

export function generatedImageArtifactPath(root: string, sessionID: string, callID: string) {
  return path.join(root, safePathSegment(sessionID), `${safePathSegment(callID)}.png`)
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
  const recentCount = params.num_last_images_to_include
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

function decodeGeneratedPng(encoded: string) {
  const compact = encoded.trim()
  if (!compact || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 !== 0) {
    throw new Error("Image generation returned invalid base64 image data.")
  }
  const bytes = Buffer.from(compact, "base64")
  if (sniffAttachmentMime(bytes, "") !== "image/png") {
    throw new Error("Image generation returned data that is not a PNG image.")
  }
  return new Uint8Array(bytes)
}

function responseError(status: number, text: string) {
  const detail = text.trim().slice(0, 1000)
  return new Error(`Codex image request failed with HTTP ${status}${detail ? `: ${detail}` : "."}`)
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
    const fs = yield* AppFileSystem.Service

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

    return {
      description: DESCRIPTION,
      parameters: ImageGenParameters,
      execute: (params: ImageGenArgs, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const prompt = params.prompt.trim()
          if (!prompt) return yield* Effect.fail(new Error("image_gen requires a non-empty prompt."))

          const selection = validateEditSelection(params)
          const operation: ImageOperation =
            selection.paths.length > 0 || selection.recentCount !== undefined ? "edits" : "generations"

          yield* ctx.metadata({
            title: operation === "edits" ? "Editing image" : "Generating image",
            metadata: { operation },
          })
          yield* ctx.ask({
            permission: "image_gen",
            patterns: [prompt],
            always: ["*"],
            metadata: { operation },
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

          const body = {
            ...(operation === "edits" ? { images: images.map((image_url) => ({ image_url })) } : {}),
            prompt,
            background: "auto",
            model: IMAGE_MODEL,
            quality: "auto",
            size: "auto",
          }
          const credentials = yield* oauthCredentials()
          const headers = new Headers({
            authorization: `Bearer ${credentials.access}`,
            "content-type": "application/json",
            "x-codex-image-turn-id": crypto.randomUUID(),
          })
          if (credentials.accountId) headers.set("ChatGPT-Account-Id", credentials.accountId)
          const preparedBody = prepareCodexChatGPTOAuthRequest({
            body: JSON.stringify(body),
            headers,
            responsesLite: false,
          })

          const response = yield* Effect.tryPromise({
            try: () =>
              fetch(codexImageEndpoint(operation), {
                method: "POST",
                headers,
                body: preparedBody,
                signal: ctx.abort,
              }),
            catch: (cause) => new Error("Codex image request failed before receiving a response.", { cause }),
          })
          if (!response.ok) {
            const text = yield* Effect.promise(() => response.text().catch(() => ""))
            return yield* Effect.fail(responseError(response.status, text))
          }
          const payload = yield* Effect.tryPromise({
            try: () => response.json() as Promise<ImageResponse>,
            catch: (cause) => new Error("Codex image response was not valid JSON.", { cause }),
          })
          const encoded = payload.data?.[0]?.b64_json
          if (!encoded) return yield* Effect.fail(new Error("Codex image response contained no image data."))

          const bytes = decodeGeneratedPng(encoded)
          const callID = ctx.callID?.trim() || crypto.randomUUID()
          const outputPath = generatedImageArtifactPath(generatedImageRoot(), ctx.sessionID, callID)
          yield* fs
            .writeWithDirs(outputPath, bytes)
            .pipe(Effect.mapError((cause) => new Error(`Failed to save generated image at ${outputPath}.`, { cause })))

          const dataUrl = `data:image/png;base64,${encoded.trim()}`
          return {
            title: operation === "edits" ? "Edited image" : "Generated image",
            output: [
              `Generated image saved to ${outputPath}.`,
              "The image is already attached and displayed to the user; do not repeat it as a Markdown image or file link.",
              "For preview-only work, leave the managed original in place.",
              "For project-bound work, copy the selected image into the workspace using a stable descriptive filename. Do not overwrite an existing asset unless the user explicitly requested replacement.",
            ].join("\n"),
            metadata: {
              operation,
              model: IMAGE_MODEL,
              path: outputPath,
              size: payload.size ?? "auto",
              quality: payload.quality ?? "auto",
            },
            attachments: [
              {
                type: "file" as const,
                mime: "image/png",
                filename: path.basename(outputPath),
                url: dataUrl,
              },
            ],
          }
        }).pipe(Effect.orDie),
    }
  }),
)
