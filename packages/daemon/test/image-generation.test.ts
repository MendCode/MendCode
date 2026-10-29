import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { codexSubscriptionHeaders, createNativeEngine, memoryHistory, type ModelMessage, type ModelProvider, type ModelRequest } from "@mendcode/engine-native"
import type { EngineEvent, TurnInput } from "@mendcode/kernel"
import { Settings, type SessionId } from "@mendcode/protocol"
import { runTool } from "@mendcode/tools"
import { startDaemon } from "../src"
import { createDaemonImageGenTool } from "../src/image-generation"
import { createProviderService } from "../src/providers"
import { until } from "./native-harness"

const cleanups: Array<() => unknown> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])
function temp() {
  const dir = mkdtempSync(path.join(tmpdir(), "mendcode-image-parity-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
async function boot() {
  const dir = temp(), project = temp(), requests: ModelRequest[] = [], imageCalls: Array<Record<string, unknown>> = []
  let editing = false
  let referenced: string | undefined
  const provider: ModelProvider = { id: "chatgpt", model: "main", async *stream(request) {
    requests.push({ ...request, messages: structuredClone(request.messages) })
    if (request.model === "vision") { yield { type: "text", delta: "A green square with white text." }; yield { type: "finish", reason: "stop" }; return }
    if (!request.messages.some((message) => message.role === "tool")) {
      const available = request.tools.some((tool) => tool.name === "image_gen")
      if (available) { yield { type: "tool_call", call: { callId: "image-call", name: "image_gen", args: { prompt: "Green square", ...(referenced ? { referenced_image_paths: [referenced] } : editing ? { num_last_images_to_include: 1 } : {}) } } }; yield { type: "finish", reason: "tool_calls" }; return }
    }
    yield { type: "text", delta: "Done" }; yield { type: "finish", reason: "stop" }
  } }
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), log: () => {}, info: { engine: "native" }, engine: ({ store }) => createNativeEngine({
    provider, tools: [], system: () => "BASE", compactionPrompt: "SUMMARIZE", cwdFor: () => project,
    permissionPolicy: () => store.settings.get(),
    history: { load: async (id) => store.engineMessages.load(id, "native") as ModelMessage[], save: async (id, messages) => store.engineMessages.save(id, "native", messages), replace: async (id, messages) => store.engineMessages.replace(id, "native", messages) },
    readBlob: async (ref) => new Uint8Array(await Bun.file(store.blobPath(ref.sha256)).arrayBuffer()),
    storeBlob: async (bytes, mime, id) => { const ref = store.putBlob(bytes, mime); store.refBlob(ref, id); return ref },
    projectTools: async () => {
      const tool = createDaemonImageGenTool({ dir, settings: () => store.settings.get(), env: {}, provider, subscriptionHeaders: async () => ({ authorization: "Bearer fake-subscription" }), fetch: async (_, init) => { imageCalls.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] })) } })
      return tool ? [tool] : []
    },
  }) })
  cleanups.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "image-parity" })
  await client.connect()
  cleanups.push(() => client.close())
  async function say() {
    const created = await client.send({ type: "session.create", directory: project })
    const sessionId = (created.ok ? created.result?.sessionId : undefined) as SessionId
    await client.send({ type: "session.permission.set", sessionId, mode: "full" })
    await client.send({ type: "user.submit", sessionId, text: "Create a green square", attachments: editing ? [daemon.store.putBlob(PNG, "image/png")] : [] })
    await until(() => daemon.store.turns.list(sessionId).some((turn) => turn.status !== "running"), 2000)
    return sessionId
  }
  return { dir, project, daemon, client, requests, imageCalls, say, edit: () => { editing = true }, reference: (file: string) => { referenced = file } }
}

test("protocol validates the complete independent config, rejects secrets and unsafe URLs", () => {
  expect(Settings.parse({ image_generation: { enabled: true, model: "openai/gpt-image-2", adapter: "codex-oauth", timeout_ms: 600000, options: { quality: "high" }, caption: { enabled: true, model: "chatgpt:vision", required: true, prompt: "Describe visible text", max_chars: 10000 } } }).image_generation?.model).toBe("openai/gpt-image-2")
  for (const image_generation of [{ adapter: "unknown" }, { model: "missing-provider" }, { base_url: "http://external.test/images" }, { base_url: "https://secret@example.test/images" }, { options: { authorization: "secret" } }, { caption: { max_chars: 10001 } }, { timeout_ms: 0 }]) expect(Settings.safeParse({ image_generation }).success).toBe(false)
})

test("typed client config persists, applies next turn and independent caption reaches the persisted transcript", async () => {
  const h = await boot()
  expect(await h.client.imageGeneration()).toEqual({ ok: true, settings: undefined })
  await h.say()
  expect(h.requests[0]?.tools.some((tool) => tool.name === "image_gen")).toBe(false)
  expect(h.imageCalls).toEqual([])
  expect(await h.client.imageGeneration({ enabled: true, adapter: "codex-oauth", model: "openai:gpt-image-2", caption: { enabled: true, model: "chatgpt:vision", max_chars: 18 } })).toMatchObject({ ok: true })
  const sessionId = await h.say()
  expect(h.imageCalls[0]?.model).toBe("gpt-image-2")
  const caption = h.requests.find((request) => request.model === "vision")!
  expect(caption.tools).toEqual([])
  expect(caption.messages[0]).toMatchObject({ role: "user", images: [{ mime: "image/png" }] })
  const events = h.daemon.store.readAfter(sessionId, 0)
  const completed = events.find((event) => event.type === "item.completed" && event.meta?.captionStatus === "completed")
  expect(completed).toMatchObject({ text: expect.stringContaining("Visual caption: A green square wit"), meta: { captionModel: "chatgpt:vision", caption: "A green square wit" } })
  expect(JSON.stringify(events)).not.toContain("fake-subscription")
  const reader = new Database(path.join(h.dir, "mendd.db"), { readonly: true })
  const saved = reader.query<{ payload: string }, []>("SELECT payload FROM settings WHERE id = 1").get()
  reader.close()
  expect(JSON.parse(saved!.payload).image_generation.caption.model).toBe("chatgpt:vision")
  await h.client.imageGeneration({ enabled: false })
  const at = h.requests.length
  await h.say()
  expect(h.requests[at]?.tools.some((tool) => tool.name === "image_gen")).toBe(false)
  expect(await h.client.imageGeneration(null)).toEqual({ ok: true, settings: undefined })
}, 10000)

test("native edits resolve the current user attachment through session blob storage", async () => {
  const h = await boot()
  await h.client.imageGeneration({ enabled: true, adapter: "codex-oauth" })
  h.edit()
  await h.say()
  expect(h.imageCalls[0]?.images).toEqual([{ image_url: `data:image/png;base64,${PNG.toString("base64")}` }])
}, 10000)

test("external reference reads obey explicit deny rules even in full mode, then use the permitted file", async () => {
  const h = await boot(), external = path.join(temp(), "ref.png")
  writeFileSync(external, PNG)
  await h.client.imageGeneration({ enabled: true, adapter: "codex-oauth" })
  await h.client.send({ type: "settings.set", patch: { permission: { read: { [external]: "deny" } } } })
  h.reference(external)
  await h.say()
  expect(h.imageCalls).toHaveLength(0)
  await h.client.send({ type: "settings.set", patch: { permission: { read: { [external]: "allow" }, external_directory: "allow" } } })
  await h.say()
  expect(h.imageCalls[0]?.images).toEqual([{ image_url: `data:image/png;base64,${PNG.toString("base64")}` }])
}, 10000)

test("caption capability and model policy failures preserve artifacts and do not call the caption provider", async () => {
  const dir = temp(), cwd = temp()
  let calls = 0
  const provider: ModelProvider = { id: "fake", model: "main", async *stream() { calls++; yield { type: "text", delta: "unexpected" } } }
  const tool = createDaemonImageGenTool({ dir, env: {}, provider, settings: () => ({ image_generation: { enabled: true, adapter: "codex-oauth", caption: { enabled: true, model: "chatgpt:text-only", required: true } } }), models: () => [{ id: "text-only", name: "Text", efforts: [], modalities: { input: ["text"], output: ["text"] } }], subscriptionHeaders: async () => ({ authorization: "Bearer fake" }), fetch: async () => new Response(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] })) })!
  const result = await runTool(tool, { prompt: "Icon" }, { cwd, signal: new AbortController().signal })
  expect(result.isError).toBe(true)
  expect(existsSync(String(result.meta?.path))).toBe(true)
  expect(calls).toBe(0)
})

test("image transport respects saved provider credentials, disabled providers and keeps reports credential-free", () => {
  const service = createProviderService({ dir: temp(), env: {} })
  expect(service.set({ id: "local", providerType: "openai-compatible", baseUrl: "http://127.0.0.1:8080/v1", apiKey: "fake-image-key" }).ok).toBe(true)
  expect(service.imageTransport?.("local")).toMatchObject({ headers: { authorization: "Bearer fake-image-key" } })
  expect(JSON.stringify(service.list())).not.toContain("fake-image-key")
  service.set({ id: "local", enabled: false })
  expect(service.imageTransport?.("local")).toBeUndefined()
})

test("unconfigured image generation is implicit only where asked: enabled false and an environment key keep their own behaviour", async () => {
  const provider: ModelProvider = { id: "fake", model: "main", async *stream() {} }
  const urls: string[] = []
  const fetch = async (url: string | URL | Request) => { urls.push(String(url)); return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] })) }
  const make = (input: { image_generation?: Settings["image_generation"]; env?: Record<string, string>; implicit?: boolean }) => createDaemonImageGenTool({ dir: temp(), env: input.env ?? {}, provider, settings: () => ({ ...(input.image_generation ? { image_generation: input.image_generation } : {}) }), subscriptionHeaders: async () => ({ authorization: "Bearer fake-subscription" }), fetch, ...(input.implicit !== undefined ? { implicit: () => input.implicit! } : {}) })
  expect(make({})).toBeUndefined()
  expect(make({ implicit: false })).toBeUndefined()
  expect(make({ image_generation: { enabled: false }, implicit: true })).toBeUndefined()
  const implicit = make({ implicit: true })!
  expect((await runTool(implicit, { prompt: "Icon" }, { cwd: temp(), signal: new AbortController().signal })).isError).toBe(false)
  expect(urls.at(-1)).toBe("https://chatgpt.com/backend-api/codex/images/generations")
  const keyed = make({ env: { OPENAI_API_KEY: "fake-key" }, implicit: true })!
  const cwd = temp()
  const result = await runTool(keyed, { prompt: "Icon" }, { cwd, signal: new AbortController().signal })
  expect(urls.at(-1)).toBe("https://api.openai.com/v1/images/generations")
  expect(String(result.meta?.path).startsWith(path.join(cwd, "generated"))).toBe(true)
})

test("a Claude Code session gets image_gen through the host tools on a ChatGPT login; the call lands the image and the transcript items of a native one", async () => {
  const dir = temp(), project = temp(), imageCalls: Array<{ url: string; auth: string; body: Record<string, unknown> }> = []
  const provider: ModelProvider = { id: "chatgpt", model: "main", async *stream() {} }
  const blobs = new Map<string, Uint8Array>([["ref-sha", new Uint8Array(PNG)]])
  const engine = createNativeEngine({
    provider, history: memoryHistory(), tools: [], system: () => "BASE", compactionPrompt: "SUMMARIZE", cwdFor: () => project, permissionPolicy: () => ({ tier: "balanced" }),
    readBlob: async (ref) => blobs.get(ref.sha256)!,
    storeBlob: async (bytes, mime) => {
      const sha256 = createHash("sha256").update(bytes).digest("hex")
      blobs.set(sha256, bytes)
      return { sha256, mime, bytes: bytes.byteLength } as never
    },
    projectTools: async (_root, _sessionId, scope) => {
      const tool = createDaemonImageGenTool({ dir, settings: () => ({}), env: {}, provider, implicit: () => scope?.host === true, subscriptionHeaders: async () => ({ authorization: "Bearer fake-subscription" }), fetch: async (url, init) => {
        imageCalls.push({ url: String(url), auth: String((init?.headers as Record<string, string>).authorization), body: JSON.parse(String(init?.body)) })
        return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] }))
      } })
      return tool ? [tool] : []
    },
  })
  const sessionId = "ses_claude_image" as SessionId
  expect((await engine.hostTools!({ directory: project, sessionId })).map((tool) => tool.name)).toEqual(["image_gen"])
  // A native request has the provider's hosted image tool instead: no second one.
  expect((await engine.catalogTools!({ directory: project })).some((tool) => tool.id === "image_gen")).toBe(false)
  const events: EngineEvent[] = []
  const turn: TurnInput = {
    permissionMode: () => "full", setPermissionMode: () => {}, sessionId, turnId: "turn_image" as TurnInput["turnId"], text: "Make this icon blue",
    attachments: [{ sha256: "ref-sha", mime: "image/png", bytes: PNG.length }] as TurnInput["attachments"],
    signal: new AbortController().signal, newItemId: (() => { let n = 0; return () => `item_${++n}` as ReturnType<TurnInput["newItemId"]> })(), emit: (event) => void events.push(event), ask: async () => ({ kind: "deny" }),
  }
  const result = await engine.hostCall!({ turn, name: "image_gen", args: { prompt: "A blue square icon", size: "1536x1024" } })
  expect(result.isError).toBe(false)
  expect(result.images?.[0]?.mime).toBe("image/png")
  expect(result.output).toContain(path.join(dir, "generated_images"))
  expect(imageCalls[0]).toMatchObject({ url: "https://chatgpt.com/backend-api/codex/images/generations", auth: "Bearer fake-subscription", body: { model: "gpt-image-2", size: "1536x1024", n: 1 } })
  const started = events.find((event) => event.type === "item.started") as Extract<EngineEvent, { type: "item.started" }>
  expect(started).toMatchObject({ kind: "tool_call", meta: { tool: "image_gen: A blue square icon" } })
  expect(events.some((event) => event.type === "item.delta" && event.text.includes("model openai/gpt-image-2\nsize 1536x1024"))).toBe(true)
  // The card carries the picture, as the hosted tool's does: the terminal draws it in the card instead of only its path.
  const completed = events.find((event) => event.type === "item.completed") as Extract<EngineEvent, { type: "item.completed" }>
  expect(completed).toMatchObject({ status: "ok", meta: { model: "gpt-image-2", operation: "generations" }, attachments: [{ mime: "image/png", sha256: createHash("sha256").update(PNG).digest("hex") }] })
  // The turn's own attachment is the recent image an edit takes.
  const edited = await engine.hostCall!({ turn, name: "image_gen", args: { prompt: "Make it blue", num_last_images_to_include: 1 } })
  expect(edited.isError).toBe(false)
  expect(imageCalls[1]).toMatchObject({ url: "https://chatgpt.com/backend-api/codex/images/edits", body: { images: [{ image_url: `data:image/png;base64,${PNG.toString("base64")}` }] } })
})

test("subscription auth is reread without rewriting or rotating Codex tokens", async () => {
  const dir = temp(), authFile = path.join(dir, "auth.json")
  const first = JSON.stringify({ tokens: { access_token: "fake-token-one", account_id: "acct" } })
  writeFileSync(authFile, first)
  const headers = codexSubscriptionHeaders({ authFile })
  expect((await headers()).authorization).toBe("Bearer fake-token-one")
  expect(readFileSync(authFile, "utf8")).toBe(first)
  writeFileSync(authFile, JSON.stringify({ tokens: { access_token: "fake-token-two", account_id: "acct" } }))
  expect((await headers()).authorization).toBe("Bearer fake-token-two")
})
