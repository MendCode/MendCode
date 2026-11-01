import { afterAll, beforeAll, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// The real helper, compiled once: its cursor travel (`--cursor-path`), its cursor drawn offscreen (`--cursor-render`, no window is
// shown) and its request loop answering refusals that sent nothing. No AX object is read, no event is posted, no app is touched.
const canCompile = process.platform === "darwin" && existsSync("/usr/bin/xcrun")
let dir = "", helper = ""

beforeAll(async () => {
  if (!canCompile) return
  dir = mkdtempSync(path.join(tmpdir(), "mc-cursor-"))
  helper = path.join(dir, "mendcode-computer")
  const compiled = Bun.spawnSync(["/usr/bin/xcrun", "swiftc", path.join(import.meta.dir, "../assets/computer.swift"), "-o", helper], { stderr: "pipe" })
  if (compiled.exitCode !== 0) throw new Error(compiled.stderr.toString())
}, 180_000)
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

type Travel = { durationMs: number; points: [number, number][] }
function travel(moves: { from: [number, number]; to: [number, number]; samples: number }[]): Travel[] {
  const run = Bun.spawnSync([helper, "--cursor-path"], { stdin: new TextEncoder().encode(moves.map((move) => JSON.stringify(move)).join("\n") + "\n") })
  return run.stdout.toString().trim().split("\n").map((line) => JSON.parse(line))
}

test.skipIf(!canCompile)("the cursor travels for 90 to 320 ms by Fitts's law, and not at all for a point it already holds", () => {
  const [short, medium, long, still] = travel([
    { from: [0, 0], to: [10, 0], samples: 2 },
    { from: [0, 0], to: [200, 0], samples: 2 },
    { from: [0, 0], to: [1800, 900], samples: 2 },
    { from: [50, 50], to: [51, 50], samples: 2 },
  ])
  expect(short!.durationMs).toBe(90)
  // 40 + 70 × log2(200 / 40 + 1)
  expect(medium!.durationMs).toBeCloseTo(40 + 70 * Math.log2(6), 6)
  expect(long!.durationMs).toBe(320)
  expect(still!.durationMs).toBe(0)
})

test.skipIf(!canCompile)("a move bows to one side, overshoots its target and lands exactly on it, the same way every time", () => {
  const move = { from: [100, 100] as [number, number], to: [700, 100] as [number, number], samples: 101 }
  const [first, again] = travel([move, move])
  expect(again).toEqual(first!)
  const points = first!.points
  expect(points[0]).toEqual([100, 100])
  expect(points.at(-1)).toEqual([700, 100])
  // The bow is 5.5 % of the distance, at most 38 points, plus a tremor of about a point; the overshoot is 3.5 % past the target.
  const sideways = Math.max(...points.map(([, y]) => Math.abs(y - 100)))
  expect(sideways).toBeGreaterThan(20)
  expect(sideways).toBeLessThan(38)
  const furthest = Math.max(...points.map(([x]) => x))
  expect(furthest).toBeGreaterThan(710)
  expect(furthest).toBeLessThan(700 + 600 * 0.035 + 2)
})

test.skipIf(!canCompile)("the cursor is a white dart with a dark rim, and its action label sits in a black pill below and right of the tip", () => {
  // Stage points, y up: the tip is at (160, 172); the dart's body, its rim below the lowest corner, the pill's left padding, empty space.
  const run = Bun.spawnSync([helper, "--cursor-render", "Click"], { stdin: new TextEncoder().encode("[171,161]\n[163.2,135.6]\n[183,130]\n[20,20]\n") })
  const [body, rim, pill, empty] = run.stdout.toString().trim().split("\n").map((line) => JSON.parse(line) as number[])
  expect(body).toEqual([255, 255, 255, 255])
  expect(rim![3]).toBe(255)
  expect(Math.max(...rim!.slice(0, 3))).toBeLessThan(40)
  expect(pill).toEqual([0, 0, 0, 255])
  expect(empty).toEqual([0, 0, 0, 0])
})

function requests(lines: string[]) {
  const run = Bun.spawnSync([helper], { stdin: new TextEncoder().encode(lines.join("\n") + "\n"), timeout: 30_000 })
  return run.stdout.toString().trim().split("\n").map((line) => JSON.parse(line) as { ok: boolean; error?: string; delivery?: string })
}

test.skipIf(!canCompile)("a refusal before any effect says nothing was delivered, for single actions and batches alike", () => {
  const replies = requests([
    JSON.stringify({ method: "action", target: { pid: 1, bundleID: "local.none" }, input: { nodeID: "0.1", action: "press" } }),
    JSON.stringify({ method: "batch", target: { pid: 1, bundleID: "local.none" }, steps: [{ nodeID: "0.1", action: "press" }] }),
    "{not json",
  ])
  expect(replies).toHaveLength(3)
  for (const reply of replies) expect(reply).toMatchObject({ ok: false, delivery: "not_delivered" })
  expect(replies[0]!.error).toContain("input lease")
})

test.skipIf(!canCompile)("an oversized request gets one refusal, and the request after it is still answered", () => {
  const replies = requests(["x".repeat(300_000), JSON.stringify({ method: "unknown" })])
  expect(replies).toEqual([{ ok: false, error: "Invalid bounded JSON request", delivery: "not_delivered" }, { ok: false, error: "Unknown native method", delivery: "not_delivered" }])
})
