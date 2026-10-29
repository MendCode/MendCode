import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { extensionLayers, INSTALL_RECORD_FILE, installPackage, listPackages, MANIFEST_FILE, parsePackageSource, readLayerThemes, removePackage } from "../src"

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

/** A package source folder with a manifest, one tool, one skill and one command. */
function source(name = "acme", extra: Record<string, string> = {}) {
  const dir = temp("pkg-src-")
  write(path.join(dir, MANIFEST_FILE), JSON.stringify({ name, version: "1.0.0", description: "Acme helpers" }))
  write(path.join(dir, "tools", "hello.json"), JSON.stringify({ description: "say hi", command: ["echo", "hi"] }))
  write(path.join(dir, "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: ship it\n---\nSteps")
  write(path.join(dir, "commands", "review.md"), "Review $ARGUMENTS")
  for (const [file, text] of Object.entries(extra)) write(path.join(dir, file), text)
  return dir
}

function roots() {
  return { userDir: temp("pkg-user-"), directory: temp("pkg-proj-") }
}

describe("extension layers", () => {
  test("lowest precedence first: user packages, user, project packages, project; disabled packages are left out", () => {
    const { userDir, directory } = roots()
    for (const name of ["b-pkg", "a-pkg"]) mkdirSync(path.join(userDir, "packages", name), { recursive: true })
    mkdirSync(path.join(directory, ".mendcode", "packages", "team"), { recursive: true })
    mkdirSync(path.join(userDir, "packages", ".staging-1"), { recursive: true })
    const layers = extensionLayers({ userDir, directory, disabled: ["user:b-pkg"] })
    expect(layers.map((l) => [l.source, l.pkg ?? "-"])).toEqual([
      ["user", "a-pkg"],
      ["user", "-"],
      ["project", "team"],
      ["project", "-"],
    ])
    expect(layers[3]!.dir).toBe(path.join(directory, ".mendcode"))
  })
})

describe("package sources", () => {
  test("github, git and URL specs become git sources with an optional ref; anything else must be a folder", () => {
    expect(parsePackageSource("github:acme/tools#v1", "/")).toEqual({ kind: "git", url: "https://github.com/acme/tools.git", ref: "v1" })
    expect(parsePackageSource("git:ssh://host/x.git", "/")).toEqual({ kind: "git", url: "ssh://host/x.git" })
    expect(parsePackageSource("git@github.com:acme/tools.git", "/")).toEqual({ kind: "git", url: "git@github.com:acme/tools.git" })
    const dir = source()
    expect(parsePackageSource(path.basename(dir), path.dirname(dir))).toEqual({ kind: "local", dir })
    expect(() => parsePackageSource("./missing", "/tmp")).toThrow("no folder")
    expect(() => parsePackageSource("github:not-a-repo", "/")).toThrow("github:owner/repo")
  })
})

describe("install, list, remove", () => {
  test("a local folder installs under the manifest's name with an install record and counted contents", async () => {
    const { userDir, directory } = roots()
    const from = source("acme", { "node_modules/x/index.js": "x", ".git/HEAD": "ref" })
    const result = await installPackage({ spec: from, scope: "user", userDir, directory, now: () => 42 })
    expect(result).toMatchObject({ name: "acme", source: "user", replaced: false, contents: { tools: 1, skills: 1, commands: 1, themes: 0, mcp: false } })
    expect(existsSync(path.join(userDir, "packages", "acme", "node_modules"))).toBe(false)
    expect(existsSync(path.join(userDir, "packages", "acme", ".git"))).toBe(false)
    expect(JSON.parse(readFileSync(path.join(userDir, "packages", "acme", INSTALL_RECORD_FILE), "utf8"))).toEqual({ source: from, installedAt: 42 })
    const [info] = listPackages({ userDir, directory, disabled: ["user:acme"] })
    expect(info).toMatchObject({ name: "acme", key: "user:acme", enabled: false, manifest: { version: "1.0.0" }, install: { installedAt: 42 } })
    expect(info!.problem).toBeUndefined()
  })

  test("installing over an existing package needs replace, and then swaps it in", async () => {
    const { userDir, directory } = roots()
    await installPackage({ spec: source(), scope: "project", userDir, directory })
    await expect(installPackage({ spec: source(), scope: "project", userDir, directory })).rejects.toThrow("already installed")
    const newer = source("acme", { "themes/night.json": "{}" })
    const result = await installPackage({ spec: newer, scope: "project", userDir, directory, replace: true })
    expect(result).toMatchObject({ replaced: true, contents: { themes: 1 } })
    expect(listPackages({ userDir, directory }).map((p) => p.key)).toEqual(["project:acme"])
  })

  test("secrets, links, a missing or invalid manifest refuse the install and leave nothing behind", async () => {
    const { userDir, directory } = roots()
    const secret = source("acme", { ".env": "TOKEN=x", "keys/deploy.pem": "k", ".env.example": "TOKEN=" })
    await expect(installPackage({ spec: secret, scope: "user", userDir, directory })).rejects.toThrow(/\.env: looks like a secret[\s\S]*deploy\.pem/)
    const linked = source()
    symlinkSync("/etc/hosts", path.join(linked, "hosts"))
    await expect(installPackage({ spec: linked, scope: "user", userDir, directory })).rejects.toThrow("links are not allowed")
    const bare = temp("pkg-bare-")
    await expect(installPackage({ spec: bare, scope: "user", userDir, directory })).rejects.toThrow(`no ${MANIFEST_FILE}`)
    const badName = source("Bad Name")
    await expect(installPackage({ spec: badName, scope: "user", userDir, directory })).rejects.toThrow("invalid mendcode-package.json")
    expect(listPackages({ userDir, directory })).toEqual([])
    expect(existsSync(path.join(userDir, "packages")) ? readdirSync(path.join(userDir, "packages")) : []).toEqual([])
  })

  test("a git source is cloned at its ref, recorded with its commit, and stripped of .git", async () => {
    const { userDir, directory } = roots()
    const repo = source("gitpkg")
    const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } })
    git("init", "-q", "-b", "main")
    git("add", ".")
    git("commit", "-q", "-m", "init")
    git("tag", "v1")
    const commit = new TextDecoder().decode(git("rev-parse", "HEAD").stdout).trim()
    const result = await installPackage({ spec: `git:file://${repo}#v1`, scope: "user", userDir, directory })
    expect(result).toMatchObject({ name: "gitpkg", commit })
    expect(existsSync(path.join(result.dir, ".git"))).toBe(false)
    expect(listPackages({ userDir, directory })[0]!.install).toMatchObject({ source: `file://${repo}#v1`, commit })
    await expect(installPackage({ spec: `git:file://${repo}#nope`, scope: "user", userDir, directory, replace: true })).rejects.toThrow("git clone failed")
  })

  test("remove deletes only an installed package folder", async () => {
    const { userDir, directory } = roots()
    await installPackage({ spec: source(), scope: "user", userDir, directory })
    expect(removePackage({ name: "../packages", scope: "user", userDir, directory })).toBe(false)
    expect(removePackage({ name: "acme", scope: "user", userDir, directory })).toBe(true)
    expect(removePackage({ name: "acme", scope: "user", userDir, directory })).toBe(false)
    expect(listPackages({ userDir, directory })).toEqual([])
  })

  test("a folder whose manifest names another package is listed with the mismatch", () => {
    const { userDir, directory } = roots()
    write(path.join(userDir, "packages", "one", MANIFEST_FILE), JSON.stringify({ name: "two", version: "1", description: "d" }))
    expect(listPackages({ userDir, directory })[0]!.problem).toContain('says "two"')
  })
})

describe("theme files", () => {
  test("every layer's themes/*.json is read, a later layer replaces the same name, and bad files carry a problem", () => {
    const { userDir, directory } = roots()
    const pkg = path.join(userDir, "packages", "acme")
    write(path.join(pkg, "themes", "dusk.json"), JSON.stringify({ background: "#000000", colors: { primary: "#111111" } }))
    write(path.join(pkg, "themes", "noon.json"), "{}")
    write(path.join(directory, ".mendcode", "themes", "dusk.json"), JSON.stringify({ label: "Project dusk" }))
    write(path.join(directory, ".mendcode", "themes", "broken.json"), "{ nope")
    write(path.join(directory, ".mendcode", "themes", "Bad Name.json"), "{}")
    const themes = readLayerThemes(extensionLayers({ userDir, directory }))
    expect(themes.map((t) => [t.name, t.source, t.pkg ?? "-"])).toEqual([
      ["noon", "user", "acme"],
      ["Bad Name", "project", "-"],
      ["broken", "project", "-"],
      ["dusk", "project", "-"],
    ])
    expect(themes.find((t) => t.name === "dusk")!.json).toEqual({ label: "Project dusk" })
    expect(themes.find((t) => t.name === "broken")!.problem).toStartWith("invalid JSON")
    expect(themes.find((t) => t.name === "Bad Name")!.problem).toContain("theme file names")
  })
})

describe("packages that ship extensions", () => {
  const extension = (name: string) => `export default { name: ${JSON.stringify(name)}, daemon() {} }\n`

  test("an extensions/ folder installs whole, is counted, and its package layer is where the loader looks", async () => {
    const { userDir, directory } = roots()
    const from = source("acme", {
      "extensions/guard.ts": extension("guard"),
      "extensions/audit/index.ts": extension("audit"),
      "extensions/audit/helper.ts": "export const x = 1\n",
      "extensions/types.d.ts": "export {}\n",
      "extensions/.hidden.ts": "ignored",
      "extensions/notes.md": "not an extension",
    })
    write(path.join(from, MANIFEST_FILE), JSON.stringify({ name: "acme", version: "1.0.0", description: "Acme helpers", extensions: true }))
    const result = await installPackage({ spec: from, scope: "user", userDir, directory })
    expect(result.contents).toMatchObject({ tools: 1, extensions: 2 })
    expect(result.manifest.extensions).toBe(true)
    const installed = path.join(userDir, "packages", "acme", "extensions")
    expect(readFileSync(path.join(installed, "guard.ts"), "utf8")).toBe(extension("guard"))
    expect(readFileSync(path.join(installed, "audit", "helper.ts"), "utf8")).toBe("export const x = 1\n")
    expect(listPackages({ userDir, directory })[0]).toMatchObject({ key: "user:acme", contents: { extensions: 2 }, manifest: { extensions: true } })
    expect(extensionLayers({ userDir, directory }).find((layer) => layer.pkg === "acme")).toMatchObject({ dir: path.join(userDir, "packages", "acme"), source: "user" })
  })

  test("a package without an extensions declaration still installs its extensions/, and one without the folder counts zero", async () => {
    const { userDir, directory } = roots()
    const result = await installPackage({ spec: source("quiet", { "extensions/a.js": "export default { name: 'a' }\n" }), scope: "project", userDir, directory })
    expect(result.contents.extensions).toBe(1)
    const plain = await installPackage({ spec: source("plain"), scope: "user", userDir, directory })
    expect(plain.contents.extensions).toBe(0)
  })

  test("links, secret files and oversize trees under extensions/ are refused like anywhere else", async () => {
    const { userDir, directory } = roots()
    const linked = source("acme", { "extensions/guard.ts": extension("guard") })
    symlinkSync("/etc/hosts", path.join(linked, "extensions", "hosts.ts"))
    await expect(installPackage({ spec: linked, scope: "user", userDir, directory })).rejects.toThrow("extensions/hosts.ts: links are not allowed")
    const secret = source("acme", { "extensions/guard.ts": extension("guard"), "extensions/.env": "TOKEN=x", "extensions/keys/signing.pem": "k" })
    await expect(installPackage({ spec: secret, scope: "user", userDir, directory })).rejects.toThrow(/extensions\/\.env: looks like a secret[\s\S]*signing\.pem/)
    const many = source("acme", Object.fromEntries(Array.from({ length: 2_001 }, (_, i) => [`extensions/e${i}.ts`, "x"])))
    await expect(installPackage({ spec: many, scope: "user", userDir, directory })).rejects.toThrow(/files; a package holds at most/)
    expect(listPackages({ userDir, directory })).toEqual([])
    expect(existsSync(path.join(userDir, "packages")) ? readdirSync(path.join(userDir, "packages")) : []).toEqual([])
  })

  test("the manifest must tell the truth about shipping code", async () => {
    const { userDir, directory } = roots()
    const declare = (extensions: boolean, files: Record<string, string>) => {
      const from = source("acme", files)
      write(path.join(from, MANIFEST_FILE), JSON.stringify({ name: "acme", version: "1.0.0", description: "Acme helpers", extensions }))
      return from
    }
    await expect(installPackage({ spec: declare(true, {}), scope: "user", userDir, directory })).rejects.toThrow("declares extensions but extensions/ has no")
    await expect(installPackage({ spec: declare(false, { "extensions/guard.ts": extension("guard") }), scope: "user", userDir, directory })).rejects.toThrow("declares no extensions but extensions/ holds 1")
    expect(listPackages({ userDir, directory })).toEqual([])
    expect((await installPackage({ spec: declare(false, {}), scope: "user", userDir, directory })).contents.extensions).toBe(0)
  })
})
