import { describe, expect, test } from "bun:test"
import { mkdir } from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { resolveMendProjectRoot } from "../../src/mend/config/paths"
import { DEFAULT_LOOP_SERVICE_LIMIT, loopServiceArgsFromConfig, loopServicePlan, loopServicePlist, loopServiceSystemdUnit, loopServiceWindowsCommand } from "../../src/mend/runtime/loop-service"

describe("loop service plans", () => {
  test("does not let a stale runtime-root override steal the project cwd", () => {
    expect(resolveMendProjectRoot("/work/project", "/runtime/mendcode", "/runtime/mendcode")).toBe("/work/project")
    expect(resolveMendProjectRoot("/runtime/mendcode", "/work/project", "/runtime/mendcode")).toBe("/work/project")
    expect(
      resolveMendProjectRoot(
        "/runtime/mendcode/src/mendcode/packages/opencode",
        "/runtime/mendcode",
        "/runtime/mendcode",
      ),
    ).toBe("/runtime/mendcode")
  })

  test("resolves configured service directories from the project root", async () => {
    await using dir = await tmpdir()
    await mkdir(path.join(dir.path, ".mendcode"), { recursive: true })
    await Bun.write(
      path.join(dir.path, ".mendcode", "mendcode.json"),
      JSON.stringify({ loop: { serviceDir: "runtime/services", logDir: "runtime/logs" } }),
    )

    const args = loopServiceArgsFromConfig(dir.path)

    expect(args.projectRoot).toBe(dir.path)
    expect(args.serviceDir).toBe(path.join(dir.path, "runtime/services"))
    expect(args.logDir).toBe(path.join(dir.path, "runtime/logs"))

    const overridden = loopServiceArgsFromConfig(dir.path, { serviceDir: "override/services", logDir: "override/logs" })
    expect(overridden.serviceDir).toBe(path.join(dir.path, "override/services"))
    expect(overridden.logDir).toBe(path.join(dir.path, "override/logs"))
  })

  test("builds a project-scoped report-only daemon by default", () => {
    const plan = loopServicePlan({
      projectRoot: "/tmp/acme repo",
      intervalMs: 5000,
      limit: 3,
      execute: true,
      reportOnly: true,
      command: "/usr/local/bin/mendcode",
      platform: "darwin",
    })

    expect(plan.label).toMatch(/^com\.mendcode\.loops\.[a-f0-9]{12}$/)
    expect(plan.backend).toBe("launchd")
    expect(plan.projectRoot).toBe(path.resolve("/tmp/acme repo"))
    expect(plan.mode).toBe("report-only")
    expect(plan.definitionPath).toContain("Library/LaunchAgents")
    expect(plan.programArguments).toEqual([
      "/usr/bin/env",
      expect.stringContaining("PATH="),
      "/usr/local/bin/mendcode",
      "loops",
      "daemon",
      "--interval-ms",
      "5000",
      "--limit",
      "3",
      "--execute",
      "--report-only",
      "--once",
      "--quiet",
    ])
  })

  test("keeps full execution opt-in", () => {
    const plan = loopServicePlan({
      projectRoot: "/tmp/repo",
      execute: true,
      reportOnly: false,
      command: "mendcode",
      platform: "darwin",
    })

    expect(plan.mode).toBe("execute")
    expect(plan.programArguments).toContain("--execute")
    expect(plan.programArguments).not.toContain("--report-only")
  })

  test("uses a batch limit that can wake several project loops per pass", () => {
    const plan = loopServicePlan({ projectRoot: "/tmp/repo", execute: true, reportOnly: true, platform: "darwin" })

    expect(DEFAULT_LOOP_SERVICE_LIMIT).toBeGreaterThan(1)
    expect(plan.limit).toBe(DEFAULT_LOOP_SERVICE_LIMIT)
    expect(plan.programArguments).toContain(String(DEFAULT_LOOP_SERVICE_LIMIT))
  })

  test("renders XML-safe plist content", () => {
    const plan = loopServicePlan({
      projectRoot: '/tmp/acme & "repo"',
      execute: true,
      reportOnly: true,
      command: "/opt/mendcode",
      platform: "darwin",
    })
    const plist = loopServicePlist(plan)

    expect(plist).toContain("<key>ProgramArguments</key>")
    expect(plist).toContain("<key>EnvironmentVariables</key>")
    expect(plist).toContain("<key>MENDCODE_SHELL_CWD</key>")
    expect(plist).toContain("<key>MENDCODE_LOOP_SERVICE</key>")
    expect(plist).toContain("<key>MENDCODE_DB</key>")
    expect(plist).toContain("<key>WorkingDirectory</key>")
    expect(plist).toContain("/tmp/acme &amp; &quot;repo&quot;")
    expect(plist).toContain("<key>StartInterval</key>")
    expect(plist).toContain("<integer>60</integer>")
    expect(plist).toContain("<key>RunAtLoad</key>\n  <false/>")
    expect(plist).not.toContain("<key>KeepAlive</key>")
  })

  test("gates macOS launches with native SQLite before starting Bun", () => {
    const plan = loopServicePlan({
      projectRoot: "/tmp/repo",
      execute: true,
      reportOnly: true,
      command: "/opt/mendcode",
      platform: "darwin",
    })

    expect(plan.serviceProgramArguments.slice(0, 2)).toEqual(["/bin/sh", "-c"])
    expect(plan.serviceProgramArguments[2]).toContain("/usr/bin/sqlite3 -readonly")
    expect(plan.serviceProgramArguments[2]).toContain("/opt/mendcode loops daemon")
    expect(plan.serviceProgramArguments[2]).toContain('if [ "$state" = "0" ]; then exit 0; fi')
    expect(plan.serviceProgramArguments[2]).not.toContain("launchctl bootout")
    expect(loopServicePlist(plan)).toContain("<string>/bin/sh</string>")
  })

  test("builds a Linux user systemd unit with configurable directories", () => {
    const plan = loopServicePlan({
      projectRoot: "/work/repo",
      execute: true,
      reportOnly: true,
      command: "/usr/bin/mendcode",
      platform: "linux",
      serviceDir: "/tmp/systemd-user",
      logDir: "/tmp/mend-logs",
    })
    const unit = loopServiceSystemdUnit(plan)

    expect(plan.backend).toBe("systemd-user")
    expect(plan.definitionPath).toBe(`/tmp/systemd-user/${plan.label}.service`)
    expect(plan.stdoutPath).toBe(`/tmp/mend-logs/${plan.label}.log`)
    expect(plan.installCommand).toEqual(["systemctl", "--user", "enable", `${plan.label}.service`])
    expect(plan.startCommand).toEqual(["systemctl", "--user", "enable", "--now", `${plan.label}.service`])
    expect(unit).toContain("Restart=always")
    expect(unit).toContain("WorkingDirectory=/work/repo")
    expect(unit).toContain('Environment=MENDCODE_SHELL_CWD="/work/repo"')
  })

  test("builds a Windows scheduled task command", () => {
    const plan = loopServicePlan({
      projectRoot: "C:\\work\\repo",
      execute: true,
      reportOnly: true,
      command: "mendcode.exe",
      platform: "win32",
      serviceDir: "C:\\MendCode\\Loops",
      logDir: "C:\\MendCode\\Logs",
    })

    expect(plan.backend).toBe("scheduled-task")
    expect(plan.definitionPath).toContain("com.mendcode.loops.")
    expect(plan.installCommand[0]).toBe("schtasks.exe")
    expect(loopServiceWindowsCommand(plan)).toContain("mendcode.exe loops daemon")
    expect(loopServiceWindowsCommand(plan)).toContain(`MENDCODE_SHELL_CWD=${plan.projectRoot}`)
    expect(loopServiceWindowsCommand(plan)).toContain("--execute --report-only")
    expect(loopServiceWindowsCommand(plan)).toContain("--once")
    expect(loopServiceWindowsCommand(plan)).toContain("--quiet")
  })
})
