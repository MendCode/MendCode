import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises"
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { z } from "zod"
import { defineTool, type Tool, type ToolResult } from "../tool"
import { displayPath, errorMessage, fail } from "../util"
import { clip, envValue, isRecord, requestJson, type FetchLike } from "./api_http"
import { createImageApi, DEFAULT_CODEX_IMAGE_MODEL, type ImageApiCredentials } from "./image_api"
import type { ImageGenerationSettings } from "@mendcode/protocol"
import { detectMediaMime } from "../media"

const MAX_IMAGES = 2
const MAX_PROMPT_CHARS = 4_000
const TIMEOUT_MS = 180_000
const MAX_RESPONSE_BYTES = 40 * 1024 * 1024
/** Images attached to the result stay under the engine's per-image cap; bigger ones are saved but not shown. */
const MAX_ATTACH_BYTES = 5 * 1024 * 1024
const DEFAULT_DIR = "generated"
const SLUG_CHARS = 40
/** The same model the configured and subscription paths default to (`DEFAULT_CODEX_IMAGE_MODEL`); `OPENAI_IMAGE_MODEL` overrides it. */
const DEFAULT_OPENAI_MODEL = DEFAULT_CODEX_IMAGE_MODEL
const DEFAULT_OPENROUTER_MODEL = "google/gemini-2.5-flash-image"

export const IMAGE_GEN_ENV = { openrouter: "OPENROUTER_API_KEY", openai: "OPENAI_API_KEY" } as const
export const IMAGE_GEN_MODEL_ENV = { openrouter: "OPENROUTER_IMAGE_MODEL", openai: "OPENAI_IMAGE_MODEL" } as const

const SIZES = ["1024x1024", "1536x1024", "1024x1536"] as const
const ASPECT: Record<(typeof SIZES)[number], string> = { "1024x1024": "1:1", "1536x1024": "3:2", "1024x1536": "2:3" }

type ImageType = "png" | "jpeg" | "gif" | "webp"
type Generated = { bytes: Uint8Array; type: ImageType }
type GenerateInput = { prompt: string; size: (typeof SIZES)[number]; count: number; key: string; fetch: FetchLike; signal: AbortSignal; env: Record<string, string | undefined> }
type GenerateOutcome = { ok: true; images: Generated[]; model: string } | { ok: false; message: string }
type Provider = { id: keyof typeof IMAGE_GEN_ENV; generate(input: GenerateInput): Promise<GenerateOutcome> }

/** PNG or JPEG by magic bytes; anything else (webp, a text error page) is not accepted. */
export function sniffImage(bytes: Uint8Array): ImageType | undefined {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png"
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg"
  return undefined
}

function decode(base64: string): Generated | string {
  const bytes = new Uint8Array(Buffer.from(base64, "base64"))
  const type = sniffImage(bytes)
  return type ? { bytes, type } : "the provider returned data that is not a PNG or JPEG image"
}

const DATA_URL = /^data:image\/[\w.+-]+;base64,(.+)$/s

const openrouter: Provider = {
  id: "openrouter",
  async generate({ prompt, size, count, key, fetch, signal, env }) {
    const model = envValue({ env, name: IMAGE_GEN_MODEL_ENV.openrouter }) ?? DEFAULT_OPENROUTER_MODEL
    const base = (envValue({ env, name: "OPENROUTER_BASE_URL" }) ?? "https://openrouter.ai/api/v1").replace(/\/+$/, "")
    // A chat completion returns one image; n images are n calls.
    const calls = await Promise.all(
      Array.from({ length: count }, () =>
        requestJson({
          fetch,
          url: `${base}/chat/completions`,
          init: {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
            body: JSON.stringify({ model, modalities: ["image", "text"], image_config: { aspect_ratio: ASPECT[size] }, messages: [{ role: "user", content: prompt }] }),
          },
          provider: "OpenRouter",
          secrets: [key],
          signal,
          timeoutMs: TIMEOUT_MS,
          maxBytes: MAX_RESPONSE_BYTES,
        }),
      ),
    )
    const images: Generated[] = []
    for (const call of calls) {
      if (!call.ok) return call
      const choices = isRecord(call.json) ? call.json.choices : undefined
      const message = Array.isArray(choices) && isRecord(choices[0]) && isRecord(choices[0].message) ? choices[0].message : undefined
      const found = Array.isArray(message?.images) ? message.images : []
      const url = found.map((item) => (isRecord(item) && isRecord(item.image_url) ? item.image_url.url : undefined)).find((value): value is string => typeof value === "string")
      const match = url?.match(DATA_URL)
      if (!match) return { ok: false, message: `OpenRouter model ${model} returned no image; it must be an image-output model (set ${IMAGE_GEN_MODEL_ENV.openrouter})` }
      const decoded = decode(match[1] as string)
      if (typeof decoded === "string") return { ok: false, message: `OpenRouter: ${decoded}` }
      images.push(decoded)
    }
    return { ok: true, images, model }
  },
}

const openai: Provider = {
  id: "openai",
  async generate({ prompt, size, count, key, fetch, signal, env }) {
    const model = envValue({ env, name: IMAGE_GEN_MODEL_ENV.openai }) ?? DEFAULT_OPENAI_MODEL
    const base = (envValue({ env, name: "OPENAI_BASE_URL" }) ?? "https://api.openai.com/v1").replace(/\/+$/, "")
    const dalle = model.startsWith("dall-e")
    // dall-e-3 takes one image per request; the gpt-image models take n.
    const requests = model.startsWith("dall-e-3") ? Array.from({ length: count }, () => 1) : [count]
    const calls = await Promise.all(
      requests.map((n) =>
        requestJson({
          fetch,
          url: `${base}/images/generations`,
          init: {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
            body: JSON.stringify({ model, prompt, size, n, ...(dalle ? { response_format: "b64_json" } : {}) }),
          },
          provider: "OpenAI Images",
          secrets: [key],
          signal,
          timeoutMs: TIMEOUT_MS,
          maxBytes: MAX_RESPONSE_BYTES,
        }),
      ),
    )
    const images: Generated[] = []
    for (const call of calls) {
      if (!call.ok) return call
      const data = isRecord(call.json) && Array.isArray(call.json.data) ? call.json.data : []
      for (const item of data) {
        const b64 = isRecord(item) ? item.b64_json : undefined
        if (typeof b64 !== "string") return { ok: false, message: "OpenAI Images returned no inline image data" }
        const decoded = decode(b64)
        if (typeof decoded === "string") return { ok: false, message: `OpenAI Images: ${decoded}` }
        images.push(decoded)
      }
    }
    if (images.length === 0) return { ok: false, message: "OpenAI Images returned no image" }
    return { ok: true, images: images.slice(0, count), model }
  },
}

/** First configured wins: OpenRouter, then OpenAI. */
const PROVIDERS: Provider[] = [openrouter, openai]

/** The provider a set of environment variables selects, or undefined when no key exists. Never returns the key. */
export function selectImageProvider(env: Record<string, string | undefined>): Provider["id"] | undefined {
  return PROVIDERS.find((provider) => envValue({ env, name: IMAGE_GEN_ENV[provider.id] }))?.id
}

export function slugify(prompt: string): string {
  const slug = prompt
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_CHARS)
    .replace(/-+$/, "")
  return slug || "image"
}

const EXTENSION: Record<ImageType, string> = { png: "png", jpeg: "jpg", gif: "gif", webp: "webp" }

/** Whether `target` (absolute) is inside `cwd`, both lexically and after resolving symlinks of its nearest existing ancestor. */
export async function insideProject({ cwd, target }: { cwd: string; target: string }): Promise<boolean> {
  const within = (root: string, path: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
  if (!within(resolve(cwd), target)) return false
  const root = await realpath(cwd).catch(() => resolve(cwd))
  let probe = target
  for (;;) {
    const real = await realpath(probe).catch(() => undefined)
    if (real !== undefined) return within(root, real)
    const parent = dirname(probe)
    if (parent === probe) return false
    probe = parent
  }
}

const args = z.object({
  prompt: z.string().trim().min(1).max(MAX_PROMPT_CHARS).describe("A complete description of the image: subject, style, composition, any exact text"),
  size: z.enum(SIZES).optional().describe("1024x1024 (default), 1536x1024 (landscape) or 1024x1536 (portrait)"),
  n: z.number().int().min(1).max(MAX_IMAGES).optional().describe(`How many images (default 1, at most ${MAX_IMAGES})`),
  path: z
    .string()
    .min(1)
    .optional()
    .describe(`Where to save it, inside the project (default ${DEFAULT_DIR}/<prompt-slug>-<n>.png). With n=2 the files get -1 and -2 before the extension.`),
  referenced_image_paths: z.array(z.string().min(1).max(4096)).max(5).optional().describe("Absolute local image paths to edit; read and external-directory permissions apply. Never combine with recent images"),
  num_last_images_to_include: z.number().int().min(0).max(5).optional().describe("0 for a new image, 1–5 for recent conversation images to edit"),
})

async function pathsFor({ cwd, images, prompt, path }: { cwd: string; images: Generated[]; prompt: string; path: string | undefined }): Promise<string[] | string> {
  if (path !== undefined) {
    const target = isAbsolute(path) ? resolve(path) : resolve(cwd, path)
    if (!(await insideProject({ cwd, target }))) return `refusing to write ${path}: image_gen only saves inside the project (${cwd})`
    const ext = extname(target).toLowerCase()
    const stem = [".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext) ? target.slice(0, -ext.length) : target
    if (basename(stem) === "") return `invalid path: ${path}`
    return images.map((image, index) => `${stem}${images.length > 1 ? `-${index + 1}` : ""}.${EXTENSION[image.type]}`)
  }
  const dir = resolve(cwd, DEFAULT_DIR)
  if (!(await insideProject({ cwd, target: dir }))) return `refusing to write ${DEFAULT_DIR}/: it resolves outside the project`
  return [join(dir, slugify(prompt))]
}

/**
 * `image_gen`: text to image through OpenRouter (an image-output model) or the OpenAI Images API, saved inside the
 * project and returned to the model as images. Returns undefined when no key is set, so the tool is not registered.
 * `env` and `fetch` are injectable so tests never touch the network.
 */
export function createImageGenTool({
  env = process.env,
  fetch = globalThis.fetch as FetchLike,
  settings,
  subscriptionHeaders,
  credentials,
  caption,
  managedDir,
  validate,
}: {
  env?: Record<string, string | undefined>
  fetch?: FetchLike
  settings?(): ImageGenerationSettings | undefined
  subscriptionHeaders?(): Promise<Record<string, string>>
  credentials?(provider: string): ImageApiCredentials | undefined
  caption?(input: { model: string; image: Generated; prompt: string; maxChars: number; signal: AbortSignal }): Promise<string>
  managedDir?: string
  validate?(settings: ImageGenerationSettings): string | undefined
} = {}): Tool | undefined {
  if (settings?.()?.enabled === false || !selectImageProvider(env) && settings?.()?.enabled !== true) return undefined
  return defineTool({
    name: "image_gen",
    description:
      "Generate or edit one or two images using the independently configured image provider/model. Use only for an explicit user image request. For edits use up to five absolute local referenced_image_paths or num_last_images_to_include (1–5), never both. Read and external-directory permissions apply. For new images omit references or use 0. Returns saved paths, images and an optional visual caption. Configured generation saves managed artifacts; path saves inside the project. Never overwrite an existing asset unless the user requested replacement.",
    permission: "write",
    args,
    async execute({ prompt, size, n, path, referenced_image_paths, num_last_images_to_include }, context): Promise<ToolResult> {
      const title = `Image ${clip({ text: prompt, max: 60 })}`
      const cfg = settings?.()
      if (cfg?.enabled === false) return fail({ title, message: "image_gen is disabled in config" })
      const problem = cfg && validate?.(cfg)
      if (problem) return fail({ title, message: problem })
      const provider = PROVIDERS.find((candidate) => envValue({ env, name: IMAGE_GEN_ENV[candidate.id] }))
      if (!provider && cfg?.enabled !== true) return fail({ title, message: "image_gen has no API key: set OPENROUTER_API_KEY or OPENAI_API_KEY, or enable image_generation" })
      if (context.signal.aborted) return fail({ title, message: "cancelled" })
      const count = n ?? 1
      // Validate the destination before paying for the image.
      const early = path !== undefined ? await pathsFor({ cwd: context.cwd, images: Array.from({ length: count }, () => ({ bytes: new Uint8Array(), type: "png" as const })), prompt, path }) : undefined
      if (typeof early === "string") return fail({ title, message: early })
      const references: Array<{ mime: string; bytes: Uint8Array }> = []
      const paths = referenced_image_paths ?? []
      const recent = num_last_images_to_include ?? 0
      if (paths.length && recent) return fail({ title, message: "Provide only one of referenced_image_paths or num_last_images_to_include" })
      try {
        for (const file of paths) {
          if (!isAbsolute(file)) return fail({ title, message: "Referenced image paths must be absolute" })
          const info = await stat(file)
          if (!info.isFile() || info.size > 50 * 1024 * 1024) return fail({ title, message: "Referenced image must be a file no larger than 50 MB" })
          const bytes = new Uint8Array(await readFile(file))
          const mime = detectMediaMime(bytes)
          if (bytes.length > 50 * 1024 * 1024 || !mime?.startsWith("image/")) return fail({ title, message: "Referenced file must be a supported raster image no larger than 50 MB" })
          references.push({ mime, bytes })
        }
        if (recent) references.push(...await context.recentImages?.(recent) ?? [])
      } catch {
        return fail({ title, message: "Unable to read image references" })
      }
      if (recent && references.length !== recent) return fail({ title, message: `Requested ${recent} recent images, but only ${references.length} are available; attach the missing images again` })
      const configured = cfg?.enabled === true || references.length > 0
      const effective = { ...cfg, model: cfg?.model ?? (cfg?.adapter === "codex-oauth" ? "openai:gpt-image-2" : provider ? `${provider.id}:${envValue({ env, name: IMAGE_GEN_MODEL_ENV[provider.id] }) ?? (provider.id === "openai" ? DEFAULT_OPENAI_MODEL : DEFAULT_OPENROUTER_MODEL)}` : "openai:gpt-image-2") }
      // What the terminal's wait canvas shows while the image is made; the result's text replaces it.
      context.onOutput?.(`model ${effective.model.replace(":", "/")}\nsize ${size ?? "1024x1024"}\n`)
      const apiCredentials = (id: string) => credentials ? credentials(id) : (id === "openai" || id === "openrouter" ? (() => {
        const key = envValue({ env, name: IMAGE_GEN_ENV[id] })
        return key ? { baseUrl: envValue({ env, name: id === "openai" ? "OPENAI_BASE_URL" : "OPENROUTER_BASE_URL" }) ?? (id === "openai" ? "https://api.openai.com/v1" : "https://openrouter.ai/api/v1"), headers: { authorization: `Bearer ${key}` } } : undefined
      })() : undefined)
      const outcome = configured
        ? await createImageApi({ settings: effective, fetch, ...(subscriptionHeaders ? { subscriptionHeaders } : {}), credentials: apiCredentials })({ prompt, size: size ?? "1024x1024", count, references, signal: context.signal })
        : await provider!.generate({ prompt, size: size ?? "1024x1024", count, key: envValue({ env, name: IMAGE_GEN_ENV[provider!.id] })!, fetch, signal: context.signal, env })
      if (!outcome.ok) return fail({ title, message: `image_gen failed: ${outcome.message}` })
      if (context.signal.aborted) return fail({ title, message: "cancelled" })

      const artifactRoot = cfg?.enabled === true && managedDir && path === undefined ? managedDir : undefined
      const planned = artifactRoot ? [join(artifactRoot, slugify(prompt))] : await pathsFor({ cwd: context.cwd, images: outcome.images, prompt, path })
      if (typeof planned === "string") return fail({ title, message: planned })
      const saved: string[] = []
      try {
        if (path !== undefined) {
          for (const [index, file] of planned.entries()) {
            await mkdir(dirname(file), { recursive: true })
            await writeFile(file, (outcome.images[index] as Generated).bytes)
            saved.push(file)
          }
        } else {
          // Default names never overwrite: take the first free <slug>-<k>.<ext>.
          const stem = planned[0] as string
          await mkdir(dirname(stem), { recursive: true })
          let next = 1
          for (const image of outcome.images) {
            for (;;) {
              const file = `${stem}-${next++}.${EXTENSION[image.type]}`
              try {
                await writeFile(file, image.bytes, { flag: "wx" })
                saved.push(file)
                break
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
              }
            }
          }
        }
      } catch (error) {
        return fail({ title, message: `image_gen could not save the image: ${errorMessage(error)}` })
      }

      let captionText = ""
      let captionStatus = "disabled"
      if (cfg?.caption?.enabled === true) {
        captionStatus = "error"
        try {
          if (!cfg.caption.model || !caption) throw new Error("Caption model is not configured")
          const signal = AbortSignal.any([context.signal, AbortSignal.timeout(cfg.timeout_ms ?? TIMEOUT_MS)])
          captionText = (await caption({ model: cfg.caption.model, image: outcome.images[0]!, prompt: cfg.caption.prompt ?? "Describe this generated image accurately and concisely. Preserve visible text, layout, objects and style. Do not infer facts that are not visible.", maxChars: cfg.caption.max_chars ?? 2000, signal })).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").trim().slice(0, cfg.caption.max_chars ?? 2000)
          if (!captionText) throw new Error("Empty caption")
          captionStatus = "completed"
        } catch {
          if (cfg.caption.required) return { ...fail({ title, message: `Generated image saved to ${saved[0]}, but required caption generation failed` }), meta: { path: saved[0]!, captionStatus: "error" } }
        }
      }

      const shown = outcome.images.filter((image) => image.bytes.length <= MAX_ATTACH_BYTES)
      const inline = shown.filter((image) => image.type === "png" || image.type === "jpeg")
      const attachments = shown.filter((image) => image.type === "gif" || image.type === "webp")
      const lines = await Promise.all(
        saved.map(async (file, index) => {
          const image = outcome.images[index] as Generated
          const size = (await stat(file).catch(() => undefined))?.size ?? image.bytes.length
          return `saved ${displayPath({ cwd: context.cwd, path: file })} (${image.type.toUpperCase()}, ${(size / 1024).toFixed(0)} KB${image.bytes.length > MAX_ATTACH_BYTES ? ", too large to show" : ""})`
        }),
      )
      const relativePaths = saved.map((file) => relative(context.cwd, file))
      return {
        output: `${lines.join("\n")}\nmodel: ${outcome.model}${captionStatus === "completed" ? `\nVisual caption: ${captionText}` : captionStatus === "error" ? "\nVisual caption unavailable" : ""}`,
        truncated: false,
        title,
        isError: false,
        render: { type: "box", title: references.length ? "Edited image" : "Generated image", children: [
          { type: "text", text: " " },
          ...saved.flatMap((file) => (file.match(/[\s\S]{1,3800}/g) ?? []).map((text) => ({ type: "text", text }))),
          { type: "text", text: `${effective.model.split(/[:/]/, 1)[0]}/${outcome.model}`, tone: "muted" },
          ...(captionStatus === "completed" ? (`Caption: ${captionText}`.match(/[\s\S]{1,3800}/g) ?? []).map((text) => ({ type: "text", text })) : captionStatus === "error" ? [{ type: "text", text: "Caption unavailable", tone: "warning" }] : []),
          { type: "text", text: " " },
        ] },
        ...(inline.length > 0 ? { images: inline.map((image) => ({ mime: image.type === "png" ? ("image/png" as const) : ("image/jpeg" as const), bytes: image.bytes })) } : {}),
        ...(attachments.length > 0 ? { attachments: attachments.map((image) => ({ mime: image.type === "gif" ? ("image/gif" as const) : ("image/webp" as const), bytes: image.bytes })) } : {}),
        meta: { provider: configured ? effective.model.split(/[:/]/, 1)[0]! : provider!.id, model: outcome.model, count: saved.length, paths: relativePaths.join(","), path: saved[0]!, operation: references.length ? "edits" : "generations", captionStatus, ...(captionText ? { caption: captionText } : {}), ...(cfg?.caption?.model ? { captionModel: cfg.caption.model } : {}) },
      }
    },
  })
}
