import { osc52Copy } from "./osc52"
import type { Line } from "./theme"
import { wrap } from "../view/wrap"

/**
 * The crash screen: an error nobody caught (an uncaught exception or a rejected promise) no longer leaves the terminal
 * in the alternate screen and raw mode with a stack trace on top. The unsent prompt is saved first, the screen shows what
 * happened, and the keys are: c copy the details, r go back to the app, q leave. After three crashes within ten seconds
 * going back is not offered: the app is not recovering.
 */

export const CRASH_WINDOW_MS = 10_000
export const CRASH_LIMIT = 3
const DETAIL_LIMIT = 8_000
const STACK_ROWS = 12

const SECRET = /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}|\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{12,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{12,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}|(?<=bearer\s)\S+|((?:api[_-]?key|token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^\s"',;]+/gi

/** The error as text a person can paste into a bug report: no secret-looking values, and the home directory as `~`. */
export function describeError(error: unknown, home?: string) {
  const text = error instanceof Error ? `${error.name}: ${error.message}${error.stack ? `\n${error.stack.split("\n").filter((row) => row.trim().startsWith("at ")).join("\n")}` : ""}` : String(error)
  const scrubbed = text.replace(SECRET, (match, prefix: string | undefined) => (prefix ? `${prefix}[hidden]` : "[hidden]"))
  const tidy = home && home.length > 1 ? scrubbed.split(home).join("~") : scrubbed
  return tidy.replace(/[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f]/g, "").slice(0, DETAIL_LIMIT)
}

/** What the copy key puts on the clipboard: the error, then the facts a maintainer asks for first. Never the environment. */
export function crashDetails(input: { error: unknown; version?: string | undefined; at: number; env: Record<string, string | undefined>; home?: string | undefined }) {
  const terminal = [input.env.TERM_PROGRAM, input.env.TERM].filter(Boolean).join(" · ")
  return [
    "MendCode terminal crash",
    `version: ${input.version ?? "unknown"}`,
    `time: ${new Date(input.at).toISOString()}`,
    `runtime: ${typeof Bun !== "undefined" ? `bun ${Bun.version}` : `node ${process.version}`} · ${process.platform} ${process.arch}`,
    `terminal: ${terminal || "unknown"}`,
    "",
    describeError(input.error, input.home),
  ].join("\n")
}

/** The screen's rows: what happened, what was kept, the keys. */
export function renderCrashScreen(input: { details: string; width: number; height: number; canReturn: boolean; copied: boolean; draftSaved: boolean }): Line[] {
  const inner = Math.max(20, input.width - 4)
  const [first = "", ...stack] = input.details.split("\n").slice(6)
  const keys = [
    { text: "c", fg: "accent" as const, bold: true }, { text: input.copied ? " copied  " : " copy details  ", fg: input.copied ? "success" as const : "muted" as const },
    ...(input.canReturn ? [{ text: "r", fg: "accent" as const, bold: true }, { text: " back to the app  ", fg: "muted" as const }] : []),
    { text: "q", fg: "accent" as const, bold: true }, { text: " leave", fg: "muted" as const },
  ]
  const rows: Line[] = [
    [],
    [{ text: "  MendCode hit an unexpected error", fg: "error", bold: true }],
    [],
    ...wrap(first, inner).map((text): Line => [{ text: `  ${text}`, fg: "text" }]),
    [],
    ...stack.slice(0, STACK_ROWS).flatMap((row) => wrap(row.trim(), inner).slice(0, 1).map((text): Line => [{ text: `  ${text}`, fg: "muted" }])),
    ...(stack.length > STACK_ROWS ? [[{ text: `  … ${stack.length - STACK_ROWS} more frames in the copied details`, fg: "muted" } as const]] as Line[] : []),
    [],
    [{ text: input.draftSaved ? "  What you were typing is saved and comes back in this session." : "  Saving what you were typing…", fg: "muted" }],
    [{ text: input.canReturn ? "  Going back may work, or crash again." : "  It crashed several times in a row: going back is off.", fg: "muted" }],
    [],
    [{ text: "  " }, ...keys],
  ]
  return Array.from({ length: Math.max(1, input.height) }, (_, index) => rows[index] ?? [])
}

type GuardScreen = {
  size: { width: number; height: number }
  hold(rows: Line[]): void
  release(): void
  invalidate(): void
  write(data: string): void
  /** With the keyboard protocol on, the keys arrive as `CSI u`: this turns them back into the single characters the screen reads. */
  translateKeys?(data: string): string
}

/** Catches what nothing else caught. `exit` restores the terminal and ends the process; `resume` draws the app again. */
export function createCrashGuard(input: {
  screen: GuardScreen
  now(): number
  version?: string | undefined
  env: Record<string, string | undefined>
  home?: string | undefined
  saveDrafts(): Promise<unknown>
  exit(code: number): void
  resume(): void
}) {
  const times: number[] = []
  let active = false
  let details = ""
  let copied = false
  let draftSaved = false
  let canReturn = true

  const draw = () => input.screen.hold(renderCrashScreen({ details, width: input.screen.size.width, height: input.screen.size.height, canReturn, copied, draftSaved }))

  async function handle(error: unknown) {
    const at = input.now()
    if (active) return
    times.push(at)
    while (times.length && at - times[0]! > CRASH_WINDOW_MS) times.shift()
    canReturn = times.length < CRASH_LIMIT
    active = true
    copied = false
    draftSaved = false
    details = crashDetails({ error, version: input.version, at, env: input.env, home: input.home })
    try { draw() } catch {
      // The screen itself is what broke: leave with the text on the plain stream.
      process.stderr.write(`${details}\n`)
      return input.exit(1)
    }
    await input.saveDrafts().catch(() => undefined)
    draftSaved = true
    if (active) draw()
  }

  /** Raw stdin while the screen is up. True when the read belonged to it (all of them do). */
  function onInput(raw: string) {
    if (!active) return false
    const data = input.screen.translateKeys?.(raw) ?? raw
    if (data === "c" || data === "C") {
      const sequence = osc52Copy(details, { tmux: Boolean(input.env.TMUX) })
      if (sequence) input.screen.write(sequence)
      copied = sequence !== undefined
      draw()
    } else if ((data === "r" || data === "R") && canReturn) {
      active = false
      input.screen.release()
      input.screen.invalidate()
      input.resume()
    } else if (data === "q" || data === "Q" || data === "\x03" || data === "\x04" || data === "\x1b") input.exit(1)
    return true
  }

  return {
    handle,
    onInput,
    get active() { return active },
    /** The terminal was resized while the screen is up. */
    redraw() { if (active) draw() },
  }
}

export type CrashGuard = ReturnType<typeof createCrashGuard>
