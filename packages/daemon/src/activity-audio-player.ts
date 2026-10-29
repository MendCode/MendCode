import { mkdirSync } from "node:fs"
import path from "node:path"
import charge from "../assets/audio/charge.wav" with { type: "file" }
import pulseA from "../assets/audio/pulse-a.wav" with { type: "file" }
import pulseB from "../assets/audio/pulse-b.wav" with { type: "file" }
import pulseC from "../assets/audio/pulse-c.wav" with { type: "file" }
import type { AudioClip, AudioProcess } from "./activity-audio"

const assets = { charge, "pulse-a": pulseA, "pulse-b": pulseB, "pulse-c": pulseC }
const players = ["afplay", "ffplay", "mpv", "play", "aplay", "paplay", "mplayer", "cvlc", "powershell.exe"] as const
type Player = (typeof players)[number]
const files = new Map<string, Promise<string>>()

export function audioArgs(player: Player, file: string) {
  if (player === "ffplay") return ["-autoexit", "-nodisp", "-loglevel", "quiet", file]
  if (player === "mpv") return ["--no-video", "--audio-display=no", "--really-quiet", file]
  if (player === "mplayer") return ["-vo", "null", "-really-quiet", file]
  if (player === "cvlc") return ["--play-and-exit", file]
  if (player === "powershell.exe") return ["-NoProfile", "-NonInteractive", "-Command", `(New-Object Media.SoundPlayer '${file.replace(/'/g, "''")}').PlaySync()`]
  return [file]
}

/** Apply gain to PCM itself so native players with no volume argument behave consistently. */
export function audioGain(source: Uint8Array, volume: number) {
  const bytes = source.slice()
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4))
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("Invalid audio asset")
  for (let at = 12; at + 8 <= bytes.length;) {
    const size = view.getUint32(at + 4, true)
    if (at + 8 + size > bytes.length) throw new Error("Invalid audio chunk")
    if (tag(at) === "fmt " && (view.getUint16(at + 8, true) !== 1 || view.getUint16(at + 22, true) !== 16)) throw new Error("Expected PCM16 audio")
    if (tag(at) === "data") for (let i = at + 8; i + 1 < at + 8 + size; i += 2) view.setInt16(i, Math.round(view.getInt16(i, true) * volume), true)
    at += 8 + size + (size % 2)
  }
  return bytes
}

async function asset(dir: string, clip: AudioClip, volume: number) {
  const file = path.join(dir, "audio-sfx", `${clip}-${Math.round(volume * 100)}.wav`)
  let pending = files.get(file)
  if (!pending) {
    pending = (async () => {
      const source = new Uint8Array(await Bun.file(assets[clip]).arrayBuffer())
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      await Bun.write(file, audioGain(source, volume))
      return file
    })()
    files.set(file, pending)
    void pending.catch(() => files.delete(file))
  }
  return pending
}

export async function playAudio(dir: string, clip: AudioClip, volume: number): Promise<AudioProcess | undefined> {
  const player = players.find((name) => Bun.which(name))
  if (!player) return
  const file = await asset(dir, clip, volume)
  const child = Bun.spawn([player, ...audioArgs(player, file)], { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
  return { exited: child.exited, kill: () => child.kill() }
}
