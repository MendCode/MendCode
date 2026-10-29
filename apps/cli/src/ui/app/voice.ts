import type { Settings, VoiceReport, VoiceTranscript } from "@mendcode/protocol"
import type { AppContext } from "./context"

type VoiceSetting = NonNullable<Settings["voice"]>

export const VOICE_USAGE = "usage: /voice [on | off | status | start | stop | cancel | language <code|auto>]"

/** Auto-repeated keys arrive this close together; a typed one rarely comes three times in a row this fast. */
const REPEAT_MS = 150
/** A held space is let go when no repeat came for this long. */
const RELEASE_MS = 320
/** Spaces further apart than this start a new run. */
const RUN_MS = 1_500
/** Levels kept for the bars (the newest last). */
const LEVELS_KEPT = 48

/**
 * Dictation into the prompt. Hold space on the prompt (as in Claude Code): once the key repeats, the spaces it typed are taken
 * back, the microphone listens while it is held, and the transcript lands at the cursor when it is let go. `/voice` (and
 * `ctrl+x v`) toggles the same recording. The daemon owns the microphone: on macOS Apple's on-device model hears it (free, no
 * key, levels and words live); elsewhere the clip goes to the configured transcription API.
 */
export function createVoice(ctx: AppContext) {
  const { input, state, editor, say, fail, requestFrame, now } = ctx
  let tick: ReturnType<typeof setInterval> | undefined
  let limit: ReturnType<typeof setTimeout> | undefined
  let epoch = 0
  let starting = false
  /** The current run of spaces: how many, the last one's time and how many came at repeat speed in a row. */
  let run = { count: 0, last: 0, fast: 0 }
  let released: ReturnType<typeof setTimeout> | undefined
  /** Let go while the recording was still starting: it stops as soon as it has started. */
  let stopWhenStarted = false
  /** Whether holding space can dictate, for the voice setting it was asked under. */
  let hold: { key: string; ready: boolean } | undefined
  let asking = false

  function clearTimers() {
    if (tick) clearInterval(tick)
    if (limit) clearTimeout(limit)
    tick = limit = undefined
  }

  async function begin(held = false) {
    if (starting || state.voice) return
    starting = true
    try {
      const reply = await input.send({ type: "voice.control", action: "start" })
      if (!reply.ok) { stopWhenStarted = false; fail(reply.error.message.replace(/^\[VOICE\]: /, "")); return }
      const { maxSeconds } = reply.result as unknown as VoiceReport
      state.voice = { phase: "recording", startedAt: now(), maxSeconds, levels: [], ...(held ? { held: true } : {}) }
      tick = setInterval(requestFrame, 1000)
      limit = setTimeout(() => void finish(), maxSeconds * 1000)
      requestFrame()
    } finally { starting = false }
    if (stopWhenStarted) { stopWhenStarted = false; void finish() }
  }

  /** The daemon's live report of an on-device recording: the bars move with the level, the words show as they are heard. */
  function live(update: { level?: number; text?: string }) {
    const current = state.voice
    if (!current || current.phase !== "recording") return
    if (update.level !== undefined) current.levels = [...current.levels.slice(1 - LEVELS_KEPT), update.level]
    if (update.text !== undefined) current.text = update.text
    requestFrame()
  }

  function armRelease() {
    if (released) clearTimeout(released)
    released = setTimeout(() => {
      released = undefined
      run = { count: 0, last: 0, fast: 0 }
      if (starting) stopWhenStarted = true
      else if (state.voice?.held) void finish()
    }, RELEASE_MS)
  }

  /** Asks the daemon once per voice setting whether dictation is ready; until it answers, held spaces type as spaces. */
  function holdReady() {
    const key = JSON.stringify(state.settingsNow.voice ?? {})
    if (hold?.key === key) return hold.ready
    if (!asking) {
      asking = true
      void input.send({ type: "voice.control", action: "status" }).then((reply) => {
        hold = { key, ready: reply.ok && (reply.result as unknown as VoiceReport).ready }
      }, () => { hold = { key, ready: false } }).finally(() => { asking = false })
    }
    return false
  }

  /**
   * Every key on the plain prompt passes here first; true when it was taken. A space held down repeats: from the third repeat in
   * a row the spaces it typed are taken back and the recording starts, and while it stays held its repeats are swallowed.
   */
  function key(pressed: string): boolean {
    if (pressed !== " ") {
      run = { count: 0, last: 0, fast: 0 }
      return false
    }
    if (input.remote) return false
    if (state.voice?.held || (starting && run.fast >= 2)) { armRelease(); return true }
    if (state.voice || starting) return false
    const at = now()
    const gap = at - run.last
    run = gap > RUN_MS ? { count: 1, last: at, fast: 0 } : { count: run.count + 1, last: at, fast: gap <= REPEAT_MS ? run.fast + 1 : 0 }
    if (run.fast < 2 || !holdReady()) return false
    // Take back the spaces this hold already typed, as far as they are right before the cursor.
    const cursor = editor.cursorOffset
    const chars = Array.from(editor.text)
    let typed = 0
    while (typed < run.count - 1 && cursor - typed > 0 && chars[cursor - typed - 1] === " ") typed++
    if (typed) editor.replaceRange(cursor - typed, cursor, "", cursor - typed)
    armRelease()
    void begin(true)
    requestFrame()
    return true
  }

  async function finish() {
    const current = state.voice
    if (!current || current.phase !== "recording") return
    clearTimers()
    state.voice = { ...current, phase: "transcribing" }
    requestFrame()
    const mine = ++epoch
    const reply = await input.send({ type: "voice.control", action: "stop" })
    if (mine !== epoch) return
    // Whatever command stopped us clears or restores the prompt as it returns; the transcript goes in after that.
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    if (mine !== epoch) return
    state.voice = undefined
    requestFrame()
    if (!reply.ok) return fail(reply.error.message.replace(/^\[VOICE\]: /, ""))
    const { text } = reply.result as unknown as VoiceTranscript
    if (!text) return say("nothing heard", "warning")
    const before = editor.text
    editor.insert(before && !/\s$/.test(before) ? ` ${text}` : text)
    requestFrame()
  }

  /** Esc: drops the clip without uploading it (or forgets a transcript that is still on its way). */
  function cancel() {
    const current = state.voice
    if (!current) return false
    epoch++
    clearTimers()
    state.voice = undefined
    if (current.phase === "recording") void input.send({ type: "voice.control", action: "cancel" }).catch(() => {})
    say("dictation cancelled")
    requestFrame()
    return true
  }

  async function apply(next: VoiceSetting, done: string) {
    const reply = await input.send({ type: "settings.set", patch: { voice: next } })
    if (!reply.ok) { fail(reply.error.message); return }
    state.settingsNow = ((reply.result as { settings?: Settings } | undefined)?.settings) ?? { ...state.settingsNow, voice: next }
    say(done, "success")
    requestFrame()
  }

  async function report() {
    const reply = await input.send({ type: "voice.control", action: "status" })
    if (!reply.ok) { fail(reply.error.message); return undefined }
    return reply.result as unknown as VoiceReport
  }

  async function voiceCommand(text: string): Promise<boolean> {
    const match = /^\/voice(?:\s+(.*))?$/s.exec(text.trim())
    if (!match) return false
    if (input.remote) { fail("Dictation uses the microphone of the machine that runs the daemon"); return true }
    const words = (match[1] ?? "").trim().split(/\s+/).filter(Boolean)
    const head = (words[0] ?? "").toLowerCase()
    const current: VoiceSetting = { ...state.settingsNow.voice }
    if (head === "" || head === "toggle") {
      if (state.voice?.phase === "recording") void finish()
      else if (state.voice) say("still transcribing", "warning")
      else await begin()
      return true
    }
    if (head === "start") { await begin(); return true }
    if (head === "stop") {
      if (state.voice?.phase === "recording") void finish()
      else say("not recording", "warning")
      return true
    }
    if (head === "cancel") {
      if (!cancel()) say("not recording", "warning")
      return true
    }
    if (head === "status") {
      const status = await report()
      if (status) say(`voice ${status.enabled ? "on" : "off"} · ${status.provider}/${status.model} · up to ${status.maxSeconds}s${status.recorder ? ` · ${status.recorder}` : ""}${status.issue ? ` · ${status.issue}` : ""}`, status.enabled && !status.ready ? "warning" : "info")
      return true
    }
    if (head === "on" || head === "off") {
      if (head === "off") cancel()
      const where = head === "on" ? ((await report())?.provider === "local" ? "heard on this Mac, nothing is uploaded" : "the clip is uploaded to the transcription provider") : ""
      await apply({ ...current, enabled: head === "on" }, head === "on" ? `voice on: hold space to talk, or /voice and ctrl+x v to start and stop; ${where}` : "voice off")
      if (head === "on") {
        const status = await report()
        if (status?.issue) say(status.issue, "warning")
      }
      return true
    }
    if (head === "language" && words[1]) {
      const code = words[1].toLowerCase()
      if (code !== "auto" && !/^[a-z]{2,3}$/.test(code)) { say(VOICE_USAGE, "warning"); return true }
      const { language: _drop, ...rest } = current
      await apply(code === "auto" ? rest : { ...rest, language: code }, code === "auto" ? "voice language: auto-detect" : `voice language: ${code}`)
      return true
    }
    say(VOICE_USAGE, "warning")
    return true
  }

  function dispose() {
    epoch++
    clearTimers()
    if (released) clearTimeout(released)
  }

  return { voiceCommand, cancelVoice: cancel, disposeVoice: dispose, voiceKey: key, voiceLive: live }
}
