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
  let pending = ""
  const listeners = new Set<(mode: TerminalMode) => void>()

  function set(mode: TerminalMode) {
    if (mode === current) return
    current = mode
    for (const listener of listeners) listener(mode)
  }

  return {
    get mode() { return current },
    set,
    subscribe(listener: (mode: TerminalMode) => void) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    consume(data: string): string {
      const joined = pending + data
      pending = ""
      let rest = joined.replace(REPORT, (_, report: string | undefined, r: string, g: string, b: string) => {
        set(report ? (report === "1" ? "dark" : "light") : modeFromColor([r, g, b]))
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
