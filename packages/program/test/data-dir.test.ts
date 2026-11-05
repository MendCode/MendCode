import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { dataDirFromEnv, defaultDataDirNow, isDefaultDataDir, mendEnv, moveLegacyDataDir, resolveDataDir, sameDir } from "../src/data-dir"

const homes: string[] = []
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })
const home = () => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mc-home-"))); homes.push(dir); return dir }
/** An earlier version's data directory: a database, settings and a session blob. */
const v2Data = (dir: string) => {
  mkdirSync(path.join(dir, "blobs"), { recursive: true })
  writeFileSync(path.join(dir, "mendd.db"), "db")
  writeFileSync(path.join(dir, "blobs", "a"), "blob")
}
const noDaemon = async () => true

describe("data directory names", () => {
  test("MENDCODE_<name> wins over MENDCODE_V2_<name>; an empty value counts as unset", () => {
    expect(mendEnv({ MENDCODE_JIT: "0", MENDCODE_V2_JIT: "1" }, "JIT")).toBe("0")
    expect(mendEnv({ MENDCODE_V2_JIT: "1" }, "JIT")).toBe("1")
    expect(mendEnv({ MENDCODE_JIT: "", MENDCODE_V2_JIT: "1" }, "JIT")).toBe("1")
    expect(mendEnv({}, "JIT")).toBeUndefined()
    expect(dataDirFromEnv({ MENDCODE_V2_DIR: "/data/old" })).toBe("/data/old")
    expect(resolveDataDir(undefined, {}, "/home/u")).toBe("/home/u/.mendcode")
    expect(resolveDataDir("/x", { MENDCODE_DIR: "/y" }, "/home/u")).toBe("/x")
  })
})

describe("moving ~/.mendcode-v2 to ~/.mendcode", () => {
  test("moves the data, leaves a link with the old name, and every file is reachable under both names", async () => {
    const h = home()
    v2Data(path.join(h, ".mendcode-v2"))
    expect(await moveLegacyDataDir({ home: h, stopDaemon: noDaemon })).toEqual({ moved: true })
    expect(lstatSync(path.join(h, ".mendcode")).isDirectory()).toBe(true)
    expect(lstatSync(path.join(h, ".mendcode-v2")).isSymbolicLink()).toBe(true)
    expect(readFileSync(path.join(h, ".mendcode-v2", "blobs", "a"), "utf8")).toBe("blob")
    expect(defaultDataDirNow(h)).toBe(path.join(h, ".mendcode"))
    expect(isDefaultDataDir(path.join(h, ".mendcode-v2"), h)).toBe(true)
    // A second start finds it done.
    expect(await moveLegacyDataDir({ home: h, stopDaemon: noDaemon })).toEqual({ moved: false, reason: "already moved" })
  })

  test("MendCode v1's ~/.mendcode is set aside, never deleted, and OpenCode's links follow it there", async () => {
    const h = home()
    v2Data(path.join(h, ".mendcode-v2"))
    const v1 = path.join(h, ".mendcode")
    mkdirSync(path.join(v1, "data"), { recursive: true })
    writeFileSync(path.join(v1, "auth.json"), "v1 auth")
    mkdirSync(path.join(h, ".local", "share"), { recursive: true })
    mkdirSync(path.join(h, ".config"), { recursive: true })
    symlinkSync(path.join(v1, "data"), path.join(h, ".local", "share", "opencode"))
    symlinkSync(v1, path.join(h, ".config", "opencode"))
    mkdirSync(path.join(h, "elsewhere"))
    symlinkSync(path.join(h, "elsewhere"), path.join(h, ".config", "mendcode"))
    expect(await moveLegacyDataDir({ home: h, stopDaemon: noDaemon })).toEqual({ moved: true, v1Aside: path.join(h, ".mendcode-v1") })
    expect(readFileSync(path.join(h, ".mendcode-v1", "auth.json"), "utf8")).toBe("v1 auth")
    expect(existsSync(path.join(h, ".mendcode", "mendd.db"))).toBe(true)
    expect(readlinkSync(path.join(h, ".local", "share", "opencode"))).toBe(path.join(h, ".mendcode-v1", "data"))
    expect(readlinkSync(path.join(h, ".config", "opencode"))).toBe(path.join(h, ".mendcode-v1"))
    // A link that never pointed into v1's folder is left as it was.
    expect(readlinkSync(path.join(h, ".config", "mendcode"))).toBe(path.join(h, "elsewhere"))
  })

  test("an empty ~/.mendcode is simply replaced; a taken .mendcode-v1 name gets a number", async () => {
    const h = home()
    v2Data(path.join(h, ".mendcode-v2"))
    mkdirSync(path.join(h, ".mendcode"))
    expect(await moveLegacyDataDir({ home: h, stopDaemon: noDaemon })).toEqual({ moved: true })
    const other = home()
    v2Data(path.join(other, ".mendcode-v2"))
    mkdirSync(path.join(other, ".mendcode-v1"))
    writeFileSync(path.join(other, ".mendcode"), "a file")
    expect(await moveLegacyDataDir({ home: other, stopDaemon: noDaemon })).toEqual({ moved: true, v1Aside: path.join(other, ".mendcode-v1-2") })
  })

  test("when both names hold a database nothing moves and the new one is used", async () => {
    const h = home()
    v2Data(path.join(h, ".mendcode-v2"))
    v2Data(path.join(h, ".mendcode"))
    expect(await moveLegacyDataDir({ home: h, stopDaemon: noDaemon })).toEqual({ moved: false, reason: "both hold data" })
    expect(defaultDataDirNow(h)).toBe(path.join(h, ".mendcode"))
  })

  test("a daemon that cannot be stopped leaves everything in place and the old directory in use until a later start", async () => {
    const h = home()
    const old = path.join(h, ".mendcode-v2")
    v2Data(old)
    writeFileSync(path.join(old, "mendd.lock"), "12345")
    const stopped: string[] = []
    expect(await moveLegacyDataDir({ home: h, stopDaemon: async (dir) => { stopped.push(dir); return false } })).toEqual({ moved: false, reason: "daemon still running" })
    expect(stopped).toEqual([old])
    expect(lstatSync(old).isDirectory()).toBe(true)
    expect(existsSync(path.join(h, ".mendcode"))).toBe(false)
    expect(defaultDataDirNow(h)).toBe(old)
    // Once it stopped, the stale lock file moves with the rest.
    expect(await moveLegacyDataDir({ home: h, stopDaemon: noDaemon })).toEqual({ moved: true })
  })

  test("the service hooks run around the move with both paths; nothing to move means no hook", async () => {
    const h = home()
    v2Data(path.join(h, ".mendcode-v2"))
    const calls: string[] = []
    await moveLegacyDataDir({ home: h, stopDaemon: noDaemon, beforeMove: (oldDir) => { calls.push(`before ${oldDir}`) }, afterMove: (oldDir, newDir) => { calls.push(`after ${oldDir} ${newDir}`) } })
    expect(calls).toEqual([`before ${path.join(h, ".mendcode-v2")}`, `after ${path.join(h, ".mendcode-v2")} ${path.join(h, ".mendcode")}`])
    const empty = home()
    expect(await moveLegacyDataDir({ home: empty, stopDaemon: noDaemon, beforeMove: () => { throw new Error("no") } })).toEqual({ moved: false, reason: "nothing to move" })
  })
})

describe("sameDir", () => {
  test("the old name after the move is the same directory as the new one; another folder is not", async () => {
    const h = home()
    v2Data(path.join(h, ".mendcode-v2"))
    await moveLegacyDataDir({ home: h, stopDaemon: noDaemon })
    expect(sameDir(path.join(h, ".mendcode-v2"), path.join(h, ".mendcode"))).toBe(true)
    expect(sameDir(path.join(h, ".mendcode"), `${path.join(h, ".mendcode")}/`)).toBe(true)
    expect(sameDir(path.join(h, ".mendcode"), path.join(h, "other"))).toBe(false)
  })
})
