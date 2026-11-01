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

type Scene = { mode: "minimal" | "balanced" | "full"; width: number; height?: number; profile?: Partial<TuiProfile>; graph?: boolean; quotas?: boolean; loops?: number; turns?: number }

/**
 * A session after a few turns of a growing context, on a fake daemon: GPT-6-Luna at high effort with `/fast` on, one live loop, the
 * code graph indexed and both quota providers read. The rows from the prompt's bottom rule down are what the footer drew.
 */
async function scene({ mode, width, height = 30, profile = {}, graph = true, quotas = true, loops = 1, turns = 4 }: Scene) {
  const layout = scratch()
  cleanups.push(layout.cleanup)
  writeTuiProfile(layout.dataDir, { ...DEFAULT_TUI_PROFILE, sidebar: "hidden", ...profile })
  const h = await appHarness({
    dataDir: layout.dataDir, directory: DIR, home: "/Users/dev", width, height, mode,
    reply: (command) => command.type === "models.list"
      ? { ok: true, result: { engine: "native", selectable: true, models: [{ id: "gpt-6-luna", name: "GPT-6-Luna" }], defaults: { model: "gpt-6-luna" }, roles: {}, effective: { model: "gpt-6-luna", effort: "high" }, session: { fast: true } } }
      : command.type === "loop.list" ? { ok: true, result: { loops: Array.from({ length: loops }, (_, at) => ({ loopId: `l${at}`, directory: DIR, state: "active" })) } } : undefined,
  })
  await h.start({ onboarded: true, tier: mode === "minimal" ? "minimalist" : mode, view: mode, reducedMotion: true } as never)
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

  test("full: a second row for the code graph, the cache share and the quota windows, compacting before anything gives way", async () => {
    const wide = await scene({ mode: "full", width: 160 })
    expect(wide.below()).toEqual([
      "   Build · GPT-6-Luna · high · fast · chatgpt │ ↻ 1 loop │ ~12 turns to compact",
      "   GRAPH 2,594 files · indexed │ cache 85% │ codex 7d █░░░░░░░ 8% resets 5d9h  claude 7d █████░░░ 61% resets 1d23h 5h █░░░░░░░ 11% resets 2h",
    ])
    expect((await scene({ mode: "full", width: 100 })).below()[1]).toBe("   GRAPH 2,594 files · indexed │ cache 85% │ codex 7d 8%  claude 7d 61% 5h 11%")
    // Without the quota readings the graph has the room for its whole form.
    expect((await scene({ mode: "full", width: 100, quotas: false })).below()[1]).toBe("   GRAPH 2,594 files · 17,641 symbols · 41,203 edges · indexed │ cache 85%")
    expect((await scene({ mode: "full", width: 60 })).below()[1]).toBe("   codex 7d 8%  claude 7d 61% 5h 11%")
    // The tier's own graph never asks the daemon for its savings: no new request per model call.
    expect(wide.h.sent.some((command) => command.type === "session.savings")).toBe(false)
  })

  test("full: the graph waits for what the daemon pushed, and the row is absent while nothing has something to show", async () => {
    const fresh = await scene({ mode: "full", width: 160, graph: false, quotas: false, turns: 0, loops: 0 })
    expect(fresh.below()).toEqual(["   Build · GPT-6-Luna · high · fast · chatgpt"])
  })

  test("the cache share waits for the second call: the first call of every session is cold", async () => {
    expect((await scene({ mode: "full", width: 160, graph: false, quotas: false, loops: 0, turns: 1 })).below()).toEqual(["   Build · GPT-6-Luna · high · fast · chatgpt"])
    expect((await scene({ mode: "full", width: 160, graph: false, quotas: false, loops: 0, turns: 2 })).below()[1]).toBe("   cache 79%")
  })

  test("full under 24 rows keeps one row: its segments join the first and give way first", async () => {
    // The row is worth more to the transcript and the panel sheet on a short terminal.
    const rows = (await scene({ mode: "full", width: 160, height: 23 })).below()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toStartWith("   Build · GPT-6-Luna · high · fast · chatgpt │ ↻ 1 loop │ ~12 turns to compact │ GRAPH")
  })

  test("screen-reader mode: one separator, words without marks, quota figures without bars", async () => {
    const rows = (await scene({ mode: "full", width: 160, profile: { accessible: true } })).below()
    expect(rows[0]).toBe("   Build · GPT-6-Luna · high · fast · chatgpt · 1 loop · ~12 turns to compact")
    expect(rows[1]).toBe("   GRAPH 2,594 files · 17,641 symbols · 41,203 edges · indexed · cache 85% · codex 7d 8%  claude 7d 61% 5h 11%")
  })

  test("ASCII glyphs: a plain bar between groups and no arrow before the loop", async () => {
    const rows = (await scene({ mode: "balanced", width: 100, profile: { glyphs: "ascii" } })).below()
    expect(rows).toEqual(["   Build - GPT-6-Luna - high - fast - chatgpt | 1 loop | ~12 turns to compact"])
  })

  test("showEffort off hides the effort; the tier never forces it back", async () => {
    expect((await scene({ mode: "balanced", width: 100, profile: { showEffort: false } })).below()).toEqual(["   Build · GPT-6-Luna · fast · chatgpt │ ↻ 1 loop │ ~12 turns to compact"])
  })
})
