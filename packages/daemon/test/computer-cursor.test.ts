import { afterAll, beforeAll, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// The real helper, compiled once: its cursor travel time (`--cursor-path`), its cursor drawn offscreen (`--cursor-render`, no window is
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

type Travel = { durationMs: number }
function travel(moves: { from: [number, number]; to: [number, number] }[]): Travel[] {
  const run = Bun.spawnSync([helper, "--cursor-path"], { stdin: new TextEncoder().encode(moves.map((move) => JSON.stringify(move)).join("\n") + "\n") })
  return run.stdout.toString().trim().split("\n").map((line) => JSON.parse(line))
}

test.skipIf(!canCompile)("the cursor travels for 40 to 120 ms, growing with the square root of the distance, and not at all for a point it already holds", () => {
  const [short, medium, long, still] = travel([
    { from: [0, 0], to: [10, 0] },
    { from: [0, 0], to: [200, 0] },
    { from: [0, 0], to: [1800, 900] },
    { from: [50, 50], to: [51, 50] },
  ])
  expect(short!.durationMs).toBe(40)
  // 4 × √200
  expect(medium!.durationMs).toBe(Math.round(4 * Math.sqrt(200)))
  expect(long!.durationMs).toBe(120)
  expect(still!.durationMs).toBe(0)
})

test.skipIf(!canCompile)("the cursor is MendCode's own: a dot in its accent colour in a white ring with a dark rim, and its action in a black tag to its right", () => {
  // Stage points, y up: the dot's center is at (130, 60); then its white ring, its dark rim, the tag's background past the gap, and empty space.
  const run = Bun.spawnSync([helper, "--cursor-render", "Click"], { stdin: new TextEncoder().encode("[130,60]\n[136,60]\n[138,60]\n[152,60]\n[20,20]\n") })
  const [core, ring, rim, tag, empty] = run.stdout.toString().trim().split("\n").map((line) => JSON.parse(line) as number[])
  expect(core).toEqual([255, 107, 107, 255])
  expect(ring).toEqual([255, 255, 255, 255])
  expect(Math.max(...rim!.slice(0, 3))).toBeLessThan(30)
  expect(rim![3]).toBe(255)
  // The tag is near black, nearly opaque.
  expect(Math.max(...tag!.slice(0, 3))).toBeLessThan(40)
  expect(tag![3]).toBeGreaterThan(240)
  expect(empty).toEqual([0, 0, 0, 0])
})

test.skipIf(!canCompile)("helpers running at once take different accents, and an accent is free again once its helper exits", async () => {
  const registry = path.join(dir, "accents")
  const hold = () => {
    const child = Bun.spawn([helper, "--cursor-accent", registry], { stdin: "pipe", stdout: "pipe" })
    const reader = child.stdout.getReader()
    return { child, index: reader.read().then(({ value }) => Number(new TextDecoder().decode(value).trim())) }
  }
  const held = Array.from({ length: 8 }, hold)
  const indexes: number[] = []
  for (const one of held) indexes.push(await one.index)
  // Eight accents, eight helpers: every one differs.
  expect(new Set(indexes).size).toBe(8)
  held[3]!.child.stdin.end()
  await held[3]!.child.exited
  const next = hold()
  expect(await next.index).toBe(indexes[3]!)
  for (const one of [...held, next]) { one.child.stdin.end(); await one.child.exited }
}, 60_000)

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
