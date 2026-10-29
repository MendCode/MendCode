import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createImageGenTool, runTool, selectImageProvider, type FetchLike } from "../src"
import { makeContext, useTempDir } from "./helpers"

const temp = useTempDir()

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fake-png-body")])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])

type Seen = { url: string; headers: Record<string, string>; body: any }
function fakeFetch(reply: (seen: Seen, index: number) => Response): { fetch: FetchLike; calls: Seen[] } {
  const calls: Seen[] = []
  const fetch: FetchLike = async (url, init) => {
    const headers: Record<string, string> = {}
    new Headers(init.headers).forEach((value, key) => (headers[key] = value))
    const seen: Seen = { url, headers, body: JSON.parse(String(init.body)) }
    calls.push(seen)
    return reply(seen, calls.length - 1)
  }
  return { fetch, calls }
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
const openAiReply = (bytes: Buffer, n = 1) => json({ data: Array.from({ length: n }, () => ({ b64_json: bytes.toString("base64") })) })
const openRouterReply = (bytes: Buffer, mime = "image/png") => json({ choices: [{ message: { images: [{ type: "image_url", image_url: { url: `data:${mime};base64,${bytes.toString("base64")}` } }] } }] })

describe("image_gen registration", () => {
  test("not created without a key; OpenRouter wins over OpenAI", () => {
    expect(createImageGenTool({ env: {} })).toBeUndefined()
    expect(selectImageProvider({ OPENAI_API_KEY: "a" })).toBe("openai")
    expect(selectImageProvider({ OPENAI_API_KEY: "a", OPENROUTER_API_KEY: "b" })).toBe("openrouter")
    expect(createImageGenTool({ env: { OPENAI_API_KEY: "a" } })?.permission).toBe("write")
  })
})

describe("image_gen with OpenAI", () => {
  test("saves to generated/<slug>-<n>.png, returns the image and the path", async () => {
    const cwd = temp()
    const { fetch, calls } = fakeFetch(() => openAiReply(PNG))
    const tool = createImageGenTool({ env: { OPENAI_API_KEY: "oa-secret" }, fetch })!
    const live: string[] = []
    const result = await runTool(tool, { prompt: "A red Fox, in snow!" }, makeContext({ cwd, onOutput: (chunk) => live.push(chunk) }))
    expect(result.isError).toBe(false)
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/images/generations")
    expect(calls[0]?.headers.authorization).toBe("Bearer oa-secret")
    expect(calls[0]?.body).toMatchObject({ model: "gpt-image-2", size: "1024x1024", n: 1 })
    // Before the request, the terminal's wait canvas is told what is being made; the key never appears.
    expect(live.join("")).toBe("model openai/gpt-image-2\nsize 1024x1024\n")
    expect(calls[0]?.body.response_format).toBeUndefined()
    expect(readFileSync(join(cwd, "generated/a-red-fox-in-snow-1.png")).equals(PNG)).toBe(true)
    expect(result.output).toContain("generated/a-red-fox-in-snow-1.png")
    expect(result.images).toHaveLength(1)
    expect(result.images?.[0]?.mime).toBe("image/png")
    expect(result.meta?.paths).toBe("generated/a-red-fox-in-snow-1.png")
  })

  test("n=2 makes two files and never overwrites an existing default name", async () => {
    const cwd = temp()
    mkdirSync(join(cwd, "generated"))
    writeFileSync(join(cwd, "generated/logo-1.png"), "old")
    const { fetch, calls } = fakeFetch(() => openAiReply(PNG, 2))
    const tool = createImageGenTool({ env: { OPENAI_API_KEY: "kkkk" }, fetch })!
    const result = await runTool(tool, { prompt: "logo", n: 2, size: "1536x1024" }, makeContext({ cwd }))
    expect(calls[0]?.body).toMatchObject({ n: 2, size: "1536x1024" })
    expect(readFileSync(join(cwd, "generated/logo-1.png"), "utf8")).toBe("old")
    expect(existsSync(join(cwd, "generated/logo-2.png"))).toBe(true)
    expect(existsSync(join(cwd, "generated/logo-3.png"))).toBe(true)
    expect(result.images).toHaveLength(2)
  })

  test("n above 2 is rejected", async () => {
    const tool = createImageGenTool({ env: { OPENAI_API_KEY: "kkkk" }, fetch: fakeFetch(() => openAiReply(PNG)).fetch })!
    expect((await runTool(tool, { prompt: "x", n: 3 }, makeContext({ cwd: temp() }))).isError).toBe(true)
  })

  test("an explicit path inside the project is used, with -1/-2 for two images", async () => {
    const cwd = temp()
    const tool = createImageGenTool({ env: { OPENAI_API_KEY: "kkkk" }, fetch: fakeFetch(() => openAiReply(PNG, 2)).fetch })!
    const result = await runTool(tool, { prompt: "icon", n: 2, path: "assets/icons/app.png" }, makeContext({ cwd }))
    expect(result.isError).toBe(false)
    expect(existsSync(join(cwd, "assets/icons/app-1.png"))).toBe(true)
    expect(existsSync(join(cwd, "assets/icons/app-2.png"))).toBe(true)
  })

  test("refuses paths outside the project before calling the provider", async () => {
    const cwd = temp()
    const outside = temp()
    const { fetch, calls } = fakeFetch(() => openAiReply(PNG))
    const tool = createImageGenTool({ env: { OPENAI_API_KEY: "kkkk" }, fetch })!
    for (const path of ["../escape.png", join(outside, "abs.png"), "a/../../up.png"]) {
      const result = await runTool(tool, { prompt: "x", path }, makeContext({ cwd }))
      expect(result.isError).toBe(true)
      expect(result.output).toContain("only saves inside the project")
    }
    expect(calls).toHaveLength(0)
    expect(existsSync(join(outside, "abs.png"))).toBe(false)
  })

  test("refuses a path that leaves the project through a symlink", async () => {
    const cwd = temp()
    const outside = temp()
    symlinkSync(outside, join(cwd, "link"))
    const tool = createImageGenTool({ env: { OPENAI_API_KEY: "kkkk" }, fetch: fakeFetch(() => openAiReply(PNG)).fetch })!
    const result = await runTool(tool, { prompt: "x", path: "link/out.png" }, makeContext({ cwd }))
    expect(result.isError).toBe(true)
    expect(existsSync(join(outside, "out.png"))).toBe(false)
  })

  test("dall-e models ask for b64_json; dall-e-3 makes one request per image", async () => {
    const cwd = temp()
    const { fetch, calls } = fakeFetch(() => openAiReply(PNG))
    const tool = createImageGenTool({ env: { OPENAI_API_KEY: "kkkk", OPENAI_IMAGE_MODEL: "dall-e-3" }, fetch })!
    const result = await runTool(tool, { prompt: "x", n: 2 }, makeContext({ cwd }))
    expect(calls).toHaveLength(2)
    expect(calls[0]?.body).toMatchObject({ model: "dall-e-3", n: 1, response_format: "b64_json" })
    expect(result.images).toHaveLength(2)
  })

  test("errors never include the key and nothing is written", async () => {
    const cwd = temp()
    const { fetch } = fakeFetch(() => new Response("bad key oa-secret-77", { status: 401 }))
    const tool = createImageGenTool({ env: { OPENAI_API_KEY: "oa-secret-77" }, fetch })!
    const result = await runTool(tool, { prompt: "x" }, makeContext({ cwd }))
    expect(result.isError).toBe(true)
    expect(result.output).toContain("HTTP 401")
    expect(result.output).not.toContain("oa-secret-77")
    expect(existsSync(join(cwd, "generated"))).toBe(false)
  })

  test("data that is not an image is refused, not saved", async () => {
    const cwd = temp()
    const tool = createImageGenTool({ env: { OPENAI_API_KEY: "kkkk" }, fetch: fakeFetch(() => openAiReply(Buffer.from("<html>"))).fetch })!
    const result = await runTool(tool, { prompt: "x" }, makeContext({ cwd }))
    expect(result.isError).toBe(true)
    expect(existsSync(join(cwd, "generated"))).toBe(false)
  })
})

describe("image_gen with OpenRouter", () => {
  test("uses chat completions with image modalities and the size's aspect ratio; one call per image", async () => {
    const cwd = temp()
    const { fetch, calls } = fakeFetch(() => openRouterReply(PNG))
    const tool = createImageGenTool({ env: { OPENROUTER_API_KEY: "or-secret", OPENAI_API_KEY: "ignored", OPENROUTER_IMAGE_MODEL: "vendor/img" }, fetch })!
    const result = await runTool(tool, { prompt: "a map", n: 2, size: "1024x1536" }, makeContext({ cwd }))
    expect(result.isError).toBe(false)
    expect(calls).toHaveLength(2)
    expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/chat/completions")
    expect(calls[0]?.headers.authorization).toBe("Bearer or-secret")
    expect(calls[0]?.body).toMatchObject({ model: "vendor/img", modalities: ["image", "text"], image_config: { aspect_ratio: "2:3" } })
    expect(existsSync(join(cwd, "generated/a-map-1.png"))).toBe(true)
    expect(existsSync(join(cwd, "generated/a-map-2.png"))).toBe(true)
  })

  test("a JPEG answer is saved with a .jpg extension and returned as image/jpeg", async () => {
    const cwd = temp()
    const tool = createImageGenTool({ env: { OPENROUTER_API_KEY: "kkkk" }, fetch: fakeFetch(() => openRouterReply(JPEG, "image/jpeg")).fetch })!
    const result = await runTool(tool, { prompt: "photo", path: "p.png" }, makeContext({ cwd }))
    expect(existsSync(join(cwd, "p.jpg"))).toBe(true)
    expect(result.images?.[0]?.mime).toBe("image/jpeg")
  })

  test("a model that returns no image explains how to choose another", async () => {
    const tool = createImageGenTool({ env: { OPENROUTER_API_KEY: "kkkk" }, fetch: fakeFetch(() => json({ choices: [{ message: { content: "text only" } }] })).fetch })!
    const result = await runTool(tool, { prompt: "x" }, makeContext({ cwd: temp() }))
    expect(result.isError).toBe(true)
    expect(result.output).toContain("OPENROUTER_IMAGE_MODEL")
  })
})
