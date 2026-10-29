import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs"
import path from "node:path"
import type { UpgradeError } from "../src/errors"
import { binPaths, installBinary, resolveDataDir, rollbackBinary } from "../src/install"
import { nodeFs } from "../src/io"
import { readState } from "../src/state"
import { resolveRepo, runUpgrade, type UpgradeRequest } from "../src/upgrade"
import { DARWIN_ARM64, fakePorts, LINUX_X64, release, REPO, tempDir } from "./helpers"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function sandbox() {
  const temp = tempDir()
  cleanups.push(temp.cleanup)
  const dataDir = path.join(temp.dir, "data")
  const home = path.join(temp.dir, "home")
  const request = (overrides: Partial<UpgradeRequest> = {}): UpgradeRequest => ({ dataDir, home, repo: REPO, check: false, force: false, rollback: false, currentVersion: "1.0.0", platform: LINUX_X64, ...overrides })
  return { dataDir, home, request, paths: binPaths(dataDir), temp }
}

const linux = (content: string, version = "1.1.0") => ({ [`mendcode-${version}-linux-x64`]: content })
const text = (file: string) => readFileSync(file, "utf8")

async function failure(run: Promise<unknown>) {
  try {
    await run
  } catch (error) {
    return error as UpgradeError
  }
  throw new Error("expected a failure")
}

describe("install", () => {
  test("installs an executable at <dataDir>/bin/mendcode and leaves no staging file", async () => {
    const box = sandbox()
    const { ports } = fakePorts([release({ tag: "v1.1.0", binaries: linux("v1.1.0 binary") })])
    const result = await runUpgrade(box.request(), ports)
    expect(result).toMatchObject({ status: "installed", latest: "v1.1.0", asset: "mendcode-1.1.0-linux-x64", downgrade: false, installedTo: box.paths.current })
    expect(text(box.paths.current)).toBe("v1.1.0 binary")
    expect(statSync(box.paths.current).mode & 0o777).toBe(0o755)
    expect(existsSync(box.paths.next)).toBe(false)
    expect(existsSync(box.paths.prev)).toBe(false)
  })

  test("keeps the previous binary as .prev, replaces it again on the next upgrade, and writes nothing outside the data directory", async () => {
    const box = sandbox()
    await runUpgrade(box.request(), fakePorts([release({ tag: "v1.1.0", binaries: linux("one") })]).ports)
    await runUpgrade(box.request({ currentVersion: "1.1.0" }), fakePorts([release({ tag: "v1.2.0", binaries: linux("two", "1.2.0") })]).ports)
    expect(text(box.paths.current)).toBe("two")
    expect(text(box.paths.prev)).toBe("one")
    expect(statSync(box.paths.prev).mode & 0o777).toBe(0o755)
    expect(readdirSync(box.temp.dir).sort()).toEqual(["data"])
    expect(readdirSync(box.dataDir).sort()).toEqual(["bin", "upgrade-recovery.json", "upgrade.json"])
    expect(readdirSync(box.paths.dir).sort()).toEqual(["mendcode-next", "mendcode-next.prev"])
  })

  test("a failed rename leaves the installed binary untouched and removes the staged file", async () => {
    const box = sandbox()
    await installBinary({ fs: nodeFs, dataDir: box.dataDir, bytes: new TextEncoder().encode("good") })
    const failing = { ...nodeFs, rename: async () => Promise.reject(new Error("disk full")) }
    const error = await failure(installBinary({ fs: failing, dataDir: box.dataDir, bytes: new TextEncoder().encode("new") }))
    expect(error.code).toBe("io")
    expect(text(box.paths.current)).toBe("good")
    expect(existsSync(box.paths.next)).toBe(false)
  })

  test("refuses a data directory that is, or is inside, a legacy MendCode directory", () => {
    const home = "/home/someone"
    for (const dir of ["/home/someone/.mendcode", "/home/someone/.mendcode/x", "/home/someone/.local/share/mendcode", "/home/someone/.local/share/mendcode/bin"]) {
      expect(() => resolveDataDir({ dataDir: dir, home })).toThrow("legacy MendCode")
    }
    expect(resolveDataDir({ dataDir: "/home/someone/.mendcode-v2", home })).toBe("/home/someone/.mendcode-v2")
  })

  test("never writes when the data directory belongs to v1", async () => {
    const box = sandbox()
    const v1 = path.join(box.home, ".mendcode")
    mkdirSync(v1, { recursive: true })
    const { ports } = fakePorts([release({ tag: "v1.1.0", binaries: linux("x") })])
    expect((await failure(runUpgrade(box.request({ dataDir: v1 }), ports))).code).toBe("bad-data-dir")
    expect(readdirSync(v1)).toEqual([])
  })
})

describe("rollback", () => {
  test("restores the previous binary and swapping again returns to the newer one", async () => {
    const box = sandbox()
    await runUpgrade(box.request(), fakePorts([release({ tag: "v1.1.0", binaries: linux("one") })]).ports)
    await runUpgrade(box.request({ currentVersion: "1.1.0" }), fakePorts([release({ tag: "v1.2.0", binaries: linux("two", "1.2.0") })]).ports)

    const offline = fakePorts([]).ports
    const back = await runUpgrade(box.request({ rollback: true, repo: "" }), offline)
    expect(back.status).toBe("rolled-back")
    expect(text(box.paths.current)).toBe("one")
    expect(text(box.paths.prev)).toBe("two")
    expect(existsSync(box.paths.next)).toBe(false)

    await runUpgrade(box.request({ rollback: true, repo: "" }), offline)
    expect(text(box.paths.current)).toBe("two")
    expect(text(box.paths.prev)).toBe("one")
  })

  test("without a previous binary it says so and changes nothing", async () => {
    const box = sandbox()
    await installBinary({ fs: nodeFs, dataDir: box.dataDir, bytes: new TextEncoder().encode("only") })
    const error = await failure(rollbackBinary({ fs: nodeFs, dataDir: box.dataDir }))
    expect(error.code).toBe("no-previous")
    expect(text(box.paths.current)).toBe("only")
  })

  test("rollback makes no network calls", async () => {
    const box = sandbox()
    await runUpgrade(box.request(), fakePorts([release({ tag: "v1.1.0", binaries: linux("a") })]).ports)
    await runUpgrade(box.request({ currentVersion: "1.1.0" }), fakePorts([release({ tag: "v1.2.0", binaries: linux("b", "1.2.0") })]).ports)
    const fake = fakePorts([])
    await runUpgrade(box.request({ rollback: true, repo: "" }), fake.ports)
    expect(fake.requested).toEqual([])
  })
})

describe("verification", () => {
  test("a binary that does not match SHA256SUMS is refused and nothing is written", async () => {
    const box = sandbox()
    const good = release({ tag: "v1.1.0", binaries: linux("expected bytes") })
    const { ports } = fakePorts([good])
    const tampered = { ...ports, download: async (url: string) => (url.endsWith("mendcode-1.1.0-linux-x64") ? new TextEncoder().encode("evil bytes") : ports.download(url)) }
    const error = await failure(runUpgrade(box.request(), tampered))
    expect(error.code).toBe("checksum-mismatch")
    expect(existsSync(box.paths.dir)).toBe(false)
    expect(existsSync(path.join(box.dataDir, "upgrade.json"))).toBe(false)
  })

  test("a SHA256SUMS without an entry for this platform is refused before downloading the binary", async () => {
    const box = sandbox()
    const other = release({ tag: "v1.1.0", binaries: { ...linux("x"), "mendcode-1.1.0-darwin-arm64": "y" }, sums: `${"0".repeat(64)}  mendcode-1.1.0-darwin-arm64\n` })
    const fake = fakePorts([other])
    const error = await failure(runUpgrade(box.request(), fake.ports))
    expect(error.code).toBe("checksum-missing")
    expect(fake.requested.some((url) => url.endsWith("mendcode-1.1.0-linux-x64"))).toBe(false)
    expect(existsSync(box.paths.dir)).toBe(false)
  })

  test("a release without a SHA256SUMS asset is refused", async () => {
    const box = sandbox()
    const error = await failure(runUpgrade(box.request(), fakePorts([release({ tag: "v1.1.0", binaries: linux("x"), sums: null })]).ports))
    expect(error.code).toBe("checksum-missing")
    expect(existsSync(box.paths.dir)).toBe(false)
  })

  test("a release without this platform's binary is refused", async () => {
    const box = sandbox()
    const error = await failure(runUpgrade(box.request(), fakePorts([release({ tag: "v1.1.0", binaries: { "mendcode-1.1.0-darwin-arm64": "x" } })]).ports))
    expect(error.code).toBe("asset-missing")
  })

  test("the asset follows the platform", async () => {
    const box = sandbox()
    const { ports } = fakePorts([release({ tag: "v1.1.0", binaries: { "mendcode-1.1.0-linux-x64": "linux", "mendcode-1.1.0-darwin-arm64": "mac" } })])
    await runUpgrade(box.request({ platform: DARWIN_ARM64 }), ports)
    expect(text(box.paths.current)).toBe("mac")
  })
})

describe("decisions", () => {
  const releases = () => fakePorts([release({ tag: "v1.1.0", binaries: linux("one-one") }), release({ tag: "v1.0.0", binaries: linux("one-zero", "1.0.0") })])

  test("up to date installs nothing, but remembers the check", async () => {
    const box = sandbox()
    const result = await runUpgrade(box.request({ currentVersion: "1.1.0" }), releases().ports)
    expect(result.status).toBe("up-to-date")
    expect(existsSync(box.paths.dir)).toBe(false)
    expect(await readState({ fs: nodeFs, dataDir: box.dataDir })).toEqual({ channel: "stable", lastCheckAt: 1_700_000_000_000, lastVersion: null })
  })

  test("never downgrades by itself: a newer running version is left alone", async () => {
    const box = sandbox()
    const result = await runUpgrade(box.request({ currentVersion: "1.5.0" }), releases().ports)
    expect(result).toMatchObject({ status: "ahead", latest: "v1.1.0", installedTo: null })
    expect(existsSync(box.paths.dir)).toBe(false)
  })

  test("--force installs the older release and reports the downgrade", async () => {
    const box = sandbox()
    const result = await runUpgrade(box.request({ currentVersion: "1.5.0", force: true }), releases().ports)
    expect(result).toMatchObject({ status: "installed", downgrade: true })
    expect(text(box.paths.current)).toBe("one-one")
  })

  test("--force reinstalls the same version without calling it a downgrade", async () => {
    const box = sandbox()
    const result = await runUpgrade(box.request({ currentVersion: "1.1.0", force: true }), releases().ports)
    expect(result).toMatchObject({ status: "installed", downgrade: false })
  })

  test("--check reports an update and writes nothing at all", async () => {
    const box = sandbox()
    const fake = releases()
    const result = await runUpgrade(box.request({ check: true }), fake.ports)
    expect(result).toMatchObject({ status: "update-available", latest: "v1.1.0" })
    expect(fake.requested.filter((url) => !url.startsWith("https://api.github.com"))).toEqual([])
    expect(existsSync(box.dataDir)).toBe(false)
  })

  test("a channel with no release of its own takes the stable one; a channel with nothing it takes is an error", async () => {
    const box = sandbox()
    expect((await runUpgrade(box.request({ check: true, channel: "beta" }), releases().ports)).latest).toBe("v1.1.0")
    expect((await failure(runUpgrade(box.request({ channel: "dev" }), releases().ports))).code).toBe("no-release")
  })

  test("a network failure is reported with the failing step", async () => {
    const box = sandbox()
    const { ports } = fakePorts([])
    const error = await failure(runUpgrade(box.request(), { ...ports, fetchJson: async () => Promise.reject(new Error("offline")) }))
    expect(error.code).toBe("network")
    expect(error.message).toContain("offline")
  })

  test("beta and dev channels install their own releases", async () => {
    const box = sandbox()
    const { ports } = fakePorts([
      release({ tag: "v1.1.0", binaries: linux("stable") }),
      release({ tag: "v1.2.0-beta.1", prerelease: true, binaries: linux("beta-1", "1.2.0-beta.1") }),
      release({ tag: "v1.2.0-beta.2", prerelease: true, binaries: linux("beta-2", "1.2.0-beta.2") }),
      release({ tag: "dev-1234567", prerelease: true, published: "2026-03-01T00:00:00Z", binaries: linux("dev-new", "dev-1234567") }),
      release({ tag: "dev-7654321", prerelease: true, published: "2026-02-01T00:00:00Z", binaries: linux("dev-old", "dev-7654321") }),
    ])
    await runUpgrade(box.request({ channel: "beta" }), ports)
    expect(text(box.paths.current)).toBe("beta-2")
    await runUpgrade(box.request({ channel: "dev", currentVersion: "1.2.0-beta.2" }), ports)
    expect(text(box.paths.current)).toBe("dev-new")
    const again = await runUpgrade(box.request({ currentVersion: "dev-1234567" }), ports)
    expect(again.status).toBe("up-to-date")
    expect(again.channel).toBe("dev")
  })
})

describe("upgrade.json", () => {
  test("remembers the chosen channel, the time and the installed version, and reuses the channel next time", async () => {
    const box = sandbox()
    const { ports } = fakePorts([release({ tag: "v1.2.0-beta.1", prerelease: true, binaries: linux("b", "1.2.0-beta.1") })], 42)
    await runUpgrade(box.request({ channel: "beta" }), ports)
    expect(JSON.parse(text(path.join(box.dataDir, "upgrade.json")))).toEqual({ channel: "beta", lastCheckAt: 42, lastVersion: "v1.2.0-beta.1" })
    const next = await runUpgrade(box.request({ currentVersion: "1.2.0-beta.1" }), ports)
    expect(next).toMatchObject({ channel: "beta", status: "up-to-date" })
    expect(JSON.parse(text(path.join(box.dataDir, "upgrade.json"))).lastVersion).toBe("v1.2.0-beta.1")
  })

  test("a damaged file falls back to the default channel", async () => {
    const box = sandbox()
    mkdirSync(box.dataDir, { recursive: true })
    writeFileSync(path.join(box.dataDir, "upgrade.json"), "{not json")
    expect(await readState({ fs: nodeFs, dataDir: box.dataDir })).toEqual({ channel: "stable", lastCheckAt: null, lastVersion: null })
    writeFileSync(path.join(box.dataDir, "upgrade.json"), JSON.stringify({ channel: "edge", lastCheckAt: "x", lastVersion: 3 }))
    expect(await readState({ fs: nodeFs, dataDir: box.dataDir })).toEqual({ channel: "stable", lastCheckAt: null, lastVersion: null })
  })

  test("rollback keeps the channel and forgets the installed version", async () => {
    const box = sandbox()
    await runUpgrade(box.request({ channel: "beta" }), fakePorts([release({ tag: "v1.2.0-beta.1", prerelease: true, binaries: linux("a", "1.2.0-beta.1") })], 7).ports)
    await runUpgrade(box.request({ currentVersion: "1.2.0-beta.1", force: true }), fakePorts([release({ tag: "v1.2.0-beta.1", prerelease: true, binaries: linux("b", "1.2.0-beta.1") })], 8).ports)
    await runUpgrade(box.request({ rollback: true, repo: "" }), fakePorts([]).ports)
    expect(JSON.parse(text(path.join(box.dataDir, "upgrade.json")))).toEqual({ channel: "beta", lastCheckAt: 8, lastVersion: null })
  })
})

describe("release repository", () => {
  test("the default repository is MendCode/MendCode; the environment variable overrides it and the legacy placeholder is refused", () => {
    expect(resolveRepo({})).toBe("MendCode/MendCode")
    expect(resolveRepo({ MENDCODE_UPGRADE_REPO: "acme/mendcode" })).toBe("acme/mendcode")
    expect(() => resolveRepo({ MENDCODE_UPGRADE_REPO: "OWNER/mendcode" })).toThrow("no release repository")
  })

  test("a malformed slug cannot steer the request to another URL", () => {
    for (const repo of ["a/b/c", "../x", "a/..", "a b/c", "a/b?x=1", "nowhere"]) expect(() => resolveRepo({ MENDCODE_UPGRADE_REPO: repo })).toThrow("owner/name")
  })
})
