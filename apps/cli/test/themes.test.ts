import { afterEach, describe, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import path from "node:path"
import { COLOR_NAMES, DEFAULT_THEME, THEMES, defineTheme } from "../src/themes"
import { activeTheme, setTheme, sgr, themeNames } from "../src/ui/theme"
import { BORDER_ROLES } from "../src/themes/contrast"

function luminance(hex: string) {
  const channel = (offset: number) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
}

function contrast(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

// The host owns terminal ANSI/default colors, so RGB contrast (including F15) is explicitly inapplicable.
const RGB_THEMES = THEMES.filter((theme) => theme.name !== "terminal")

afterEach(() => setTheme(DEFAULT_THEME))

describe("theme definitions", () => {
  test.each(RGB_THEMES.map((theme) => [theme.name, theme] as const))("%s defines every color as #rrggbb", (_, theme) => {
    for (const color of COLOR_NAMES) expect(theme.colors[color]).toMatch(/^#[0-9a-f]{6}$/i)
    expect(theme.background).toMatch(/^#[0-9a-f]{6}$/i)
    expect(theme.label.length).toBeGreaterThan(0)
  })
  test.each(RGB_THEMES.map((theme) => [theme.name, theme] as const))("%s text and body reach 4.5:1 against its background", (_, theme) => {
    expect(contrast(theme.colors.text, theme.background)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(theme.colors.body, theme.background)).toBeGreaterThanOrEqual(4.5)
  })
  test.each(RGB_THEMES.map((theme) => [theme.name, theme] as const))("%s keeps every readable role at 4.5:1 (border roles excepted)", (_, theme) => {
    for (const color of COLOR_NAMES.filter((name) => !BORDER_ROLES.has(name))) {
      expect(contrast(theme.colors[color], theme.background)).toBeGreaterThanOrEqual(4.5)
    }
  })
  test.each(RGB_THEMES.map((theme) => [theme.name, theme] as const))("%s text stays readable on its panel and diff fills", (_, theme) => {
    for (const fill of ["panel", "element"] as const) expect(contrast(theme.colors.text, theme.colors[fill])).toBeGreaterThanOrEqual(4.5)
    expect(contrast(theme.colors.body, theme.colors.diffAddedBg)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(theme.colors.body, theme.colors.diffRemovedBg)).toBeGreaterThanOrEqual(4.5)
  })
  test.each(RGB_THEMES.map((theme) => [theme.name, theme] as const))("%s borders reach 3:1 and active borders are stronger", (_, theme) => {
    const passive = contrast(theme.colors.border, theme.background)
    expect(passive).toBeGreaterThanOrEqual(3)
    expect(contrast(theme.colors.borderActive, theme.background)).toBeGreaterThan(passive)
  })
  test("light themes have a lighter background than their text", () => {
    for (const theme of RGB_THEMES) expect(luminance(theme.background) > luminance(theme.colors.text)).toBe(!theme.dark)
  })
  test("names are unique and match a lowercase slug", () => {
    const names = THEMES.map((theme) => theme.name)
    expect(new Set(names).size).toBe(names.length)
    for (const name of names) expect(name).toMatch(/^[a-z][a-z0-9-]*$/)
  })
  test("defineTheme rejects a bad color", () => {
    const base = THEMES[0]!
    expect(() => defineTheme({ ...base, colors: { ...base.colors, error: "red" } })).toThrow("[THEME]")
    expect(() => defineTheme({ ...base, name: "Bad Name" })).toThrow("[THEME]")
  })
  test("the default theme is mend (v1's mend-dark) and is the active theme at startup", () => {
    expect(DEFAULT_THEME).toBe("mend")
    expect(THEMES[0]!.name).toBe("mend")
    expect(activeTheme().name).toBe("mend")
    expect(activeTheme().label).toBe("MendCode")
    expect(themeNames()).toContain("matrix")
  })
  test("mend carries v1's profile tokens and its fixed roles", () => {
    const mend = THEMES.find((theme) => theme.name === "mend")!
    expect(mend.background).toBe("#08110d")
    expect(mend.colors).toMatchObject({
      primary: "#22c55e", accent: "#22c55e", text: "#ffffff", body: "#ffffff", muted: "#a3a3a3", secondary: "#a3a3a3", border: "#636363", borderActive: "#22c55e",
      panel: "#0b1f16", element: "#0b1f16", error: "#ef4444", warning: "#f59e0b", success: "#22c55e", info: "#38bdf8", link: "#38bdf8", heading: "#22c55e", code: "#22c55e",
      diffAddedBg: "#052e16", diffRemovedBg: "#450a0a", background: "#08110d",
    })
    expect(contrast(mend.colors.muted, mend.colors.panel)).toBeGreaterThanOrEqual(4.5)
  })
  test("text drawn on a primary bar (the palette's selected row) reads at 3:1 in every theme", () => {
    for (const theme of RGB_THEMES) expect(contrast(theme.colors.background, theme.colors.primary)).toBeGreaterThanOrEqual(3)
  })
})

describe("registry", () => {
  test("every theme file in the folder is registered under its file name", () => {
    const names = (dir: string) =>
      readdirSync(dir)
        .filter((file) => file.endsWith(".ts") && !["index.ts", "define.ts", "contrast.ts"].includes(file))
        .map((file) => file.replace(/\.ts$/, ""))
    const root = path.join(import.meta.dir, "../src/themes")
    const files = [...names(root), ...names(path.join(root, "v1"))].sort()
    expect(THEMES.map((theme) => theme.name).sort()).toEqual(files)
  })
})

describe("active theme", () => {
  test("setTheme switches the sgr output", () => {
    expect(sgr({ text: "x", fg: "primary" }, "truecolor")).toBe("\x1b[38;2;34;197;94m")
    expect(setTheme("matrix")).toBe(true)
    expect(sgr({ text: "x", fg: "primary" }, "truecolor")).toBe("\x1b[38;2;46;255;106m")
    expect(setTheme("amber")).toBe(true)
    expect(activeTheme().name).toBe("amber")
    expect(sgr({ text: "x", fg: "primary" }, "truecolor")).toBe("\x1b[38;2;255;176;0m")
    expect(sgr({ text: "x", fg: "primary" }, "256")).toMatch(/^\x1b\[38;5;\d+m$/)
  })
  test("a coloured dim span is dimmed in its colour toward the theme's background, never with SGR 2; uncoloured text keeps SGR 2", () => {
    const plain = sgr({ text: "x", fgHex: "#ffffff" }, "truecolor")
    const dim = sgr({ text: "x", fgHex: "#ffffff", dim: true }, "truecolor")
    expect(plain).toBe("\x1b[38;2;255;255;255m")
    expect(dim).toMatch(/^\x1b\[38;2;\d+;\d+;\d+m$/)
    expect(dim).not.toBe(plain)
    expect(sgr({ text: "x", fg: "muted", dim: true }, "truecolor")).toMatch(/^\x1b\[38;2;/)
    expect(sgr({ text: "x", fg: "muted", dim: true }, "256")).toMatch(/^\x1b\[38;5;/)
    expect(sgr({ text: "x", dim: true }, "truecolor")).toBe("\x1b[2m")
  })
  test("content colors paint the background too, in truecolor or the 256 palette, and bad values are ignored", () => {
    expect(sgr({ text: "▀", fgHex: "#ff0000", bgHex: "#00f" }, "truecolor")).toBe("\x1b[38;2;255;0;0;48;2;0;0;255m")
    expect(sgr({ text: "▀", bgHex: "#0000ff" }, "256")).toBe("\x1b[48;5;21m")
    expect(sgr({ text: "▀", bgHex: "blue" }, "truecolor")).toBe("")
  })
  test("unknown names return false and keep the current theme", () => {
    setTheme("fjord")
    expect(setTheme("nope")).toBe(false)
    expect(setTheme("")).toBe(false)
    expect(activeTheme().name).toBe("fjord")
  })
  test("names are matched case-insensitively", () => {
    expect(setTheme(" Paper ")).toBe(true)
    expect(activeTheme().name).toBe("paper")
  })
  test("fgHex still wins over the theme role", () => {
    setTheme("mono")
    expect(sgr({ text: "x", fg: "primary", fgHex: "#ff0000" }, "truecolor")).toBe("\x1b[38;2;255;0;0m")
  })
  test("themeNames lists the registry in order", () => {
    expect(themeNames()).toEqual(THEMES.map((theme) => theme.name))
    expect(themeNames()).toContain("paper")
  })
  test("MENDCODE_THEME selects the theme at startup", async () => {
    const script = `import { activeTheme } from "./apps/cli/src/ui/theme"; console.log(activeTheme().name)`
    const run = (theme: string) =>
      Bun.spawnSync(["bun", "-e", script], { cwd: path.join(import.meta.dir, "../../.."), env: { ...process.env, MENDCODE_THEME: theme } }).stdout.toString().trim()
    expect(run("mint")).toBe("mint")
    expect(run("does-not-exist")).toBe("mend")
  })
})

describe("UI-8 terminal palette", () => {
  test("all roles emit ANSI 16/default at either advertised color depth, including content colors", () => {
    expect(setTheme("terminal")).toBe(true)
    expect(sgr({ text: "x", fg: "text", bg: "background" }, "truecolor")).toBe("\x1b[39;49m")
    expect(sgr({ text: "x", fg: "primary" }, "truecolor")).toBe("\x1b[32m")
    for (const depth of ["truecolor", "256"] as const) for (const role of COLOR_NAMES) {
      const code = sgr({ text: "x", fg: role, bg: role, bold: true }, depth)
      expect(code).not.toMatch(/(?:38|48);(?:2|5);/)
      expect(code).toMatch(/^\x1b\[(?:1;)?(?:3[0-9]|9[0-7]);(?:4[0-9]|10[0-7])m$/)
    }
    expect(sgr({ text: "▀", fgHex: "#ff0000", bgHex: "#00f" }, "truecolor")).toBe("\x1b[91;104m")
  })

  test("all missing v1 themes are registered and matrix carries v1 fills and syntax", () => {
    for (const name of ["cursor", "lucent-orng", "mercury", "vesper", "terminal"]) expect(themeNames()).toContain(name)
    const matrix = THEMES.find((theme) => theme.name === "matrix")!
    expect(matrix.colors).toMatchObject({ panel: "#0e130d", element: "#141c12", body: "#62ff94", synKeyword: "#c770ff", synFunction: "#30b3ff", diffAddedBg: "#132616", diffRemovedBg: "#261212" })
  })
})
