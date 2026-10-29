import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createVirtualClock } from "@mendcode/kernel"
import { isReadOnlyCommand } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { createActivityAudio, type AudioClip, type AudioProcess } from "../src/activity-audio"
import { audioArgs, audioGain } from "../src/activity-audio-player"

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

function fakeProcess() {
  let complete!: () => void
  let kills = 0
  const exited = new Promise<void>((resolve) => { complete = resolve })
  return { exited, kill() { kills++; complete() }, complete, get kills() { return kills } }
}

function fixture() {
  const clock = createVirtualClock()
  const clips: Array<{ clip: AudioClip; volume: number; child: ReturnType<typeof fakeProcess> }> = []
  const audio = createActivityAudio({ dir: "/unused", clock, player: async (clip, volume) => {
    const child = fakeProcess()
    clips.push({ clip, volume, child })
    return child
  } })
  cleanups.push(() => audio.dispose())
  return { clock, clips, audio, owner: {} }
}

test("hum restart, rotating pulses, 140ms tail and natural exit release every timer", async () => {
  const { audio, clock, clips, owner } = fixture()
  expect(await audio.control(owner, "start")).toEqual({ played: true })
  await audio.control(owner, "start")
  expect(clips[0]!.child.kills).toBe(1)
  await audio.control(owner, "pulse", 0)
  expect(clips.map(({ clip, volume }) => [clip, volume])).toEqual([["charge", 0.24], ["charge", 0.24], ["pulse-a", 0.26]])
  clock.advance(139)
  expect(clips[1]!.child.kills).toBe(0)
  clock.advance(1)
  expect(clips[1]!.child.kills).toBe(1)
  await audio.control(owner, "pulse", 1)
  expect(clips[2]!.child.kills).toBe(1)
  await audio.control(owner, "pulse", 0.8)
  await audio.control(owner, "pulse")
  expect(clips.slice(3).map(({ clip, volume }) => [clip, volume])).toEqual([["pulse-b", 0.4], ["pulse-c", 0.37], ["pulse-a", 0.4]])
  clips.at(-1)!.child.complete()
  await Promise.resolve()
  expect(clock.pendingTimers()).toBe(0)
  audio.dispose()
  expect(clock.pendingTimers()).toBe(0)
})

test("stop, disconnect, daemon disposal and stuck players cannot leak processes or timers", async () => {
  const { audio, clock, clips, owner } = fixture()
  const other = {}
  await audio.control(owner, "start")
  await audio.control(other, "start")
  await audio.control(owner, "stop")
  expect(clips[0]!.child.kills).toBe(1)
  expect(clips[1]!.child.kills).toBe(0)
  clock.advance(4_350)
  expect(clips[1]!.child.kills).toBe(1)
  await audio.control(owner, "start")
  await audio.control(owner, "pulse")
  audio.forget(owner)
  expect(clips.slice(2).every(({ child }) => child.kills === 1)).toBe(true)
  expect(clock.pendingTimers()).toBe(0)
  await audio.control(other, "pulse")
  audio.dispose()
  expect(clips.at(-1)!.child.kills).toBe(1)
  expect(clock.pendingTimers()).toBe(0)
  expect(await audio.control(owner, "start")).toEqual({ played: false })
})

test("a player loading after stop/disconnect is killed, failures remain contained", async () => {
  for (const action of ["stop", "forget", "dispose"] as const) {
    const clock = createVirtualClock()
    let finish!: (process: AudioProcess) => void
    const audio = createActivityAudio({ dir: "/unused", clock, player: () => new Promise((resolve) => { finish = resolve }) })
    const owner = {}
    const playing = audio.control(owner, "start")
    if (action === "stop") await audio.control(owner, "stop")
    else if (action === "forget") audio.forget(owner)
    else audio.dispose()
    const child = fakeProcess()
    finish(child)
    expect(await playing).toEqual({ played: false })
    expect(child.kills).toBe(1)
    expect(clock.pendingTimers()).toBe(0)
  }
  const clock = createVirtualClock()
  for (const player of [async () => undefined, async () => { throw new Error("player failed") }]) {
    const audio = createActivityAudio({ dir: "/unused", clock, player })
    expect(await audio.control({}, "start")).toEqual({ played: false })
    audio.dispose()
  }
  expect(clock.pendingTimers()).toBe(0)
})

test("source WAVs stay intact; PCM gain works for every native player", () => {
  for (const clip of ["charge", "pulse-a", "pulse-b", "pulse-c"]) {
    const bytes = new Uint8Array(readFileSync(path.join(import.meta.dir, "../assets/audio", `${clip}.wav`)))
    const muted = audioGain(bytes, 0)
    expect(audioGain(bytes, 1)).toEqual(bytes)
    expect(muted.subarray(0, 44)).toEqual(bytes.subarray(0, 44))
    expect(muted.subarray(44).every((value) => value === 0)).toBe(true)
    expect(bytes.subarray(44).some((value) => value !== 0)).toBe(true)
  }
  expect(audioArgs("ffplay", "/a b.wav")).toEqual(["-autoexit", "-nodisp", "-loglevel", "quiet", "/a b.wav"])
  expect(audioArgs("afplay", "/a b.wav")).toEqual(["/a b.wav"])
  expect(audioArgs("powershell.exe", "/a'b.wav").at(-1)).toContain("'/a''b.wav'")
})

async function until(check: () => boolean) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > 2_000) throw new Error("audio condition timed out")
    await Bun.sleep(5)
  }
}

async function boot(player: (clip: AudioClip, volume: number) => Promise<AudioProcess | undefined>) {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-audio-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "d.sock"), audioPlayer: player, engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  cleanups.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "audio-test", timeoutMs: 1_000 })
  cleanups.push(() => client.close())
  await client.connect()
  return { daemon, client }
}

test("protocol/client/daemon use connection-owned audio and reject invalid or read-only requests", async () => {
  const clips: ReturnType<typeof fakeProcess>[] = []
  const { client } = await boot(async () => { const child = fakeProcess(); clips.push(child); return child })
  expect(isReadOnlyCommand("audio.play")).toBe(false)
  expect(await client.activityAudio("start")).toEqual({ ok: true, result: { played: true } })
  expect(await client.send({ type: "audio.play", action: "pulse", scale: 2 })).toMatchObject({ ok: false, error: { code: "invalid_command" } })
  expect(await client.send({ type: "audio.play", action: "start", file: "/private.wav" } as never)).toMatchObject({ ok: false, error: { code: "invalid_command" } })
  client.close()
  await until(() => clips[0]!.kills === 1)
})

test("ephemeral audio is not replayed on reconnect, including the typed helper", async () => {
  let launches = 0
  let finish!: (child: AudioProcess) => void
  const { client } = await boot(() => { launches++; return new Promise((resolve) => { finish = resolve }) })
  const pending = client.activityAudio("start")
  await until(() => launches === 1)
  client.dropConnection()
  expect(await pending).toMatchObject({ ok: false })
  await client.connect()
  const child = fakeProcess()
  finish(child)
  await until(() => child.kills === 1)
  expect(launches).toBe(1)
  const sent = client.send({ type: "audio.play", action: "pulse" })
  await until(() => launches === 2)
  client.dropConnection()
  expect(await sent).toMatchObject({ ok: false })
  const pulse = fakeProcess()
  finish(pulse)
  await until(() => pulse.kills === 1)
})
