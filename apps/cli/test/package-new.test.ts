import { afterEach, describe, expect, test } from "bun:test"
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { EXTENSION_API_VERSION } from "@mendcode/extension-api"
import { VIEW_SLOT_NAMES } from "@mendcode/extension-api/views"
import { checkPackage, installPackage, listPackages } from "../../../packages/packages/src"
import { parsePackageFileCommand, runPackageFileCommand } from "../src/package-file-command"
import { packageFiles } from "../src/package-scaffold"
import { appHarness, scratch } from "./extensions-harness"

const cleanups: string[] = []
const made: Array<ReturnType<typeof scratch>> = []
afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true })
  for (const item of made.splice(0)) item.cleanup()
})
const temp = () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-new-")))
  cleanups.push(dir)
  return dir
}
const host = { appVersion: "0.0.1-dev", apiVersion: EXTENSION_API_VERSION }

async function scaffold(name = "ember") {
  const parent = temp()
  const out: string[] = []
  const err: string[] = []
  const command = parsePackageFileCommand(["package", "new", name, "--dir", parent])!
  const code = await runPackageFileCommand(command, { cwd: parent, version: host.appVersion, out: { write: (text) => void out.push(text) }, err: { write: (text) => void err.push(text) } })
  return { parent, dir: path.join(parent, name), code, out: out.join(""), err: err.join("") }
}

describe("mendcode package new", () => {
  test("writes a complete package with one file per thing a package can change", async () => {
    const { dir, code } = await scaffold()
    expect(code).toBe(0)
    for (const file of ["mendcode-package.json", "README.md", "themes/ember.json", "extensions/message-assistant.ts", "extensions/tool-card.ts", "commands/ember-hello.md", "skills/ember-tips/SKILL.md", "keybindings.json", "workflows/ember-review.js", "docs/hooks.example.json"]) expect(existsSync(path.join(dir, file))).toBe(true)
    // The hooks example is not live: only hooks.json is read.
    expect(existsSync(path.join(dir, "hooks.json"))).toBe(false)
    const manifest = JSON.parse(readFileSync(path.join(dir, "mendcode-package.json"), "utf8"))
    expect(manifest.activate.views).toEqual({ "message.assistant": "message-assistant", "tool.card": "tool-card" })
    expect(manifest.activate.tuiProfile.slashMenu).toBe("groups")
    expect(manifest.compatibility.api).toBe(EXTENSION_API_VERSION)
  })

  test("passes package check with no errors and no warnings", async () => {
    const { dir } = await scaffold()
    const result = checkPackage({ dir, host, knownSlots: VIEW_SLOT_NAMES })
    expect(result.errors).toEqual([])
    expect(result.warnings).toEqual([])
    expect(result.ok).toBe(true)
  })

  test("package check is the CLI command too: exit 0 for the scaffold, 1 with the reason for a broken copy", async () => {
    const { dir } = await scaffold()
    const run = async (folder: string) => {
      const out: string[] = []
      const code = await runPackageFileCommand(parsePackageFileCommand(["package", "check", folder])!, { cwd: process.cwd(), version: host.appVersion, out: { write: (text) => void out.push(text) }, err: { write: () => {} } })
      return { code, text: out.join("") }
    }
    expect(await run(dir)).toMatchObject({ code: 0, text: expect.stringContaining("ok: ember passes") })
    const copy = (change: (manifest: Record<string, any>) => void) => {
      const broken = path.join(temp(), "broken")
      cpSync(dir, broken, { recursive: true })
      const manifestFile = path.join(broken, "mendcode-package.json")
      const manifest = JSON.parse(readFileSync(manifestFile, "utf8"))
      change(manifest)
      writeFileSync(manifestFile, JSON.stringify(manifest))
      return broken
    }
    // A forbidden key stops at the schema, with the reason.
    const forbidden = await run(copy((manifest) => { manifest.activate.tuiProfile.permissionMode = "bypass" }))
    expect(forbidden.code).toBe(1)
    expect(forbidden.text).toMatch(/permissionMode: a package cannot set permissions/)
    // Everything else is listed together.
    const broken = copy((manifest) => {
      manifest.activate.views["message.assistant"] = "gone"
      manifest.activate.views["no.slot"] = "tool-card"
      manifest.compatibility.mendcode = ">=99.0.0"
    })
    writeFileSync(path.join(broken, "extensions", "net.ts"), "export default { name: 'net', tui() { void fetch('https://example.invalid') } }")
    const bad = await run(broken)
    expect(bad.code).toBe(1)
    expect(bad.text).toMatch(/no module "gone"/)
    expect(bad.text).toMatch(/activate\.views\.no\.slot/)
    expect(bad.text).toMatch(/>=99\.0\.0/)
    expect(bad.text).toMatch(/appears to use "network" but capabilities does not declare it/)
  })

  test("refuses a name that is not a package name and a folder that exists", async () => {
    const parent = temp()
    const io = { cwd: parent, version: host.appVersion, out: { write: () => {} }, err: { write: () => {} } }
    expect(await runPackageFileCommand(parsePackageFileCommand(["package", "new", "Not A Name"])!, io)).toBe(1)
    expect(await runPackageFileCommand(parsePackageFileCommand(["package", "new", "ok-name"])!, io)).toBe(0)
    expect(await runPackageFileCommand(parsePackageFileCommand(["package", "new", "ok-name"])!, io)).toBe(1)
  })

  test("other `package` words are not this command", () => {
    expect(parsePackageFileCommand(["package", "install", "x"])).toBeUndefined()
    expect(parsePackageFileCommand(["review", "this"])).toBeUndefined()
  })

  test("the scaffold installs, enables, and loads cleanly in the app: its look applies and nothing is reported", async () => {
    const { dir } = await scaffold()
    const dirs = scratch()
    made.push(dirs)
    await installPackage({ spec: dir, scope: "user", userDir: dirs.dataDir, directory: dirs.project, host })
    expect(listPackages({ userDir: dirs.dataDir, directory: dirs.project })[0]).toMatchObject({ key: "user:ember", enabled: true })
    const h = await appHarness({ dataDir: dirs.dataDir, directory: dirs.project, width: 120, height: 36 })
    await h.start({ onboarded: true } as never)
    h.message("hello", "hi there")
    h.tool("read: a.ts", "contents")
    expect(h.app.accessibility.profile).toMatchObject({ logoText: "EMBER", slashMenu: "groups", rightSidebar: true })
    // The starter views draw: the message view prefixes "assistant", the tool card view draws read calls on one line.
    expect(h.text()).toMatch(/assistant/)
    await h.type("/help\r")
    expect(h.text()).not.toMatch(/extension problem|failed to load/)
  })

  test("the files are deterministic per name (a drift guard for the starters)", () => {
    expect(Object.keys(packageFiles("ember")).sort()).toEqual(Object.keys(packageFiles("ember")).sort())
    expect(packageFiles("ember")["extensions/tool-card.ts"]).toContain('name: "ember-tool-card"')
    expect(packageFiles("ember")["workflows/ember-review.js"]).toContain('name: "ember-review"')
  })
})
