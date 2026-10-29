import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs"
import path from "node:path"
import type { Clock, TimerHandle } from "@mendcode/kernel"
import type { Settings, VoiceReport, VoiceTranscript } from "@mendcode/protocol"
import type { LocalDictation, LocalLive, LocalSession } from "./voice-local"

export type VoiceRecording = { stop(): Promise<void>; kill(): void }
/** The microphone side: `name()` is the program that would record (undefined when none is installed). Tests supply a fake. */
export type VoiceRecorder = { name(): string | undefined; start(file: string): Promise<VoiceRecording> }
export type VoiceCredentials = { baseUrl: string; headers: Record<string, string> }
type Failure = { ok: false; code: "invalid_command" | "busy" | "forbidden"; message: string }
export type VoiceResult<T> = { ok: true; value: T } | Failure
export type Transcription = { ok: true; text: string } | { ok: false; message: string }

export const VOICE_DEFAULTS = { provider: "openai", model: "gpt-4o-mini-transcribe", maxSeconds: 60, timeoutMs: 60_000 } as const
/** Under the 25 MB most transcription endpoints accept. */
const MAX_AUDIO_BYTES = 24 * 1024 * 1024
/** A WAV header alone is 44 bytes; anything smaller than this carries no speech. */
const MIN_AUDIO_BYTES = 1000
const MAX_TEXT_CHARS = 20_000
const ERROR_BODY_CHARS = 200

type Active = { owner: object; file: string; recording: VoiceRecording; startedAt: number; timer: TimerHandle; /** On-device dictation: the transcript comes from the helper, no file or upload. */ local?: LocalSession }

/** The provider name of on-device dictation, and how it reads in `/voice status`. */
export const LOCAL_PROVIDER = "local"
const LOCAL_MODEL = "macOS on-device"

/**
 * Opt-in push-to-talk dictation: the daemon alone opens the microphone (an argument-array child process writing a private
 * temp WAV), uploads the finished clip to an OpenAI-compatible transcription endpoint and deletes the file. One recording
 * at a time; it belongs to the connection that started it and ends with it.
 */
export function createVoice(input: {
  dir: string
  clock: Clock
  settings(): Settings
  credentials?(provider: string): VoiceCredentials | undefined
  recorder: VoiceRecorder
  fetch?: typeof fetch
  /** On-device dictation (macOS): the default where it runs, unless a provider or endpoint is set. */
  local?: LocalDictation
  /** Whether the tier lets dictation be on by default (the `voice` feature); unset means it does. */
  allowed?(): boolean
  /** Levels and the running transcript of an on-device recording, for the terminal that owns it. */
  live?(owner: object, update: LocalLive): void
}) {
  const folder = path.join(input.dir, "voice")
  const request = input.fetch ?? fetch
  const inflight = new Set<AbortController>()
  let active: Active | undefined
  let counter = 0
  let disposed = false

  const config = () => input.settings().voice ?? {}
  const limit = () => config().max_seconds ?? VOICE_DEFAULTS.maxSeconds

  function transport(): VoiceResult<{ url: string; headers: Record<string, string>; model: string; provider: string }> {
    const cfg = config()
    const provider = cfg.provider ?? VOICE_DEFAULTS.provider
    const credentials = input.credentials?.(provider)
    let base: string
    let headers: Record<string, string>
    if (cfg.base_url) {
      // A custom endpoint only ever sees provider credentials the user asked for by naming the provider.
      base = cfg.base_url
      headers = cfg.provider && credentials ? credentials.headers : {}
    } else {
      if (!credentials) return { ok: false, code: "invalid_command", message: `[VOICE]: no API credentials for ${provider}; connect it with /connect or set voice.base_url` }
      base = credentials.baseUrl
      headers = credentials.headers
    }
    const clean = Object.fromEntries(Object.entries(headers).filter(([name]) => !/^content-(type|length)$/i.test(name)))
    return { ok: true, value: { url: `${base.replace(/\/+$/, "")}/audio/transcriptions`, headers: clean, model: cfg.model ?? VOICE_DEFAULTS.model, provider } }
  }

  /** On-device dictation is used when asked for by name, or by default where it can run and nothing else is configured. */
  function local() {
    const cfg = config()
    if (cfg.provider === LOCAL_PROVIDER) return input.local
    return !cfg.provider && !cfg.base_url && input.local && !input.local.available() ? input.local : undefined
  }

  function report(): VoiceReport {
    const cfg = config()
    const device = local()
    if (device || cfg.provider === LOCAL_PROVIDER) {
      const on = cfg.enabled ?? (input.allowed?.() ?? true)
      const issue = !on ? "voice dictation is off" : device ? device.available() : "on-device dictation is not available here"
      return { enabled: on, recording: active !== undefined, ready: on && !issue, provider: LOCAL_PROVIDER, model: LOCAL_MODEL, maxSeconds: limit(), recorder: "macOS", ...(issue ? { issue } : {}) }
    }
    const route = transport()
    const recorder = input.recorder.name()
    const issue = !cfg.enabled ? "voice dictation is off" : !recorder ? "no recorder found: install sox (rec), arecord or ffmpeg" : !route.ok ? route.message.replace(/^\[VOICE\]: /, "") : undefined
    return {
      enabled: cfg.enabled === true,
      recording: active !== undefined,
      ready: cfg.enabled === true && recorder !== undefined && route.ok,
      provider: cfg.provider ?? VOICE_DEFAULTS.provider,
      model: cfg.model ?? VOICE_DEFAULTS.model,
      maxSeconds: limit(),
      ...(recorder ? { recorder } : {}),
      ...(issue ? { issue } : {}),
    }
  }

  function discard(file: string) {
    if (!file) return
    try { rmSync(file, { force: true }) } catch {}
  }

  function release(state: Active) {
    state.timer.cancel()
    try { state.recording.kill() } catch {}
    discard(state.file)
    if (active === state) active = undefined
  }

  /** Recordings left by a crashed daemon are removed on first use; they hold voice data. */
  function sweep() {
    try { for (const name of readdirSync(folder)) if (/^rec-.*\.wav$/.test(name)) discard(path.join(folder, name)) } catch {}
  }

  async function start(owner: object): Promise<VoiceResult<VoiceReport>> {
    if (disposed) return { ok: false, code: "invalid_command", message: "[VOICE]: daemon is stopping" }
    // On-device dictation hears nothing beyond this machine, so it is on unless turned off; an upload waits for `/voice on`.
    if (!(config().enabled ?? (Boolean(local()) && (input.allowed?.() ?? true)))) return { ok: false, code: "invalid_command", message: "[VOICE]: voice dictation is off; turn it on with /voice on" }
    if (active) return { ok: false, code: "busy", message: active.owner === owner ? "[VOICE]: already recording" : "[VOICE]: another terminal is recording" }
    if (config().provider === LOCAL_PROVIDER || local()) return startLocal(owner)
    const route = transport()
    if (!route.ok) return route
    if (!input.recorder.name()) return { ok: false, code: "invalid_command", message: "[VOICE]: no recorder found; install sox (rec), arecord or ffmpeg" }
    if (counter === 0) sweep()
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    const file = path.join(folder, `rec-${++counter}-${input.clock.now()}.wav`)
    let recording: VoiceRecording
    try { recording = await input.recorder.start(file) } catch (error) {
      discard(file)
      return { ok: false, code: "invalid_command", message: `[VOICE]: ${error instanceof Error ? error.message.slice(0, 300) : "could not open the microphone"}` }
    }
    if (disposed || active) {
      try { recording.kill() } catch {}
      discard(file)
      return { ok: false, code: "busy", message: "[VOICE]: already recording" }
    }
    const state: Active = { owner, file, recording, startedAt: input.clock.now(), timer: { cancel() {} } }
    // The clip ends at the limit; a vanished client's clip is dropped a minute later.
    state.timer = input.clock.setTimer(limit() * 1000, () => {
      void recording.stop().catch(() => {})
      state.timer = input.clock.setTimer(60_000, () => release(state))
    })
    active = state
    return { ok: true, value: report() }
  }

  async function startLocal(owner: object): Promise<VoiceResult<VoiceReport>> {
    const device = local()
    const why = device ? device.available() : "on-device dictation is not available here"
    if (!device || why) return { ok: false, code: "invalid_command", message: `[VOICE]: ${why}` }
    let session: LocalSession
    try {
      session = await device.start({ language: config().language, live: (update) => { if (active?.local === session) input.live?.(owner, update) } })
    } catch (error) {
      return { ok: false, code: "invalid_command", message: `[VOICE]: ${error instanceof Error ? error.message.slice(0, 300) : "could not open the microphone"}` }
    }
    if (disposed || active) {
      session.kill()
      return { ok: false, code: "busy", message: "[VOICE]: already recording" }
    }
    const state: Active = { owner, file: "", recording: { stop: async () => {}, kill: () => session.kill() }, startedAt: input.clock.now(), timer: { cancel() {} }, local: session }
    // At the limit the terminal stops it; a vanished client's recording is dropped a minute after that.
    state.timer = input.clock.setTimer(limit() * 1000 + 60_000, () => release(state))
    active = state
    return { ok: true, value: report() }
  }

  async function transcribe({ bytes, name, mime, language }: { bytes: Uint8Array; name: string; mime: string; language?: string }): Promise<Transcription> {
    const cfg = config()
    if (!cfg.enabled) return { ok: false, message: "voice dictation is off" }
    const route = transport()
    if (!route.ok) return { ok: false, message: route.message.replace(/^\[VOICE\]: /, "") }
    if (bytes.length > MAX_AUDIO_BYTES) return { ok: false, message: "audio is larger than 24 MB" }
    const secrets = Object.values(route.value.headers).flatMap((value) => [value, value.replace(/^Bearer\s+/i, "")]).filter((value) => value.length >= 4)
    const scrub = (text: string) => secrets.reduce((result, secret) => result.split(secret).join("***"), text)
    const form = new FormData()
    form.set("model", route.value.model)
    form.set("response_format", "json")
    const hint = language ?? cfg.language
    if (hint) form.set("language", hint)
    form.set("file", new Blob([bytes as BlobPart], { type: mime }), name)
    const controller = new AbortController()
    inflight.add(controller)
    const timeoutMs = cfg.timeout_ms ?? VOICE_DEFAULTS.timeoutMs
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await request(route.value.url, { method: "POST", redirect: "error", headers: route.value.headers, body: form, signal: controller.signal })
      const body = (await response.text()).slice(0, 1_000_000)
      if (!response.ok) {
        const detail = scrub(body.replace(/\s+/g, " ").trim()).slice(0, ERROR_BODY_CHARS)
        return { ok: false, message: `${route.value.provider} returned HTTP ${response.status}${detail ? `: ${detail}` : ""}` }
      }
      let text: unknown
      try { text = (JSON.parse(body) as { text?: unknown }).text } catch { return { ok: false, message: `${route.value.provider} returned a response that is not JSON` } }
      if (typeof text !== "string") return { ok: false, message: `${route.value.provider} returned no transcript` }
      return { ok: true, text: text.trim().slice(0, MAX_TEXT_CHARS) }
    } catch (error) {
      if (controller.signal.aborted) return { ok: false, message: disposed ? "cancelled" : `${route.value.provider} timed out after ${Math.round(timeoutMs / 1000)} s` }
      return { ok: false, message: `${route.value.provider} request failed: ${scrub(error instanceof Error ? error.message : String(error)).slice(0, 200)}` }
    } finally {
      clearTimeout(timer)
      inflight.delete(controller)
    }
  }

  async function stop(owner: object): Promise<VoiceResult<VoiceTranscript>> {
    const state = active
    if (!state || state.owner !== owner) return { ok: false, code: "invalid_command", message: "[VOICE]: not recording" }
    active = undefined
    state.timer.cancel()
    const seconds = Math.min(limit(), Math.round((input.clock.now() - state.startedAt) / 100) / 10)
    if (state.local) {
      try {
        return { ok: true, value: { text: (await state.local.stop()).slice(0, MAX_TEXT_CHARS), seconds } }
      } catch (error) {
        return { ok: false, code: "invalid_command", message: `[VOICE]: ${error instanceof Error ? error.message.slice(0, 300) : "dictation failed"}` }
      }
    }
    try {
      await state.recording.stop()
      let size = 0
      try { size = statSync(state.file).size } catch {}
      if (size < MIN_AUDIO_BYTES) return { ok: false, code: "invalid_command", message: "[VOICE]: no audio captured; check the microphone and its permission" }
      const bytes = new Uint8Array(await Bun.file(state.file).arrayBuffer())
      const result = await transcribe({ bytes, name: "dictation.wav", mime: "audio/wav" })
      return result.ok ? { ok: true, value: { text: result.text, seconds } } : { ok: false, code: "invalid_command", message: `[VOICE]: ${result.message}` }
    } finally {
      discard(state.file)
    }
  }

  function cancel(owner: object): VoiceResult<VoiceReport> {
    if (active && active.owner === owner) release(active)
    return { ok: true, value: report() }
  }

  function forget(owner: object) {
    if (active && active.owner === owner) release(active)
  }

  function dispose() {
    disposed = true
    if (active) release(active)
    for (const controller of inflight) controller.abort()
  }

  return {
    status: (): VoiceResult<VoiceReport> => ({ ok: true, value: report() }),
    start,
    stop,
    cancel,
    transcribe,
    forget,
    dispose,
  }
}
export type Voice = ReturnType<typeof createVoice>
