import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { discoverExtensions } from "../src/extensions/discover"
import { createExtensionRuntime } from "../src/extensions/runtime"
import { appHarness, extension, scratch } from "./extensions-harness"

const cli = path.join(import.meta.dir, "..")
const dirs: Array<ReturnType<typeof scratch>> = []
function layout() {
  const made = scratch()
  dirs.push(made)
  return made
}
afterEach(() => {
  for (const made of dirs.splice(0)) made.cleanup()
  delete (globalThis as { __extensionDaemonCalls?: number }).__extensionDaemonCalls
})

const tag = (name: string, label: string) => extension(name, `api.markdown((text) => text + " [${label}]")`)

describe("discovery", () => {
  test("finds files and folders with an index in every layer, in load order, and skips what is not a module", () => {
    const { dataDir, project, write } = layout()
    write("data/extensions/b-user.ts", "export default {}")
    write("data/extensions/a-folder/index.js", "export default {}")
    write("data/extensions/a-folder/helper.ts", "export default {}")
    write("data/extensions/no-index/readme.md", "")
    write("data/extensions/types.d.ts", "")
    write("data/extensions/.hidden.ts", "")
    write("data/extensions/notes.txt", "")
    write("data/packages/pkg/extensions/p.ts", "export default {}")
    write("project/.mendcode/packages/pk/extensions/q.ts", "export default {}")
    write("project/.mendcode/extensions/z.ts", "export default {}")
    const found = discoverExtensions({ dataDir, directory: project })
    // The daemon's layer order: user packages, the user's folder, project packages, the project's folder; later wins.
    expect(found.map((file) => path.relative(dataDir.replace(/data$/, ""), file.file))).toEqual([
      "data/packages/pkg/extensions/p.ts",
      "data/extensions/a-folder/index.js",
      "data/extensions/b-user.ts",
      "project/.mendcode/packages/pk/extensions/q.ts",
      "project/.mendcode/extensions/z.ts",
    ])
    expect(found.map((file) => [file.source, file.pkg])).toEqual([["user", "pkg"], ["user", undefined], ["user", undefined], ["project", "pk"], ["project", undefined]])
    expect(found[1]!.dir).toEndWith("a-folder")
    expect(found[2]!.dir).toEndWith("data/extensions")
  })

  test("disabled packages are skipped, and a missing directory is an empty list", () => {
    const { dataDir, project, write } = layout()
    write("data/packages/off/extensions/p.ts", "export default {}")
    write("data/packages/on/extensions/p.ts", "export default {}")
    write("project/.mendcode/packages/off/extensions/q.ts", "export default {}")
    const found = discoverExtensions({ dataDir, directory: project, disabled: ["user:off"] })
    expect(found.map((file) => [file.source, file.pkg])).toEqual([["user", "on"], ["project", "off"]])
    expect(discoverExtensions({ dataDir: path.join(dataDir, "missing"), directory: path.join(project, "missing") })).toEqual([])
  })

  test("a package's single extensions can be switched off by resource key; its other modules stay", () => {
    const { dataDir, project, write } = layout()
    write("data/packages/kit/extensions/a.ts", "export default {}")
    write("data/packages/kit/extensions/b/index.ts", "export default {}")
    write("project/.mendcode/packages/kit/extensions/c.ts", "export default {}")
    const found = discoverExtensions({ dataDir, directory: project, disabledResources: ["user:kit/extensions/a", "project:kit/extensions/c", "user:other/extensions/b"] })
    expect(found.map((file) => [file.source, file.pkg, path.basename(file.file)])).toEqual([["user", "kit", "index.ts"]])
  })
})

describe("loading into the app", () => {
  test("modules load in the daemon's layer order (user packages, user, project packages, project); transforms chain in that order", async () => {
    const { dataDir, project, write } = layout()
    write("data/extensions/b-user.ts", tag("user", "user"))
    write("data/packages/pkg/extensions/p.ts", tag("userpkg", "userpkg"))
    write("project/.mendcode/packages/pk/extensions/q.ts", tag("projpkg", "projpkg"))
    write("project/.mendcode/extensions/z/index.ts", tag("project", "project"))
    const h = await appHarness({ dataDir, directory: project })
    await h.start({ trustedToolDirs: [project] })
    h.message("question", "hi")
    expect(h.text()).toContain("hi [userpkg] [user] [projpkg] [project]")
  })

  test("a package the daemon reports as disabled is not loaded", async () => {
    const { dataDir, project, write } = layout()
    write("data/packages/pkg/extensions/p.ts", tag("userpkg", "userpkg"))
    write("data/extensions/u.ts", tag("user", "user"))
    const h = await appHarness({ dataDir, directory: project })
    await h.start({ disabledPackages: ["user:pkg"] })
    h.message("question", "hi")
    expect(h.text()).toContain("hi [user]")
    expect(h.text()).not.toContain("[userpkg]")
  })

  test("project extensions stay unloaded while the directory is untrusted, and /help says so", async () => {
    const { dataDir, project, write } = layout()
    write("data/extensions/u.ts", tag("user", "user"))
    write("project/.mendcode/extensions/p.ts", tag("project", "project"))
    const h = await appHarness({ dataDir, directory: project, width: 140, height: 70, reply: (command) => (command.type === "tools.list" ? { ok: true, result: { directory: project, tools: [], issues: [] } } : undefined) })
    await h.start({})
    h.message("question", "hi")
    expect(h.text()).toContain("hi [user]")
    expect(h.text()).not.toContain("[project]")
    // tools.list (the daemon's per-directory answer) was asked before giving up.
    expect(h.sent.some((command) => command.type === "tools.list" && command.directory === project)).toBe(true)
    await h.type("/help\r")
    expect(h.text()).toContain("1 extension not loaded: directory not trusted")
  })

  test("a project whose tools.list reports them trusted loads its extensions even when settings carry no trust list", async () => {
    const { dataDir, project, write } = layout()
    write("project/.mendcode/extensions/p.ts", tag("project", "project"))
    const tools = [{ name: "t", toolName: "custom__t", description: "", source: "project", file: "t.json", command: ["x"], trusted: true }]
    const h = await appHarness({ dataDir, directory: project, reply: (command) => (command.type === "tools.list" ? { ok: true, result: { directory: project, tools, issues: [] } } : undefined) })
    await h.start({})
    h.message("question", "hi")
    expect(h.text()).toContain("hi [project]")
  })

  test("trusting the directory later loads its extensions without a restart", async () => {
    const { dataDir, project, write } = layout()
    write("project/.mendcode/extensions/p.ts", tag("project", "project"))
    const h = await appHarness({ dataDir, directory: project })
    await h.start({})
    h.message("question", "hi")
    expect(h.text()).not.toContain("[project]")
    h.app.applySettings({ trustedToolDirs: [project] })
    await h.app.extensionsReady
    h.app.render()
    expect(h.text()).toContain("hi [project]")
  })

  test("invalid modules are recorded, the good ones still load, and one toast and /help report them", async () => {
    const { dataDir, project, write } = layout()
    write("data/extensions/a-good.ts", tag("good", "good"))
    write("data/extensions/b-syntax.ts", "export default { name: ")
    write("data/extensions/c-nodefault.ts", "export const x = 1")
    write("data/extensions/d-noname.ts", "export default { tui() {} }")
    write("data/extensions/e-throws.ts", extension("throws", "api.markdown((t) => t + ' [throws]'); throw new Error('boom in tui')"))
    write("data/extensions/f-rejects.ts", "export default { name: 'rejects', async tui() { throw new Error('async boom') } }")
    write("data/extensions/g-badslot.ts", extension("badslot", "api.slot('nowhere.left', () => undefined)"))
    write("data/extensions/h-dupe.ts", tag("good", "dupe"))
    const h = await appHarness({ dataDir, directory: project, width: 140, height: 70 })
    await h.start({})
    h.message("question", "hi")
    // The failed extension's markdown registration was rolled back; only the good one applies.
    expect(h.text()).toContain("hi [good]")
    expect(h.text()).not.toContain("[dupe]")
    expect(h.text()).not.toContain("[throws]")
    expect(h.text()).toContain("7 extension problems")
    await h.type("/help\r")
    const help = h.text()
    expect(help).toContain("failed to load")
    expect(help).toContain("default export must be { name, tui? }")
    expect(help).toContain("extension needs a name")
    expect(help).toContain("tui() failed: boom in tui")
    expect(help).toContain("tui() failed: async boom")
    expect(help).toContain('unknown slot "nowhere.left"')
    expect(help).toContain("user · terminal")
  })

  test("only tui(api) is called; the daemon half of a module is never run", async () => {
    const { dataDir, write } = layout()
    write("data/extensions/both.ts", "export default { name: 'both', daemon() { globalThis.__extensionDaemonCalls = (globalThis.__extensionDaemonCalls ?? 0) + 1 }, tui(api) { api.markdown((t) => t + ' [both]') } }")
    write("data/extensions/daemon-only.ts", "export default { name: 'daemon-only', daemon() { globalThis.__extensionDaemonCalls = (globalThis.__extensionDaemonCalls ?? 0) + 1 } }")
    const h = await appHarness({ dataDir, width: 140, height: 70 })
    await h.start({})
    h.message("question", "hi")
    expect(h.text()).toContain("hi [both]")
    expect((globalThis as { __extensionDaemonCalls?: number }).__extensionDaemonCalls).toBeUndefined()
    await h.type("/help\r")
    expect(h.text()).toContain("user · daemon only")
  })

  test("a tui() that never settles is given up on instead of hanging the load", async () => {
    const runtime = createExtensionRuntime({ redraw() {}, timeoutMs: 30, importModule: async () => ({ default: { name: "slow", tui: () => new Promise(() => {}) } }) })
    await runtime.load([{ file: "/x/slow.ts", dir: "/x", source: "user" }])
    expect(runtime.problems.map((problem) => problem.message)).toEqual(["tui() failed: took longer than 30 ms"])
    expect(runtime.loaded).toEqual([])
  })
})

describe("no extensions, no extension code", () => {
  function probe(directory: string, dataDir: string) {
    const script = `const { createApp } = await import("./src/ui/app")
const app = createApp({ sessionId: "s1", screen: { size: { width: 80, height: 24 }, draw() {} }, send: async () => ({ ok: true }), exit() {}, directory: ${JSON.stringify(directory)}, dataDir: ${JSON.stringify(dataDir)}, schedule: (fn) => fn() })
app.applySettings({})
await app.extensionsReady
app.render()
const keys = Object.keys(require.cache)
console.log(JSON.stringify({ runtime: keys.some((k) => k.endsWith("/extensions/runtime.ts")), zod: keys.filter((k) => k.includes("/zod/")).length }))`
    const result = Bun.spawnSync(["bun", "-e", script], { cwd: cli, stdout: "pipe", stderr: "pipe" })
    expect(result.stderr.toString()).toBe("")
    return JSON.parse(result.stdout.toString().trim()) as { runtime: boolean; zod: number }
  }

  test("the runtime module is imported only when an extension file exists, and never pulls in zod", () => {
    const { dataDir, project, write } = layout()
    expect(probe(project, dataDir)).toEqual({ runtime: false, zod: 0 })
    write("data/extensions/one.ts", extension("one", "api.markdown((t) => t)"))
    expect(probe(project, dataDir)).toEqual({ runtime: true, zod: 0 })
  })

  test("without registrations the runtime is inactive", () => {
    const runtime = createExtensionRuntime({ redraw() {} })
    expect(runtime.active).toBe(false)
    expect(runtime.markdown("same")).toBe("same")
    expect(runtime.tool({ tool: "shell", detail: "", output: "", status: "ok", width: 40, expanded: false })).toBeUndefined()
  })
})
