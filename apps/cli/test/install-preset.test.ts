import { afterEach, describe, expect, test } from "bun:test"
import type { CommandInput } from "@mendcode/client"
import { cleanTemps } from "./session-ui-harness"
import { onboardingHarness, type Machine } from "./onboarding-harness"

afterEach(cleanTemps)

type Harness = ReturnType<typeof onboardingHarness>
const patches = (h: Harness) => h.sets()
const keys = async (h: Harness, ...list: string[]) => { for (const key of list) await h.app.onKey(key); await Bun.sleep(5); h.app.render() }
const screen = (h: Harness) => h.text().join("\n")
const launch = async (machine: Machine, settings: Record<string, unknown>, preset?: "minimalist" | "balanced" | "full", reply?: (command: CommandInput) => never | undefined) => {
  const h = onboardingHarness(machine, { width: 80, height: 24, ...(reply ? { reply } : {}) })
  h.app.applySettings(settings as never)
  const before = h.sent.length
  await h.app.openSetupIfFirstRun(settings as never, preset)
  await Bun.sleep(5)
  h.app.render()
  // The app's own start-up traffic is not the preset's: only what a first launch would ask or write counts.
  return Object.assign(h, { fresh: () => h.sent.slice(before).filter((command) => /^(settings|prompt)\.set$|^setup\.|^providers\.list$|^daemon\.info$/.test(command.type)) })
}

describe("the installer's preset on the first launch", () => {
  test("minimalist goes straight to the prompt: no setup page, the tier bundle and the detected model are saved", async () => {
    const h = await launch({ claude: true, keys: ["anthropic"] }, {}, "minimalist")
    expect(h.app.page).toBe("chat")
    expect(screen(h)).not.toMatch(/welcome|Ready|Setup/)
    expect(patches(h)[0]).toMatchObject({ tier: "minimalist", view: "minimal" })
    expect(h.sentOf("prompt.set")[0]).toMatchObject({ mode: "minimal" })
    expect(patches(h).at(-1)).toEqual({ onboarded: true, models: { main: { model: "claude-sonnet" } } })
    expect(h.sentOf("setup.import")).toEqual([])
  })
  test("detection is the setup page's own: the same order picks ChatGPT, then Claude Code, then a key", async () => {
    for (const [machine, model] of [[{ chatgpt: true, claude: true }, "gpt-5.5"], [{ claude: true, codex: true }, "claude-sonnet"], [{ keys: ["openai"] }, "openai:default"], [{ pi: true }, "pi:default"]] as const) {
      const h = await launch({ ...machine }, {}, "minimalist")
      expect([model, patches(h).at(-1)]).toEqual([model, { onboarded: true, models: { main: { model } } }])
    }
  })
  test("a provider found says nothing; nothing found says one line how to add one and still records the first launch", async () => {
    const found = await launch({ keys: ["anthropic"] }, {}, "minimalist")
    expect(screen(found)).not.toContain("no model found")
    const none = await launch({}, {}, "minimalist", (command) => command.type === "providers.list" ? { ok: true, result: { providers: [] } } as never : undefined)
    expect(none.app.page).toBe("chat")
    expect(screen(none).match(/no model found/g)).toHaveLength(1)
    expect(screen(none)).toContain("/connect adds one")
    expect(patches(none).at(-1)).toEqual({ onboarded: true })
    expect(patches(none)[0]).toMatchObject({ tier: "minimalist" })
  })
  test("a model already chosen is kept, and a daemon that does not answer writes nothing so the next launch tries again", async () => {
    const kept = await launch({ claude: true }, { models: { main: { model: "claude-opus" } } }, "minimalist")
    expect(patches(kept).at(-1)).toEqual({ onboarded: true })
    const silent = await launch({ claude: true }, {}, "minimalist", (command) => command.type === "models.list" ? { ok: false, code: "unavailable", error: { message: "down" } } as never : undefined)
    expect(silent.sent.filter((command) => command.type === "settings.set" || command.type === "prompt.set")).toEqual([])
    expect(screen(silent)).not.toContain("no model found")
  })
  test("a saved tier, a finished setup or no preset leave minimalist alone", async () => {
    const saved = await launch({ claude: true }, { tier: "balanced" }, "minimalist")
    expect(saved.app.page).toBe("setup")
    expect(screen(saved)).toContain("balanced")
    expect(patches(saved)).toEqual([])
    const done = await launch({ claude: true }, { onboarded: true, tier: "full" }, "minimalist")
    expect(done.fresh()).toEqual([])
    const doneNoTier = await launch({ claude: true }, { onboarded: true }, "minimalist")
    expect(doneNoTier.fresh()).toEqual([])
    expect(doneNoTier.app.page).toBe("chat")
  })
  test("it applies once: after the first launch the same receipt does nothing, also when the tier was cleared", async () => {
    const first = await launch({ claude: true }, {}, "minimalist")
    expect(patches(first).at(-1)).toMatchObject({ onboarded: true })
    const later = await launch({ claude: true }, { onboarded: true, tier: "minimalist" }, "minimalist")
    expect(later.fresh()).toEqual([])
    const cleared = await launch({ claude: true }, { onboarded: true }, "minimalist")
    expect(cleared.fresh()).toEqual([])
  })
  test("balanced and full keep the setup page, with the preset as the Tier row's start", async () => {
    for (const tier of ["balanced", "full"] as const) {
      const h = await launch({ claude: true }, {}, tier)
      expect(h.app.page).toBe("setup")
      expect(screen(h)).toContain("welcome")
      expect(screen(h)).toContain(`Tier        ‹ ${tier} ›`)
      expect(patches(h)).toEqual([])
      await keys(h, "\r")
      expect(patches(h)[0]).toMatchObject({ onboarded: true })
      expect(patches(h).some((patch) => patch.tier === tier)).toBe(true)
    }
  })
  test("leaving the page with esc keeps the preset's tier; without a preset esc writes only the done flag", async () => {
    const preset = await launch({ claude: true }, {}, "full")
    await keys(preset, "\x1b")
    expect(patches(preset)[0]).toEqual({ onboarded: true })
    expect(patches(preset).some((patch) => patch.tier === "full" && patch.view === "full")).toBe(true)
    const plain = await launch({ claude: true }, {})
    expect(plain.app.page).toBe("setup")
    expect(screen(plain)).toContain("Tier        ‹ balanced ›")
    await keys(plain, "\x1b")
    expect(patches(plain)).toEqual([{ onboarded: true }])
  })
  test("choosing another tier on the page beats the preset", async () => {
    const h = await launch({ claude: true }, {}, "full")
    await keys(h, "j", "\x1b[D")
    expect(screen(h)).toContain("Tier        ‹ balanced ›")
    await keys(h, "\r")
    expect(patches(h).some((patch) => patch.tier === "balanced")).toBe(true)
    expect(patches(h).some((patch) => patch.tier === "full")).toBe(false)
  })
})
