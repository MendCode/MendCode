import { afterEach, describe, expect, test } from "bun:test"
import { createIdFactory, type Settings } from "@mendcode/protocol"
import { createApp } from "../src/ui/app"
import { createScreen } from "../src/ui/screen"
import { glyphs, type Line } from "../src/ui/theme"
import { parseStartup, STARTUP_USAGE } from "../src/startup"
import { accessibleMode, ACCESSIBLE_LOOK } from "../src/view/accessible"
import { SLASH_COMMANDS } from "../src/view/commands"
import { DEFAULT_TUI_PROFILE, normalizeTuiProfile, readTuiProfile } from "../src/view/tui-profile"
import { CUSTOMIZE_ROWS, customizePageKey } from "../src/view/customize-page"
import { TUI_DEFAULTS } from "@mendcode/protocol/wire"
import { plain, scratch } from "./extensions-harness"

const made: Array<ReturnType<typeof scratch>> = []
afterEach(() => { for (const item of made.splice(0)) item.cleanup() })
const ids = createIdFactory()

type Reply = (command: Record<string, unknown>) => unknown
async function harness(options: { dataDir?: string; accessible?: boolean; width?: number; height?: number; reply?: Reply; settings?: Settings; env?: Record<string, string | undefined> } = {}) {
  const frames: Line[][] = []
  const sent: Array<Record<string, unknown>> = []
  const screen = { size: { width: options.width ?? 100, height: options.height ?? 30 }, draw: (rows: Line[]) => void frames.push(rows), write: () => undefined } as unknown as Parameters<typeof createApp>[0]["screen"]
  const app = createApp({
    sessionId: ids("session"),
    screen,
    directory: "/work/app",
    ...(options.dataDir ? { dataDir: options.dataDir } : {}),
    ...(options.accessible !== undefined ? { accessible: options.accessible } : {}),
    ...(options.env ? { env: options.env } : {}),
    exit() {},
    schedule: (fn) => fn(),
    glyphs: glyphs({}),
    now: () => 1_800_000_000_000,
    random: () => 0,
    send: (async (command: Record<string, unknown>) => { sent.push(command); return (await options.reply?.(command)) ?? { ok: true } }) as never,
  })
  app.applySettings(options.settings ?? {})
  await app.extensionsReady
  app.render()
  const h = {
    app,
    sent,
    rows: () => frames.at(-1)!.map(plain),
    text: () => frames.at(-1)!.map(plain).join("\n"),
    async key(value: string) { await app.onKey(value); await Bun.sleep(2); app.render() },
    async type(value: string) { await app.onInput(value); await Bun.sleep(2); app.render() },
    async command(text: string) { for (const char of text) await h.key(char); await h.key("\r") },
  }
  return h
}
const layout = () => { const item = scratch(); made.push(item); return item }

describe("screen-reader mode", () => {
  test("the mode is asked for: flag, then MENDCODE_ACCESSIBLE, then the saved setting", () => {
    expect(accessibleMode({ flag: true, env: { MENDCODE_ACCESSIBLE: "0" }, saved: false })).toBe(true)
    expect(accessibleMode({ env: { MENDCODE_ACCESSIBLE: "1" }, saved: false })).toBe(true)
    expect(accessibleMode({ env: { MENDCODE_ACCESSIBLE: "0" }, saved: true })).toBe(false)
    expect(accessibleMode({ env: {}, saved: true })).toBe(true)
    expect(accessibleMode({ env: { TERM: "dumb", NO_COLOR: "1" }, saved: false })).toBe(false)
    expect(parseStartup(["--accessible"]).accessible).toBe(true)
    expect(parseStartup([]).accessible).toBeUndefined()
    expect(() => parseStartup(["run", "hi", "--accessible"])).toThrow("--accessible requires the TUI")
    expect(STARTUP_USAGE).toContain("--accessible")
  })

  test("the setting defaults off, is validated and matches the protocol defaults", () => {
    expect(DEFAULT_TUI_PROFILE.accessible).toBe(false)
    expect(TUI_DEFAULTS.accessible).toBe(false)
    expect(normalizeTuiProfile({ accessible: true }).accessible).toBe(true)
    expect(normalizeTuiProfile({ accessible: "yes" }).accessible).toBe(false)
  })

  test("the screen stops mouse reporting and stays inline for screen-reader mode", () => {
    const writes: string[] = []
    const out = { write: (data: string) => void writes.push(data), columns: 80, rows: 24, isTTY: true }
    createScreen(out, {}, { inline: false }).enter()
    expect(writes.join("")).toContain("\x1b[?1003h")
    writes.length = 0
    createScreen(out, {}, { inline: false, mouse: false }).enter()
    expect(writes.join("")).not.toContain("\x1b[?1003h")
    writes.length = 0
    const inline = createScreen(out, {}, { inline: true, mouse: false })
    inline.enter()
    expect(inline.inline).toBe(true)
    expect(writes.join("")).not.toContain("\x1b[?1049h")
    expect(writes.join("")).not.toContain("\x1b[?1003h")
  })

  test("a run in the mode shows plain text and no animation or clock, and never saves the look", async () => {
    const { dataDir } = layout()
    const h = await harness({ dataDir, accessible: true })
    expect(h.app.accessibility.accessible).toBe(true)
    expect(h.app.accessibility.reducedMotion).toBe(true)
    expect(h.app.accessibility.profile).toMatchObject(ACCESSIBLE_LOOK)
    await h.command("/multiline on")
    const saved = readTuiProfile(dataDir)
    expect(saved.multiline).toBe(true)
    expect(saved.accessible).toBe(false)
    expect(saved.presentation).toBe("auto")
    expect(saved.messageRenderer).toBe("full")
  })

  test("/accessible on saves the mode with the plain look, off restores the normal look", async () => {
    const { dataDir } = layout()
    const h = await harness({ dataDir })
    await h.command("/accessible on")
    expect(readTuiProfile(dataDir)).toMatchObject({ accessible: true, ...ACCESSIBLE_LOOK })
    expect(h.app.accessibility.accessible).toBe(true)
    expect(h.app.accessibility.reducedMotion).toBe(true)
    expect(h.text()).toContain("screen-reader mode on")
    await h.command("/accessible off")
    expect(readTuiProfile(dataDir)).toMatchObject({ accessible: false, presentation: "auto", messageRenderer: "full", reasoning: "auto" })
    expect(h.app.accessibility.accessible).toBe(false)
    expect(h.app.accessibility.reducedMotion).toBe(false)
    await h.command("/accessible maybe")
    expect(h.text()).toContain("usage: /accessible")
    await h.command("/accessible toggle")
    expect(readTuiProfile(dataDir).accessible).toBe(true)
  })

  test("a saved setting turns the mode on at start and keeps reduced motion on over a settings push", async () => {
    const { dataDir } = layout()
    const first = await harness({ dataDir })
    await first.command("/accessible on")
    const again = await harness({ dataDir, settings: { reducedMotion: false } })
    expect(again.app.accessibility.accessible).toBe(true)
    expect(again.app.accessibility.reducedMotion).toBe(true)
    expect(readTuiProfile(dataDir).accessible).toBe(true)
  })

  test("an environment that says 0 wins over the saved setting for the app too", async () => {
    const { dataDir } = layout()
    const first = await harness({ dataDir })
    await first.command("/accessible on")
    const off = await harness({ dataDir, accessible: false })
    expect(off.app.accessibility.accessible).toBe(false)
    expect(off.app.accessibility.reducedMotion).toBe(false)
  })

  test("/customize has a Screen reader row that toggles the setting, and the command is in the catalog", () => {
    expect(SLASH_COMMANDS.some((command) => command.name === "accessible" && command.aliases.length === 0)).toBe(true)
    const row = CUSTOMIZE_ROWS.indexOf("accessible")
    expect(row).toBeGreaterThan(-1)
    expect(customizePageKey({ row }, " ", DEFAULT_TUI_PROFILE).action).toEqual({ type: "set", patch: { accessible: true } })
  })
})

describe("/import setup", () => {
  const report = (extra: Record<string, unknown> = {}) => ({ applied: false, found: [{ tool: "claude-code", file: "~/.claude.json" }], items: [
    { kind: "mcp", name: "files", tool: "claude-code", scope: "user", status: "new", enabled: false, needs: ["API_TOKEN"], note: "imported disabled: set the variables, then enable it" },
    { kind: "command", name: "review", tool: "codex", scope: "user", status: "new" },
    { kind: "mcp", name: "docs", tool: "claude-code", scope: "user", status: "exists", note: "kept the MendCode entry" },
  ], inPlace: ["~/.claude: 2 skills (read where they are)"], notImported: ["permission rules and approvals (review them in /permissions)"], ...extra })

  test("previews by default as a page and writes only with apply", async () => {
    const h = await harness({ reply: (command) => command.type === "setup.import" ? { ok: true, result: report(command.apply ? { applied: true, items: report().items.map((item) => ({ ...item, status: item.status === "new" ? "imported" : item.status })) } : {}) } : undefined })
    await h.command("/import setup")
    expect(h.sent.filter((command) => command.type === "setup.import")).toEqual([{ type: "setup.import", directory: "/work/app" }])
    expect(h.text()).toContain("Import setup")
    expect(h.text()).toContain("would add · MCP server files")
    expect(h.text()).toContain("set $API_TOKEN")
    expect(h.text()).toContain("kept yours · MCP server docs")
    expect(h.text()).toContain("Never imported")
    expect(h.text()).toContain("/import setup apply adds all 2")
    expect(h.text()).toContain("/setup picks which")
    await h.key("\x1b")
    expect(h.app.page).toBe("chat")
    await h.command("/import setup codex apply")
    expect(h.sent.filter((command) => command.type === "setup.import")[1]).toEqual({ type: "setup.import", directory: "/work/app", from: "codex", apply: true })
    expect(h.text()).toContain("added · MCP server files")
  })

  test("a bad word shows the usage and nothing is sent; a refusal is shown", async () => {
    const h = await harness({ reply: (command) => command.type === "setup.import" ? { ok: false, error: { code: "forbidden", message: "[IMPORT]: setup import reads local files and is local only" } } : undefined })
    await h.command("/import setup vim")
    expect(h.text()).toContain("usage: /import")
    expect(h.sent.filter((command) => command.type === "setup.import")).toEqual([])
    await h.command("/import setup")
    expect(h.text()).toContain("local only")
  })

  test("nothing found says so", async () => {
    const h = await harness({ reply: (command) => command.type === "setup.import" ? { ok: true, result: { applied: false, found: [], items: [], inPlace: [], notImported: [] } } : undefined })
    await h.command("/import setup")
    expect(h.text()).toContain("No Claude Code or Codex setup found")
  })
})
