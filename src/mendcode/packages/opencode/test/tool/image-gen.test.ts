import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { Effect, Layer } from "effect"
import { MockLanguageModelV3 } from "ai/test"
import { AppFileSystem } from "@mendcode/core/filesystem"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { Provider } from "@/provider/provider"
import { MessageID, SessionID } from "@/session/schema"
import type { MessageV2 } from "@/session/message-v2"
import { codexImageEndpoint, generatedImageArtifactPath, ImageGenTool, type ImageGenArgs } from "@/tool/image-gen"
import * as Tool from "@/tool/tool"
import { Truncate } from "@/tool/truncate"

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=="
const PNG_BYTES = Buffer.from(PNG_BASE64, "base64")
const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`

let imageGenerationConfig: Config.Info["image_generation"] = {
  enabled: true,
  model: "openai/gpt-image-2",
  options: { background: "auto", quality: "auto", size: "auto" },
}
let captionLanguageModel: MockLanguageModelV3 | undefined

const buildAgent: Agent.Info = {
  name: "build",
  mode: "primary",
  permission: Permission.fromConfig({ "*": "allow" }),
  options: {},
}

const authLayer = Layer.succeed(
  Auth.Service,
  Auth.Service.of({
    get: (providerID) =>
      Effect.succeed(
        providerID === "openai"
          ? new Auth.Oauth({
              type: "oauth",
              access: "subscription-access",
              refresh: "subscription-refresh",
              expires: Date.now() + 60_000,
              accountId: "account-123",
            })
          : providerID === "openrouter"
            ? new Auth.Api({ type: "api", key: "openrouter-test-key" })
            : undefined,
      ),
    all: () => Effect.succeed({}),
    set: () => Effect.void,
    remove: () => Effect.void,
  }),
)

const agentLayer = Layer.succeed(
  Agent.Service,
  Agent.Service.of({
    get: () => Effect.succeed(buildAgent),
    list: () => Effect.succeed([buildAgent]),
    defaultAgent: () => Effect.succeed("build"),
    generate: () => Effect.die("agent generation is not used by image_gen tests"),
  }),
)

const truncateLayer = Layer.succeed(
  Truncate.Service,
  Truncate.Service.of({
    cleanup: () => Effect.void,
    write: (text) => Effect.succeed(text),
    writeOutput: () => Effect.succeed({ path: "", complete: true }),
    output: (content) => Effect.succeed({ content, truncated: false as const }),
    limits: () => Effect.succeed({ maxLines: 2000, maxBytes: 50 * 1024 }),
  }),
)

const configLayer = Layer.succeed(
  Config.Service,
  Config.Service.of({
    get: () => Effect.succeed({ image_generation: imageGenerationConfig }),
    getGlobal: () => Effect.succeed({}),
    getConsoleState: () => Effect.succeed({ consoleManagedProviders: [], switchableOrgCount: 0 }),
    update: () => Effect.void,
    updateGlobal: (info) => Effect.succeed({ info, changed: false }),
    invalidate: () => Effect.void,
    directories: () => Effect.succeed([]),
    waitForDependencies: () => Effect.void,
  }),
)

const providerLayer = Layer.succeed(
  Provider.Service,
  Provider.Service.of({
    list: () => Effect.succeed({}),
    getProvider: () => Effect.die("provider info is not used by image_gen tests"),
    getModel: (providerID, modelID) =>
      modelID === "gpt-image-2"
        ? Effect.die("gpt-image-2 is intentionally absent from the conversational provider catalog")
        : Effect.succeed(
            {
              id: modelID,
              providerID,
              api: { id: modelID, url: "https://api.openai.com/v1", npm: "@ai-sdk/openai" },
              name: modelID,
              family: "image",
              capabilities: {
                temperature: false,
                reasoning: false,
                attachment: true,
                toolcall: false,
                input: { text: true, audio: false, image: true, video: false, pdf: false },
                output: {
                  text: modelID === "caption-model",
                  audio: false,
                  image: modelID !== "caption-model",
                  video: false,
                  pdf: false,
                },
                interleaved: false,
              },
              cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
              limit: { context: 1, output: 1 },
              status: "active",
              options: {},
              headers: {},
              variants: {},
              release_date: "2026-01-01",
            } as any,
          ),
    getLanguage: () =>
      captionLanguageModel
        ? Effect.succeed(captionLanguageModel)
        : Effect.die("caption language model is not configured by this test"),
    closest: () => Effect.succeed(undefined),
    getSmallModel: () => Effect.succeed(undefined),
    defaultModel: () => Effect.die("default model is not used by image_gen tests"),
  }),
)

const layer = Layer.mergeAll(
  authLayer,
  configLayer,
  providerLayer,
  agentLayer,
  truncateLayer,
  AppFileSystem.defaultLayer,
)
const sessionID = SessionID.make("ses/test")
const messageID = MessageID.make("msg_test")
let imagesRoot = ""

function context(messages: MessageV2.WithParts[] = []): Tool.Context {
  return {
    sessionID,
    messageID,
    callID: "call/test",
    agent: "build",
    abort: AbortSignal.any([]),
    messages,
    extra: { bypassCwdCheck: true },
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

function execute(args: ImageGenArgs, ctx: Tool.Context = context()) {
  return ImageGenTool.pipe(
    Effect.flatMap((info) => info.init()),
    Effect.flatMap((tool) => tool.execute(args, ctx)),
    Effect.provide(layer),
    Effect.runPromise,
  )
}

beforeEach(async () => {
  captionLanguageModel = undefined
  imageGenerationConfig = {
    enabled: true,
    model: "openai/gpt-image-2",
    options: { background: "auto", quality: "auto", size: "auto" },
  }
  imagesRoot = await mkdtemp(path.join(tmpdir(), "mendcode-image-gen-"))
  process.env.MENDCODE_OPENAI_CODEX_GENERATED_IMAGES_DIR = imagesRoot
})

afterEach(async () => {
  delete process.env.MENDCODE_OPENAI_CODEX_GENERATED_IMAGES_DIR
  delete process.env.MENDCODE_OPENAI_CODEX_IMAGES_ENDPOINT
  delete process.env.MENDCODE_OPENAI_CODEX_RESPONSES_ENDPOINT
  await rm(imagesRoot, { recursive: true, force: true })
})

describe("tool.image_gen", () => {
  test("treats a zero recent-image count as generation, persists the PNG, and returns an attachment", async () => {
    let received: { url: string; headers: Headers; body: Record<string, unknown> } | undefined
    using server = Bun.serve({
      port: 0,
      async fetch(request) {
        received = {
          url: request.url,
          headers: new Headers(request.headers),
          body: await request.json(),
        }
        return Response.json({
          created: 1,
          data: [{ b64_json: PNG_BASE64 }],
          quality: "high",
          size: "2048x2048",
        })
      },
    })
    process.env.MENDCODE_OPENAI_CODEX_IMAGES_ENDPOINT = new URL("/backend-api/codex/images", server.url).toString()

    const result = await execute({
      prompt: "Create a polished square product illustration",
      num_last_images_to_include: 0,
    })
    const outputPath = generatedImageArtifactPath(imagesRoot, sessionID, "call/test")

    expect(received?.url).toEndWith("/backend-api/codex/images/generations")
    expect(received?.headers.get("authorization")).toBe("Bearer subscription-access")
    expect(received?.headers.get("chatgpt-account-id")).toBe("account-123")
    expect(received?.headers.get("originator")).toBe("codex_cli_rs")
    expect(received?.headers.get("user-agent")).toContain("codex_cli_rs/0.0.0 (MendCode;")
    expect(received?.headers.get("x-codex-image-turn-id")).toMatch(/^[0-9a-f-]{36}$/)
    expect(received?.body).toEqual({
      prompt: "Create a polished square product illustration",
      background: "auto",
      model: "gpt-image-2",
      quality: "auto",
      size: "auto",
    })
    expect(outputPath).toEndWith(path.join("ses_test", "call_test.png"))
    expect(Buffer.from(await readFile(outputPath))).toEqual(PNG_BYTES)
    expect(result.metadata).toMatchObject({
      operation: "generations",
      model: "gpt-image-2",
      path: outputPath,
      size: "2048x2048",
      quality: "high",
    })
    expect(result.output).toContain(outputPath)
    expect(result.output).not.toContain(PNG_BASE64)
    expect(result.attachments).toEqual([
      {
        type: "file",
        mime: "image/png",
        filename: "call_test.png",
        url: PNG_DATA_URL,
      },
    ])
  })

  test("edits an absolute local image through the Codex images endpoint", async () => {
    const reference = path.join(imagesRoot, "reference.png")
    await writeFile(reference, PNG_BYTES)
    let received: { url: string; body: Record<string, unknown> } | undefined
    using server = Bun.serve({
      port: 0,
      async fetch(request) {
        received = { url: request.url, body: await request.json() }
        return Response.json({ created: 1, data: [{ b64_json: PNG_BASE64 }] })
      },
    })
    process.env.MENDCODE_OPENAI_CODEX_IMAGES_ENDPOINT = new URL("/api/codex/images", server.url).toString()

    const result = await execute({
      prompt: "Add a red hat and keep everything else unchanged",
      referenced_image_paths: [reference],
    })

    expect(received?.url).toEndWith("/api/codex/images/edits")
    expect(received?.body).toMatchObject({
      prompt: "Add a red hat and keep everything else unchanged",
      images: [{ image_url: PNG_DATA_URL }],
      model: "gpt-image-2",
      quality: "auto",
      size: "auto",
      background: "auto",
    })
    expect(result.metadata.operation).toBe("edits")
  })

  test("uses the requested recent conversation image for an edit", async () => {
    let body: Record<string, unknown> | undefined
    using server = Bun.serve({
      port: 0,
      async fetch(request) {
        body = await request.json()
        return Response.json({ created: 1, data: [{ b64_json: PNG_BASE64 }] })
      },
    })
    process.env.MENDCODE_OPENAI_CODEX_IMAGES_ENDPOINT = new URL("/api/codex/images", server.url).toString()
    const messages = [
      {
        parts: [
          {
            type: "tool",
            state: {
              status: "completed",
              attachments: [{ type: "file", mime: "image/png", url: PNG_DATA_URL }],
            },
          },
        ],
      },
    ] as unknown as MessageV2.WithParts[]

    await execute(
      { prompt: "Turn the previous image into an oil painting", num_last_images_to_include: 1 },
      context(messages),
    )

    expect(body).toMatchObject({ images: [{ image_url: PNG_DATA_URL }] })
  })

  test("uses OpenRouter's dedicated Image API with the configured model and references", async () => {
    let received: { url: string; authorization: string | null; body: Record<string, unknown> } | undefined
    using server = Bun.serve({
      port: 0,
      async fetch(request) {
        received = {
          url: request.url,
          authorization: request.headers.get("authorization"),
          body: await request.json(),
        }
        return Response.json({
          data: [{ b64_json: PNG_BASE64, media_type: "image/png" }],
          usage: { cost: 0.04 },
        })
      },
    })
    imageGenerationConfig = {
      enabled: true,
      model: "openrouter/bytedance-seed/seedream-4.5",
      base_url: server.url.toString(),
      options: { resolution: "2K", aspect_ratio: "16:9" },
    }

    const result = await execute(
      { prompt: "Restyle the reference as a watercolor", num_last_images_to_include: 1 },
      context([
        {
          parts: [
            {
              type: "tool",
              state: {
                status: "completed",
                attachments: [{ type: "file", mime: "image/png", url: PNG_DATA_URL }],
              },
            },
          ],
        },
      ] as unknown as MessageV2.WithParts[]),
    )

    expect(received?.url).toEndWith("/api/v1/images")
    expect(received?.authorization).toBe("Bearer openrouter-test-key")
    expect(received?.body).toEqual({
      resolution: "2K",
      aspect_ratio: "16:9",
      model: "bytedance-seed/seedream-4.5",
      prompt: "Restyle the reference as a watercolor",
      n: 1,
      input_references: [{ type: "image_url", image_url: { url: PNG_DATA_URL } }],
    })
    expect(result.metadata).toMatchObject({
      provider: "openrouter",
      model: "bytedance-seed/seedream-4.5",
      adapter: "openrouter",
      cost: 0.04,
    })
  })

  test("downloads and validates a provider-returned image URL", async () => {
    let generatedURL = ""
    using server = Bun.serve({
      port: 0,
      fetch(request) {
        if (request.method === "GET") {
          return new Response(PNG_BYTES, { headers: { "content-type": "image/png" } })
        }
        return Response.json({ data: [{ url: generatedURL }] })
      },
    })
    generatedURL = new URL("/generated.png", server.url).toString()
    imageGenerationConfig = {
      enabled: true,
      model: "openrouter/bytedance-seed/seedream-4.5",
      base_url: server.url.toString(),
    }

    const result = await execute({ prompt: "Create an image" })
    expect(Buffer.from(await readFile(result.metadata.path))).toEqual(PNG_BYTES)
    expect(result.attachments?.[0]?.mime).toBe("image/png")
  })

  test("defaults to gpt-image-2 for an active OpenAI subscription OAuth login", async () => {
    let body: Record<string, unknown> | undefined
    using server = Bun.serve({
      port: 0,
      async fetch(request) {
        body = await request.json()
        return Response.json({ data: [{ b64_json: PNG_BASE64 }] })
      },
    })
    process.env.MENDCODE_OPENAI_CODEX_IMAGES_ENDPOINT = new URL("/api/codex/images", server.url).toString()
    imageGenerationConfig = { enabled: true }

    const result = await execute({ prompt: "Create an image" })

    expect(body?.model).toBe("gpt-image-2")
    expect(result.metadata).toMatchObject({ provider: "openai", model: "gpt-image-2", adapter: "codex-oauth" })
  })

  test("keeps an explicit image generation disable authoritative", async () => {
    imageGenerationConfig = { enabled: false }
    await expect(execute({ prompt: "Create an image" })).rejects.toThrow("image_gen is disabled in config")
  })

  test("keeps the artifact when optional caption configuration is incomplete", async () => {
    using server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ data: [{ b64_json: PNG_BASE64 }] })
      },
    })
    process.env.MENDCODE_OPENAI_CODEX_IMAGES_ENDPOINT = new URL("/api/codex/images", server.url).toString()
    imageGenerationConfig = {
      enabled: true,
      model: "openai/gpt-image-2",
      caption: { enabled: true, required: false },
    }

    const result = await execute({ prompt: "Create an image" })
    expect(result.output).toContain("Visual caption unavailable")
    expect(result.metadata.caption).toEqual({
      status: "error",
      error: "Caption is enabled but image_generation.caption.model is not configured.",
      model: undefined,
    })
    expect(Buffer.from(await readFile(result.metadata.path))).toEqual(PNG_BYTES)
  })

  test("persists a caption from an independently configured vision model", async () => {
    using server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ data: [{ b64_json: PNG_BASE64, media_type: "image/png" }] })
      },
    })
    process.env.MENDCODE_OPENAI_CODEX_IMAGES_ENDPOINT = new URL("/api/codex/images", server.url).toString()
    captionLanguageModel = new MockLanguageModelV3({
      doGenerate: {
        content: [{ type: "text", text: "A small red product box centered on a white background." }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 12, text: 12, reasoning: 0 },
        },
        warnings: [],
      },
    })
    imageGenerationConfig = {
      enabled: true,
      model: "openai/gpt-image-2",
      caption: { enabled: true, model: "vision/caption-model", max_chars: 500 },
    }

    const result = await execute({ prompt: "Create a red product box" })

    expect(result.output).toContain(
      "Visual caption: A small red product box centered on a white background.",
    )
    expect(result.metadata.caption).toEqual({
      status: "completed",
      caption: "A small red product box centered on a white background.",
      model: "vision/caption-model",
    })
    expect(captionLanguageModel.doGenerateCalls).toHaveLength(1)
    expect(JSON.stringify(captionLanguageModel.doGenerateCalls[0]?.prompt)).toContain("image/png")
  })

  test("rejects conflicting edit selectors before making a request", async () => {
    await expect(
      execute({
        prompt: "Edit this",
        referenced_image_paths: [path.join(imagesRoot, "reference.png")],
        num_last_images_to_include: 1,
      }),
    ).rejects.toThrow("Provide only one of referenced_image_paths or num_last_images_to_include")
  })

  test("rejects non-image response data instead of writing a mislabeled artifact", async () => {
    using server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ data: [{ b64_json: Buffer.from("not an image").toString("base64") }] })
      },
    })
    process.env.MENDCODE_OPENAI_CODEX_IMAGES_ENDPOINT = new URL("/api/codex/images", server.url).toString()

    await expect(execute({ prompt: "Create an image" })).rejects.toThrow("not a supported image")
  })

  test("derives image endpoints from a configured Responses endpoint", () => {
    process.env.MENDCODE_OPENAI_CODEX_RESPONSES_ENDPOINT = "https://example.test/backend-api/codex/responses"

    expect(codexImageEndpoint("generations")).toBe("https://example.test/backend-api/codex/images/generations")
    expect(codexImageEndpoint("edits")).toBe("https://example.test/backend-api/codex/images/edits")
  })
})
