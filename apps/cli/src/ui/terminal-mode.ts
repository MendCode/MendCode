import type { Theme } from "../themes/define"

export type TerminalMode = "dark" | "light"

/** Turns on mode-change reports (DEC 2031) and asks for the current mode (DEC 996 and the OSC 11 background colour). */
export const MODE_SUBSCRIBE = "\x1b[?2031h\x1b[?996n\x1b]11;?\x07"
export const MODE_UNSUBSCRIBE = "\x1b[?2031l"

const REPORT = /\x1b\[\?997;([12])n|\x1b\]11;rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})(?:\x07|\x1b\\)/gi
/** A reply cut by the chunk boundary, from its number on; a lone Esc, `Esc [` or `Esc ]` (alt+]) is a key press and is never held back. */
const PARTIAL = /\x1b\](?:1|11|11;[^\x07\x1b]*\x1b?)$|\x1b\[\?997(?:;\d*)?$/

/** `COLORFGBG` is `fg;bg` (or `fg;default;bg`): background 7 and 9-15 are light, the rest dark. */
export function modeFromEnv(env: Record<string, string | undefined>): TerminalMode | undefined {
  const background = Number.parseInt((env.COLORFGBG ?? "").split(";").at(-1) ?? "", 10)
  if (!Number.isInteger(background) || background < 0 || background > 15) return undefined
  return background === 7 || background >= 9 ? "light" : "dark"
}

function modeFromColor(channels: string[]): TerminalMode {
  const [r, g, b] = channels.map((hex) => Number.parseInt(hex, 16) / (16 ** hex.length - 1))
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! < 0.5 ? "dark" : "light"
}

/**
 * The terminal's light/dark background as far as it can be told: `COLORFGBG` at start, then the terminal's own
 * replies (a mode report or the OSC 11 colour). `consume` removes those replies from raw input so they never become
 * editor text.
 */
export function createTerminalMode(env: Record<string, string | undefined> = process.env) {
  let current = modeFromEnv(env)
  let answered = false
  let pending = ""
  const listeners = new Set<(mode: TerminalMode) => void>()

  function set(mode: TerminalMode, announce = false) {
    if (mode === current && !announce) return
    current = mode
    for (const listener of listeners) listener(mode)
  }

  return {
    get mode() { return current },
    /** The terminal answered the OSC 11 colour query: it knows OSC 11, so it can take a background colour too. */
    get answered() { return answered },
    set,
    subscribe(listener: (mode: TerminalMode) => void) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    consume(data: string): string {
      const joined = pending + data
      pending = ""
      let rest = joined.replace(REPORT, (_, report: string | undefined, r: string, g: string, b: string) => {
        if (report) set(report === "1" ? "dark" : "light")
        else {
          // The first answer is announced even when COLORFGBG had guessed the same mode: it is what lets the theme's background be painted.
          const first = !answered
          answered = true
          set(modeFromColor([r, g, b]), first)
        }
        return ""
      })
      const partial = PARTIAL.exec(rest)
      if (partial) {
        pending = partial[0]
        rest = rest.slice(0, partial.index)
      }
      return rest
    },
  }
}

export type TerminalModeTracker = ReturnType<typeof createTerminalMode>

/** The terminal's default colours, set to a theme's own (OSC 10 text, 11 background, 12 cursor). */
export type BackgroundPaint = { background: string; text: string; cursor: string }

/** Puts the terminal's own default colours back (OSC 110, 111, 112). */
export const PAINT_RESET = "\x1b]110\x07\x1b]111\x07\x1b]112\x07"

/**
 * Whether the theme's background is painted behind every cell: when the terminal answered the OSC 11 query and its
 * light/dark mode is not the theme's (a light theme in a dark terminal draws dark text on black otherwise), or when
 * the theme asks for it (`paintBackground: "always"`). A theme that matches its terminal, a terminal that never
 * answered, a theme in the terminal's own palette (`ansi`) or `paintBackground: "never"` keeps the terminal's colours.
 */
export function backgroundPaint({ theme, mode, answered }: { theme: Pick<Theme, "dark" | "background" | "colors" | "ansi" | "paintBackground">; mode: TerminalMode | undefined; answered: boolean }): BackgroundPaint | undefined {
  if (theme.ansi || theme.paintBackground === "never") return undefined
  const mismatch = answered && mode !== undefined && mode !== (theme.dark ? "dark" : "light")
  if (!mismatch && theme.paintBackground !== "always") return undefined
  return { background: theme.background, text: theme.colors.text, cursor: theme.colors.text }
}

const oscColor = (hex: string) => `rgb:${hex.slice(1, 3)}/${hex.slice(3, 5)}/${hex.slice(5, 7)}`

/** The sequence that sets the terminal's default colours to `paint`, or puts the terminal's own back when there is none. */
export function paintSequence(paint: BackgroundPaint | undefined): string {
  if (!paint) return PAINT_RESET
  return `\x1b]10;${oscColor(paint.text)}\x07\x1b]11;${oscColor(paint.background)}\x07\x1b]12;${oscColor(paint.cursor)}\x07`
}
