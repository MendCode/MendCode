import { describe, expect, test } from "bun:test"
import { mkdir } from "fs/promises"
import { Effect } from "effect"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { LoopWorkflow } from "../../src/session/loop"
import { WithInstance } from "../../src/project/with-instance"
import { resolveMendProjectRoot } from "../../src/mend/config/paths"
import {
  DEFAULT_LOOP_SERVICE_LIMIT,
  loopServiceArgsFromConfig,
  loopServiceDefinition,
  loopServicePlan,
  loopServicePlist,
  loopServiceStart,
  loopServiceStop,
  loopServiceStatus,
  loopServiceSystemdUnit,
  loopServiceUninstall,
  loopServiceWindowsCommand,
  writeLoopServiceHealth,
} from "../../src/mend/runtime/loop-service"

function runLoop<A, E>(fx: Effect.Effect<A, E, LoopWorkflow.Service>) {
  return Effect.runPromise(fx.pipe(Effect.provide(LoopWorkflow.defaultLayer)))
}

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

  test("binds the service identity to the selected database channel and override", () => {
    const previousMendChannel = process.env.MENDCODE_CHANNEL
    const previousChannel = process.env.OPENCODE_CHANNEL
    const previousMendDb = process.env.MENDCODE_DB
    const previousDb = process.env.OPENCODE_DB
    const channel = `t20-${Date.now()}`
    try {
      process.env.MENDCODE_CHANNEL = channel
      process.env.OPENCODE_CHANNEL = channel
      delete process.env.MENDCODE_DB
      delete process.env.OPENCODE_DB
      expect(path.basename(loopServicePlan({ projectRoot: "/tmp/repo", platform: "darwin" }).databasePath)).toBe(`mendcode-${channel}.db`)

      process.env.MENDCODE_DB = "service.db"
      process.env.OPENCODE_DB = "service.db"
      expect(path.basename(loopServicePlan({ projectRoot: "/tmp/repo", platform: "darwin" }).databasePath)).toBe("service.db")
    } finally {
      if (previousMendChannel === undefined) delete process.env.MENDCODE_CHANNEL
      else process.env.MENDCODE_CHANNEL = previousMendChannel
      if (previousChannel === undefined) delete process.env.OPENCODE_CHANNEL
      else process.env.OPENCODE_CHANNEL = previousChannel
      if (previousMendDb === undefined) delete process.env.MENDCODE_DB
      else process.env.MENDCODE_DB = previousMendDb
      if (previousDb === undefined) delete process.env.OPENCODE_DB
      else process.env.OPENCODE_DB = previousDb
    }
  })

  test("builds a persistent project-scoped report-only daemon by default", () => {
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

  test("uses a batch limit that can wake several project loops per pass", () => {
    const plan = loopServicePlan({ projectRoot: "/tmp/repo", execute: true, reportOnly: true, platform: "darwin" })

    expect(DEFAULT_LOOP_SERVICE_LIMIT).toBeGreaterThan(1)
    expect(plan.limit).toBe(DEFAULT_LOOP_SERVICE_LIMIT)
    expect(plan.executable).toBe(process.env.MENDCODE_PUBLIC_BIN || "mend")
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
    expect(loopServiceWindowsCommand(plan)).not.toContain("--once")
    expect(loopServiceWindowsCommand(plan)).toContain("--quiet")
  })

  test("persists bounded scheduler health and reports service drift", async () => {
    await using dir = await tmpdir()
    const args = {
      projectRoot: dir.path,
      intervalMs: 1_000,
      command: process.execPath,
      execute: true,
      reportOnly: true,
      platform: "linux" as const,
      serviceDir: path.join(dir.path, "service"),
      logDir: path.join(dir.path, "logs"),
    }
    const plan = loopServicePlan(args)
    await mkdir(path.dirname(plan.definitionPath), { recursive: true })
    await Bun.write(plan.definitionPath, loopServiceDefinition(plan))
    await Promise.all([
      writeLoopServiceHealth(plan, { lastWakeAttempt: 121, degraded: false }),
      writeLoopServiceHealth(plan, { lastWakeAttempt: 122, degraded: false }),
    ])
    await writeLoopServiceHealth(plan, {
      lastWakeAttempt: 123,
      lastError: "scheduler failure ".repeat(500),
      degraded: true,
      updatedAt: Date.now(),
    })

    const status = await loopServiceStatus(args)
    expect(status).toMatchObject({
      projectRoot: dir.path,
      databasePath: plan.databasePath,
      definitionPath: plan.definitionPath,
      healthPath: plan.healthPath,
      lastWakeAttempt: 123,
      degraded: true,
    })
    expect(status.executablePath).toBe(process.execPath)
    expect(status.executableFingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(status.executableVersion).toBeString()
    expect(status.lastError?.length).toBeLessThanOrEqual(1_000)
    expect(status.drift).toContain("scheduler-degraded")

    await Bun.write(plan.definitionPath, "stale service definition")
    const drifted = await loopServiceStatus(args)
    expect(drifted.drift).toEqual(expect.arrayContaining(["definition-drift", "definition-fingerprint-drift"]))
  })

  test.skipIf(process.env.MENDCODE_RUN_LOOP_SERVICE_SMOKE !== "1")(
    "manual installed-service smoke; uses MENDCODE_MANUAL_COMMAND (default: mend)",
    async () => {
      await using dir = await tmpdir()
      const projectRoot = resolveMendProjectRoot()
      const execute = process.env.MENDCODE_MANUAL_EXECUTE === "1"
      const args = {
        projectRoot,
        intervalMs: 60_000,
        limit: 10,
        execute,
        reportOnly: execute,
        command: process.env.MENDCODE_MANUAL_COMMAND || "mend",
        platform: process.platform,
        serviceDir: path.join(dir.path, "service"),
        logDir: path.join(dir.path, "logs"),
      }
      const plan = loopServicePlan(args)
      const readHealth = async () => {
        let status = await loopServiceStatus(args)
        for (let attempt = 0; attempt < 20 && !status.healthUpdatedAt; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 250))
          status = await loopServiceStatus(args)
        }
        return status
      }
      let manualLoopID: LoopWorkflow.LoopID | undefined

      try {
        const draft = await WithInstance.provide({
          directory: projectRoot,
          fn: () => runLoop(LoopWorkflow.Service.use((loop) => loop.createDraft({
            name: `T21 manual service smoke ${process.pid}`,
            objective: "Exercise the installed loop service health path without provider execution.",
            trigger: { mode: "interval", intervalMs: args.intervalMs },
            budgetMode: "unbounded-monitor",
          }))),
        })
        manualLoopID = draft.id
        await WithInstance.provide({
          directory: projectRoot,
          fn: () => runLoop(LoopWorkflow.Service.use((loop) => loop.activate({
            id: draft.id,
            reason: "T21 manual service smoke",
            now: Date.now() - 1_000,
          }))),
        })

        await loopServiceStart(args)
        const started = await readHealth()
        expect(started.installed).toBe(true)
        expect(started.projectRoot).toBe(projectRoot)
        expect(started.databasePath).toBe(plan.databasePath)
        expect(started.definitionPath).toBe(plan.definitionPath)
        expect(started.healthUpdatedAt).toBeDefined()
        expect(started.executablePath).toBeDefined()
        expect(started.executableVersion).toBeDefined()
        expect(started.executableFingerprint).toMatch(/^[a-f0-9]{64}$/)
        expect(started.drift).not.toContain("project-drift")
        expect(started.drift).not.toContain("database-drift")
        expect(started.drift).not.toContain("definition-drift")

        await loopServiceStop(args)
        await loopServiceStart(args)
        const restarted = await readHealth()
        expect(restarted.projectRoot).toBe(projectRoot)
        expect(restarted.databasePath).toBe(plan.databasePath)
        expect(restarted.executableFingerprint).toBe(started.executableFingerprint)
      } finally {
        await loopServiceStop(args).catch(() => undefined)
        await loopServiceUninstall(args).catch(() => undefined)
        if (manualLoopID) {
          await WithInstance.provide({
            directory: projectRoot,
            fn: () => runLoop(LoopWorkflow.Service.use((loop) => loop.delete(manualLoopID!))),
          }).catch(() => undefined)
        }
      }
    },
  )
})
