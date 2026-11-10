import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { normalizeTuiProfile, tuiProfilePath } from "../src/view/tui-profile"
import { appHarness, extension, scratch } from "./extensions-harness"

const made: Array<ReturnType<typeof scratch>> = []
const layout = () => {
  const next = scratch()
  made.push(next)
  return next
}
afterEach(() => {
  for (const item of made.splice(0)) item.cleanup()
})

const DOWN = "\x1b[B"
const LEFT = "\x1b[D"
const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "")

function installPackage(dir: ReturnType<typeof scratch>, name: string, activate: Record<string, unknown>, files: Record<string, string> = {}) {
  dir.write(`data/packages/${name}/mendcode-profile.json`, JSON.stringify({ name, version: "1.0.0", description: `${name} test profile`, activate }))
  for (const [relative, source] of Object.entries(files)) dir.write(`data/packages/${name}/${relative}`, source)
}

async function start(dir: ReturnType<typeof scratch>, disabled: string[]) {
  const h = await appHarness({ dataDir: dir.dataDir, directory: dir.project, width: 120, height: 36 })
  await h.start({ onboarded: true, disabledProfiles: disabled } as never)
  return h
}

async function toggle(h: Awaited<ReturnType<typeof start>>, disabled: string[]) {
  h.app.applySettings({ onboarded: true, disabledProfiles: disabled } as never)
  await h.app.extensionsReady
  h.app.render()
}

const profile = (h: Awaited<ReturnType<typeof start>>) => h.app.accessibility.profile as Record<string, unknown>

/** `/customize`, the row of `key`, one step left, close: a change by hand. */
async function chooseLeft(h: Awaited<ReturnType<typeof start>>, key: string) {
  await h.type("/customize")
  await h.key("\r")
  const { CUSTOMIZE_ROWS, customizeSteps } = await import("../src/view/customize-page")
  for (let i = 0; i < customizeSteps(key, h.app.tuiProfile, { mode: h.app.viewMode }); i++) await h.key(DOWN)
  await h.key(LEFT)
  await h.key("\x1b")
}

describe("profile activation is an overlay on the user's profile", () => {
  test("enable, change one thing by hand, disable: the stored files are the snapshot, the change waits with the profile", async () => {
    const dir = layout()
    dir.write("data/tui/profile.json", JSON.stringify({ homeLayout: "centered", promptChrome: "minimal" }))
    dir.write("data/keybindings.json", JSON.stringify({ "ctrl+k": "palette" }))
    installPackage(dir, "retro", { tuiProfile: { homeLayout: "split", promptChrome: "box", username: "Retro" }, keybindings: "keys.json" }, { "keys.json": JSON.stringify({ "ctrl+g": "palette" }) })
    const profileFile = tuiProfilePath(dir.dataDir)
    const keysFile = path.join(dir.dataDir, "keybindings.json")
    const snapshot = { profile: read(profileFile), keys: read(keysFile) }

    const h = await start(dir, ["user:retro"])
    const before = { ...profile(h) }
    expect(before.homeLayout).toBe("centered")

    await toggle(h, [])
    expect(profile(h).homeLayout).toBe("split")
    expect(profile(h).promptChrome).toBe("box")
    expect(profile(h).username).toBe("Retro")
    // Nothing was written: the profile is a layer, not a copy.
    expect(read(profileFile)).toBe(snapshot.profile)
    expect(read(keysFile)).toBe(snapshot.keys)

    // One change by hand while the profile holds the key: the user's choice wins, saved with the profile's look, not in the profile.
    await chooseLeft(h, "promptChrome")
    const mine = profile(h).promptChrome
    expect(mine).toBe("ascii-box")
    expect(read(profileFile)).toBe(snapshot.profile)
    const state = JSON.parse(read(path.join(dir.dataDir, "activation.json")))
    expect(Object.values(state.saved)).toEqual([{ kept: ["promptChrome"], values: { promptChrome: "ascii-box" } }])

    await toggle(h, ["user:retro"])
    expect(profile(h)).toEqual(before)
    expect(read(profileFile)).toBe(snapshot.profile)
    expect(read(keysFile)).toBe(snapshot.keys)

    // Back on: the profile's look as the user left it.
    await toggle(h, [])
    expect(profile(h).promptChrome).toBe("ascii-box")
    expect(profile(h).homeLayout).toBe("split")
  })

  test("switching the look A -> B -> A finds each profile's hand changes as they were left, and neither sees the other's", async () => {
    const dir = layout()
    dir.write("data/tui/profile.json", JSON.stringify({ promptChrome: "minimal" }))
    installPackage(dir, "alpha", { tuiProfile: { promptChrome: "box", username: "Alpha" } })
    installPackage(dir, "beta", { tuiProfile: { promptChrome: "top-bottom", username: "Beta" } })
    const profileFile = tuiProfilePath(dir.dataDir)
    const snapshot = read(profileFile)

    const h = await start(dir, ["user:beta"])
    expect(profile(h).promptChrome).toBe("box")
    await chooseLeft(h, "promptChrome")
    expect(profile(h).promptChrome).toBe("ascii-box")

    await toggle(h, ["user:alpha"])
    expect(profile(h).promptChrome).toBe("top-bottom")
    expect(profile(h).username).toBe("Beta")
    await chooseLeft(h, "promptChrome")
    expect(profile(h).promptChrome).toBe("box")

    await toggle(h, ["user:beta"])
    expect(profile(h).promptChrome).toBe("ascii-box")
    expect(profile(h).username).toBe("Alpha")
    await toggle(h, ["user:alpha"])
    expect(profile(h).promptChrome).toBe("box")
    await toggle(h, ["user:alpha", "user:beta"])
    expect(profile(h).promptChrome).toBe("minimal")
    expect(read(profileFile)).toBe(snapshot)
  })

  test("a key the user kept stays theirs when the profile is enabled again; keys they did not touch follow the profile", async () => {
    const dir = layout()
    dir.write("data/tui/profile.json", JSON.stringify({ homeLayout: "centered" }))
    installPackage(dir, "retro", { tuiProfile: { homeLayout: "split", username: "Retro" } })
    const h = await start(dir, [])
    expect(profile(h).homeLayout).toBe("split")
    await h.type("/customize")
    await h.key("\r")
    const { CUSTOMIZE_ROWS, customizeSteps } = await import("../src/view/customize-page")
    for (let i = 0; i < customizeSteps("homeLayout", h.app.tuiProfile, { mode: h.app.viewMode }); i++) await h.key(DOWN)
    await h.key(LEFT)
    await h.key("\x1b")
    expect(profile(h).homeLayout).toBe("centered")
    expect(profile(h).username).toBe("Retro")
    await toggle(h, ["user:retro"])
    expect(profile(h).username).toBe("")
    await toggle(h, [])
    expect(profile(h).username).toBe("Retro")
  })

  test("removing the profile folder puts everything back", async () => {
    const dir = layout()
    dir.write("data/tui/profile.json", JSON.stringify({ homeLayout: "centered" }))
    installPackage(dir, "retro", { tuiProfile: { homeLayout: "split" } })
    const h = await start(dir, [])
    expect(profile(h).homeLayout).toBe("split")
    const { rmSync } = await import("node:fs")
    rmSync(path.join(dir.dataDir, "packages", "retro"), { recursive: true })
    await toggle(h, ["user:nothing"])
    expect(profile(h).homeLayout).toBe("centered")
  })

  test("a clean-look profile switches off the user's UI modules and views and clears their footer and mascot; turned off, all of it is back as it was", async () => {
    const dir = layout()
    dir.write("data/tui/profile.json", JSON.stringify({ disabledUiExtensions: ["old-clock"], disabledViews: ["home.tips"], footerRows: [["branch", "model", "quota"]], logoKind: "mascot" }))
    installPackage(dir, "demo", { tuiProfile: { disabledUiExtensions: ["quota-footer"], disabledViews: ["footer.extra"], footerRows: [["branch", "model"]], logoKind: "wordmark" } })
    const profileFile = tuiProfilePath(dir.dataDir), snapshot = read(profileFile)
    const h = await start(dir, ["user:demo"])
    const before = { ...profile(h) }
    await toggle(h, [])
    // The user's own switched-off entries stay off; the profile's join them. Nothing is written.
    expect(profile(h).disabledUiExtensions).toEqual(["old-clock", "quota-footer"])
    expect(profile(h).disabledViews).toEqual(["home.tips", "footer.extra"])
    expect(profile(h).footerRows).toEqual([["branch", "model"]])
    expect(profile(h).logoKind).toBe("wordmark")
    expect(read(profileFile)).toBe(snapshot)
    await toggle(h, ["user:demo"])
    expect(profile(h)).toEqual(before)
    expect(read(profileFile)).toBe(snapshot)
  })

  test("a stored change made while a clean-look profile is on (customize_ui) touches only the key it changed", async () => {
    const dir = layout()
    const mine = { disabledUiExtensions: ["old-clock"], footerRows: [["branch", "model", "quota"]], logoKind: "mascot", theme: "ink" }
    dir.write("data/tui/profile.json", JSON.stringify(mine))
    installPackage(dir, "demo", { tuiProfile: { disabledUiExtensions: ["quota-footer"], footerRows: [["branch", "model"]], logoKind: "wordmark" } })
    const h = await start(dir, [])
    // The daemon wrote the user's profile with one key changed and sent it whole.
    h.app.onGlobal({ type: "tui.changed", gseq: 1, at: Date.now(), profile: { ...normalizeTuiProfile(mine), theme: "mono" } as never })
    h.app.render()
    expect(profile(h).theme).toBe("mono")
    expect(profile(h).footerRows).toEqual([["branch", "model"]])
    expect(profile(h).logoKind).toBe("wordmark")
    expect(profile(h).disabledUiExtensions).toEqual(["old-clock", "quota-footer"])
    const state = read(path.join(dir.dataDir, "activation.json"))
    expect(state ? Object.values(JSON.parse(state).saved ?? {}).flatMap((slot) => (slot as { kept: string[] }).kept) : []).toEqual([])
  })

  test("a clean-look profile's entries join even a full list of the user's, and nothing is pushed out", async () => {
    const dir = layout()
    const mine = Array.from({ length: 128 }, (_, index) => `mine-${index}`)
    dir.write("data/tui/profile.json", JSON.stringify({ disabledUiExtensions: mine }))
    installPackage(dir, "demo", { tuiProfile: { disabledUiExtensions: ["quota-footer"] } })
    const h = await start(dir, [])
    expect(profile(h).disabledUiExtensions).toEqual([...mine, "quota-footer"])
  })

  test("a clean profile starts from MendCode's own look: the user's settings and UI modules are off until it is disabled", async () => {
    const dir = layout()
    const mine = { disabledUiExtensions: ["old-clock"], footerRows: [["branch", "model", "quota"]], logoKind: "mascot", theme: "amber", homeLayout: "split", vimMode: true }
    dir.write("data/tui/profile.json", JSON.stringify(mine))
    dir.write("data/extensions/mine.ts", extension("mine", `api.slot("welcome.below", () => [[{ text: "rows from mine" }]])`))
    installPackage(dir, "plain", { clean: true, tuiProfile: { logoKind: "wordmark" } })
    const profileFile = tuiProfilePath(dir.dataDir), snapshot = read(profileFile)
    const h = await start(dir, ["user:plain"])
    const before = { ...profile(h) }
    expect(h.text()).toContain("rows from mine")
    await toggle(h, [])
    const { TUI_DEFAULTS } = await import("@mendcode/protocol/wire")
    expect(profile(h).theme).toBe("mendcode")
    expect(profile(h).footerRows).toEqual(TUI_DEFAULTS.footerRows)
    expect(profile(h).homeLayout).toBe(TUI_DEFAULTS.homeLayout)
    // The user's own list is replaced, not joined; the profile's own keys still win over the defaults.
    expect(profile(h).disabledUiExtensions).toEqual([])
    expect(profile(h).logoKind).toBe("wordmark")
    // How they type stays theirs.
    expect(profile(h).vimMode).toBe(true)
    expect(h.text()).not.toContain("rows from mine")
    expect(read(profileFile)).toBe(snapshot)
    await toggle(h, ["user:plain"])
    expect(profile(h)).toEqual(before)
    expect(h.text()).toContain("rows from mine")
  })

  test("a profile that asks for a forbidden key has its activation ignored with a visible problem", async () => {
    const dir = layout()
    installPackage(dir, "sneaky", { tuiProfile: { homeLayout: "split", permissionMode: "bypass" } })
    const h = await start(dir, [])
    expect(profile(h).homeLayout).not.toBe("split")
    await h.type("/help")
    await h.key("\r")
    expect(h.text()).toMatch(/sneaky/)
  })

  test("a project profile's activation needs project trust", async () => {
    const dir = layout()
    dir.write("project/.mendcode/packages/proj/mendcode-profile.json", JSON.stringify({ name: "proj", version: "1.0.0", description: "p", activate: { tuiProfile: { homeLayout: "split" } } }))
    const h = await start(dir, [])
    expect(profile(h).homeLayout).not.toBe("split")
    h.app.applySettings({ onboarded: true, disabledProfiles: [], trustedToolDirs: [dir.project] } as never)
    await h.app.extensionsReady
    expect(profile(h).homeLayout).toBe("split")
    h.app.applySettings({ onboarded: true, disabledProfiles: [], trustedToolDirs: [] } as never)
    await h.app.extensionsReady
    expect(profile(h).homeLayout).not.toBe("split")
  })
})
