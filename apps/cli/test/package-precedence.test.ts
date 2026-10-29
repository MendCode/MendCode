import { afterEach, expect, test } from "bun:test"
import { createExtensionRuntime } from "../src/extensions/runtime"
import { discoverExtensions } from "../src/extensions/discover"
import { terminalClaims } from "../src/ui/app/precedence"
import { describePrecedence, resolvePrecedence } from "@mendcode/protocol/wire"
import { extension, scratch } from "./extensions-harness"

/** The terminal half of the precedence report: what extensions register, in the daemon's layer order. */

const temporary: Array<{ cleanup(): void }> = []
afterEach(() => { for (const temp of temporary.splice(0)) temp.cleanup() })

const body = "api.view('message.assistant', () => undefined)\napi.key('alt+q', () => {})\napi.command('hello', 'x', () => {})\napi.widget('sidebar', 'card', { title: 'c', render: () => undefined })"

test("views, keys, widgets and commands name the layer in force and the ones it overrides, in the daemon's order", async () => {
  const temp = scratch()
  temporary.push(temp)
  temp.write("data/packages/pk/extensions/a.ts", extension("from-user-package", body))
  temp.write("data/extensions/b.ts", extension("from-user-folder", body))
  temp.write("project/.mendcode/extensions/c.ts", extension("from-project", body))
  const runtime = createExtensionRuntime({ redraw() {} })
  await runtime.load(discoverExtensions({ dataDir: temp.dataDir, directory: temp.project }))
  expect(runtime.problems).toHaveLength(0)
  const rows = resolvePrecedence(terminalClaims({ activation: undefined, runtime: runtime.claims(), runtimeProfile: [], keybindingFile: [], kept: new Set() }))
  for (const [surface, name] of [["views", "message.assistant"], ["keybindings", "alt+q"], ["commands", "/hello"], ["widgets", "sidebar:card"]] as const) {
    const row = rows.find((candidate) => candidate.surface === surface && candidate.name === name)
    expect(row, `${surface} ${name}`).toBeDefined()
    expect(row!.effective, surface).toEqual([{ layer: "project" }])
    expect(row!.overridden.map((entry) => entry.layer), surface).toEqual(["user", "package user:pk"])
  }
  const text = describePrecedence(rows, { onlyConflicts: true }).flatMap((section) => section.lines)
  expect(text).toContain("- message.assistant: project · overrides user, package user:pk")
  runtime.dispose()
  expect(runtime.claims()).toEqual([])
})

test("a profile key the package changes lists your settings as overridden; a key you kept wins again", () => {
  const rows = resolvePrecedence(terminalClaims({
    activation: { problems: [], keybindings: [], result: { rows: [
      { part: "profile", key: "density", package: "user:retro", value: "compact", base: "comfortable", kept: false },
      { part: "profile", key: "userLead", package: "user:retro", value: "»", base: "›", kept: true },
      { part: "keybinding", key: "alt+g", package: "user:retro", value: "panel.toggle", kept: false },
    ], keybindings: [{ spec: "alt+g", action: "panel.toggle", package: "user:retro" }] } } as never,
    runtime: [],
    runtimeProfile: [],
    keybindingFile: [{ spec: "alt+g", action: "messages.open", target: { kind: "direct", seqs: ["alt+g"] } } as never],
    kept: new Set(),
  }))
  expect(rows.find((row) => row.surface === "profile" && row.name === "density")).toEqual({ surface: "profile", name: "density", effective: [{ layer: "package user:retro", note: "profile" }], overridden: [{ layer: "your settings" }], inactive: [] })
  expect(rows.find((row) => row.surface === "profile" && row.name === "userLead")!.effective).toEqual([{ layer: "you (kept)" }])
  const keys = rows.find((row) => row.surface === "keybindings" && row.name === "alt+g")!
  expect(keys.effective).toEqual([{ layer: "package user:retro" }])
  expect(keys.overridden).toEqual([{ layer: "your keybindings.json" }])
})
