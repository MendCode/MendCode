import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { moveDataDirAtStart } from "../src/data-dir-move"
import { daemonServiceDefinition, daemonServicePlan } from "../../../packages/daemon/src/user-service"

const ENV = { NODE_ENV: "test", MENDCODE_TEST_DATA_DIR_MOVE: "1" }
const REMOTE = ["--listen", "127.0.0.1:9876", "--tls-cert", "/srv/tls/cert.pem", "--tls-key", "/srv/tls/key.pem"]
const idle = async () => ({ activeTurns: 0, backgroundJobs: 0, loops: { running: 0 } })
let home: string
let written: string[]
let spy: ReturnType<typeof spyOn>

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "mc-move-"))
  mkdirSync(path.join(home, ".mendcode-v2"), { recursive: true })
  written = []
  spy = spyOn(process.stderr, "write").mockImplementation(((text: string) => { written.push(String(text)); return true }) as never)
})
afterEach(() => { spy.mockRestore(); rmSync(home, { recursive: true, force: true }) })

/** A user service as a host has it: a definition from an older template, a drop-in, and a binding that may not record the listener. */
function installService({ binding }: { binding: "with-remote" | "without-remote" }) {
  const plan = daemonServicePlan({ dir: path.join(home, ".mendcode-v2"), cwd: home, command: ["/home/u/.local/bin/mendcode", "__daemon"], remote: REMOTE, platform: "linux", home })
  mkdirSync(path.dirname(plan.definitionPath), { recursive: true })
  writeFileSync(plan.definitionPath, daemonServiceDefinition(plan).replace("RestartSec=5\n", "").replace("UMask=0077\n", ""))
  const dropIn = path.join(path.dirname(plan.definitionPath), "com.mendcode.v2.daemon.service.d", "limits.conf")
  mkdirSync(path.dirname(dropIn), { recursive: true })
  writeFileSync(dropIn, "[Service]\nCPUQuota=50%\nMemoryMax=2G\n")
  writeFileSync(plan.bindingPath, JSON.stringify({ dir: plan.dataDir, cwd: home, command: ["/home/u/.local/bin/mendcode", "__daemon"], ...(binding === "with-remote" ? { remote: REMOTE } : {}) }) + "\n")
  return { plan, dropIn }
}

function manager({ stopFails = false } = {}) {
  const calls: string[] = []
  let loaded = true
  const execute = (command: string[]) => {
    calls.push(command.join(" "))
    if (command.includes("is-active")) return { code: loaded ? 0 : 3, stdout: loaded ? "active" : "inactive", stderr: "" }
    if (command.includes("stop")) { if (stopFails) return { code: 1, stdout: "", stderr: "Failed to stop unit" }; loaded = false }
    if (command.includes("start")) loaded = true
    return { code: 0, stdout: "", stderr: "" }
  }
  return { execute, calls }
}

describe("data directory move with an installed user service", () => {
  for (const binding of ["with-remote", "without-remote"] as const) {
    test(`a definition older than the template (${binding} binding) is rewritten for the new directory with its listener and drop-in kept`, async () => {
      const { plan, dropIn } = installService({ binding })
      const host = manager()
      const result = await moveDataDirAtStart(["bun", "mendcode"], ENV, home, { execute: host.execute, platform: "linux", work: idle })
      expect(result?.moved).toBe(true)
      const definition = readFileSync(plan.definitionPath, "utf8")
      expect(definition).toContain(`"--dir" "${path.join(home, ".mendcode")}"`)
      for (const arg of REMOTE) expect(definition).toContain(`"${arg}"`)
      expect(definition).not.toContain("--local-only")
      expect(JSON.parse(readFileSync(plan.bindingPath, "utf8"))).toMatchObject({ dir: path.join(home, ".mendcode"), remote: REMOTE })
      expect(readFileSync(dropIn, "utf8")).toContain("CPUQuota=50%")
      expect(host.calls.some((call) => call.endsWith("stop com.mendcode.v2.daemon.service"))).toBe(true)
      expect(host.calls.some((call) => call.endsWith(" start com.mendcode.v2.daemon.service"))).toBe(true)
      expect(written.join("")).toContain("keeps its data in")
      expect(written.join("")).not.toContain("could not move")
    })
  }

  test("a move that cannot happen says why once, then stays quiet on later starts", async () => {
    installService({ binding: "with-remote" })
    const host = manager({ stopFails: true })
    const first = await moveDataDirAtStart(["bun", "mendcode"], ENV, home, { execute: host.execute, platform: "linux", work: idle })
    expect(first).toMatchObject({ moved: false, reason: "failed" })
    expect(written.join("")).toContain("could not move ~/.mendcode-v2")
    written.length = 0
    await moveDataDirAtStart(["bun", "mendcode"], ENV, home, { execute: host.execute, platform: "linux", work: idle })
    await moveDataDirAtStart(["bun", "mendcode"], ENV, home, { execute: host.execute, platform: "linux", work: idle })
    expect(written).toEqual([])
    expect(existsSync(path.join(home, ".mendcode-v2"))).toBe(true)
  })

  test("a busy daemon is never stopped: nothing moves, the directory and service stay as they were, the reason is said once", async () => {
    const { plan } = installService({ binding: "with-remote" })
    const before = readFileSync(plan.definitionPath, "utf8")
    const host = manager()
    const busy = async () => ({ activeTurns: 1, backgroundJobs: 0, loops: { running: 0 } })
    for (const attempt of [1, 2]) {
      const result = await moveDataDirAtStart(["bun", "mendcode"], ENV, home, { execute: host.execute, platform: "linux", work: busy })
      expect(result).toMatchObject({ moved: false, reason: "failed" })
      if (attempt === 1) expect(written.join("")).toContain("the daemon is working: 1 turns · 0 jobs")
      else expect(written).toEqual([])
      written.length = 0
    }
    expect(host.calls).toEqual([])
    expect(existsSync(path.join(home, ".mendcode"))).toBe(false)
    expect(readFileSync(plan.definitionPath, "utf8")).toBe(before)
  })

  test("background jobs and a daemon that cannot be queried also keep the directory where it is", async () => {
    installService({ binding: "with-remote" })
    const host = manager()
    for (const work of [async () => ({ activeTurns: 0, backgroundJobs: 2, loops: { running: 0 } }), async () => undefined]) {
      expect(await moveDataDirAtStart(["bun", "mendcode"], ENV, home, { execute: host.execute, platform: "linux", work })).toMatchObject({ moved: false })
    }
    expect(host.calls).toEqual([])
    expect(existsSync(path.join(home, ".mendcode"))).toBe(false)
  })

  test("a different reason is said again", async () => {
    installService({ binding: "with-remote" })
    await moveDataDirAtStart(["bun", "mendcode"], ENV, home, { execute: manager({ stopFails: true }).execute, platform: "linux", work: idle })
    written.length = 0
    writeFileSync(path.join(home, ".mendcode-v2", ".data-dir-move-notice"), "an older reason\n")
    await moveDataDirAtStart(["bun", "mendcode"], ENV, home, { execute: manager({ stopFails: true }).execute, platform: "linux", work: idle })
    expect(written.join("")).toContain("could not move")
  })
})
