import { afterEach, describe, expect, test } from "bun:test"
import type { CommandInput, CommandReply } from "@mendcode/client"
import { SLASH_COMMANDS } from "../src/view/commands"
import { KEY_ACTIONS, LEADER_CHORDS } from "../src/ui/keymap"
import { clockText, levelBars, voiceRow } from "../src/view/voice-row"
import { appHarness, cleanTemps, tempDir } from "./session-ui-harness"

const apps: ReturnType<typeof appHarness>[] = []
afterEach(() => {
  for (const h of apps.splice(0)) void h.app.onInput("/voice cancel\r")
  cleanTemps()
})
const asReply = (reply: unknown) => reply as CommandReply

function app(options: { remote?: boolean; transcript?: string; startError?: string; ready?: boolean } = {}) {
  const report = (recording: boolean, enabled = true) => ({ enabled, recording, ready: options.ready !== false, provider: "openai", model: "gpt-4o-mini-transcribe", maxSeconds: 60, recorder: "rec", ...(options.ready === false ? { issue: "no recorder found: install sox (rec), arecord or ffmpeg" } : {}) })
  const h = appHarness({
    directory: tempDir("mendcode-voice-"),
    ...(options.remote ? { remote: { host: "test.invalid", readOnly: false } } : {}),
    reply: (command: CommandInput) => {
      if (command.type === "voice.control") {
        if (command.action === "start") return options.startError ? asReply({ ok: false, error: { code: "invalid_command", message: options.startError } }) : asReply({ ok: true, result: report(true) })
        if (command.action === "stop") return asReply({ ok: true, result: { text: options.transcript ?? "run the tests", seconds: 3.1 } })
        return asReply({ ok: true, result: report(false) })
      }
      if (command.type === "settings.set") return asReply({ ok: true, result: { settings: command.patch } })
      return undefined
    },
  })
  apps.push(h)
  return h
}
/** The frame as one line of words: toasts wrap inside their box. */
const screen = (h: ReturnType<typeof appHarness>) => h.text().join(" ").replace(/[┃│]/g, " ").replace(/\s+/g, " ")
const voiceCalls = (h: ReturnType<typeof appHarness>) => h.sentOf("voice.control").map((command) => (command as { action: string }).action)

describe("/voice", () => {
  test("the command (no alias) and the key action exist; ctrl+x v is the leader chord", () => {
    expect(SLASH_COMMANDS.find((entry) => entry.name === "voice")?.aliases).toEqual([])
    expect(KEY_ACTIONS).toContain("voice.toggle")
    expect(LEADER_CHORDS.v).toBe("voice.toggle")
  })

  test("first press records with a visible row, the second transcribes into the prompt", async () => {
    const h = app()
    await h.type("/voice\r")
    expect(voiceCalls(h)).toEqual(["start"])
    expect(screen(h)).toMatch(/● ▁{16} 0:00/)
    await h.type("/voice\r")
    await Bun.sleep(5)
    h.app.render()
    expect(voiceCalls(h)).toEqual(["start", "stop"])
    expect(screen(h)).not.toContain("recording 0:00")
    expect(screen(h)).toContain("run the tests")
    expect(h.sentOf("user.submit")).toHaveLength(0)
  })

  test("ctrl+x v starts and stops from the keyboard, and the transcript joins what was typed", async () => {
    const h = app({ transcript: "and fix the lint" })
    await h.type("please")
    await h.type("\x18v")
    expect(voiceCalls(h)).toEqual(["start"])
    await h.type("\x18v")
    await Bun.sleep(5)
    h.app.render()
    expect(voiceCalls(h)).toEqual(["start", "stop"])
    expect(screen(h)).toContain("please and fix the lint")
  })

  test("esc drops the clip: cancel is sent, nothing is transcribed or inserted", async () => {
    const h = app()
    await h.type("/voice\r")
    await h.type("\x1b")
    expect(voiceCalls(h)).toEqual(["start", "cancel"])
    expect(screen(h)).not.toContain("recording 0:00")
    expect(screen(h)).toContain("dictation cancelled")
    await h.type("/voice stop\r")
    expect(voiceCalls(h)).toEqual(["start", "cancel"])
    expect(screen(h)).toContain("not recording")
  })

  test("an empty transcript says so and a refused start shows the daemon's reason", async () => {
    const quiet = app({ transcript: "" })
    await quiet.type("/voice\r")
    await quiet.type("/voice\r")
    await Bun.sleep(5)
    quiet.app.render()
    expect(screen(quiet)).toContain("nothing heard")
    const off = app({ startError: "[VOICE]: voice dictation is off; turn it on with /voice on" })
    await off.type("/voice\r")
    expect(screen(off)).toContain("voice dictation is off; turn it on with /voice on")
    expect(screen(off)).not.toContain("recording")
  })

  test("on and off change the setting; on warns when the daemon cannot record yet", async () => {
    const ready = app()
    await ready.type("/voice on\r")
    expect(screen(ready)).toContain("voice on")
    expect(screen(ready)).toContain("uploaded to the transcription provider")
    const h = app({ ready: false })
    await h.type("/voice on\r")
    expect(h.sentOf("settings.set").at(-1)).toMatchObject({ patch: { voice: { enabled: true } } })
    expect(screen(h)).toContain("install sox")
    await h.type("/voice language es\r")
    expect(h.sentOf("settings.set").at(-1)).toMatchObject({ patch: { voice: { enabled: true, language: "es" } } })
    await h.type("/voice language auto\r")
    expect(h.sentOf("settings.set").at(-1)).toEqual(expect.objectContaining({ patch: { voice: { enabled: true } } }))
    await h.type("/voice language spanish\r")
    expect(screen(h)).toContain("usage: /voice")
    await h.type("/voice off\r")
    expect(h.sentOf("settings.set").at(-1)).toMatchObject({ patch: { voice: { enabled: false } } })
    await h.type("/voice status\r")
    expect(voiceCalls(h)).toContain("status")
  })

  test("a remote terminal never asks for a microphone", async () => {
    const h = app({ remote: true })
    await h.type("/voice\r")
    await h.type("/voice on\r")
    expect(h.sentOf("voice.control")).toHaveLength(0)
    expect(h.sentOf("settings.set")).toHaveLength(0)
    expect(screen(h)).toContain("machine that runs the daemon")
  })
})

describe("voice row", () => {
  test("shows the clock against the limit, then the wait for the transcript", () => {
    expect(clockText(7_400)).toBe("0:07")
    expect(clockText(125_000)).toBe("2:05")
    const row = voiceRow({ voice: { phase: "recording", startedAt: 1000, maxSeconds: 60, levels: [] }, now: 8_000, dot: "●", width: 100 }).map((span) => span.text).join("")
    expect(row).toMatch(/^● ▁{16} {2}0:07 {2}listening +\/voice or ctrl\+x v to stop · esc cancels$/)
    expect(row.length).toBe(100)
    expect(voiceRow({ voice: { phase: "transcribing", startedAt: 0, maxSeconds: 60, levels: [0.5] }, now: 1, dot: "●", width: 80 }).map((span) => span.text).join("")).toBe(`● ${"▁".repeat(15)}▅  finishing…`)
  })

  test("bars follow the level with the newest on the right, the words heard show their end, and a held space says how it stops", () => {
    expect(levelBars([0, 0.5, 1], 5)).toBe("▁▁▁▅█")
    expect(levelBars([0, 0.5, 1], 5, true)).toBe("...=#")
    const voice = { phase: "recording" as const, startedAt: 0, maxSeconds: 60, levels: [0.1, 0.9, 0.4], text: "hola mundo, esto es una prueba de dictado en vivo", held: true }
    const wide = voiceRow({ voice, now: 3_000, dot: "●", width: 120 })
    expect(wide.map((span) => span.text).join("")).toMatch(/^● ▁{13}▂▇▄ {2}0:03 {2}hola mundo, esto es una prueba de dictado en vivo +release space to stop · esc cancels$/)
    expect(wide.find((span) => span.text.includes("▇"))?.fg).toBe("primary")
    const narrow = voiceRow({ voice, now: 3_000, dot: "●", width: 70 }).map((span) => span.text).join("")
    // The keys give way to the words, which keep their end.
    expect(narrow).toMatch(/0:03 {2}….*dictado en vivo$/)
    expect(narrow.length).toBeLessThanOrEqual(70)
  })
})

describe("hold space to talk", () => {
  function holder(options: { ready?: boolean } = {}) {
    let at = 1_000_000
    const h = appHarness({
      directory: tempDir("mendcode-voice-"),
      now: () => at,
      reply: (command: CommandInput) => {
        if (command.type !== "voice.control") return undefined
        if (command.action === "stop") return asReply({ ok: true, result: { text: "run the tests", seconds: 2 } })
        return asReply({ ok: true, result: { enabled: true, recording: command.action === "start", ready: options.ready !== false, provider: "local", model: "macOS on-device", maxSeconds: 60, recorder: "macOS" } })
      },
    })
    apps.push(h)
    /** One space at `gap` ms after the last key, as a held key repeats. */
    const space = async (gap: number) => { at += gap; await h.type(" ") }
    return { h, space }
  }
  const prompt = (h: ReturnType<typeof appHarness>) => h.app.editor.text

  test("a held space takes back the spaces it typed, listens with live bars and words, and lets go into the prompt at the cursor", async () => {
    const { h, space } = holder()
    await h.type("fix")
    await space(500)
    await space(450)
    await space(40)
    await space(40)
    // The first repeat run only asked whether dictation is ready; the next repeat starts it.
    expect(voiceCalls(h)).toEqual(["status"])
    await space(40)
    expect(voiceCalls(h)).toEqual(["status", "start"])
    expect(prompt(h)).toBe("fix")
    await h.app.onGlobal({ type: "voice.live", gseq: 1, at: 1, level: 0.9, text: "run the" })
    h.app.render()
    expect(screen(h)).toMatch(/● ▁{15}▇ 0:00 run the ─/)
    // Repeats while held are swallowed.
    await space(40)
    expect(prompt(h)).toBe("fix")
    await Bun.sleep(400)
    await Bun.sleep(5)
    expect(voiceCalls(h)).toEqual(["status", "start", "stop"])
    expect(prompt(h)).toBe("fix run the tests")
  })

  test("spaces typed at a human pace stay spaces, and held spaces stay spaces where dictation is not ready", async () => {
    const typed = holder()
    for (const gap of [200, 180, 220, 190]) await typed.space(gap)
    expect(voiceCalls(typed.h)).toEqual([])
    expect(prompt(typed.h)).toBe("    ")
    const unready = holder({ ready: false })
    await unready.space(500)
    for (let index = 0; index < 6; index++) await unready.space(40)
    expect(voiceCalls(unready.h)).toEqual(["status"])
    expect(prompt(unready.h)).toBe("       ")
  })
})
