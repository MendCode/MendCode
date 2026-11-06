import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { b80Fixture } from "./b80-fixtures"
import { signal } from "./b29-fixtures"
import { POOR_TREE_HINT, poorObservation } from "../src/computer-hints"

// Apps whose content is a webview (Tauri, WebKit, Electron) show a handful of nodes until an assistive app asks. These tests cover
// the decisions with fakes; the real attribute calls need such an app and are checked by hand (see docs/computer.md).
const node = (id: string, role: string, actions: string[] = []) => ({ id, role, name: "", states: ["enabled"], actions }) as never

test("a small tree with no web page is poor; a page or a pressable link makes it rich", () => {
  const few = [node("1", "AXWindow"), node("2", "AXButton", ["press"])]
  expect(poorObservation(few)).toBe(true)
  expect(poorObservation([...few, node("3", "AXWebArea")])).toBe(false)
  expect(poorObservation([...few, node("3", "AXLink", ["press"])])).toBe(false)
  expect(poorObservation(Array.from({ length: 13 }, (_, i) => node(String(i), "AXGroup")))).toBe(false)
})

const fixtures: ReturnType<typeof b80Fixture>[] = []
afterEach(() => { for (const f of fixtures.splice(0)) f.close() })

test("observe adds the hint for a poor tree and leaves a rich one without it", async () => {
  const f = b80Fixture(); fixtures.push(f)
  const session = await f.start()
  f.ax.state.nodes = [node("0", "AXWindow"), node("0.1", "AXWebArea")]
  const rich = await f.port.observe!({ computerSessionID: session.computerSessionID }, signal())
  expect(JSON.parse(rich.output).hint).toBeUndefined()
  f.ax.state.nodes = [node("0", "AXWindow")]
  const poor = await f.port.observe!({ computerSessionID: session.computerSessionID }, signal())
  expect(JSON.parse(poor.output).hint).toBe(POOR_TREE_HINT)
})

// The helper's own decisions, compiled from the real source: `--web-plan` runs only them (no AX object, event or window).
const canCompile = process.platform === "darwin" && existsSync("/usr/bin/xcrun")
let dir = "", helper = ""
beforeAll(() => {
  if (!canCompile) return
  dir = mkdtempSync(path.join(tmpdir(), "mc-web-plan-"))
  helper = path.join(dir, "mendcode-computer")
  const compiled = Bun.spawnSync(["/usr/bin/xcrun", "swiftc", path.join(import.meta.dir, "../assets/computer.swift"), "-o", helper], { stderr: "pipe" })
  if (compiled.exitCode !== 0) throw new Error(compiled.stderr.toString())
}, 180_000)
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

function plan(cases: object[]) {
  const run = Bun.spawnSync([helper, "--web-plan"], { stdin: new TextEncoder().encode(cases.map((item) => JSON.stringify(item)).join("\n") + "\n") })
  return run.stdout.toString().trim().split("\n").map((line) => JSON.parse(line) as { poor: boolean; route: string })
}

test.skipIf(!canCompile)("the helper turns web accessibility on only for a poor tree", () => {
  expect(plan([{ count: 6 }, { count: 12 }, { count: 13 }, { count: 6, probe: true }]).map((item) => item.poor)).toEqual([true, true, false, false])
})

test.skipIf(!canCompile)("a key goes to the node, else to the app, and never past a secure field or a focus outside the window", () => {
  expect(plan([{ focusable: true }, { focusable: true, secure: true }, {}, { secure: true }, { outside: true }]).map((item) => item.route)).toEqual(["node", "node", "app", "refuse", "refuse"])
})
