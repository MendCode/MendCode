import { afterAll, beforeAll, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// The native helper's pointer decision on recorded accessibility trees: `--pointer-plan` compiles the real helper and runs only the
// decision (no AX object, event or window). The trees are what Chromium reported for a credentials page's tabs: the window, page and
// tab list with their bounds as Brave reported them on GitHub (the tabs were unnamed list items there, with their links cut off by the
// old 12-level limit), and the list items' link and label as Chrome reported them on a local copy of that structure.
const canCompile = process.platform === "darwin" && existsSync("/usr/bin/xcrun")
let dir = "", helper = ""

beforeAll(async () => {
  if (!canCompile) return
  dir = mkdtempSync(path.join(tmpdir(), "mc-pointer-plan-"))
  helper = path.join(dir, "mendcode-computer")
  const compiled = Bun.spawnSync(["/usr/bin/xcrun", "swiftc", path.join(import.meta.dir, "../assets/computer.swift"), "-o", helper], { stderr: "pipe" })
  if (compiled.exitCode !== 0) throw new Error(compiled.stderr.toString())
}, 180_000)
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

type Node = { id: string; role: string; parent?: string; bounds?: [number, number, number, number]; press?: boolean }
const page: Node[] = [
  { id: "window", role: "AXWindow", bounds: [41, 41, 1471, 941] },
  { id: "web", role: "AXWebArea", parent: "window", bounds: [41, 74, 1471, 908] },
  { id: "main", role: "AXGroup", parent: "web", bounds: [41, 132, 1471, 285] },
  { id: "tabs", role: "AXGroup", parent: "main", bounds: [563, 226, 655, 44] },
  { id: "list", role: "AXList", parent: "tabs", bounds: [563, 226, 269, 44] },
  { id: "item-client", role: "AXGroup", parent: "list", bounds: [563, 234, 147, 28] },
  { id: "link-client", role: "AXLink", parent: "item-client", bounds: [563, 234, 147, 28], press: true },
  { id: "label-client", role: "AXStaticText", parent: "link-client", bounds: [578, 240, 117, 17] },
  { id: "item-keys", role: "AXGroup", parent: "list", bounds: [716, 234, 116, 28] },
  { id: "link-keys", role: "AXLink", parent: "item-keys", bounds: [716, 234, 116, 28], press: true },
  { id: "label-keys", role: "AXStaticText", parent: "link-keys", bounds: [731, 240, 86, 17] },
  { id: "banner-row", role: "AXGroup", parent: "main", bounds: [563, 280, 655, 41] },
  { id: "behind", role: "AXButton", parent: "banner-row", bounds: [563, 280, 103, 22], press: true },
  { id: "banner", role: "AXGroup", parent: "banner-row", bounds: [563, 280, 655, 41] },
  { id: "banner-text", role: "AXStaticText", parent: "banner", bounds: [563, 280, 99, 17] },
  { id: "search-row", role: "AXGroup", parent: "main", bounds: [563, 330, 655, 30], press: true },
  { id: "search", role: "AXTextField", parent: "search-row", bounds: [563, 330, 300, 30], press: true },
  { id: "other-window", role: "AXWindow", bounds: [600, 200, 400, 300] },
  { id: "other-button", role: "AXButton", parent: "other-window", bounds: [700, 230, 150, 40], press: true },
]
const center = (id: string) => { const [x, y, w, h] = page.find((node) => node.id === id)!.bounds!; return [x + w / 2, y + h / 2] }

function plan(cases: { node: string; hit: string; click?: boolean }[]) {
  const input = cases.map((item) => JSON.stringify({ nodes: page, node: item.node, hit: item.hit, point: center(item.node), click: item.click ?? true })).join("\n") + "\n"
  const run = Bun.spawnSync([helper, "--pointer-plan"], { stdin: new TextEncoder().encode(input) })
  return run.stdout.toString().trim().split("\n").map((line) => JSON.parse(line) as { plan: string; element?: string })
}

test.skipIf(!canCompile)("a click on a visible tab inside unnamed groups presses its link, whatever Chromium answers at its center", () => {
  expect(plan([
    // The unnamed list item, with the app answering its label, the item itself, or the list around it (old: "obscured").
    { node: "item-keys", hit: "label-keys" },
    { node: "item-keys", hit: "item-keys" },
    { node: "item-keys", hit: "list" },
    // The label itself, with Chromium answering the label's link (old: "obscured").
    { node: "label-keys", hit: "link-keys" },
    { node: "link-keys", hit: "label-keys" },
  ])).toEqual(Array(5).fill({ plan: "press", element: "link-keys" }))
})

test.skipIf(!canCompile)("something else at the center still covers the node, and is named", () => {
  expect(plan([
    { node: "behind", hit: "banner-text" },
    { node: "item-keys", hit: "web" },
    { node: "item-keys", hit: "other-button" },
  ])).toEqual([{ plan: "covered", element: "banner-text" }, { plan: "covered", element: "web" }, { plan: "covered", element: "other-button" }])
})

test.skipIf(!canCompile)("right and double clicks, and a click into a text field, stay pointer events at the reached node", () => {
  expect(plan([
    { node: "item-keys", hit: "label-keys", click: false },
    { node: "search", hit: "search" },
  ])).toEqual([{ plan: "post" }, { plan: "post" }])
})
