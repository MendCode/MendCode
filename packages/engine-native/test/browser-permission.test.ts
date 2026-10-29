import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { EngineEvent, EngineRequest, EngineResolution, TurnInput } from "@mendcode/kernel"
import { createIdFactory, type PermissionMode, type Settings } from "@mendcode/protocol"
import { browserTool, type BrowserInput, type BrowserPort } from "@mendcode/tools"
import { createNativeEngine, memoryHistory, type ModelEvent, type ModelProvider, type ModelRequest } from "../src"
import { permissionName, permissionPatterns } from "../src/permission-rules"

const ids = createIdFactory()
const project = realpathSync(mkdtempSync(join(tmpdir(), "browser-perm-")))
afterAll(() => rmSync(project, { recursive: true, force: true }))

function scripted(steps: ModelEvent[][]) {
  const requests: ModelRequest[] = []
  const provider: ModelProvider = {
    id: "scripted",
    model: "script-1",
    async *stream(request) {
      requests.push({ ...request, messages: structuredClone(request.messages) })
      const step = steps.shift()
      if (!step) throw new Error("script exhausted")
      yield* step
    },
  }
  return { provider, requests }
}
const stop: ModelEvent[] = [{ type: "text", delta: "done" }, { type: "finish", reason: "stop" }]
const call = (args: unknown): ModelEvent[] => [{ type: "tool_call", call: { callId: ids("item"), name: "browser", args } }, { type: "finish", reason: "tool_calls" }]

function scenario(steps: ModelEvent[][], permission: Exclude<Settings["permission"], string | undefined> = {}) {
  const { provider, requests } = scripted(steps)
  const ran: BrowserInput[] = []
  const port: BrowserPort = { async run(input) { ran.push(input); return { ok: true, text: `ok ${input.action}` } } }
  const engine = createNativeEngine({
    provider,
    tools: [browserTool],
    history: memoryHistory(),
    cwdFor: () => project,
    system: () => "sys",
    compactionPrompt: "summarize",
    browser: () => port,
    permissionPolicy: () => ({ permission: { external_directory: "allow", ...permission }, experimental: { continue_loop_on_deny: true } }),
  })
  return { engine, requests, ran }
}

function turn(options: { mode: PermissionMode; answers?: EngineResolution[] }) {
  const events: EngineEvent[] = []
  const asked: EngineRequest[] = []
  const answers = [...(options.answers ?? [])]
  const input: TurnInput = {
    permissionMode: () => options.mode,
    setPermissionMode: () => {},
    sessionId: ids("session"),
    turnId: ids("turn"),
    text: "go",
    attachments: [],
    signal: new AbortController().signal,
    newItemId: () => ids("item"),
    emit: (event) => void events.push(event),
    ask: async (request) => (asked.push(request), answers.shift() ?? { kind: "deny", reason: "nobody answered" }),
  }
  return { input, events, asked }
}
const lastOutput = (requests: ModelRequest[]) => (requests.at(-1)!.messages.at(-1) as { output: string; isError: boolean })

describe("browser has its own permission class", () => {
  test("navigation is matched by its URL, other steps by their action, so a click grant never opens pages", () => {
    expect(permissionName("browser")).toBe("browser")
    expect(permissionPatterns("browser", { action: "navigate", url: "http://localhost:3000/x" }, project)).toEqual(["http://localhost:3000/x"])
    expect(permissionPatterns("browser", { action: "click", ref: 3 }, project)).toEqual(["click"])
    expect(permissionPatterns("browser", { action: "snapshot" }, project)).toEqual(["snapshot"])
  })

  test("ask mode asks before opening a page, showing the URL, and runs it only when approved", async () => {
    const s = scenario([call({ action: "navigate", url: "http://localhost:3000/" }), stop])
    const { input, asked } = turn({ mode: "ask", answers: [{ kind: "approve", scope: "once" }] })
    await s.engine.runTurn(input)
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ tool: "browser", permission: "execute", title: "Use browser", detail: expect.stringContaining("open http://localhost:3000/"), permissionContext: { name: "browser", patterns: ["http://localhost:3000/"] } })
    expect(s.ran).toEqual([{ action: "navigate", url: "http://localhost:3000/" }])
  })

  test("typing shows what will be typed and a refusal never reaches the browser", async () => {
    const s = scenario([call({ action: "type", ref: 4, text: "ada@example.com", submit: true }), stop])
    const { input, asked } = turn({ mode: "ask", answers: [{ kind: "deny", reason: "no" }] })
    await s.engine.runTurn(input)
    expect(asked[0]).toMatchObject({ detail: expect.stringContaining("ada@example.com") })
    expect(s.ran).toEqual([])
    expect(lastOutput(s.requests)).toMatchObject({ isError: true, output: expect.stringContaining("denied") })
  })

  test("observing the open page needs no approval in ask mode", async () => {
    const s = scenario([call({ action: "snapshot" }), stop])
    const { input, asked } = turn({ mode: "ask" })
    await s.engine.runTurn(input)
    expect(asked).toEqual([])
    expect(s.ran).toEqual([{ action: "snapshot" }])
  })

  test("plan mode refuses to load pages", async () => {
    const s = scenario([call({ action: "navigate", url: "http://localhost:3000/" }), stop])
    const { input, asked } = turn({ mode: "plan" })
    await s.engine.runTurn(input)
    expect(asked).toEqual([])
    expect(s.ran).toEqual([])
  })

  test("a browser rule can allow one origin without asking and deny the rest", async () => {
    const s = scenario([call({ action: "navigate", url: "http://localhost:3000/a" }), call({ action: "navigate", url: "https://evil.example/" }), stop], { browser: { "https://*": "deny", "http://localhost:*": "allow" } })
    const { input, asked } = turn({ mode: "ask" })
    await s.engine.runTurn(input)
    expect(asked).toEqual([])
    expect(s.ran).toEqual([{ action: "navigate", url: "http://localhost:3000/a" }])
    expect(lastOutput(s.requests)).toMatchObject({ isError: true })
  })

  test("turning the tool off in settings disables it", async () => {
    const s = scenario([call({ action: "snapshot" }), stop], { browser: "deny" })
    const { input } = turn({ mode: "full" })
    await s.engine.runTurn(input)
    expect(s.ran).toEqual([])
    expect(lastOutput(s.requests).isError).toBe(true)
  })
})
