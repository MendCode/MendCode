import { describe, expect, test } from "bun:test"
import { Command } from "../src/commands"
import { isReadOnlyCommand } from "../src/remote"
import { MAX_THEME_BYTES, THEME_NAME, themeDocument } from "../src/theme-data"
import { createIdFactory } from "../src/id-factory"
import { legacyTheme, nativeTheme } from "./theme-fixtures"

const ids = createIdFactory()
const base = { id: ids("command"), clientId: ids("client") }

describe("B65 theme protocol", () => {
  test("additive commands default to project and confine names; arbitrary-file reads are not read-only", () => {
    expect(Command.parse({ ...base, type: "theme.install", directory: "/tmp/project", file: "/tmp/forest.json" })).toMatchObject({ scope: "project" })
    for (const name of ["../bad", "/bad", "", "has space", "a".repeat(41)]) expect(Command.safeParse({ ...base, type: "theme.select", directory: "/tmp/project", name }).success).toBe(false)
    for (const name of ["1Night.Mode", "forest", "MY_THEME"]) expect(THEME_NAME.test(name)).toBe(true)
    for (const type of ["theme.validate", "theme.install", "theme.select"] as const) expect(isReadOnlyCommand(type)).toBe(false)
    expect(MAX_THEME_BYTES).toBe(16384)
  })
  test("native documents validate every required and optional rendering role", () => {
    expect(themeDocument(nativeTheme)).toMatchObject({ errors: [], document: nativeTheme })
    expect(themeDocument({ ...nativeTheme, colors: { ...nativeTheme.colors, primary: "no" } }).errors).toContain("primary must be #rrggbb")
    expect(themeDocument({ ...nativeTheme, colors: { ...nativeTheme.colors, borderActive: "bad" } }).errors).toContain("borderActive must be #rrggbb")
    expect(themeDocument(null).document).toBeUndefined()
  })
  test("v1 references, variants, short hex and ANSI palettes normalize to native roles", () => {
    const result = themeDocument(legacyTheme)
    expect(result.errors).toEqual([])
    expect(result.document).toMatchObject({ background: "#0b1210", dark: true, colors: { body: "#f3f4f6", synNumber: "#ffaf00", primary: "#4ade80" } })
    expect(themeDocument({ ...legacyTheme, dark: false }).document?.background).toBe("#ffffff")
    expect(themeDocument({ ...legacyTheme, defs: { ...legacyTheme.defs, green: "#0f0" } }).document?.colors.primary).toBe("#00ff00")
    expect(themeDocument({ ...legacyTheme, theme: { ...legacyTheme.theme, text: "none", background: "transparent" } })).toMatchObject({ errors: [], document: { background: "#0b1210", colors: { text: "#f3f4f6" } } })
    expect(themeDocument({ ...legacyTheme, theme: { ...legacyTheme.theme, text: "none", background: "#ffffff" } }).errors).toEqual([])
  })
  test("missing roles, cycles, unknown references, broken light variants and low contrast fail", () => {
    expect(themeDocument({ theme: {} }).errors).toContain("theme.primary is required")
    for (const defs of [ { ...legacyTheme.defs, green: "missing" }, { ...legacyTheme.defs, green: "green" }, { ...legacyTheme.defs, green: { dark: "#00ff00", light: "missing" } } ]) expect(themeDocument({ ...legacyTheme, defs }).errors.length).toBeGreaterThan(0)
    expect(themeDocument({ ...legacyTheme, theme: { ...legacyTheme.theme, text: "ink" } }).errors[0]).toContain("minimum is 3:1")
  })
})
