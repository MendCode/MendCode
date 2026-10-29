import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync, mkdirSync, rmSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createUserService, daemonServiceDefinition, daemonServicePlan, type ServiceOptions } from "../src/user-service"
import { daemonLogs, daemonLogPaths } from "../src/daemon-logs"

const temps: string[] = []
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "mend-service-")); temps.push(dir); return dir }
const options = (platform = "darwin"): ServiceOptions => {
  const root = temp()
  return { dir: path.join(root, "data & state"), cwd: root, command: ["/opt/Mend Code/mendcode", "__daemon"], platform, home: root, uid: 123 }
}

describe("one user service", () => {
  test("plans launchd and systemd with absolute args, private logs and no listener", () => {
    for (const platform of ["darwin", "linux"]) {
      const a = options(platform)
      const plan = daemonServicePlan(a)
      expect(plan.programArguments).toContain("--local-only")
      expect(plan.programArguments).toContain(path.resolve(a.dir))
      expect(plan.label).toBe(daemonServicePlan({ ...a, cwd: "/other/project" }).label)
      const definition = daemonServiceDefinition(plan)
      expect(definition).not.toContain("--listen")
      expect(definition).not.toContain("--token")
      if (platform === "darwin") { expect(definition).toContain("data &amp; state"); expect(definition).toContain("<key>KeepAlive</key><true/>") }
      else { expect(definition).toContain('ExecStart="/opt/Mend Code/mendcode"'); expect(definition).toContain("UMask=0077") }
    }
    expect(() => daemonServicePlan({ ...options(), command: ["mendcode"] })).toThrow("absolute")
    expect(() => daemonServicePlan({ ...options(), cwd: "bad\npath" })).toThrow("Invalid")
    const plan = daemonServicePlan({ ...options("linux"), command: ["/opt/%n/$BIN/code\\name"] })
    expect(daemonServiceDefinition(plan)).toContain('"/opt/%%n/$$BIN/code\\\\name"')
  })

  test.each(["darwin", "linux"])("%s install is opt-in, idempotent start, and uninstall retains exact files", async (platform) => {
    const a = options(platform)
    let loaded = false
    const calls: string[][] = []
    const service = createUserService(a, (command) => {
      calls.push(command)
      if (command.includes("print") || command.includes("is-active")) return { code: loaded ? 0 : 1, stdout: loaded ? "active" : "", stderr: "" }
      if (command.includes("bootstrap") || command.includes("start")) loaded = true
      if (command.includes("bootout") || command.includes("stop")) loaded = false
      return { code: 0, stdout: "", stderr: "" }
    })
    expect((await service.status()).installed).toBe(false)
    expect(existsSync(a.dir)).toBe(false)
    expect((await service.control("install")).loaded).toBe(false)
    expect(calls.some((command) => command.includes("start") || command.includes("bootstrap"))).toBe(false)
    expect(statSync(service.plan.bindingPath).mode & 0o777).toBe(0o600)
    expect(statSync(service.plan.stderrPath).mode & 0o777).toBe(0o600)
    await service.control("start")
    const starts = calls.length
    await service.control("start")
    expect(calls.slice(starts).filter((command) => command.includes("bootstrap") || command.includes("start"))).toEqual([])
    expect((await service.status()).loaded).toBe(true)
    await expect(service.control("install")).rejects.toThrow("Stop")
    await service.control("stop")
    const definition = readFileSync(service.plan.definitionPath, "utf8")
    await service.control("uninstall")
    expect(existsSync(service.plan.definitionPath)).toBe(false)
    const trash = path.join(a.dir, "service", "trash")
    const archived = path.join(trash, readdirSync(trash)[0]!, path.basename(service.plan.definitionPath))
    expect(readFileSync(archived, "utf8")).toBe(definition)
  })

  test("binding rejects a second data dir, detects drift and preserves foreign/symlink definitions", async () => {
    const a = options()
    const exec = () => ({ code: 1, stdout: "", stderr: "not loaded" })
    const service = createUserService(a, exec)
    await service.control("install")
    await expect(createUserService({ ...a, dir: path.join(a.cwd, "other") }, exec).control("install")).rejects.toThrow("belongs to")
    writeFileSync(service.plan.definitionPath, "foreign definition")
    expect((await service.status()).drift).toEqual(["definition-drift"])
    await expect(service.control("start")).rejects.toThrow("matching")
    expect(readFileSync(service.plan.definitionPath, "utf8")).toBe("foreign definition")
    const b = options()
    const foreign = createUserService(b, exec)
    mkdirSync(path.dirname(foreign.plan.definitionPath), { recursive: true })
    writeFileSync(foreign.plan.definitionPath, "unowned")
    await expect(foreign.control("install")).rejects.toThrow("no MendCode binding")
    const c = options()
    const linked = createUserService(c, exec)
    mkdirSync(path.dirname(linked.plan.definitionPath), { recursive: true })
    symlinkSync(foreign.plan.definitionPath, linked.plan.definitionPath)
    await expect(linked.control("install")).rejects.toThrow("symlinks")
  })

  test("manager errors are reported and Windows activation has no side effects", async () => {
    const a = options("linux")
    const service = createUserService(a, (command) => ({ code: 1, stdout: "", stderr: command.includes("daemon-reload") ? "manager unavailable" : "not loaded" }))
    await expect(service.control("install")).rejects.toThrow("manager unavailable")
    const win = options("win32")
    const windows = createUserService(win, () => { throw new Error("must not execute") })
    expect((await windows.control("plan")).supported).toBe(false)
    await expect(windows.control("install")).rejects.toThrow("use daemon start or daemon run")
    const status = await windows.status()
    expect(status.loaded).toBe(false)
    expect(status.detail).not.toContain("socket")
    expect(status.detail).toContain("No user service manager")
    expect(existsSync(win.dir)).toBe(false)
  })
})

test("log tails are bounded, secret-redacted, control-free and refuse symlinks", async () => {
  const dir = temp()
  expect((await daemonLogs(dir)).logs.every((log) => log.missing)).toBe(true)
  const logs = daemonLogPaths(dir)
  mkdirSync(path.dirname(logs.stdout))
  const secret = "sk-" + "a".repeat(48)
  writeFileSync(logs.stdout, "old\n".repeat(40_000) + `\x1b[31mkey ${secret}\x1b[0m\nlast\n`)
  const report = await daemonLogs(dir, 2)
  expect(report.logs[0]!.text).toContain("last")
  expect(report.logs[0]!.text).not.toContain(secret)
  expect(report.logs[0]!.text).not.toContain("\x1b")
  expect(report.logs[0]!.truncated).toBe(true)
  const external = path.join(dir, "private.txt")
  writeFileSync(external, "private")
  symlinkSync(external, logs.stderr)
  await expect(daemonLogs(dir)).rejects.toThrow()
})
