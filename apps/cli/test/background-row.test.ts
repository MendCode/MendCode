import { describe, expect, test } from "bun:test"
import { backgroundRows } from "../src/view/background-row"

const NOW = 1_000_000
const plain = (rows: ReturnType<typeof backgroundRows>) => rows.map((row) => row.map((span) => span.text).join("").trimEnd())

describe("background work over the prompt", () => {
  test("nothing running: no row", () => {
    expect(backgroundRows({ items: [], full: false, width: 80, now: NOW, inset: 2 })).toEqual([])
  })

  test("compact (minimal and balanced): one row naming the single item, its kind and run time", () => {
    expect(plain(backgroundRows({ items: [{ command: "bun run dev", startedAt: NOW - 65_000 }], full: false, width: 80, now: NOW, inset: 2 }))).toEqual(["  ◇ background command · bun run dev · 1m 5s · /ps"])
  })

  test("compact with several: counts by kind on one row", () => {
    const items = [{ command: "a", kind: "agent" as const, startedAt: NOW }, { command: "b", startedAt: NOW }, { command: "c", kind: "command" as const, startedAt: NOW }]
    expect(plain(backgroundRows({ items, full: false, width: 80, now: NOW, inset: 0 }))).toEqual(["◇ 2 background commands · 1 background agent · /ps"])
  })

  test("full: one row per item up to three, then +N more", () => {
    const items = Array.from({ length: 5 }, (_, i) => ({ command: `job ${i}`, kind: i % 2 ? "agent" as const : "command" as const, startedAt: NOW - i * 1_000 }))
    expect(plain(backgroundRows({ items, full: true, width: 80, now: NOW, inset: 0 }))).toEqual([
      "◇ job 0  command · 0s · /ps",
      "◇ job 1  agent · 1s",
      "◇ job 2  command · 2s",
      "  +2 more · /ps",
    ])
  })

  test("a command's control characters never reach the screen, and a narrow width cuts the row", () => {
    const [row] = plain(backgroundRows({ items: [{ command: "a\x1b[31m\nb", startedAt: NOW }], full: false, width: 20, now: NOW, inset: 0 }))
    expect(row).not.toContain("\x1b")
    expect(row!.length).toBeLessThanOrEqual(20)
  })
})
