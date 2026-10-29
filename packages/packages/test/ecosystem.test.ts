import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createPackageRegistry, extensionLayers, installPackage, isPinnedSpec, layerAllows, listPackageResources, listPackages, MANIFEST_FILE, parsePackageSource, readLayerThemes, readLayerAgents, setResourceEnabled, type PackageFetchers } from "../src"

const cleanups: string[] = []
const servers: Array<{ stop(force?: boolean): unknown }> = []
afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true })
  for (const server of servers.splice(0)) server.stop(true)
})
function temp(prefix = "pkg-eco-") {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  cleanups.push(dir)
  return dir
}
function write(file: string, text: string) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}
const roots = () => ({ userDir: temp(), directory: temp() })

/** An npm-style tarball (`package/…`) built with the system tar; `prefix` and `link` let a test break the rules. */
function tarball(files: Record<string, string>, options: { prefix?: string; link?: [string, string] } = {}) {
  const root = temp()
  const prefix = options.prefix ?? "package"
  for (const [name, text] of Object.entries(files)) write(path.join(root, prefix, name), text)
  if (options.link) symlinkSync(options.link[1], path.join(root, prefix, options.link[0]))
  const out = path.join(temp(), "pkg.tgz")
  expect(Bun.spawnSync(["tar", "-czf", out, "-C", root, prefix]).exitCode).toBe(0)
  return out
}
const digest = (file: string) => `sha512-${createHash("sha512").update(readFileSync(file)).digest("base64")}`
const manifest = (name = "npmpack", version = "2.0.0") => JSON.stringify({ name, version, description: `${name} from the registry` })
const fakeNpm = (tgz: string, calls: string[] = []): PackageFetchers => ({ npmPack: async ({ name, version }) => (calls.push(`${name}@${version}`), tgz) })

describe("npm and commit pinning", () => {
  test("npm specs need an exact version; ranges, tags and bad digests are refused", () => {
    expect(parsePackageSource("npm:acme@1.2.3", "/")).toEqual({ kind: "npm", name: "acme", version: "1.2.3" })
    expect(parsePackageSource("npm:@scope/acme@1.2.3-beta.1", "/")).toEqual({ kind: "npm", name: "@scope/acme", version: "1.2.3-beta.1" })
    for (const spec of ["npm:acme", "npm:acme@^1.2.3", "npm:acme@latest", "npm:acme@1.2", "npm:@scope/acme", "npm:BAD NAME@1.0.0", "npm:../x@1.0.0"]) expect(() => parsePackageSource(spec, "/")).toThrow("[PACKAGES]")
    expect(() => parsePackageSource("npm:acme@1.0.0#md5-zzz", "/")).toThrow("sha512")
    expect(() => parsePackageSource("git:--upload-pack=touch", "/")).toThrow("dash")
  })

  test("pinned means an exact npm version or a full git commit; branches, tags and folders are not", () => {
    const commit = "0123456789abcdef0123456789abcdef01234567"
    expect(isPinnedSpec("npm:acme@1.0.0")).toBe(true)
    expect(isPinnedSpec(`github:acme/tools#${commit}`)).toBe(true)
    expect(isPinnedSpec("github:acme/tools#main")).toBe(false)
    expect(isPinnedSpec("github:acme/tools")).toBe(false)
    expect(isPinnedSpec("./folder")).toBe(false)
  })

  test("an npm package is downloaded as a tarball only, audited, recorded with its sha512 and marked pinned", async () => {
    const { userDir, directory } = roots()
    const tgz = tarball({ [MANIFEST_FILE]: manifest(), "commands/hello.md": "Hello $ARGUMENTS", "package.json": "{\"scripts\":{\"postinstall\":\"echo never\"}}" })
    const calls: string[] = []
    const result = await installPackage({ spec: `npm:npmpack@2.0.0#${digest(tgz)}`, scope: "user", userDir, directory, fetchers: fakeNpm(tgz, calls), now: () => 7 })
    expect(calls).toEqual(["npmpack@2.0.0"])
    expect(result).toMatchObject({ name: "npmpack", pinned: true, integrity: digest(tgz), contents: { commands: 1 } })
    expect(listPackages({ userDir, directory })[0]!.install).toEqual({ source: "npm:npmpack@2.0.0", integrity: digest(tgz), pinned: true, installedAt: 7 })
    expect(readdirNames(path.join(userDir, "packages"))).toEqual(["npmpack"])
  })

  test("a digest that differs from the pinned one, links, escaping entries and secrets all leave nothing installed", async () => {
    const { userDir, directory } = roots()
    const good = tarball({ [MANIFEST_FILE]: manifest() })
    await expect(installPackage({ spec: `npm:npmpack@2.0.0#sha512-${"A".repeat(86)}==`, scope: "user", userDir, directory, fetchers: fakeNpm(good) })).rejects.toThrow("digest differs")
    await expect(installPackage({ spec: "npm:npmpack@2.0.0", scope: "user", userDir, directory, fetchers: fakeNpm(tarball({ [MANIFEST_FILE]: manifest() }, { link: ["evil", "/etc/passwd"] })) })).rejects.toThrow("links")
    await expect(installPackage({ spec: "npm:npmpack@2.0.0", scope: "user", userDir, directory, fetchers: fakeNpm(tarball({ [MANIFEST_FILE]: manifest() }, { prefix: "other" })) })).rejects.toThrow("outside package/")
    await expect(installPackage({ spec: "npm:npmpack@2.0.0", scope: "user", userDir, directory, fetchers: fakeNpm(tarball({ [MANIFEST_FILE]: manifest(), ".env": "TOKEN=1" })) })).rejects.toThrow("secret")
    await expect(installPackage({ spec: "npm:npmpack@2.0.0", scope: "user", userDir, directory, fetchers: fakeNpm(tarball({ [MANIFEST_FILE]: manifest("other", "2.0.0") })), expected: { name: "npmpack", version: "2.0.0" } })).rejects.toThrow("differs")
    expect(listPackages({ userDir, directory })).toEqual([])
    expect(readdirNames(path.join(userDir, "packages")).filter((entry) => entry.startsWith("."))).toEqual([])
  })

  test("a git source pinned to a full commit is fetched by hash and checked", async () => {
    const { userDir, directory } = roots()
    const repo = temp("pkg-eco-git-")
    write(path.join(repo, MANIFEST_FILE), manifest("gitpin", "1.0.0"))
    const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } })
    git("init", "-q", "-b", "main")
    git("add", ".")
    git("commit", "-q", "-m", "one")
    const first = new TextDecoder().decode(git("rev-parse", "HEAD").stdout).trim()
    write(path.join(repo, "commands", "later.md"), "later")
    git("add", ".")
    git("commit", "-q", "-m", "two")
    const result = await installPackage({ spec: `git:file://${repo}#${first}`, scope: "user", userDir, directory })
    expect(result).toMatchObject({ name: "gitpin", commit: first, pinned: true, contents: { commands: 0 } })
    expect(existsSync(path.join(result.dir, ".git"))).toBe(false)
    await expect(installPackage({ spec: `git:file://${repo}#${"0".repeat(40)}`, scope: "user", userDir, directory, replace: true })).rejects.toThrow("git fetch failed")
    await expect(installPackage({ spec: `git:file://${repo}#${first}`, scope: "user", userDir, directory, replace: true, expected: { name: "gitpin", version: "1.0.0", commit: "1".repeat(40) } })).rejects.toThrow("pinned commit")
  })
})

function readdirNames(dir: string) {
  return existsSync(dir) ? readdirSync(dir).sort() : []
}

describe("remote catalogs", () => {
  function remote(index: unknown, extra: PackageFetchers = {}) {
    const { userDir, directory } = roots()
    const fetched: string[] = []
    const fetchers: PackageFetchers = { text: async (url) => (fetched.push(url), JSON.stringify(index)), ...extra }
    return { userDir, directory, fetched, fetchers, registry: createPackageRegistry({ userDir, directory, fetchers }) }
  }
  const tgz = () => tarball({ [MANIFEST_FILE]: manifest("npmpack", "2.0.0"), "skills/deploy/SKILL.md": "---\nname: deploy\ndescription: ship\n---\nSteps" })

  test("a remote source is off until enabled, and nothing is fetched until refresh", async () => {
    const f = remote({ version: 0, packs: [] })
    f.registry.addSource("hub", "https://hub.example/index.json")
    expect(f.registry.sources().find((source) => source.id === "hub")).toMatchObject({ remote: true, enabled: false })
    expect(f.registry.search().entries).toEqual([])
    await expect(f.registry.refresh("hub")).rejects.toThrow("disabled")
    f.registry.addSource("hub", "https://hub.example/index.json", true)
    expect(f.registry.search().issues.join(" ")).toContain("has not been fetched")
    expect(f.fetched).toEqual([])
    await expect(f.registry.refresh("local")).rejects.toThrow("local source")
  })

  test("refresh stores a validated index; search and preview then work offline and report pinning problems", async () => {
    const archive = tgz()
    const commit = "0123456789abcdef0123456789abcdef01234567"
    const f = remote({ version: 0, packs: [
      { id: "npmpack", version: "2.0.0", description: "From npm", tags: ["review"], source: { url: "npm:npmpack@2.0.0", integrity: digest(archive) } },
      { id: "gitpack", version: "1.0.0", source: { url: `github:acme/tools#${commit}` } },
      { id: "floating", version: "1.0.0", source: { url: "github:acme/tools#main" } },
    ] })
    f.registry.addSource("hub", "https://hub.example/index.json", true)
    expect(await f.registry.refresh("hub")).toMatchObject({ entries: 3, sources: [{ id: "local" }, { id: "hub", remote: true }] })
    expect(f.fetched).toEqual(["https://hub.example/index.json"])
    const again = createPackageRegistry({ userDir: f.userDir, directory: f.directory })
    const entries = again.search("", "hub").entries
    expect(entries.map((entry) => [entry.name, entry.remote, entry.problem === undefined])).toEqual([["npmpack", true, true], ["gitpack", true, true], ["floating", true, false]])
    expect(entries[0]!.location).toBe(`npm:npmpack@2.0.0#${digest(archive)}`)
    expect(entries[2]!.problem).toContain("not pinned")
    expect(again.preview("npmpack", "hub", "user")).toMatchObject({ action: "install", problems: [] })
    expect(again.preview("floating", "hub", "user").problems[0]).toContain("not pinned")
    expect(f.fetched).toHaveLength(1)
    expect(existsSync(path.join(f.directory, ".mendcode", "packages"))).toBe(false)
    again.removeSource("hub")
    expect(existsSync(path.join(f.userDir, "package-cache", "hub.json"))).toBe(false)
  })

  test("installing a remote entry fetches the pinned tarball through the audited installer; unpinned entries are refused", async () => {
    const archive = tgz()
    const calls: string[] = []
    const f = remote({ version: 0, packs: [
      { id: "npmpack", version: "2.0.0", source: { url: "npm:npmpack@2.0.0", integrity: digest(archive) } },
      { id: "floating", version: "1.0.0", source: { url: "github:acme/tools#main" } },
    ] }, fakeNpm(archive, calls))
    f.registry.addSource("hub", "https://hub.example/index.json", true)
    await f.registry.refresh("hub")
    await expect(f.registry.install("floating", "hub", "user")).rejects.toThrow("not pinned")
    expect(calls).toEqual([])
    const installed = await f.registry.install("npmpack", "hub", "project")
    expect(calls).toEqual(["npmpack@2.0.0"])
    expect(installed).toMatchObject({ name: "npmpack", pinned: true, integrity: digest(archive), contents: { skills: 1 } })
    expect(listPackages(f)[0]).toMatchObject({ key: "project:npmpack", install: { source: "npm:npmpack@2.0.0" } })
  })

  test("a catalog digest that does not match the tarball refuses the install", async () => {
    const f = remote({ version: 0, packs: [{ id: "npmpack", version: "2.0.0", source: { url: "npm:npmpack@2.0.0", integrity: `sha512-${"B".repeat(86)}==` } }] }, fakeNpm(tgz()))
    f.registry.addSource("hub", "https://hub.example/index.json", true)
    await f.registry.refresh("hub")
    await expect(f.registry.install("npmpack", "hub", "user")).rejects.toThrow("digest differs")
    expect(listPackages(f)).toEqual([])
  })

  test("malformed, duplicate and folder-only remote indexes are rejected without replacing the cache", async () => {
    const good = { version: 0, packs: [{ id: "npmpack", version: "2.0.0", source: { url: "npm:npmpack@2.0.0" } }] }
    let body = JSON.stringify(good)
    const { userDir, directory } = roots()
    const registry = createPackageRegistry({ userDir, directory, fetchers: { text: async () => body } })
    registry.addSource("hub", "https://hub.example/index.json", true)
    await registry.refresh("hub")
    for (const bad of ["not json", JSON.stringify({ version: 1, packs: [] }), JSON.stringify({ version: 0, packs: [good.packs[0], good.packs[0]] }), JSON.stringify({ version: 0, packs: [{ id: "local", version: "1" }] }), "x".repeat(1024 * 1024 + 1)]) {
      body = bad
      await expect(registry.refresh("hub")).rejects.toThrow("[PACKAGES]")
    }
    expect(registry.search("", "hub").entries.map((entry) => entry.name)).toEqual(["npmpack"])
  })

  test("the default fetch reads a loopback catalog, refuses redirects, and caps the response", async () => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/index.json") return Response.json({ version: 0, packs: [{ id: "npmpack", version: "2.0.0", source: { url: "npm:npmpack@2.0.0" } }] })
      if (url.pathname === "/redirect") return Response.redirect("http://127.0.0.1:1/x", 302)
      return new Response("x".repeat(1024 * 1024 + 10))
    } })
    servers.push(server)
    const { userDir, directory } = roots()
    const registry = createPackageRegistry({ userDir, directory })
    for (const route of ["redirect", "huge"]) {
      registry.addSource(route, `http://127.0.0.1:${server.port}/${route}`, true)
      await expect(registry.refresh(route)).rejects.toThrow()
    }
    registry.addSource("loop", `http://127.0.0.1:${server.port}/index.json`, true)
    expect(await registry.refresh("loop")).toMatchObject({ entries: 1 })
    expect(registry.search("", "loop").entries[0]).toMatchObject({ name: "npmpack", remote: true })
  })

  test("a local index may point at pinned npm or git sources too", () => {
    const { userDir, directory } = roots()
    const source = temp()
    write(path.join(source, "marketplace-index.json"), JSON.stringify({ version: 0, packs: [{ id: "npmpack", version: "2.0.0", source: { url: "npm:npmpack@2.0.0" } }] }))
    const registry = createPackageRegistry({ userDir, directory })
    registry.addSource("team", source, true)
    expect(registry.search("", "team").entries[0]).toMatchObject({ name: "npmpack", remote: true, location: "npm:npmpack@2.0.0" })
  })
})

describe("per-resource switches", () => {
  function installed() {
    const { userDir, directory } = roots()
    const pkg = path.join(userDir, "packages", "kit")
    write(path.join(pkg, MANIFEST_FILE), manifest("kit", "1.0.0"))
    write(path.join(pkg, "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: ship\n---\nSteps")
    write(path.join(pkg, "commands", "review.md"), "review")
    write(path.join(pkg, "commands", "team", "ship.md"), "ship")
    write(path.join(pkg, "agents", "helper.md"), "---\ndescription: helps\n---\nHelp")
    write(path.join(pkg, "themes", "night.json"), "{}")
    write(path.join(pkg, "tools", "hello.json"), "{}")
    write(path.join(pkg, "extensions", "ext.ts"), "export default {}")
    return { userDir, directory }
  }

  test("every kind is listed with what loaders call it, all on by default", () => {
    const roots = installed()
    const [kit] = listPackageResources(roots)
    expect(kit!.resources.map((resource) => resource.id)).toEqual(["skills/deploy", "commands/review", "commands/team:ship", "agents/helper", "themes/night", "tools/hello", "extensions/ext"])
    expect(kit!.resources.every((resource) => resource.enabled)).toBe(true)
  })

  test("switching stores a key, rejects unknown packages or resources, and turning back on drops it", () => {
    const roots = installed()
    const off = setResourceEnabled({ ...roots, disabledResources: [], key: "user:kit", resource: "commands/review", enabled: false })
    expect(off).toEqual(["user:kit/commands/review"])
    expect(listPackageResources({ ...roots, disabledResources: off })[0]!.resources.filter((resource) => !resource.enabled).map((resource) => resource.id)).toEqual(["commands/review"])
    expect(setResourceEnabled({ ...roots, disabledResources: off, key: "user:kit", resource: "commands/review", enabled: true })).toEqual([])
    expect(() => setResourceEnabled({ ...roots, disabledResources: [], key: "user:nope", resource: "x", enabled: false })).toThrow("not installed")
    expect(() => setResourceEnabled({ ...roots, disabledResources: [], key: "user:kit", resource: "skills/nope", enabled: false })).toThrow("no resource")
  })

  test("layers carry the switches of their package only; theme and agent loaders skip switched-off files", () => {
    const roots = installed()
    const layers = extensionLayers({ ...roots, disabledResources: ["user:kit/themes/night", "user:kit/agents/helper", "project:other/themes/night"] })
    const pkg = layers.find((layer) => layer.pkg === "kit")!
    expect(pkg.off).toEqual(["themes/night", "agents/helper"])
    expect(layers.filter((layer) => layer !== pkg).every((layer) => layer.off === undefined)).toBe(true)
    expect(layerAllows(pkg, "themes", "night")).toBe(false)
    expect(layerAllows(pkg, "themes", "day")).toBe(true)
    expect(readLayerThemes(layers).map((theme) => theme.name)).toEqual([])
    expect(readLayerAgents(layers, { projectTrusted: true }).agents).toEqual([])
    expect(readLayerThemes(extensionLayers(roots)).map((theme) => theme.name)).toEqual(["night"])
    expect(readLayerAgents(extensionLayers(roots), { projectTrusted: true }).agents.map((agent) => agent.name)).toEqual(["helper"])
  })
})
