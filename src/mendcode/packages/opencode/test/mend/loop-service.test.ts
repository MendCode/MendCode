import { describe, expect, test } from "bun:test"
import path from "path"
import { loopServicePlan, loopServicePlist, loopServiceSystemdUnit, loopServiceWindowsCommand } from "../../src/mend/runtime/loop-service"

describe("loop service plans", () => {
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
    expect(plist).toContain("<key>WorkingDirectory</key>")
    expect(plist).toContain("/tmp/acme &amp; &quot;repo&quot;")
    expect(plist).toContain("<key>KeepAlive</key>")
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
    expect(loopServiceWindowsCommand(plan)).toContain("--execute --report-only")
    expect(loopServiceWindowsCommand(plan)).toContain("--quiet")
  })
})
