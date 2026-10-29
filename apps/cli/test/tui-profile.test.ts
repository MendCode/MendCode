import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { DEFAULT_TUI_PROFILE, PRODUCT_NAME_MAX, normalizeLogoText, normalizeProductName, normalizeTuiProfile, readTuiProfile, tuiProfilePath, writeTuiProfile, type TuiProfile } from "../src/view/tui-profile"
import { scratch } from "./extensions-harness"

const made: Array<ReturnType<typeof scratch>> = []
const dir = () => {
  const next = scratch()
  made.push(next)
  return next.dataDir
}
afterEach(() => {
  for (const item of made.splice(0)) item.cleanup()
})

const custom: TuiProfile = { ...DEFAULT_TUI_PROFILE, promptChrome: "ascii-box", logoText: "ACME", logoFont: "solid", productName: "Acme Code", homeLayout: "split", homeTips: false, homeFooter: true, turnBell: true, sidebar: "always", images: "iterm2" }

describe("tui profile file", () => {
  test("lives at <dataDir>/tui/profile.json", () => {
    expect(tuiProfilePath("/data")).toBe(path.join("/data", "tui", "profile.json"))
  })

  test("a missing file is the defaults, and reading it creates nothing", () => {
    const dataDir = dir()
    expect(readTuiProfile(dataDir)).toEqual(DEFAULT_TUI_PROFILE)
    expect(existsSync(path.join(dataDir, "tui"))).toBe(false)
  })

  test("save then load round-trips every field, creating the folder", () => {
    const dataDir = dir()
    expect(writeTuiProfile(dataDir, custom)).toEqual({ ok: true })
    expect(readTuiProfile(dataDir)).toEqual(custom)
    expect(JSON.parse(readFileSync(tuiProfilePath(dataDir), "utf8"))).toEqual(custom)
    // Written whole and renamed into place: no temporary file is left behind.
    expect(readdirSync(path.join(dataDir, "tui"))).toEqual(["profile.json"])
  })

  test("saved slant profiles migrate atomically to the default without losing identity", () => {
    const dataDir = dir()
    mkdirSync(path.join(dataDir, "tui"), { recursive: true })
    writeFileSync(tuiProfilePath(dataDir), JSON.stringify({ ...custom, logoFont: "slant" }))
    expect(readTuiProfile(dataDir)).toEqual({ ...custom, logoFont: "mendcode" })
    expect(JSON.parse(readFileSync(tuiProfilePath(dataDir), "utf8"))).toEqual({ ...custom, logoFont: "mendcode" })
    expect(readdirSync(path.join(dataDir, "tui"))).toEqual(["profile.json"])
  })

  test("invalid JSON, an array and a number are all the defaults", () => {
    const dataDir = dir()
    mkdirSync(path.join(dataDir, "tui"), { recursive: true })
    for (const text of ["{ not json", "[1,2]", "42", "null", ""]) {
      writeFileSync(tuiProfilePath(dataDir), text)
      expect(readTuiProfile(dataDir)).toEqual(DEFAULT_TUI_PROFILE)
    }
  })

  test("each invalid field falls back alone; the valid ones stay", () => {
    const dataDir = dir()
    mkdirSync(path.join(dataDir, "tui"), { recursive: true })
    writeFileSync(tuiProfilePath(dataDir), JSON.stringify({ promptChrome: "neon", logoText: 7, logoFont: "comic", productName: "  ", homeLayout: "split", homeTips: "yes", homeFooter: true, extra: "ignored" }))
    expect(readTuiProfile(dataDir)).toEqual({ ...DEFAULT_TUI_PROFILE, homeLayout: "split", homeFooter: true })
  })

  test("a save that cannot be written reports the file and keeps no partial file", () => {
    const dataDir = dir()
    // `tui` is a file, so the folder cannot be created.
    writeFileSync(path.join(dataDir, "tui"), "in the way")
    const result = writeTuiProfile(dataDir, custom)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("profile.json")
    expect(readTuiProfile(dataDir)).toEqual(DEFAULT_TUI_PROFILE)
  })
})

describe("tui profile validation", () => {
  test("image modes are validated independently and older profiles default to auto", () => {
    for (const images of ["auto", "kitty", "iterm2", "sixel", "off"]) expect(normalizeTuiProfile({ images }).images).toBe(images)
    expect(normalizeTuiProfile({ images: "unknown" }).images).toBe("auto")
    expect(normalizeTuiProfile({ images: false, sidebar: "hidden" })).toEqual({ ...DEFAULT_TUI_PROFILE, sidebar: "hidden" })
  })
  test("every prompt chrome of v1 is kept, the old left-rail is not", () => {
    for (const promptChrome of ["box", "top-bottom", "minimal", "ascii-box"]) expect(normalizeTuiProfile({ promptChrome }).promptChrome).toBe(promptChrome)
    expect(normalizeTuiProfile({ promptChrome: "left-rail" }).promptChrome).toBe("top-bottom")
  })

  test("v1's legacy fonts fold into mendcode", () => {
    expect(normalizeTuiProfile({ logoFont: "classic" }).logoFont).toBe("mendcode")
    expect(normalizeTuiProfile({ logoFont: "opencode" }).logoFont).toBe("mendcode")
    for (const logoFont of ["mendcode", "compact", "solid", "outline"]) expect(normalizeTuiProfile({ logoFont }).logoFont).toBe(logoFont)
  })

  test("logo text is one trimmed line cut at the font's letter cap; empty means MENDCODE", () => {
    expect(normalizeLogoText("  acme  ")).toBe("acme")
    expect(normalizeLogoText("a\nb\tc\x1b[31m")).toBe("a b c")
    expect(normalizeLogoText("x".repeat(40), "mendcode")).toHaveLength(18)
    expect(normalizeLogoText("x".repeat(40), "compact")).toHaveLength(18)
    expect(normalizeLogoText("   ")).toBe("MENDCODE")
    // A retired font migrates to the default without truncating valid text.
    expect(normalizeTuiProfile({ logoFont: "solid", logoText: "ABCDEFGHIJKLMNOP" }).logoText).toBe("ABCDEFGHIJKLMNOP")
  })

  test("the product name is one line of at most 32 characters; empty means MendCode", () => {
    expect(normalizeProductName("Acme\nCode")).toBe("Acme Code")
    expect(normalizeProductName("n".repeat(80))).toHaveLength(PRODUCT_NAME_MAX)
    expect(normalizeProductName("")).toBe("MendCode")
    expect(normalizeProductName(undefined)).toBe("MendCode")
  })

  test("the same validation runs on save, so a bad value never reaches the file", () => {
    const dataDir = dir()
    writeTuiProfile(dataDir, { ...custom, promptChrome: "neon" as never, productName: "" })
    expect(JSON.parse(readFileSync(tuiProfilePath(dataDir), "utf8"))).toMatchObject({ promptChrome: "top-bottom", productName: "MendCode" })
  })
})

test("loading a retired font atomically migrates the stored profile", () => {
  const dataDir = dir()
  mkdirSync(path.join(dataDir, "tui"), { recursive: true })
  writeFileSync(tuiProfilePath(dataDir), JSON.stringify({ logoFont: "shadow", logoText: "ACME", homeLayout: "split", promptLead: "acme>" }))
  expect(readTuiProfile(dataDir)).toMatchObject({ logoFont: "mendcode", logoText: "ACME", homeLayout: "split", promptLead: "acme>" })
  expect(JSON.parse(readFileSync(tuiProfilePath(dataDir), "utf8")).logoFont).toBe("mendcode")
  expect(readdirSync(path.join(dataDir, "tui"))).toEqual(["profile.json"])
})
