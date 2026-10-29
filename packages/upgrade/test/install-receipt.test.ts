import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { INSTALL_RECEIPT, parseInstallReceipt, readInstallPreset } from "../src/install-receipt"

const SUM = "a".repeat(64)
const temps: string[] = []
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "mendcode-receipt-")); temps.push(dir); return dir }
const receipt = (dir: string, text: string) => { mkdirSync(dir, { recursive: true }); writeFileSync(path.join(dir, INSTALL_RECEIPT), text) }

describe("parseInstallReceipt", () => {
  test("reads the three original lines and the tier line, with LF or CRLF", () => {
    expect(parseInstallReceipt(`schema=mendcode-v2.install.v1\nbinary=mendcode\nsha256=${SUM}\n`)).toEqual({ binary: "mendcode", sha256: SUM })
    expect(parseInstallReceipt(`schema=mendcode-v2.install.v1\nbinary=mendcode\nsha256=${SUM}\ntier=full\n`)).toEqual({ binary: "mendcode", sha256: SUM, tier: "full" })
    expect(parseInstallReceipt(`schema=mendcode-v2.install.v1\r\nbinary=mendcode.exe\r\nsha256=${SUM}\r\ntier=minimalist\r\n`)).toEqual({ binary: "mendcode.exe", sha256: SUM, tier: "minimalist" })
  })
  test("anything else is not a receipt: an unknown tier, extra lines, another binary or schema", () => {
    for (const text of [`schema=mendcode-v2.install.v1\nbinary=mendcode\nsha256=${SUM}\ntier=huge\n`, `schema=mendcode-v2.install.v1\nbinary=mendcode\nsha256=${SUM}\ntier=full\nextra=1\n`, `schema=mendcode-v2.install.v1\nbinary=other\nsha256=${SUM}\n`, `schema=v0\nbinary=mendcode\nsha256=${SUM}\n`, ""]) expect(parseInstallReceipt(text)).toBeUndefined()
  })
})

describe("readInstallPreset", () => {
  test("a binary's own directory wins; its receipt names the tier", () => {
    const root = temp()
    receipt(path.join(root, "bin"), `schema=mendcode-v2.install.v1\nbinary=mendcode\nsha256=${SUM}\ntier=minimalist\n`)
    expect(readInstallPreset({ runningBinary: path.join(root, "bin", "mendcode"), env: {}, home: path.join(root, "home"), platform: "linux" })).toBe("minimalist")
  })
  test("MENDCODE_INSTALL_DIR is read, also from source where there is no running binary", () => {
    const root = temp()
    receipt(path.join(root, "custom"), `schema=mendcode-v2.install.v1\nbinary=mendcode\nsha256=${SUM}\ntier=full\n`)
    expect(readInstallPreset({ env: { MENDCODE_INSTALL_DIR: path.join(root, "custom") }, home: path.join(root, "home"), platform: "linux" })).toBe("full")
  })
  test("the installer's default directory is read only for an installed binary, never from source", () => {
    const root = temp()
    receipt(path.join(root, "home", ".local", "bin"), `schema=mendcode-v2.install.v1\nbinary=mendcode\nsha256=${SUM}\ntier=full\n`)
    expect(readInstallPreset({ env: {}, home: path.join(root, "home"), platform: "linux" })).toBeUndefined()
    expect(readInstallPreset({ runningBinary: path.join(root, "data", "bin", "mendcode-next"), env: {}, home: path.join(root, "home"), platform: "linux" })).toBe("full")
  })
  test("Windows looks in LOCALAPPDATA\\Programs\\mendcode", () => {
    const root = temp()
    receipt(path.join(root, "local", "Programs", "mendcode"), `schema=mendcode-v2.install.v1\nbinary=mendcode.exe\nsha256=${SUM}\ntier=balanced\n`)
    expect(readInstallPreset({ runningBinary: path.join(root, "elsewhere", "mendcode.exe"), env: { LOCALAPPDATA: path.join(root, "local") }, home: root, platform: "win32" })).toBe("balanced")
  })
  test("no receipt, a receipt without a tier, a damaged one or a directory in its place give no preset", () => {
    const root = temp()
    const base = { env: { MENDCODE_INSTALL_DIR: path.join(root, "dir") }, home: root, platform: "linux" }
    expect(readInstallPreset(base)).toBeUndefined()
    receipt(path.join(root, "dir"), `schema=mendcode-v2.install.v1\nbinary=mendcode\nsha256=${SUM}\n`)
    expect(readInstallPreset(base)).toBeUndefined()
    receipt(path.join(root, "dir"), "tier=full\n")
    expect(readInstallPreset(base)).toBeUndefined()
    rmSync(path.join(root, "dir", INSTALL_RECEIPT))
    mkdirSync(path.join(root, "dir", INSTALL_RECEIPT))
    expect(readInstallPreset(base)).toBeUndefined()
  })
})
