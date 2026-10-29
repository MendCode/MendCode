import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Glob } from "bun"
import { compatibilityProblem, PACKAGE_KINDS, PACKAGE_READ_PATHS, resolveActivation, unknownPackageEntries, versionSatisfies, type ActivationPackage } from "@mendcode/protocol/wire"
import { installPackage, listPackages, listTrash, MANIFEST_FILE, moveToTrash, pruneTrash, removePackage, restorePackage, TRASH_RETENTION_MS } from "../src"

const cleanups: string[] = []
afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function temp(prefix: string) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  cleanups.push(dir)
  return dir
}

function write(file: string, text: string) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}

function source(version: string, extra: Record<string, unknown> = {}) {
  const dir = temp("life-src-")
  write(path.join(dir, MANIFEST_FILE), JSON.stringify({ name: "acme", version, description: "Acme", ...extra }))
  write(path.join(dir, "commands", "hi.md"), `hello ${version}`)
  return dir
}

const roots = () => ({ userDir: temp("life-user-"), directory: temp("life-proj-") })
const installed = (userDir: string) => path.join(userDir, "packages", "acme")
const leftovers = (userDir: string) => readdirSync(path.join(userDir, "packages")).filter((name) => name.startsWith(".staging"))

describe("install replace is atomic", () => {
  test("a failure of the first rename leaves the installed copy exactly as it was", async () => {
    const { userDir, directory } = roots()
    await installPackage({ spec: source("1.0.0"), scope: "user", userDir, directory })
    const before = readFileSync(path.join(installed(userDir), "commands", "hi.md"), "utf8")
    let calls = 0
    const rename = () => {
      calls++
      throw new Error("disk says no")
    }
    await expect(installPackage({ spec: source("2.0.0"), scope: "user", userDir, directory, replace: true, rename })).rejects.toThrow("disk says no")
    expect(calls).toBe(1)
    expect(readFileSync(path.join(installed(userDir), "commands", "hi.md"), "utf8")).toBe(before)
    expect(listPackages({ userDir, directory })[0]?.manifest?.version).toBe("1.0.0")
    expect(leftovers(userDir)).toEqual([])
  })

  test("a failure of the second rename puts the previous copy back", async () => {
    const { userDir, directory } = roots()
    await installPackage({ spec: source("1.0.0"), scope: "user", userDir, directory })
    const { renameSync } = await import("node:fs")
    let calls = 0
    const rename = (from: string, to: string) => {
      if (++calls === 2) throw new Error("second rename failed")
      renameSync(from, to)
    }
    await expect(installPackage({ spec: source("2.0.0"), scope: "user", userDir, directory, replace: true, rename })).rejects.toThrow("second rename failed")
    expect(listPackages({ userDir, directory })[0]?.manifest?.version).toBe("1.0.0")
    expect(readFileSync(path.join(installed(userDir), "commands", "hi.md"), "utf8")).toBe("hello 1.0.0")
    expect(leftovers(userDir)).toEqual([])
  })

  test("a successful replace keeps the old copy in the Trash, restorable", async () => {
    const { userDir, directory } = roots()
    await installPackage({ spec: source("1.0.0"), scope: "user", userDir, directory })
    await installPackage({ spec: source("2.0.0"), scope: "user", userDir, directory, replace: true })
    expect(listPackages({ userDir, directory })[0]?.manifest?.version).toBe("2.0.0")
    expect(listTrash({ base: userDir, label: "acme" })).toHaveLength(1)
  })

  test("a package that needs a newer app is refused before anything is written", async () => {
    const { userDir, directory } = roots()
    const host = { appVersion: "1.2.0", apiVersion: 1 }
    await expect(installPackage({ spec: source("1.0.0", { compatibility: { mendcode: ">=2.0.0" } }), scope: "user", userDir, directory, host })).rejects.toThrow(/>=2\.0\.0/)
    expect(existsSync(installed(userDir))).toBe(false)
    expect(leftovers(userDir)).toEqual([])
  })
})

describe("the Trash", () => {
  test("remove moves to the Trash, restore brings it back, purge deletes", async () => {
    const { userDir, directory } = roots()
    await installPackage({ spec: source("1.0.0"), scope: "user", userDir, directory })
    expect(removePackage({ name: "acme", scope: "user", userDir, directory })).toBe(true)
    expect(existsSync(installed(userDir))).toBe(false)
    expect(listTrash({ base: userDir, label: "acme" })).toHaveLength(1)
    restorePackage({ name: "acme", scope: "user", userDir, directory })
    expect(readFileSync(path.join(installed(userDir), "commands", "hi.md"), "utf8")).toBe("hello 1.0.0")
    expect(removePackage({ name: "acme", scope: "user", userDir, directory, purge: true })).toBe(true)
    expect(listTrash({ base: userDir, label: "acme" })).toHaveLength(0)
  })

  test("a failed move leaves the package installed", async () => {
    const { userDir, directory } = roots()
    await installPackage({ spec: source("1.0.0"), scope: "user", userDir, directory })
    expect(() => removePackage({ name: "acme", scope: "user", userDir, directory, rename: () => { throw new Error("no space") } })).toThrow("no space")
    expect(existsSync(installed(userDir))).toBe(true)
  })

  test("entries older than the retention period are deleted the next time something moves to the Trash", () => {
    const base = temp("life-trash-")
    const old = path.join(base, "old-thing")
    write(path.join(old, "a.txt"), "a")
    const oldAt = 1_700_000_000_000
    moveToTrash({ base, source: old, label: "old", now: () => oldAt })
    expect(listTrash({ base })).toHaveLength(1)
    const fresh = path.join(base, "fresh-thing")
    write(path.join(fresh, "b.txt"), "b")
    moveToTrash({ base, source: fresh, label: "fresh", now: () => oldAt + TRASH_RETENTION_MS + 1000 })
    expect(listTrash({ base }).map((entry) => entry.label)).toEqual(["fresh"])
    expect(pruneTrash({ base, now: oldAt + 2 * TRASH_RETENTION_MS + 5000 })).toBe(1)
  })

  test("a Trash that is a link is refused", () => {
    const base = temp("life-trash-link-")
    const elsewhere = temp("life-elsewhere-")
    require("node:fs").symlinkSync(elsewhere, path.join(base, ".Trash"))
    const thing = path.join(base, "thing")
    write(path.join(thing, "a.txt"), "a")
    expect(() => moveToTrash({ base, source: thing, label: "thing" })).toThrow(/link/)
    expect(existsSync(thing)).toBe(true)
    utimesSync(thing, new Date(), new Date())
  })
})

describe("version ranges", () => {
  test("the common ranges", () => {
    for (const [range, version, ok] of [[">=1.2.0", "1.2.0", true], [">=1.2.0", "1.1.9", false], ["^1.2.0", "1.9.0", true], ["^1.2.0", "2.0.0", false], ["~1.2.0", "1.2.9", true], ["~1.2.0", "1.3.0", false], [">=1 <2", "1.5.0", true], [">=1 <2", "2.0.0", false], ["1.x", "1.4.0", true], ["*", "0.0.1", true], ["1.2.3", "1.2.3", true], ["1.2.3", "1.2.4", false]] as const) {
      expect([range, version, versionSatisfies(version, range)]).toEqual([range, version, ok])
    }
  })

  test("api and mendcode are checked separately, and an unreadable label is not enforced", () => {
    expect(compatibilityProblem({ compatibility: { api: 2 }, appVersion: "1.0.0", apiVersion: 1 })).toMatch(/API 2/)
    expect(compatibilityProblem({ compatibility: { mendcode: "v2 and later" }, appVersion: "1.0.0", apiVersion: 1 })).toBeUndefined()
    expect(compatibilityProblem({ compatibility: { mendcode: ">=1.0.0" }, appVersion: "1.0.0", apiVersion: 1 })).toBeUndefined()
  })
})

describe("one table of resource kinds", () => {
  test("every folder or file a loader reads under a layer is in the table", async () => {
    const repo = path.join(import.meta.dir, "..", "..", "..")
    const found = new Set<string>()
    const patterns = [/layer\w*\.dir, "([A-Za-z_.-]+)"/g, /layerReads\(\w+, "(\w+)"\)/g]
    for (const folder of ["packages/daemon/src", "packages/engine-native/src", "packages/packages/src", "apps/cli/src"]) {
      for await (const file of new Glob("**/*.ts").scan(path.join(repo, folder))) {
        const text = readFileSync(path.join(repo, folder, file), "utf8")
        for (const pattern of patterns) for (const match of text.matchAll(pattern)) found.add(match[1]!)
      }
    }
    expect([...found].length).toBeGreaterThan(5)
    const known = new Set([...PACKAGE_READ_PATHS, ...PACKAGE_KINDS.map((kind) => kind.id)])
    expect([...found].filter((name) => !known.has(name))).toEqual([])
  })

  test("a package folder with an entry no loader reads is reported", () => {
    expect(unknownPackageEntries(["skills", "hooks.json", "README.md", "mendcode-package.json", "mystery"])).toEqual(["mystery"])
  })
})

describe("resolving activations", () => {
  const pkg = (key: string, activation: ActivationPackage["activation"], extra: Partial<ActivationPackage> = {}): ActivationPackage => ({ key, scope: "user", activation, ...extra })
  const resolve = (packages: ActivationPackage[], overrides: Partial<Parameters<typeof resolveActivation>[0]> = {}) => resolveActivation({ packages, state: { user: { kept: [] }, project: { kept: [] } } as never, projectTrusted: true, base: {}, panel: () => undefined, ...overrides })

  test("two packages with a look: the recorded owner has it, the other waits and nothing of it applies", () => {
    const result = resolve([pkg("user:a", { tuiProfile: { username: "A" } }), pkg("user:b", { tuiProfile: { username: "B", homeLayout: "split" } })], { state: { user: { kept: [], look: "user:a" }, project: { kept: [] } } as never })
    expect(result.overlay).toEqual({ username: "A" })
    expect(result.waiting).toMatchObject([{ package: "user:b", owner: "user:a" }])
  })

  test("independent keys from different packages merge, and a key bound twice is a visible conflict", () => {
    const result = resolve([
      pkg("user:a", { keybindings: "keys.json" }, { keybindings: { "ctrl+g": "palette", "ctrl+y": "help" } }),
      pkg("user:b", { keybindings: "keys.json" }, { keybindings: { "ctrl+g": "help", "ctrl+u": "palette" } }),
    ])
    expect(result.keybindings.map((entry) => entry.spec).sort()).toEqual(["ctrl+g", "ctrl+u", "ctrl+y"])
    expect(result.conflicts.join("\n")).toMatch(/ctrl\+g.*user:b wins over user:a/)
  })

  test("a project package is ignored without trust", () => {
    const result = resolve([pkg("project:p", { tuiProfile: { username: "P" } }, { scope: "project" })], { projectTrusted: false })
    expect(result.overlay).toEqual({})
  })

  test("the user's kept key is not in what is applied", () => {
    const first = resolve([pkg("user:a", { tuiProfile: { username: "A", homeLayout: "split" } })])
    const kept = resolve([pkg("user:a", { tuiProfile: { username: "A", homeLayout: "split" } })], { state: { user: { kept: ["homeLayout"], keptFor: first.signature }, project: { kept: [] } } as never })
    expect(Object.keys(first.applied).sort()).toEqual(["homeLayout", "username"])
    expect(Object.keys(kept.applied)).toEqual(["username"])
  })

  test("a saved slot applies the user's value over its owners' package, and only under those owners", async () => {
    const { activationStateJson, parseActivationState, saveLook } = await import("@mendcode/protocol/wire")
    const a = [pkg("user:a", { tuiProfile: { username: "A", homeLayout: "split" } })]
    const b = [pkg("user:b", { tuiProfile: { username: "B", homeLayout: "split" } })]
    const signatureA = resolve(a).signature
    const state = parseActivationState(JSON.parse(activationStateJson(saveLook({ kept: [] }, signatureA, { kept: ["homeLayout"], values: { homeLayout: "centered" } }))))
    const underA = resolve(a, { state: { user: state, project: { kept: [] } } as never })
    expect(underA.applied).toEqual({ username: "A", homeLayout: "centered" })
    expect(underA.rows.find((row) => row.key === "homeLayout")).toMatchObject({ kept: true, mine: "centered" })
    const underB = resolve(b, { state: { user: state, project: { kept: [] } } as never })
    expect(underB.applied).toEqual({ username: "B", homeLayout: "split" })
    expect(underB.kept).toEqual([])
  })

  test("an older activation.json (kept/keptFor, no values) still keeps its keys, with the stored profile's value", async () => {
    const { parseActivationState } = await import("@mendcode/protocol/wire")
    const a = [pkg("user:a", { tuiProfile: { username: "A", homeLayout: "split" } })]
    const state = parseActivationState({ version: 1, keptFor: resolve(a).signature, kept: ["homeLayout"] })
    const result = resolve(a, { state: { user: state, project: { kept: [] } } as never })
    expect(result.applied).toEqual({ username: "A" })
    expect(result.keptValues).toEqual({})
  })

  test("saving a slot keeps the other owners' slots, drops an empty one and caps how many are kept", async () => {
    const { saveLook } = await import("@mendcode/protocol/wire")
    let state = saveLook({ kept: [] }, "one", { kept: ["theme"], values: { theme: "mend" } })
    state = saveLook(state, "two", { kept: ["theme"], values: { theme: "dark" } })
    expect(Object.keys(state.saved!)).toEqual(["one", "two"])
    expect(state).toMatchObject({ keptFor: "two", kept: ["theme"] })
    state = saveLook(state, "one", { kept: [], values: {} })
    expect(Object.keys(state.saved!)).toEqual(["two"])
    for (let i = 0; i < 40; i++) state = saveLook(state, `s${i}`, { kept: ["theme"], values: { theme: "x" } })
    expect(Object.keys(state.saved!)).toHaveLength(32)
    expect(state.saved!.two).toBeUndefined()
  })
})

describe("the exporter covers every kind in the table", () => {
  test("one file per path the table lists lands in the exported package", async () => {
    const { authorLocalPackage, LOCAL_PACKAGE_DIR } = await import("../src")
    const directory = temp("life-export-")
    const base = path.join(directory, ".mendcode")
    const expected: string[] = []
    for (const kind of PACKAGE_KINDS) {
      if (!("selection" in kind) || !kind.selection) continue
      for (const entry of [...kind.paths, ...("exportPaths" in kind ? kind.exportPaths : [])]) {
        const file = /\.[a-z]+$/i.test(entry) ? entry : path.join(entry, "sample.txt")
        // MCP files are parsed (credentials are refused), so they must be JSON even under mcp/.
        write(path.join(base, file), file.endsWith(".json") || entry === "mcp" ? "{}" : "sample")
        expected.push(file)
      }
    }
    expect(expected.length).toBeGreaterThan(25)
    const report = authorLocalPackage({ directory, action: "create", metadata: { id: "everything" } as never, include: ["all"] })
    const exported = path.join(directory, report.packagePath)
    expect(path.basename(report.packagePath)).toBe(LOCAL_PACKAGE_DIR)
    expect(expected.filter((file) => !existsSync(path.join(exported, file)))).toEqual([])
  })
})
