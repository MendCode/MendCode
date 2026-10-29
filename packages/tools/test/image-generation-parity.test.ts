import { expect, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { ImageGenerationSettings } from "@mendcode/protocol"
import { createImageGenTool, runTool, type FetchLike } from "../src"
import { codexImagesBase, createImageApi } from "../src/tools/image_api"
import { makeContext, useTempDir } from "./helpers"

const temp = useTempDir()
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])
const image = () => new Response(JSON.stringify({ data: [{ b64_json: PNG.toString("base64"), media_type: "image/png" }] }))
const cfg = (patch: Partial<ImageGenerationSettings> = {}): ImageGenerationSettings => ({ enabled: true, adapter: "codex-oauth", model: "openai/gpt-image-2", ...patch })
function setup(settings = cfg(), fetch: FetchLike = async () => image()) {
  const dir = temp(), cwd = temp()
  const calls: Array<{ url: string; init: RequestInit }> = []
  const tool = createImageGenTool({ env: {}, settings: () => settings, managedDir: path.join(dir, "generated_images"), subscriptionHeaders: async () => ({ authorization: "Bearer test-token", "chatgpt-account-id": "test-account" }), fetch: async (url, init) => { calls.push({ url, init }); return fetch(url, init) } })!
  return { tool, cwd, calls, run: (args: unknown, context = makeContext({ cwd })) => runTool(tool, args, context) }
}

test("new subscription generation is off by default, explicit disable also hides API-key generation", () => {
  expect(createImageGenTool({ env: {}, subscriptionHeaders: async () => ({ authorization: "Bearer fake" }) })).toBeUndefined()
  expect(createImageGenTool({ env: { OPENAI_API_KEY: "test-key" }, settings: () => ({ enabled: false }) })).toBeUndefined()
  expect(createImageGenTool({ env: {}, settings: () => ({ model: "openai/gpt-image-2" }) })).toBeUndefined()
})

test("subscription adapter uses image endpoint and auth, honors options without altering the active model", async () => {
  const h = setup(cfg({ options: { quality: "high", size: "1536x1024" } }))
  const result = await h.run({ prompt: "Green icon" })
  expect(result.isError).toBe(false)
  expect(h.calls[0]?.url).toBe("https://chatgpt.com/backend-api/codex/images/generations")
  expect(h.calls[0]?.init.redirect).toBe("error")
  expect(new Headers(h.calls[0]?.init.headers).get("chatgpt-account-id")).toBe("test-account")
  expect(new Headers(h.calls[0]?.init.headers).get("originator")).toBe("codex_cli_rs")
  expect(new Headers(h.calls[0]?.init.headers).get("origin")).toBe("https://chatgpt.com")
  expect(JSON.parse(String(h.calls[0]?.init.body))).toMatchObject({ model: "gpt-image-2", prompt: "Green icon", size: "1536x1024", quality: "high", n: 1 })
  expect(readFileSync(String(result.meta?.path))).toEqual(PNG)
  expect(result.meta?.path).toContain("generated_images")
  expect(result.meta?.captionStatus).toBe("disabled")
  expect(result.output).not.toContain("test-token")
})

test("explicit path is checked before an authenticated or paid call", async () => {
  const h = setup()
  expect((await h.run({ prompt: "Icon", path: "../outside.png" })).isError).toBe(true)
  expect(h.calls).toHaveLength(0)
  const result = await h.run({ prompt: "Icon", path: "assets/icon.png" })
  expect(result.isError).toBe(false)
  expect(existsSync(path.join(h.cwd, "assets/icon.png"))).toBe(true)
})

test("new-image sentinel sends no references; edit sends local and recent images only when requested", async () => {
  const h = setup()
  writeFileSync(path.join(h.cwd, "ref.png"), PNG)
  expect((await h.run({ prompt: "New", num_last_images_to_include: 0 })).isError).toBe(false)
  expect(JSON.parse(String(h.calls[0]?.init.body)).images).toBeUndefined()
  const edited = await h.run({ prompt: "Change the color", referenced_image_paths: [path.join(h.cwd, "ref.png")] })
  expect(edited.meta?.operation).toBe("edits")
  expect(h.calls[1]?.url).toEndWith("/images/edits")
  expect(JSON.parse(String(h.calls[1]?.init.body)).images[0].image_url).toStartWith("data:image/png;base64,")
  const recent = await h.run({ prompt: "Change it", num_last_images_to_include: 1 }, { ...makeContext({ cwd: h.cwd }), recentImages: async () => [{ mime: "image/png", bytes: PNG }] })
  expect(recent.isError).toBe(false)
})

test("missing, relative, conflicting and excessive references fail before a provider call", async () => {
  const h = setup()
  for (const args of [
    { prompt: "Edit", num_last_images_to_include: 1 },
    { prompt: "Edit", referenced_image_paths: ["/outside/ref.png"] },
    { prompt: "Edit", referenced_image_paths: ["ref.png"] },
    { prompt: "Edit", referenced_image_paths: ["/outside/ref.png"], num_last_images_to_include: 1 },
    { prompt: "Edit", num_last_images_to_include: 6 },
  ]) expect((await h.run(args)).isError).toBe(true)
  expect(h.calls).toHaveLength(0)
})

test("caption is opt-in, bounded and persisted; optional and required failures preserve saved files", async () => {
  const cwd = temp()
  let settings = cfg({ caption: { enabled: true, model: "chatgpt/vision", max_chars: 8 } })
  let fail = false
  const seen: string[] = []
  const tool = createImageGenTool({ env: {}, settings: () => settings, fetch: async () => image(), subscriptionHeaders: async () => ({ authorization: "Bearer test-token" }), caption: async ({ model }) => { seen.push(model); if (fail) throw new Error("secret-provider-body"); return "Green square icon" } })!
  const result = await runTool(tool, { prompt: "Icon" }, makeContext({ cwd }))
  expect(result.output).toContain("Visual caption: Green sq")
  expect(result.meta).toMatchObject({ captionStatus: "completed", captionModel: "chatgpt/vision", caption: "Green sq" })
  fail = true
  const optional = await runTool(tool, { prompt: "Optional" }, makeContext({ cwd }))
  expect(optional.isError).toBe(false)
  expect(optional.output).toContain("caption unavailable")
  expect(optional.output).not.toContain("secret-provider-body")
  settings = cfg({ caption: { enabled: true, model: "chatgpt/vision", required: true } })
  const required = await runTool(tool, { prompt: "Required" }, makeContext({ cwd }))
  expect(required.isError).toBe(true)
  expect(existsSync(String(required.meta?.path))).toBe(true)
  expect(required.output).toContain("required caption generation failed")
  settings = cfg({ caption: { enabled: false, model: "chatgpt/vision" } })
  await runTool(tool, { prompt: "No caption" }, makeContext({ cwd }))
  expect(seen).toHaveLength(3)
})

test("legacy API-key providers retain their endpoint, precedence and workspace output", async () => {
  for (const env of [{ OPENAI_API_KEY: "test-key" }, { OPENAI_API_KEY: "test-key", OPENROUTER_API_KEY: "router-key" }]) {
    const cwd = temp(), urls: string[] = []
    const tool = createImageGenTool({ env, fetch: async (url) => { urls.push(url); return env.OPENROUTER_API_KEY ? new Response(JSON.stringify({ choices: [{ message: { images: [{ image_url: { url: `data:image/png;base64,${PNG.toString("base64")}` } }] } }] })) : image() } })!
    const result = await runTool(tool, { prompt: "Logo" }, makeContext({ cwd }))
    expect(result.isError).toBe(false)
    expect(result.meta?.provider).toBe(env.OPENROUTER_API_KEY ? "openrouter" : "openai")
    expect(urls[0]).toContain(env.OPENROUTER_API_KEY ? "chat/completions" : "images/generations")
    expect(existsSync(path.join(cwd, "generated/logo-1.png"))).toBe(true)
  }
})

test("configured OpenRouter and compatible API adapters select the independent image model", async () => {
  for (const [adapter, model, base, endpoint] of [["openrouter", "openrouter/vendor/image", "https://openrouter.ai/api/v1", "/api/v1/images"], ["openai-compatible", "local:image", "http://127.0.0.1:8080/v1", "/v1/images/generations"]] as const) {
    const calls: string[] = []
    const tool = createImageGenTool({ env: {}, settings: () => cfg({ adapter, model }), credentials: () => ({ baseUrl: base, headers: { authorization: "Bearer fake-key" } }), fetch: async (url) => { calls.push(url); return image() } })!
    expect((await runTool(tool, { prompt: "Icon" }, makeContext({ cwd: temp() }))).isError).toBe(false)
    expect(calls[0]).toEndWith(endpoint)
  }
})

test("compatible edits use multipart references; unsafe subscription endpoints never get a token", async () => {
  let authCalls = 0
  const api = createImageApi({ settings: cfg({ base_url: "https://example.test/images" }), subscriptionHeaders: async () => { authCalls++; return {} }, fetch: async () => image() })
  expect((await api({ prompt: "Icon", count: 1, size: "1024x1024", references: [], signal: new AbortController().signal })).ok).toBe(false)
  expect(authCalls).toBe(0)
  expect(codexImagesBase("http://127.0.0.1:8080/codex/responses")).toBe("http://127.0.0.1:8080/codex/images")
  let form: FormData | undefined
  const local = createImageApi({ settings: cfg({ adapter: "openai-compatible", model: "local:image" }), credentials: () => ({ baseUrl: "http://localhost:8080/v1", headers: { authorization: "Bearer fake" } }), fetch: async (_, init) => { form = init.body as FormData; return image() } })
  expect((await local({ prompt: "Edit", size: "1024x1024", count: 1, references: [{ mime: "image/png", bytes: PNG }], signal: new AbortController().signal })).ok).toBe(true)
  expect(form?.getAll("image[]")).toHaveLength(1)
  expect(form?.get("model")).toBe("image")
})

test("downloaded outputs are bounded and fetched without credentials; malformed bytes are refused", async () => {
  const headers: Headers[] = []
  const h = setup(cfg(), async (url, init) => { headers.push(new Headers(init.headers)); return url.endsWith("/generations") ? new Response(JSON.stringify({ data: [{ url: "https://images.example.test/image.png" }] })) : new Response(PNG) })
  expect((await h.run({ prompt: "Icon" })).isError).toBe(false)
  expect(headers[1]?.get("authorization")).toBeNull()
  const invalid = setup(cfg(), async () => new Response(JSON.stringify({ data: [{ b64_json: "<invalid>" }] })))
  expect((await invalid.run({ prompt: "Icon" })).isError).toBe(true)
  const oversized = setup(cfg(), async (url) => url.endsWith("/generations") ? new Response(JSON.stringify({ data: [{ url: "http://localhost:8080/image" }] })) : new Response(PNG, { headers: { "content-length": String(51 * 1024 * 1024) } }))
  expect((await oversized.run({ prompt: "Icon" })).output).toContain("50 MB")
})

test("long echoed tokens are redacted before error truncation; cancellation starts no request", async () => {
  const token = "subscription-token-" + "x".repeat(400)
  const tool = createImageGenTool({ env: {}, settings: () => cfg(), subscriptionHeaders: async () => ({ authorization: `Bearer ${token}` }), fetch: async () => new Response(`invalid ${token}`, { status: 401 }) })!
  const result = await runTool(tool, { prompt: "Icon" }, makeContext({ cwd: temp() }))
  expect(result.output).not.toContain("subscription-token")
  expect(result.output).toContain("HTTP 401")
  const h = setup(), abort = new AbortController()
  abort.abort()
  expect((await h.run({ prompt: "Icon" }, makeContext({ cwd: h.cwd, signal: abort.signal }))).output).toBe("cancelled")
  expect(h.calls).toHaveLength(0)
})
