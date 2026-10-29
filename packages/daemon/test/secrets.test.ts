import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient, type Client } from "@mendcode/client"
import { createNativeEngine, type ModelEvent, type ModelMessage, type ModelProvider, type ModelRequest } from "@mendcode/engine-native"
import { createIdFactory, type SecretInfo, type SessionEvent, type SessionId } from "@mendcode/protocol"
import { openStore, secretsKeyPath, type Store } from "@mendcode/store"
import { edit, read, shell, write } from "@mendcode/tools"
import { startDaemon, type MemoryAccess } from "../src"
import { createSecretsService } from "../src/secrets"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
beforeEach(() => {
  ;(globalThis as { __seen?: string[] }).__seen = []
})

/** Fake credentials derived from a label: distinct from each other and never a real secret. */
const fake = (label: string, length: number) => new Bun.CryptoHasher("sha256").update(`fake:${label}`).digest("hex").repeat(Math.ceil(length / 64)).slice(0, length)
const SECRETS = {
  openai: "s" + "k-" + fake("openai", 48),
  github: "gh" + "p_" + fake("github", 36),
  awsKey: "AK" + "IA" + "ABCDEFGHIJKLMNOP",
  awsSecret: fake("aws-secret", 40),
  jwt: "ey" + "J" + fake("jwt-a", 20) + "." + "ey" + "J" + fake("jwt-b", 30) + "." + fake("jwt-c", 43),
  password: fake("password", 20),
}
const PASTED = `openai ${SECRETS.openai}
github ${SECRETS.github}
AWS_ACCESS_KEY_ID=${SECRETS.awsKey}
AWS_SECRET_ACCESS_KEY=${SECRETS.awsSecret}
jwt ${SECRETS.jwt}
PASSWORD=${SECRETS.password}`
const RAW = Object.values(SECRETS)

const stop = (text: string): ModelEvent[] => [{ type: "text", delta: text }, { type: "finish", reason: "stop" }]
const callTool = (name: string, args: unknown, callId = `call-${name}-${Math.random().toString(36).slice(2, 8)}`): ModelEvent[] => [{ type: "tool_call", call: { callId, name, args } }, { type: "finish", reason: "tool_calls" }]

function scripted(steps: ModelEvent[][]) {
  const requests: ModelRequest[] = []
  const provider: ModelProvider = {
    id: "scripted",
    model: "script-1",
    async *stream(request) {
      requests.push({ ...request, messages: structuredClone(request.messages) })
      const step = steps.shift()
      if (!step) throw new Error("script exhausted: the model must not be called here")
      yield* step
    },
  }
  return { provider, requests, steps }
}

async function until(check: () => boolean, ms = 8_000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out")
    await new Promise((r) => setTimeout(r, 10))
  }
}

const tempDir = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

type Boot = { dir?: string; project?: string; steps?: ModelEvent[][]; complete?: (input: { prompt: string }) => Promise<string>; setup?(dir: string): void }

async function boot(options: Boot = {}) {
  const dir = options.dir ?? tempDir("mendd-sec-")
  const project = options.project ?? tempDir("mendd-sec-proj-")
  options.setup?.(dir)
  const script = scripted(options.steps ?? [])
  let handles!: { store: Store; memory: MemoryAccess }
  const tools = [shell, write, edit, read]
  const daemon = await startDaemon({
    dir,
    socketPath: path.join(dir, "mendd.sock"),
    log: () => {},
    extensionHookTimeoutMs: 500,
    ...(options.complete ? { complete: async (input: { prompt: string }) => options.complete!(input) } : {}),
    engine: ({ store, secrets, background, memory, extensions }) => {
      handles = { store, memory }
      extensions.setBuiltinTools(tools)
      return createNativeEngine({
        provider: script.provider,
        tools,
        secrets,
        background,
        hooks: extensions.hooks,
        history: {
          load: async (sessionId) => {
            const messages = store.engineMessages.load(sessionId, "native") as ModelMessage[]
            return messages.length ? messages : undefined
          },
          save: async (sessionId, messages) => store.engineMessages.save(sessionId, "native", messages),
          replace: async (sessionId, messages) => store.engineMessages.replace(sessionId, "native", messages),
        },
        cwdFor: (sessionId) => store.sessionDirectory(sessionId) || project,
        system: () => "BASE",
        compactionPrompt: "SUMMARIZE",
        projectTools: (root, sessionId) => extensions.tools(root, sessionId),
      })
    },
  })
  let stopped = false
  const stopDaemon = async () => {
    if (stopped) return
    stopped = true
    await daemon.stop()
  }
  cleanups.push(stopDaemon)
  const events: SessionEvent[] = []
  const client = createClient({ socketPath: daemon.socketPath, name: "secrets", onEvent: (event) => void events.push(event) })
  await client.connect()
  cleanups.push(() => client.close())
  return { dir, project, daemon, client, events, store: handles.store, memory: handles.memory, requests: script.requests, stopDaemon }
}
type Harness = Awaited<ReturnType<typeof boot>>

async function open(h: Harness, existing?: SessionId) {
  let sessionId = existing
  if (!sessionId) {
    const created = await h.client.send({ type: "session.create", directory: h.project })
    sessionId = (created.ok ? created.result?.sessionId : undefined) as SessionId
  }
  await h.client.subscribe(sessionId, 0)
  return sessionId
}

const finished = (h: Harness) => h.events.filter((e) => e.type === "turn.completed" || e.type === "turn.failed").length
async function say(h: Harness, sessionId: SessionId, text: string) {
  const before = finished(h)
  const ack = await h.client.send({ type: "user.submit", sessionId, text, attachments: [] })
  if (ack.ok) await until(() => finished(h) > before)
  return ack
}

const full = (h: Harness, sessionId: SessionId) => h.client.send({ type: "session.permission.set", sessionId, mode: "full" })

/** Every byte of the database and its write-ahead log. */
function databaseBytes(dir: string) {
  return Buffer.concat(readdirSync(dir).filter((name) => name.startsWith("mendd.db")).map((name) => readFileSync(path.join(dir, name))))
}

/** Everything the store keeps about a session in readable form, plus the events a client received. */
function storedText(h: Harness, sessionId: SessionId) {
  return JSON.stringify({
    events: h.store.readAfter(sessionId, 0, 10_000),
    queue: h.store.queueOf(sessionId),
    history: h.store.engineMessages.load(sessionId, "native"),
    prompts: h.store.promptHistory(h.project),
    sessions: h.store.listSessions({}),
    draft: h.store.drafts.get(sessionId),
    received: h.events,
  })
}

function expectNoRaw(text: string | Buffer, values: string[] = RAW) {
  for (const value of values) expect(text.includes(value)).toBe(false)
}

const listed = async (client: Client, sessionId: SessionId) => {
  const reply = await client.send({ type: "secrets.list", sessionId })
  if (!reply.ok) throw new Error(reply.error.message)
  return reply.result?.secrets as SecretInfo[]
}

describe("pasted secrets", () => {
  test("OpenAI, GitHub, AWS, JWT and PASSWORD= values become markers in every stored place and in what the model sees", async () => {
    const h = await boot({ steps: [stop("noted")] })
    const sessionId = await open(h)
    expect(await say(h, sessionId, `please remember these\n${PASTED}`)).toMatchObject({ ok: true })

    const queued = h.events.find((e) => e.type === "queue.added")
    expect(queued).toMatchObject({ type: "queue.added" })
    const text = (queued as { text: string }).text
    for (const n of [1, 2, 3, 4, 5, 6]) expect(text).toContain(`‹secret:${n}›`)
    // Numbers follow detection order: self-identifying tokens first, then NAME=value assignments.
    expect(text).toContain("AWS_SECRET_ACCESS_KEY=‹secret:5›")
    expect(text).toContain("PASSWORD=‹secret:6›")

    expect((await listed(h.client, sessionId)).map((s) => s.kind)).toEqual(["openai-key", "github-token", "aws-access-key-id", "jwt", "aws-secret", "password"])
    // The model got the markers and a note on how to use them, never a value.
    const first = h.requests[0]!
    expect(first.messages[0]).toMatchObject({ role: "user" })
    expect(JSON.stringify(first)).toContain("‹secret:1›")
    expect(first.system).toContain("The user pasted secrets")
    expectNoRaw(JSON.stringify(first))

    expectNoRaw(storedText(h, sessionId))
    expect(h.store.promptHistory(h.project)[0]).toContain("‹secret:1›")
    expect(h.store.listSessions({})[0]!.title).not.toContain(SECRETS.openai)
    // The database and its WAL, while the daemon runs and after it stops.
    expectNoRaw(databaseBytes(h.dir))
    await h.stopDaemon()
    expectNoRaw(databaseBytes(h.dir))
  })

  test("the same value twice is the same marker; a new value is the next number", async () => {
    const h = await boot({ steps: [stop("one"), stop("two")] })
    const sessionId = await open(h)
    await say(h, sessionId, `key ${SECRETS.openai}`)
    await say(h, sessionId, `again ${SECRETS.openai} and now ${SECRETS.github} and ${SECRETS.openai}`)
    const texts = h.events.filter((e) => e.type === "queue.added").map((e) => (e as { text: string }).text)
    expect(texts).toEqual(["key ‹secret:1›", "again ‹secret:1› and now ‹secret:2› and ‹secret:1›"])
    expect(await listed(h.client, sessionId)).toHaveLength(2)
  })

  test("a value the detectors would miss is still masked once it is known", async () => {
    const h = await boot({ steps: [stop("one"), stop("two")] })
    const sessionId = await open(h)
    const plain = fake("plain", 24)
    await say(h, sessionId, `PASSWORD=${plain}`)
    await say(h, sessionId, `the password is ${plain}, please use it`)
    expect(h.events.filter((e) => e.type === "queue.added").map((e) => (e as { text: string }).text)[1]).toBe("the password is ‹secret:1›, please use it")
    expectNoRaw(storedText(h, sessionId), [plain])
  })

  test("an unsent draft with a secret is stored as its marker", async () => {
    const h = await boot()
    const sessionId = await open(h)
    expect(await h.client.send({ type: "draft.set", sessionId, text: `half typed PASSWORD=${SECRETS.password}` })).toMatchObject({ ok: true })
    const draft = await h.client.send({ type: "draft.get", sessionId })
    expect(draft.ok && (draft.result?.draft as { text: string }).text).toBe("half typed PASSWORD=‹secret:1›")
    expectNoRaw(databaseBytes(h.dir), [SECRETS.password])
  })
})

describe("using a secret through tools", () => {
  test("the approval shows the marker; after approval the shell command receives the real value", async () => {
    const command = "printf %s '‹secret:1›' > token.txt"
    const h = await boot({ steps: [callTool("shell", { command }), stop("written")] })
    const sessionId = await open(h)
    const before = finished(h)
    await h.client.send({ type: "user.submit", sessionId, text: `write my token to a file. TOKEN=${fake("token", 32)}`, attachments: [] })
    await until(() => h.events.some((e) => e.type === "server.request"))
    const request = h.events.find((e) => e.type === "server.request") as Extract<SessionEvent, { type: "server.request" }>
    expect(request.detail).toContain("‹secret:1›")
    expectNoRaw(request.detail, [fake("token", 32)])
    expect(existsSync(path.join(h.project, "token.txt"))).toBe(false)

    await h.client.send({ type: "request.resolve", sessionId, requestId: request.requestId, decision: { kind: "approve", scope: "once" } })
    await until(() => finished(h) > before)
    expect(readFileSync(path.join(h.project, "token.txt"), "utf8")).toBe(fake("token", 32))
    expectNoRaw(storedText(h, sessionId), [fake("token", 32)])
    expectNoRaw(databaseBytes(h.dir), [fake("token", 32)])
  })

  test("output that contains the value is masked before the model and the event log see it (cat .env)", async () => {
    const h = await boot({ steps: [callTool("shell", { command: "printf 'API_TOKEN=%s\\n' '‹secret:1›' > .env" }), callTool("shell", { command: "cat .env" }), stop("done")] })
    const sessionId = await open(h)
    await full(h, sessionId)
    await say(h, sessionId, `PASSWORD=${SECRETS.password} put it in .env then cat it`)
    expect(readFileSync(path.join(h.project, ".env"), "utf8")).toBe(`API_TOKEN=${SECRETS.password}\n`)
    const toolOutputs = h.requests.at(-1)!.messages.filter((m) => m.role === "tool").map((m) => (m as { output: string }).output)
    expect(toolOutputs.at(-1)).toContain("API_TOKEN=‹secret:1›")
    expectNoRaw(JSON.stringify(h.requests), [SECRETS.password])
    const completed = h.events.filter((e) => e.type === "item.completed")
    expect(completed.map((e) => (e as { text?: string }).text).join("\n")).toContain("API_TOKEN=‹secret:1›")
    expectNoRaw(storedText(h, sessionId), [SECRETS.password])
    expectNoRaw(databaseBytes(h.dir), [SECRETS.password])
  })

  test("write and edit resolve markers in their content, and read shows them masked again", async () => {
    const h = await boot({
      steps: [
        callTool("write", { path: "config.env", content: "KEY=‹secret:1›\nMODE=dev\n" }),
        callTool("edit", { path: "config.env", oldString: "MODE=dev", newString: "MODE=prod TOKEN=‹secret:1›" }),
        callTool("read", { path: "config.env" }),
        stop("done"),
      ],
    })
    const sessionId = await open(h)
    await full(h, sessionId)
    await say(h, sessionId, `PASSWORD=${SECRETS.password} write a config`)
    expect(readFileSync(path.join(h.project, "config.env"), "utf8")).toBe(`KEY=${SECRETS.password}\nMODE=prod TOKEN=${SECRETS.password}\n`)
    const toolOutputs = h.requests.at(-1)!.messages.filter((m) => m.role === "tool").map((m) => (m as { output: string }).output)
    expect(toolOutputs.at(-1)).toContain("KEY=‹secret:1›")
    expectNoRaw(JSON.stringify(h.requests), [SECRETS.password])
    expectNoRaw(storedText(h, sessionId), [SECRETS.password])
  })

  test("the secrets tool lists markers, kinds and tails and no value", async () => {
    const h = await boot({ steps: [callTool("secrets", {}), stop("ok")] })
    const sessionId = await open(h)
    await say(h, sessionId, `OPENAI ${SECRETS.openai}`)
    const output = (h.requests.at(-1)!.messages.filter((m) => m.role === "tool")[0] as { output: string }).output
    expect(output).toBe(`‹secret:1› openai-key …${SECRETS.openai.slice(-4)}`)
    expect(h.requests[0]!.system).toContain("secrets")
  })

  test("a background command with a marker is listed and announced masked", async () => {
    const h = await boot({ steps: [callTool("shell", { command: "echo '‹secret:1›'; sleep 30", background: true }), stop("started")] })
    const sessionId = await open(h)
    await full(h, sessionId)
    await say(h, sessionId, `PASSWORD=${SECRETS.password} run it in the background`)
    const tasks = await h.client.send({ type: "background.list", sessionId })
    expect(tasks.ok && JSON.stringify(tasks.result)).toContain("‹secret:1›")
    expectNoRaw(JSON.stringify(tasks), [SECRETS.password])
  })

  test("a forgotten secret no longer resolves", async () => {
    const h = await boot({ steps: [stop("noted"), callTool("shell", { command: "printf %s '‹secret:1›' > out.txt" }), stop("done")] })
    const sessionId = await open(h)
    await full(h, sessionId)
    await say(h, sessionId, `PASSWORD=${SECRETS.password}`)
    expect(await h.client.send({ type: "secrets.forget", sessionId, n: 1 })).toMatchObject({ ok: true })
    expect(await h.client.send({ type: "secrets.forget", sessionId, n: 1 })).toMatchObject({ ok: false, error: { code: "target_mismatch" } })
    expect(await listed(h.client, sessionId)).toEqual([])
    await say(h, sessionId, "now write it")
    expect(readFileSync(path.join(h.project, "out.txt"), "utf8")).toBe("‹secret:1›")
  })
})

describe("secrets.* commands", () => {
  test("list shows number, kind, tail and time; reveal is the only way to get a value", async () => {
    const h = await boot({ steps: [stop("ok")] })
    const sessionId = await open(h)
    await say(h, sessionId, `PASSWORD=${SECRETS.password}`)
    const entries = await listed(h.client, sessionId)
    expect(entries).toMatchObject([{ n: 1, kind: "password", tail: SECRETS.password.slice(-4) }])
    expect(entries[0]!.createdAt).toBeGreaterThan(0)
    expectNoRaw(JSON.stringify(entries), [SECRETS.password])
    expect(await h.client.send({ type: "secrets.reveal", sessionId, n: 1 })).toMatchObject({ ok: true, result: { value: SECRETS.password } })
    expect(await h.client.send({ type: "secrets.reveal", sessionId, n: 9 })).toMatchObject({ ok: false, error: { code: "target_mismatch" } })
    expect(await h.client.send({ type: "secrets.list", sessionId: "ses_01M3K99AR430RP1AGHZQN64R74" as SessionId })).toMatchObject({ ok: false, error: { code: "unknown_session" } })
  })

  test("deleting the session deletes its secrets", async () => {
    const h = await boot({ steps: [stop("ok")] })
    const sessionId = await open(h)
    await say(h, sessionId, `PASSWORD=${SECRETS.password}`)
    expect(h.store.secrets.list(sessionId)).toHaveLength(1)
    expect(await h.client.send({ type: "session.delete", sessionId })).toMatchObject({ ok: true })
    expect(h.store.secrets.list(sessionId)).toEqual([])
    expect(h.store.secrets.values(sessionId)).toEqual([])
  })

  test("a fork resolves the same markers", async () => {
    const h = await boot({ steps: [stop("ok")] })
    const sessionId = await open(h)
    await say(h, sessionId, `PASSWORD=${SECRETS.password}`)
    const fork = await h.client.send({ type: "session.fork", sessionId })
    const forkId = (fork.ok ? fork.result?.sessionId : undefined) as SessionId
    expect(await listed(h.client, forkId)).toMatchObject([{ n: 1, kind: "password" }])
    expect(await h.client.send({ type: "secrets.reveal", sessionId: forkId, n: 1 })).toMatchObject({ ok: true, result: { value: SECRETS.password } })
  })
})

describe("restart and the key file", () => {
  test("after a restart the markers still resolve", async () => {
    const dir = tempDir("mendd-sec-")
    const project = tempDir("mendd-sec-proj-")
    const first = await boot({ dir, project, steps: [stop("ok")] })
    const sessionId = await open(first)
    await say(first, sessionId, `PASSWORD=${SECRETS.password}`)
    await first.stopDaemon()
    expect(statModeOf(secretsKeyPath(dir))).toBe(0o600)

    const second = await boot({ dir, project, steps: [callTool("shell", { command: "printf %s '‹secret:1›' > after-restart.txt" }), stop("done")] })
    await open(second, sessionId)
    await full(second, sessionId)
    await say(second, sessionId, "use the secret again")
    expect(readFileSync(path.join(project, "after-restart.txt"), "utf8")).toBe(SECRETS.password)
    expectNoRaw(databaseBytes(dir), [SECRETS.password])
  })

  test("a wrong key file is a clear error when revealing or pasting another secret, and the message is not sent", async () => {
    const dir = tempDir("mendd-sec-")
    const project = tempDir("mendd-sec-proj-")
    const first = await boot({ dir, project, steps: [stop("ok")] })
    const sessionId = await open(first)
    await say(first, sessionId, `PASSWORD=${SECRETS.password}`)
    await first.stopDaemon()
    const original = readFileSync(secretsKeyPath(dir))
    writeFileSync(secretsKeyPath(dir), Buffer.alloc(32, 9))

    const second = await boot({ dir, project })
    await open(second, sessionId)
    const reveal = await second.client.send({ type: "secrets.reveal", sessionId, n: 1 })
    expect(reveal).toMatchObject({ ok: false, error: { code: "internal" } })
    expect(!reveal.ok && reveal.error.message).toMatch(/does not decrypt with .*secrets\.key/)
    const before = second.events.filter((e) => e.type === "queue.added").length
    const paste = await second.client.send({ type: "user.submit", sessionId, text: `OPENAI ${SECRETS.openai}`, attachments: [] })
    expect(paste).toMatchObject({ ok: false, error: { code: "internal" } })
    expect(second.events.filter((e) => e.type === "queue.added")).toHaveLength(before)
    expectNoRaw(databaseBytes(dir), [SECRETS.openai])
    await second.stopDaemon()

    writeFileSync(secretsKeyPath(dir), original)
    const third = await boot({ dir, project })
    await open(third, sessionId)
    expect(await third.client.send({ type: "secrets.reveal", sessionId, n: 1 })).toMatchObject({ ok: true, result: { value: SECRETS.password } })
  })
})

describe("other readers of a session", () => {
  test("/btw sees the marker, never the value", async () => {
    const h = await boot({ complete: async () => "", steps: [stop("answer")] })
    const sessionId = await open(h)
    const reply = await h.client.send({ type: "session.aside", sessionId, text: `is ${SECRETS.openai} a valid key?` })
    expect(reply).toMatchObject({ ok: true, result: { text: "answer" } })
    const sent = JSON.stringify(h.requests[0]!.messages)
    expect(sent).toContain("‹secret:1›")
    expectNoRaw(sent, [SECRETS.openai])
  })

  test("extension input and tool hooks see markers and masked output, never a value", async () => {
    const extension = `export default { name: "spy", daemon(api) { api.on("input", (e) => { globalThis.__seen.push("input:" + e.text) }); api.on("tool.before", (e) => { globalThis.__seen.push("before:" + e.args.command) }); api.on("tool.after", (e) => { globalThis.__seen.push("after:" + e.output) }) } }\n`
    const h = await boot({
      steps: [callTool("shell", { command: "printf %s '‹secret:1›'" }), stop("done")],
      setup: (dir) => {
        mkdirSync(path.join(dir, "extensions"), { recursive: true })
        writeFileSync(path.join(dir, "extensions", "spy.ts"), extension)
      },
    })
    const sessionId = await open(h)
    await full(h, sessionId)
    await say(h, sessionId, `PASSWORD=${SECRETS.password} print it`)
    const seen = (globalThis as { __seen?: string[] }).__seen!
    expect(seen).toEqual(["input:PASSWORD=‹secret:1› print it", "before:printf %s '‹secret:1›'", "after:‹secret:1›"])
    expectNoRaw(seen.join("\n"), [SECRETS.password])
  })

  test("a memory the agent proposes with a secret still in it is redacted", async () => {
    const h = await boot()
    h.memory.propose({ scope: "user", text: `the key is ${SECRETS.openai}`, category: "" })
    const stored = h.store.memories.list({ status: "pending" })
    expect(stored).toHaveLength(1)
    expect(stored[0]!.text).toBe("the key is [redacted:openai-key]")
  })
})

describe("live output masking", () => {
  test("a secret cut in two by output chunks never appears, however the chunks fall", () => {
    const dir = tempDir("mendd-sec-")
    const store = openStore({ dir })
    cleanups.push(() => store.close())
    const sessionId = createIdFactory()("session")
    store.createSession({ id: sessionId, directory: "/repo", title: "t" })
    const service = createSecretsService({ store, log: () => {} })
    expect(service.capture(sessionId, `PASSWORD=${SECRETS.password}`)).toEqual({ text: "PASSWORD=‹secret:1›" })

    const output = `start ${SECRETS.password} middle ${JSON.stringify(SECRETS.password)} end ${SECRETS.password}`
    const expected = "start ‹secret:1› middle \"‹secret:1›\" end ‹secret:1›"
    for (let cut = 0; cut <= output.length; cut++) {
      const stream = service.stream(sessionId)!
      const joined = stream.push(output.slice(0, cut)) + stream.push(output.slice(cut)) + stream.flush()
      expect(joined).toBe(expected)
    }
    const stream = service.stream(sessionId)!
    let byChar = ""
    for (const char of output) byChar += stream.push(char)
    expect(byChar + stream.flush()).toBe(expected)
  })

  test("a rotated credential stays masked after another secret is pasted", () => {
    const dir = tempDir("mendd-sec-")
    const store = openStore({ dir })
    cleanups.push(() => store.close())
    const sessionId = createIdFactory()("session")
    store.createSession({ id: sessionId, directory: "/repo", title: "t" })
    const service = createSecretsService({ store, log: () => {} })
    const before = fake("rotated-before", 24)
    store.environment.set({ name: "INSTABOX_KEY", value: before, scope: "session", sessionId, directory: "/repo" })
    expect(service.mask(sessionId, `old ${before}`)).toBe("old ‹env:INSTABOX_KEY›")
    store.environment.set({ name: "INSTABOX_KEY", value: fake("rotated-after", 24), scope: "session", sessionId, directory: "/repo" })
    expect(service.capture(sessionId, `PASSWORD=${SECRETS.password}`)).toEqual({ text: "PASSWORD=‹secret:1›" })
    // A background process started before the rotation may still print the old value.
    expect(service.mask(sessionId, `old ${before}`)).toBe("old ‹env:INSTABOX_KEY›")
  })

  test("a session without secrets costs nothing: no stream, text untouched", () => {
    const dir = tempDir("mendd-sec-")
    const store = openStore({ dir })
    cleanups.push(() => store.close())
    const sessionId = createIdFactory()("session")
    store.createSession({ id: sessionId, directory: "/repo", title: "t" })
    const service = createSecretsService({ store, log: () => {} })
    expect(service.stream(sessionId)).toBeUndefined()
    expect(service.mask(sessionId, "nothing here")).toBe("nothing here")
    expect(service.capture(sessionId, "plain prose")).toEqual({ text: "plain prose" })
  })
})

const statModeOf = (file: string) => statSync(file).mode & 0o777
