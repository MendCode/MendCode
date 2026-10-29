import { afterAll, describe, expect, test } from "bun:test"
import type { CommandInput, CommandReply } from "@mendcode/client"
import { parseGlobalOptions } from "../src/global-options"
import { STARTUP_USAGE } from "../src/startup"
import { SLASH_COMMANDS, parseSlash } from "../src/view/commands"
import { SETUP_ROWS, renderSetupPage, setupPageKey } from "../src/view/setup-page"
import { appHarness, cleanTemps, tempDir } from "./session-ui-harness"

afterAll(cleanTemps)
const reply = (value: unknown) => value as CommandReply

function app(options: { settings?: Record<string, unknown>; persist?: boolean; remote?: boolean; safeMode?: boolean; promptOk?: boolean; reply?: (command: CommandInput) => unknown } = {}) {
  const h = appHarness({
    directory: tempDir("mendcode-tier-"),
    ...(options.remote ? { remote: { host: "test.invalid", readOnly: false } } : {}),
    ...(options.safeMode ? { safeMode: true } : {}),
    reply: (command) => {
      if (command.type === "settings.get") return reply({ ok: true, result: { settings: options.settings ?? {} } })
      if (command.type === "settings.set") {
        const patch = (command as { patch: Record<string, unknown> }).patch
        const next = { ...options.settings, ...patch }
        for (const [key, value] of Object.entries(patch)) if (value === null) delete next[key]
        // `persist`: like the daemon, a patch replaces each key it names whole and the next `settings.get` reads the result.
        if (options.persist) options.settings = next
        return reply({ ok: true, result: { settings: next } })
      }
      if (command.type === "prompt.set") return options.promptOk === false ? reply({ ok: false, code: "invalid_command", error: { message: "no" } }) : reply({ ok: true, result: {} })
      return options.reply ? reply(options.reply(command)) : undefined
    },
  })
  return h
}
/** The screen with box edges removed and whitespace collapsed, so a toast that wraps still reads as one sentence. */
const screen = (h: ReturnType<typeof app>) => h.text().join("\n").replace(/[┃│]/g, " ").replace(/[ \t]*\n[ \t]*/g, "\n").replace(/[ \t]+/g, " ").replace(/\n+/g, " ")

describe("--safe-mode", () => {
  test("parses as a global flag, is stripped from the arguments and stays out of a literal after --", () => {
    expect(parseGlobalOptions(["--safe-mode", "run", "hi"])).toEqual({ args: ["run", "hi"], printLogs: false, safeMode: true })
    expect(parseGlobalOptions(["--safe-mode=true"])).toEqual({ args: [], printLogs: false, safeMode: true })
    expect(parseGlobalOptions(["--safe-mode", "--safe-mode=false"])).toEqual({ args: [], printLogs: false })
    expect(parseGlobalOptions(["run", "--", "--safe-mode"]).args).toEqual(["run", "--", "--safe-mode"])
    expect(parseGlobalOptions(["--pure", "--safe-mode"])).toMatchObject({ pure: true, safeMode: true })
    expect(STARTUP_USAGE).toContain("--safe-mode")
  })

  test("/doctor says which mode this terminal runs in", async () => {
    const safe = app({ safeMode: true })
    await safe.type("/doctor\r")
    expect(screen(safe)).toContain("safe mode on")
    const normal = app({ settings: { tier: "balanced" } })
    await normal.type("/doctor\r")
    expect(screen(normal)).toContain("safe mode off")
    expect(screen(normal)).toContain("tier: none")
  })
})

describe("/tier", () => {
  test("is listed without an alias and takes an optional argument", () => {
    expect(SLASH_COMMANDS.some((command) => command.name === "tier")).toBe(true)
    expect(parseSlash("/tier")?.command.name).toBe("tier")
    expect(parseSlash("/tiers")).toBeUndefined()
  })

  test("with no argument it shows the bundles, what each tier includes and what is on now", async () => {
    const h = app({ settings: { tier: "balanced", features: { mcp: true } } })
    await h.type("/tier\r")
    const text = screen(h)
    expect(text).toContain("Tiers")
    expect(text).toContain("balanced")
    expect(text).toMatch(/on\s+codegraph/)
    expect(text).toMatch(/on\s+mcp .* · override\s/)
    expect(text).not.toContain("override override")
    expect(text).toMatch(/off\s+jev/)
    expect(text).toContain("minimalist: view minimal")
    expect(h.sentOf("settings.set")).toHaveLength(0)
  })

  test("an opt-in feature switched on reads on, not allowed: /tier <feature> on is its switch", async () => {
    const on = app({ settings: { tier: "full", features: { computer: true } } })
    await on.type("/tier\r")
    expect(screen(on)).toMatch(/on\s+computer · Computer control .* · override\s/)
    expect(screen(on)).toMatch(/allowed browser/)
    const back = app({ settings: { tier: "full", features: { computer: true } } })
    await back.type("/tier computer default\r")
    expect(screen(back)).toContain("computer off · its default")
    expect(screen(back)).not.toContain("follows the tier")
  })

  test("without a tier the listing says every feature keeps its own default", async () => {
    const h = app()
    await h.type("/tier\r")
    expect(screen(h)).toContain("no tier set")
  })

  test("a tier writes itself with its chat view and sets the project prompt mode", async () => {
    const h = app()
    await h.type("/tier minimalist\r")
    expect(h.sentOf("settings.set")[0]).toMatchObject({ patch: { tier: "minimalist", view: "minimal" } })
    expect(h.sentOf("prompt.set")[0]).toMatchObject({ mode: "minimal" })
    expect(screen(h)).toContain("tier minimalist · view minimal · prompt minimal · density compact")
    await h.type("/tier full\r")
    expect(h.sentOf("settings.set")[1]).toMatchObject({ patch: { tier: "full", view: "full" } })
    expect(h.sentOf("prompt.set")[1]).toMatchObject({ mode: "full" })
  })

  test("a failed prompt mode change is said, not hidden", async () => {
    const h = app({ promptOk: false })
    await h.type("/tier balanced\r")
    expect(h.sentOf("settings.set")[0]).toMatchObject({ patch: { tier: "balanced", view: "balanced" } })
    expect(screen(h)).toContain("prompt mode unchanged")
  })

  test("a feature is overridden and put back without touching the others", async () => {
    const h = app({ settings: { tier: "minimalist", features: { jev: false } } })
    await h.type("/tier mcp on\r")
    expect(h.sentOf("settings.set")[0]).toMatchObject({ patch: { features: { jev: false, mcp: true } } })
    await h.type("/tier jev default\r")
    expect(h.sentOf("settings.set")[1]).toMatchObject({ patch: { features: null } })
    expect(screen(h)).toContain("follows the tier again")
  })

  test("enabling one feature and then another keeps the first: settings.set replaces features whole, so /tier resends them all", async () => {
    const h = app({ settings: { tier: "minimalist" }, persist: true })
    await h.type("/tier mcp on\r")
    await h.type("/tier subagents on\r")
    await h.type("/tier jev off\r")
    expect(h.sentOf("settings.set").map((command) => (command as { patch: { features: unknown } }).patch.features)).toEqual([
      { mcp: true },
      { mcp: true, subagents: true },
      { mcp: true, subagents: true, jev: false },
    ])
    await h.type("/tier subagents default\r")
    expect(h.sentOf("settings.set").at(-1)).toMatchObject({ patch: { features: { mcp: true, jev: false } } })
  })

  test("an opt-in feature says its own switch is still needed; kernel features and bad input are refused", async () => {
    const h = app({ settings: { tier: "full" } })
    await h.type("/tier browser on\r")
    expect(screen(h)).toContain("still needs its own switch")
    // Computer control has no second switch: `/tier computer on` is the switch.
    await h.type("/tier computer on\r")
    expect(h.sentOf("settings.set").at(-1)).toMatchObject({ patch: { features: { computer: true } } })
    expect(screen(h)).toContain("computer on")
    expect(screen(h)).not.toContain("computer included")
    expect(screen(h)).not.toContain("/tier computer on (macOS")
    await h.type("/tier hooks off\r")
    expect(screen(h)).toContain("changes only with --safe-mode")
    await h.type("/tier tiny\r")
    expect(screen(h)).toContain("usage: /tier")
    await h.type("/tier mcp maybe\r")
    // Only the two switches above were saved; the refused inputs sent nothing.
    expect(h.sentOf("settings.set")).toHaveLength(2)
  })

  test("off clears the tier and every feature goes back to its own default", async () => {
    const h = app({ settings: { tier: "balanced" } })
    await h.type("/tier off\r")
    expect(h.sentOf("settings.set")[0]).toMatchObject({ patch: { tier: null } })
  })

  test("a remote terminal cannot set it", async () => {
    const h = app({ remote: true })
    await h.type("/tier full\r")
    expect(h.sentOf("settings.set")).toHaveLength(0)
    expect(screen(h)).toContain("machine that runs the commands")
  })
})

describe("/experimental with tiers", () => {
  test("lists a tier-managed flag as on and a flag the tier leaves out as off", async () => {
    const h = app({ settings: { tier: "full", experimental: { code_mode: true } } })
    await h.type("/experimental\r")
    expect(screen(h)).toMatch(/on\s+reasoning_auto/)
    const lower = app({ settings: { tier: "balanced", experimental: { code_mode: true } } })
    await lower.type("/experimental\r")
    expect(screen(lower)).toMatch(/off\s+code_mode/)
    expect(screen(lower)).toContain("/tier")
  })

  test("with a tier an off flag is saved as false so the tier default cannot bring it back", async () => {
    const h = app({ settings: { tier: "full" } })
    await h.type("/experimental reasoning_auto off\r")
    expect(h.sentOf("settings.set")[0]).toMatchObject({ patch: { experimental: { reasoning_auto: false } } })
  })

  test("a flag the tier leaves out is saved but the answer says it stays off", async () => {
    const h = app({ settings: { tier: "balanced" } })
    await h.type("/experimental code_mode on\r")
    expect(h.sentOf("settings.set")[0]).toMatchObject({ patch: { experimental: { code_mode: true } } })
    expect(screen(h)).toContain("leaves it out")
    expect(screen(h)).toContain("/tier code_mode on")
  })
})

describe("setup", () => {
  const values = { theme: "mend", view: "balanced", defaultPermission: "ask", reducedMotion: false }
  const options = { themes: ["mend"] }

  test("the tier row cycles none, minimalist, balanced, full and back", () => {
    const row = SETUP_ROWS.indexOf("tier")
    expect(row).toBeGreaterThan(SETUP_ROWS.indexOf("preset"))
    const next = (tier?: "minimalist" | "balanced" | "full") => setupPageKey({ row }, "\x1b[C", { ...values, ...(tier ? { tier } : {}) }, options).action
    expect(next()).toEqual({ type: "tier", tier: "minimalist" })
    expect(next("minimalist")).toEqual({ type: "tier", tier: "balanced" })
    expect(next("balanced")).toEqual({ type: "tier", tier: "full" })
    expect(next("full")).toEqual({ type: "tier", tier: null })
  })

  test("the row shows the tier and what the next one adds or removes", () => {
    const row = SETUP_ROWS.indexOf("tier")
    const draw = (tier?: "minimalist" | "balanced" | "full") => renderSetupPage({ state: { row }, values: { ...values, ...(tier ? { tier } : {}) }, checks: { connected: true, quotas: [] }, firstRun: false, width: 140, height: 50 }).map((line) => line.map((span) => span.text).join("")).join("\n")
    expect(draw("minimalist")).toContain("‹ minimalist ›")
    expect(draw("minimalist")).toContain("next balanced: +package_tools +codegraph +subagents")
    expect(draw("balanced")).toContain("next full: +mcp +jev +pets")
    expect(draw("full")).toContain("next: no tier")
    expect(draw()).toContain("‹ none ›")
  })
})
