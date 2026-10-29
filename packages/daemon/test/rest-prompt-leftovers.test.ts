import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ModelEvent } from "@mendcode/engine-native"
import { RestMessageDto, type SessionId } from "@mendcode/protocol"
import { remoteTokens } from "../src/remote"
import { answer, boot, callTool, openSession, say, stop, type NativeHarness, type Step } from "./native-harness"

const harnesses: NativeHarness[] = []
const removals: Array<() => void> = []
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.cleanup()
  for (const remove of removals.splice(0)) remove()
})

async function rest(steps: Step[]) {
  // The HTTP server needs a token in the daemon directory before it starts.
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-rest-prompt-")))
  const token = remoteTokens(dir).create({ name: "full" }).token
  const h = await boot({ steps, http: true, dir })
  harnesses.push(h)
  removals.push(() => rmSync(dir, { recursive: true, force: true }))
  const sessionId = await openSession(h)
  const request = async (route: string, value?: unknown) => {
    const response = await h.daemon.httpAdapter!.fetch(new Request(`http://127.0.0.1:4096${route}`, { method: value === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) }))
    if (!response) throw new Error("unexpected upgrade")
    return response
  }
  const prompt = (extra: Record<string, unknown>, text = "hello") => request(`/session/${sessionId}/message`, { parts: [{ type: "text", text }], ...extra })
  const messages = async () => await (await request(`/session/${sessionId}/message`)).json() as Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>
  return { h, sessionId: sessionId as SessionId, request, prompt, messages }
}

const withUsage = (events: ModelEvent[], input: number, output: number): ModelEvent[] => [...events.slice(0, -1), { type: "usage", usage: { input, output, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }, events.at(-1)!]

test("noReply records the prompt without a model call, and the next turn sees it", async () => {
  const t = await rest([stop("second answer")])
  const recorded = await t.prompt({ noReply: true }, "remember: the code word is plum")
  expect(recorded.status).toBe(200)
  const body = await recorded.json()
  expect(body.info.role).toBe("user")
  expect(t.h.requests).toHaveLength(0)
  const shown = await t.messages()
  expect(shown.map((message) => message.info.role)).toEqual(["user"])
  expect(shown[0]!.parts.some((part) => part.type === "step-start")).toBe(false)
  expect(await (await t.prompt({})).json()).toMatchObject({ info: { role: "assistant" } })
  expect(JSON.stringify(t.h.requests[0]!.messages)).toContain("the code word is plum")
})

test("a prompt's tools map removes tools for that turn only and never adds one", async () => {
  const t = await rest([stop("one"), stop("two"), stop("local")])
  expect((await t.prompt({ tools: { probe: false, read: true } })).status).toBe(200)
  const first = t.h.requests[0]!.tools.map((tool) => tool.name)
  expect(first).not.toContain("probe")
  expect(first).not.toContain("task")
  expect(first).toContain("read")
  expect((await t.prompt({})).status).toBe(200)
  const second = t.h.requests[1]!.tools.map((tool) => tool.name)
  expect(second).toContain("probe")
  expect(second).not.toContain("task") // Remote tool restrictions cannot be bypassed by delegation.
  await say(t.h, t.sessionId, "local turn")
  expect(t.h.requests[2]!.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["probe", "task"]))
})

test("a json_schema format returns the validated object as info.structured, retrying invalid answers", async () => {
  const schema = { type: "object", properties: { title: { type: "string" }, count: { type: "integer" } }, required: ["title", "count"], additionalProperties: false }
  const t = await rest([stop("plain text first"), callTool("StructuredOutput", { title: "x", count: "two" }), callTool("StructuredOutput", { title: "report", count: 2 })])
  const response = await t.prompt({ format: { type: "json_schema", schema } })
  expect(response.status).toBe(200)
  const message = await response.json()
  expect(message.info.structured).toEqual({ title: "report", count: 2 })
  expect(message.info.error).toBeUndefined()
  expect(RestMessageDto.safeParse(message).success).toBe(true)
  const spec = t.h.requests[0]!.tools.find((tool) => tool.name === "StructuredOutput")
  expect(spec?.parameters).toMatchObject({ type: "object", required: ["title", "count"] })
  expect(t.h.requests).toHaveLength(3)
  expect(JSON.stringify(t.h.requests[0]!.system)).toContain("structured answer")
})

test("a missing structured answer fails the turn with StructuredOutputError after the retries", async () => {
  const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] }
  const t = await rest([stop("no"), stop("still no")])
  const message = await (await t.prompt({ format: { type: "json_schema", schema, retryCount: 1 } })).json()
  expect(message.info.error).toMatchObject({ name: "StructuredOutputError" })
  expect(message.info.structured).toBeUndefined()
  expect(t.h.requests).toHaveLength(2)
})

test("an unusable format is refused before the model runs", async () => {
  const t = await rest([])
  expect((await t.prompt({ format: { type: "json_schema", schema: { type: "array" } } })).status).toBe(400)
  expect((await t.prompt({ format: { type: "json_schema", schema: { type: "object", properties: { a: { $ref: "https://example.test/schema.json" } } } } })).status).toBe(400)
  expect(t.h.requests).toHaveLength(0)
})

test("tool rounds become step-start and step-finish parts with each call's usage", async () => {
  const t = await rest([withUsage(callTool("probe", {}), 10, 3), answer("done", { input: 20, output: 5 })])
  const message = await (await t.prompt({})).json()
  const types = (message.parts as Array<{ type: string }>).map((part) => part.type)
  expect(types).toEqual(["step-start", "tool", "step-finish", "step-start", "text", "step-finish"])
  const finishes = message.parts.filter((part: { type: string }) => part.type === "step-finish")
  expect(finishes.map((part: { reason: string }) => part.reason)).toEqual(["tool-calls", "stop"])
  expect(finishes[0].tokens).toMatchObject({ input: 10, output: 3 })
  expect(finishes[1].tokens).toMatchObject({ input: 20, output: 5 })
  expect(RestMessageDto.safeParse(message).success).toBe(true)
  // Step parts are bookkeeping: they cannot be edited, and v2 content leaves them out.
  const part = message.parts[0]
  expect((await t.h.daemon.httpAdapter!.fetch(new Request(`http://127.0.0.1:4096/session/${t.sessionId}/message/${message.info.id}/part/${part.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${remoteTokens(t.h.dir).create({ name: "again" }).token}` } })))!.status).toBe(400)
  const v2 = await (await t.request(`/api/session/${t.sessionId}/message`)).json()
  expect(JSON.stringify(v2)).not.toContain("step-")
})
