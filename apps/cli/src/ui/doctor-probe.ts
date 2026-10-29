import { detectImageTier, type ImageMode } from "../pets/detect"
import { detectTerminal, terminalGuides, type TerminalKind } from "../view/terminal-setup-page"
import { colorDepth } from "./theme"
import { keyText } from "./key-labels"

/**
 * `/doctor`'s terminal probe. It reads the environment and what the terminal already told this client (focus reports,
 * the window size, the image protocol in use); it writes nothing to the terminal, so there is nothing to answer and no
 * input to swallow. Facts a terminal cannot be asked without risking junk in the prompt are labelled as unknown, with
 * the setting that makes them work.
 */
export type ProbeStatus = "ok" | "warn" | "info"
export type ProbeItem = { status: ProbeStatus; name: string; detail: string; fix?: string }

export type ProbeInput = {
  env: Record<string, string | undefined>
  size: { width: number; height: number }
  /** What the screen last heard of the window focus (`unknown` until a report arrives). */
  focus: "unknown" | "focused" | "unfocused" | undefined
  /** The image protocol the screen draws with now (`off` when none). */
  imageProtocol: string | undefined
  imageMode: ImageMode
  turnNotify: "off" | "osc9" | "osc777"
  notifyWhen: "unfocused" | "always"
  tty: boolean
}

const OSC52_SUPPORT: Partial<Record<TerminalKind, { ok: boolean; note: string }>> = {
  kitty: { ok: true, note: "kitty reads OSC 52 writes" },
  wezterm: { ok: true, note: "WezTerm reads OSC 52 writes" },
  ghostty: { ok: true, note: "Ghostty reads OSC 52 writes" },
  iterm2: { ok: true, note: "iTerm2 needs Settings > General > Selection > Applications in terminal may access clipboard" },
  alacritty: { ok: true, note: "Alacritty reads OSC 52 writes (terminal.osc52 = \"OnlyCopy\" or \"CopyPaste\")" },
  "windows-terminal": { ok: true, note: "Windows Terminal reads OSC 52 writes" },
  apple: { ok: false, note: "Terminal.app ignores OSC 52" },
}

const KEY_NOTE: Partial<Record<TerminalKind, string>> = {
  apple: "Terminal.app cannot map Shift+Enter",
  gnome: "VTE terminals cannot rebind Shift+Enter",
  jetbrains: "the JetBrains terminal does not tell Shift+Enter from Enter",
}

export function probeTerminal(input: ProbeInput): ProbeItem[] {
  const { env, size } = input
  const detected = detectTerminal(env)
  const name = terminalGuides(detected)[0]!.name
  const items: ProbeItem[] = []
  const add = (status: ProbeStatus, label: string, detail: string, fix?: string) => void items.push({ status, name: label, detail, ...(fix ? { fix } : {}) })

  const term = env.TERM ?? ""
  if (!input.tty) add("warn", "Terminal", "output is not a terminal", "run MendCode in a terminal window, not a pipe")
  else if (term === "dumb" || term === "") add("warn", "Terminal", `${name} · TERM=${term || "unset"}`, "set TERM to a real terminal type such as xterm-256color")
  else add("ok", "Terminal", `${name} · TERM=${term}${detected.tmux ? " · inside tmux" : detected.screen ? " · inside screen" : ""}${env.SSH_CONNECTION || env.SSH_TTY ? " · over SSH" : ""}`)

  if (colorDepth(env) === "truecolor") add("ok", "Colors", `truecolor (COLORTERM=${env.COLORTERM})`)
  else add("warn", "Colors", "256 colors: gradients and themes are approximated", "export COLORTERM=truecolor if your terminal supports it (most do)")
  if (env.NO_COLOR) add("info", "NO_COLOR", "set in the environment; MendCode still draws with theme colors")

  if (size.width < 80 || size.height < 24) add("warn", "Window size", `${size.width} x ${size.height}`, "80 x 24 is the smallest size every page is laid out for")
  else add("ok", "Window size", `${size.width} x ${size.height}`)

  const lang = `${env.LC_ALL ?? ""}${env.LC_CTYPE ?? ""}${env.LANG ?? ""}`
  if (lang && !/utf-?8/i.test(lang)) add("warn", "Locale", `${env.LC_ALL || env.LC_CTYPE || env.LANG} is not UTF-8`, "export LANG=en_US.UTF-8 so box lines and symbols draw correctly")
  else add("ok", "Locale", lang ? "UTF-8" : "not set; assuming UTF-8")

  const keyNote = KEY_NOTE[detected.kind]
  add("info", "Shift+Enter", keyNote ?? `${name} can send it as a newline once mapped`, keyNote ? keyText("use Alt+Enter or Ctrl+J, which work in every terminal") : "/terminal-setup shows the setting and checks what the terminal sends")

  const osc52 = OSC52_SUPPORT[detected.kind]
  if (osc52 && !osc52.ok) add("warn", "Clipboard (OSC 52)", osc52.note, "/copy cannot reach the clipboard here; select text with the mouse while holding shift or option")
  else if (detected.tmux) add("warn", "Clipboard (OSC 52)", "inside tmux, copying works only when tmux passes it on", "set -g set-clipboard on and set -g allow-passthrough on in ~/.tmux.conf")
  else add("info", "Clipboard (OSC 52)", osc52?.note ?? "copying goes through OSC 52; a terminal cannot be asked whether it listens", "if /copy puts nothing on the clipboard, enable OSC 52 in the terminal's settings")

  if (detected.tmux) add("warn", "tmux", "image protocols are off in tmux; focus and notifications need passthrough", "set -g focus-events on, set -g allow-passthrough on, set -g extended-keys on")
  else if (detected.screen) add("warn", "screen", "GNU screen drops most terminal extensions", "use tmux, or a terminal window without a multiplexer, for images and notifications")

  const tier = detectImageTier(env, colorDepth(env), input.imageMode)
  const using = input.imageProtocol ?? "off"
  if (using !== "off") add("ok", "Images", `drawing with ${using}`)
  else if (tier === "kitty" || tier === "iterm2" || tier === "sixel") add("info", "Images", `${tier} is available but images are off`, "/customize > Images: auto")
  else add("info", "Images", detected.tmux ? "off inside tmux" : "this terminal has no graphics protocol MendCode recognizes", "pets fall back to text characters")

  if (input.focus === "focused" || input.focus === "unfocused") add("ok", "Focus reports", `the terminal reports its focus (now ${input.focus})`)
  else add("info", "Focus reports", "none received yet", input.notifyWhen === "unfocused" ? "click out of the window and back; if nothing changes, notices go out whether or not you are looking (tmux: set -g focus-events on)" : undefined)

  if (input.turnNotify === "off") add("info", "Desktop notice", "off", "/customize > Desktop notice: osc9 or osc777; or a Notification hook runs a command")
  else add("ok", "Desktop notice", `${input.turnNotify} · ${input.notifyWhen === "unfocused" ? "only while the window is not focused" : "always"}`, "if nothing appears, try the other mode; the terminal must support it and allow notifications")

  return items
}

/** The text page's lines: one bullet per item, with the fix after the facts. */
export function probeLines(items: ProbeItem[]): string[] {
  return items.map((item) => `- ${item.status === "ok" ? "ok  " : item.status === "warn" ? "warn" : "note"} · ${item.name}: ${item.detail}${item.fix ? ` → ${item.fix}` : ""}`)
}
