import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { EngineEvent, EngineRequest, EngineResolution, TurnInput } from "@mendcode/kernel"
import { createIdFactory, type PermissionMode, type Settings } from "@mendcode/protocol"
import { shellSession, type InteractiveInfo, type InteractivePort } from "@mendcode/tools"
import { createNativeEngine, memoryHistory, type ModelEvent, type ModelProvider, type ModelRequest } from "../src"
import { asShellCall } from "../src/smart-permissions"
import { externalPatterns, permissionName, permissionPatterns } from "../src/permission-rules"

const ids = createIdFactory()
const project = realpathSync(mkdtempSync(join(tmpdir(), "shell-session-perm-")))
afterAll(() => rmSync(project, { recursive: true, force: true }))

const info = (id: string): InteractiveInfo => ({ id, command: "x", cwd: project, status: "running", startedAt: Date.now(), cols: 80, rows: 24 })

/** Records what reached the daemon-side registry; the permission path decides before any of it runs. */
function fakePort() {
  const calls: string[] = []
  const port: InteractivePort = {
    start: (input) => (calls.push(`start ${input.command}`), { ok: true, session: info("pty_1") }),
    write: (id, data) => (calls.push(`write ${id} ${JSON.stringify(data)}`), { ok: true, session: info(id) }),
    read: async (id) => (calls.push(`read ${id}`), { session: info(id), output: "ready\n", dropped: 0, remaining: 0 }),
    resize: (id, cols, rows) => (calls.push(`resize ${id} ${cols}x${rows}`), { ok: true, session: info(id) }),
    signal: (id, signal) => (calls.push(`signal ${id} ${signal}`), { ok: true, session: info(id) }),
    kill: (id) => (calls.push(`kill ${id}`), info(id)),
    list: () => [],
  }
  return { port, calls }
}

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
const call = (args: unknown): ModelEvent[] => [{ type: "tool_call", call: { callId: ids("item"), name: "shell_session", args } }, { type: "finish", reason: "tool_calls" }]

function scenario(steps: ModelEvent[][], permission: Exclude<Settings["permission"], string | undefined> = {}) {
  const { provider, requests } = scripted(steps)
  const fake = fakePort()
  const engine = createNativeEngine({
    provider,
    tools: [shellSession],
    history: memoryHistory(),
    cwdFor: () => project,
    system: () => "sys",
    compactionPrompt: "summarize",
    interactive: () => fake.port,
    permissionPolicy: () => ({ permission: { external_directory: "allow", ...permission }, experimental: { continue_loop_on_deny: true } }),
  })
  return { engine, requests, ...fake }
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

describe("shell_session starts through the shell permission path", () => {
  test("a start is judged, matched and bound like the equivalent shell command; other actions are judged as themselves", () => {
    expect(asShellCall("shell_session", { action: "start", command: "git status", workdir: "sub" })).toEqual({ tool: "shell", args: { command: "git status", workdir: "sub" } })
    expect(asShellCall("shell_session", { action: "write", id: "pty_1", input: "x" })).toEqual({ tool: "shell_session", args: { action: "write", id: "pty_1", input: "x" } })
    expect(permissionName("shell_session")).toBe("bash")
    expect(permissionPatterns("shell_session", { action: "start", command: "git status && bun test" }, project)).toEqual(["git status", "bun test"])
    expect(permissionPatterns("shell_session", { action: "read", id: "pty_1" }, project)).toEqual(["*"])
    const outside = externalPatterns("shell", { command: "cat /etc/hosts" }, project)
    expect(outside).toHaveLength(1)
    expect(externalPatterns("shell_session", { action: "start", command: "cat /etc/hosts" }, project)).toEqual(outside)
    expect(externalPatterns("shell_session", { action: "read", id: "pty_1" }, project)).toEqual([])
  })

  test("ask mode asks for a start, saying it is interactive, and runs it only when approved", async () => {
    const s = scenario([call({ action: "start", command: "python3 repl.py" }), stop])
    const { input, asked } = turn({ mode: "ask", answers: [{ kind: "approve", scope: "once" }] })
    await s.engine.runTurn(input)
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ tool: "shell_session", permission: "execute", title: "Run interactive command", detail: expect.stringContaining("python3 repl.py"), permissionContext: { name: "bash", patterns: ["python3 repl.py"] } })
    expect(s.calls).toEqual(["start python3 repl.py", "read pty_1"])
  })

  test("a refused start never reaches the registry", async () => {
    const s = scenario([call({ action: "start", command: "python3 repl.py" }), stop])
    const { input, asked } = turn({ mode: "ask", answers: [{ kind: "deny", reason: "no" }] })
    await s.engine.runTurn(input)
    expect(asked).toHaveLength(1)
    expect(s.calls).toEqual([])
    expect(lastOutput(s.requests)).toMatchObject({ isError: true, output: expect.stringContaining("denied") })
  })

  test("a shell deny rule refuses a start without asking, whatever the mode", async () => {
    const s = scenario([call({ action: "start", command: "rm -rf build" }), stop], { shell: { "rm *": "deny" } })
    const { input, asked } = turn({ mode: "full" })
    await s.engine.runTurn(input)
    expect(asked).toEqual([])
    expect(s.calls).toEqual([])
    expect(lastOutput(s.requests)).toMatchObject({ isError: true, output: expect.stringContaining("permission rule") })
  })

  test("disabling the shell tool for the whole project disables interactive sessions too", async () => {
    const s = scenario([call({ action: "list" }), stop], { shell: "deny" })
    const { input } = turn({ mode: "full" })
    await s.engine.runTurn(input)
    expect(s.calls).toEqual([])
    expect(lastOutput(s.requests).isError).toBe(true)
  })

  test("plan mode refuses a start but not a read-only action", async () => {
    const s = scenario([call({ action: "start", command: "git status" }), call({ action: "list" }), stop])
    const { input, asked } = turn({ mode: "plan" })
    await s.engine.runTurn(input)
    expect(asked).toEqual([])
    expect(s.calls).toEqual([])
  })

  test("smart mode lets a read-only command start without asking and asks about a network one", async () => {
    const s = scenario([call({ action: "start", command: "git status" }), call({ action: "start", command: "curl https://example.com" }), stop])
    const { input, asked } = turn({ mode: "smart", answers: [{ kind: "deny", reason: "no network" }] })
    await s.engine.runTurn(input)
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ tool: "shell_session", detail: expect.stringContaining("(network)") })
    expect(s.calls.filter((entry) => entry.startsWith("start"))).toEqual(["start git status"])
  })

  test("write, read, resize, signal and kill on a started session need no second approval", async () => {
    const s = scenario([
      call({ action: "start", command: "python3 repl.py" }),
      call({ action: "write", id: "pty_1", input: "print(1)\n" }),
      call({ action: "read", id: "pty_1" }),
      call({ action: "resize", id: "pty_1", cols: 100, rows: 30 }),
      call({ action: "signal", id: "pty_1", signal: "INT" }),
      call({ action: "kill", id: "pty_1" }),
      stop,
    ])
    const { input, asked } = turn({ mode: "ask", answers: [{ kind: "approve", scope: "once" }] })
    await s.engine.runTurn(input)
    expect(asked).toHaveLength(1)
    expect(s.calls).toEqual(["start python3 repl.py", "read pty_1", "write pty_1 \"print(1)\\n\"", "read pty_1", "read pty_1", "resize pty_1 100x30", "signal pty_1 INT", "read pty_1", "kill pty_1"])
  })

  test("a bare interactive shell is refused by the tool before it reaches the registry", async () => {
    const s = scenario([call({ action: "start", command: "bash -i" }), stop])
    const { input } = turn({ mode: "full" })
    await s.engine.runTurn(input)
    expect(s.calls).toEqual([])
    expect(lastOutput(s.requests)).toMatchObject({ isError: true, output: expect.stringContaining("bare interactive shell") })
  })
})
