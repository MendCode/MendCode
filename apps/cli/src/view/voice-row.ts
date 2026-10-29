import type { Line } from "../ui/theme"
import { lineWidth } from "./deck"
import { truncateEnd } from "./wrap"

export type VoiceState = {
  phase: "recording" | "transcribing"
  startedAt: number
  maxSeconds: number
  /** Microphone levels 0..1, the newest last (on-device dictation reports them live). */
  levels: number[]
  /** What was heard so far (on-device dictation). */
  text?: string
  /** Started by holding space: letting go of it stops the recording. */
  held?: boolean
}

export function clockText(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
}

/** Bars drawn for the level, one cell each. */
export const VOICE_BARS = 16
const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]
const ASCII = [".", ".", ":", "-", "=", "+", "*", "#"]

/** The newest `count` levels as bars, the newest on the right; a quiet start reads as a flat line. */
export function levelBars(levels: readonly number[], count = VOICE_BARS, ascii = false): string {
  const glyphs = ascii ? ASCII : BLOCKS
  const recent = levels.slice(-count)
  const padded = [...Array.from({ length: count - recent.length }, () => 0), ...recent]
  return padded.map((level) => glyphs[Math.round(Math.max(0, Math.min(1, level)) * (glyphs.length - 1))]).join("")
}

/**
 * The line above the prompt while dictating: a red dot, bars that move with the voice, the clock, the words heard so far (the end
 * of them when long) and, at the right, how it stops. Without live levels (an upload provider) the bars stay flat.
 */
export function voiceRow({ voice, now, dot, width, ascii = false }: { voice: VoiceState; now: number; dot: string; width: number; ascii?: boolean }): Line {
  const hint = voice.phase === "transcribing" ? "" : voice.held ? "release space to stop · esc cancels" : "/voice or ctrl+x v to stop · esc cancels"
  // On a narrow row the words heard win over the keys.
  const keys = voice.text?.trim() && width - lineWidth([{ text: hint }]) < 50 ? "" : hint
  const head: Line = voice.phase === "transcribing"
    ? [{ text: dot, fg: "muted" }, { text: ` ${levelBars(voice.levels, VOICE_BARS, ascii)}`, fg: "muted" }, { text: "  finishing…", fg: "muted" }]
    : [
        { text: dot, fg: "error", bold: true },
        { text: ` ${levelBars(voice.levels, VOICE_BARS, ascii)}`, fg: "primary" },
        { text: `  ${clockText(now - voice.startedAt)}`, fg: "primary", bold: true },
      ]
  const room = width - lineWidth(head) - (keys ? lineWidth([{ text: keys }]) + 2 : 0) - 2
  const heard = voice.text?.trim()
  // The words keep their end in view: what was just said matters most.
  const words: Line = heard && room >= 8 ? [{ text: "  " }, { text: heard.length > room ? `…${heard.slice(-(room - 1))}` : heard, fg: "body" }] : voice.phase === "recording" && room >= 12 ? [{ text: "  listening", fg: "muted" }] : []
  const left: Line = [...head, ...words]
  if (!keys) return left
  const gap = width - lineWidth(left) - lineWidth([{ text: keys }])
  if (gap < 2) return [...left, { text: "  " }, { text: truncateEnd(keys, Math.max(0, width - lineWidth(left) - 2)), fg: "muted" }]
  return [...left, { text: " ".repeat(gap) }, { text: keys, fg: "muted" }]
}
