import { afterEach, describe, expect, test } from "bun:test"
import type { ExtensionsReport } from "@mendcode/protocol"
import { createExtensionRuntime } from "../src/extensions/runtime"
import { discoverExtensions } from "../src/extensions/discover"
import { buildBindings } from "../src/extensions/keybindings"
import { createExtensionsPageState, extensionItems, extensionsPageKey, renderExtensionsPage } from "../src/view/extensions-page"
import { keymapRows } from "../src/view/keymap-page"
import { appHarness, extension, plain, scratch } from "./extensions-harness"

const temporary: Array<ReturnType<typeof scratch>> = []
afterEach(() => {
  for (const temp of temporary.splice(0)) temp.cleanup()
  ;(globalThis as { __coexist?: string[] }).__coexist = []
})
function sandbox() {
  const temp = scratch()
  temporary.push(temp)
  ;(globalThis as { __coexist?: string[] }).__coexist = []
  return temp
}
const marks = () => (globalThis as { __coexist?: string[] }).__coexist!

describe("key conflicts", () => {
  test("an extension key over a built-in or your keybindings.json is reported with who replaced what; two extensions name the loser", () => {
    const taken = buildBindings({ extensions: [{ spec: "ctrl+o", owner: "alpha", run() {} }] })
    expect(taken.bindings.overrides).toEqual([expect.objectContaining({ key: "ctrl+o", owner: "alpha", source: "built-in" })])
    expect(taken.problems).toEqual([])
    const rows = keymapRows(taken.bindings)
    expect(rows.find((row) => row.action === "extension:alpha")?.conflicts[0]).toContain("ctrl+o replaced")
    expect(rows.find((row) => row.action === taken.bindings.overrides![0]!.wasAction)?.conflicts).toContain("ctrl+o is taken by extension alpha")
    const both = buildBindings({ extensions: [{ spec: "f9", owner: "alpha", run() {} }, { spec: "f9", owner: "beta", run() {} }] })
    expect(both.problems).toEqual(["alpha: key f9 is also bound by beta, which loads later and wins"])
    expect(both.bindings.overrides).toBeUndefined()
  })

  test("a user's keybindings.json entry that an extension replaces is named as such; no collision adds no field", () => {
    const parsed = { entries: [{ spec: "f8", target: { kind: "direct" as const, seqs: ["\x1b[19~"], label: "f8" }, action: "usage" as const }], problems: [] }
    const built = buildBindings({ file: parsed.entries, extensions: [{ spec: "f8", owner: "gamma", run() {} }] })
    expect(built.bindings.overrides).toEqual([expect.objectContaining({ owner: "gamma", source: "keybindings.json" })])
    expect("overrides" in buildBindings({ extensions: [{ spec: "f9", owner: "delta", run() {} }] }).bindings).toBe(false)
  })
})

describe("terminal runtime", () => {
  test("two extensions with the same command or page id: the later wins and the replaced one is named", async () => {
    const temp = sandbox()
    temp.write("data/extensions/a-first.ts", extension("first", `api.command("deploy", "one", () => {}); api.page("p", { title: "P", render: () => [] })`))
    temp.write("data/extensions/b-second.ts", extension("second", `api.command("deploy", "two", () => {}); api.page("p", { title: "P2", render: () => [] })`))
    const runtime = createExtensionRuntime({ redraw() {} })
    await runtime.load(discoverExtensions({ dataDir: temp.dataDir, directory: temp.project }))
    expect(runtime.conflicts.map((entry) => [entry.winner, entry.loser])).toEqual([["second", "first"], ["second", "first"]])
    expect(runtime.conflicts[0]!.message).toBe("/deploy of first is replaced by second, which loads later")
    expect(runtime.commands()).toEqual([{ name: "deploy", description: "two" }])
    runtime.dispose()
  })

  test("a syntax error or a missing import is a failure found before importing, and the fixed file loads on the next revision", async () => {
    const temp = sandbox()
    const file = temp.write("data/extensions/look.ts", extension("look", `api.slot("footer.replace", () => [[{ text: "ONE" }]])`))
    const first = createExtensionRuntime({ redraw() {}, revision: 1 })
    await first.load(discoverExtensions({ dataDir: temp.dataDir, directory: temp.project }))
    expect(first.failed).toEqual([])
    temp.write("data/extensions/look.ts", "export default { name: 'look', tui(api) {")
    const broken = createExtensionRuntime({ redraw() {}, revision: 2 })
    await broken.load(discoverExtensions({ dataDir: temp.dataDir, directory: temp.project }))
    expect(broken.failed).toEqual([{ file, extension: "look", message: expect.stringContaining("failed to load") }])
    temp.write("data/extensions/look.ts", extension("look", `api.slot("footer.replace", () => [[{ text: "TWO" }]])\nimport "./nowhere"`).replace("import", "//"))
    const fixed = createExtensionRuntime({ redraw() {}, revision: 3 })
    await fixed.load(discoverExtensions({ dataDir: temp.dataDir, directory: temp.project }))
    expect(fixed.failed).toEqual([])
    expect(fixed.footerRows("footer.left", { width: 20, height: 4, now: 0, directory: "/p", state: "idle" })).toEqual([])
    expect(fixed.slot("footer.replace", { width: 20, height: 4, now: 0, directory: "/p", state: "idle" })?.[0]?.[0]?.text).toContain("TWO")
    for (const runtime of [first, broken, fixed]) runtime.dispose()
  })

  test("dispose runs every disposer once, however often it is called", async () => {
    const temp = sandbox()
    temp.write("data/extensions/clean.ts", extension("clean", `api.onDispose(() => globalThis.__coexist.push("disposed"))`))
    const runtime = createExtensionRuntime({ redraw() {} })
    await runtime.load(discoverExtensions({ dataDir: temp.dataDir, directory: temp.project }))
    runtime.dispose()
    runtime.dispose()
    expect(marks()).toEqual(["disposed"])
  })
})

describe("reload with a candidate", () => {
  test("a broken edit keeps the running extensions on screen and reports it; the fix swaps once and disposes the old copy once", async () => {
    const temp = sandbox()
    const keep = (text: string) => extension("keep", `globalThis.__coexist.push("setup"); api.onDispose(() => globalThis.__coexist.push("dispose")); api.slot("footer.replace", () => [[{ text: ${JSON.stringify(text)} }]])`)
    temp.write("data/extensions/keep.ts", keep("LAYOUT ONE"))
    temp.write("data/extensions/other.ts", extension("other", `api.slot("header.replace", () => [[{ text: "HEADER" }]])`))
    const harness = await appHarness({ dataDir: temp.dataDir, directory: temp.project })
    try {
      await harness.start({ onboarded: true })
      harness.message("question", "answer")
      expect(harness.text()).toContain("LAYOUT ONE")
      expect(marks()).toEqual(["setup"])

      // A syntax error in one file and a valid change in another: nothing is applied, the working layout stays.
      temp.write("data/extensions/other.ts", "export default { name: 'other', tui(api) {")
      temp.write("data/extensions/keep.ts", keep("LAYOUT TWO"))
      harness.sent.length = 0
      harness.app.onGlobal({ type: "extensions.changed", revision: 1, seq: 1, at: 0 } as never)
      await harness.app.extensionsReady
      harness.app.render()
      expect(harness.text()).toContain("LAYOUT ONE")
      expect(harness.text()).not.toContain("LAYOUT TWO")
      expect(harness.text()).toContain("HEADER")
      // The candidate's own disposer ran once; the running copy's did not.
      expect(marks()).toEqual(["setup", "setup", "dispose"])
      const report = harness.sent.find((command) => command.type === "extensions.report") as { errors: string[] }
      expect(report.errors[0]).toContain("the previous version is still running")

      // The fix: the candidate loads clean, takes over, and the previous copy is disposed exactly once.
      temp.write("data/extensions/other.ts", extension("other", `api.slot("header.replace", () => [[{ text: "HEADER TWO" }]])`))
      harness.app.onGlobal({ type: "extensions.changed", revision: 2, seq: 2, at: 0 } as never)
      await harness.app.extensionsReady
      harness.app.render()
      expect(harness.text()).toContain("LAYOUT TWO")
      expect(harness.text()).toContain("HEADER TWO")
      expect(marks()).toEqual(["setup", "setup", "dispose", "setup", "dispose"])
    } finally {
      await harness.key("\x03")
      await harness.key("\x03")
    }
  })

  test("on a reload the old copy's async disposer finishes before the new copy's onStart runs; a broken candidate never starts", async () => {
    const temp = sandbox()
    const helper = (label: string) => extension("helper", `api.onStart(() => globalThis.__coexist.push("start ${label}")); api.onDispose(async () => { globalThis.__coexist.push("stopping ${label}"); await new Promise((r) => setTimeout(r, 30)); globalThis.__coexist.push("stopped ${label}") })`)
    temp.write("data/extensions/helper.ts", helper("one"))
    const harness = await appHarness({ dataDir: temp.dataDir, directory: temp.project })
    try {
      await harness.start({ onboarded: true })
      expect(marks()).toEqual(["start one"])
      temp.write("data/extensions/helper.ts", helper("two"))
      harness.app.onGlobal({ type: "extensions.changed", revision: 1, seq: 1, at: 0 } as never)
      await harness.app.extensionsReady
      expect(marks()).toEqual(["start one", "stopping one", "stopped one", "start two"])
      temp.write("data/extensions/helper.ts", "export default { name: 'helper', tui(api) {")
      harness.app.onGlobal({ type: "extensions.changed", revision: 2, seq: 2, at: 0 } as never)
      await harness.app.extensionsReady
      expect(marks()).toEqual(["start one", "stopping one", "stopped one", "start two"])
    } finally {
      await harness.key("\x03")
      await harness.key("\x03")
    }
  })

  test("settings an extension asks for while it loads wait for the swap and never apply from a discarded candidate", async () => {
    const temp = sandbox()
    temp.write("data/extensions/theme.ts", extension("theme", `api.settings.set("density", "compact")`))
    temp.write("data/extensions/ok.ts", extension("ok", ``))
    const harness = await appHarness({ dataDir: temp.dataDir, directory: temp.project, reply: () => ({ ok: true }) })
    try {
      await harness.start({ onboarded: true })
      harness.sent.length = 0
      temp.write("data/extensions/ok.ts", "export default { name: 'ok', tui(api) {")
      temp.write("data/extensions/theme.ts", extension("theme", `api.settings.set("density", "spacious")`))
      harness.app.onGlobal({ type: "extensions.changed", revision: 1, seq: 1, at: 0 } as never)
      await harness.app.extensionsReady
      expect(JSON.stringify(harness.sent)).not.toContain("spacious")
    } finally {
      await harness.key("\x03")
      await harness.key("\x03")
    }
  })
})

describe("/extensions page", () => {
  const report: ExtensionsReport = {
    extensions: [
      { name: "alpha", source: "user", file: "/d/alpha.ts", daemon: true, tui: false, tools: ["big"], commands: ["deploy"], hooks: ["prompt.system"], errors: [], trusted: true, conflicts: ["/deploy of beta is hidden by alpha, which loads later"], context: { tokens: 412, tools: [{ name: "big", tokens: 412, offered: true }, { name: "huge", tokens: 900, offered: false }], rewrites: ["prompt.system"] } },
      { name: "beta", source: "user", file: "/d/beta.ts", daemon: true, tui: false, tools: [], commands: [], hooks: ["tool.before"], errors: ["tool.before: stopped for this session after 3 failures in a row; /extensions reload turns it back on"], trusted: true, breaker: ["tool.before#0"], kept: "load failed: Unexpected end of file" },
      { name: "gamma", source: "user", file: "/d/gamma.ts", daemon: false, tui: false, tools: [], commands: [], hooks: [], errors: [], trusted: true, disabled: true },
    ],
    conflicts: [{ kind: "command", name: "deploy", winner: "alpha", losers: ["beta"], note: "/deploy of beta is hidden by alpha, which loads later" }],
  }
  const draw = (tier: "minimalist" | "balanced" | "full" | undefined, open = false, width = 120, selected = 0) => {
    const items = extensionItems(report, [])
    return renderExtensionsPage({ state: { selected, open: open ? items.map((item) => item.key) : [] }, report, terminal: [], terminalProblems: [], ...(tier ? { tier } : {}), width, height: 40 }).map(plain).join("\n")
  }

  test("balanced and full show cost, collisions, stopped handlers, the kept version and what is disabled", () => {
    for (const tier of ["balanced", "full", undefined] as const) {
      const text = draw(tier)
      expect(text).toContain("~412+ tok")
      expect(text).toContain("1 conflict")
      expect(text).toContain("stopped")
      expect(text).toContain("kept old")
      expect(text).toContain("disabled")
      expect(text).toContain("/deploy of beta is hidden by alpha")
    }
    // The single-column layout of a narrow terminal has its own Conflicts section.
    expect(draw("balanced", false, 60)).toContain("Conflicts")
    expect(draw("balanced", false, 60)).toContain("/deploy of beta is hidden by alpha")
    const open = draw("balanced", true, 200)
    expect(open).toContain("context  ~412 tokens per request")
    expect(open).toContain("huge ~900 (not offered at your tier)")
    expect(open).toContain("prompt.system may rewrite what the model reads: cost not measured")
    const stopped = draw("balanced", true, 200, 1)
    expect(stopped).toContain("reload failed, the previous version keeps running")
    expect(stopped).toContain("stopped for this session after repeated failures: tool.before#0")
    expect(draw("balanced", true, 200, 2)).toContain("turned off: nothing of it runs")
  })

  test("minimalist keeps the page to what is broken: a count, no per-extension cost, no collision detail", () => {
    const text = draw("minimalist")
    expect(text).not.toContain("tok")
    expect(text).toContain("1 conflict")
    expect(text).toContain("/tier balanced shows which")
    expect(text).not.toContain("hidden by alpha")
    expect(draw("minimalist", true, 200)).not.toContain("context  ~")
    expect(draw("minimalist", false, 60)).toContain("something was replaced by another extension")
  })

  test("d turns the selected extension off by name, or back on when it already is", () => {
    const items = extensionItems(report, [])
    const on = extensionsPageKey(createExtensionsPageState(), "d", items, report)
    expect(on.action).toEqual({ type: "disable", name: "alpha", disabled: true })
    const off = extensionsPageKey({ ...createExtensionsPageState(), selected: 2 }, "d", items, report)
    expect(off.action).toEqual({ type: "disable", name: "gamma", disabled: false })
    const terminal = extensionItems(undefined, [{ name: "ui", slots: [], keys: [], commands: [], pages: [], renderers: [], transforms: 0, errors: [], enabled: false }])
    expect(extensionsPageKey(createExtensionsPageState(), "d", terminal).action).toEqual({ type: "disable", name: "ui", disabled: false })
    expect(extensionsPageKey(createExtensionsPageState(), "d", []).action).toEqual({ type: "none" })
  })

  test("pressing d in the app sends extensions.disable, updates the profile and reloads the report", async () => {
    const harness = await appHarness({
      width: 140,
      height: 40,
      reply: (command) => (command.type === "extensions.list" ? { ok: true, result: report } : command.type === "extensions.disable" ? { ok: true, result: { revision: 1, errors: [], terminalValidation: "complete" } } : undefined),
    })
    try {
      await harness.start({ onboarded: true })
      await harness.type("/extensions")
      await harness.key("\r")
      await Bun.sleep(5)
      harness.app.render()
      expect(harness.text()).toContain("alpha")
      harness.sent.length = 0
      await harness.key("d")
      await Bun.sleep(5)
      expect(harness.sent).toContainEqual(expect.objectContaining({ type: "extensions.disable", name: "alpha", disabled: true }))
      expect(harness.sent.filter((command) => command.type === "extensions.list")).toHaveLength(1)
    } finally {
      await harness.key("\x1b")
      await harness.key("\x03")
      await harness.key("\x03")
    }
  })
})

describe("extension feedback", () => {
  test("a toast from a daemon extension shows on the toast line and leaves the prompt, its focus and the transcript alone", async () => {
    const harness = await appHarness()
    try {
      await harness.start({ onboarded: true })
      harness.message("question", "answer")
      await harness.type("half a sentence")
      // The toast floats over the right of the chat column, and a short transcript now starts under the top bar: compare the left part.
      const transcript = () => harness.rows().filter((row) => row.includes("question") || row.includes("answer")).map((row) => row.slice(0, 30).trimEnd())
      const before = transcript()
      harness.app.onGlobal({ type: "extension.feedback", gseq: 0, at: 0, extension: "indexer", text: "indexed 40 files", level: "success" } as never)
      harness.app.render()
      expect(harness.text()).toContain("indexer: indexed 40 files")
      expect(harness.text()).toContain("half a sentence")
      expect(transcript()).toEqual(before)
      expect(harness.sent.filter((command) => command.type === "user.submit")).toEqual([])
    } finally {
      await harness.key("\x03")
      await harness.key("\x03")
    }
  })
})
