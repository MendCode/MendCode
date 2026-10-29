import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import path from "node:path"
import type { Line } from "../src/ui/theme"
import { createCustomizePageState, customizePageKey, customizePreview, renderCustomizePage, CUSTOMIZE_ROWS } from "../src/view/customize-page"
import { logoRowsFor } from "../src/view/logo-fonts"
import { DEFAULT_TUI_PROFILE, tuiProfilePath, type TuiProfile } from "../src/view/tui-profile"
import { glyphs } from "../src/ui/theme"
import { textWidth } from "../src/view/wrap"
import { appHarness, extension, scratch } from "./extensions-harness"
import { mendRows } from "./session-ui-harness"

const made: Array<ReturnType<typeof scratch>> = []
function layout() {
  const next = scratch()
  made.push(next)
  return next
}
afterEach(() => {
  for (const item of made.splice(0)) item.cleanup()
})

const RIGHT = "\x1b[C"
const LEFT = "\x1b[D"
const DOWN = "\x1b[B"
const saved = (dataDir: string): TuiProfile => JSON.parse(readFileSync(tuiProfilePath(dataDir), "utf8"))

async function open(options: { width?: number; height?: number; settings?: Record<string, unknown>; reply?: (command: Record<string, unknown>) => unknown } = {}) {
  const { dataDir } = layout()
  const h = await appHarness({ dataDir, width: options.width ?? 100, height: options.height ?? 34, ...(options.reply ? { reply: options.reply } : {}) })
  await h.start((options.settings ?? { onboarded: true }) as never)
  await h.type("/customize")
  await h.key("\r")
  return { h, dataDir }
}

const at = (name: typeof CUSTOMIZE_ROWS[number]) => ({ row: CUSTOMIZE_ROWS.indexOf(name) })
async function select(h: Awaited<ReturnType<typeof appHarness>>, name: typeof CUSTOMIZE_ROWS[number]) {
  if (h.app.page !== "chat") await h.key("\x1b")
  await h.type("/customize")
  await h.key("\r")
  for (let i = 0; i < at(name).row; i++) await h.key(DOWN)
}

describe("/customize page", () => {
  test("grouped choices and the real home preview, without invented sessions or models", async () => {
    const { h } = await open({ width: 180, height: 50 })
    expect(h.app.page).toBe("customize")
    for (const label of ["Home", "Logo kind", "Logo text", "Logo font", "Product name", "Welcome layout", "Split panel", "Density", "Prompt & footer", "Preview"]) expect(h.text()).toContain(label)
    expect(h.text()).toContain(logoRowsFor("MENDCODE")[0]!)
    expect(h.text()).toContain("No sessions yet")
    expect(h.text()).not.toMatch(/sample sessions|Port the palette|gpt-6|● Tip/)
    expect(h.rows()[0]).toContain("esc back")
  })

  test("prompt chrome applies and persists locally with no daemon command", async () => {
    const { h, dataDir } = await open({ width: 180, height: 50 })
    await select(h, "promptChrome")
    await h.key(LEFT)
    expect(saved(dataDir).promptChrome).toBe("box")
    expect(h.text()).toMatch(/╭─+╮/)
    await h.key(RIGHT)
    await h.key(RIGHT)
    await h.key(RIGHT)
    expect(saved(dataDir).promptChrome).toBe("ascii-box")
    expect(h.text()).toMatch(/┌─+┐/)
    expect(h.sent.filter((command) => command.type === "settings.set")).toEqual([])
    const next = await appHarness({ dataDir, width: 180, height: 50 })
    await next.start({ onboarded: true })
    expect(next.text()).toMatch(/┌─+┐/)
  })

  test("text edits preview live, save on enter, cancel on esc", async () => {
    const { h, dataDir } = await open({ width: 180, height: 50 })
    await select(h, "logoText")
    await h.key("\r")
    for (let i = 0; i < 8; i++) await h.key("\x7f")
    await h.type("ACME")
    expect(h.text()).toContain(logoRowsFor("ACME")[0]!)
    expect(existsSync(tuiProfilePath(dataDir))).toBe(false)
    await h.key("\r")
    expect(saved(dataDir).logoText).toBe("ACME")
    await h.key("\r")
    await h.type("extra")
    await h.key("\x1b")
    expect(saved(dataDir).logoText).toBe("ACME")
  })

  test("custom ASCII keeps spaces and newlines and changes the home immediately", async () => {
    const { h, dataDir } = await open({ width: 180, height: 50 })
    await select(h, "customAscii")
    await h.key("\r")
    await h.type("  /\\")
    await h.key("\x0a")
    await h.type(" <++>")
    expect(h.text()).toContain("<++>")
    await h.key("\r")
    expect(saved(dataDir)).toMatchObject({ customAscii: "  /\\\n <++>", logoKind: "custom" })
    await h.key("\x1b")
    expect(h.text()).toContain("<++>")
  })

  test("all fonts cycle, removed fonts migrate, and none hides the identity", async () => {
    const { h, dataDir } = await open({ width: 180, height: 50 })
    await select(h, "logoFont")
    for (const font of ["compact", "solid", "outline", "mendcode"]) {
      await h.key(RIGHT)
      expect(saved(dataDir).logoFont).toBe(font)
    }
    await select(h, "logoKind")
    await h.key(LEFT)
    expect(saved(dataDir).logoKind).toBe("none")
    await h.key("\x1b")
    expect(h.text()).not.toContain(logoRowsFor("MENDCODE")[0]!)
  })

  test("welcome panel, layout and density save with their rendered changes", async () => {
    const { h, dataDir } = await open({ width: 180, height: 50 })
    await select(h, "homeLayout")
    await h.key(RIGHT)
    expect(saved(dataDir).homeLayout).toBe("split")
    await select(h, "homeRightPanel")
    await h.key(RIGHT)
    expect(saved(dataDir).homeRightPanel).toBe("actions")
    expect(h.text()).toContain("Resume session")
    await select(h, "density")
    await h.key(RIGHT)
    expect(saved(dataDir).density).toBe("spacious")
    await h.key("\x1b")
    expect(h.text()).toContain("Open commands")
    expect(h.text()).toMatch(/┌─+┐/)
  })

  test("every boolean applies and round-trips, reset restores defaults", async () => {
    const { h, dataDir } = await open({ width: 180, height: 50 })
    const fields = CUSTOMIZE_ROWS.filter((row) => row !== "reset" && typeof DEFAULT_TUI_PROFILE[row] === "boolean")
    // One pass down the page: rows are in CUSTOMIZE_ROWS order, so moving from the previous field is enough.
    let row = 0
    await select(h, CUSTOMIZE_ROWS[0]!)
    for (const field of fields) {
      for (; row < at(field).row; row++) await h.key(DOWN)
      await h.key(" ")
      expect(saved(dataDir)[field]).toBe(!DEFAULT_TUI_PROFILE[field])
    }
    await select(h, "reset")
    await h.key("\r")
    expect(saved(dataDir)).toEqual(DEFAULT_TUI_PROFILE)
  }, 20_000)

  test("pet opens the picker, which includes the official Mend in colored blocks", async () => {
    const { h } = await open({ width: 180, height: 50 })
    await select(h, "pet")
    await h.key("\r")
    expect(h.app.page).toBe("pet")
    expect(h.text()).toContain("The official Mend mascot")
    expect(h.text()).toContain(mendRows("idle", 2)[0])
  })

  test("no data dir applies the look and reports the persistence gap", async () => {
    const h = await appHarness({ width: 100, height: 34 })
    await h.start({ onboarded: true })
    await select(h, "logoKind")
    await h.key(RIGHT)
    expect(h.text()).toContain("no data dir")
    await h.key("\x1b")
    expect(h.text()).toContain(mendRows("idle", 2)[0])
  })
})

describe("customize page keys and rendering", () => {
  const profile: TuiProfile = { ...DEFAULT_TUI_PROFILE }
  test("keys clamp, cycle, edit, cancel, and ignore escape sequences", () => {
    const state = createCustomizePageState()
    expect(customizePageKey(state, "k", profile).state).toBe(state)
    expect(customizePageKey({ row: CUSTOMIZE_ROWS.length - 1 }, "j", profile).state.row).toBe(CUSTOMIZE_ROWS.length - 1)
    expect(customizePageKey(at("promptChrome"), "h", profile).action).toEqual({ type: "set", patch: { promptChrome: "box" } })
    expect(customizePageKey(at("logoText"), "\r", profile).state.typing).toBe("MENDCODE")
    const typing = { ...at("logoText"), typing: "ACME" }
    expect(customizePageKey(typing, "\x1b[C", profile).state).toBe(typing)
    expect(customizePageKey(typing, "\x7f", profile).state.typing).toBe("ACM")
    expect(customizePageKey(typing, "\x1b", profile).action.type).toBe("none")
    expect(customizePageKey(state, "\x1b", profile).action.type).toBe("close")
  })

  test("every option remains focused and within bounds at all contract sizes", () => {
    for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]] as const) {
      for (const field of CUSTOMIZE_ROWS) {
        const rows = renderCustomizePage({ state: at(field), profile, preview: { root: "/work/app", tip: "", now: 0 }, width, height })
        expect(rows).toHaveLength(height)
        for (const row of rows) expect(textWidth(row.map((span) => span.text).join(""))).toBe(width)
        expect(rows.flat().filter((span) => span.text === "❯ ")).toHaveLength(1)
        expect(rows[0]!.map((span) => span.text).join("")).toContain("esc back")
      }
    }
    // Every row at five sizes (about 5 s alone): the default 5 s limit flakes when a shard loads the machine.
  }, 30_000)

  test("the preview uses the real prompt in every preset", () => {
    for (const promptChrome of ["box", "top-bottom", "minimal", "ascii-box"] as const) {
      const rows = customizePreview({ profile: { ...profile, promptChrome }, preview: { root: "/work/app", tip: "", now: 0 }, screenHeight: 40, width: 70, height: 20, glyphs: glyphs({}) })
      expect(rows).toHaveLength(20)
      expect(rows.flat().map((span) => span.text).join("")).toContain("Ask anything...")
      for (const row of rows) expect(textWidth(row.map((span) => span.text).join(""))).toBe(70)
    }
  })
})

describe("extension slots win over the profile", () => {
  test("welcome.below takes the tip's place and a footer slot removes the home footer", async () => {
    const { dataDir, write } = layout()
    write("data/extensions/mine.ts", extension("mine", `api.slot("welcome.below", () => [[{ text: "rows from mine" }]])\napi.slot("footer.left", () => [[{ text: "mine left" }]])`))
    mkdirSync(path.join(dataDir, "tui"), { recursive: true })
    writeFileSync(tuiProfilePath(dataDir), JSON.stringify({ homeTips: true, homeFooter: true }))
    const h = await appHarness({ dataDir, width: 120, height: 40 })
    await h.start({ onboarded: true })
    expect(h.text()).toContain("rows from mine")
    expect(h.text()).not.toContain("● Tip")
    expect(h.text()).not.toContain("runtime v")
  })

  test("welcome.replace is still the whole home, whatever the layout", async () => {
    const { dataDir, write } = layout()
    write("data/extensions/mine.ts", extension("mine", `api.slot("welcome.replace", () => [[{ text: "my own home" }]])`))
    mkdirSync(path.join(dataDir, "tui"), { recursive: true })
    writeFileSync(tuiProfilePath(dataDir), JSON.stringify({ homeLayout: "split", homeTips: true, homeFooter: true }))
    const h = await appHarness({ dataDir, width: 160, height: 40 })
    await h.start({ onboarded: true })
    expect(h.text()).toContain("my own home")
    expect(h.text()).not.toMatch(/┌─+┐/)
    expect(h.text()).not.toContain("● Tip")
  })
})


describe("v1 data-only customization", () => {
  test("JSON phase editors preview valid art and reject invalid input without applying it", () => {
    const profile = { ...DEFAULT_TUI_PROFILE }
    const state = { ...at("activityStates"), typing: '{"idle":" /o\\\\\\n(++)"}' }
    const result = customizePageKey(state, "\r", profile)
    expect(result.action.type).toBe("set")
    const shown = renderCustomizePage({ state, profile, preview: { root: "/work", tip: "", now: 0 }, width: 180, height: 50 })
    expect(shown.map((line) => line.map((span) => span.text).join("")).join("\n")).toContain("(++)")
    const invalid = customizePageKey({ ...state, typing: "{broken" }, "\r", profile)
    expect(invalid.action.type).toBe("none")
    expect(invalid.state.error).toBe("Invalid phase map JSON")
    expect(customizePageKey({ ...at("promptGlyphs"), typing: "bad" }, "\r", profile).state.error).toContain("six single-cell")
  })
})

test("compact activity preview preserves every art row before allocating prompt chrome", () => {
  const art = [" .-.", "(o T)", "/[+]\\", " |||", "_| |_"]
  const profile = { ...DEFAULT_TUI_PROFILE, activityStates: JSON.stringify({ idle: art.join("\n") }) }
  const rows = renderCustomizePage({ state: at("activityStates"), profile, preview: { root: "/work", tip: "", now: 0, phase: "idle" }, width: 60, height: 19 })
  for (const row of art) expect(rows.flat().some((span) => span.text === row)).toBe(true)
  expect(rows).toHaveLength(19)
})
