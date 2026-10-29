import { describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { SessionEvent } from "@mendcode/protocol"
import { TUI_DEFAULTS, TUI_ENUMS, tuiProblems } from "@mendcode/protocol/wire"
import { glyphs } from "../src/ui/theme"
import { CUSTOMIZE_ROWS } from "../src/view/customize-page"
import { renderToolCard } from "../src/view/tool-card"
import { jsonShape } from "../src/view/tool-data"
import { foldLabel } from "../src/view/tool-summary"
import { createTranscript, type PresentationMode, type ViewLine } from "../src/view/transcript"
import { DEFAULT_TUI_PROFILE, normalizeTuiProfile, TOOL_DENSITIES, type TuiProfile } from "../src/view/tui-profile"
import { DENSITY_NOW, densitySession } from "./density-session"

/**
 * The full view's `toolDensity` on the owner's session (`density-session.ts`): `dense` is the full view as it was, `standard` caps every
 * call's preview by kind, `calm` keeps one row per finished call except the latest, running and failed ones. The goldens in
 * `fixtures/density-golden` are the fixture at 100 columns in each density; `MENDCODE_WRITE_GOLDENS=1 bun test <this file>` rewrites them.
 */
type Density = (typeof TOOL_DENSITIES)[number]
const session = densitySession("ses_density")

function build({ density, mode = "full", toolOutput = "auto", events = session.events }: { density?: Density; mode?: PresentationMode; toolOutput?: TuiProfile["toolOutput"]; events?: readonly SessionEvent[] } = {}) {
  const appearance = { ...DEFAULT_TUI_PROFILE, ...(density ? { toolDensity: density } : {}) }
  const t = createTranscript({ appearance, glyphs: glyphs({}), mode, now: () => DENSITY_NOW })
  t.setAppearance({ ...appearance, reasoning: "auto", toolOutput, timestamps: false })
  for (const event of events) t.apply(event)
  return t
}

const lines = (t: ReturnType<typeof build>, width = 100) => t.viewport(width, 6000)
const text = (t: ReturnType<typeof build>, width = 100) => lines(t, width).map((line) => line.text.trimEnd())

/** The rows each block drew, by item. */
function perBlock(rows: readonly ViewLine[]) {
  const out = new Map<string, string[]>()
  for (const row of rows) if (row.itemId) out.set(row.itemId, [...(out.get(row.itemId) ?? []), row.text.trimEnd()])
  return out
}

const goldenFile = (name: string) => path.join(import.meta.dir, "fixtures", "density-golden", `${name}.txt`)
function golden(name: string, rows: readonly string[]) {
  const body = rows.join("\n") + "\n"
  if (process.env.MENDCODE_WRITE_GOLDENS) {
    mkdirSync(path.dirname(goldenFile(name)), { recursive: true })
    writeFileSync(goldenFile(name), body)
  }
  return { actual: body, expected: readFileSync(goldenFile(name), "utf8") }
}

const tool = (title: string) => session.tools.filter((entry) => entry.title.startsWith(title))
const itemOf = (title: string, nth = 0) => tool(title)[nth]!.itemId

describe("the setting", () => {
  test("toolDensity is calm, standard or dense, and anything else reads as the default", () => {
    expect(TOOL_DENSITIES).toEqual(["calm", "standard", "dense"])
    expect(DEFAULT_TUI_PROFILE.toolDensity).toBe("calm")
    for (const value of TOOL_DENSITIES) expect(normalizeTuiProfile({ toolDensity: value }).toolDensity).toBe(value)
    for (const value of ["compact", "", 3, null, undefined]) expect(normalizeTuiProfile({ toolDensity: value }).toolDensity).toBe("calm")
  })

  test("the shared profile data knows it and /customize lists it in Session chrome next to Tool output", () => {
    expect(TUI_DEFAULTS.toolDensity).toBe("calm")
    expect(TUI_ENUMS.toolDensity).toEqual([...TOOL_DENSITIES])
    expect(tuiProblems({ toolDensity: "dense" })).toEqual([])
    expect(tuiProblems({ toolDensity: "loud" })).not.toEqual([])
    expect(CUSTOMIZE_ROWS.indexOf("toolDensity")).toBe(CUSTOMIZE_ROWS.indexOf("toolOutput") + 1)
  })
})

describe("the three densities on the owner's session at 100 columns", () => {
  for (const density of TOOL_DENSITIES) {
    test(`${density} is the recorded frame`, () => {
      const { actual, expected } = golden(`${density}-100`, text(build({ density })))
      expect(actual).toBe(expected)
    })
  }

  test("calm draws far fewer rows than standard, and standard fewer than dense", () => {
    const rows = Object.fromEntries(TOOL_DENSITIES.map((density) => [density, text(build({ density })).length]))
    expect(rows.calm!).toBeLessThan(rows.standard!)
    expect(rows.standard!).toBeLessThan(rows.dense!)
    expect(rows.calm!).toBeLessThan(rows.dense! / 2)
  })

  test("the assistant's sentences, the code map and the thoughts read the same in every density", () => {
    const keep = (density: Density) => text(build({ density })).filter((row) => /^ {2}• |^ {4}┃ |Project map|7 dirs · 2,360 files/.test(row))
    expect(keep("calm")).toEqual(keep("dense"))
    expect(keep("standard")).toEqual(keep("dense"))
    expect(keep("dense").length).toBeGreaterThan(6)
  })

  test("every density shows every call: nothing is dropped, only folded or capped", () => {
    for (const density of TOOL_DENSITIES) {
      const rows = text(build({ density })).join("\n")
      expect(rows).toContain("Skill whittle")
      expect(rows).toContain("packages inspect acme-theme")
      expect(rows).toContain("bun test apps/cli/test/docs.test.ts")
    }
  })
})

describe("dense is the full view as it was", () => {
  test("a successful call has the same rows as before the setting existed", () => {
    // The fixture's cards before this change: the same text, one call at a time, in the full view's preview level.
    const dense = text(build({ density: "dense" }))
    expect(dense).toContain("     ▤ Read docs/extensions.md  28 lines")
    expect(dense.filter((row) => row.startsWith("     │ ") && /^\s*│ [0-9]+ {2}/.test(row)).length).toBeGreaterThanOrEqual(6)
    expect(dense.join("\n")).toContain("… 22 more lines")
  })

  test("balanced and minimal ignore the setting", () => {
    for (const mode of ["balanced", "minimal"] as const) expect(text(build({ density: "calm", mode }))).toEqual(text(build({ density: "dense", mode })))
  })

  test("the toolOutput setting and ctrl+o keep their meaning in every density", () => {
    for (const toolOutput of ["expanded", "collapsed"] as const) expect(text(build({ density: "calm", toolOutput }))).toEqual(text(build({ density: "dense", toolOutput })))
    const open = (density: Density) => {
      const t = build({ density })
      t.toggleTools()
      return text(t)
    }
    expect(open("calm")).toEqual(open("dense"))
  })
})

describe("standard caps the preview by kind", () => {
  const rows = perBlock(lines(build({ density: "standard" })))
  const of = (title: string, nth = 0) => rows.get(itemOf(title, nth))!

  test("a read shows 3 lines and says how many are left", () => {
    expect(of("read: docs/extensions.md").filter((row) => /^ {5}│ +\d+/.test(row))).toHaveLength(3)
    expect(of("read: docs/extensions.md").at(-1)).toContain("… 25 more lines")
  })

  test("a search shows 3 matching lines, a shell the last 3 lines, and a web search 3 titles", () => {
    expect(of("grep: docsTopic").filter((row) => /^ {5}│ +\d+ {2}/.test(row))).toHaveLength(3)
    expect(of("shell: wc").filter((row) => /^ {5}│ \d+ docs\//.test(row))).toHaveLength(3)
    expect(of("web_search").filter((row) => /^ {5}│ \d\. /.test(row))).toHaveLength(3)
  })

  test("a JSON result is its shape and no rows: object · 4 keys, json · 1,155 lines", () => {
    expect(of("packages: list")[0]).toContain("object · 4 keys")
    expect(of("packages: list")).toHaveLength(1)
    expect(of("shell: mendcode docs --json")[0]).toContain("json · 1,155 lines")
    expect(of("shell: mendcode docs --json").filter((row) => row.includes("│"))).toEqual([])
  })

  test("a diff shows at most 8 rows; the session's patch has exactly 8, so nothing is left out", () => {
    const patch = of("apply_patch")
    expect(patch.filter((row) => row.startsWith("     │ "))).toHaveLength(8)
    expect(patch.at(-1)).not.toMatch(/…/)
  })
})

describe("calm keeps one row for a finished call that is no longer news", () => {
  const rows = perBlock(lines(build({ density: "calm" })))
  const of = (title: string, nth = 0) => rows.get(itemOf(title, nth))!

  test("a finished call that is neither the latest nor failed is its header row, with its result count and duration", () => {
    expect(of("web_search")).toHaveLength(1)
    expect(of("web_search")[0]).toMatch(/Web search "bun test docs" {2}8 results +1\.6s$/)
    expect(of("shell: wc")[0]).toMatch(/\$ wc -l docs\/\*\.md \| sort -n {2}82 lines$/)
    expect(of("shell: bun test")).toHaveLength(1)
    expect(of("shell: bun test")[0]).toMatch(/241 pass · 0 fail +12\.4s$/)
  })

  test("the latest call keeps a bounded preview", () => {
    const latest = of("grep: prompt-modes")
    expect(latest.length).toBeGreaterThan(2)
    expect(latest.length).toBeLessThanOrEqual(7)
  })

  test("a failed call keeps its marker, its badge in words and a short, readable body", () => {
    expect(of("shell: mendcode docs packages")[0]).toMatch(/^ {5}✗ mendcode docs packages/)
    expect(of("shell: mendcode docs packages").join("\n")).toContain("exit 2")
    expect(of("skill: whittle", 1)).toEqual(["     ✗ Skill whittle  failed", "     │ Unknown skill \"whittle\". Available: build, fix, review, rush."])
    expect(of("packages: inspect")).toEqual(["     ✗ packages inspect acme-theme  failed", "     │ [PACKAGES]: Package tree exceeds approval budget"])
  })

  test("a run of finished looking calls folds into one row with the counts spelled, and opens on a click", () => {
    const t = build({ density: "calm" })
    const folded = text(t).filter((row) => row.includes("◇ Read") || row.includes("◇ Glob"))
    expect(folded).toContain("     ◇ Read 1 file · Glob 1 pattern · Grep 1 pattern")
    expect(folded).toContain("     ◇ Read 1 file · Grep 2 patterns")
    expect(foldLabel(["read", "grep", "grep", "glob", "ls", "ls"], true)).toBe("Read 1 file · List 2 folders · Glob 1 pattern · Grep 2 patterns")
    expect(foldLabel(["read", "grep", "read"])).toBe("Read 2 files · Grep 1")
    const leader = lines(t).find((row) => row.text.includes("◇ Read 1 file · Grep 2 patterns"))!
    t.toggleDetails(leader.itemId!, leader.fold)
    const opened = text(t).join("\n")
    expect(opened).toContain("Read docs/extensions.md")
    expect(opened).toContain('Grep "docsTopic"')
  })

  test("a card the reader opened by hand stays open as the session goes on", () => {
    const events = session.events
    const upTo = events.findIndex((event) => event.type === "item.started" && event.itemId === itemOf("grep: ORDER"))
    const t = build({ density: "calm", events: events.slice(0, upTo) })
    const shell = itemOf("shell: wc")
    expect(perBlock(lines(t)).get(shell)).toHaveLength(1)
    t.toggleDetails(shell)
    const opened = perBlock(lines(t)).get(shell)!
    expect(opened.length).toBeGreaterThan(20)
    for (const event of events.slice(upTo)) t.apply(event)
    expect(perBlock(lines(t)).get(shell)).toEqual(opened)
    t.toggleDetails(shell)
    expect(perBlock(lines(t)).get(shell)).toHaveLength(1)
  })
})

describe("heights stay stable while the session streams", () => {
  const events = session.events
  const startOf = (itemId: string) => events.findIndex((event) => event.type === "item.started" && event.itemId === itemId)
  const endOf = (itemId: string) => events.findIndex((event) => event.type === "item.completed" && event.itemId === itemId)

  test("a call finishing changes only its own rows", () => {
    for (const title of ["grep: TOPICS", "shell: bun test", "apply_patch", "grep: prompt-modes"]) {
      const item = itemOf(title)
      const t = build({ density: "calm", events: events.slice(0, endOf(item)) })
      const before = perBlock(lines(t))
      t.apply(events[endOf(item)]!)
      const after = perBlock(lines(t))
      for (const [id, rows] of before) if (id !== item) expect(after.get(id)).toEqual(rows)
    }
  })

  test("a call that is no longer the latest folds when the next call starts, not before", () => {
    const first = itemOf("grep: ORDER")
    const next = itemOf("skill: whittle", 1)
    const t = build({ density: "calm", events: events.slice(0, startOf(next)) })
    expect(perBlock(lines(t)).get(first)!.length).toBeGreaterThan(1)
    t.apply(events[startOf(next)]!)
    expect(perBlock(lines(t)).get(first)).toHaveLength(1)
  })

  test("the assistant's answer arriving moves nothing above it", () => {
    const answerAt = events.findLastIndex((event) => event.type === "item.started")
    const t = build({ density: "calm", events: events.slice(0, answerAt) })
    const before = perBlock(lines(t))
    for (const event of events.slice(answerAt)) t.apply(event)
    const after = perBlock(lines(t))
    for (const [id, rows] of before) expect(after.get(id)).toEqual(rows)
  })

  test("the laid-out total matches the rows drawn after a call folds", () => {
    const t = build({ density: "calm" })
    expect(t.totalLines(100)).toBe(lines(t).length)
  })
})

describe("nothing the model receives changes", () => {
  test("the cards read the same text in every density: only the rows differ", () => {
    const input = { title: "grep: x", text: "a.ts:1:one\nb.ts:2:two\nc.ts:3:three\nd.ts:4:four", status: "ok" as const, width: 100, expanded: false, level: "preview" as const, frame: 0, tailLines: 4, pattern: "x" }
    const dense = renderToolCard(input).map((row) => row.map((span) => span.text).join(""))
    const brief = renderToolCard({ ...input, density: "brief" }).map((row) => row.map((span) => span.text).join(""))
    const line = renderToolCard({ ...input, density: "line" }).map((row) => row.map((span) => span.text).join(""))
    expect(dense.join("\n")).toContain("d.ts")
    expect(brief.join("\n")).not.toContain("d.ts")
    expect(line).toHaveLength(1)
    // An opened card (`full`) ignores the density: the reader asked for the body.
    const full = renderToolCard({ ...input, level: "full", density: "line" }).map((row) => row.map((span) => span.text).join(""))
    expect(full.join("\n")).toContain("d.ts")
  })

  test("the JSON shape of a shell result", () => {
    expect(jsonShape(['{"a":1,"b":2}'])).toBe("object · 2 keys")
    expect(jsonShape(["[", "1,", "2", "]"])).toBe("array · 2 items")
    expect(jsonShape(["{", '  "a": [', "  ...", "}"])).toBe("json · 4 lines")
    expect(jsonShape(["bun test v1", "ok"])).toBeUndefined()
  })
})
