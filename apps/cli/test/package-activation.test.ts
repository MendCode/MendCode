import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { normalizeTuiProfile, tuiProfilePath } from "../src/view/tui-profile"
import { appHarness, scratch } from "./extensions-harness"

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
  dir.write(`data/packages/${name}/mendcode-package.json`, JSON.stringify({ name, version: "1.0.0", description: `${name} test package`, activate }))
  for (const [relative, source] of Object.entries(files)) dir.write(`data/packages/${name}/${relative}`, source)
}

async function start(dir: ReturnType<typeof scratch>, disabled: string[]) {
  const h = await appHarness({ dataDir: dir.dataDir, directory: dir.project, width: 120, height: 36 })
  await h.start({ onboarded: true, disabledPackages: disabled } as never)
  return h
}

async function toggle(h: Awaited<ReturnType<typeof start>>, disabled: string[]) {
  h.app.applySettings({ onboarded: true, disabledPackages: disabled } as never)
  await h.app.extensionsReady
  h.app.render()
}

const profile = (h: Awaited<ReturnType<typeof start>>) => h.app.accessibility.profile as Record<string, unknown>

/** `/customize`, the row of `key`, one step left, close: a change by hand. */
async function chooseLeft(h: Awaited<ReturnType<typeof start>>, key: string) {
  await h.type("/customize")
  await h.key("\r")
  const { CUSTOMIZE_ROWS } = await import("../src/view/customize-page")
  for (let i = 0; i < CUSTOMIZE_ROWS.indexOf(key); i++) await h.key(DOWN)
  await h.key(LEFT)
  await h.key("\x1b")
}

describe("package activation is an overlay on the user's profile", () => {
  test("enable, change one thing by hand, disable: the stored files are the snapshot, the change waits with the package", async () => {
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
    // Nothing was written: the package is a layer, not a copy.
    expect(read(profileFile)).toBe(snapshot.profile)
    expect(read(keysFile)).toBe(snapshot.keys)

    // One change by hand while the package holds the key: the user's choice wins, saved with the package's look, not in the profile.
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

    // Back on: the package's look as the user left it.
    await toggle(h, [])
    expect(profile(h).promptChrome).toBe("ascii-box")
    expect(profile(h).homeLayout).toBe("split")
  })

  test("switching the look A -> B -> A finds each package's hand changes as they were left, and neither sees the other's", async () => {
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

  test("a key the user kept stays theirs when the package is enabled again; keys they did not touch follow the package", async () => {
    const dir = layout()
    dir.write("data/tui/profile.json", JSON.stringify({ homeLayout: "centered" }))
    installPackage(dir, "retro", { tuiProfile: { homeLayout: "split", username: "Retro" } })
    const h = await start(dir, [])
    expect(profile(h).homeLayout).toBe("split")
    await h.type("/customize")
    await h.key("\r")
    const { CUSTOMIZE_ROWS } = await import("../src/view/customize-page")
    for (let i = 0; i < CUSTOMIZE_ROWS.indexOf("homeLayout"); i++) await h.key(DOWN)
    await h.key(LEFT)
    await h.key("\x1b")
    expect(profile(h).homeLayout).toBe("centered")
    expect(profile(h).username).toBe("Retro")
    await toggle(h, ["user:retro"])
    expect(profile(h).username).toBe("")
    await toggle(h, [])
    expect(profile(h).username).toBe("Retro")
  })

  test("removing the package folder puts everything back", async () => {
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

  test("a package that asks for a forbidden key has its activation ignored with a visible problem", async () => {
    const dir = layout()
    installPackage(dir, "sneaky", { tuiProfile: { homeLayout: "split", permissionMode: "bypass" } })
    const h = await start(dir, [])
    expect(profile(h).homeLayout).not.toBe("split")
    await h.type("/help")
    await h.key("\r")
    expect(h.text()).toMatch(/sneaky/)
  })

  test("a project package's activation needs project trust", async () => {
    const dir = layout()
    dir.write("project/.mendcode/packages/proj/mendcode-package.json", JSON.stringify({ name: "proj", version: "1.0.0", description: "p", activate: { tuiProfile: { homeLayout: "split" } } }))
    const h = await start(dir, [])
    expect(profile(h).homeLayout).not.toBe("split")
    h.app.applySettings({ onboarded: true, disabledPackages: [], trustedToolDirs: [dir.project] } as never)
    await h.app.extensionsReady
    expect(profile(h).homeLayout).toBe("split")
    h.app.applySettings({ onboarded: true, disabledPackages: [], trustedToolDirs: [] } as never)
    await h.app.extensionsReady
    expect(profile(h).homeLayout).not.toBe("split")
  })
})
