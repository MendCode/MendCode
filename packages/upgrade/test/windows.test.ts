import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { sha256Hex } from "../src/checksum"
import type { UpgradeError } from "../src/errors"
import { installWindowsBinary, refreshInstallReceipt, windowsInstallPath } from "../src/install"
import { nodeFs } from "../src/io"
import type { UpgradeFs } from "../src/ports"
import { platformAsset, type Platform } from "../src/releases"
import { runUpgrade, type UpgradeRequest } from "../src/upgrade"
import { fakePorts, release, REPO, tempDir } from "./helpers"

const WINDOWS_X64: Platform = { os: "win32", arch: "x64" }
const encoder = new TextEncoder()
const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

function sandbox() {
  const temp = tempDir()
  cleanups.push(temp.cleanup)
  const dataDir = path.join(temp.dir, "data")
  const installDir = path.join(temp.dir, "Programs", "mendcode")
  const exe = path.join(installDir, "mendcode.exe")
  mkdirSync(installDir, { recursive: true })
  const request = (overrides: Partial<UpgradeRequest> = {}): UpgradeRequest => ({ dataDir, home: path.join(temp.dir, "home"), repo: REPO, check: false, force: false, rollback: false, currentVersion: "1.0.0", platform: WINDOWS_X64, installPath: exe, ...overrides })
  return { dataDir, installDir, exe, request }
}
const windows = (content: string, version = "1.1.0") => ({ [`mendcode-${version}-windows-x64.exe`]: content })
const text = (file: string) => readFileSync(file, "utf8")
const receipt = (sha: string, tier = "balanced") => `schema=mendcode.install.v1\nbinary=mendcode.exe\nsha256=${sha}\ntier=${tier}\n`

async function failure(run: Promise<unknown>) {
  try { await run } catch (error) { return error as UpgradeError }
  throw new Error("expected a failure")
}

describe("windows assets and paths", () => {
  test("the Windows asset is the versioned x64 .exe, and other Windows architectures keep the reinstall message", () => {
    expect(platformAsset(WINDOWS_X64, "v1.2.3")).toBe("mendcode-1.2.3-windows-x64.exe")
    expect(platformAsset(WINDOWS_X64, "v1.2.3-nightly.20261101.7")).toBe("mendcode-1.2.3-nightly.20261101.7-windows-x64.exe")
    expect(() => platformAsset({ os: "win32", arch: "arm64" }, "v1.2.3")).toThrow("install.ps1")
  })

  test("the executable to replace is the running mendcode.exe, else where install.ps1 puts it", () => {
    expect(windowsInstallPath({ runningBinary: "C:\\tools\\mendcode.exe", env: { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" } })).toBe("C:\\tools\\mendcode.exe")
    expect(windowsInstallPath({ env: { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" } })).toBe("C:\\Users\\a\\AppData\\Local\\Programs\\mendcode\\mendcode.exe")
    expect(windowsInstallPath({ env: { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local", MENDCODE_INSTALL_DIR: "D:\\apps\\mc" } })).toBe("D:\\apps\\mc\\mendcode.exe")
    expect(windowsInstallPath({ env: {} })).toBeUndefined()
  })
})

describe("windows upgrade", () => {
  test("replaces the executable where it is, keeps the old one as .old, refreshes the receipt and keeps the data directory free of binaries", async () => {
    const box = sandbox()
    writeFileSync(box.exe, "v1.0.0 program")
    writeFileSync(path.join(box.installDir, ".mendcode-install"), receipt(sha256Hex(encoder.encode("v1.0.0 program")), "full"))
    const { ports } = fakePorts([release({ tag: "v1.1.0", binaries: windows("v1.1.0 program") })])
    const result = await runUpgrade(box.request(), ports)
    expect(result).toMatchObject({ status: "installed", latest: "v1.1.0", asset: "mendcode-1.1.0-windows-x64.exe", installedTo: box.exe, rollbackAvailable: false })
    expect(text(box.exe)).toBe("v1.1.0 program")
    expect(text(`${box.exe}.old`)).toBe("v1.0.0 program")
    expect(readdirSync(box.installDir).sort()).toEqual([".mendcode-install", "mendcode.exe", "mendcode.exe.old"])
    expect(text(path.join(box.installDir, ".mendcode-install"))).toBe(receipt(sha256Hex(encoder.encode("v1.1.0 program")), "full"))
    expect(existsSync(path.join(box.dataDir, "bin"))).toBe(false)
    expect(JSON.parse(text(path.join(box.dataDir, "upgrade.json"))).lastVersion).toBe("v1.1.0")
  })

  test("a second upgrade replaces the .old of the first", async () => {
    const box = sandbox()
    writeFileSync(box.exe, "one")
    await runUpgrade(box.request(), fakePorts([release({ tag: "v1.1.0", binaries: windows("two") })]).ports)
    await runUpgrade(box.request({ currentVersion: "1.1.0" }), fakePorts([release({ tag: "v1.2.0", binaries: windows("three", "1.2.0") })]).ports)
    expect(text(box.exe)).toBe("three")
    expect(text(`${box.exe}.old`)).toBe("two")
  })

  test("installs a first copy when nothing is installed yet and leaves no receipt it did not find", async () => {
    const box = sandbox()
    await runUpgrade(box.request(), fakePorts([release({ tag: "v1.1.0", binaries: windows("fresh") })]).ports)
    expect(readdirSync(box.installDir)).toEqual(["mendcode.exe"])
    expect(text(box.exe)).toBe("fresh")
  })

  test("a checksum mismatch in the download changes nothing", async () => {
    const box = sandbox()
    writeFileSync(box.exe, "keep me")
    const published = release({ tag: "v1.1.0", binaries: windows("good") })
    const bad = fakePorts([{ ...published, files: new Map([...published.files].map(([url, bytes]) => [url, url.endsWith(".exe") ? encoder.encode("tampered") : bytes])) }])
    expect((await failure(runUpgrade(box.request(), bad.ports))).code).toBe("checksum-mismatch")
    expect(text(box.exe)).toBe("keep me")
    expect(readdirSync(box.installDir)).toEqual(["mendcode.exe"])
  })

  test("without a known install location it names the reinstall command and downloads nothing", async () => {
    const box = sandbox()
    const { ports, requested } = fakePorts([release({ tag: "v1.1.0", binaries: windows("x") })])
    const error = await failure(runUpgrade(box.request({ installPath: undefined as unknown as string }), ports))
    expect(error.code).toBe("unsupported-platform")
    expect(error.message).toContain("install.ps1")
    expect(requested.some((url) => url.endsWith(".exe"))).toBe(false)
  })

  test("--rollback says it is not available on Windows", async () => {
    const box = sandbox()
    const error = await failure(runUpgrade(box.request({ rollback: true }), fakePorts([]).ports))
    expect(error.code).toBe("unsupported-platform")
    expect(error.message).toContain("not available on Windows")
  })

  test("--check reads the release without needing an install location", async () => {
    const box = sandbox()
    const result = await runUpgrade(box.request({ check: true, installPath: undefined as unknown as string }), fakePorts([release({ tag: "v1.1.0", binaries: windows("x") })]).ports)
    expect(result).toMatchObject({ status: "update-available", asset: "mendcode-1.1.0-windows-x64.exe" })
  })
})

describe("replacing a running executable", () => {
  const failing = (fail: (call: { op: string; from: string; to?: string }) => boolean): UpgradeFs => ({
    ...nodeFs,
    rename: async (from, to) => { if (fail({ op: "rename", from, to })) throw new Error("EBUSY: resource busy"); await nodeFs.rename(from, to) },
    remove: async (file) => { if (fail({ op: "remove", from: file })) throw new Error("EPERM: operation not permitted"); await nodeFs.remove(file) },
    writeFile: async (file, bytes) => { if (fail({ op: "write", from: file })) throw new Error("ENOSPC: no space left"); await nodeFs.writeFile(file, bytes) },
  })
  const digest = (content: string) => sha256Hex(encoder.encode(content))

  test("when the new file cannot take the name the previous executable is put back and the staged file is removed", async () => {
    const box = sandbox()
    writeFileSync(box.exe, "previous")
    const fs = failing(({ op, from }) => op === "rename" && from.endsWith(".new"))
    const error = await failure(installWindowsBinary({ fs, target: box.exe, bytes: encoder.encode("next"), sha256: digest("next") }))
    expect(error.message).toContain("cannot put the new executable in place")
    expect(text(box.exe)).toBe("previous")
    expect(readdirSync(box.installDir)).toEqual(["mendcode.exe"])
  })

  test("when the previous executable cannot be put back either, the error says where it is", async () => {
    const box = sandbox()
    writeFileSync(box.exe, "previous")
    const fs = failing(({ op, from }) => op === "rename" && (from.endsWith(".new") || from.endsWith(".old")))
    const error = await failure(installWindowsBinary({ fs, target: box.exe, bytes: encoder.encode("next"), sha256: digest("next") }))
    expect(error.message).toContain(`it is at ${box.exe}.old`)
    expect(text(`${box.exe}.old`)).toBe("previous")
  })

  test("an .old that is still running stops the swap before anything moves", async () => {
    const box = sandbox()
    writeFileSync(box.exe, "previous")
    writeFileSync(`${box.exe}.old`, "still running")
    const fs = failing(({ op, from }) => op === "remove" && from.endsWith(".old"))
    const error = await failure(installWindowsBinary({ fs, target: box.exe, bytes: encoder.encode("next"), sha256: digest("next") }))
    expect(error.message).toContain("is still running")
    expect(text(box.exe)).toBe("previous")
    expect(text(`${box.exe}.old`)).toBe("still running")
    expect(existsSync(`${box.exe}.new`)).toBe(false)
  })

  test("a staged file whose digest differs from the verified one is never swapped in", async () => {
    const box = sandbox()
    writeFileSync(box.exe, "previous")
    const error = await failure(installWindowsBinary({ fs: nodeFs, target: box.exe, bytes: encoder.encode("next"), sha256: digest("something else") }))
    expect(error.code).toBe("checksum-mismatch")
    expect(text(box.exe)).toBe("previous")
    expect(existsSync(`${box.exe}.new`)).toBe(false)
  })

  test("the receipt is refreshed only when it is the installer's for mendcode.exe, and an earlier receipt name is replaced", async () => {
    const box = sandbox()
    expect(await refreshInstallReceipt({ fs: nodeFs, target: box.exe, sha256: digest("a") })).toBe(false)
    writeFileSync(path.join(box.installDir, ".mendcode-v2-install"), "schema=mendcode-v2.install.v1\nbinary=mendcode.exe\nsha256=" + digest("old") + "\n")
    expect(await refreshInstallReceipt({ fs: nodeFs, target: box.exe, sha256: digest("a") })).toBe(true)
    expect(readdirSync(box.installDir)).toEqual([".mendcode-install"])
    expect(text(path.join(box.installDir, ".mendcode-install"))).toBe(`schema=mendcode.install.v1\nbinary=mendcode.exe\nsha256=${digest("a")}\n`)
    writeFileSync(path.join(box.installDir, ".mendcode-install"), "not a receipt")
    expect(await refreshInstallReceipt({ fs: nodeFs, target: box.exe, sha256: digest("b") })).toBe(false)
    expect(text(path.join(box.installDir, ".mendcode-install"))).toBe("not a receipt")
  })
})
