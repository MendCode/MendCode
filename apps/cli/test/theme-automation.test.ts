import { afterEach, describe, expect, test } from "bun:test"
import { parseAutomation, runAutomation, helpText, SCHEMA } from "../src/automation"
import { catalogHarness } from "./catalog-harness"
import { appHarness, cleanTemps, tempDir, NOW } from "./session-ui-harness"
import { activeTheme, registerThemes, setTheme, themeNames } from "../src/ui/theme"
import { themesFromFiles } from "../src/ui/theme-files"
import { readTuiProfile, writeTuiProfile } from "../src/view/tui-profile"
import { CUSTOMIZE_ROWS } from "../src/view/customize-page"
import { legacyTheme, nativeTheme } from "../../../packages/protocol/test/theme-fixtures"
import type { ThemeFile } from "@mendcode/protocol"

const file: ThemeFile = { name: "Forest_Mode", file: "/tmp/themes/Forest_Mode.json", source: "project", json: legacyTheme }
afterEach(() => { cleanTemps(); registerThemes([]); setTheme("mend") })

describe("B65 theme CLI", () => {
  test("validate/install/select parse scoped names and data-dir aliases without affecting other commands", () => {
    expect(parseAutomation(["theme", "validate", "theme.json"])).toMatchObject({ command: { kind: "theme.validate", file: "theme.json" } })
    expect(parseAutomation(["--dir", "/tmp/data", "theme", "install", "theme.json"])).toMatchObject({ command: { kind: "theme.install", scope: "project", dir: "/tmp/data" } })
    expect(parseAutomation(["theme", "install", "theme.json", "--name=1Night.Mode", "--scope=user", "--data-dir=/tmp/data", "--json"])).toMatchObject({ command: { name: "1Night.Mode", scope: "user", dir: "/tmp/data", json: true } })
    expect(parseAutomation(["theme", "select", "Forest_Mode", "--scope", "global"])).toMatchObject({ command: { kind: "theme.select", name: "Forest_Mode", scope: "user" } })
    expect(parseAutomation(["theme", "--help"])).toMatchObject({ command: { kind: "help", topic: "theme" } })
    expect(helpText("theme")).toContain("theme validate <file>")
    expect(parseAutomation(["session", "list"]).ok).toBe(true)
  })
  for (const args of [
    ["theme"], ["theme", "validate"], ["theme", "install", "a", "extra"], ["theme", "select", "../bad"], ["theme", "install", "a", "--name", ""],
    ["theme", "select", "a", "--scope", "no"], ["theme", "select", "a", "--name", "b"], ["theme", "validate", "a", "--scope", "user"],
    ["theme", "install", "a", "--name"], ["theme", "select", "a", "--json=maybe"], ["theme", "install", "a", "--unknown"],
  ]) test(`rejects ${args.join(" ")}`, () => expect(parseAutomation(args).ok).toBe(false))
  test("automation factories resolve paths at the project and keep validation failures as result data", async () => {
    const fixture = catalogHarness({ send: (command) => ({ ok: true, result: { ok: command.type !== "theme.validate", errors: command.type === "theme.validate" ? ["invalid JSON"] : [], callsProviders: false } }) })
    expect(await fixture.run(["theme", "validate", "theme.json", "--json"])).toBe(1)
    expect(fixture.sent[0]).toEqual({ type: "theme.validate", file: "/work/catalog/theme.json" })
    expect(JSON.parse(fixture.out.join(""))).toMatchObject({ schema: SCHEMA, kind: "result", command: "theme.validate", data: { ok: false, errors: ["invalid JSON"], callsProviders: false } })
    expect(await fixture.run(["theme", "install", "theme.json", "--name", "Forest_Mode", "--scope", "global"])).toBe(0)
    expect(fixture.sent[1]).toEqual({ type: "theme.install", directory: "/work/catalog", file: "/work/catalog/theme.json", name: "Forest_Mode", scope: "user" })
    expect(await fixture.run(["theme", "select", "Forest_Mode"])).toBe(0)
    expect(fixture.sent[2]).toEqual({ type: "theme.select", directory: "/work/catalog", name: "Forest_Mode", scope: "project" })
  })
  test("daemon errors fail cleanly and remote file operations never send a request", async () => {
    const fixture = catalogHarness({ send: () => ({ ok: false, error: { code: "invalid_command", message: "Invalid theme" } }) })
    expect(await fixture.run(["theme", "select", "missing", "--json"])).toBe(1)
    expect(JSON.parse(fixture.out.join(""))).toMatchObject({ kind: "error", error: { code: "invalid_command", message: "Invalid theme" } })
    const parsed = parseAutomation(["theme", "install", "file.json"])
    if (parsed.ok !== true) throw new Error("parse failed")
    fixture.sent.length = 0
    expect(await runAutomation(parsed.command, { ...fixture.deps, allowFiles: false })).toBe(64)
    expect(fixture.sent).toEqual([])
  })
})

describe("B65 themes in the app harness", () => {
  test("v1 themes and v1-compatible names load into the native palette", async () => {
    const result = themesFromFiles([file])
    expect(result.problems).toEqual([])
    registerThemes(result.themes)
    expect(setTheme("Forest_Mode")).toBe(true)
    expect(activeTheme()).toMatchObject({ name: "Forest_Mode", background: "#0b1210" })
    const fixture = appHarness({ directory: "/work/project", reply: (command) => command.type === "themes.list" ? { ok: true, result: { themes: [file] } } : undefined })
    await fixture.type("/theme Forest_Mode\r")
    expect(fixture.sent).toContainEqual({ type: "settings.set", patch: { theme: "Forest_Mode" } })
  })
  test("project selection overrides the local profile and does not affect another project's theme", async () => {
    registerThemes(themesFromFiles([file]).themes)
    const dataDir = tempDir()
    writeTuiProfile(dataDir, { theme: "matrix" })
    const fixture = appHarness({ dataDir, directory: "/work/project", reply: (command) => command.type === "themes.list" ? { ok: true, result: { themes: [file] } } : undefined })
    fixture.app.applySettings({ theme: "mend", projectThemes: { "/work/project": "Forest_Mode", "/work/other": "paper" } })
    expect(activeTheme().name).toBe("Forest_Mode")
    await fixture.type("/theme amber\r")
    expect(fixture.sent).toContainEqual({ type: "settings.set", patch: { projectThemes: { "/work/project": "amber", "/work/other": "paper" } } })
    expect(fixture.sent.some((command) => command.type === "settings.set" && command.patch.theme === "amber")).toBe(false)
    expect(readTuiProfile(dataDir).theme).toBe("matrix")
    const other = appHarness({ dataDir, directory: "/work/elsewhere" })
    other.app.applySettings({ theme: "mend", projectThemes: { "/work/project": "Forest_Mode" } })
    expect(activeTheme().name).toBe("matrix")
  })
  test("selecting an installed name again refreshes its edited palette", async () => {
    registerThemes(themesFromFiles([{ ...file, json: nativeTheme }]).themes)
    let json = nativeTheme
    const fixture = appHarness({ directory: "/work/project", reply: (command) => command.type === "themes.list" ? { ok: true, result: { themes: [{ ...file, json }] } } : undefined })
    fixture.app.applySettings({ theme: "Forest_Mode" })
    await Bun.sleep(5)
    json = { ...nativeTheme, colors: { ...nativeTheme.colors, primary: "#ffaf00" } }
    fixture.app.applySettings({ theme: "Forest_Mode" })
    await Bun.sleep(5)
    expect(activeTheme().colors.primary).toBe("#ffaf00")
  })
  test("user selection replaces an old local preference even when the global name is unchanged", async () => {
    const dataDir = tempDir()
    writeTuiProfile(dataDir, { theme: "matrix" })
    const fixture = appHarness({ dataDir, directory: "/work/project", reply: (command) => command.type === "themes.list" ? { ok: true, result: { themes: [{ ...file, json: nativeTheme }] } } : undefined })
    fixture.app.applySettings({ theme: "Forest_Mode" })
    expect(activeTheme().name).toBe("matrix")
    fixture.app.onGlobal({ type: "tui.changed", gseq: 1, at: NOW, profile: { ...readTuiProfile(dataDir), theme: "Forest_Mode" } })
    await Bun.sleep(5)
    expect(activeTheme().name).toBe("Forest_Mode")
  })
  test("Customize shows and cycles the active project theme without overwriting the user's theme", async () => {
    registerThemes(themesFromFiles([file]).themes)
    const dataDir = tempDir()
    writeTuiProfile(dataDir, { theme: "matrix" })
    const fixture = appHarness({ dataDir, directory: "/work/project", reply: (command) => command.type === "themes.list" ? { ok: true, result: { themes: [file] } } : undefined })
    fixture.app.applySettings({ theme: "mend", projectThemes: { "/work/project": "Forest_Mode", "/work/other": "paper" } })
    await fixture.type("/customize\r")
    for (let row = 0; row < CUSTOMIZE_ROWS.indexOf("theme"); row++) await fixture.app.onKey("\x1b[B")
    fixture.app.render()
    expect(fixture.text().join("\n")).toContain("Forest_Mode")
    await fixture.app.onKey("\x1b[C")
    expect(activeTheme().name).toBe(themeNames()[0]!)
    expect(readTuiProfile(dataDir).theme).toBe("matrix")
    expect(fixture.sent).toContainEqual({ type: "settings.set", patch: { projectThemes: { "/work/project": themeNames()[0]!, "/work/other": "paper" } } })
  })
  test("live selections reload files and replace a cached profile theme without restarting", async () => {
    const dataDir = tempDir()
    writeTuiProfile(dataDir, { theme: "matrix" })
    const fixture = appHarness({ dataDir, directory: "/work/project", reply: (command) => command.type === "themes.list" ? { ok: true, result: { themes: [{ ...file, json: nativeTheme }] } } : undefined })
    fixture.app.applySettings({ theme: "matrix" })
    fixture.app.applySettings({ theme: "Forest_Mode" })
    await Bun.sleep(5)
    expect(themeNames()).toContain("Forest_Mode")
    expect(activeTheme().name).toBe("Forest_Mode")
    fixture.app.applySettings({ theme: "Forest_Mode", reducedMotion: true })
    expect(activeTheme().name).toBe("Forest_Mode")
    expect(fixture.sent).toContainEqual({ type: "themes.list", directory: "/work/project" })
  })
})
