import type { Line } from "../ui/theme"
import { keyName } from "../ui/keymap"
import { isMac, keyText } from "../ui/key-labels"
import { isAltSequence, OPTION_TYPED } from "./option-keys"
import { clip, panelGrid } from "./deck"
import { pickerFrame } from "./picker-frame"
import { wrap } from "./wrap"

/**
 * `/terminal-setup`: which terminal this is and the setting that makes Shift+Enter insert a newline in the prompt, and on a Mac the one that
 * makes Option send Alt. It prints the instructions. For the three terminals whose setting is a plain config line (kitty, Ghostty, Alacritty)
 * the `a` key can add the line to the terminal's configuration file after a confirmation (ui/terminal-config.ts does that); nothing else is edited.
 */
export type TerminalKind = "kitty" | "wezterm" | "alacritty" | "ghostty" | "iterm2" | "apple" | "vscode" | "windows-terminal" | "zed" | "jetbrains" | "konsole" | "gnome" | "other"
export type TerminalGuide = { kind: TerminalKind; name: string; where: string; steps: string[]; snippet: string[] }
/** The two settings the page shows: Option as Alt (a Mac) and the Shift+Enter newline. */
export type SetupTopic = "option" | "enter"
/** What the `a` key is doing: asking before it writes, or the outcome of the last try. */
export type ApplyView = { stage: "confirm"; file: string; lines: string[]; created: boolean } | { stage: "done" | "info" | "error"; text: string }
/** `option` (macOS only) shows how to make Option send Alt; no topic is the Shift+Enter setup. Tab switches between them on a Mac. */
export type TerminalSetupState = { guide: number; lastKey?: string; topic?: "option"; apply?: ApplyView }

/** The terminals whose setting is a plain line the page can add (ui/terminal-config.ts has the rules per terminal). */
export const APPLIES: readonly TerminalKind[] = ["ghostty", "kitty", "alacritty"]
export type Detected = { kind: TerminalKind; tmux: boolean; screen: boolean }

/** The sequence a terminal must send for Shift+Enter; the prompt reads it as a newline. */
export const SHIFT_ENTER_SEQUENCE = "\\u001b[13;2u"

/** On a Mac the page opens on the Option setup: without it none of the alt+key bindings work. */
export const createTerminalSetupState = (platform?: string): TerminalSetupState => isMac(platform) ? { guide: 0, topic: "option" } : { guide: 0 }

export function detectTerminal(env: Record<string, string | undefined>): Detected {
  const program = (env.TERM_PROGRAM ?? "").toLowerCase()
  const term = (env.TERM ?? "").toLowerCase()
  const kind: TerminalKind =
    env.KITTY_WINDOW_ID || term.includes("kitty") ? "kitty"
    : env.WEZTERM_EXECUTABLE || program === "wezterm" ? "wezterm"
    : env.GHOSTTY_RESOURCES_DIR || program === "ghostty" || term.includes("ghostty") ? "ghostty"
    : env.ALACRITTY_LOG || env.ALACRITTY_SOCKET || term === "alacritty" ? "alacritty"
    : program === "iterm.app" || env.ITERM_SESSION_ID ? "iterm2"
    : program === "apple_terminal" ? "apple"
    : program === "vscode" || env.VSCODE_INJECTION ? "vscode"
    : env.WT_SESSION ? "windows-terminal"
    : env.ZED_TERM ? "zed"
    : (env.TERMINAL_EMULATOR ?? "").toLowerCase().includes("jetbrains") ? "jetbrains"
    : env.KONSOLE_VERSION ? "konsole"
    : env.VTE_VERSION ? "gnome"
    : "other"
  return { kind, tmux: Boolean(env.TMUX), screen: Boolean(env.STY) }
}

const UNIVERSAL = ["Alt+Enter and Ctrl+J insert a newline in every terminal, with no setup."]
/** On a Mac Option sends Alt only when the terminal is set to (see `OPTION_FIXES`), so only Ctrl+J is universal. */
const UNIVERSAL_MAC = ["Ctrl+J is a newline everywhere. Option+Enter needs the setting."]

/**
 * macOS: the terminal setting that makes Option send Alt (an Esc prefix) instead of the character Option+key types (Option+Q is `œ`).
 * Without it every alt+key binding of MendCode is out of reach. `short` is the one-line form the "Option is not Alt" toast shows as its
 * hint, with " · /terminal-setup" after it: the toast box cuts a hint at 54 cells, so `short` stays within 36.
 * Checked against each terminal's documentation except VS Code, Zed and JetBrains (written from their settings' names).
 */
export type OptionFix = { where: string; steps: string[]; snippet: string[]; short: string }
const OPTION_FIXES: Readonly<Partial<Record<TerminalKind, OptionFix>>> = {
  ghostty: { where: "~/.config/ghostty/config", steps: ["Add the line, then reload (cmd+shift+,).", "On by default for US layouts only.", "Use left to keep the right Option for accents."], snippet: ["macos-option-as-alt = true"], short: "Ghostty: macos-option-as-alt = true" },
  kitty: { where: "~/.config/kitty/kitty.conf", steps: ["Add the line and restart kitty."], snippet: ["macos_option_as_alt both"], short: "kitty: macos_option_as_alt both" },
  wezterm: { where: "~/.wezterm.lua", steps: ["The left Option key already sends Alt; the right one types characters.", "Add the lines to your config to make both send Alt."], snippet: ["config.send_composed_key_when_left_alt_is_pressed = false", "config.send_composed_key_when_right_alt_is_pressed = false"], short: "WezTerm: right_alt compose = false" },
  alacritty: { where: "~/.config/alacritty/alacritty.toml", steps: ["Add the setting; Alacritty applies it on save."], snippet: ["[window]", `option_as_alt = "Both"`], short: `Alacritty: option_as_alt = "Both"` },
  iterm2: { where: "Settings > Profiles > Keys > General", steps: ["Set Left Option key to Esc+ (and Right Option key too, if you use it)."], snippet: [], short: "iTerm2: Left Option key = Esc+" },
  apple: { where: "Settings > Profiles > Keyboard", steps: [`Tick "Use Option as Meta key".`], snippet: [], short: "Terminal: Use Option as Meta key" },
  vscode: { where: "Settings (JSON): cmd+shift+p > Open User Settings (JSON)", steps: ["Add the entry to settings.json."], snippet: [`"terminal.integrated.macOptionIsMeta": true`], short: "VS Code: macOptionIsMeta = true" },
  zed: { where: "Zed settings (cmd+,)", steps: ["Add the entry to the settings file."], snippet: [`"terminal": { "option_as_meta": true }`], short: "Zed: terminal.option_as_meta = true" },
  jetbrains: { where: "Settings > Tools > Terminal", steps: [`Tick "Use Option as Meta key".`], snippet: [], short: "JetBrains: Use Option as Meta key" },
}
const OPTION_OTHER: OptionFix = { where: "your terminal's keyboard settings", steps: [`Turn on the setting that makes Option send Esc or Meta (often "Option as Alt" or "Option as Meta").`], snippet: [], short: "turn on Option as Meta/Alt" }
export const optionFix = (kind: TerminalKind): OptionFix => OPTION_FIXES[kind] ?? OPTION_OTHER

/** The configuration lines a topic adds for a terminal: exactly the snippet the page shows. */
export const configLines = (kind: TerminalKind, topic: SetupTopic): string[] => [...(topic === "option" ? optionFix(kind).snippet : GUIDES[kind].snippet)]

/** The toast, once, for a character an Option key typed that MendCode ran as the key it stands for: what came out, what ran, and the fix that makes Option a real Alt. */
export function optionNotice({ kind, char, key }: { kind: TerminalKind; char: string; key: string }): { message: string; hint: string } {
  return { message: keyText(`Option typed ${char}: ran ${key}`), hint: `${optionFix(kind).short} · /terminal-setup` }
}

const GUIDES: Readonly<Record<TerminalKind, TerminalGuide>> = {
  kitty: { kind: "kitty", name: "kitty", where: "~/.config/kitty/kitty.conf", steps: ["Add the line, then reload with ctrl+shift+f5."], snippet: ["map shift+enter send_text all \\x1b[13;2u"] },
  wezterm: { kind: "wezterm", name: "WezTerm", where: "~/.wezterm.lua", steps: ["Add the binding to the keys table of your config; WezTerm reloads it on save."], snippet: [`{ key = "Enter", mods = "SHIFT",`, `  action = wezterm.action.SendString("\\x1b[13;2u") },`] },
  alacritty: { kind: "alacritty", name: "Alacritty", where: "~/.config/alacritty/alacritty.toml", steps: ["Add the binding; Alacritty applies it on save."], snippet: ["[[keyboard.bindings]]", `key = "Return"`, `mods = "Shift"`, `chars = "${SHIFT_ENTER_SEQUENCE}"`] },
  ghostty: { kind: "ghostty", name: "Ghostty", where: "~/.config/ghostty/config", steps: ["Add the line and reload the config (cmd+shift+, or ctrl+shift+,)."], snippet: ["keybind = shift+enter=text:\\x1b[13;2u"] },
  iterm2: { kind: "iterm2", name: "iTerm2", where: "Settings > Profiles > Keys > Key Mappings", steps: ["Press + to add a mapping.", "Shortcut: Shift+Return. Action: Send Hex Code.", "Hex code: 0x1b 0x5b 0x31 0x33 0x3b 0x32 0x75"], snippet: ["0x1b 0x5b 0x31 0x33 0x3b 0x32 0x75"] },
  apple: { kind: "apple", name: "Terminal.app", where: "Settings > Profiles > Keyboard", steps: ["Terminal.app cannot map Shift+Enter to a sequence.", "Tick \"Use Option as Meta key\": Option+Enter then sends Alt+Enter, a newline."], snippet: [] },
  vscode: { kind: "vscode", name: "VS Code terminal", where: "Keyboard Shortcuts (JSON): cmd/ctrl+shift+p > Open Keyboard Shortcuts (JSON)", steps: ["Add the entry to keybindings.json."], snippet: ["{", `  "key": "shift+enter",`, `  "command": "workbench.action.terminal.sendSequence",`, `  "when": "terminalFocus",`, `  "args": { "text": "${SHIFT_ENTER_SEQUENCE}" }`, "}"] },
  "windows-terminal": { kind: "windows-terminal", name: "Windows Terminal", where: "Settings > Open JSON file", steps: ["Add the entry to the actions array."], snippet: ["{", `  "command": { "action": "sendInput", "input": "${SHIFT_ENTER_SEQUENCE}" },`, `  "keys": "shift+enter"`, "}"] },
  zed: { kind: "zed", name: "Zed terminal", where: "Zed keymap (cmd+k cmd+s > Open Keymap File)", steps: ["Add the binding in the Terminal context."], snippet: ["{", `  "context": "Terminal",`, `  "bindings": {`, `    "shift-enter": ["terminal::SendText", "\\u001b[13;2u"]`, `  }`, "}"] },
  jetbrains: { kind: "jetbrains", name: "JetBrains terminal", where: "Settings > Tools > Terminal", steps: ["The built-in terminal does not report Shift+Enter apart from Enter.", "Use Alt+Enter, or Settings > Keymap > Terminal to bind Shift+Enter to Send Text."], snippet: [] },
  konsole: { kind: "konsole", name: "Konsole", where: "Settings > Edit Current Profile > Keyboard > Edit", steps: ["Add an entry: key Return+Shift, output \\E[13;2u (Konsole writes \\E for escape)."], snippet: ["Return+Shift : \"\\E[13;2u\""] },
  gnome: { kind: "gnome", name: "GNOME Terminal / VTE", where: "no key mapping setting", steps: ["VTE terminals cannot rebind Shift+Enter.", "Use Alt+Enter or Ctrl+J, or run MendCode in a terminal that can."], snippet: [] },
  other: { kind: "other", name: "Other terminal", where: "your terminal's key mapping", steps: ["Map Shift+Enter to send the text below (escape, [, 1, 3, ;, 2, u).", "Terminals with the kitty keyboard protocol or modifyOtherKeys send it themselves."], snippet: [SHIFT_ENTER_SEQUENCE] },
}

/** The detected terminal's guide first, then the others in a stable order. */
export function terminalGuides(detected: Detected): TerminalGuide[] {
  const first = GUIDES[detected.kind]
  return [first, ...Object.values(GUIDES).filter((guide) => guide.kind !== first.kind)]
}

const TMUX_NOTE = ["tmux sits between the terminal and MendCode and drops the modifier unless extended keys are on.", "Add to ~/.tmux.conf and reload (tmux source ~/.tmux.conf):"]
const TMUX_SNIPPET = ["set -g extended-keys on", "set -as terminal-features 'xterm*:extkeys'", "bind-key -n S-Enter send-keys Escape \"[13;2u\""]

/** What the prompt does with a key the terminal sent, for the live check on the page. */
export function describeKeyPress(seq: string): { name: string; newline: boolean; text: string } {
  const newline = ["\x1b[13;2u", "\x1b[27;2;13~", "\x1b[13;5u", "\x1b[27;5;13~", "\x1b[13;3u", "\x1b\r", "\n"].includes(seq)
  const name = seq === "\r" ? "enter" : seq === "\x1b[13;2u" || seq === "\x1b[27;2;13~" ? "shift+enter" : seq === "\x1b\r" || seq === "\x1b[13;3u" ? "alt+enter" : seq === "\x1b[13;5u" || seq === "\x1b[27;5;13~" ? "ctrl+enter" : seq === "\n" ? "ctrl+j (or enter sent as a line feed)" : keyName(seq) ?? JSON.stringify(seq).slice(1, -1)
  const text = newline ? `${name}: inserts a newline` : seq === "\r" ? "enter: sends the prompt. If you pressed Shift+Enter, the terminal does not tell it apart; apply the setting below" : `${name}: not a newline key`
  return { name, newline, text }
}

/** What the prompt makes of a key pressed on the Option topic: Option sent Alt, typed a character, or was not an Option key. */
export function describeOptionPress(seq: string): { name: string; works: boolean; text: string } {
  const typed = OPTION_TYPED[seq]
  if (typed) {
    const name = keyName(typed) ?? typed
    return { name: seq, works: false, text: `${seq}: Option typed a character, not Alt (${name} does not fire)` }
  }
  if (isAltSequence(seq)) {
    const name = keyName(seq) ?? JSON.stringify(seq).slice(1, -1)
    return { name, works: true, text: `${name}: Option sends Alt, the alt+key bindings work` }
  }
  return { name: keyName(seq) ?? JSON.stringify(seq).slice(1, -1), works: false, text: `${keyName(seq) ?? JSON.stringify(seq).slice(1, -1)}: not an Option key` }
}

export function renderTerminalSetupPage(input: { env: Record<string, string | undefined>; state: TerminalSetupState; width: number; height: number; platform?: string; /** The app can write the terminal's configuration (it knows the user's home). */ canApply?: boolean }): Line[] {
  const { env, state, width, height } = input
  const mac = isMac(input.platform)
  const option = mac && state.topic === "option"
  const detected = detectTerminal(env)
  const guides = terminalGuides(detected)
  const guide = guides[Math.min(state.guide, guides.length - 1)]!
  const lines = (text: string, w: number, fg: "text" | "muted" | "success" | "warning" = "text"): Line[] => wrap(text, w).map((row) => [{ text: row, fg }])
  const detectedText = `${GUIDES[detected.kind].name}${detected.tmux ? " in tmux" : detected.screen ? " in screen" : ""}`
  const key = state.lastKey === undefined ? undefined : describeKeyPress(state.lastKey)
  const optionKey = state.lastKey === undefined ? undefined : describeOptionPress(state.lastKey)
  const apply = state.apply
  const applyLines = (w: number): Line[] => !apply ? [] : apply.stage === "confirm"
    ? [...lines(`Add to ${apply.file}${apply.created ? " (new file)" : ""}:`, w), ...apply.lines.flatMap((row): Line[] => wrap(row, Math.max(1, w - 2)).map((part) => [{ text: `  ${part}`, fg: "primary" }])), ...lines("y writes it · any other key cancels", w, "warning")]
    : lines(apply.text, w, apply.stage === "done" ? "success" : apply.stage === "error" ? "warning" : "muted")
  const check = (w: number): Line[] => apply ? applyLines(w) : [
    ...(option
      ? lines(optionKey ? keyText(optionKey.text) : "Press Option+Q now to see what your terminal sends.", w, optionKey ? (optionKey.works ? "success" : "warning") : "muted")
      : lines(key ? keyText(key.text) : "Press Shift+Enter now to see what your terminal sends.", w, key ? (key.newline ? "success" : "warning") : "muted")),
    ...(state.lastKey ? [[{ text: `bytes: ${JSON.stringify(state.lastKey).slice(1, -1)}`, fg: "muted" } as const] as Line] : []),
    [],
    ...(mac ? UNIVERSAL_MAC : UNIVERSAL).flatMap((text) => lines(text, w, "muted")),
  ]
  const fix = optionFix(guide.kind)
  const optionInstructions = (w: number): Line[] => [
    [{ text: `${guide.name}${guide.kind === detected.kind ? " · detected" : ""}`, fg: "heading", bold: true }],
    ...lines(fix.where, w, "muted"),
    // The line to add comes before the notes: a short terminal cuts the end of the panel, never the setting.
    ...(fix.snippet.length ? [[], ...fix.snippet.flatMap((row): Line[] => wrap(row, w).map((part) => [{ text: part, fg: "primary" }]))] : []),
    [],
    ...fix.steps.flatMap((step) => lines(step, w)),
  ]
  const instructions = (w: number): Line[] => option ? optionInstructions(w) : [
    [{ text: `${guide.name}${guide.kind === detected.kind ? " · detected" : ""}`, fg: "heading", bold: true }],
    ...lines(guide.where, w, "muted"),
    [],
    ...guide.steps.flatMap((step) => lines(step, w)),
    ...(guide.snippet.length ? [[], ...guide.snippet.flatMap((row): Line[] => wrap(row, w).map((part) => [{ text: part, fg: "primary" }]))] : []),
    ...(detected.tmux ? [[], ...TMUX_NOTE.flatMap((text) => lines(text, w, "warning")), ...TMUX_SNIPPET.flatMap((row): Line[] => wrap(row, w).map((part) => [{ text: part, fg: "primary" }]))] : []),
  ]
  const choices = (w: number): Line[] => guides.map((item, index) => clip([{ text: index === state.guide ? "› " : "  ", fg: "primary" }, { text: item.name, fg: index === state.guide ? "primary" : "text" }, { text: item.kind === detected.kind ? " · detected" : "", fg: "muted" }], w))
  const compact = width < 70
  const setupTitle = option ? "Option as Alt" : "Setup"
  const panels = compact
    ? [{ title: setupTitle, active: true, scroll: 0, body: instructions }]
    : [{ title: "Terminals", active: false, scroll: 0, weight: 1, body: choices }, { title: setupTitle, active: true, scroll: 0, weight: 2, body: instructions }]
  const room = Math.max(0, height - 2)
  const baseCheck = Math.min(8, Math.max(5, Math.floor(room / 3)))
  // The question lists the lines it would add and must never be cut: the panel grows for it (borders, padding, the heading and the prompt).
  const checkHeight = apply?.stage === "confirm" ? Math.min(Math.max(baseCheck, apply.lines.length + 6), Math.max(baseCheck, room - 8)) : baseCheck
  const offersApply = input.canApply === true && APPLIES.includes(guide.kind)
  const hints = `↑↓ terminal${offersApply ? " · a add it" : ""}${mac ? ` · tab ${option ? "Shift+Enter" : "Option as Alt"}` : ""} · any key tests it · esc back`
  return pickerFrame("Terminal setup", hints, width, height, panelGrid({
    width, padding: true, compact, maxColumns: compact ? 1 : 2, heights: [Math.max(0, room - checkHeight - 1), checkHeight],
    rows: [panels, [{ title: apply ? "Add the setting" : "Key check", active: apply?.stage === "confirm", scroll: 0, body: check }]],
  }), `Detected: ${detectedText}. ${offersApply ? "Nothing is written unless you press a and confirm." : "Instructions only: nothing is changed for you."}`)
}
