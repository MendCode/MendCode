export const IMAGE_MODES = ["auto", "kitty", "iterm2", "sixel", "off"] as const
export type ImageMode = (typeof IMAGE_MODES)[number]
export type ImageProtocol = Exclude<ImageMode, "auto">

const set = (value: string | undefined) => value !== undefined && value !== ""

/**
 * A terminal multiplexer between MendCode and the real terminal: tmux, GNU screen, or tuios (`TERM_PROGRAM=TUIOS`, `TUIOS_ENV`).
 * Pictures written through one were reserved rows it did not draw (a blank band under a message with an image, in tuios).
 */
export const insideMultiplexer = (env: Record<string, string | undefined>) => set(env.TMUX) || set(env.STY) || set(env.TUIOS_ENV) || env.TERM_PROGRAM?.toLowerCase() === "tuios"

/** Uses answers already collected by a host, never sends a terminal query itself. */
export function detectImageProtocol(env: Record<string, string | undefined>, mode: ImageMode = "auto", answers: { da1?: string } = {}): ImageProtocol {
  if (mode === "off") return "off"
  // MENDCODE_PET_IMAGES=1 is the user's own override: Kitty (or the profile's explicit protocol) even inside a multiplexer or SSH.
  if (env.MENDCODE_PET_IMAGES === "1") return mode === "auto" ? "kitty" : mode
  // There is no graphics passthrough in this client. Do not emit raw OSC/DCS/APC into a multiplexer.
  if (insideMultiplexer(env)) return "off"
  if (mode !== "auto") return mode
  if (env.MENDCODE_PET_IMAGES === "0") return "off"
  if (set(env.SSH_CONNECTION) || set(env.SSH_TTY)) return "off"
  const program = env.TERM_PROGRAM?.toLowerCase()
  if (set(env.KITTY_WINDOW_ID) || env.TERM?.toLowerCase().includes("kitty")) return "kitty"
  if (program === "kitty" || program === "ghostty" || env.TERM === "xterm-ghostty") return "kitty"
  if (program === "iterm.app" || program === "wezterm") return "iterm2"
  const attributes = /^\x1b\[\?(\d+(?:;\d+)*)c$/.exec(answers.da1 ?? "")?.[1]?.split(";").slice(1)
  return attributes?.includes("4") ? "sixel" : "off"
}

export type ImageTier = "kitty" | "iterm2" | "sixel" | "halfblock" | "off"

/** Graphics detection with the existing pet half-block fallback and legacy truecolor guard. */
export function detectImageTier(env: Record<string, string | undefined>, depth: "truecolor" | "256", mode: ImageMode = "auto", answers: { da1?: string } = {}): ImageTier {
  const protocol = detectImageProtocol(env, mode, answers)
  if (protocol === "off" || (protocol === "kitty" && mode === "auto" && depth === "256" && env.MENDCODE_PET_IMAGES !== "1")) return "halfblock"
  return protocol
}
