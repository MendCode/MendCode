import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createIdFactory, type ModelChoice, type PermissionMode, type SessionId } from "@mendcode/protocol"
import type { EngineEvent, EnginePort, EngineRequest, EngineResolution, TurnInput } from "@mendcode/kernel"
import type { SandboxPolicy } from "@mendcode/tools"
import { classifySmart } from "../../engine-native/src/smart-permissions"
import {
  createPiConfig,
  createPiEngine,
  GATE_MARK,
  GATE_SOURCE,
  GATE_READY,
  GATE_STATUS_KEY,
  gateDetail,
  parseGateRequest,
  parsePiConfig,
  parsePiVersion,
  piCapabilities,
  piToolPermission,
  probePi,
  spawnPi,
  withPiEngine,
  type PiCapabilities,
} from "../src"

const ids = createIdFactory()
const FAKE = join(import.meta.dir, "fake-pi.ts")
const temps: string[] = []
const engines: Array<{ stop(): void }> = []
afterEach(() => {
  for (const engine of engines.splice(0)) engine.stop()
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function temp() {
  const dir = mkdtempSync(join(tmpdir(), "mendcode-pi-test-"))
  temps.push(dir)
  return dir
}

const piConfig = {
  resolved: () => ({ command: process.execPath, args: [], env: {} }),
  patternOf: (id: string | undefined) => (id?.startsWith("pi:") ? id.slice(3) : undefined),
  owns: (id: string | undefined) => id === "pi" || id?.startsWith("pi:") === true,
}

type Setup = {
  env?: Record<string, string>
  capabilities?: PiCapabilities
  idleMs?: number
  settleQuietMs?: number
  gateTimeoutMs?: number
  cancelGraceMs?: number
  fileExists?: (path: string) => boolean
  bindings?: Map<string, string>
  model?: () => ModelChoice
  readBlob?: boolean
  trusted?: () => boolean
  sandbox?: () => SandboxPolicy | undefined
  permission?: () => PermissionMode
  args?: string[]
  smartBash?: (input: { args: Record<string, unknown>; cwd: string }) => "allow" | "ask" | "deny"
  environment?: () => { values: Record<string, string>; note: string } | undefined
}

function setup(patch: Setup = {}) {
  const dir = temp()
  const log = join(dir, "log.jsonl")
  writeFileSync(log, "")
  const store = patch.bindings ?? new Map<string, string>()
  const spawned: string[][] = []
  const envs: Array<Record<string, string>> = []
  const policies: Array<SandboxPolicy | undefined> = []
  const engine = createPiEngine({
    config: { ...piConfig, resolved: () => ({ ...piConfig.resolved(), args: patch.args ?? [] }) },
    modelFor: () => (patch.model ?? (() => ({ model: "pi" })))(),
    cwdFor: () => dir,
    projectTrusted: () => patch.trusted?.() ?? false,
    sandbox: () => patch.sandbox?.(),
    permissionFor: () => patch.permission?.() ?? "ask",
    ...(patch.smartBash ? { smartBash: patch.smartBash } : {}),
    ...(patch.environment ? { environment: patch.environment } : {}),
    capabilities: () => patch.capabilities ?? { settled: true, disableExtensions: true },
    ...(patch.idleMs ? { idleMs: patch.idleMs } : {}),
    ...(patch.settleQuietMs ? { settleQuietMs: patch.settleQuietMs } : {}),
    ...(patch.gateTimeoutMs ? { gateTimeoutMs: patch.gateTimeoutMs } : {}),
    ...(patch.cancelGraceMs ? { cancelGraceMs: patch.cancelGraceMs } : {}),
    ...(patch.fileExists ? { fileExists: patch.fileExists } : {}),
    bindings: { get: (sessionId) => store.get(sessionId), set: (sessionId, file) => void store.set(sessionId, file) },
    readBlob: async () => new Uint8Array([1, 2, 3]),
    transportFactory: ({ args, env, cwd, sandbox }) => {
      spawned.push(args)
      envs.push(env)
      policies.push(sandbox)
      return spawnPi({ command: process.execPath, args: [FAKE, ...args], env: { FAKE_PI_LOG: log, ...env, ...patch.env }, cwd })
    },
  })
  engines.push(engine)
  const received = () =>
    readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  const commands = (type: string) => received().filter((message) => message.type === type)
  return { engine, dir, received, commands, spawned, store, policies, envs }
}

type TurnPatch = { sessionId?: SessionId; text?: string; mode?: () => PermissionMode; answer?: (request: EngineRequest) => EngineResolution | Promise<EngineResolution>; signal?: AbortSignal; attachments?: TurnInput["attachments"]; queued?: Array<{ text: string; attachments: [] }> }

function turnInput(patch: TurnPatch = {}) {
  const events: EngineEvent[] = []
  const asked: EngineRequest[] = []
  const queued = patch.queued ? [...patch.queued] : undefined
  const input: TurnInput = {
    sessionId: patch.sessionId ?? ids("session"),
    turnId: ids("turn"),
    text: patch.text ?? "hello",
    attachments: patch.attachments ?? [],
    signal: patch.signal ?? new AbortController().signal,
    newItemId: () => ids("item"),
    emit: (event) => void events.push(event),
    ask: async (request) => {
      asked.push(request)
      return (await patch.answer?.(request)) ?? { kind: "abandoned" }
    },
    permissionMode: patch.mode ?? (() => "ask"),
    setPermissionMode: () => undefined,
    ...(queued ? { takeQueued: async () => queued.shift() } : {}),
  }
  return { input, events, asked }
}

const items = (events: EngineEvent[], kind: string) =>
  events
    .filter((event) => event.type === "item.started" && event.kind === kind)
    .map((started) => events.find((event) => event.type === "item.completed" && event.itemId === (started as any).itemId) as any)
const texts = (events: EngineEvent[], kind: string) => items(events, kind).map((item) => item?.text)
const approve = (): EngineResolution => ({ kind: "approve", scope: "once" })

test("the real bridge source installs its tool hook before answering the process handshake", () => {
  const hooks = new Map<string, (event: unknown, context: unknown) => unknown>()
  const source = GATE_SOURCE.replace("process.env.MENDCODE_PI_GATE_TOKEN", JSON.stringify("test-handshake"))
  const install = new Function(source.replace("export default", "return"))() as (pi: unknown) => void
  install({ on: (name: string, hook: (event: unknown, context: unknown) => unknown) => hooks.set(name, hook) })
  expect([...hooks.keys()]).toEqual(["tool_call", "session_start"])
  const statuses: string[][] = []
  hooks.get("session_start")!({}, { ui: { setStatus: (...status: string[]) => statuses.push(status) } })
  expect(statuses).toEqual([[GATE_STATUS_KEY, `${GATE_READY}:test-handshake`]])
})

test("the bridge refuses oversized arguments instead of approving a clipped command", async () => {
  const hooks = new Map<string, (event: unknown, context: unknown) => unknown>()
  const install = new Function(GATE_SOURCE.replace("export default", "return"))() as (pi: unknown) => void
  install({ on: (name: string, hook: (event: unknown, context: unknown) => unknown) => hooks.set(name, hook) })
  let asked = 0
  const context = { ui: { select: async () => { asked++; return "allow" } } }
  const event = { toolCallId: "long", toolName: "bash", input: { command: "echo safe " + "x".repeat(6_000) + "; echo hidden" } }
  expect(await hooks.get("tool_call")!(event, context)).toMatchObject({ block: true })
  expect(asked).toBe(0)
  expect(await hooks.get("tool_call")!({ ...event, input: { command: "echo safe" } }, context)).toBeUndefined()
  expect(asked).toBe(1)
})

test("plan mode refuses a tool even when an earlier turn approved it for the session", async () => {
  const { engine } = setup()
  const sessionId = ids("session")
  await engine.runTurn(turnInput({ sessionId, text: "tool bash", answer: () => ({ kind: "approve", scope: "session" }) }).input)
  const planned = turnInput({ sessionId, text: "tool bash", mode: () => "plan" })
  expect(await engine.runTurn(planned.input)).toEqual({ status: "ok" })
  expect(texts(planned.events, "agent_message").join("\n")).toContain("picked:deny")
})

describe("a normal turn", () => {
  test("starts pi with its own session store and the bridge, and maps thinking, text and usage", async () => {
    const { engine, dir, received, spawned, store } = setup()
    const { input, events } = turnInput({ text: "hello" })
    expect(await engine.runTurn(input)).toEqual({ status: "ok" })
    expect(texts(events, "reasoning")).toEqual(["hmm"])
    expect(texts(events, "agent_message")).toEqual(["Hello there"])
    expect(events.find((event) => event.type === "usage")).toEqual({ type: "usage", provider: "anthropic", model: "claude-test", input: 100, output: 20, reasoning: 0, cacheRead: 10, cacheWrite: 0, costMicros: 3000 })
    const args = spawned[0]!
    expect(args.slice(0, 2)).toEqual(["--mode", "rpc"])
    expect(args).not.toContain("--no-session")
    expect(args).toContain("--no-extensions")
    expect(args).not.toContain("--no-skills")
    const gate = args[args.indexOf("-e") + 1]!
    expect(readFileSync(gate, "utf8")).toBe(GATE_SOURCE)
    expect(received().find((message) => message.argv)?.argv).toContain("rpc")
    expect(dir).not.toBe("")
    expect([...store.values()]).toEqual(["/tmp/fake-pi/session-1.jsonl"])
    expect(received().find((message) => message.type === "prompt")).toMatchObject({ message: "hello", id: expect.stringMatching(/^mend-/) })
  })

  test("/env credentials reach pi's process and its appended system prompt names them; new ones start a new process", async () => {
    let environment: { values: Record<string, string>; note: string } | undefined = { values: { INSTABOX_KEY: "ib-secret" }, note: "MendCode credentials (set by the user in /env) are in your shell's environment: INSTABOX_KEY." }
    const h = setup({ environment: () => environment })
    const sessionId = ids("session")
    expect(await h.engine.runTurn(turnInput({ sessionId }).input)).toEqual({ status: "ok" })
    expect(h.envs[0]).toMatchObject({ INSTABOX_KEY: "ib-secret" })
    expect(h.spawned[0]).toEqual(expect.arrayContaining(["--append-system-prompt", environment.note]))
    environment = { values: { INSTABOX_KEY: "ib-rotated" }, note: environment.note }
    expect(await h.engine.runTurn(turnInput({ sessionId }).input)).toEqual({ status: "ok" })
    expect(h.spawned).toHaveLength(2)
    expect(h.envs[1]).toMatchObject({ INSTABOX_KEY: "ib-rotated" })
  })

  test("the process stays up between turns and the bridge file goes away with the engine", async () => {
    const { engine, spawned } = setup()
    const sessionId = ids("session")
    await engine.runTurn(turnInput({ sessionId }).input)
    const second = turnInput({ sessionId, text: "anything else" })
    expect(await engine.runTurn(second.input)).toEqual({ status: "ok" })
    expect(texts(second.events, "agent_message")).toEqual(["echo:anything else"])
    expect(spawned).toHaveLength(1)
    const gate = spawned[0]![spawned[0]!.indexOf("-e") + 1]!
    expect(existsSync(gate)).toBe(true)
    engine.stop()
    expect(existsSync(gate)).toBe(false)
  })

  test("images go as image blocks, other attachments as a text marker", async () => {
    const { engine, commands } = setup()
    const image = { sha256: "a".repeat(64), mime: "image/png", size: 3, name: "shot.png" } as any
    const file = { sha256: "b".repeat(64), mime: "application/pdf", size: 3, name: "doc.pdf" } as any
    const { input, events } = turnInput({ text: "images please", attachments: [image, file] })
    await engine.runTurn(input)
    expect(texts(events, "agent_message")).toEqual(["images:1"])
    expect(commands("prompt")[0]).toMatchObject({ images: [{ type: "image", mimeType: "image/png", data: Buffer.from([1, 2, 3]).toString("base64") }] })
    expect(commands("prompt")[0].message).toBe("[attachment doc.pdf · application/pdf · not sent]\nimages please")
  })

  test("pi cannot interleave: the text keeps the tokens and the images follow the order of the tokens", async () => {
    const { engine, commands } = setup()
    const text = "ver [Image #2] y [Image #1]"
    const first = { sha256: "a".repeat(64), mime: "image/png", size: 3, name: "a.png", label: "[Image #1]", at: text.length } as any
    const second = { sha256: "b".repeat(64), mime: "image/jpeg", size: 3, name: "b.jpg", label: "[Image #2]", at: "ver [Image #2]".length } as any
    const { input } = turnInput({ text, attachments: [first, second] })
    await engine.runTurn(input)
    expect(commands("prompt")[0].message).toBe(text)
    expect(commands("prompt")[0].images.map((image: any) => image.mimeType)).toEqual(["image/jpeg", "image/png"])
  })

  test("a prompt pi rejects ends the turn with its reason", async () => {
    const { engine } = setup()
    expect(await engine.runTurn(turnInput({ text: "reject" }).input)).toEqual({ status: "error", code: "pi_rejected", message: "[PI]: Agent is already processing" })
  })

  test("a pi that is not installed says so", async () => {
    const engine = createPiEngine({ config: { ...piConfig, resolved: () => ({ command: "definitely-not-a-pi-binary-xyz", args: [], env: {} }) }, modelFor: () => ({ model: "pi" }), cwdFor: () => tmpdir() })
    engines.push(engine)
    expect(await engine.runTurn(turnInput().input)).toMatchObject({ status: "error", code: "pi_missing" })
  })
})

describe("sessions", () => {
  test("a restarted process resumes pi's session file; a file that is gone starts a new session", async () => {
    const bindings = new Map<string, string>()
    const sessionId = ids("session")
    bindings.set(sessionId, "/tmp/fake-pi/old-session.jsonl")
    const kept = setup({ bindings, fileExists: () => true })
    await kept.engine.runTurn(turnInput({ sessionId }).input)
    const resumed = kept.spawned[0]!
    expect(resumed[resumed.indexOf("--session") + 1]).toBe("/tmp/fake-pi/old-session.jsonl")

    const gone = setup({ bindings: new Map([[sessionId, "/tmp/fake-pi/old-session.jsonl"]]), fileExists: () => false })
    await gone.engine.runTurn(turnInput({ sessionId }).input)
    expect(gone.spawned[0]).not.toContain("--session")
  })

  test("a pi model passes its pattern, and a model switch restarts on the same session file", async () => {
    let model: ModelChoice = { model: "pi:anthropic/sonnet:high" }
    const { engine, spawned } = setup({ model: () => model, fileExists: () => true })
    const sessionId = ids("session")
    await engine.runTurn(turnInput({ sessionId }).input)
    expect(spawned[0]![spawned[0]!.indexOf("--model") + 1]).toBe("anthropic/sonnet:high")
    model = { model: "pi" }
    await engine.runTurn(turnInput({ sessionId }).input)
    expect(spawned).toHaveLength(2)
    expect(spawned[1]).not.toContain("--model")
    expect(spawned[1]![spawned[1]!.indexOf("--session") + 1]).toBe("/tmp/fake-pi/session-1.jsonl")
  })

  test("the chosen effort becomes pi's thinking level once", async () => {
    const { engine, commands } = setup({ model: () => ({ model: "pi", effort: "high" }) })
    const sessionId = ids("session")
    await engine.runTurn(turnInput({ sessionId }).input)
    await engine.runTurn(turnInput({ sessionId }).input)
    expect(commands("set_thinking_level")).toMatchObject([{ level: "high" }])
  })

  test("a session that is not on a pi model is refused", async () => {
    const { engine } = setup({ model: () => ({ model: "gpt-5" }) })
    expect(await engine.runTurn(turnInput().input)).toMatchObject({ status: "error", code: "pi_no_model" })
  })
})

describe("when a run is over", () => {
  test("the first agent_end is not the end: a compaction and a continued run follow, and only agent_settled finishes the turn", async () => {
    const { engine } = setup()
    const { input, events } = turnInput({ text: "compaction" })
    expect(await engine.runTurn(input)).toEqual({ status: "ok" })
    expect(texts(events, "agent_message")).toEqual(["part one", "part two"])
    expect(texts(events, "compaction")).toEqual(["short summary (9000 → 1000 tokens)"])
  })

  test("a retry after an error is shown and the turn ends with the recovered answer", async () => {
    const { engine } = setup()
    const { input, events } = turnInput({ text: "retry" })
    expect(await engine.runTurn(input)).toEqual({ status: "ok" })
    expect(events.find((event) => event.type === "retrying")).toEqual({ type: "retrying", attempt: 1, delayMs: 20, message: "529 overloaded" })
    expect(texts(events, "agent_message")).toEqual(["recovered"])
  })

  test("retries that give up end the turn with pi's final error", async () => {
    const { engine } = setup()
    const outcome = await engine.runTurn(turnInput({ text: "giveup" }).input)
    expect(outcome).toMatchObject({ status: "error", code: "pi_retry_failed" })
    expect((outcome as any).message).toContain("529 overloaded_error")
  })

  test("a pi without agent_settled ends after agent_end plus a quiet period, still waiting for retries and compaction", async () => {
    const { engine } = setup({ env: { FAKE_PI_OLD: "1" }, capabilities: { settled: false }, settleQuietMs: 150 })
    const sessionId = ids("session")
    for (const text of ["hello", "retry", "compaction"]) {
      const { input, events } = turnInput({ sessionId, text })
      expect(await engine.runTurn(input)).toEqual({ status: "ok" })
      expect(texts(events, "agent_message").at(-1)).toBe(text === "hello" ? "Hello there" : text === "retry" ? "recovered" : "part two")
    }
  })

  test("a prompt handled without any run (an extension command) ends through pi's own state, and a stale settled before the run is ignored", async () => {
    const { engine, commands } = setup()
    const sessionId = ids("session")
    expect(await engine.runTurn(turnInput({ sessionId, text: "slashcmd" }).input)).toEqual({ status: "ok" })
    expect(commands("get_state").length).toBeGreaterThanOrEqual(2)
    // The process is reusable right after.
    expect(await engine.runTurn(turnInput({ sessionId, text: "hello" }).input)).toEqual({ status: "ok" })
  })

  test("a pi error becomes a turn error, and an authentication failure points at pi's own login", async () => {
    const { engine } = setup()
    const auth = await engine.runTurn(turnInput({ text: "autherror" }).input)
    expect(auth).toMatchObject({ status: "error", code: "pi_auth" })
    expect((auth as any).message).toContain("sign in inside pi itself")
    expect(await engine.runTurn(turnInput({ text: "length" }).input)).toMatchObject({ status: "error", code: "pi_limit" })
  })

  test("no activity for the idle limit aborts the run", async () => {
    const { engine, commands } = setup({ idleMs: 150 })
    expect(await engine.runTurn(turnInput({ text: "silent" }).input)).toMatchObject({ status: "error", code: "stream_idle" })
    await Bun.sleep(50)
    expect(commands("abort")).toHaveLength(1)
  })
})

describe("queued messages", () => {
  test("a message queued while the run works is handed to pi as steer at the turn boundary", async () => {
    const { engine, commands } = setup()
    const { input, events } = turnInput({ text: "queued", queued: [{ text: "also do this", attachments: [] }] })
    expect(await engine.runTurn(input)).toEqual({ status: "ok" })
    expect(commands("steer")).toMatchObject([{ message: "also do this" }])
    expect(texts(events, "agent_message")).toEqual(["working", "steered:also do this"])
  })
})

describe("cancel", () => {
  test("clears pi's queue, then aborts, and the turn ends stopped", async () => {
    const { engine, received } = setup()
    const controller = new AbortController()
    const { input, events } = turnInput({ text: "slow", signal: controller.signal })
    const running = engine.runTurn(input)
    await Bun.sleep(200)
    controller.abort()
    expect(await running).toEqual({ status: "ok" })
    const order = received().map((message) => message.type).filter((type) => type === "clear_queue" || type === "abort")
    expect(order).toEqual(["clear_queue", "abort"])
    expect(texts(events, "agent_message")).toEqual(["working"])
  })

  test("stopping the engine during a turn ends that turn instead of leaving it waiting", async () => {
    const { engine } = setup()
    const running = engine.runTurn(turnInput({ text: "slow" }).input)
    await Bun.sleep(200)
    engine.stop()
    expect(await running).toMatchObject({ status: "error", code: "pi_stopped" })
  })

  test("a pi too old for clear_queue is still aborted", async () => {
    const { engine, commands } = setup({ env: { FAKE_PI_OLD: "1" }, capabilities: { settled: false }, settleQuietMs: 100 })
    const controller = new AbortController()
    const running = engine.runTurn(turnInput({ text: "slow", signal: controller.signal }).input)
    await Bun.sleep(200)
    controller.abort()
    expect(await running).toEqual({ status: "ok" })
    expect(commands("abort")).toHaveLength(1)
  })

  test("a pi that never answers abort is cut off after the grace period and resumes on the next turn", async () => {
    const { engine, spawned } = setup({ cancelGraceMs: 150, fileExists: () => true })
    const sessionId = ids("session")
    const controller = new AbortController()
    const running = engine.runTurn(turnInput({ sessionId, text: "deaf", signal: controller.signal }).input)
    await Bun.sleep(200)
    controller.abort()
    expect(await running).toEqual({ status: "ok" })
    expect(await engine.runTurn(turnInput({ sessionId, text: "hello" }).input)).toEqual({ status: "ok" })
    expect(spawned).toHaveLength(2)
    expect(spawned[1]).toContain("--session")
  })
})

describe("tool approvals", () => {
  for (const tool of ["write", "edit", "custom", "bash"]) {
    test(`session grants for ${tool} cover only identical arguments, including nested values`, async () => {
      const { engine } = setup()
      const sessionId = ids("session")
      const args = { path: "a.ts", content: "first", edits: [{ oldText: "a", newText: "b" }], command: "node first.js", timeout: 10 }
      const call = (input: object, answer?: () => EngineResolution) => turnInput({ sessionId, text: `tool ${tool} ${JSON.stringify(input)}`, ...(answer ? { answer } : {}) })
      const first = call(args, () => ({ kind: "approve", scope: "session" }))
      expect(await engine.runTurn(first.input)).toEqual({ status: "ok" })
      expect(first.asked).toHaveLength(1)
      const identical = call(Object.fromEntries(Object.entries(args).reverse()))
      await engine.runTurn(identical.input)
      expect(identical.asked).toHaveLength(0)
      expect(texts(identical.events, "agent_message")).toEqual(["picked:allow"])
      for (const changed of [{ ...args, path: "b.ts" }, { ...args, content: "second" }, { ...args, edits: [{ oldText: "a", newText: "c" }] }, { ...args, command: "node second.js" }, { ...args, timeout: 20 }]) {
        const next = call(changed)
        await engine.runTurn(next.input)
        expect(next.asked).toHaveLength(1)
        expect(texts(next.events, "agent_message")).toEqual(["picked:deny"])
      }
      const otherTool = turnInput({ sessionId, text: `tool other ${JSON.stringify(args)}` })
      await engine.runTurn(otherTool.input)
      expect(otherTool.asked).toHaveLength(1)
    })
  }

  test("smart bash uses native command analysis; a later refusal overrides an exact session grant", async () => {
    let refuse = false
    const { engine } = setup({ smartBash: ({ args, cwd }) => refuse ? "deny" : classifySmart({ tool: { name: "shell", permission: "execute" }, args, cwd }).decision })
    const sessionId = ids("session")
    const read = turnInput({ sessionId, text: 'tool bash {"command":"ls -la"}', mode: () => "smart" })
    await engine.runTurn(read.input)
    expect(read.asked).toHaveLength(0)
    expect(texts(read.events, "agent_message")).toEqual(["picked:allow"])
    const unknown = turnInput({ sessionId, text: 'tool bash {"command":"node script.js"}', mode: () => "smart", answer: () => ({ kind: "approve", scope: "session" }) })
    await engine.runTurn(unknown.input)
    expect(unknown.asked).toHaveLength(1)
    refuse = true
    const blocked = turnInput({ ...unknown.input, sessionId, text: unknown.input.text, mode: () => "smart" })
    await engine.runTurn(blocked.input)
    expect(blocked.asked).toHaveLength(0)
    expect(texts(blocked.events, "agent_message")).toEqual(["picked:deny"])
  })

  test("ask mode: the user is asked with the command, the tool card is linked, and approve lets pi run it", async () => {
    const { engine } = setup()
    const { input, asked, events } = turnInput({ text: "tool bash", answer: approve })
    expect(await engine.runTurn(input)).toEqual({ status: "ok" })
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ kind: "approval", title: "bash ls -la", detail: "ls -la", tool: "bash", permission: "execute" })
    const toolStarted = events.find((event) => event.type === "item.started" && event.kind === "tool_call") as any
    expect(asked[0]!.itemId).toBe(toolStarted.itemId)
    const toolDone = events.find((event) => event.type === "item.completed" && event.itemId === toolStarted.itemId) as any
    expect(toolDone).toMatchObject({ status: "ok", text: "file-list", toolInput: JSON.stringify({ command: "ls -la" }) })
    expect(texts(events, "agent_message")).toEqual(["picked:allow"])
  })

  test("deny, and an abandoned question, block the call", async () => {
    const { engine } = setup()
    const denied = turnInput({ text: "tool bash", answer: () => ({ kind: "deny" }) })
    await engine.runTurn(denied.input)
    expect(texts(denied.events, "agent_message")).toEqual(["picked:deny"])
    expect(items(denied.events, "tool_call")[0]).toMatchObject({ status: "error", text: "Not approved in MendCode" })
    const abandoned = turnInput({ text: "tool bash" })
    await engine.runTurn(abandoned.input)
    expect(texts(abandoned.events, "agent_message")).toEqual(["picked:deny"])
  })

  test("reads never ask, edits ask only in ask mode, full approves all, plan refuses what is not a read", async () => {
    const { engine } = setup()
    const read = turnInput({ text: "tool read" })
    await engine.runTurn(read.input)
    expect(read.asked).toHaveLength(0)
    expect(texts(read.events, "agent_message")).toEqual(["picked:allow"])

    const editAsk = turnInput({ text: "tool edit", answer: approve })
    await engine.runTurn(editAsk.input)
    expect(editAsk.asked).toMatchObject([{ tool: "edit", permission: "write", detail: expect.stringContaining("a.ts") }])

    const editEdits = turnInput({ text: "tool edit", mode: () => "edits" })
    await engine.runTurn(editEdits.input)
    expect(editEdits.asked).toHaveLength(0)
    expect(texts(editEdits.events, "agent_message")).toEqual(["picked:allow"])

    const bashEdits = turnInput({ text: "tool bash", mode: () => "edits", answer: approve })
    await engine.runTurn(bashEdits.input)
    expect(bashEdits.asked).toHaveLength(1)

    const full = turnInput({ text: "tool bash", mode: () => "full" })
    await engine.runTurn(full.input)
    expect(full.asked).toHaveLength(0)
    expect(texts(full.events, "agent_message")).toEqual(["picked:allow"])

    const plan = turnInput({ text: "tool edit", mode: () => "plan" })
    await engine.runTurn(plan.input)
    expect(plan.asked).toHaveLength(0)
    expect(texts(plan.events, "agent_message")).toEqual(["picked:deny"])
  })

  test("approve for the session covers that exact command, not other commands", async () => {
    const { engine } = setup()
    const sessionId = ids("session")
    const first = turnInput({ sessionId, text: "tool bash", answer: () => ({ kind: "approve", scope: "session" }) })
    await engine.runTurn(first.input)
    const again = turnInput({ sessionId, text: "tool bash" })
    await engine.runTurn(again.input)
    expect(again.asked).toHaveLength(0)
    expect(texts(again.events, "agent_message")).toEqual(["picked:allow"])
  })

  for (const mode of ["ask", "edits", "smart", "plan"] as const) {
    test(`missing bridge refuses even reads before prompting in ${mode} mode`, async () => {
      const { engine, commands } = setup({ env: { FAKE_PI_NO_GATE: "1" }, gateTimeoutMs: 80 })
      expect(await engine.runTurn(turnInput({ text: "tool read", mode: () => mode }).input)).toMatchObject({ status: "error", code: "pi_gate_missing" })
      expect(commands("prompt")).toHaveLength(0)
      expect(commands("extension_ui_response")).toHaveLength(0)
    })
  }

  test("full may run without a bridge, but switching the same process to ask requires one", async () => {
    const { engine, commands } = setup({ env: { FAKE_PI_NO_GATE: "1" }, gateTimeoutMs: 80 })
    const sessionId = ids("session")
    expect(await engine.runTurn(turnInput({ sessionId, text: "tool bash", mode: () => "full" }).input)).toEqual({ status: "ok" })
    expect(await engine.runTurn(turnInput({ sessionId, text: "tool read" }).input)).toMatchObject({ status: "error", code: "pi_gate_missing" })
    expect(commands("prompt")).toHaveLength(1)
  })

  test("a delayed handshake arrives before the tool's prompt", async () => {
    const { engine, received } = setup({ env: { FAKE_PI_GATE_DELAY: "100" }, gateTimeoutMs: 500 })
    expect(await engine.runTurn(turnInput({ text: "tool read" }).input)).toEqual({ status: "ok" })
    const log = received()
    expect(log.findIndex((entry) => entry.type === "bridge_ready")).toBeLessThan(log.findIndex((entry) => entry.type === "prompt"))
  })

  test("an unrelated or stale bridge status does not satisfy the process handshake", async () => {
    const { engine, commands } = setup({ env: { FAKE_PI_BAD_GATE: "1" }, gateTimeoutMs: 80 })
    expect(await engine.runTurn(turnInput({ text: "tool read" }).input)).toMatchObject({ status: "error", code: "pi_gate_missing" })
    expect(commands("prompt")).toHaveLength(0)
  })
})

describe("project trust and confinement", () => {
  test("a pi without a confirmed isolation flag refuses untrusted project resources before any process starts", async () => {
    let trusted = false
    const { engine, dir, spawned } = setup({ capabilities: { settled: true }, trusted: () => trusted })
    mkdirSync(join(dir, ".pi", "extensions"), { recursive: true })
    const sessionId = ids("session")
    const result = await engine.runTurn(turnInput({ sessionId, mode: () => "full" }).input)
    expect(result).toMatchObject({ status: "error", code: "pi_start", message: expect.stringContaining("cannot disable project extensions") })
    expect(spawned).toHaveLength(0)
    trusted = true
    expect(await engine.runTurn(turnInput({ sessionId }).input)).toEqual({ status: "ok" })
    trusted = false
    expect(await engine.runTurn(turnInput({ sessionId }).input)).toMatchObject({ status: "error" })
    expect(spawned).toHaveLength(1)
  })
  test("untrusted project extensions do not execute, even in full; trust enables discovery and revocation restarts pi", async () => {
    let trusted = false
    const { engine, dir, spawned } = setup({ trusted: () => trusted })
    const sessionId = ids("session")
    const extensions = join(dir, ".pi", "extensions")
    mkdirSync(extensions, { recursive: true })
    const marker = join(dir, "extension-ran")
    writeFileSync(join(extensions, "probe.ts"), `import { appendFileSync } from "node:fs"\nappendFileSync(${JSON.stringify(marker)}, "loaded\\n")\n`)
    const input = () => turnInput({ sessionId, mode: () => "full" }).input
    expect(await engine.runTurn(input())).toEqual({ status: "ok" })
    expect(existsSync(marker)).toBe(false)
    trusted = true
    expect(await engine.runTurn(input())).toEqual({ status: "ok" })
    expect(readFileSync(marker, "utf8")).toBe("loaded\n")
    expect(spawned[1]).not.toContain("--no-extensions")
    trusted = false
    expect(await engine.runTurn(input())).toEqual({ status: "ok" })
    expect(spawned).toHaveLength(3)
    expect(spawned[2]).toContain("--no-extensions")
    expect(readFileSync(marker, "utf8")).toBe("loaded\n")
  })

  for (const args of [["-e", "./.pi/extensions/probe.ts"], ["--extension", "npm:project-package"], ["--extension=./probe.ts"], ["--"]]) {
    test(`untrusted launch refuses unsafe extra args ${args[0]} before spawning`, async () => {
      const { engine, spawned } = setup({ args })
      expect(await engine.runTurn(turnInput({ mode: () => "full" }).input)).toMatchObject({ status: "error", code: "pi_start" })
      expect(spawned).toHaveLength(0)
    })
  }

  test("the OS policy reaches pi on every permission mode, and changes restart the process", async () => {
    let policy: SandboxPolicy | undefined
    const { engine, policies, dir, spawned } = setup({ sandbox: () => policy })
    const sessionId = ids("session")
    await engine.runTurn(turnInput({ sessionId }).input)
    expect(policies).toEqual([undefined])
    policy = { mode: "workspace-write", network: false, writable: [dir], protect: [join(dir, ".mendcode")] }
    await engine.runTurn(turnInput({ sessionId, mode: () => "full" }).input)
    expect(policies[1]).toEqual(policy)
    for (const mode of ["ask", "edits", "smart", "plan"] as const) await engine.runTurn(turnInput({ sessionId, mode: () => mode }).input)
    expect(spawned).toHaveLength(2)
    policy = { mode: "read-only", network: true, writable: [], protect: [] }
    await engine.runTurn(turnInput({ sessionId }).input)
    expect(policies[2]).toEqual(policy)
    expect(spawned).toHaveLength(3)
  })
})

describe("extension dialogs", () => {
  test("confirm is an approval; plan mode refuses it without asking", async () => {
    const { engine } = setup()
    const yes = turnInput({ text: "ext-confirm", answer: approve })
    await engine.runTurn(yes.input)
    expect(yes.asked[0]).toMatchObject({ kind: "approval", title: "Clear it?", detail: "All of it.", tool: "pi extension" })
    expect(texts(yes.events, "agent_message")).toEqual(['answer:{"confirmed":true}'])
    const no = turnInput({ text: "ext-confirm", answer: () => ({ kind: "deny" }) })
    await engine.runTurn(no.input)
    expect(texts(no.events, "agent_message")).toEqual(['answer:{"confirmed":false}'])
    const plan = turnInput({ text: "ext-confirm", mode: () => "plan" })
    await engine.runTurn(plan.input)
    expect(plan.asked).toHaveLength(0)
    expect(texts(plan.events, "agent_message")).toEqual(['answer:{"confirmed":false}'])
  })

  test("a select of options is a question, and only an offered option is accepted", async () => {
    const { engine } = setup()
    const picked = turnInput({ text: "ext-select", answer: () => ({ kind: "answer", text: "Green" }) })
    await engine.runTurn(picked.input)
    expect(picked.asked[0]).toMatchObject({ kind: "question", title: "Pick one", options: [{ label: "red" }, { label: "green" }] })
    expect(texts(picked.events, "agent_message")).toEqual(['answer:{"value":"green"}'])
    const other = turnInput({ text: "ext-select", answer: () => ({ kind: "answer", text: "blue" }) })
    await engine.runTurn(other.input)
    expect(texts(other.events, "agent_message")).toEqual(['answer:{"cancelled":true}'])
  })

  test("a select of allow and deny labels is an approval that answers with the matching label", async () => {
    const { engine } = setup()
    const yes = turnInput({ text: "ext-allow", answer: approve })
    await engine.runTurn(yes.input)
    expect(yes.asked[0]).toMatchObject({ kind: "approval", tool: "pi extension" })
    expect(texts(yes.events, "agent_message")).toEqual(['answer:{"value":"Yes"}'])
    const no = turnInput({ text: "ext-allow", answer: () => ({ kind: "deny" }) })
    await engine.runTurn(no.input)
    expect(texts(no.events, "agent_message")).toEqual(['answer:{"value":"No"}'])
  })

  test("input and editor return the typed text; an abandoned question cancels", async () => {
    const { engine } = setup()
    const input = turnInput({ text: "ext-input", answer: () => ({ kind: "answer", text: "Bob" }) })
    await engine.runTurn(input.input)
    expect(input.asked[0]).toMatchObject({ kind: "question", title: "Name?", detail: "x" })
    expect(texts(input.events, "agent_message")).toEqual(['answer:{"value":"Bob"}'])
    const editor = turnInput({ text: "ext-editor", answer: () => ({ kind: "answer", text: "final" }) })
    await engine.runTurn(editor.input)
    expect(editor.asked[0]).toMatchObject({ detail: "draft" })
    expect(texts(editor.events, "agent_message")).toEqual(['answer:{"value":"final"}'])
    const abandoned = turnInput({ text: "ext-input" })
    await engine.runTurn(abandoned.input)
    expect(texts(abandoned.events, "agent_message")).toEqual(['answer:{"cancelled":true}'])
  })
})

describe("process failures", () => {
  test("a crash mid-turn is reported with pi's last words", async () => {
    const { engine } = setup()
    const outcome = await engine.runTurn(turnInput({ text: "crash" }).input)
    expect(outcome).toMatchObject({ status: "error", code: "pi_exited" })
    expect((outcome as any).message).toContain("boom: pi crashed")
  })

  test("a question open when pi exits is withdrawn, its late answer goes nowhere, and the next turn resumes the session", async () => {
    const { engine, received, spawned } = setup({ fileExists: () => true })
    const sessionId = ids("session")
    let release: ((resolution: EngineResolution) => void) | undefined
    let withdrawn = false
    const first = turnInput({ sessionId, text: "dieasking" })
    first.input.ask = async (request) => {
      request.signal?.addEventListener("abort", () => (withdrawn = true), { once: true })
      return new Promise<EngineResolution>((resolve) => (release = resolve))
    }
    const outcome = await engine.runTurn(first.input)
    expect(outcome).toMatchObject({ status: "error", code: "pi_exited" })
    expect(withdrawn).toBe(true)
    release?.({ kind: "answer", text: "too late" })
    const next = turnInput({ sessionId, text: "hello" })
    expect(await engine.runTurn(next.input)).toEqual({ status: "ok" })
    expect(spawned).toHaveLength(2)
    expect(spawned[1]).toContain("--session")
    expect(received().filter((message) => message.type === "extension_ui_response")).toHaveLength(0)
  })
})

describe("compaction", () => {
  test("compaction requires the bridge except in full mode", async () => {
    let mode: PermissionMode = "plan"
    const { engine, commands } = setup({ env: { FAKE_PI_NO_GATE: "1" }, gateTimeoutMs: 80, permission: () => mode })
    const input = { sessionId: ids("session"), turnId: ids("turn"), signal: new AbortController().signal, newItemId: () => ids("item"), emit: () => {} }
    expect(await engine.compact(input)).toMatchObject({ status: "error", code: "pi_gate_missing" })
    expect(commands("compact")).toHaveLength(0)
    mode = "full"
    expect(await engine.compact(input)).toEqual({ status: "ok" })
    expect(commands("compact")).toHaveLength(1)
  })

  test("/compact is pi's compact, with the instructions, and shows pi's compaction card", async () => {
    const { engine, commands } = setup()
    const events: EngineEvent[] = []
    const outcome = await engine.compact({ sessionId: ids("session"), turnId: ids("turn"), signal: new AbortController().signal, newItemId: () => ids("item"), emit: (event) => void events.push(event), instructions: "keep the plan" })
    expect(outcome).toEqual({ status: "ok" })
    expect(commands("compact")).toMatchObject([{ customInstructions: "keep the plan" }])
    expect(texts(events, "compaction")).toEqual(["compacted:keep the plan (100 → 10 tokens)"])
    expect(engine.needsCompaction("x" as SessionId)).toBe(false)
  })
})

describe("config, version and probe", () => {
  test("pi.json: the file is the opt-in, bad entries disable pi, models become pi:<pattern>", () => {
    const dir = temp()
    const absent = createPiConfig({ dir })
    expect(absent.models()).toEqual([])
    expect(absent.owns("pi")).toBe(false)
    expect(createPiConfig({ dir, optedIn: () => true }).models().map((model) => model.id)).toEqual(["pi"])

    writeFileSync(join(dir, "pi.json"), JSON.stringify({ command: "pi-next", args: ["--no-skills"], env: { A: "1", B: "${MENDCODE_PI_TEST_VAR}" }, models: ["anthropic/sonnet", "anthropic/sonnet", "openai/gpt:high"], sessionDir: "/data/pi" }))
    process.env.MENDCODE_PI_TEST_VAR = "from-env"
    try {
      const config = createPiConfig({ dir })
      expect(config.resolved()).toEqual({ command: "pi-next", args: ["--no-skills"], env: { A: "1", B: "from-env" }, sessionDir: "/data/pi" })
      expect(config.models().map((model) => [model.id, model.engine])).toEqual([["pi", "pi"], ["pi:anthropic/sonnet", "pi"], ["pi:openai/gpt:high", "pi"]])
      expect(config.patternOf("pi:openai/gpt:high")).toBe("openai/gpt:high")
      expect(config.patternOf("pi:unknown")).toBeUndefined()
      expect(config.owns("pi")).toBe(true)
      expect(config.owns("pi:unknown")).toBe(false)
    } finally {
      delete process.env.MENDCODE_PI_TEST_VAR
    }

    writeFileSync(join(dir, "pi.json"), "{ nope")
    const broken = createPiConfig({ dir })
    expect(broken.models()).toEqual([])
    expect(broken.load().issues[0]).toContain("invalid JSON")
    expect(parsePiConfig(JSON.stringify({ models: [""] })).issues[0]).toContain("models")
  })

  test("the version decides whether agent_settled is relied on", () => {
    expect(parsePiVersion("pi 0.85.1\n")).toEqual([0, 85, 1])
    expect(parsePiVersion("no number")).toBeUndefined()
    expect(piCapabilities([0, 85, 1])).toEqual({ settled: true })
    expect(piCapabilities([0, 80, 4])).toEqual({ settled: true })
    expect(piCapabilities([0, 80, 3])).toEqual({ settled: false })
    expect(piCapabilities([0, 79, 9])).toEqual({ settled: false })
    expect(piCapabilities([1, 0, 0])).toEqual({ settled: true })
    expect(piCapabilities(undefined)).toEqual({ settled: false })
  })

  test("the probe reads --version and fails quietly when there is no pi", async () => {
    expect(await probePi({ command: process.execPath, args: [FAKE], env: { FAKE_PI_VERSION: "0.80.2" } })).toEqual({ ok: true, version: "0.80.2", capabilities: { settled: false, disableExtensions: true } })
    expect(await probePi({ command: process.execPath, args: [FAKE] })).toMatchObject({ ok: true, version: "0.85.1", capabilities: { settled: true } })
    expect(await probePi({ command: "definitely-not-a-pi-binary-xyz" })).toEqual({ ok: false })
    expect(await probePi({ command: process.execPath, args: [FAKE], env: { FAKE_PI_NO_ISOLATION: "1" } })).toMatchObject({ ok: true, capabilities: { disableExtensions: false } })
  })
})

describe("the bridge", () => {
  test("classifies pi's tools and formats what an approval shows", () => {
    expect(["read", "grep", "find", "ls"].map(piToolPermission)).toEqual(["read", "read", "read", "read"])
    expect(["write", "edit"].map(piToolPermission)).toEqual(["write", "write"])
    expect(["bash", "mcp_thing"].map(piToolPermission)).toEqual(["execute", "execute"])
    expect(gateDetail({ id: "1", tool: "bash", input: { command: "ls" } })).toBe("ls")
    expect(gateDetail({ id: "1", tool: "write", input: { path: "a.txt", content: "hi" } })).toBe("a.txt\n\nhi")
    expect(parseGateRequest(`${GATE_MARK}${JSON.stringify({ id: "x", tool: "bash", input: { command: "ls" } })}`)).toEqual({ id: "x", tool: "bash", input: { command: "ls" } })
    expect(parseGateRequest("Allow?")).toBeUndefined()
    expect(parseGateRequest(`${GATE_MARK}{broken`)).toBeUndefined()
  })

  test("the engine never touches pi's own files or credentials", () => {
    const sources = readdirSync(join(import.meta.dir, "../src")).map((name) => readFileSync(join(import.meta.dir, "../src", name), "utf8"))
    for (const source of sources) {
      expect(source).not.toMatch(/auth\.json|homedir\(|["'`]~\/\.pi|\.pi\/agent|process\.env\.HOME/)
    }
  })
})

describe("routing", () => {
  const base = (log: string[]): EnginePort => ({
    runTurn: async () => (log.push("base"), { status: "ok" }),
    needsCompaction: () => true,
    compact: async () => (log.push("base-compact"), { status: "ok" }),
  })
  const piPort = (log: string[]): EnginePort => ({
    runTurn: async () => (log.push("pi"), { status: "ok" }),
    needsCompaction: () => false,
    compact: async () => (log.push("pi-compact"), { status: "ok" }),
  })

  test("pi sessions go to the lazily created pi engine, everything else to the base", async () => {
    const log: string[] = []
    let created = 0
    let initialized: SessionId | undefined
    const router = withPiEngine({
      base: base(log),
      pi: async (sessionId) => {
        initialized = sessionId
        created++
        return piPort(log)
      },
      usesPi: (sessionId) => sessionId === ("pi-session" as SessionId),
    })
    expect(created).toBe(0)
    await router.runTurn(turnInput({ sessionId: "other" as SessionId }).input)
    expect(created).toBe(0)
    await router.runTurn(turnInput({ sessionId: "pi-session" as SessionId }).input)
    await router.runTurn(turnInput({ sessionId: "pi-session" as SessionId }).input)
    expect(created).toBe(1)
    expect(String(initialized)).toBe("pi-session")
    expect(router.needsCompaction("pi-session" as SessionId)).toBe(false)
    expect(router.needsCompaction("other" as SessionId)).toBe(true)
    const compaction = { turnId: ids("turn"), signal: new AbortController().signal, newItemId: () => ids("item"), emit: () => undefined }
    await router.compact({ sessionId: "pi-session" as SessionId, ...compaction })
    await router.compact({ sessionId: "other" as SessionId, ...compaction })
    expect(log).toEqual(["base", "pi", "pi", "pi-compact", "base-compact"])
  })

  test("an engine that cannot be created fails the turn with pi_unavailable and is retried next turn", async () => {
    let attempts = 0
    const router = withPiEngine({ base: base([]), pi: async () => { attempts++; throw new Error("no pi") }, usesPi: () => true })
    expect(await router.runTurn(turnInput().input)).toEqual({ status: "error", code: "pi_unavailable", message: "[PI]: no pi" })
    await router.runTurn(turnInput().input)
    expect(attempts).toBe(2)
  })
})
