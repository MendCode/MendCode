import { afterEach, describe, expect, test } from "bun:test"
import { createIdFactory, FOOTER_PRESETS, FOOTER_SEGMENTS, FOOTER_SEGMENT_TIER, tierFooter } from "@mendcode/protocol/wire"
import { DEFAULT_TUI_PROFILE, writeTuiProfile, type TuiProfile } from "../src/view/tui-profile"
import { layoutGroups, renderDetailRow, renderStatusRow, type FooterRowPart } from "../src/view/prompt-chrome"
import { appHarness, plain, scratch } from "./extensions-harness"
import { NOW, quotaScene } from "./footer-rows-fixture"

const ids = createIdFactory()
const DIR = "/Users/dev/Code/MendCodeV2"
const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

type Scene = { mode: "minimal" | "balanced" | "full"; width: number; height?: number; profile?: Partial<TuiProfile>; graph?: boolean; quotas?: boolean; loops?: number; turns?: number; settings?: Record<string, unknown> }

/**
 * A session after a few turns of a growing context, on a fake daemon: GPT-6-Luna at high effort with `/fast` on, one live loop, the
 * code graph indexed and both quota providers read. The rows from the prompt's bottom rule down are what the footer drew.
 */
async function scene({ mode, width, height = 30, profile = {}, graph = true, quotas = true, loops = 1, turns = 4, settings = {} }: Scene) {
  const layout = scratch()
  cleanups.push(layout.cleanup)
  // These scenes pin the built-in footer under the packs: `footerPack: off` (footer-pack.test.ts covers the packs, `clean` the default).
  writeTuiProfile(layout.dataDir, { ...DEFAULT_TUI_PROFILE, sidebar: "hidden", footerPack: "off", ...profile })
  const h = await appHarness({
    dataDir: layout.dataDir, directory: DIR, home: "/Users/dev", width, height, mode,
    reply: (command) => command.type === "models.list"
      ? { ok: true, result: { engine: "native", selectable: true, models: [{ id: "gpt-6-luna", name: "GPT-6-Luna" }], defaults: { model: "gpt-6-luna" }, roles: {}, effective: { model: "gpt-6-luna", effort: "high" }, session: { fast: true } } }
      : command.type === "loop.list" ? { ok: true, result: { loops: Array.from({ length: loops }, (_, at) => ({ loopId: `l${at}`, directory: DIR, state: "active" })) } } : undefined,
  })
  await h.start({ onboarded: true, tier: mode === "minimal" ? "minimalist" : mode, view: mode, reducedMotion: true, ...settings } as never)
  await Bun.sleep(5)
  if (quotas) for (const event of quotaScene("fresh")) h.app.onGlobal(event as never)
  if (graph) h.app.onGlobal({ type: "codegraph.status", gseq: 0, at: NOW, directory: DIR, state: "indexed", files: 2594, symbols: 17641, edges: 41203, partial: false } as never)
  h.message("hello", "hi")
  for (const [at, context] of [40_000, 60_000, 80_000, 100_000].slice(0, turns).entries()) {
    const turnId = ids("turn")
    h.event({ type: "turn.started", turnId, queueId: ids("queue") })
    h.event({ type: "usage.recorded", turnId, provider: "openai", model: "gpt-6-luna", input: 4_000, output: 300, reasoning: 0, cacheRead: at ? 30_000 : 0, cacheWrite: 0, contextTokens: context })
    h.event({ type: "turn.completed", turnId })
  }
  h.app.render()
  const below = () => {
    const rows = h.frames.at(-1)!.map(plain)
    return rows.slice(rows.findLastIndex((row) => /[─-]{20}/.test(row)) + 1).map((row) => row.trimEnd())
  }
  return { h, below }
}

describe("every footer segment declares where it shows", () => {
  test("the table covers every segment, and each view's list follows it", () => {
    expect(Object.keys(FOOTER_SEGMENT_TIER).sort()).toEqual([...FOOTER_SEGMENTS].sort())
    // Minimalist gains no chrome: the minimal view has no row under the prompt and places nothing.
    expect(tierFooter("minimal")).toEqual([])
    expect(tierFooter("balanced")).toEqual(["forecast"])
    // The full view's own segments, in drawing order: the code graph, the session's cache share, the quota windows.
    expect(tierFooter("full")).toEqual(["forecast", "codegraph", "cache", "quota"])
  })
})

describe("the row under the prompt, laid out in groups", () => {
  const part = (id: string, text: string, rank: number, compact?: string): FooterRowPart => ({ id, spans: [{ text }], rank, ...(compact ? { compact: [{ text: compact }] } : {}) })

  test("groups read left to right behind a divider; nothing is pushed to the right edge", () => {
    const row = renderStatusRow({ width: 100, agent: "Build", model: "GPT-6-Luna", effort: "high", fast: { mark: "fast", applies: true }, provider: "native", loops: 1, segments: [part("forecast", "~9 turns to compact", 1.2)] })
    expect(plain(row)).toBe("   Build · GPT-6-Luna · high · fast · native │ ↻ 1 loop │ ~9 turns to compact")
    expect(row.find((span) => span.text === "fast")).toMatchObject({ fg: "warning" })
    expect(row.find((span) => span.text === " │ ")).toMatchObject({ fg: "muted" })
  })

  test("fast that this model never gets says n/a, muted", () => {
    const row = renderStatusRow({ width: 100, agent: "Build", model: "Opus", fast: { mark: "fast", applies: false }, loops: 0 })
    expect(plain(row).trim()).toBe("Build · Opus · fast n/a")
    expect(row.find((span) => span.text === "fast n/a")).toMatchObject({ fg: "muted" })
  })

  test("narrow rows give way in rank order: segments, engine, effort, fast, loops, goal, model; the agent and a writing permission stay", () => {
    const base = { agent: "Build", permission: "full" as const, permissionLabel: "Full access", model: "GPT-6-Luna", effort: "high", fast: { mark: "fast", applies: true }, provider: "native", loops: 1, goal: [{ text: "◎ ship it" }], segments: [part("forecast", "~9 turns to compact", 1.2)] }
    const at = (width: number) => plain(renderStatusRow({ ...base, width })).trim()
    expect(at(120)).toBe("Build · Full access · GPT-6-Luna · high · fast · native │ ◎ ship it · ↻ 1 loop │ ~9 turns to compact")
    expect(at(100)).toBe("Build · Full access · GPT-6-Luna · high · fast · native │ ◎ ship it · ↻ 1 loop")
    expect(at(80)).toBe("Build · Full access · GPT-6-Luna · high · fast │ ◎ ship it · ↻ 1 loop")
    expect(at(70)).toBe("Build · Full access · GPT-6-Luna · fast │ ◎ ship it · ↻ 1 loop")
    expect(at(60)).toBe("Build · Full access · GPT-6-Luna │ ◎ ship it · ↻ 1 loop")
    expect(at(50)).toBe("Build · Full access · GPT-6-Luna │ ◎ ship it")
    expect(at(40)).toBe("Build · Full access · GPT-6-Luna")
    expect(at(30)).toBe("Build · Full access")
    // Eleven cells of room: the permission never gives way, it is cut.
    expect(at(16)).toBe("Build · Fu…")
  })

  test("a compact form comes before giving way, the lowest rank first", () => {
    const parts = [part("codegraph", "GRAPH 2,594 files · 17,641 symbols · 41,203 edges · indexed", 1.1, "GRAPH 2,594 files · indexed"), part("cache", "cache 85%", 1.1), part("quota", "codex 7d █░░░ 8% resets 5d9h", 1.3, "codex 7d 8%")]
    const at = (width: number) => plain(layoutGroups({ groups: parts.map((one) => [one]), width, separator: " · ", divider: " │ ", keepOne: true }))
    expect(at(120)).toBe("GRAPH 2,594 files · 17,641 symbols · 41,203 edges · indexed │ cache 85% │ codex 7d █░░░ 8% resets 5d9h")
    expect(at(85)).toBe("GRAPH 2,594 files · indexed │ cache 85% │ codex 7d █░░░ 8% resets 5d9h")
    expect(at(60)).toBe("GRAPH 2,594 files · indexed │ cache 85% │ codex 7d 8%")
    // Compact graph and quota still need 41 cells: the cache, then the graph give way, and the quota fits whole again.
    expect(at(40)).toBe("codex 7d █░░░ 8% resets 5d9h")
    expect(at(20)).toBe("codex 7d 8%")
    // One part always stays on the detail row, cut when it must be.
    expect(at(8)).toBe("codex 7…")
  })

  test("a compacted part gets its whole form back when it fits beside the others' compact forms", () => {
    // `a` compacts first (lower rank) but saves little; `b` must compact too, and then `a` fits whole again.
    const parts = [part("a", "a".repeat(30), 1, "a".repeat(10)), part("b", "b".repeat(40), 2, "b".repeat(5))]
    expect(plain(layoutGroups({ groups: parts.map((one) => [one]), width: 50, separator: " · ", divider: " │ " }))).toBe(`${"a".repeat(30)} │ ${"b".repeat(5)}`)
  })

  test("the detail row starts at the status row's margin", () => {
    expect(plain(renderDetailRow({ parts: [part("cache", "cache 85%", 1.1)], width: 60 }))).toBe("   cache 85%")
  })

  test("a statusLeft template keeps the old layout: the live counts and the placed segments stay on the right", () => {
    const row = renderStatusRow({ width: 60, leftItems: [{ text: "custom" }], loops: 2, segments: [part("forecast", "~9 turns to compact", 1.2)] })
    expect(plain(row)).toMatch(/^ {3}custom +↻ 2 loops {2}~9 turns to compact$/)
  })
})

describe("plan mode is named once", () => {
  test("the agent label says Plan, so the permission does not repeat it; every other mode keeps both", () => {
    const row = (agent: string, permission: "plan" | "edits" | "full" | "smart" | "ask", label: string) => plain(renderStatusRow({ width: 100, agent, permission, permissionLabel: label, model: "GPT-6-Luna", effort: "low", loops: 0 })).trim()
    expect(row("Plan", "plan", "plan mode")).toBe("Plan · GPT-6-Luna · low")
    expect(row("Build", "edits", "auto edits")).toBe("Build · auto edits · GPT-6-Luna · low")
    expect(row("Build", "full", "full access")).toBe("Build · full access · GPT-6-Luna · low")
    expect(row("Build", "smart", "smart approval")).toBe("Build · smart approval · GPT-6-Luna · low")
    expect(row("Build", "ask", "ask before edits")).toBe("Build · GPT-6-Luna · low")
  })

  test("without the agent label the permission still says it is plan mode", () => {
    expect(plain(renderStatusRow({ width: 100, permission: "plan", permissionLabel: "plan mode", model: "GPT-6-Luna", loops: 0 })).trim()).toBe("plan mode · GPT-6-Luna")
  })

  for (const [name, mode, profile] of [["the balanced row", "balanced", {}], ["the full view's built-in rows", "full", {}], ["a statusLeft template with mode", "balanced", { statusLeft: "mode,permissionMode,model,reasoning" }], ["a footer preset", "balanced", { footerRows: [["directory", "model", "effort"]] }]] as const) {
    test(`in the app, ${name} reads plan mode once`, async () => {
      const { h, below } = await scene({ mode, width: 100, profile: { ...profile } as Partial<TuiProfile>, quotas: false, graph: false })
      h.event({ type: "session.permission", mode: "plan" })
      h.app.render()
      const text = below().join("\n")
      expect(text.match(/plan mode|Plan/gi)?.length).toBe(1)
      h.event({ type: "session.permission", mode: "edits" })
      h.app.render()
      expect(below().join("\n")).toContain("auto edits")
    })
  }
})

describe("the footer by tier in the app", () => {
  test("minimalist: no row under the prompt at any width (only the blank row the minimal view always ends with)", async () => {
    for (const width of [60, 100, 160]) expect((await scene({ mode: "minimal", width })).below()).toEqual([""])
  })

  test("balanced: one calm line of mode, model, effort, fast, engine, then the loop and the forecast", async () => {
    expect((await scene({ mode: "balanced", width: 160 })).below()).toEqual(["   Build · GPT-6-Luna · high · fast · chatgpt │ ↻ 1 loop │ ~12 turns to compact"])
    expect((await scene({ mode: "balanced", width: 100 })).below()).toEqual(["   Build · GPT-6-Luna · high · fast · chatgpt │ ↻ 1 loop │ ~12 turns to compact"])
    // At 60 the forecast gives way first; quota, graph and cache are not balanced segments, so they never show here.
    expect((await scene({ mode: "balanced", width: 60 })).below()).toEqual(["   Build · GPT-6-Luna · high · fast · chatgpt │ ↻ 1 loop"])
  })

  test("full: the footer is the line preset until the user chooses one: directory, model, effort, cache, quotas and graph on one row, the loop at the right", async () => {
    const wide = await scene({ mode: "full", width: 160 })
    const rows = wide.below()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toStartWith("   ~/Code/MendCodeV2 · GPT-6-Luna fast · high:JEV · cache 85% · codex 7d 92% left  claude 7d 39% left 5h 89% left · GRAPH 2,594 files · indexed")
    expect(rows[0]).toEndWith("↻ 1 loop")
    // The context is the prompt's own figure: the footer does not repeat it.
    expect(rows[0]).not.toContain("context")
    // The tier's own graph row never asks the daemon for its savings: no new request per model call.
    expect(wide.h.sent.some((command) => command.type === "session.savings")).toBe(false)
  })

  test("full: narrow widths compact the counts, then drop the lowest ranks, and keep the directory and model", async () => {
    expect((await scene({ mode: "full", width: 120 })).below()).toEqual(["   ~/Code/MendCodeV2 · GPT-6-Luna fast · high:JEV · cache 85% · codex 7d 92% left  claude 7d 39% left 5h 89%  ↻ 1 loop"])
    expect((await scene({ mode: "full", width: 50 })).below()).toEqual(["   ~/Code/MendCodeV2 · GPT-6-Luna fast  ↻ 1 loop"])
    expect((await scene({ mode: "full", width: 80, height: 24 })).below()).toEqual(["   ~/Code/MendCodeV2 · GPT-6-Luna fast                                ↻ 1 loop"])
  })

  test("full: a provider with no reading and a graph not counted yet leave nothing in the row", async () => {
    const none = (await scene({ mode: "full", width: 160, quotas: false })).below()
    expect(none).toHaveLength(1)
    expect(none[0]).not.toContain("codex")
    expect(none[0]).toContain("GRAPH 2,594 files")
    const nothingYet = (await scene({ mode: "full", width: 160, quotas: false, graph: false })).below()
    expect(nothingYet).toHaveLength(1)
    expect(nothingYet[0]).toStartWith("   ~/Code/MendCodeV2 · GPT-6-Luna")
  })

  test("full: the line is one row at any height", async () => {
    for (const height of [20, 12, 8]) expect((await scene({ mode: "full", width: 160, height })).below()).toHaveLength(1)
  })

  test("full: `rows` brings back the five-row footer", async () => {
    const rows = (await scene({ mode: "full", width: 160, profile: { footerRows: FOOTER_PRESETS.rows!.rows.map((row) => [...row]) } })).below()
    expect(rows).toHaveLength(5)
    expect(rows[1]).toBe("   GPT-6-Luna fast · high:JEV · context 21% · cache 85% · in 106K out 1,200 cr 90K")
    expect(rows[2]).toStartWith("   CODEX 7d ")
  })

  test("full: what the user chose wins: their rows, `/footer preset classic` (the single row) and a `/footer` list", async () => {
    const chosen = (await scene({ mode: "full", width: 160, profile: { footerRows: [["model", "context"]] } })).below()
    expect(chosen).toHaveLength(1)
    expect(chosen[0]).toStartWith("   GPT-6-Luna fast · context 21%")
    const classic = (await scene({ mode: "full", width: 160, profile: { footerDefaultRows: false } })).below()
    expect(classic).toEqual([
      "   Build · GPT-6-Luna · high · fast · chatgpt │ ↻ 1 loop │ ~12 turns to compact",
      "   GRAPH 2,594 files · indexed │ cache 85% │ codex 7d █░░░░░░░ 8% resets 5d9h  claude 7d █████░░░ 61% resets 1d23h 5h █░░░░░░░ 11% resets 2h",
    ])
    const listed = (await scene({ mode: "full", width: 160, settings: { footer: ["state", "context"] } })).below()
    expect(listed).toHaveLength(1)
  })

  test("screen-reader mode: the default rows keep their words and drop the bars", async () => {
    const rows = (await scene({ mode: "full", width: 160, profile: { accessible: true } })).below()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain("codex 7d 92% left")
    expect(rows[0]).not.toMatch(/[█░]/)
  })

  test("ASCII glyphs: a plain bar between groups and no arrow before the loop", async () => {
    const rows = (await scene({ mode: "balanced", width: 100, profile: { glyphs: "ascii" } })).below()
    expect(rows).toEqual(["   Build - GPT-6-Luna - high - fast - chatgpt | 1 loop | ~12 turns to compact"])
  })

  test("showEffort off hides the effort; the tier never forces it back", async () => {
    expect((await scene({ mode: "balanced", width: 100, profile: { showEffort: false } })).below()).toEqual(["   Build · GPT-6-Luna · fast · chatgpt │ ↻ 1 loop │ ~12 turns to compact"])
  })
})
