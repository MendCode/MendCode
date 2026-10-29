import { describe, expect, test } from "bun:test"
import type { SessionEvent } from "@mendcode/protocol"
import { TUI_DEFAULTS, TUI_ENUMS, tuiProblems } from "@mendcode/protocol/wire"
import { CUSTOMIZE_ROWS } from "../src/view/customize-page"
import { renderToolCard } from "../src/view/tool-card"
import { createTranscript, type PresentationMode } from "../src/view/transcript"
import { CODE_MAP_CARDS, DEFAULT_TUI_PROFILE, normalizeTuiProfile, type TuiProfile } from "../src/view/tui-profile"
import { textWidth } from "../src/view/wrap"
import { ids, NOW } from "./session-ui-harness"

/** The engine's own `graph_map` (injected) as the transcript receives it: the card's spec, the model's text and the meta. */
const DIRS = [["packages", 1450], ["apps", 958], ["scripts", 90], ["benchmarks", 40], ["editors", 22], ["spikes", 20], ["examples", 14]] as const
const SUMMARY = "7 dirs · 2,594 files · hubs: ids 616 · textWidth 329 · createClient.request 211"
const RENDER = {
  type: "stack",
  children: [
    { type: "graph", root: "MendCodeV2", title: "Project map", edges: DIRS.map(([dir]) => ({ from: "MendCodeV2", to: dir, relation: "dir" })) },
    { type: "text", text: SUMMARY, tone: "muted" },
    { type: "detail", at: "preview", children: [{ type: "table", columns: ["hub", "file", "callers"], rows: [["ids", "model-prefs", "616"], ["textWidth", "wrap", "329"]] }] },
    {
      type: "detail",
      at: "open",
      children: [
        { type: "text", text: "Directories", bold: true },
        { type: "list", items: DIRS.map(([dir, files]) => `${dir}  ${files} files  ts ${files}`) },
        { type: "text", text: "Hub symbols", bold: true },
        { type: "list", items: Array.from({ length: 20 }, (_, index) => `hub${index}  apps/cli/src/view/model-prefs.ts:${25 + index}  callers:${616 - index}`) },
      ],
    },
  ],
}
const TEXT = "2594 files, 9000 symbols\nDirectories (depth 2):\npackages  1450 files  ts 1450\nHub symbols (most callers):\nids  apps/cli/src/view/model-prefs.ts:25  callers:616"
const META = { files: 2594, symbols: 9000, directories: 7, hubs: 20 }

function build(options: { mode?: PresentationMode; codeMapCard?: TuiProfile["codeMapCard"]; injected?: boolean; maps?: number } = {}) {
  const sessionId = ids("session")
  let seq = 0
  const events: SessionEvent[] = []
  const emit = (event: Record<string, unknown>) => events.push({ sessionId, seq: ++seq, at: NOW - 60_000 + seq * 100, ...event } as SessionEvent)
  const items: string[] = []
  for (let map = 0; map < (options.maps ?? 1); map++) {
    const turnId = ids("turn")
    emit({ type: "turn.started", turnId, queueId: ids("queue") })
    const itemId = ids("item")
    items.push(itemId)
    emit({ type: "item.started", turnId, itemId, kind: "tool_call", meta: { tool: "graph_map", ...(options.injected === false ? {} : { injected: true }) } })
    emit({ type: "item.completed", itemId, status: "ok", text: TEXT, render: RENDER, meta: META })
    emit({ type: "turn.completed", turnId })
  }
  const transcript = createTranscript({ now: () => NOW, mode: options.mode ?? "balanced" })
  transcript.setAppearance({ ...DEFAULT_TUI_PROFILE, reasoning: "auto", toolOutput: "auto", timestamps: false, ...(options.codeMapCard ? { codeMapCard: options.codeMapCard } : {}) })
  for (const event of events) transcript.apply(event)
  const rows = (width = 100) => transcript.viewport(width, 2000).map((row) => row.text).filter((row) => row.trim())
  return { transcript, itemId: items[0]!, items, rows, events }
}

const hasList = (rows: string[]) => rows.some((row) => /Directories|Hub symbols|callers:|files {2}ts /.test(row))
const hasDiagram = (rows: string[]) => rows.some((row) => row.includes("Project map")) && rows.some((row) => row.includes("MendCodeV2"))
const hasSummary = (rows: string[]) => rows.some((row) => row.includes(SUMMARY))
const hasHint = (rows: string[]) => rows.some((row) => /Code map · 7 dirs · 2,594 files +click or ctrl\+o to open$/.test(row))

describe("the setting", () => {
  test("codeMapCard is auto, open or folded; anything else reads as auto", () => {
    expect(CODE_MAP_CARDS).toEqual(["auto", "open", "folded"])
    expect(DEFAULT_TUI_PROFILE.codeMapCard).toBe("auto")
    for (const value of CODE_MAP_CARDS) expect(normalizeTuiProfile({ codeMapCard: value }).codeMapCard).toBe(value)
    for (const value of ["always", "", 1, null, undefined]) expect(normalizeTuiProfile({ codeMapCard: value }).codeMapCard).toBe("auto")
  })

  test("the shared profile data and /customize know it", () => {
    expect(TUI_DEFAULTS.codeMapCard).toBe("auto")
    expect(TUI_ENUMS.codeMapCard).toEqual([...CODE_MAP_CARDS])
    expect(tuiProblems({ codeMapCard: "open" })).toEqual([])
    expect(tuiProblems({ codeMapCard: "sometimes" })).not.toEqual([])
    expect(CUSTOMIZE_ROWS).toContain("codeMapCard")
  })
})

describe("the engine's code map card", () => {
  test("full opens it by default: the ASCII map alone, no summary row and no list", () => {
    const rows = build({ mode: "full" }).rows()
    expect(hasDiagram(rows)).toBe(true)
    expect(hasSummary(rows)).toBe(false)
    expect(hasList(rows)).toBe(false)
    expect(hasHint(rows)).toBe(false)
    expect(rows.some((row) => row.includes("hub") && row.includes("callers") && row.includes("model-prefs"))).toBe(false)
  })

  test("balanced folds it by default into one row with the key hint", () => {
    const rows = build({ mode: "balanced" }).rows()
    expect(rows).toHaveLength(1)
    expect(hasHint(rows)).toBe(true)
    expect(hasDiagram(rows)).toBe(false)
  })

  test("balanced expanded is the ASCII map alone, never the summary row or the list", () => {
    const { transcript, itemId, rows } = build({ mode: "balanced" })
    transcript.toggleDetails(itemId)
    const opened = rows()
    expect(hasDiagram(opened)).toBe(true)
    expect(hasSummary(opened)).toBe(false)
    expect(hasList(opened)).toBe(false)
    expect(hasHint(opened)).toBe(false)
    // The same rows as the full view's default card.
    expect(opened).toEqual(build({ mode: "full" }).rows())
  })

  test("ctrl+o opens every card, the folded map included, and still shows no list", () => {
    for (const mode of ["balanced", "full"] as const) {
      const { transcript, rows } = build({ mode, codeMapCard: "folded" })
      expect(rows()).toHaveLength(1)
      transcript.toggleTools()
      const opened = rows()
      expect(hasDiagram(opened)).toBe(true)
      expect(hasList(opened)).toBe(false)
    }
  })

  test("a card the reader folded or opened keeps that against the setting, a changed setting and the view", () => {
    const full = build({ mode: "full" })
    full.transcript.toggleDetails(full.itemId)
    expect(hasHint(full.rows())).toBe(true)
    full.transcript.setAppearance({ ...DEFAULT_TUI_PROFILE, reasoning: "auto", toolOutput: "auto", codeMapCard: "open" })
    expect(hasHint(full.rows())).toBe(true)
    full.transcript.toggleDetails(full.itemId)
    expect(hasDiagram(full.rows())).toBe(true)
    full.transcript.setAppearance({ ...DEFAULT_TUI_PROFILE, reasoning: "auto", toolOutput: "auto", codeMapCard: "folded" })
    expect(hasDiagram(full.rows())).toBe(true)

    const balanced = build({ mode: "balanced", codeMapCard: "open" })
    expect(hasDiagram(balanced.rows())).toBe(true)
    balanced.transcript.toggleDetails(balanced.itemId)
    expect(hasHint(balanced.rows())).toBe(true)
    balanced.transcript.setMode("full")
    expect(hasHint(balanced.rows())).toBe(true)
  })

  test("a click folds the card in full and opens it again, one card at a time", () => {
    const { transcript, items, rows } = build({ mode: "full", maps: 2 })
    expect(rows().filter((row) => row.includes("Project map"))).toHaveLength(2)
    transcript.toggleDetails(items[0]!)
    const mixed = rows()
    expect(mixed.filter((row) => row.includes("Project map"))).toHaveLength(1)
    expect(mixed.filter((row) => row.includes("click or ctrl+o to open"))).toHaveLength(1)
    transcript.toggleDetails(items[0]!)
    expect(rows().filter((row) => row.includes("Project map"))).toHaveLength(2)
  })

  test("open shows the card in balanced and folded keeps the row in full; auto follows the view", () => {
    expect(hasDiagram(build({ mode: "balanced", codeMapCard: "open" }).rows())).toBe(true)
    expect(hasHint(build({ mode: "full", codeMapCard: "folded" }).rows())).toBe(true)
    expect(hasHint(build({ mode: "balanced", codeMapCard: "auto" }).rows())).toBe(true)
    expect(hasDiagram(build({ mode: "full", codeMapCard: "auto" }).rows())).toBe(true)
  })

  test("the minimal view is unchanged: the row, whatever the setting", () => {
    for (const codeMapCard of CODE_MAP_CARDS) {
      const rows = build({ mode: "minimal", codeMapCard }).rows()
      expect(rows).toHaveLength(1)
      expect(hasHint(rows)).toBe(true)
    }
  })

  test("a map the model asked for keeps its card in every view, the map alone too", () => {
    for (const mode of ["balanced", "full"] as const) {
      const rows = build({ mode, injected: false }).rows()
      expect(hasDiagram(rows)).toBe(true)
      expect(hasSummary(rows)).toBe(false)
      expect(hasList(rows)).toBe(false)
    }
  })

  test("the folded row's hint is worded by the key-label system", () => {
    const row = build({ mode: "balanced" }).rows()[0]!
    expect(row).toContain("click or ctrl+o to open")
    expect(/(?<![\w-])[MC]-[A-Za-z](?![\w-])/.test(row)).toBe(false)
  })
})

describe("what the card reads and what the model gets", () => {
  test("drawing the card changes neither the tool's text nor its spec", () => {
    const { transcript, itemId, rows, events } = build({ mode: "full" })
    const before = JSON.stringify(events)
    transcript.toggleDetails(itemId)
    transcript.toggleDetails(itemId)
    transcript.toggleTools()
    rows(60)
    rows(120)
    expect(JSON.stringify(events)).toBe(before)
    const done = events.find((event) => event.type === "item.completed") as unknown as { text: string; render: typeof RENDER }
    expect(done.text).toBe(TEXT)
    expect(done.render.children.filter((child) => child.type === "detail")).toHaveLength(2)
  })

  test("the card leaves the summary row and the lists out at every level, also for a result saved with them beside the map", () => {
    const text = (render: unknown, level: "summary" | "preview" | "full") => renderToolCard({ title: "graph_map", text: TEXT, status: "ok", width: 100, render: render as never, level, frame: 0, tailLines: 4 }).map((line) => line.map((span) => span.text).join("")).join("\n")
    const legacy = { type: "stack", children: [RENDER.children[0], RENDER.children[1], RENDER.children[3]!.children![0], RENDER.children[3]!.children![1]] }
    for (const render of [RENDER, legacy]) {
      for (const level of ["summary", "preview", "full"] as const) {
        const drawn = text(render, level)
        expect(drawn).toContain("Project map")
        expect(drawn).not.toContain(SUMMARY)
        expect(drawn).not.toMatch(/Directories|Hub symbols|callers:/)
      }
    }
  })

  test("a card for any other tool still shows its own details", () => {
    const render = { type: "stack", children: [{ type: "text", text: "summary", tone: "muted" }, { type: "detail", at: "open", children: [{ type: "list", items: ["kept"] }] }] }
    const drawn = renderToolCard({ title: "graph_impact: a.ts", text: "x", status: "ok", width: 100, render: render as never, level: "full", frame: 0, tailLines: 4 }).map((line) => line.map((span) => span.text).join("")).join("\n")
    expect(drawn).toContain("kept")
  })
})

describe("narrow widths", () => {
  const card = (width: number) => build({ mode: "full" }).rows(width)

  test("no row is wider than the screen, and no summary row comes back at any width", () => {
    for (const width of [30, 40, 57, 58, 70, 80, 120]) {
      const rows = card(width)
      expect(rows.some((row) => row.includes("7 dirs"))).toBe(false)
      for (const row of rows) expect(textWidth(row)).toBeLessThanOrEqual(width)
    }
  })

  test("below the frame width the diagram falls back to one row per edge, as before", () => {
    const rows = card(50)
    expect(rows.some((row) => row.includes("MendCodeV2 --dir--> packages"))).toBe(true)
    expect(rows.some((row) => row.includes("╭"))).toBe(false)
    expect(hasList(rows)).toBe(false)
  })
})

describe("many maps", () => {
  test("a session with many open cards keeps a constant height per card and a steady viewport", () => {
    const { transcript, rows } = build({ mode: "full", maps: 40 })
    const all = rows(100)
    const perCard = all.filter((row) => row.includes("Project map")).length
    expect(perCard).toBe(40)
    expect(all.filter((row) => row.includes(SUMMARY))).toHaveLength(0)
    // Scrolling up and back through the history lands on the same rows.
    const bottom = transcript.viewport(100, 30).map((row) => row.text)
    transcript.viewport(100, 30, 200)
    expect(transcript.viewport(100, 30).map((row) => row.text)).toEqual(bottom)
  })
})
