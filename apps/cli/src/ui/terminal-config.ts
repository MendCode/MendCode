import { appendFileSync, mkdirSync, readFileSync } from "node:fs"
import path from "node:path"
import type { SetupTopic, TerminalKind } from "../view/terminal-setup-page"

/**
 * `/terminal-setup` > apply: add the setting the page shows to the terminal's own configuration file, after the user agreed.
 * Only kitty, Ghostty and Alacritty keep it as a plain line. The file is only ever appended to (or created); a file that already sets the
 * key differently, or that cannot take the line at its end, is left as it is and the page says what to do by hand.
 */
export type ConfigFiles = {
  /** The text of the file, or undefined when it does not exist. Throws for any other failure. */
  read(file: string): string | undefined
  /** Adds the text at the end, creating the file and its folder when missing. */
  append(file: string, text: string): void
}

export const nodeConfigFiles: ConfigFiles = {
  read(file) {
    try { return readFileSync(file, "utf8") } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    }
  },
  append(file, text) {
    mkdirSync(path.dirname(file), { recursive: true })
    appendFileSync(file, text)
  },
}

export type ConfigPlan =
  /** Appending `text` to `file` (a new file when `created`) does it. */
  | { kind: "write"; file: string; text: string; lines: string[]; created: boolean; reload: string; /** The files as they were read: a write is only made if they still read the same. */ seen: string }
  /** The file already has exactly this setting. */
  | { kind: "present"; file: string; reload: string }
  /** Nothing is written; `reason` says why and what to do by hand. */
  | { kind: "refuse"; file?: string; reason: string }

export type ConfigEnvironment = { home: string; env: Record<string, string | undefined>; platform: string | undefined; files: ConfigFiles }

/** What a file says about the setting: not at all, exactly this, something else, or in a form the line cannot be added to. */
type Verdict = { kind: "unset" } | { kind: "same" } | { kind: "different"; found: string } | { kind: "blocked"; reason: string }
type Spec = {
  /** Where the terminal looks, in its order; `all` terminals merge every file, the others use the first that exists. */
  files(context: ConfigEnvironment): string[]
  merged: boolean
  /** Where a new file goes. */
  fallback(context: ConfigEnvironment): string
  check(text: string, topic: SetupTopic): Verdict
  reload(topic: SetupTopic): string
}

const active = (text: string) => text.split(/\r?\n/).filter((line) => !/^\s*#/.test(line))
const last = <T>(items: T[]): T | undefined => items[items.length - 1]
const xdg = ({ home, env }: ConfigEnvironment) => env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(home, ".config")
/** Spaces around the equals sign and the line's end are not part of what a setting says. */
const squash = (text: string) => text.replace(/\s+/g, "")

const GHOSTTY_ENTER = "text:\\x1b[13;2u"
const KITTY_ENTER = "send_text all \\x1b[13;2u"
const ALACRITTY_ENTER = `chars="\\u001b[13;2u"`

const SPECS: Readonly<Partial<Record<TerminalKind, Spec>>> = {
  // Ghostty reads `config.ghostty` (new) and `config` (older), in the XDG folder and, on macOS, in Application Support, and merges them; the
  // later file wins, so a key set in none of them is safe to add to any (checked against Ghostty 1.3.1's own help text and strings).
  ghostty: {
    files: (context) => {
      const folders = [path.join(xdg(context), "ghostty"), ...(context.platform === "darwin" ? [path.join(context.home, "Library", "Application Support", "com.mitchellh.ghostty")] : [])]
      return folders.flatMap((folder) => [path.join(folder, "config"), path.join(folder, "config.ghostty")])
    },
    merged: true,
    fallback: (context) => path.join(xdg(context), "ghostty", "config"),
    check(text, topic) {
      const lines = active(text)
      if (topic === "option") {
        const values = lines.flatMap((line) => { const match = /^\s*macos-option-as-alt\s*=\s*"?([^"#\s]*)"?\s*$/i.exec(line); return match ? [match[1]!.toLowerCase()] : [] })
        const value = last(values)
        return value === undefined ? { kind: "unset" } : value === "true" ? { kind: "same" } : { kind: "different", found: `macos-option-as-alt = ${value || "(empty)"}` }
      }
      const binds = lines.flatMap((line) => {
        const match = /^\s*keybind\s*=\s*((?:[a-z]+:)*)\s*shift\+enter\s*=\s*(.*?)\s*$/i.exec(line)
        return match ? [match[2]!] : []
      })
      const action = last(binds)
      return action === undefined ? { kind: "unset" } : action === GHOSTTY_ENTER ? { kind: "same" } : { kind: "different", found: `keybind = shift+enter=${action}` }
    },
    reload: (topic) => topic === "option" ? "Reload Ghostty (cmd+shift+,); if Option still types a character, quit and reopen it." : "Reload Ghostty (cmd+shift+, on a Mac, ctrl+shift+, on Linux).",
  },
  // kitty uses the first kitty.conf that exists: $KITTY_CONFIG_DIRECTORY when set, else $XDG_CONFIG_HOME/kitty, else ~/.config/kitty (kitty's `--config` help).
  kitty: {
    files: (context) => {
      const direct = context.env.KITTY_CONFIG_DIRECTORY
      if (direct && path.isAbsolute(direct)) return [path.join(direct, "kitty.conf")]
      return [...new Set([path.join(xdg(context), "kitty", "kitty.conf"), path.join(context.home, ".config", "kitty", "kitty.conf")])]
    },
    merged: false,
    fallback: (context) => (context.env.KITTY_CONFIG_DIRECTORY && path.isAbsolute(context.env.KITTY_CONFIG_DIRECTORY) ? [path.join(context.env.KITTY_CONFIG_DIRECTORY, "kitty.conf")] : [path.join(xdg(context), "kitty", "kitty.conf")])[0]!,
    check(text, topic) {
      const lines = active(text)
      if (topic === "option") {
        const value = last(lines.flatMap((line) => { const match = /^\s*macos_option_as_alt\s+(\S+)\s*$/.exec(line); return match ? [match[1]!] : [] }))
        return value === undefined ? { kind: "unset" } : value === "both" ? { kind: "same" } : { kind: "different", found: `macos_option_as_alt ${value}` }
      }
      const action = last(lines.flatMap((line) => { const match = /^\s*map\s+shift\+enter\s+(.*?)\s*$/i.exec(line); return match ? [match[1]!] : [] }))
      return action === undefined ? { kind: "unset" } : action === KITTY_ENTER ? { kind: "same" } : { kind: "different", found: `map shift+enter ${action}` }
    },
    reload: (topic) => topic === "option" ? "Restart kitty: it does not apply this setting on a reload." : "Reload with ctrl+shift+f5.",
  },
  // Alacritty: the first of these that exists is the config. Its settings are TOML, where a table can only be added once: a file that has the table
  // already cannot take the lines at its end.
  alacritty: {
    files: (context) => [...new Set([path.join(xdg(context), "alacritty", "alacritty.toml"), path.join(xdg(context), "alacritty.toml"), path.join(context.home, ".config", "alacritty", "alacritty.toml"), path.join(context.home, ".alacritty.toml")])],
    merged: false,
    fallback: (context) => path.join(xdg(context), "alacritty", "alacritty.toml"),
    check(text, topic) {
      const lines = active(text)
      if (topic === "option") {
        const value = last(lines.flatMap((line) => { const match = /^\s*option_as_alt\s*=\s*"?([A-Za-z]+)"?\s*(?:#.*)?$/.exec(line); return match ? [match[1]!] : [] }))
        if (value !== undefined) return value === "Both" ? { kind: "same" } : { kind: "different", found: `option_as_alt = "${value}"` }
        return lines.some((line) => /^\s*\[window\]\s*(?:#.*)?$/.test(line) || /^\s*window\s*[.=]/.test(line))
          ? { kind: "blocked", reason: `has a [window] table already: add option_as_alt = "Both" under it by hand` } : { kind: "unset" }
      }
      if (lines.some((line) => /^\s*(?:keyboard\.)?bindings\s*=/.test(line))) return { kind: "blocked", reason: "lists its bindings inline: add the binding to that list by hand" }
      let inBinding = false
      const found: string[][] = []
      for (const line of lines) {
        if (/^\s*\[\[keyboard\.bindings\]\]/.test(line)) { found.push([]); inBinding = true } else if (/^\s*\[/.test(line)) inBinding = false
        else if (inBinding && line.trim()) found[found.length - 1]!.push(squash(line))
      }
      const mine = found.filter((block) => block.includes(`key="Return"`) && block.includes(`mods="Shift"`))
      const block = last(mine)
      return block === undefined ? { kind: "unset" } : block.includes(ALACRITTY_ENTER) ? { kind: "same" } : { kind: "different", found: `a Shift+Return binding (${block.join(", ")})` }
    },
    reload: () => "Alacritty reloads the file when it is saved; if Option still types a character, restart it.",
  },
}

/** Whether `/terminal-setup` can write the setting for this terminal. */
export const canApply = (kind: TerminalKind): boolean => kind in SPECS

const MARK = "# added by MendCode (/terminal-setup)"

/** What applying the setting would do, from the files as they are now. Reads only. `lines` are the setting as the page shows it (`configLines`). */
export function planConfigEdit({ kind, topic, lines, context }: { kind: TerminalKind; topic: SetupTopic; lines: readonly string[]; context: ConfigEnvironment }): ConfigPlan {
  const spec = SPECS[kind]
  if (!spec) return { kind: "refuse", reason: "this terminal's setting is not a plain config line: follow the steps shown" }
  if (!lines.length) return { kind: "refuse", reason: "nothing to add for this terminal: follow the steps shown" }
  const reload = spec.reload(topic)
  const found: Array<{ file: string; text: string }> = []
  for (const file of spec.files(context)) {
    let text: string | undefined
    try { text = context.files.read(file) } catch (error) { return { kind: "refuse", file, reason: `cannot read it (${(error as NodeJS.ErrnoException).code ?? "error"}): nothing was changed` } }
    if (text !== undefined) found.push({ file, text })
    if (text !== undefined && !spec.merged) break
  }
  let same: string | undefined
  for (const { file, text } of found) {
    const verdict = spec.check(text, topic)
    if (verdict.kind === "different") return { kind: "refuse", file, reason: `already has ${verdict.found}: change that line yourself, nothing was changed` }
    if (verdict.kind === "blocked") return { kind: "refuse", file, reason: `${verdict.reason}; nothing was changed` }
    if (verdict.kind === "same") same ??= file
  }
  if (same) return { kind: "present", file: same, reload }
  const target = found.find(({ text }) => text.trim()) ?? found[0]
  const file = target?.file ?? spec.fallback(context)
  const before = target?.text ?? ""
  const text = `${before && !before.endsWith("\n") ? "\n" : ""}${before.trim() ? "\n" : ""}${MARK}\n${lines.join("\n")}\n`
  return { kind: "write", file, text, lines: [...lines], created: target === undefined, reload, seen: found.map((item) => `${item.file}\0${item.text}`).join("\0\0") }
}

/** Appends the plan's text. The file is read again first: a plan older than a change to the file does not write. */
export function applyConfigEdit({ kind, topic, plan, context }: { kind: TerminalKind; topic: SetupTopic; plan: Extract<ConfigPlan, { kind: "write" }>; context: ConfigEnvironment }): { ok: true } | { ok: false; reason: string } {
  const again = planConfigEdit({ kind, topic, lines: plan.lines, context })
  if (again.kind !== "write" || again.file !== plan.file || again.text !== plan.text || again.seen !== plan.seen) return { ok: false, reason: "the file changed since it was read: nothing was written, try again" }
  try {
    context.files.append(plan.file, plan.text)
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: `cannot write it (${(error as NodeJS.ErrnoException).code ?? "error"}): nothing was changed` }
  }
}
