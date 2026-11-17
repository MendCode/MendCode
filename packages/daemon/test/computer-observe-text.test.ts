import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ComputerCodeReport, ComputerNode, ComputerObserveReport } from "@mendcode/protocol"
import { b80Fixture, data } from "./b80-fixtures"
import { signal } from "./b29-fixtures"
import { renderTree, shownMap, treeChanges } from "../src/computer-tree"
import { APP_SCOPE_HINT } from "../src/computer-sessions"

// Demo AX only: these tests never launch, observe or modify any real application.
const fixtures: ReturnType<typeof b80Fixture>[] = []
afterEach(() => { for (const f of fixtures.splice(0)) f.close() })
function fixture() { const f = b80Fixture(); fixtures.push(f); return f }
const node = (id: string, depth: number, role: string, name = "", extra: Partial<ComputerNode> = {}): ComputerNode => ({ id, role, name, states: ["enabled"], actions: [], depth, ...extra })
const look = async (f: ReturnType<typeof fixture>, id: string, extra: { full?: boolean; screenshot?: boolean } = {}) => data<ComputerObserveReport>(await f.port.observe!({ computerSessionID: id, ...extra }, signal()))

test("the tree is text, one node per line under its parent; unnamed structure is left out and its children move up", () => {
  const tree = renderTree([
    node("0.1", 0, "AXWindow", "Notes", { bounds: { x: 10.4, y: 20, width: 800, height: 600 } }),
    node("0.2", 1, "AXGroup"),
    node("0.3", 2, "AXButton", "Save", { actions: ["press", "click", "key", "scroll", "drag"] }),
    node("0.4", 2, "AXTextField", "Title", { value: "Draft", actions: ["setValue", "typeText"], states: ["enabled", "focused"] }),
    node("0.5", 1, "AXMenu"),
    node("0.6", 2, "AXMenuItem"),
    node("0.7", 2, "AXMenuItem", "Copy", { states: [] }),
    node("0.8", 2, "AXMenuItem", "Paste", { actions: ["press"] }),
    node("0.9", 1, "AXSecureTextField", "", { secure: true, states: ["secure"] }),
  ])
  expect(tree).toBe([
    '0.1 Window "Notes" @10,20 800x600',
    '  0.3 Button "Save" [press,ptr]',
    '  0.4 TextField "Title" ="Draft" [setValue,typeText] {focused}',
    '  0.8 MenuItem "Paste" [press]',
    "  0.9 SecureTextField (secure)",
  ].join("\n"))
})

test("what changed since the last look: nothing, a short list, or the whole tree when most of it changed", () => {
  const before = [node("0.1", 0, "AXWindow", "W"), ...Array.from({ length: 40 }, (_, i) => node(`0.${i + 2}`, 1, "AXButton", `B${i}`, { actions: ["press"] }))]
  expect(treeChanges(shownMap(before), shownMap(before))).toEqual({ unchanged: true })
  const after = structuredClone(before)
  after[2]!.name = "Renamed"; after.splice(3, 1); after.push(node("0.99", 1, "AXStaticText", "Done"))
  expect(treeChanges(shownMap(before), shownMap(after))).toEqual({ changes: ['~ 0.3 Button "Renamed" [press]', '+ 0.99 StaticText "Done"', '- 0.4 Button "B2" [press]'].join("\n") })
  const rebuilt = before.map((one, i) => i ? { ...one, id: `0.${i + 100}` } : one)
  expect(treeChanges(shownMap(before), shownMap(rebuilt))).toBeUndefined()
})

test("computer_observe sends the whole tree once, then only unchanged or the changes, and the whole tree again on full", async () => {
  const f = fixture(), session = await f.start()
  const first = await look(f, session.computerSessionID)
  expect(first.tree).toContain('0.1 Button "Save" [press]')
  expect(first).not.toHaveProperty("nodes")
  expect(first.nodeCount).toBe(4)
  const second = await look(f, session.computerSessionID)
  expect(second).toMatchObject({ revision: 2, unchanged: true, nodeCount: 4 })
  expect(second.tree).toBeUndefined()
  f.ax.state.nodes[2]!.value = "draft two"
  const third = await look(f, session.computerSessionID)
  expect(third.changes).toBe('~ 0.2 TextField "Search" ="draft two" [setValue]')
  expect((await look(f, session.computerSessionID, { full: true })).tree).toContain("draft two")
  // An unchanged answer is still a fresh observation: its revision authorizes the next action on the IDs already seen.
  const control = await f.start("control")
  await look(f, control.computerSessionID)
  const again = await look(f, control.computerSessionID)
  expect(again.unchanged).toBe(true)
  const pressed = data<ComputerCodeReport>(await f.port.code!({ computerSessionID: control.computerSessionID, code: `return await tools.press({revision:${again.revision},nodeID:'0.1'})` }, signal()))
  expect(pressed.ok).toBe(true)
})

test("an action whose effect is seen when the app is read again is verified; one with no visible change is not, and says to check", async () => {
  const f = fixture(), session = await f.start("control")
  const unseen = data<ComputerCodeReport>(await f.port.code!({ computerSessionID: session.computerSessionID, code: "return await tools.press({name:'Save'})" }, signal()))
  expect(unseen.value).toMatchObject({ outcome: "dispatched", verified: false, after: { effect: "none_seen", changed: [] } })
  expect((unseen.value as { next: string }).next).toContain("No change was seen")
  f.ax.state.onAction = async () => { f.ax.state.nodes.push({ id: "0.9", role: "AXStaticText", name: "Saved", states: ["enabled"], actions: [] }) }
  const seen = data<ComputerCodeReport>(await f.port.code!({ computerSessionID: session.computerSessionID, code: "return await tools.press({name:'Save'})" }, signal()))
  expect(seen.value).toMatchObject({ verified: true, after: { effect: "changed", changed: [{ id: "0.9", name: "Saved" }] } })
})

/** A running app with no focused window, as the helper reports it: the app, its windows (listed), its menu bar and status item. */
function windowless(f: ReturnType<typeof fixture>) {
  const nodes = [
    node("0.1", 0, "AXApplication", "Tray", { actions: ["key"] }),
    node("0.2", 1, "AXWindow", "Settings", { states: ["enabled", "minimized"] }),
    node("0.3", 1, "AXMenuBar"),
    node("0.4", 2, "AXMenuBarItem", "File", { actions: ["press"] }),
    node("0.5", 3, "AXMenuItem", "New Window", { actions: ["press"] }),
    node("0.6", 1, "AXMenuBar"),
    node("0.7", 2, "AXMenuBarItem", "Tray status", { actions: ["press", "click", "key", "scroll", "drag"], bounds: { x: 900, y: 0, width: 24, height: 24 } }),
  ]
  f.ax.os.observe = async () => ({ nodes: structuredClone(nodes), truncated: false, scope: "app" })
  return nodes
}

test("observing an app with no focused window returns its windows, menu bar and status item, and a hint to act on them", async () => {
  const f = fixture(), session = await f.start("control")
  windowless(f)
  const report = await look(f, session.computerSessionID)
  expect(report.scope).toBe("app")
  expect(report.hint).toBe(APP_SCOPE_HINT)
  expect(report.tree).toContain('0.2 Window "Settings" {minimized}')
  expect(report.tree).toContain('0.7 MenuBarItem "Tray status" [press,ptr]')
  // The status item is pressed like any node: through its element, in the background.
  const pressed = data<ComputerCodeReport>(await f.port.code!({ computerSessionID: session.computerSessionID, code: "return await tools.press({name:'Tray status'})" }, signal()))
  expect(pressed.ok).toBe(true)
  expect(f.ax.actions.at(-1)).toMatchObject({ action: "press", nodeID: "0.7" })
  // A key goes to the app itself.
  const keyed = data<ComputerCodeReport>(await f.port.code!({ computerSessionID: session.computerSessionID, code: "return await tools.key({name:'Tray',key:'escape'})" }, signal()))
  expect(keyed.ok).toBe(true)
  expect(f.ax.actions.at(-1)).toMatchObject({ action: "key", nodeID: "0.1", role: "AXApplication" })
})

test("a listed window is restored by its node, and a windowless app is asked to reopen; the session follows the window", async () => {
  const f = fixture(), session = await f.start("control")
  windowless(f)
  const asked: unknown[] = []
  f.ax.os.selectWindow = async (target, window) => { asked.push(window); return { ...target, windowID: "w-settings", windowName: "Settings", report: { focused: true, restored: true, minimized: false } } }
  f.ax.os.reopen = async (target) => ({ target: { ...target, windowID: "w-new", windowName: "Tray" }, opened: true })
  const selected = data<ComputerCodeReport>(await f.port.code!({ computerSessionID: session.computerSessionID, code: "const o = await tools.observe({}); return await tools.selectWindow({nodeID: o.nodes.find(n => n.role === 'AXWindow').id})" }, signal()))
  expect(asked).toEqual([{ nodeID: "0.2" }])
  expect(selected.value).toMatchObject({ verified: true, restored: true, target: { windowID: "w-settings" } })
  const notWindow = await f.port.code!({ computerSessionID: session.computerSessionID, code: "await tools.observe({}); return await tools.selectWindow({nodeID:'0.4'})" }, signal())
  expect(notWindow.output).toContain("must be a window")
  const reopened = data<ComputerCodeReport>(await f.port.code!({ computerSessionID: session.computerSessionID, code: "return await tools.reopen({})" }, signal()))
  expect(reopened.value).toMatchObject({ opened: true, verified: true, target: { windowID: "w-new", pid: 42 } })
  const observer = await f.start("observe")
  expect((await f.port.code!({ computerSessionID: observer.computerSessionID, code: "return await tools.reopen({})" }, signal())).output).toContain("observe-only")
})

test("screenshot:true attaches a capture of just the observed window", async () => {
  const f = fixture(), session = await f.start()
  f.ax.state.nodes[0]!.bounds = { x: 100.5, y: 50, width: 640.2, height: 480 }
  const result = await f.port.observe!({ computerSessionID: session.computerSessionID, screenshot: true }, signal())
  const report = JSON.parse(result.output) as ComputerObserveReport & { screenshot: { region: string } }
  expect(result.images).toHaveLength(1)
  expect(report.screenshot).toMatchObject({ region: "the observed window" })
  expect(report.screenshotFallback).toBeUndefined()
  expect(f.os.calls.find((call) => call[0] === "/usr/sbin/screencapture" && call.includes("-R"))).toContain("100,50,641,480")
})

// The helper's own decisions, compiled from the real source: `--scope-plan` runs only them (no AX object, event or window).
const canCompile = process.platform === "darwin" && existsSync("/usr/bin/xcrun")
let dir = "", helper = ""
beforeAll(() => {
  if (!canCompile) return
  dir = mkdtempSync(path.join(tmpdir(), "mc-scope-plan-"))
  helper = path.join(dir, "mendcode-computer")
  const compiled = Bun.spawnSync(["/usr/bin/xcrun", "swiftc", path.join(import.meta.dir, "../assets/computer.swift"), "-o", helper], { stderr: "pipe" })
  if (compiled.exitCode !== 0) throw new Error(compiled.stderr.toString())
}, 180_000)
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })
function plan(cases: object[]) {
  const run = Bun.spawnSync([helper, "--scope-plan"], { stdin: new TextEncoder().encode(cases.map((item) => JSON.stringify(item)).join("\n") + "\n") })
  return run.stdout.toString().trim().split("\n").map((line) => JSON.parse(line) as { scope: string; children: string })
}

test.skipIf(!canCompile)("with no focused window the helper observes the application instead of failing; a closed window is followed, a new focus is not", () => {
  expect(plan([
    { focused: false },
    { focused: false, selected: true, selectedOpen: true },
    { focused: true },
    { focused: true, selected: true, selectedFocused: true },
    { focused: true, selected: true, selectedOpen: false },
    { focused: true, selected: true, selectedOpen: true },
    { focused: true, selected: true, known: false },
  ]).map((item) => item.scope)).toEqual(["app", "app", "window", "window", "window", "changed", "changed"])
})

test.skipIf(!canCompile)("the application scope lists windows without walking them, one level of the app's menus, and an open status menu", () => {
  expect(plan([
    { role: "AXWindow" },
    { role: "AXMenuBar", mainMenuBar: true },
    { role: "AXMenuBar" },
    { role: "AXMenuBarItem", mainMenuBar: true },
    { role: "AXMenuBarItem" },
    { role: "AXMenuBarItem", open: true },
    { role: "AXMenuItem" },
    { role: "AXMenuItem", open: true },
    { role: "AXMenu" },
  ]).map((item) => item.children)).toEqual(["none", "rest", "all", "all", "none", "all", "none", "all", "all"])
})
