import { describe, expect, test } from "bun:test"
import path from "path"
import { dreamServicePlan, dreamServicePlist, dreamServiceSystemdUnit, dreamServiceWindowsCommand } from "../../src/mend/runtime/dream-service"

describe("dream service plans", () => {
  test("builds a global Dream daemon by default", () => {
    const plan = dreamServicePlan({
      intervalMs: 5000,
      command: "/usr/local/bin/mendcode",
      platform: "darwin",
      workingDirectory: "/Users/test",
    })

    expect(plan.label).toBe("com.mendcode.dream")
    expect(plan.backend).toBe("launchd")
    expect(plan.workingDirectory).toBe(path.resolve("/Users/test"))
    expect(plan.definitionPath).toContain("Library/LaunchAgents")
    expect(plan.programArguments).toEqual([
      "/usr/bin/env",
      expect.stringContaining("PATH="),
      "/usr/local/bin/mendcode",
      "memory",
      "dream",
      "daemon",
      "--interval-ms",
      "5000",
      "--once",
      "--quiet",
    ])
  })

  test("renders XML-safe plist content", () => {
    const plan = dreamServicePlan({
      workingDirectory: '/tmp/acme & "repo"',
      command: "/opt/mendcode",
      platform: "darwin",
    })
    const plist = dreamServicePlist(plan)

    expect(plist).toContain("<key>ProgramArguments</key>")
    expect(plist).toContain("<key>EnvironmentVariables</key>")
    expect(plist).toContain("<key>MENDCODE_MEMORY_DIR</key>")
    expect(plist).toContain("<key>WorkingDirectory</key>")
    expect(plist).toContain("/tmp/acme &amp; &quot;repo&quot;")
    expect(plist).toContain("<key>StartInterval</key>")
    expect(plist).toContain("<integer>60</integer>")
    expect(plist).toContain("<key>RunAtLoad</key>\n  <false/>")
    expect(plist).not.toContain("<key>KeepAlive</key>")
  })

  test("gates macOS launches with native Dream window checks", () => {
    const plan = dreamServicePlan({
      command: "/opt/mendcode",
      platform: "darwin",
      workingDirectory: "/Users/test",
    })

    expect(plan.serviceProgramArguments.slice(0, 2)).toEqual(["/bin/sh", "-c"])
    expect(plan.serviceProgramArguments[2]).toContain("/usr/bin/plutil -extract")
    expect(plan.serviceProgramArguments[2]).toContain("TZ=\"$timezone\"")
    expect(plan.serviceProgramArguments[2]).toContain("/opt/mendcode memory dream daemon")
    expect(dreamServicePlist(plan)).toContain("<string>/bin/sh</string>")
  })

  test("builds a Linux user systemd unit with configurable directories", () => {
    const plan = dreamServicePlan({
      command: "/usr/bin/mendcode",
      platform: "linux",
      serviceDir: "/tmp/systemd-user",
      logDir: "/tmp/mend-logs",
      workingDirectory: "/tmp",
    })
    const unit = dreamServiceSystemdUnit(plan)

    expect(plan.backend).toBe("systemd-user")
    expect(plan.definitionPath).toBe(`/tmp/systemd-user/${plan.label}.service`)
    expect(plan.stdoutPath).toBe(`/tmp/mend-logs/${plan.label}.log`)
    expect(plan.installCommand).toEqual(["systemctl", "--user", "enable", `${plan.label}.service`])
    expect(plan.startCommand).toEqual(["systemctl", "--user", "enable", "--now", `${plan.label}.service`])
    expect(unit).toContain("Restart=always")
    expect(unit).toContain("WorkingDirectory=/tmp")
  })

  test("builds a Windows scheduled task command", () => {
    const plan = dreamServicePlan({
      command: "mendcode.exe",
      platform: "win32",
      serviceDir: "C:\\MendCode\\Dream",
      logDir: "C:\\MendCode\\Logs",
      workingDirectory: "C:\\Users\\test",
    })

    expect(plan.backend).toBe("scheduled-task")
    expect(plan.definitionPath).toContain("com.mendcode.dream")
    expect(plan.installCommand[0]).toBe("schtasks.exe")
    expect(dreamServiceWindowsCommand(plan)).toContain("mendcode.exe memory dream daemon")
    expect(dreamServiceWindowsCommand(plan)).toContain("--once")
    expect(dreamServiceWindowsCommand(plan)).toContain("--quiet")
  })

  test("quotes Windows scheduled task commands with Windows syntax", () => {
    const plan = dreamServicePlan({
      command: "C:\\Program Files\\MendCode\\mendcode.exe",
      platform: "win32",
      serviceDir: "C:\\MendCode\\Dream",
      logDir: "C:\\MendCode\\Logs",
      workingDirectory: "C:\\Users\\test",
    })
    const command = dreamServiceWindowsCommand(plan)

    expect(plan.programArguments[0]).toBe("C:\\Program Files\\MendCode\\mendcode.exe")
    expect(plan.programArguments).not.toContain("/usr/bin/env")
    expect(command).toContain('"C:\\\\Program Files\\\\MendCode\\\\mendcode.exe" memory dream daemon')
    expect(command).toContain("--once")
    expect(command).not.toContain("'C:\\Program Files")
  })
})
