import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { applyConfigEdit, canApply, nodeConfigFiles, planConfigEdit, type ConfigEnvironment, type ConfigFiles, type ConfigPlan } from "../src/ui/terminal-config"
import { summaryFor } from "../src/view/picker-frame"
import { APPLIES, configLines, renderTerminalSetupPage, type SetupTopic, type TerminalKind } from "../src/view/terminal-setup-page"
import { appHarness } from "./session-ui-harness"

const homes: string[] = []
const homeDir = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-termcfg-"))
  homes.push(dir)
  return dir
}
afterEach(() => { for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const HOME = "/home/test"
/** Files in memory: the planner never touches the host. */
function memory(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial))
  const appended: Array<{ file: string; text: string }> = []
  const api: ConfigFiles = {
    read: (file) => files.get(file),
    append(file, text) { appended.push({ file, text }); files.set(file, (files.get(file) ?? "") + text) },
  }
  return { files, appended, api }
}
const context = (files: ConfigFiles, extra: Partial<ConfigEnvironment> = {}): ConfigEnvironment => ({ home: HOME, env: {}, platform: "darwin", files, ...extra })
const plan = (kind: TerminalKind, topic: SetupTopic, ctx: ConfigEnvironment): ConfigPlan => planConfigEdit({ kind, topic, lines: configLines(kind, topic), context: ctx })
const write = (result: ConfigPlan) => {
  if (result.kind !== "write") throw new Error(`expected a write, got ${JSON.stringify(result)}`)
  return result
}

const MARK = "# added by MendCode (/terminal-setup)"

describe("which terminals can take a line", () => {
  test("kitty, Ghostty and Alacritty only, and the page and the planner agree", () => {
    expect([...APPLIES].sort()).toEqual(["alacritty", "ghostty", "kitty"])
    for (const kind of ["kitty", "wezterm", "alacritty", "ghostty", "iterm2", "apple", "vscode", "windows-terminal", "zed", "jetbrains", "konsole", "gnome", "other"] as const) {
      expect(canApply(kind)).toBe(APPLIES.includes(kind))
      if (!canApply(kind)) expect(plan(kind, "option", context(memory().api)).kind).toBe("refuse")
    }
  })

  test("the lines are the snippet the page shows", () => {
    expect(configLines("ghostty", "option")).toEqual(["macos-option-as-alt = true"])
    expect(configLines("kitty", "option")).toEqual(["macos_option_as_alt both"])
    expect(configLines("alacritty", "option")).toEqual(["[window]", `option_as_alt = "Both"`])
    expect(configLines("ghostty", "enter")).toEqual(["keybind = shift+enter=text:\\x1b[13;2u"])
    expect(configLines("kitty", "enter")).toEqual(["map shift+enter send_text all \\x1b[13;2u"])
    expect(configLines("alacritty", "enter")[0]).toBe("[[keyboard.bindings]]")
  })
})

describe("Ghostty", () => {
  test("a new file in the XDG folder, with the line under a mark", () => {
    const result = write(plan("ghostty", "option", context(memory().api)))
    expect(result).toMatchObject({ file: `${HOME}/.config/ghostty/config`, created: true, lines: ["macos-option-as-alt = true"] })
    expect(result.text).toBe(`${MARK}\nmacos-option-as-alt = true\n`)
    expect(result.reload).toContain("cmd+shift+,")
  })

  test("XDG_CONFIG_HOME moves it; a relative one is ignored", () => {
    expect(write(plan("ghostty", "option", context(memory().api, { env: { XDG_CONFIG_HOME: "/xdg" } }))).file).toBe("/xdg/ghostty/config")
    expect(write(plan("ghostty", "option", context(memory().api, { env: { XDG_CONFIG_HOME: "relative" } }))).file).toBe(`${HOME}/.config/ghostty/config`)
  })

  test("an existing file is appended to, whatever it ends with, and nothing before it changes", () => {
    for (const before of ["theme = dark\n", "theme = dark", "theme = dark\n\n\n", "\n"]) {
      const result = write(plan("ghostty", "option", context(memory({ [`${HOME}/.config/ghostty/config`]: before }).api)))
      expect(result.created).toBe(false)
      expect(result.text.startsWith("\n") || before.trim() === "" || before.endsWith("\n")).toBe(true)
      const after = before + result.text
      expect(after.startsWith(before)).toBe(true)
      expect(after.endsWith(`${MARK}\nmacos-option-as-alt = true\n`)).toBe(true)
    }
  })

  test("macOS reads both folders and both names; Linux does not read Application Support", () => {
    const support = `${HOME}/Library/Application Support/com.mitchellh.ghostty`
    // Set to something else in a file Ghostty merges on top: refuse and name that file.
    for (const file of [`${support}/config`, `${support}/config.ghostty`, `${HOME}/.config/ghostty/config.ghostty`]) {
      const result = plan("ghostty", "option", context(memory({ [file]: "macos-option-as-alt = false\n" }).api))
      expect(result).toMatchObject({ kind: "refuse", file })
    }
    const same = plan("ghostty", "option", context(memory({ [`${support}/config.ghostty`]: "macos-option-as-alt = true\n" }).api))
    expect(same).toMatchObject({ kind: "present", file: `${support}/config.ghostty` })
    const linux = plan("ghostty", "option", context(memory({ [`${support}/config`]: "macos-option-as-alt = false\n" }).api, { platform: "linux" }))
    expect(linux.kind).toBe("write")
  })

  test("with a file in Application Support only, the line goes there", () => {
    const file = `${HOME}/Library/Application Support/com.mitchellh.ghostty/config.ghostty`
    const result = write(plan("ghostty", "option", context(memory({ [file]: "font-size = 14\n" }).api)))
    expect(result.file).toBe(file)
  })

  test("with files in both, the first one that has text takes it", () => {
    const xdg = `${HOME}/.config/ghostty/config`
    const support = `${HOME}/Library/Application Support/com.mitchellh.ghostty/config`
    expect(write(plan("ghostty", "option", context(memory({ [xdg]: "", [support]: "font-size = 14\n" }).api))).file).toBe(support)
    expect(write(plan("ghostty", "option", context(memory({ [xdg]: "x = 1\n", [support]: "font-size = 14\n" }).api))).file).toBe(xdg)
  })

  test("a comment is not a setting; the last value wins; left and right are another choice", () => {
    expect(plan("ghostty", "option", context(memory({ [`${HOME}/.config/ghostty/config`]: "# macos-option-as-alt = false\n" }).api)).kind).toBe("write")
    expect(plan("ghostty", "option", context(memory({ [`${HOME}/.config/ghostty/config`]: "macos-option-as-alt = false\nmacos-option-as-alt = true\n" }).api)).kind).toBe("present")
    expect(plan("ghostty", "option", context(memory({ [`${HOME}/.config/ghostty/config`]: "macos-option-as-alt = true\nmacos-option-as-alt = false\n" }).api)).kind).toBe("refuse")
    const left = plan("ghostty", "option", context(memory({ [`${HOME}/.config/ghostty/config`]: "macos-option-as-alt = left\n" }).api))
    expect(left).toMatchObject({ kind: "refuse" })
    expect((left as { reason: string }).reason).toContain("macos-option-as-alt = left")
    expect(plan("ghostty", "option", context(memory({ [`${HOME}/.config/ghostty/config`]: `macos-option-as-alt="true"\n` }).api)).kind).toBe("present")
  })

  test("the Shift+Enter keybind: another action refuses, the same one is present, other keys are left alone", () => {
    const file = `${HOME}/.config/ghostty/config`
    expect(plan("ghostty", "enter", context(memory({ [file]: "keybind = ctrl+shift+enter=text:x\nkeybind = shift+tab=text:y\n" }).api)).kind).toBe("write")
    expect(plan("ghostty", "enter", context(memory({ [file]: "keybind = shift+enter=text:\\x1b[13;2u\n" }).api)).kind).toBe("present")
    expect(plan("ghostty", "enter", context(memory({ [file]: "keybind = global:shift+enter=new_window\n" }).api))).toMatchObject({ kind: "refuse", file })
  })
})

describe("kitty", () => {
  const conf = `${HOME}/.config/kitty/kitty.conf`

  test("a new kitty.conf, a restart for the Option setting and a reload for the key", () => {
    const result = write(plan("kitty", "option", context(memory().api)))
    expect(result).toMatchObject({ file: conf, created: true })
    expect(result.text).toBe(`${MARK}\nmacos_option_as_alt both\n`)
    expect(result.reload).toContain("Restart kitty")
    expect(write(plan("kitty", "enter", context(memory().api))).reload).toContain("ctrl+shift+f5")
  })

  test("KITTY_CONFIG_DIRECTORY is always the folder; otherwise XDG, then ~/.config, the first that exists", () => {
    expect(write(plan("kitty", "option", context(memory().api, { env: { KITTY_CONFIG_DIRECTORY: "/kc" } }))).file).toBe("/kc/kitty.conf")
    expect(plan("kitty", "option", context(memory({ [conf]: "macos_option_as_alt no\n" }).api, { env: { KITTY_CONFIG_DIRECTORY: "/kc" } })).kind).toBe("write")
    expect(write(plan("kitty", "option", context(memory({ [conf]: "font_size 14\n", "/xdg/kitty/kitty.conf": "x 1\n" }).api, { env: { XDG_CONFIG_HOME: "/xdg" } }))).file).toBe("/xdg/kitty/kitty.conf")
    // kitty uses only the first file it finds: a setting in a later one is not read.
    expect(plan("kitty", "option", context(memory({ [conf]: "macos_option_as_alt no\n", "/xdg/kitty/kitty.conf": "x 1\n" }).api, { env: { XDG_CONFIG_HOME: "/xdg" } })).kind).toBe("write")
  })

  test("another value refuses, both is present, a comment is nothing", () => {
    expect(plan("kitty", "option", context(memory({ [conf]: "macos_option_as_alt left\n" }).api))).toMatchObject({ kind: "refuse", file: conf })
    expect(plan("kitty", "option", context(memory({ [conf]: "macos_option_as_alt both\n" }).api)).kind).toBe("present")
    expect(plan("kitty", "option", context(memory({ [conf]: "# macos_option_as_alt no\n" }).api)).kind).toBe("write")
    expect(plan("kitty", "enter", context(memory({ [conf]: "map shift+enter send_text all \\x1b[13;2u\n" }).api)).kind).toBe("present")
    expect(plan("kitty", "enter", context(memory({ [conf]: "map shift+enter new_window\n" }).api)).kind).toBe("refuse")
  })
})

describe("Alacritty", () => {
  const toml = `${HOME}/.config/alacritty/alacritty.toml`

  test("a new file gets the [window] table with the setting", () => {
    const result = write(plan("alacritty", "option", context(memory().api)))
    expect(result).toMatchObject({ file: toml, created: true })
    expect(result.text).toBe(`${MARK}\n[window]\noption_as_alt = "Both"\n`)
  })

  test("a file with other tables takes the table at its end", () => {
    const result = write(plan("alacritty", "option", context(memory({ [toml]: "[font]\nsize = 13\n" }).api)))
    expect(("[font]\nsize = 13\n" + result.text)).toBe(`[font]\nsize = 13\n\n${MARK}\n[window]\noption_as_alt = "Both"\n`)
  })

  test("a [window] table that is already there cannot take a second one: refused, with the line to add by hand", () => {
    for (const before of ["[window]\nopacity = 0.9\n", "window.opacity = 0.9\n", "[window] # mine\n"]) {
      const result = plan("alacritty", "option", context(memory({ [toml]: before }).api))
      expect(result).toMatchObject({ kind: "refuse", file: toml })
      expect((result as { reason: string }).reason).toContain(`option_as_alt = "Both"`)
    }
  })

  test("the setting itself: another value refuses, Both is present", () => {
    expect(plan("alacritty", "option", context(memory({ [toml]: `[window]\noption_as_alt = "OnlyLeft"\n` }).api))).toMatchObject({ kind: "refuse", file: toml })
    expect(plan("alacritty", "option", context(memory({ [toml]: `[window]\noption_as_alt = "Both"\n` }).api)).kind).toBe("present")
  })

  test("the first of the documented files that exists is the config", () => {
    const old = `${HOME}/.alacritty.toml`
    expect(write(plan("alacritty", "option", context(memory({ [old]: "[font]\nsize = 1\n" }).api))).file).toBe(old)
    expect(write(plan("alacritty", "option", context(memory({ [old]: "[font]\n", [toml]: "[font]\n" }).api))).file).toBe(toml)
  })

  test("the Shift+Enter binding is another [[keyboard.bindings]] entry, unless one for the key is there or the list is inline", () => {
    const other = `[[keyboard.bindings]]\nkey = "Tab"\nmods = "Shift"\nchars = "x"\n`
    const added = write(plan("alacritty", "enter", context(memory({ [toml]: other }).api)))
    expect(added.text).toContain(`${MARK}\n[[keyboard.bindings]]\nkey = "Return"\nmods = "Shift"\nchars = "\\u001b[13;2u"\n`)
    const same = `[[keyboard.bindings]]\nkey = "Return"\nmods = "Shift"\nchars = "\\u001b[13;2u"\n`
    expect(plan("alacritty", "enter", context(memory({ [toml]: same }).api)).kind).toBe("present")
    expect(plan("alacritty", "enter", context(memory({ [toml]: same.replace("u001b[13;2u", "n") }).api))).toMatchObject({ kind: "refuse", file: toml })
    expect(plan("alacritty", "enter", context(memory({ [toml]: `[keyboard]\nbindings = [{ key = "Tab", chars = "x" }]\n` }).api))).toMatchObject({ kind: "refuse", file: toml })
  })
})

describe("what goes wrong", () => {
  test("a file that cannot be read stops everything, with its name", () => {
    const denied: ConfigFiles = { read() { throw Object.assign(new Error("no"), { code: "EACCES" }) }, append() { throw new Error("must not write") } }
    const result = plan("ghostty", "option", context(denied))
    expect(result).toMatchObject({ kind: "refuse" })
    expect((result as { reason: string }).reason).toContain("EACCES")
  })

  test("a plan older than a change to the file does not write", () => {
    const files = memory({ [`${HOME}/.config/ghostty/config`]: "a = 1\n" })
    const ctx = context(files.api)
    const result = write(plan("ghostty", "option", ctx))
    files.files.set(`${HOME}/.config/ghostty/config`, "a = 2\n")
    expect(applyConfigEdit({ kind: "ghostty", topic: "option", plan: result, context: ctx })).toMatchObject({ ok: false })
    expect(files.appended).toEqual([])
  })

  test("a write that fails says so and the plan is not retried", () => {
    const files = memory()
    const failing: ConfigFiles = { read: files.api.read, append() { throw Object.assign(new Error("full"), { code: "ENOSPC" }) } }
    const ctx = context(failing)
    const result = applyConfigEdit({ kind: "kitty", topic: "option", plan: write(plan("kitty", "option", ctx)), context: ctx })
    expect(result).toMatchObject({ ok: false })
    expect((result as { reason: string }).reason).toContain("ENOSPC")
  })
})

describe("on a real folder", () => {
  const real = (home: string, extra: Partial<ConfigEnvironment> = {}): ConfigEnvironment => ({ home, env: {}, platform: "darwin", files: nodeConfigFiles, ...extra })

  test("it creates the folders and the file, then finds the setting there", () => {
    const home = homeDir()
    const ctx = real(home)
    const result = write(plan("ghostty", "option", ctx))
    expect(existsSync(path.join(home, ".config"))).toBe(false)
    expect(applyConfigEdit({ kind: "ghostty", topic: "option", plan: result, context: ctx })).toEqual({ ok: true })
    expect(readFileSync(path.join(home, ".config/ghostty/config"), "utf8")).toBe(`${MARK}\nmacos-option-as-alt = true\n`)
    expect(plan("ghostty", "option", ctx).kind).toBe("present")
  })

  test("it only appends: what was in the file is still there, byte for byte", () => {
    const home = homeDir()
    const file = path.join(home, ".config/kitty/kitty.conf")
    mkdirSync(path.dirname(file), { recursive: true })
    const before = "font_size 14\r\n# mine\nmap f1 new_window"
    writeFileSync(file, before)
    const ctx = real(home)
    expect(applyConfigEdit({ kind: "kitty", topic: "option", plan: write(plan("kitty", "option", ctx)), context: ctx })).toEqual({ ok: true })
    const after = readFileSync(file, "utf8")
    expect(after.startsWith(before)).toBe(true)
    expect(after.slice(before.length)).toBe(`\n\n${MARK}\nmacos_option_as_alt both\n`)
  })

  test("a file that sets the key differently is not touched", () => {
    const home = homeDir()
    const file = path.join(home, ".config/alacritty/alacritty.toml")
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, `[window]\noption_as_alt = "None"\n`)
    const result = plan("alacritty", "option", real(home))
    expect(result.kind).toBe("refuse")
    expect(readFileSync(file, "utf8")).toBe(`[window]\noption_as_alt = "None"\n`)
  })
})

describe("the page summary", () => {
  test("keeps whole sentences, then whole words, never half a word", () => {
    const summary = "Detected: Ghostty. Nothing is written unless you press a and confirm."
    expect(summaryFor(summary, 80)).toBe(summary)
    expect(summaryFor(summary, 40)).toBe("Detected: Ghostty.")
    expect(summaryFor("Nothing is written unless you press a", 20)).toBe("Nothing is written…")
    const page = renderTerminalSetupPage({ env: { TERM_PROGRAM: "ghostty" }, state: { guide: 0 }, width: 60, height: 24, platform: "darwin", canApply: true })
    expect(page[1]!.map((span) => span.text).join("").trimEnd()).toBe("Detected: Ghostty.")
  })
})

describe("/terminal-setup", () => {
  const GHOSTTY = { TERM_PROGRAM: "ghostty", TERM: "xterm-ghostty" }
  const open = async (home: string, env: Record<string, string> = GHOSTTY, extra: { platform?: string; terminalConfig?: boolean } = {}) => {
    const h = appHarness({ width: 120, height: 40, env, platform: extra.platform ?? "darwin", mode: "full", ...(extra.terminalConfig === false ? {} : { terminalConfig: { home } }) })
    h.app.applySettings({ onboarded: true })
    await h.type("/terminal-setup")
    await h.type("\r")
    // The page's module loads lazily.
    await Bun.sleep(40)
    h.app.render()
    return { key: async (input: string) => (await h.type(input), undefined), text: () => h.text().join("\n"), app: h.app }
  }
  const config = (home: string) => path.join(home, ".config/ghostty/config")

  test("a asks first, y writes the line, and the page says how to reload", async () => {
    const home = homeDir()
    const h = await open(home)
    expect(h.text()).toContain("Option as Alt")
    expect(h.text()).toContain("a add it")
    expect(h.text()).toContain("Nothing is written unless you press a and confirm.")
    await h.key("a")
    expect(h.text()).toContain("Add to ~/.config/ghostty/config (new file):")
    expect(h.text()).toContain("macos-option-as-alt = true")
    expect(h.text()).toContain("y writes it")
    expect(existsSync(config(home))).toBe(false)
    await h.key("y")
    expect(readFileSync(config(home), "utf8")).toBe(`${MARK}\nmacos-option-as-alt = true\n`)
    expect(h.text()).toContain("Added to ~/.config/ghostty/config. Reload Ghostty (cmd+shift+,)")
    // A second try finds it.
    await h.key("a")
    expect(h.text()).toContain("already has this setting")
    expect(readFileSync(config(home), "utf8")).toBe(`${MARK}\nmacos-option-as-alt = true\n`)
  })

  test("any key but y cancels, esc included, and nothing is written", async () => {
    for (const refusal of ["n", "\x1b", "\r", "a"]) {
      const home = homeDir()
      const h = await open(home)
      await h.key("a")
      expect(h.text()).toContain("y writes it")
      await h.key(refusal)
      expect(h.text()).toContain("Cancelled: nothing was written.")
      expect(h.app.page).toBe("terminal-setup")
      expect(existsSync(config(home))).toBe(false)
    }
  })

  test("a file that sets the key differently is left alone, and the page names it", async () => {
    const home = homeDir()
    mkdirSync(path.dirname(config(home)), { recursive: true })
    writeFileSync(config(home), "macos-option-as-alt = left\n")
    const h = await open(home)
    await h.key("a")
    expect(h.text()).toContain("~/.config/ghostty/config already has macos-option-as-alt = left")
    expect(h.text()).not.toContain("y writes it")
    await h.key("y")
    expect(readFileSync(config(home), "utf8")).toBe("macos-option-as-alt = left\n")
  })

  test("Application Support is the file when it is the one that exists", async () => {
    const home = homeDir()
    const file = path.join(home, "Library/Application Support/com.mitchellh.ghostty/config.ghostty")
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, "font-size = 14\n")
    const h = await open(home)
    await h.key("a")
    expect(h.text()).toContain("Add to ~/Library/Application Support/com.mitchellh.ghostty/config.ghostty:")
    await h.key("y")
    expect(readFileSync(file, "utf8")).toBe(`font-size = 14\n\n${MARK}\nmacos-option-as-alt = true\n`)
    expect(existsSync(config(home))).toBe(false)
  })

  test("the Shift+Enter topic adds its own line", async () => {
    const home = homeDir()
    const h = await open(home, GHOSTTY, { platform: "linux" })
    await h.key("a")
    expect(h.text()).toContain("keybind = shift+enter=text:")
    await h.key("y")
    expect(readFileSync(config(home), "utf8")).toBe(`${MARK}\nkeybind = shift+enter=text:\\x1b[13;2u\n`)
  })

  test("without the app's home, or for a terminal that has no plain line, a is only a key to test", async () => {
    const home = homeDir()
    const without = await open(home, GHOSTTY, { terminalConfig: false })
    expect(without.text()).not.toContain("a add it")
    expect(without.text()).toContain("Instructions only")
    await without.key("a")
    expect(without.text()).toContain("bytes: a")
    expect(existsSync(config(home))).toBe(false)
    const wezterm = await open(home, { TERM_PROGRAM: "WezTerm", WEZTERM_EXECUTABLE: "/usr/bin/wezterm" })
    expect(wezterm.text()).not.toContain("a add it")
    await wezterm.key("a")
    expect(wezterm.text()).toContain("bytes: a")
    expect(readdirSafe(home)).toEqual([])
  })

  test("the list moves to another terminal's guide, and a applies that terminal's", async () => {
    const home = homeDir()
    const h = await open(home, GHOSTTY)
    await h.key("\x1b[B")
    await h.key("a")
    expect(h.text()).toContain("kitty.conf")
    await h.key("y")
    expect(readFileSync(path.join(home, ".config/kitty/kitty.conf"), "utf8")).toBe(`${MARK}\nmacos_option_as_alt both\n`)
    expect(existsSync(config(home))).toBe(false)
  })
})

function readdirSafe(dir: string): string[] {
  try { return readdirSync(dir) } catch { return [] }
}
