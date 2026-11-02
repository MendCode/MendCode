import { afterEach, describe, expect, test } from "bun:test"
import { createIdFactory, FOOTER_SEGMENTS, FOOTER_SEGMENT_TIER, tierFooter } from "@mendcode/protocol/wire"
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
  writeTuiProfile(layout.dataDir, { ...DEFAULT_TUI_PROFILE, sidebar: "hidden", ...profile })
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

  test("full: the footer is the rows preset until the user chooses one: directory, model and session figures, a row per quota provider, the code graph", async () => {
    const wide = await scene({ mode: "full", width: 160 })
    const rows = wide.below()
    expect(rows).toHaveLength(5)
    expect(rows[0]).toStartWith("   ~/Code/MendCodeV2 ")
    expect(rows[0]).toEndWith("↻ 1 loop")
    expect(rows.slice(1)).toEqual([
      "   GPT-6-Luna fast · high:JEV · context 21% · cache 85% · in 106K out 1,200 cr 90K",
      "   CODEX 7d ███████░ 92% left resets 5d9h · 5h n/a",
      "   CLAUDE 7d ███░░░░░ 39% left resets 1d23h · 5h ███████░ 89% left resets 2h",
      "   GRAPH 2,594 files · 17,641 symbols · 41,203 edges · indexed",
    ])
    // The tier's own graph row never asks the daemon for its savings: no new request per model call.
    expect(wide.h.sent.some((command) => command.type === "session.savings")).toBe(false)
  })

  test("full: narrow widths keep every row and compact the counts before anything gives way", async () => {
    const narrow = (await scene({ mode: "full", width: 50 })).below()
    expect(narrow.slice(1)).toEqual([
      "   GPT-6-Luna fast · high:JEV · context 21%",
      "   CODEX 7d 92% left · 5h n/a",
      "   CLAUDE 7d 39% left · 5h 89% left",
      "   GRAPH 2,594 files · indexed",
    ])
    const classicWidth = (await scene({ mode: "full", width: 80, height: 24 })).below()
    expect(classicWidth).toHaveLength(5)
    expect(classicWidth[1]).toBe("   GPT-6-Luna fast · high:JEV · context 21% · cache 85%")
  })

  test("full: a provider with no reading and a graph not counted yet leave no row, and the rows under them move up", async () => {
    const none = (await scene({ mode: "full", width: 160, quotas: false })).below()
    expect(none.map((row) => row.trim().split(" ")[0])).toEqual(["~/Code/MendCodeV2", "GPT-6-Luna", "GRAPH"])
    const nothingYet = (await scene({ mode: "full", width: 160, quotas: false, graph: false })).below()
    expect(nothingYet).toHaveLength(2)
    expect(nothingYet[1]).toStartWith("   GPT-6-Luna")
  })

  test("full: rows are cut to a quarter of the height from the bottom: the graph first, then Claude, then Codex", async () => {
    // Terminal height / 4, rounded down: 20 rows allow 5, 16 allow 4, 12 allow 3, 8 allow 2.
    expect((await scene({ mode: "full", width: 160, height: 20 })).below().map((row) => row.trim().split(" ")[0])).toEqual(["~/Code/MendCodeV2", "GPT-6-Luna", "CODEX", "CLAUDE", "GRAPH"])
    expect((await scene({ mode: "full", width: 160, height: 16 })).below().map((row) => row.trim().split(" ")[0])).toEqual(["~/Code/MendCodeV2", "GPT-6-Luna", "CODEX", "CLAUDE"])
    expect((await scene({ mode: "full", width: 160, height: 12 })).below().map((row) => row.trim().split(" ")[0])).toEqual(["~/Code/MendCodeV2", "GPT-6-Luna", "CODEX"])
    expect((await scene({ mode: "full", width: 160, height: 8 })).below().map((row) => row.trim().split(" ")[0])).toEqual(["~/Code/MendCodeV2", "GPT-6-Luna"])
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
    expect(rows.slice(2, 4)).toEqual(["   CODEX 7d 92% left · 5h n/a", "   CLAUDE 7d 39% left · 5h 89% left"])
  })

  test("ASCII glyphs: a plain bar between groups and no arrow before the loop", async () => {
    const rows = (await scene({ mode: "balanced", width: 100, profile: { glyphs: "ascii" } })).below()
    expect(rows).toEqual(["   Build - GPT-6-Luna - high - fast - chatgpt | 1 loop | ~12 turns to compact"])
  })

  test("showEffort off hides the effort; the tier never forces it back", async () => {
    expect((await scene({ mode: "balanced", width: 100, profile: { showEffort: false } })).below()).toEqual(["   Build · GPT-6-Luna · fast · chatgpt │ ↻ 1 loop │ ~12 turns to compact"])
  })
})
