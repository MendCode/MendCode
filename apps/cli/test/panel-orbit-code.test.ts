import { afterEach, describe, expect, test } from "bun:test"
import { CODEGRAPH_OVERVIEW, type CodegraphOverview } from "@mendcode/protocol/wire"
import type { Line } from "../src/ui/theme"
import { ORBIT_MODE_KEY, renderOrbit, type OrbitCamera } from "../src/view/panel-orbit"
import { ORBIT_CODE_ROWS, codeOrbitDetails, codeOrbitGraph, codeOrbitValue, codeOrbitView, codeOverviewOf, type CodeOverviewReady } from "../src/view/panel-orbit-code"
import { textWidth } from "../src/view/wrap"
import { reviewFixture } from "./panel-review-fixture"
import { cleanTemps } from "./session-ui-harness"

/** The galaxy's code mode: the project's most connected files on the session's disc, asked for with one key and never before it. */
afterEach(cleanTemps)

const plain = (line: Line) => line.map((span) => span.text).join("")
const settle = () => Bun.sleep(30)

const PATHS = [
  "packages/daemon/src/daemon.ts", "packages/protocol/src/index.ts", "apps/cli/src/ui/app.ts", "packages/store/src/store.ts", "apps/cli/src/view/transcript.ts",
  "packages/engine-native/src/engine.ts", "packages/tools/src/tool.ts", "apps/cli/src/ui/app/context.ts", "packages/codegraph/src/index.ts", "packages/client/src/index.ts",
  "apps/cli/src/view/deck.ts", "packages/protocol/src/commands.ts",
]
function overview(count = PATHS.length): CodeOverviewReady {
  const files = PATHS.slice(0, count).map((path, index) => ({ path, imports: 40 - index * 3, importedBy: 60 - index * 4, calls: 200 - index * 15, degree: 300 - index * 22, symbols: 30, topImports: PATHS.filter((other) => other !== path).slice(0, 5), topImportedBy: PATHS.filter((other) => other !== path).slice(5, 8) }))
  const edges = files.flatMap((_, from) => files.flatMap((_, to): Array<[number, number]> => (from !== to && (from + to) % 3 === 0 ? [[from, to]] : [])))
  return { state: "ready", files, edges, total: { files: 812, symbols: 9_400 }, omittedEdges: 0, partial: false, builtAt: 1 }
}
const camera: OrbitCamera = { yaw: .6, pitch: .2, selected: 0, focused: true, zoom: 1 }

describe("the code graph as the galaxy draws it", () => {
  test("files become file nodes in rank order, named apart when two share a name, with the links among them", () => {
    const report = overview()
    const graph = codeOrbitGraph(report)
    expect(graph.nodes.map((node) => node.kind)).toEqual(PATHS.map(() => "file"))
    expect(graph.nodes[0]).toEqual({ id: "code:packages/daemon/src/daemon.ts", kind: "file", label: "packages/daemon/src/daemon.ts", target: "packages/daemon/src/daemon.ts", activity: 300, short: "daemon" })
    expect(graph.nodes.filter((node) => node.label.endsWith("/index.ts")).map((node) => node.short)).toEqual(["protocol/src/index", "codegraph/src/index", "client/src/index"])
    expect(graph.edges).toHaveLength(report.edges.length)
    expect(graph.omitted).toBe(812 - PATHS.length)
    expect(codeOrbitValue(report)).toBe("12 of 812 files")
    expect(codeOrbitValue({ ...report, total: { files: 12, symbols: 1 } })).toBe("12 files")
    expect(codeOrbitValue({ state: "building" })).toBe("")
  })

  for (const [width, height] of [[54, 33], [30, 18]] as const) {
    test(`the galaxy, its legend and its hints fit ${width} columns`, () => {
      const report = overview()
      const rows = renderOrbit(codeOrbitGraph(report), width, height, camera, false, {}, codeOrbitView(report, width))
      expect(rows).toHaveLength(height)
      for (const row of rows) expect(textWidth(plain(row))).toBe(width)
      const text = rows.map(plain)
      // One row under the canvas: the keys while focused, the counts at rest.
      expect(text.at(-1)!.trimEnd()).toBe(width >= 54 ? `daemon · hjkl · tab · enter · ${ORBIT_MODE_KEY} session` : `hjkl · tab · enter · ${ORBIT_MODE_KEY} session`)
      const resting = renderOrbit(codeOrbitGraph(report), width, height, { ...camera, focused: false }, false, {}, codeOrbitView(report, width)).map(plain)
      expect(resting.at(-1)!.trim()).toBe(`▣ 12 files · ${report.edges.length} links +800`)
      expect(text.join("\n")).not.toContain("f type")
      expect(text.join("\n")).not.toContain("event")
      expect(text.join("\n")).not.toMatch(/zoom|\d+%/)
      expect(text.slice(0, -1).join("\n")).toContain("[▣]")
      expect(text.slice(0, -1).join("\n")).toContain("daemon")
    })
  }

  test("a short sheet keeps one status row, and session mode names the key that leads here", () => {
    const report = overview()
    const short = renderOrbit(codeOrbitGraph(report), 40, 9, camera, false, {}, codeOrbitView(report, 40)).map(plain)
    expect(short).toHaveLength(9)
    expect(short.at(-1)!.trim()).toBe(`daemon · hjkl · tab · enter · ${ORBIT_MODE_KEY} session`)
    const session = renderOrbit({ nodes: [], edges: [] }, 60, 20, camera).map(plain)
    expect(session.at(-1)!.trim()).toBe(`hjkl · tab · enter · f type · ${ORBIT_MODE_KEY} code`)
    expect(renderOrbit({ nodes: [], edges: [] }, 30, 20, camera).map(plain).at(-1)!.trim()).toBe(`hjkl · tab · enter · f · ${ORBIT_MODE_KEY}`)
    expect(renderOrbit({ nodes: [], edges: [] }, 20, 20, camera).map(plain).at(-1)!.trim()).toBe("hjkl · tab")
    const ascii = renderOrbit(codeOrbitGraph(report), 54, 30, { ...camera, focused: false }, true, {}, codeOrbitView(report, 54)).map(plain)
    expect(ascii.join("")).toMatch(/^[\x20-\x7e]*$/)
    expect(ascii.at(-1)).toContain(`F 12 files | ${report.edges.length} links`)
  })

  test("building, off here and failed are one muted line where the galaxy would be, at any width", () => {
    const states: Array<[Parameters<typeof codeOrbitView>[0], string, string]> = [
      [{ state: "building" }, "Building code graph", "Building code graph"],
      [{ state: "idle" }, "Building code graph", "Building code graph"],
      [{ state: "off", reason: "not a project" }, "Code graph is off here · not a project", "Code graph is off here"],
      [{ state: "failed", reason: "EACCES: permission denied, scandir '/work/app/private'" }, "Code graph failed · EACCES: permission denied, scandir '/work/app/private'", "Code graph failed · EACCES: p…"],
      [{ ...overview(0) }, "No connected source files", "No connected source files"],
    ]
    for (const [code, wide, narrow] of states) for (const [width, expected] of [[78, wide], [30, narrow]] as const) {
      const view = codeOrbitView(code, width)
      expect(view.note).toBe(expected)
      const rows = renderOrbit({ nodes: [], edges: [] }, width, 20, camera, false, {}, view)
      expect(rows).toHaveLength(20)
      const canvas = rows.slice(0, -1)
      const said = canvas.filter((row) => plain(row).trim() !== "")
      expect(said.map((row) => plain(row).trim())).toEqual([expected])
      expect(said[0]!.every((span) => span.text.trim() === "" || span.fg === "muted")).toBe(true)
      expect(plain(rows.at(-1)!)).toContain(width >= 54 ? `${ORBIT_MODE_KEY} session` : `${ORBIT_MODE_KEY}`)
      expect(plain(renderOrbit({ nodes: [], edges: [] }, width, 20, { ...camera, focused: false }, false, {}, view).at(-1)!).trim()).toBe("")
      // Two rows of sheet: the line takes the legend's place and nothing is lost.
      expect(renderOrbit({ nodes: [], edges: [] }, width, 2, camera, false, {}, view).map((row) => plain(row).trim())[0]).toBe(expected)
    }
  })

  for (const width of [54, 28]) {
    test(`Focus and Top fill ${width} columns: the file, its imports and importers, and the ranking`, () => {
      const report = overview()
      const details = codeOrbitDetails({ report, camera: { ...camera, selected: 1 }, width })
      for (const row of [...details.focus, ...details.top]) expect(textWidth(plain(row))).toBe(width)
      const focus = details.focus.map((row) => plain(row).trimEnd())
      expect(focus[0]).toBe(width === 54 ? "▣ packages/protocol/src/index.ts" : "▣ packages…ocol/src/index.ts")
      expect(focus[1]).toBe(width === 54 ? "37 imports · 56 imported by · 185 calls" : "37 out · 56 in · 185 calls")
      expect(focus[2]).toBe("imports · top 4 of 37")
      expect(focus[3]).toBe(width === 54 ? "  ▣ packages/daemon/src/daemon.ts" : "  ▣ package…on/src/daemon.ts")
      expect(focus[7]).toBe("imported by · top 3 of 56")
      expect(focus).toHaveLength(11)
      expect(details.focus.length).toBeLessThanOrEqual(ORBIT_CODE_ROWS.focus)
      const top = details.top.map(plain)
      expect(top).toHaveLength(ORBIT_CODE_ROWS.top)
      expect(top[0]!.trimStart().startsWith("▣ daemon")).toBe(true)
      expect(top[1]!.startsWith("▸ ▣ ")).toBe(true)
      expect(top.map((row) => row.slice(-4))).toEqual([" 300", " 278", " 256", " 234", " 212", " 190", " 168", " 146"])
      const meterStart = top.map((row) => row.search(/[█▏▎▍▌▋▊▉░]/))
      expect(new Set(meterStart).size).toBe(1)
    })
  }

  test("a file with no resolved imports says so, and no selection asks for tab", () => {
    const report = overview(3)
    report.files[0] = { ...report.files[0]!, imports: 0, importedBy: 0, topImports: [], topImportedBy: [] }
    expect(codeOrbitDetails({ report, camera, width: 40 }).focus.map((row) => plain(row).trimEnd())).toEqual(["▣ packages/daemon/src/daemon.ts", "0 imports · 0 imported by · 200 calls", "No resolved imports"])
    expect(codeOrbitDetails({ report, camera: { ...camera, selected: -1 }, width: 40 }).focus.map((row) => plain(row).trimEnd())).toEqual(["No file selected · tab"])
    const ascii = codeOrbitDetails({ report: overview(), camera, width: 30, ascii: true })
    expect([...ascii.focus, ...ascii.top].map(plain).join("")).toMatch(/^[\x20-\x7e]*$/)
  })
})

describe("a reply is re-bounded before it is drawn", () => {
  test("counts, lists and strings beyond the caps are cut, control characters dropped, a broken reply is a failure line", () => {
    const flood = {
      state: "ready",
      files: Array.from({ length: 500 }, (_, index) => ({ path: `src/f${index}\x1b[31m.ts`, imports: 1e9, importedBy: -4, calls: "many", degree: 7.9, symbols: Number.NaN, topImports: Array.from({ length: 90 }, (_, at) => `src/n${at}.ts`), topImportedBy: ["x".repeat(5000), 12, "src/ok.ts"] })),
      edges: [...Array.from({ length: 5000 }, (_, index) => [index % 30, (index + 1) % 30]), [0, 999], [-1, 2], "bad", [1.5, 2]],
      total: { files: 3, symbols: -1 }, omittedEdges: 12, partial: "yes", builtAt: 5,
    }
    const report = codeOverviewOf(flood)
    if (report.state !== "ready") throw new Error("expected a ready overview")
    expect(report.files).toHaveLength(CODEGRAPH_OVERVIEW.files)
    expect(report.edges).toHaveLength(CODEGRAPH_OVERVIEW.edges)
    expect(report.files[0]).toEqual({ path: "src/f0[31m.ts", imports: 1e9, importedBy: 0, calls: 0, degree: 7, symbols: 0, topImports: ["src/n0.ts", "src/n1.ts", "src/n2.ts", "src/n3.ts", "src/n4.ts"], topImportedBy: ["src/ok.ts"] })
    expect(report.total).toEqual({ files: 30, symbols: 0 })
    expect(report.partial).toBe(false)
    expect(codeOverviewOf({ state: "ready", files: [{ path: "a.ts" }, { path: 3 }, { path: "b.ts" }], edges: [[0, 2]] })).toMatchObject({ state: "ready", edges: [], files: [{ path: "a.ts" }, { path: "b.ts" }] })
    expect(codeOverviewOf({ state: "off", reason: `no\n${"r".repeat(900)}` })).toEqual({ state: "off", reason: `no${"r".repeat(198)}` })
    expect(codeOverviewOf({ state: "failed", reason: 4 })).toEqual({ state: "failed", reason: "" })
    for (const broken of [undefined, null, {}, { state: "ready" }, { state: "indexed", files: [] }, "ready"]) expect(codeOverviewOf(broken)).toEqual({ state: "failed", reason: "the daemon sent no overview" })
  })
})

describe("the mode key in the focused panel", () => {
  const open = async (options: { width?: number; height?: number; codeOverview?: () => unknown } = {}) => {
    const h = reviewFixture({ session: "active", width: options.width ?? 200, height: options.height ?? 60, preset: "galaxy", rightSidebar: true, ...(options.codeOverview ? { codeOverview: options.codeOverview } : {}) })
    await settle()
    h.app.render()
    await h.type("\x1b}")
    await settle()
    h.app.render()
    return h
  }
  const screen = (h: Awaited<ReturnType<typeof open>>) => h.text().join("\n")
  const ready = (): { ok: true; result: CodegraphOverview } => ({ ok: true, result: overview() })

  test("nothing asks for the code graph until the key is pressed; the key switches session and code, and each press to code asks once", async () => {
    const h = await open({ codeOverview: ready })
    for (const key of ["h", "j", "\t", "+", "f", "f", "]"]) await h.type(key)
    expect(h.sentOf("codegraph.overview")).toEqual([])
    expect(screen(h)).toContain(`${ORBIT_MODE_KEY} code`)
    expect(screen(h)).toContain("galaxy · /panel · focused")
    expect(screen(h)).toContain("─ Recent ")

    await h.type(ORBIT_MODE_KEY)
    await settle()
    h.app.render()
    expect(h.sentOf("codegraph.overview")).toEqual([{ type: "codegraph.overview", directory: h.directory }])
    expect(screen(h)).toContain("galaxy · code · /panel · focused")
    expect(screen(h)).toContain("12 of 812 files")
    expect(screen(h)).toContain(`hjkl · tab · enter · ${ORBIT_MODE_KEY} session`)
    expect(screen(h)).not.toContain("+/- zoom")
    expect(screen(h)).toContain("─ Focus ")
    expect(screen(h)).toContain("─ Top ")
    expect(screen(h)).not.toContain("─ Recent ")
    expect(screen(h)).toContain("▣ packages/daemon/src/daemon.ts")
    expect(screen(h)).toContain("imports · top 4 of 40")

    // Tab walks the ranking; the type filter and the event keys have nothing to do here and stay in the panel.
    await h.type("\t")
    expect(screen(h)).toContain("▣ packages/protocol/src/index.ts")
    for (const key of ["f", "[", "]"]) await h.type(key)
    expect(screen(h)).toContain("▣ packages/protocol/src/index.ts")
    expect(screen(h)).not.toContain("[file]")

    await h.type(ORBIT_MODE_KEY)
    expect(screen(h)).toContain("galaxy · /panel · focused")
    expect(screen(h)).toContain(`${ORBIT_MODE_KEY} code`)
    expect(screen(h)).toContain("─ Recent ")
    expect(h.sentOf("codegraph.overview")).toHaveLength(1)

    await h.type(ORBIT_MODE_KEY)
    await settle()
    h.app.render()
    expect(h.sentOf("codegraph.overview")).toHaveLength(2)
    expect(screen(h)).toContain("▣ packages/protocol/src/index.ts")
  })

  test("the key reaches the prompt when the panel is not focused, and asks for nothing", async () => {
    const h = await open({ codeOverview: ready })
    await h.type("\x1b")
    await h.type(ORBIT_MODE_KEY)
    expect(h.sentOf("codegraph.overview")).toEqual([])
    expect(screen(h)).not.toContain("galaxy · code")
  })

  test("while the daemon builds, one line says so; then the graph replaces it", async () => {
    let answer: (reply: unknown) => void = () => undefined
    const h = await open({ codeOverview: () => new Promise((resolve) => { answer = resolve }) })
    await h.type(ORBIT_MODE_KEY)
    expect(screen(h)).toContain("Building code graph")
    expect(screen(h)).toContain("galaxy · code")
    expect(screen(h)).not.toContain("─ Focus ")
    expect(screen(h)).not.toContain("files ·")
    answer(ready())
    await settle()
    h.app.render()
    expect(screen(h)).not.toContain("Building code graph")
    expect(screen(h)).toContain("12 of 812 files")
  })

  test("a non-project directory is one line and the panel keeps working", async () => {
    const h = await open({ codeOverview: () => ({ ok: true, result: { state: "off", reason: "not a project" } }) })
    await h.type(ORBIT_MODE_KEY)
    await settle()
    h.app.render()
    expect(screen(h)).toContain("Code graph is off here · not a project")
    expect(screen(h)).not.toContain("─ Focus ")
    await h.type("\r")
    expect(h.sentOf("file.view")).toEqual([])
    await h.type(ORBIT_MODE_KEY)
    expect(screen(h)).toContain("─ Recent ")
  })

  test("a failed build, a refused command and a daemon that does not know the command are one line with the reason", async () => {
    for (const [reply, line] of [
      [{ ok: true, result: { state: "failed", reason: "EACCES: permission denied" } }, "Code graph failed · EACCES: permission denied"],
      [{ ok: false, error: { code: "forbidden", message: "read-only peer" } }, "Code graph failed · read-only peer"],
      [{ ok: true }, "Code graph failed · the daemon sent no overview"],
    ] as const) {
      const h = await open({ codeOverview: () => reply })
      await h.type(ORBIT_MODE_KEY)
      await settle()
      h.app.render()
      expect(screen(h)).toContain(line)
    }
  })

  test("enter opens the selected file in the file viewer and leaves the panel's focus", async () => {
    const h = await open({ codeOverview: ready })
    await h.type(ORBIT_MODE_KEY)
    await settle()
    await h.type("\t")
    await h.type("\r")
    await settle()
    expect(h.sentOf("file.view")).toMatchObject([{ type: "file.view", directory: h.directory, path: "packages/protocol/src/index.ts" }])
    expect(h.sentOf("session.changes").length).toBeGreaterThan(0)
  })

  test("the sheet of a narrow terminal shows the same mode in the rows it has", async () => {
    const h = await open({ width: 100, height: 30, codeOverview: ready })
    await h.type(ORBIT_MODE_KEY)
    await settle()
    h.app.render()
    const rows = h.text()
    expect(rows.join("\n")).toContain("galaxy · code · /panel · focused")
    expect(rows.join("\n")).toContain("12 of 812 files")
    expect(rows.join("\n")).toContain(` · ${ORBIT_MODE_KEY}`)
    for (const row of rows) expect(textWidth(row)).toBeLessThanOrEqual(100)
  })

  test("another session starts in session mode; with nothing touched yet it asks for the project's code once by itself", async () => {
    const h = await open({ codeOverview: ready })
    await h.type(ORBIT_MODE_KEY)
    await settle()
    expect(h.sentOf("codegraph.overview")).toHaveLength(1)
    await h.type("\x1b")
    await h.type("/new\r")
    await settle()
    expect(h.sentOf("session.create")).toHaveLength(1)
    await h.type("\x1b}")
    await settle()
    h.app.render()
    expect(h.app.sessionId).not.toBe(h.sessionId)
    expect(screen(h)).toContain("galaxy · /panel · focused")
    expect(screen(h)).toContain(`${ORBIT_MODE_KEY} code`)
    expect(h.sentOf("codegraph.overview")).toHaveLength(2)
  })

  test("a session that has touched no code shows the project's code by itself once it is ready; a failed overview leaves the session view", async () => {
    const shown = reviewFixture({ session: "home", width: 200, height: 60, preset: "galaxy", rightSidebar: true, codeOverview: ready })
    await shown.app.start()
    await shown.type("\x1b}")
    await settle()
    shown.app.render()
    expect(shown.sentOf("codegraph.overview")).toHaveLength(1)
    expect(screen(shown)).toContain(`${ORBIT_MODE_KEY} session`)
    const failed = reviewFixture({ session: "home", width: 200, height: 60, preset: "galaxy", rightSidebar: true, codeOverview: () => ({ ok: false, error: { message: "x" } }) })
    await failed.app.start()
    await failed.type("\x1b}")
    await settle()
    failed.app.render()
    expect(failed.sentOf("codegraph.overview")).toHaveLength(1)
    expect(screen(failed)).toContain(`${ORBIT_MODE_KEY} code`)
  })
})
