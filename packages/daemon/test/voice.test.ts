import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createVirtualClock } from "@mendcode/kernel"
import { Settings, isReadOnlyCommand, type SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { createChannelBridge, type BridgeHost } from "../src/channels-bridge"
import { createChannelsConfig, createPairing } from "../src/channels-config"
import { createTelegramApi, type TelegramUpdate } from "../src/channels-telegram"
import { remoteTokens } from "../src/remote"
import { createVoice, type VoiceRecorder } from "../src/voice"
import { createVoiceRecorder, recorderTools } from "../src/voice-recorder"
import type { LocalDictation, LocalLive } from "../src/voice-local"

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

function temp() {
  const root = mkdtempSync(path.join(tmpdir(), "mend-voice-"))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  return root
}

/** A microphone that writes `bytes` of "audio" when recording starts. */
function fakeRecorder(options: { name?: string | undefined; bytes?: number; fail?: string } = {}) {
  const calls = { started: [] as string[], stops: 0, kills: 0 }
  const recorder: VoiceRecorder = {
    name: () => ("name" in options ? options.name : "fakerec"),
    async start(file) {
      if (options.fail) throw new Error(options.fail)
      calls.started.push(file)
      writeFileSync(file, new Uint8Array(options.bytes ?? 5000))
      return { async stop() { calls.stops++ }, kill() { calls.kills++ } }
    },
  }
  return { recorder, calls }
}

type Seen = { url: string; headers: Record<string, string>; model: string | null; language: string | null; format: string | null; file: { name: string; type: string; size: number } }
function fakeFetch(respond: () => Response = () => Response.json({ text: "  hola mundo  " })) {
  const seen: Seen[] = []
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const form = init!.body as FormData
    const file = form.get("file") as File
    seen.push({ url: String(input), headers: Object.fromEntries(new Headers(init!.headers).entries()), model: form.get("model") as string | null, language: form.get("language") as string | null, format: form.get("response_format") as string | null, file: { name: file.name, type: file.type, size: file.size } })
    return respond()
  }) as typeof fetch
  return { fetcher, seen }
}

function service(options: { voice?: Settings["voice"]; recorder?: ReturnType<typeof fakeRecorder>; fetch?: ReturnType<typeof fakeFetch>; credentials?: boolean } = {}) {
  const dir = temp()
  const clock = createVirtualClock()
  const recorder = options.recorder ?? fakeRecorder()
  const http = options.fetch ?? fakeFetch()
  const voice = createVoice({
    dir, clock, recorder: recorder.recorder, fetch: http.fetcher,
    settings: () => ({ voice: options.voice }) as Settings,
    ...(options.credentials === false ? {} : { credentials: (provider: string) => provider === "openai" || provider === "groq" ? { baseUrl: `https://api.${provider}.test/v1/`, headers: { authorization: `Bearer sk-secret-${provider}`, "content-type": "application/json" } } : undefined }),
  })
  cleanups.push(() => voice.dispose())
  return { dir, clock, voice, recorder, http, owner: {}, files: () => { try { return readdirSync(path.join(dir, "voice")) } catch { return [] } } }
}

describe("dictation service", () => {
  test("off by default: nothing is recorded or uploaded", async () => {
    const h = service()
    expect(await h.voice.start(h.owner)).toMatchObject({ ok: false, code: "invalid_command", message: expect.stringContaining("/voice on") })
    expect(h.voice.status()).toMatchObject({ ok: true, value: { enabled: false, recording: false, ready: false, issue: "voice dictation is off" } })
    expect(h.recorder.calls.started).toEqual([])
    expect(h.http.seen).toEqual([])
    expect(await h.voice.transcribe({ bytes: new Uint8Array(2000), name: "a.ogg", mime: "audio/ogg" })).toEqual({ ok: false, message: "voice dictation is off" })
  })

  test("records, uploads once with the provider's key and no stored audio left behind", async () => {
    const h = service({ voice: { enabled: true, language: "es" } })
    const started = await h.voice.start(h.owner)
    expect(started).toMatchObject({ ok: true, value: { recording: true, ready: true, provider: "openai", model: "gpt-4o-mini-transcribe", maxSeconds: 60, recorder: "fakerec" } })
    expect(h.files()).toHaveLength(1)
    h.clock.advance(4_200)
    const stopped = await h.voice.stop(h.owner)
    expect(stopped).toEqual({ ok: true, value: { text: "hola mundo", seconds: 4.2 } })
    expect(h.recorder.calls.stops).toBe(1)
    expect(h.files()).toEqual([])
    expect(h.http.seen).toHaveLength(1)
    const [request] = h.http.seen
    expect(request).toMatchObject({ url: "https://api.openai.test/v1/audio/transcriptions", model: "gpt-4o-mini-transcribe", language: "es", format: "json", file: { name: "dictation.wav", type: "audio/wav", size: 5000 } })
    expect(request!.headers.authorization).toBe("Bearer sk-secret-openai")
    expect(request!.headers["content-type"]).toBeUndefined()
    expect(h.voice.status()).toMatchObject({ value: { recording: false } })
  })

  test("needs credentials, a recorder and a free microphone before it records", async () => {
    const none = service({ voice: { enabled: true }, credentials: false })
    expect(await none.voice.start(none.owner)).toMatchObject({ ok: false, message: expect.stringContaining("no API credentials for openai") })
    expect(none.recorder.calls.started).toEqual([])
    const mute = service({ voice: { enabled: true }, recorder: fakeRecorder({ name: undefined }) })
    expect(await mute.voice.start(mute.owner)).toMatchObject({ ok: false, message: expect.stringContaining("install sox") })
    const broken = service({ voice: { enabled: true }, recorder: fakeRecorder({ fail: "rec stopped right away" }) })
    expect(await broken.voice.start(broken.owner)).toMatchObject({ ok: false, message: "[VOICE]: rec stopped right away" })
    expect(broken.files()).toEqual([])
    const shared = service({ voice: { enabled: true } })
    await shared.voice.start(shared.owner)
    expect(await shared.voice.start(shared.owner)).toMatchObject({ ok: false, code: "busy", message: expect.stringContaining("already recording") })
    expect(await shared.voice.start({})).toMatchObject({ ok: false, code: "busy", message: expect.stringContaining("another terminal") })
    expect(await shared.voice.stop({})).toMatchObject({ ok: false, message: "[VOICE]: not recording" })
  })

  test("a custom endpoint only gets provider credentials when the provider is named", async () => {
    const plain = service({ voice: { enabled: true, base_url: "http://127.0.0.1:8080/v1" } })
    await plain.voice.start(plain.owner)
    expect((await plain.voice.stop(plain.owner)).ok).toBe(true)
    expect(plain.http.seen[0]!.url).toBe("http://127.0.0.1:8080/v1/audio/transcriptions")
    expect(plain.http.seen[0]!.headers.authorization).toBeUndefined()
    const named = service({ voice: { enabled: true, provider: "groq", model: "whisper-large-v3", base_url: "https://proxy.test/openai/v1" } })
    await named.voice.start(named.owner)
    await named.voice.stop(named.owner)
    expect(named.http.seen[0]).toMatchObject({ url: "https://proxy.test/openai/v1/audio/transcriptions", model: "whisper-large-v3" })
    expect(named.http.seen[0]!.headers.authorization).toBe("Bearer sk-secret-groq")
  })

  test("cancel, disconnect and shutdown delete the clip without uploading it", async () => {
    const h = service({ voice: { enabled: true } })
    await h.voice.start(h.owner)
    expect(h.voice.cancel(h.owner)).toMatchObject({ ok: true, value: { recording: false } })
    expect(h.files()).toEqual([])
    expect(h.recorder.calls.kills).toBe(1)
    await h.voice.start(h.owner)
    h.voice.forget(h.owner)
    expect(h.files()).toEqual([])
    await h.voice.start(h.owner)
    h.voice.dispose()
    expect(h.files()).toEqual([])
    expect(h.recorder.calls.kills).toBe(3)
    expect(h.http.seen).toEqual([])
    expect(await h.voice.start(h.owner)).toMatchObject({ ok: false })
  })

  test("the recording ends at the limit and an unclaimed clip is dropped a minute later", async () => {
    const h = service({ voice: { enabled: true, max_seconds: 5 } })
    await h.voice.start(h.owner)
    h.clock.advance(4_999)
    expect(h.recorder.calls.stops).toBe(0)
    h.clock.advance(1)
    expect(h.recorder.calls.stops).toBe(1)
    const stopped = await h.voice.stop(h.owner)
    expect(stopped).toMatchObject({ ok: true, value: { seconds: 5 } })
    await h.voice.start(h.owner)
    h.clock.advance(5_000 + 60_000)
    expect(h.files()).toEqual([])
    expect(h.clock.pendingTimers()).toBe(0)
    expect(await h.voice.stop(h.owner)).toMatchObject({ ok: false, message: "[VOICE]: not recording" })
  })

  test("an empty clip is reported as no audio and nothing is uploaded", async () => {
    const h = service({ voice: { enabled: true }, recorder: fakeRecorder({ bytes: 100 }) })
    await h.voice.start(h.owner)
    expect(await h.voice.stop(h.owner)).toMatchObject({ ok: false, message: expect.stringContaining("no audio captured") })
    expect(h.http.seen).toEqual([])
    expect(h.files()).toEqual([])
  })

  test("provider errors name the status and never echo the key", async () => {
    const h = service({ voice: { enabled: true }, fetch: fakeFetch(() => new Response("invalid key sk-secret-openai for org", { status: 401 })) })
    await h.voice.start(h.owner)
    const failed = await h.voice.stop(h.owner)
    expect(failed).toMatchObject({ ok: false, message: expect.stringContaining("openai returned HTTP 401") })
    expect(JSON.stringify(failed)).not.toContain("sk-secret-openai")
    expect(h.files()).toEqual([])
    const garbled = service({ voice: { enabled: true }, fetch: fakeFetch(() => new Response("<html>", { status: 200 })) })
    await garbled.voice.start(garbled.owner)
    expect(await garbled.voice.stop(garbled.owner)).toMatchObject({ ok: false, message: expect.stringContaining("not JSON") })
  })
})

describe("on-device dictation", () => {
  function device(options: { unavailable?: string; final?: string; fail?: string } = {}) {
    const calls = { starts: [] as Array<string | undefined>, stops: 0, kills: 0 }
    let live: ((update: LocalLive) => void) | undefined
    const local: LocalDictation = {
      available: () => options.unavailable,
      async start(input) {
        if (options.fail) throw new Error(options.fail)
        calls.starts.push(input.language)
        live = input.live
        return { async stop() { calls.stops++; return options.final ?? "hola mundo" }, kill() { calls.kills++ } }
      },
    }
    return { local, calls, hear: (update: LocalLive) => live?.(update) }
  }
  function onDevice(options: { voice?: Settings["voice"]; device?: ReturnType<typeof device>; allowed?: boolean } = {}) {
    const dir = temp()
    const recorder = fakeRecorder()
    const http = fakeFetch()
    const mic = options.device ?? device()
    const heard: Array<{ owner: object; update: LocalLive }> = []
    const voice = createVoice({ dir, clock: createVirtualClock(), recorder: recorder.recorder, fetch: http.fetcher, settings: () => ({ voice: options.voice }) as Settings, credentials: () => ({ baseUrl: "https://api.openai.test/v1", headers: { authorization: "Bearer sk-secret" } }), local: mic.local, ...(options.allowed !== undefined ? { allowed: () => options.allowed! } : {}), live: (owner, update) => heard.push({ owner, update }) })
    cleanups.push(() => voice.dispose())
    return { voice, recorder, http, mic, heard, owner: {} }
  }

  test("where it runs it is the default and on without a setting: no key, no recorder program, no upload", async () => {
    const h = onDevice()
    const status = h.voice.status()
    expect(status.ok && status.value).toMatchObject({ enabled: true, ready: true, provider: "local", model: "macOS on-device" })
    expect((await h.voice.start(h.owner)).ok).toBe(true)
    h.mic.hear({ level: 0.6 })
    h.mic.hear({ text: "hola" })
    expect(h.heard).toEqual([{ owner: h.owner, update: { level: 0.6 } }, { owner: h.owner, update: { text: "hola" } }])
    const stopped = await h.voice.stop(h.owner)
    expect(stopped.ok && stopped.value.text).toBe("hola mundo")
    expect(h.recorder.calls.started).toEqual([])
    expect(h.http.seen).toEqual([])
  })

  test("a tier without voice (minimalist) leaves it off until the user turns it on", async () => {
    const minimal = onDevice({ allowed: false })
    const status = minimal.voice.status()
    expect(status.ok && status.value).toMatchObject({ enabled: false, ready: false, provider: "local" })
    expect((await minimal.voice.start(minimal.owner)).ok).toBe(false)
    const chosen = onDevice({ allowed: false, voice: { enabled: true } })
    expect((await chosen.voice.start(chosen.owner)).ok).toBe(true)
  })

  test("the language hint goes to the model; off, a named provider or an endpoint keeps it out", async () => {
    const spanish = onDevice({ voice: { language: "es" } })
    await spanish.voice.start(spanish.owner)
    expect(spanish.mic.calls.starts).toEqual(["es"])
    const off = onDevice({ voice: { enabled: false } })
    expect((await off.voice.start(off.owner)).ok).toBe(false)
    const api = onDevice({ voice: { enabled: true, provider: "openai" } })
    const status = api.voice.status()
    expect(status.ok && status.value.provider).toBe("openai")
    await api.voice.start(api.owner)
    expect(api.mic.calls.starts).toEqual([])
    expect(api.recorder.calls.started).toHaveLength(1)
  })

  test("where it cannot run, the upload provider stays the default and stays off until turned on", async () => {
    const h = onDevice({ device: device({ unavailable: "on-device dictation needs macOS" }) })
    const status = h.voice.status()
    expect(status.ok && status.value).toMatchObject({ enabled: false, provider: "openai" })
    const asked = onDevice({ voice: { provider: "local" }, device: device({ unavailable: "on-device dictation needs macOS" }) })
    const report = asked.voice.status()
    expect(report.ok && report.value).toMatchObject({ provider: "local", ready: false, issue: "on-device dictation needs macOS" })
    const started = await asked.voice.start(asked.owner)
    expect(started.ok || started.message).toBe("[VOICE]: on-device dictation needs macOS")
  })

  test("a helper that cannot open the microphone is a clear error; cancel and disconnect stop the helper and nothing more is heard", async () => {
    const broken = onDevice({ device: device({ fail: "no microphone input; check the microphone and its permission" }) })
    const failed = await broken.voice.start(broken.owner)
    expect(failed.ok || failed.message).toBe("[VOICE]: no microphone input; check the microphone and its permission")
    const h = onDevice()
    await h.voice.start(h.owner)
    h.voice.cancel(h.owner)
    expect(h.mic.calls.kills).toBe(1)
    h.mic.hear({ level: 1 })
    expect(h.heard).toEqual([])
  })
})

describe("microphone recorder", () => {
  test("picks the first installed program for the platform and never invents one", () => {
    expect(recorderTools("darwin").map((tool) => tool.bin)).toEqual(["rec", "sox", "ffmpeg"])
    expect(recorderTools("linux").map((tool) => tool.bin)).toEqual(["rec", "sox", "arecord", "ffmpeg"])
    expect(recorderTools("win32").map((tool) => tool.bin)).toEqual(["rec", "sox"])
    expect(createVoiceRecorder({ platform: "linux", which: (bin) => (bin === "arecord" ? "/usr/bin/arecord" : null) }).name()).toBe("arecord")
    expect(createVoiceRecorder({ platform: "darwin", which: () => null }).name()).toBeUndefined()
    const args = recorderTools("linux").find((tool) => tool.bin === "arecord")!.args("/tmp/a b.wav")
    expect(args).toEqual(["-q", "-f", "S16_LE", "-r", "16000", "-c", "1", "-t", "wav", "/tmp/a b.wav"])
  })

  test("a recorder that dies at once is a clear error, not a silent empty clip", async () => {
    const root = temp()
    const recorder = createVoiceRecorder({ platform: "linux", which: (bin) => (bin === "rec" ? "rec" : null) })
    // `rec` is not installed in the test environment path used here, so Bun.spawn fails or exits at once.
    const previous = process.env.PATH
    process.env.PATH = root
    try { await expect(recorder.start(path.join(root, "x.wav"))).rejects.toThrow() } finally { process.env.PATH = previous }
  })
})

async function bootDaemon(options: { listen?: string } = {}) {
  const root = temp()
  const dir = path.join(root, "data")
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const recorder = fakeRecorder()
  const http = fakeFetch()
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), defaultDirectory: root, engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }), voice: { recorder: recorder.recorder, fetch: http.fetcher }, ...(options.listen ? { listen: options.listen } : {}) })
  const client = createClient({ socketPath: daemon.socketPath, name: "voice-test" })
  await client.connect()
  cleanups.push(() => daemon.stop(), () => client.close())
  return { daemon, client, dir, recorder, http }
}

describe("voice.control in the daemon", () => {
  test("is off until the setting is on, then records and transcribes for the local terminal", async () => {
    const h = await bootDaemon()
    expect(isReadOnlyCommand("voice.control")).toBe(false)
    expect(await h.client.send({ type: "voice.control", action: "start" })).toMatchObject({ ok: false, error: { code: "invalid_command" } })
    expect(await h.client.send({ type: "voice.control", action: "status" })).toMatchObject({ ok: true, result: { enabled: false, recording: false } })
    const set = await h.client.send({ type: "settings.set", patch: { voice: { enabled: true, base_url: "http://127.0.0.1:9/v1" } } })
    expect(set.ok).toBe(true)
    expect(await h.client.send({ type: "voice.control", action: "start" })).toMatchObject({ ok: true, result: { recording: true, ready: true } })
    const stopped = await h.client.send({ type: "voice.control", action: "stop" })
    expect(stopped).toMatchObject({ ok: true, result: { text: "hola mundo" } })
    expect(h.http.seen).toHaveLength(1)
    expect(h.http.seen[0]!.url).toBe("http://127.0.0.1:9/v1/audio/transcriptions")
    expect(existsSync(path.join(h.dir, "voice")) ? readdirSync(path.join(h.dir, "voice")) : []).toEqual([])
  })

  test("a disconnect drops the clip and remote peers are refused", async () => {
    const h = await bootDaemon({ listen: "127.0.0.1:0" })
    await h.client.send({ type: "settings.set", patch: { voice: { enabled: true, base_url: "http://127.0.0.1:9/v1" } } })
    const second = createClient({ socketPath: h.daemon.socketPath, name: "second" })
    await second.connect()
    expect(await second.send({ type: "voice.control", action: "start" })).toMatchObject({ ok: true })
    second.close()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(h.recorder.calls.kills).toBe(1)
    expect(readdirSync(path.join(h.dir, "voice"))).toEqual([])
    const full = remoteTokens(h.dir).create({ name: "full", readOnly: false }).token
    const remote = createClient({ name: "remote", remote: { hostname: "127.0.0.1", port: h.daemon.remotePort!, token: full } })
    await remote.connect()
    cleanups.push(() => remote.close())
    expect(await remote.send({ type: "voice.control", action: "start" })).toMatchObject({ ok: false, error: { code: "forbidden" } })
    expect(h.recorder.calls.started).toHaveLength(1)
  })

  test("the voice setting validates its URL and language", () => {
    expect(Settings.safeParse({ voice: { enabled: true, language: "es", max_seconds: 30 } }).success).toBe(true)
    expect(Settings.safeParse({ voice: { base_url: "http://example.com/v1" } }).success).toBe(false)
    expect(Settings.safeParse({ voice: { base_url: "https://user:pw@example.com/v1" } }).success).toBe(false)
    expect(Settings.safeParse({ voice: { language: "Spanish" } }).success).toBe(false)
    expect(Settings.safeParse({ voice: { max_seconds: 9000 } }).success).toBe(false)
    expect(Settings.safeParse({ voice: { token: "x" } }).success).toBe(false)
  })
})

describe("Telegram voice messages", () => {
  const SESSION = "ses_phone" as SessionId
  function bridge(options: { transcribe?: boolean; text?: string; download?: () => Promise<Uint8Array> } = {}) {
    const root = temp()
    const project = path.join(root, "project")
    mkdirSync(project)
    mkdirSync(path.join(root, "data"))
    const config = createChannelsConfig(path.join(root, "data"))
    const pairing = createPairing({ now: () => 1000 })
    const messages: string[] = []
    const submitted: string[] = []
    const transcribed: Array<{ name: string; mime: string; size: number }> = []
    const host: BridgeHost = {
      async send(command) {
        if (command.type === "session.create") return { ok: true, result: { sessionId: SESSION } }
        if (command.type === "user.submit") { submitted.push(command.text); return { ok: true, result: { queueId: "queue_1" } } }
        return { ok: true }
      },
      async watch() { return { ok: true } },
      unwatch() {},
      mask: (_id, text) => text,
    }
    const result = options.text ?? "run the tests"
    const live = createChannelBridge({
      api: { sendMessage: async (_chat, text) => { messages.push(text) }, answerCallback: async () => {}, sendTyping: async () => {}, sendDocument: async () => {}, downloadFile: options.download ? async () => options.download!() : async () => new Uint8Array(3000) },
      host, config, pairing, dataDir: path.join(root, "data"), log: () => {},
      ...(options.transcribe === false ? {} : { transcribe: async (clip) => { transcribed.push({ name: clip.name, mime: clip.mime, size: clip.bytes.length }); return result === "FAIL" ? { ok: false as const, message: "voice dictation is off" } : { ok: true as const, text: result } } }),
    })
    let id = 0
    const voice = (chat: number, extra: Record<string, unknown> = {}): TelegramUpdate => ({ update_id: ++id, message: { message_id: id, chat: { id: chat, type: "private", first_name: "Ana" }, voice: { file_id: "f1", duration: 4, mime_type: "audio/ogg", ...extra } } })
    const text = (chat: number, value: string): TelegramUpdate => ({ update_id: ++id, message: { message_id: id, chat: { id: chat, type: "private", first_name: "Ana" }, text: value } })
    return { live, messages, submitted, transcribed, voice, text, async pair() { await live.update(text(7, `/pair ${pairing.create(project).code}`)) } }
  }

  test("a paired chat's voice message is transcribed, echoed and run as a plain prompt", async () => {
    const h = bridge({ text: "/stop everything" })
    await h.pair()
    await h.live.update(h.voice(7))
    expect(h.transcribed).toEqual([{ name: "voice.ogg", mime: "audio/ogg", size: 3000 }])
    expect(h.messages.at(-1)).toBe("Heard: /stop everything")
    expect(h.submitted).toEqual(["/stop everything"])
  })

  test("the Bot API download goes through getFile, is size-capped and keeps the token out of errors", async () => {
    const TOKEN = "123456789:AAEhBOweik6ad9r_QXMENQjcrr9FMJAGu7e"
    const urls: string[] = []
    const api = createTelegramApi({ token: TOKEN, base: "https://tg.test", fetch: (async (input: RequestInfo | URL) => {
      const url = String(input)
      urls.push(url)
      if (url.endsWith("/getFile")) return Response.json({ ok: true, result: { file_path: url.includes("big") ? "voice/big.oga" : "voice/file_1.oga", file_size: 9 } })
      if (url.includes("/file/")) throw new Error(`connect failed for ${url}`)
      return Response.json({ ok: true, result: {} })
    }) as typeof fetch })
    await expect(api.downloadFile("f1", 5)).rejects.toThrow("too large")
    const failure = await api.downloadFile("f1", 100).then(() => "", (error: Error) => error.message)
    expect(failure).toContain("file download failed")
    expect(failure).not.toContain(TOKEN)
    expect(urls.some((url) => url === `https://tg.test/file/bot${TOKEN}/voice/file_1.oga`)).toBe(true)
  })

  test("unpaired chats, overlong clips and failures never reach the provider or a turn", async () => {
    const stranger = bridge()
    await stranger.live.update(stranger.voice(9))
    expect(stranger.transcribed).toEqual([])
    expect(stranger.messages).toEqual([])
    const long = bridge()
    await long.pair()
    await long.live.update(long.voice(7, { duration: 900 }))
    expect(long.messages.at(-1)).toContain("too long")
    const off = bridge({ text: "FAIL" })
    await off.pair()
    await off.live.update(off.voice(7))
    expect(off.messages.at(-1)).toBe("Could not transcribe: voice dictation is off")
    const none = bridge({ transcribe: false })
    await none.pair()
    await none.live.update(none.voice(7))
    expect(none.messages.at(-1)).toBe("Voice messages are not available.")
    const broken = bridge({ download: async () => { throw new Error("[CHANNELS]: telegram file download failed: HTTP 500") } })
    await broken.pair()
    await broken.live.update(broken.voice(7))
    expect(broken.messages.at(-1)).toContain("Could not get the voice message")
    const empty = bridge({ text: "" })
    await empty.pair()
    await empty.live.update(empty.voice(7))
    expect(empty.messages.at(-1)).toBe("Heard nothing in that voice message.")
    for (const h of [stranger, long, off, none, broken, empty]) expect(h.submitted).toEqual([])
  })
})
