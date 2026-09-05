import { test, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"
import { readBackendPhase, waitForBackend } from "../../src/installation/backend-startup"

test("a slow child preparation outlives the connection deadline without being killed", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "progress.json")
  const module = path.resolve(import.meta.dir, "../../src/installation/backend-startup.ts")
  const child = Bun.spawn([process.execPath, "-e", `import { reportBackendPhase } from ${JSON.stringify(module)}; reportBackendPhase('backup'); await Bun.sleep(250); reportBackendPhase('migration'); await Bun.sleep(100); reportBackendPhase('ready'); await Bun.sleep(2000)`], {
    env: { ...process.env, MENDCODE_BACKEND_STARTUP_FILE: file, MENDCODE_BACKEND_STARTUP_TOKEN: "test-owner" },
    stdout: "ignore", stderr: "pipe",
  })
  try {
    const until = Date.now() + 5000
    while (!readBackendPhase(file, child.pid, "test-owner") && Date.now() < until) await Bun.sleep(10)
    const phases: string[] = []
    const result = await waitForBackend({
      connect: async () => readBackendPhase(file, child.pid, "test-owner") === "ready" ? "connected" : undefined,
      alive: () => child.exitCode === null,
      phase: () => readBackendPhase(file, child.pid, "test-owner"),
      progress: phase => { phases.push(phase) }, timeoutMs: 50, preparationTimeoutMs: 1500, pollMs: 5,
    })
    expect(result).toBe("connected")
    expect(phases).toEqual(["backup", "migration", "ready"])
    expect(child.exitCode).toBeNull()
    expect(readBackendPhase(file, child.pid + 1, "test-owner")).toBeUndefined()
    expect(readBackendPhase(file, child.pid, "another-owner")).toBeUndefined()
  } finally { child.kill(); await child.exited }
})

test("missing progress and stuck preparation remain bounded; dead and failed children stop immediately", async () => {
  for (const phase of [undefined, "backup", "failed"] as const) {
    let connections = 0
    expect(await waitForBackend({ connect: async () => { connections++ }, alive: () => true,
      phase: () => phase, progress: () => {}, timeoutMs: 20, preparationTimeoutMs: 40, pollMs: 5 })).toBeUndefined()
    expect(connections > 0).toBe(phase !== "failed")
  }
  let called = false
  await waitForBackend({ connect: async () => { called = true }, alive: () => false,
    phase: () => "backup", progress: () => {} })
  expect(called).toBe(false)
})
