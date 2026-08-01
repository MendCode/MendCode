import { describe, expect, test } from "bun:test"
import {
  formatBytes,
  formatDiagnostics,
  isProcessMemoryUsage,
  type ProcessMemoryUsage,
} from "../../../src/util/process-memory"

const sample: ProcessMemoryUsage = {
  pid: 123,
  role: "server",
  rss: 1024 ** 3,
  heapTotal: 512 * 1024 ** 2,
  heapUsed: 256 * 1024 ** 2,
  external: 4 * 1024 ** 2,
  arrayBuffers: 2 * 1024 ** 2,
  uptimeSeconds: 3661,
}

describe("process diagnostics", () => {
  test("formats process memory without starting a sampler", () => {
    const output = formatDiagnostics({
      tui: { ...sample, role: "tui" },
      server: {
        ...sample,
        sharedServer: {
          runtimeID: "runtime-test",
          stateOwner: true,
          activeClientLeases: 2,
        },
      },
      ui: {
        sessionCount: 12,
        cachedSessionCount: 3,
        cachedMessageCount: 24,
        cachedPartCount: 48,
        route: "session",
      },
    })

    expect(output).toContain("On-demand sample only")
    expect(output).toContain("TUI (pid 123, tui)")
    expect(output).toContain("Connected runtime (pid 123, server)")
    expect(output).toContain("RSS (RAM): 1.00 GiB")
    expect(output).toContain("Uptime: 1h 1m")
    expect(output).toContain("Shared server: 2 client lease(s) · state owner")
    expect(output).toContain("Runtime: runtime-test")
    expect(output).toContain("TUI counters: 12 loaded sessions · route session")
    expect(output).toContain("TUI cache: 3 sessions · 24 messages · 48 parts")
  })

  test("reports an unavailable connected runtime without hiding the TUI sample", () => {
    const output = formatDiagnostics({
      tui: { ...sample, role: "tui" },
      serverError: "connection refused",
    })

    expect(output).toContain("TUI (pid 123, tui)")
    expect(output).toContain("Connected runtime: unavailable (connection refused)")
  })

  test("validates remote samples before displaying them", () => {
    expect(isProcessMemoryUsage(sample)).toBe(true)
    expect(isProcessMemoryUsage({ ...sample, rss: "large" })).toBe(false)
    expect(isProcessMemoryUsage({ ...sample, sharedServer: { runtimeID: "test" } })).toBe(false)
    expect(isProcessMemoryUsage({ pid: 123 })).toBe(false)
  })

  test("formats byte units consistently", () => {
    expect(formatBytes(512)).toBe("512 B")
    expect(formatBytes(1024)).toBe("1.0 KiB")
    expect(formatBytes(1024 ** 2)).toBe("1.0 MiB")
    expect(formatBytes(1024 ** 3)).toBe("1.00 GiB")
  })
})
