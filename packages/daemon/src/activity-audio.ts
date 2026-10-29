import type { Clock, TimerHandle } from "@mendcode/kernel"

export type AudioClip = "charge" | "pulse-a" | "pulse-b" | "pulse-c"
export type AudioProcess = { exited: Promise<unknown>; kill(): void }
export type AudioPlayer = (clip: AudioClip, volume: number) => Promise<AudioProcess | undefined>
type Track = { process: AudioProcess; timer: TimerHandle }
type Playback = { revision: number; shot: number; hum?: Track; pulse?: Track; tail?: TimerHandle }

/** One hum and one pulse per terminal; all timers/processes end with their owning socket. */
export function createActivityAudio(input: { dir: string; clock: Clock; player?: AudioPlayer }) {
  const owners = new Map<object, Playback>()
  let disposed = false
  const play: AudioPlayer = input.player ?? (async (clip, volume) => {
    const { playAudio } = await import("./activity-audio-player")
    return playAudio(input.dir, clip, volume)
  })

  function kill(track: Track | undefined) {
    if (!track) return
    track.timer.cancel()
    try { track.process.kill() } catch {}
  }

  function stopHum(state: Playback, delay = 0) {
    state.tail?.cancel()
    delete state.tail
    const hum = state.hum
    if (!hum) return
    if (!delay) {
      delete state.hum
      kill(hum)
    } else state.tail = input.clock.setTimer(delay, () => {
      delete state.tail
      if (state.hum === hum) delete state.hum
      kill(hum)
    })
  }

  function stop(state: Playback) {
    state.revision++
    stopHum(state)
    kill(state.pulse)
    delete state.pulse
  }

  async function launch(owner: object, state: Playback, clip: AudioClip, volume: number, slot: "hum" | "pulse") {
    const revision = state.revision
    let process: AudioProcess | undefined
    try { process = await play(clip, volume) } catch { return false }
    if (!process) return false
    void process.exited.catch(() => {})
    // Loading an embedded WAV or finding a player may finish after off/disconnect/start.
    if (disposed || owners.get(owner) !== state || state.revision !== revision) {
      try { process.kill() } catch {}
      return false
    }
    const track: Track = { process, timer: input.clock.setTimer(slot === "hum" ? 4_350 : 2_000, () => {
      if (state[slot] === track) delete state[slot]
      kill(track)
    }) }
    state[slot] = track
    const finish = () => {
      track.timer.cancel()
      if (state[slot] === track) {
        delete state[slot]
        if (slot === "hum") { state.tail?.cancel(); delete state.tail }
      }
    }
    void process.exited.then(finish, finish)
    return true
  }

  async function control(owner: object, action: "start" | "stop" | "pulse", scale = 1) {
    if (disposed) return { played: false }
    let state = owners.get(owner)
    if (action === "stop") {
      if (state) stop(state)
      return { played: false }
    }
    if (!state) { state = { revision: 0, shot: 0 }; owners.set(owner, state) }
    state.revision++
    if (action === "start") {
      stop(state)
      return { played: await launch(owner, state, "charge", 0.24, "hum") }
    }
    stopHum(state, 140)
    kill(state.pulse)
    delete state.pulse
    const clip = (["pulse-a", "pulse-b", "pulse-c"] as const)[state.shot++ % 3]!
    return { played: await launch(owner, state, clip, Math.round((0.26 + 0.14 * scale) * 100) / 100, "pulse") }
  }

  function forget(owner: object) {
    const state = owners.get(owner)
    if (state) stop(state)
    owners.delete(owner)
  }

  function dispose() {
    disposed = true
    for (const owner of owners.keys()) forget(owner)
  }

  return { control, forget, dispose }
}
