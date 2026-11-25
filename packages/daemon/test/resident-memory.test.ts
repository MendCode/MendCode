import { expect, test } from "bun:test"
import { residentBytes, residentMemoryUsage } from "../src/resident-memory"

const psResidentBytes = () => Number(Bun.spawnSync(["ps", "-o", "rss=", "-p", String(process.pid)]).stdout.toString().trim()) * 1024

test.skipIf(process.platform === "win32")("the daemon's resident memory is the RSS that ps shows, not the macOS physical footprint", () => {
  const ours = residentBytes()
  const ps = psResidentBytes()
  expect(ps).toBeGreaterThan(0)
  // Read a moment apart, so a few MB of drift is allowed; the footprint Bun 1.4 reports on macOS is lower by more than that.
  expect(Math.abs(ours - ps)).toBeLessThan(Math.max(4 * 1048576, ps * 0.05))
})

test("the memory usage reply keeps every field and carries the resident size as rss", () => {
  const usage = residentMemoryUsage()
  expect(Object.keys(usage).sort()).toEqual(Object.keys(process.memoryUsage()).sort())
  expect(usage.rss).toBeGreaterThan(0)
  expect(usage.heapUsed).toBeGreaterThan(0)
})
