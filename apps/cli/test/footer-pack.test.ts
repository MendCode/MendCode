import { afterEach, describe, expect, test } from "bun:test"
import { createIdFactory, FOOTER_PACK_BUILTINS, footerPackProblems, tuiProblems, type FooterPackFile } from "@mendcode/protocol/wire"
import { DEFAULT_TUI_PROFILE, normalizeTuiProfile, writeTuiProfile, type TuiProfile } from "../src/view/tui-profile"
import { BUILTIN_FOOTER_PACKS, footerPackNamed, packBar, packLook, parseFooterPackCommand, pieGlyph, registerFooterPacks, renderFooterPack, type PackFacts } from "../src/view/footer-pack"
import { CUSTOMIZE_ROWS } from "../src/view/customize-page"
import type { Line } from "../src/ui/theme"
import { appHarness, plain, scratch } from "./extensions-harness"
import { NOW } from "./footer-rows-fixture"

const ids = createIdFactory()
const DIR = "/Users/dev/Code/MendCodeV2"
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  registerFooterPacks([])
})

const text = (line: Line) => plain(line).trimEnd()
const squeeze = (line: Line) => text(line).trim().replace(/ {2,}/g, "  ")

/** A session that says everything a pack can show. */
const FULL: PackFacts = {
  now: NOW, directory: "~/Code/MendCodeV2", branch: "main", git: { staged: 2, unstaged: 3, untracked: 1, ahead: 1 },
  diff: { added: 120, removed: 4 }, model: "GPT-6-Luna", effort: "high", context: { tokens: 48_000, limit: 200_000 },
  quotas: [{ provider: "claude", windows: [{ id: "five_hour", label: "5h", usedPercent: 88 }], fetchedAt: NOW, source: "test" }],
  costMicros: 420_000, jobs: 1, agents: 2, mode: "Build", permission: "ask", permissionLabel: "ask", connection: "connected",
}
/** A quiet session: nothing running, nothing changed, nothing spent, every quota far from its limit. */
const QUIET: PackFacts = {
  now: NOW, directory: "~/Code/MendCodeV2", branch: "main", model: "GPT-6-Luna", effort: "high", context: { tokens: 48_000, limit: 200_000 },
  quotas: [{ provider: "claude", windows: [{ id: "five_hour", label: "5h", usedPercent: 40 }], fetchedAt: NOW, source: "test" }],
  diff: { added: 0, removed: 0 }, costMicros: 0, jobs: 0, agents: 0, loops: 0, workflows: 0, mode: "Build", permission: "ask", connection: "connected",
}
const draw = (name: string, facts: PackFacts, width = 200, glyphs: "text" | "unicode" | "nerd" | "ascii" = "unicode") => renderFooterPack({ pack: BUILTIN_FOOTER_PACKS[name]!, facts, width, glyphs, limit: 6 })

describe("footer pack files", () => {
  test("every built-in pack is a valid file, and the list the protocol keeps names them all in order", () => {
    expect(Object.keys(BUILTIN_FOOTER_PACKS)).toEqual([...FOOTER_PACK_BUILTINS])
    for (const pack of Object.values(BUILTIN_FOOTER_PACKS)) expect(footerPackProblems(JSON.parse(JSON.stringify(pack)))).toEqual([])
  })

  test("a broken file says what is wrong in one line", () => {
    expect(footerPackProblems({ rows: [] })[0]).toContain("rows")
    expect(footerPackProblems({ rows: [{ left: ["moddel"] }] })[0]).toContain('unknown segment "moddel"')
    expect(footerPackProblems({ rows: [{ left: ["model"] }], context: "donut" })[0]).toContain("context: one of")
    expect(footerPackProblems({ rows: [{ left: ["model"] }], colour: {} })[0]).toBe('unknown key "colour"')
    expect(footerPackProblems({ rows: [{ left: ["model"] }], symbols: { emoji: {} } })[0]).toContain('unknown glyph set "emoji"')
    expect(footerPackProblems({ rows: [{ left: ["model"] }], contextWarn: [95, 80] })[0]).toContain("contextWarn")
  })

  test("a file from a layer wins over a built-in of its name; a bad file or an unknown role is a problem, not a pack", () => {
    const mine: FooterPackFile = { rows: [{ left: ["model"], right: ["context"] }], context: "fraction" }
    const problems = registerFooterPacks([{ name: "clean", json: mine }, { name: "broken", json: { rows: "x" } }, { name: "tinted", json: { rows: [{ left: ["model"] }], colors: { model: "chartreuse" } } }])
    expect(problems.map((problem) => problem.name)).toEqual(["broken", "tinted"])
    expect(problems[1]!.message).toContain('"chartreuse" is not a theme role')
    expect(footerPackNamed("clean")).toBe(mine)
    // A pack that is gone (its profile turned off) leaves the default, never a blank footer; `off` is the built-in footer.
    expect(footerPackNamed("tinted")).toBe(BUILTIN_FOOTER_PACKS.clean)
    expect(footerPackNamed("off")).toBeUndefined()
  })

  test("a glyph set the pack leaves out falls back down the line: nerd to unicode to ascii, and text is the file's own fields", () => {
    const powerline = BUILTIN_FOOTER_PACKS.powerline!
    expect(packLook(powerline, "nerd").arrows).toEqual({ left: "", right: "" })
    // No Nerd Font: the powerline pack is flat blocks, its ASCII form.
    expect(packLook(powerline, "unicode").arrows).toBeUndefined()
    expect(packLook(BUILTIN_FOOTER_PACKS.clean!, "nerd").context).toBe("pie")
    expect(packLook(BUILTIN_FOOTER_PACKS.clean!, "text").context).toBe("percent")
  })

  test("the profile keeps a pack name, the symbols and the stack; anything else falls back", () => {
    expect(DEFAULT_TUI_PROFILE.footerPack).toBe("clean")
    expect(normalizeTuiProfile({ footerPack: "my-look", footerPackSymbols: "text", footerPackStack: true })).toMatchObject({ footerPack: "my-look", footerPackSymbols: "text", footerPackStack: true })
    expect(normalizeTuiProfile({ footerPack: "../etc", footerPackSymbols: "emoji" })).toMatchObject({ footerPack: "clean", footerPackSymbols: "auto" })
    expect(tuiProblems({ footerPack: "Bad Name" })[0]).toContain("footerPack")
    expect(tuiProblems({ footerPack: "powerline", footerPackSymbols: "text", footerPackStack: false })).toEqual([])
  })

  test("/customize has one Footer pack row", () => {
    expect(CUSTOMIZE_ROWS.filter((row) => row === "footerPack")).toEqual(["footerPack"])
  })
})

describe("what a pack draws", () => {
  test("clean: folder and branch on the left, model, effort and context on the right; a quiet session shows nothing else", () => {
    expect(draw("clean", QUIET).map(squeeze)).toEqual(["~/Code/MendCodeV2 · main  GPT-6-Luna · high · ◔ 24%"])
    expect(draw("clean", QUIET, 200, "text").map(squeeze)).toEqual(["~/Code/MendCodeV2 · main  GPT-6-Luna · high · ctx 24%"])
  })

  test("contextual parts show only when they say something: changes, shells, agents, a quota near its limit, a cost", () => {
    const busy = draw("clean", FULL).map(squeeze)[0]!
    for (const part of ["+120 -4", "1 shell", "2 agents", "5h 12% left", "$0.42"]) expect(busy).toContain(part)
    const quiet = draw("clean", QUIET).map(squeeze)[0]!
    for (const part of ["+0", "shell", "agent", "left", "$"]) expect(quiet).not.toContain(part)
    // The bars pack shows every window whatever is left.
    expect(draw("bars", QUIET, 200, "ascii").map(squeeze)).toContain("5h [##....] 60% left")
  })

  test("the context turns amber at 70% and red at 90%; the plain pack says so in words too", () => {
    const tone = (tokens: number, name = "clean") => {
      const spans = draw(name, { ...QUIET, context: { tokens, limit: 100_000 } })[0]!
      return spans.find((span) => /\d+%/.test(span.text) && !span.text.includes("left"))
    }
    expect(tone(69_000)!.fg).toBe("muted")
    expect(tone(70_000)!.fg).toBe("warning")
    expect(tone(90_000)!.fg).toBe("error")
    expect(tone(92_000, "plain")!.text).toBe("92% near limit")
    expect([0, 20, 50, 75, 100].map(pieGlyph).join("")).toBe("○◔◑◕●")
    expect(packBar(41, false)).toBe("▕██▌░░░▏")
    expect(packBar(41, true)).toBe("[##....]")
  })

  test("a permission that acts without asking and a lost connection always show, even in a pack that leaves them out", () => {
    const facts = { ...QUIET, permission: "full" as const, permissionLabel: "full access", connection: "reconnecting" as const }
    const minimal = draw("minimal", facts, 60).map(squeeze)[0]!
    expect(minimal).toContain("full access")
    expect(minimal).toContain("offline · reconnecting…")
    const own = renderFooterPack({ pack: { rows: [{ left: ["model"] }] }, facts, width: 120, glyphs: "text", limit: 1 }).map(squeeze)[0]!
    expect(own).toContain("full access")
  })

  test("too narrow: shorter forms first, then the lowest ranks give way; the context and the permission stay", () => {
    const narrow = draw("clean", { ...FULL, permission: "edits", permissionLabel: "auto-edit" }, 60).map(text)
    expect(narrow).toHaveLength(1)
    expect(narrow[0]!.length).toBeLessThanOrEqual(58)
    expect(narrow[0]).toContain("auto-edit")
    expect(narrow[0]).toContain("◔ 24%")
    expect(narrow[0]).not.toContain("high")
  })

  test("powerline joins coloured chips with arrows on a Nerd Font and draws flat blocks without one", () => {
    const nerd = draw("powerline", FULL, 200, "nerd")[0]!
    expect(nerd.some((span) => span.text === "")).toBe(true)
    expect(nerd.find((span) => span.text.includes("main"))).toMatchObject({ bg: "secondary", fg: "background" })
    expect(text(nerd)).toContain("main +2 *3 ?1 ↑1")
    const flat = draw("powerline", FULL, 200, "ascii")[0]!
    expect(text(flat)).not.toMatch(/[-]/)
    expect(text(flat)).toContain("main +2 *3 ?1 ^1")
  })

  test("badges: the agent and the permission as chips, the context with its real denominator", () => {
    const row = draw("badges", { ...FULL, permission: "plan", permissionLabel: "plan", mode: "Plan" })[0]!
    expect(row.find((span) => span.text === " PLAN ")).toMatchObject({ bg: "primary", fg: "background" })
    expect(text(row)).toContain("48K/200K")
    // Plan mode is named once.
    expect(text(row).match(/PLAN/g)).toHaveLength(1)
  })

  test("bars: several rows, the context and each quota window as a bar; plain: words, brackets, no symbols", () => {
    expect(draw("bars", FULL).map(squeeze).slice(1)).toEqual(["ctx ▕█▌░░░░▏ 24%  $0.42 · 1 shell · 2 agents", "5h ▕█████▎▏ 12% left"])
    const plainRow = draw("plain", { ...FULL, permission: "full", permissionLabel: "full access" }, 200, "nerd").map(squeeze)[0]!
    expect(plainRow).toContain("[FULL ACCESS]")
    expect(plainRow).toContain("dir ~/Code/MendCodeV2 | git main")
    expect(plainRow).toContain("quota 5h 12% left low")
    expect(plainRow).not.toMatch(/[▀-◿-]/)
  })
})

describe("/footer pack", () => {
  const current = { pack: "clean", symbols: "auto" as const, stack: false }
  test("alone it lists the packs and marks the one in use", () => {
    const listed = parseFooterPackCommand("pack", current)
    expect(listed).toMatchObject({ ok: false })
    expect((listed as { error: string }).error).toContain("clean*, powerline, minimal, badges, bars, plain, off")
  })
  test("a name, then text or symbols, then stack or alone", () => {
    expect(parseFooterPackCommand("pack powerline text stack", current)).toMatchObject({ ok: true, patch: { footerPack: "powerline", footerPackSymbols: "text", footerPackStack: true } })
    expect(parseFooterPackCommand("pack nope", current)).toMatchObject({ ok: false })
    expect(parseFooterPackCommand("rows 2", current)).toBeUndefined()
  })
})

type Scene = { mode?: "balanced" | "full"; width?: number; profile?: Partial<TuiProfile>; ext?: boolean }

/** A session after one model call, on a fake daemon. The rows under the prompt's bottom rule are the footer. */
async function scene({ mode = "balanced", width = 120, profile = {} }: Scene = {}) {
  const layout = scratch()
  cleanups.push(layout.cleanup)
  writeTuiProfile(layout.dataDir, { ...DEFAULT_TUI_PROFILE, sidebar: "hidden", ...profile })
  const h = await appHarness({
    dataDir: layout.dataDir, directory: DIR, home: "/Users/dev", width, height: 30, mode,
    reply: (command) => command.type === "models.list" ? { ok: true, result: { engine: "native", selectable: true, models: [{ id: "gpt-6-luna", name: "GPT-6-Luna", efforts: ["low", "medium", "high"] }], defaults: { model: "gpt-6-luna" }, roles: {}, effective: { model: "gpt-6-luna", effort: "high" } } }
      : command.type === "git.branch" ? { ok: true, result: { branch: "main" } } : undefined,
  })
  await h.start({ onboarded: true, tier: mode, view: mode, reducedMotion: true } as never)
  await Bun.sleep(5)
  h.message("hello", "hi")
  const turnId = ids("turn")
  h.event({ type: "turn.started", turnId, queueId: ids("queue") })
  h.event({ type: "usage.recorded", turnId, provider: "openai", model: "gpt-6-luna", input: 4_000, output: 300, reasoning: 0, cacheRead: 0, cacheWrite: 0, contextTokens: 80_000 })
  h.event({ type: "turn.completed", turnId })
  await Bun.sleep(5)
  h.app.render()
  const below = () => {
    const rows = h.frames.at(-1)!.map(plain)
    return rows.slice(rows.findLastIndex((row) => /^ *─{20,} *$/.test(row)) + 1).map((row) => row.trim().replace(/ {2,}/g, "  ")).filter(Boolean)
  }
  return { h, below }
}

describe("the pack in the app", () => {
  for (const mode of ["balanced", "full"] as const) {
    test(`${mode}: the default footer is the clean pack`, async () => {
      const { below } = await scene({ mode })
      // Adaptive reasoning (on in the full tier) marks the effort, as the rows do.
      expect(below()).toEqual([expect.stringMatching(new RegExp(`^~/Code/MendCodeV2 · main {2}GPT-6-Luna · high${mode === "full" ? ":JEV" : ""} · [○◔◑◕●] \\d+%$`))])
    })
  }

  test("a footer of the user's own stays: rows, a /footer list, a template; footerPack off is the built-in footer", async () => {
    const rows = await scene({ profile: { footerRows: [["model", "effort"]] } })
    expect(rows.below()).toEqual(["GPT-6-Luna · high"])
    const template = await scene({ profile: { statusLeft: "model,reasoning" } })
    expect(template.below()[0]).toMatch(/^GPT-6-Luna · high/)
    const off = await scene({ profile: { footerPack: "off" } })
    expect(off.below()[0]).toMatch(/^Build · GPT-6-Luna · high/)
  })

  test("footerPackStack draws the pack above the user's own footer instead of standing aside", async () => {
    const { below } = await scene({ profile: { footerRows: [["model", "effort"]], footerPack: "minimal", footerPackStack: true } })
    expect(below()).toEqual([expect.stringMatching(/^GPT-6-Luna · [○◔◑◕●] \d+%$/), "GPT-6-Luna · high"])
  })

  test("text symbols draw words only", async () => {
    const { below } = await scene({ profile: { footerPackSymbols: "text" } })
    expect(below()[0]).toMatch(/high · ctx \d+%$/)
  })

  test("/footer pack switches it at once; with a footer of the user's own it says the pack stands aside", async () => {
    const { h, below } = await scene()
    await h.type("/footer pack minimal\r")
    expect(below()[0]).toMatch(/^GPT-6-Luna · [○◔◑◕●] \d+%$/)
    const own = await scene({ profile: { footerRows: [["model"]] } })
    await own.h.type("/footer pack powerline\r")
    expect(own.h.text()).toContain("your own footer stays")
  })

  test("with the status line in the prompt's border the pack leaves out what it says: folder, branch, model, effort, context", async () => {
    const { h, below } = await scene({ profile: { promptStatus: "border" } })
    const rule = h.frames.at(-1)!.map(plain).find((row) => row.includes("READY"))!
    expect(rule).toContain("GPT-6-Luna")
    expect(below().join("\n")).not.toMatch(/GPT-6-Luna|high|MendCodeV2|main|%/)
  })

  test("with the status line in the border, the activity is its first part and no row of its own repeats it", async () => {
    const { h } = await scene({ width: 140, profile: { promptStatus: "border" } })
    h.working()
    await Bun.sleep(2)
    h.app.render()
    const rows = h.frames.at(-1)!.map(plain)
    const rule = rows.find((row) => row.includes("Generating"))!
    expect(rule).toContain("─")
    expect(rule).toContain("GPT-6-Luna")
    expect(rule).not.toContain("READY")
    expect(rows.filter((row) => row.includes("Generating"))).toHaveLength(1)
  })
})
