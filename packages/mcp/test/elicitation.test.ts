import { afterEach, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createMcpClient, createMcpManager, discoverMcpTools, elicitationContent, elicitationQuestions, parseElicitation, respondToElicitation, userElicitation, type ElicitHandler, type McpClient } from "../src"
import { tempDir } from "./helpers"

const cleanups: Array<() => unknown> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

const FIXTURE = join(import.meta.dir, "fixtures/fake-elicit.ts")
const profile = {
  type: "object",
  properties: {
    name: { type: "string", title: "Name", minLength: 2 },
    age: { type: "integer", title: "Age", minimum: 18 },
    subscribe: { type: "boolean", title: "Subscribe" },
    color: { type: "string", title: "Color", oneOf: [{ const: "r", title: "Red" }, { const: "g", title: "Green" }] },
    tags: { type: "array", title: "Tags", items: { type: "string", enum: ["a", "b", "c"] } },
  },
  required: ["name", "age"],
}

function local(extra: { elicitation?: boolean; timeoutMs?: number; log?: string } = {}) {
  const client = createMcpClient({ name: "elicit", config: { command: process.execPath, args: [FIXTURE], ...(extra.log ? { env: { ELICIT_LOG: extra.log } } : {}), ...(extra.elicitation !== undefined ? { elicitation: extra.elicitation } : {}), ...(extra.timeoutMs ? { timeoutMs: extra.timeoutMs } : {}) } })
  cleanups.push(() => client.close())
  return client
}

const answered = (answers: Record<string, string[]>): ElicitHandler => async () => ({ action: "accept", answers })
const reply = async (client: McpClient, schema: string, handler?: ElicitHandler) => JSON.parse((await client.callTool("ask", { schema }, undefined, handler)).text)

test("parseElicitation reads a flat form and refuses what it cannot ask", () => {
  const parsed = parseElicitation({ message: "Hi", requestedSchema: profile })
  expect(parsed.ok && parsed.fields.map((field) => [field.key, field.type, field.required])).toEqual([["name", "string", true], ["age", "integer", true], ["subscribe", "boolean", false], ["color", "choice", false], ["tags", "multi", false]])
  expect(parseElicitation({ message: "Hi", requestedSchema: { type: "object", properties: { n: { type: "string", enum: ["x"], enumNames: ["Ex"] } } } })).toMatchObject({ ok: true, fields: [{ choices: [{ value: "x", title: "Ex" }] }] })
  expect(parseElicitation({ message: "Hi" })).toEqual({ ok: true, message: "Hi", fields: [] })
  expect(parseElicitation({ mode: "url", message: "Go", url: "https://example.com" })).toMatchObject({ ok: false, reason: "unsupported" })
  expect(parseElicitation({ message: "Hi", requestedSchema: { type: "object", properties: { x: { type: "object" } } } })).toMatchObject({ ok: false, reason: "unsupported" })
  expect(parseElicitation({ message: "Hi", requestedSchema: { type: "object", properties: { apiKey: { type: "string" } } } })).toMatchObject({ ok: false, reason: "sensitive" })
  expect(parseElicitation({ message: "Hi", requestedSchema: { type: "object", properties: { x: { type: "string", title: "Your password" } } } })).toMatchObject({ ok: false, reason: "sensitive" })
  expect(parseElicitation({ requestedSchema: profile })).toMatchObject({ ok: false, reason: "invalid" })
  const many = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`f${index}`, { type: "string" }]))
  expect(parseElicitation({ message: "Hi", requestedSchema: { type: "object", properties: many } })).toMatchObject({ ok: false, reason: "unsupported" })
})

test("elicitationContent types and checks every answer, and leaves optional empties out", () => {
  const parsed = parseElicitation({ message: "Hi", requestedSchema: profile })
  const fields = parsed.ok ? parsed.fields : []
  expect(elicitationContent({ fields, answers: { name: ["Ada"], age: ["36"], subscribe: ["Yes"], color: ["Green"], tags: ["a", "c"] } })).toEqual({ ok: true, content: { name: "Ada", age: 36, subscribe: true, color: "g", tags: ["a", "c"] } })
  expect(elicitationContent({ fields, answers: { name: ["Ada"], age: ["36"], subscribe: [] } })).toEqual({ ok: true, content: { name: "Ada", age: 36 } })
  expect(elicitationContent({ fields, answers: { name: ["Ada"] } })).toMatchObject({ ok: false, message: "Age is required" })
  expect(elicitationContent({ fields, answers: { name: ["A"], age: ["36"] } })).toMatchObject({ ok: false })
  expect(elicitationContent({ fields, answers: { name: ["Ada"], age: ["17"] } })).toMatchObject({ ok: false })
  expect(elicitationContent({ fields, answers: { name: ["Ada"], age: ["3.5"] } })).toMatchObject({ ok: false })
  expect(elicitationContent({ fields, answers: { name: ["Ada"], age: ["20"], color: ["Blue"] } })).toMatchObject({ ok: false })
  expect(elicitationContent({ fields, answers: { name: ["Ada"], age: ["20"], subscribe: ["maybe"] } })).toMatchObject({ ok: false })
})

test("elicitationQuestions maps fields to a question batch within the terminal's limits", () => {
  const parsed = parseElicitation({ message: "Hi", requestedSchema: { ...profile, properties: { ...profile.properties, big: { type: "string", enum: Array.from({ length: 12 }, (_, index) => `v${index}`) } } } })
  const questions = elicitationQuestions(parsed.ok ? parsed.fields : [])
  expect(questions.map((question) => question.header)).toEqual(["Name", "Age", "Subscribe", "Color", "Tags", "big"])
  expect(questions[2]).toMatchObject({ options: [{ label: "Yes" }, { label: "No" }], custom: false })
  expect(questions[3]).toMatchObject({ options: [{ label: "Red", description: "r" }, { label: "Green", description: "g" }], custom: false })
  expect(questions[4]).toMatchObject({ multiple: true, custom: false })
  expect(questions[5]).toMatchObject({ options: [], custom: true })
  expect(questions[0]!.context).toContain("length 2")
})

test("userElicitation asks through the tool's ask and turns refusals into decline or cancel", async () => {
  const asked: Array<Record<string, unknown>> = []
  const handler = userElicitation({ ask: async (question) => { asked.push(question as Record<string, unknown>); return { answered: true, text: "", answers: [["Ada"], ["36"]] } } })
  const form = { type: "object", properties: { name: { type: "string" }, age: { type: "integer" } }, required: ["name", "age"] }
  expect(await respondToElicitation({ server: "crm", params: { message: "Who are you?", requestedSchema: form }, handler })).toEqual({ result: { action: "accept", content: { name: "Ada", age: 36 } } })
  expect(asked[0]).toMatchObject({ title: "crm asks for input", detail: "Who are you?" })
  const declined = userElicitation({ ask: async () => ({ answered: false, reason: "the user declined to answer" }) })
  expect(await respondToElicitation({ server: "crm", params: { message: "Who?", requestedSchema: form }, handler: declined })).toEqual({ result: { action: "decline" } })
  const abandoned = userElicitation({ ask: async () => ({ answered: false, reason: "the question was abandoned" }) })
  expect(await respondToElicitation({ server: "crm", params: { message: "Who?", requestedSchema: form }, handler: abandoned })).toEqual({ result: { action: "cancel" } })
  const confirm = userElicitation({ ask: async (question) => ({ answered: true, text: "", answers: [[question.questions![0]!.options[0]!.label]] }) })
  expect(await respondToElicitation({ server: "crm", params: { message: "Proceed?" }, handler: confirm })).toEqual({ result: { action: "accept", content: {} } })
  expect(await respondToElicitation({ server: "crm", params: { message: "Proceed?" }, handler: undefined })).toEqual({ result: { action: "decline" } })
  expect(await respondToElicitation({ server: "crm", params: { nope: true }, handler })).toMatchObject({ error: { code: -32602 } })
})

test("stdio: the client announces elicitation, answers the server mid-call and types the content", async () => {
  const log = join(tempDir(), "init.log")
  const client = local({ log })
  const handler = answered({ name: ["Ada"], age: ["36"], subscribe: ["no"], color: ["Red"], tags: ["b"] })
  expect(await reply(client, "profile", handler)).toEqual({ action: "accept", content: { name: "Ada", age: 36, subscribe: false, color: "r", tags: ["b"] } })
  expect(JSON.parse(readFileSync(log, "utf8").trim().split("\n")[0]!).capabilities).toEqual({ elicitation: {} })
})

test("stdio: no handler, a refusal, an invalid answer and a credential form never reach the server as content", async () => {
  const client = local()
  expect(await reply(client, "profile")).toEqual({ action: "decline" })
  expect(await reply(client, "profile", async () => ({ action: "decline" }))).toEqual({ action: "decline" })
  expect(await reply(client, "profile", async () => ({ action: "cancel" }))).toEqual({ action: "cancel" })
  expect(await reply(client, "profile", answered({ name: ["Ada"], age: ["10"] }))).toEqual({ action: "cancel" })
  expect(await reply(client, "profile", async () => { throw new Error("ui broke") })).toEqual({ action: "cancel" })
  let asked = false
  expect(await reply(client, "credential", async () => { asked = true; return { action: "accept", answers: { apiKey: ["sk-1"] } } })).toEqual({ action: "decline" })
  expect(asked).toBe(false)
})

test("stdio: elicitation: false in the server config does not announce it and declines", async () => {
  const log = join(tempDir(), "init.log")
  const client = local({ elicitation: false, log })
  expect(await reply(client, "profile", answered({ name: ["Ada"], age: ["36"] }))).toEqual({ action: "decline" })
  expect(JSON.parse(readFileSync(log, "utf8").trim().split("\n")[0]!).capabilities).toEqual({})
})

test("stdio: the call's timeout stands still while the person answers", async () => {
  const client = local({ timeoutMs: 400 })
  const slow: ElicitHandler = async () => { await Bun.sleep(900); return { action: "accept", answers: { name: ["Ada"], age: ["36"] } } }
  expect(await reply(client, "profile", slow)).toEqual({ action: "accept", content: { name: "Ada", age: 36 } })
})

test("manager.callTool and MCP tools pass the tool's ask on as the elicitation handler", async () => {
  const manager = createMcpManager({ configLoader: () => ({ servers: { elicit: { command: process.execPath, args: [FIXTURE] } }, errors: [] }) })
  cleanups.push(() => manager.stop())
  const directory = tempDir()
  const { tools } = await discoverMcpTools({ manager, directory })
  const tool = tools.find((entry) => entry.name === "mcp__elicit__ask")!
  const asked: string[] = []
  const result = await tool.execute({ schema: "profile" }, { cwd: directory, signal: new AbortController().signal, ask: async (question) => { asked.push(question.title); return { answered: true, text: "", answers: [["Ada"], ["36"], [], [], []] } } })
  expect(JSON.parse(result.output)).toEqual({ action: "accept", content: { name: "Ada", age: 36 } })
  expect(asked).toEqual(["elicit asks for input"])
  const without = await tool.execute({ schema: "profile" }, { cwd: directory, signal: new AbortController().signal })
  expect(JSON.parse(without.output)).toEqual({ action: "decline" })
})

function startRemote() {
  const state = { capabilities: undefined as unknown, replies: [] as unknown[] }
  let release: ((message: Record<string, any>) => void) | undefined
  const json = (value: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json", ...headers } })
  const encoder = new TextEncoder()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method === "DELETE") return new Response(null, { status: 200 })
      const message: any = await request.json()
      if (message.method === "initialize") {
        state.capabilities = message.params.capabilities
        return json({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } } }, { "mcp-session-id": "s1" })
      }
      if (message.method === undefined && message.id === "elicit-1") {
        state.replies.push(message.result ?? message.error)
        release?.(message)
        return new Response(null, { status: 202 })
      }
      if (message.id === undefined) return new Response(null, { status: 202 })
      if (message.method === "tools/list") return json({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "ask", inputSchema: { type: "object" } }] } })
      const answer = new Promise<Record<string, any>>((resolve) => (release = resolve))
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: "elicit-1", method: "elicitation/create", params: { message: "Tell me", requestedSchema: profile } })}\n\n`))
          const response = await answer
          controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify(response.result ?? response.error) }] } })}\n\n`))
          controller.close()
        },
      })
      return new Response(stream, { headers: { "content-type": "text/event-stream" } })
    },
  })
  cleanups.push(() => server.stop(true))
  return { url: `http://127.0.0.1:${server.port}/mcp`, state }
}

test("streamable HTTP: a question inside the call's event stream is answered by a separate POST", async () => {
  const remote = startRemote()
  const client = createMcpClient({ name: "remote", config: { url: remote.url, oauth: false } })
  cleanups.push(() => client.close())
  expect(await reply(client, "profile", answered({ name: ["Ada"], age: ["36"] }))).toEqual({ action: "accept", content: { name: "Ada", age: 36 } })
  expect(remote.state.capabilities).toEqual({ elicitation: {} })
  expect(await reply(client, "profile")).toEqual({ action: "decline" })
})

test("streamable HTTP: the request deadline stands still while the person answers", async () => {
  const remote = startRemote()
  const client = createMcpClient({ name: "remote", config: { url: remote.url, oauth: false, timeoutMs: 400 } })
  cleanups.push(() => client.close())
  const slow: ElicitHandler = async () => { await Bun.sleep(900); return { action: "accept", answers: { name: ["Ada"], age: ["36"] } } }
  expect(await reply(client, "profile", slow)).toEqual({ action: "accept", content: { name: "Ada", age: 36 } })
})

test("streamable HTTP: elicitation: false announces nothing and declines", async () => {
  const remote = startRemote()
  const client = createMcpClient({ name: "remote", config: { url: remote.url, oauth: false, elicitation: false } })
  cleanups.push(() => client.close())
  expect(await reply(client, "profile", answered({ name: ["Ada"], age: ["36"] }))).toEqual({ action: "decline" })
  expect(remote.state.capabilities).toEqual({})
})
