import { afterEach, describe, expect, test } from "bun:test"
import type { CommandInput } from "@mendcode/client"
import type { ModelsReport } from "@mendcode/protocol"
import { createModelQuickState, quickChoice, quickValue, renderModelQuick, stepQuickValue } from "../src/view/model-quick"
import { modelLabel } from "../src/view/model-label"
import { readModelPrefs, type ModelPrefs } from "../src/view/model-prefs"
import { textWidth } from "../src/view/wrap"
import { DEFAULT_TUI_PROFILE, writeTuiProfile } from "../src/view/tui-profile"
import { appHarness, cleanTemps, conversation, plain, tempDir } from "./session-ui-harness"

afterEach(cleanTemps)

/** A Claude Code alias the daemon has seen resolve (`resolved`), one it has not, a ChatGPT model, and an API-key provider's. */
const REPORT: ModelsReport = {
  engine: "native",
  selectable: true,
  models: [
    { id: "gpt-6.1-sol", name: "GPT-6.1-Sol", efforts: ["low", "medium", "high"], defaultEffort: "medium", contextWindow: 272_000 },
    { id: "gpt-6-luna", name: "GPT-6-Luna", efforts: ["low", "medium"], defaultEffort: "low" },
    { id: "claude-opus", name: "Claude Opus · Claude Code", efforts: ["low", "high", "xhigh"], engine: "claude", resolved: "claude-opus-5-5" },
    { id: "claude-sonnet", name: "Claude Sonnet · Claude Code", efforts: ["low", "high"], engine: "claude" },
    { id: "claude-haiku", name: "Claude Haiku · Claude Code", efforts: [], engine: "claude" },
    { id: "anthropic:claude-opus-5-5", name: "claude-opus-5-5 · Anthropic", efforts: ["low", "high"], provider: "anthropic" },
  ],
  defaults: { model: "gpt-6.1-sol", effort: "medium" },
  roles: {},
  effective: { model: "gpt-6.1-sol", effort: "medium" },
}
const NO_PREFS: ModelPrefs = { favorites: [], recents: [] }

async function chat(size: { width: number; height: number } = { width: 120, height: 40 }, report: ModelsReport = REPORT, profile: Partial<typeof DEFAULT_TUI_PROFILE> = {}) {
  const dataDir = tempDir()
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, pet: "off", images: "off", sidebar: "hidden", ...profile })
  let current = report
  const h = appHarness({ ...size, dataDir, directory: "/work/app", reply: (command: CommandInput) => {
    if (command.type === "models.list") return { ok: true, result: current }
    if (command.type === "session.model.set") {
      current = { ...current, session: command.choice ?? undefined, effective: command.choice ?? current.effective } as ModelsReport
      return { ok: true, result: current }
    }
    if (command.type === "agents.list") return { ok: true, result: { current: "build", agents: [], problems: [] } }
    return undefined
  } })
  h.app.applySettings({ onboarded: true, reducedMotion: true })
  conversation(h.sessionId, (event) => h.app.onEvent(event)).exchange("hello", "hi")
  await h.type("")
  return { ...h, dataDir }
}
const sent = (h: Awaited<ReturnType<typeof chat>>) => h.sentOf("session.model.set") as Array<Extract<CommandInput, { type: "session.model.set" }>>

describe("the quick model switch", () => {
  test("/model opens a card over the chat, not a page: favorites and recents first, then the catalog by provider", async () => {
    const h = await chat()
    await h.type("/model\r")
    expect(h.app.page).toBe("chat")
    const text = h.text()
    const joined = text.join("\n")
    expect(joined).toContain("filter models…")
    expect(joined).toContain("tab roles & defaults")
    expect(joined).toContain("hello")
    // Each row: the name, the exact id muted, the provider and the effort.
    expect(text.find((row) => row.includes("GPT-6.1-Sol") && row.includes("gpt-6.1-sol") && row.includes("ChatGPT subscription · ‹ medium ›"))).toBeDefined()
    expect(text.find((row) => row.includes("Opus 5.5") && row.includes("claude-opus") && row.includes("Claude Code"))).toBeDefined()
    expect(text.some((row) => row.includes("Sonnet") && !row.includes("Sonnet 5"))).toBe(true)
    const headings = ["ChatGPT subscription", "Claude Code", "Anthropic"].map((title) => text.findIndex((row) => row.trim() === title || row.trim().startsWith(`${title}  `) && !row.includes("·")))
    expect(headings.every((at) => at >= 0)).toBe(true)
    expect([...headings].sort((a, b) => a - b)).toEqual(headings)
  })

  test("typing filters at once; enter switches this session's model and closes", async () => {
    const h = await chat()
    await h.type("/model\r")
    await h.type("sonn")
    expect(h.text().find((row) => row.includes("Sonnet") && row.includes("claude-sonnet"))).toBeDefined()
    expect(h.text().join("\n")).not.toContain("GPT-6-Luna")
    await h.type("\r")
    expect(sent(h).at(-1)?.choice).toEqual({ model: "claude-sonnet" })
    expect(h.sent.at(-1)).toMatchObject({ type: "session.model.set" })
    expect(h.text().join("\n")).not.toContain("filter models…")
    // The footer names the model in use, so the switch adds no notice repeating it.
    expect(h.text().join("\n")).not.toContain("model: Sonnet")
    expect(h.text().join("\n")).toContain("Sonnet")
    expect(h.app.page).toBe("chat")
  })

  test("← → change the effort in place and enter sends it; ctrl+e does the same", async () => {
    const h = await chat({ width: 120, height: 40 }, { ...REPORT, models: REPORT.models.filter((model) => model.engine === "claude") })
    await h.type("/model\r")
    await h.type("opus")
    expect(h.text().find((row) => row.includes("Opus 5.5") && row.includes("‹ default ›"))).toBeDefined()
    await h.type("\x1b[C")
    expect(h.text().find((row) => row.includes("Opus 5.5") && row.includes("‹ low ›"))).toBeDefined()
    await h.type("\x1b[C")
    await h.type("\x1b[D")
    await h.type("\x05")
    await h.type("\r")
    const choice = sent(h).at(-1)!.choice
    expect(choice?.model).toBe("claude-opus")
    // default → low → high → low → (ctrl+e) high
    expect(choice?.effort).toBe("high")
  })

  test("a model's catalog levels are the ones offered, max and none included, and the footer names the one in force", async () => {
    const report: ModelsReport = {
      ...REPORT,
      models: [
        { id: "acp:opencode/opencode/deepseek-v4.1-flash-free", name: "OpenCode/DeepSeek V4.1 Flash Free · OpenCode harness", efforts: ["low", "high", "max"] },
        { id: "opencode:nemotron-3.5-super-vl-free", name: "Nemotron 3.5 Super VL Free · OpenCode Zen", efforts: ["none", "low", "high"], provider: "opencode" },
      ],
      defaults: { model: "opencode:nemotron-3.5-super-vl-free" },
      effective: { model: "opencode:nemotron-3.5-super-vl-free" },
    }
    const h = await chat({ width: 120, height: 40 }, report, { showEffort: true })
    await h.type("/model\r")
    await h.type("deepseek")
    const row = () => h.text().find((line) => line.includes("DeepSeek V4.1 Flash Free"))
    expect(row()).toContain("‹ default ›")
    const walked: string[] = []
    for (let step = 0; step < 4; step++) {
      await h.type("\x1b[C")
      walked.push(/‹ (\S+) ›/.exec(row() ?? "")?.[1] ?? "?")
    }
    // default → low → high → max → around to low: exactly the catalog's levels, no medium.
    expect(walked).toEqual(["low", "high", "max", "low"])
    await h.type("\x1b[D")
    await h.type("\r")
    expect(sent(h).at(-1)?.choice).toEqual({ model: "acp:opencode/opencode/deepseek-v4.1-flash-free", effort: "max" })
    expect(h.text().join("\n")).not.toContain("filter models…")
    expect(h.text().slice(-3).join("\n")).toMatch(/DeepSeek V4\.1 Flash Free.*max/)
    // F3 on a model whose catalog offers none walks to it like any level.
    const zen = await chat({ width: 120, height: 40 }, report)
    await zen.type("\x1bOR")
    expect(sent(zen).at(-1)?.choice).toEqual({ model: "opencode:nemotron-3.5-super-vl-free", effort: "none" })
  })

  test("the model the session already runs closes with no change; its effort picked in place is a change", async () => {
    const h = await chat()
    await h.type("/model\r")
    await h.type("\r")
    expect(sent(h)).toHaveLength(0)
    expect(h.text().join("\n")).not.toContain("filter models…")
    await h.type("/model\r")
    await h.type("\x1b[C")
    await h.type("\r")
    expect(sent(h).at(-1)?.choice).toEqual({ model: "gpt-6.1-sol", effort: "high" })
  })

  test("ctrl+f stars the highlighted model (kept on disk) and the highlight follows it to the favorites", async () => {
    const h = await chat()
    await h.type("/model\r")
    await h.type("luna")
    await h.type("\x06")
    expect(readModelPrefs(h.dataDir).favorites).toEqual(["gpt-6-luna"])
    await h.type("\x15")
    const text = h.text()
    const heading = text.findIndex((row) => row.trim().startsWith("Favorites"))
    expect(heading).toBeGreaterThanOrEqual(0)
    expect(text[heading + 1]).toContain("* GPT-6-Luna")
  })

  test("a switch is noted in the recents, which come first on the next open", async () => {
    const h = await chat()
    await h.type("/model\r")
    await h.type("haiku\r")
    expect(readModelPrefs(h.dataDir).recents).toEqual(["claude-haiku"])
    await h.type("/model\r")
    const text = h.text()
    const heading = text.findIndex((row) => row.trim().startsWith("Recent"))
    expect(heading).toBeGreaterThanOrEqual(0)
    expect(text[heading + 1]).toContain("Haiku")
  })

  test("tab opens the full page with the roles; esc closes without a change", async () => {
    const h = await chat()
    await h.type("/model\r")
    await h.type("\t")
    expect(h.app.page).toBe("model")
    expect(h.text().join("\n")).toContain("this session")
    expect(h.text().join("\n")).not.toContain("filter models…")
    const closed = await chat()
    await closed.type("/model\r")
    await closed.type("\x1b")
    expect(closed.app.page).toBe("chat")
    expect(closed.text().join("\n")).not.toContain("filter models…")
    expect(sent(closed)).toHaveLength(0)
  })

  test("/model roles and /model all open the page directly; /model <id> switches without a screen", async () => {
    const h = await chat()
    await h.type("/model roles\r")
    expect(h.app.page).toBe("model")
    const all = await chat()
    await all.type("/model all\r")
    expect(all.app.page).toBe("model")
    const direct = await chat()
    await direct.type("/model gpt-6-luna\r")
    expect(direct.app.page).toBe("chat")
    expect(sent(direct).at(-1)?.choice).toMatchObject({ model: "gpt-6-luna" })
    expect(direct.text().join("\n")).not.toContain("filter models…")
  })

  test("F2 and F3 keep cycling the recent model and the effort", async () => {
    const h = await chat()
    await h.type("\x1bOR")
    expect(sent(h).at(-1)?.choice).toMatchObject({ model: "gpt-6.1-sol", effort: "high" })
    await h.type("/model\r")
    expect(h.text().join("\n")).toContain("filter models…")
  })

  test("a refusal from the daemon stays in the card and nothing closes", async () => {
    const dataDir = tempDir()
    writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, pet: "off", images: "off", sidebar: "hidden" })
    const h = appHarness({ width: 100, height: 30, dataDir, directory: "/work/app", reply: (command) => command.type === "models.list" ? { ok: true, result: REPORT } : command.type === "session.model.set" ? { ok: false, error: { code: "invalid_command", message: "[DAEMON]: unknown model claude-haiku" } } : undefined })
    h.app.applySettings({ onboarded: true, reducedMotion: true })
    await h.type("/model\r")
    await h.type("haiku\r")
    expect(h.text().join("\n")).toContain("unknown model claude-haiku")
    expect(h.text().join("\n")).toContain("Haiku  claude-haiku")
    expect(h.text().join("\n")).not.toContain("tab roles & defaults")
    expect(h.text().some((row) => row.trim() === "haiku" || row.trim().startsWith("haiku "))).toBe(true)
  })

  test("an engine that chooses its own model says so instead of a list", async () => {
    const h = await chat({ width: 100, height: 30 }, { ...REPORT, engine: "codex", selectable: false, models: [] })
    await h.type("/model\r")
    expect(h.text().join("\n")).toContain("codex engine chooses its own model")
  })
})

describe("the card at the small sizes", () => {
  for (const [width, height] of [[80, 24], [60, 20], [120, 40]] as const) {
    test(`${width}x${height}: every row fits, the filter and the tab hint are visible`, async () => {
      const h = await chat({ width, height })
      await h.type("/model\r")
      const text = h.text()
      expect(text.every((row) => textWidth(row) <= width)).toBe(true)
      expect(text.join("\n")).toContain("filter models…")
      expect(text.join("\n")).toContain(width >= 70 ? "tab roles & defaults" : "tab")
      expect(text.join("\n")).toContain("Opus 5.5")
    })
  }

  test("the list scrolls with the highlight and the card never grows past the room above the prompt", () => {
    const report: ModelsReport = { ...REPORT, models: Array.from({ length: 40 }, (_, index) => ({ id: `provider:model-${index}`, name: `Model ${index}`, efforts: [], provider: "provider" })) }
    const state = { ...createModelQuickState(), selected: 30 }
    const card = renderModelQuick({ state, report, prefs: NO_PREFS, width: 80, bottom: 17 })!
    expect(card.rows.length).toBeLessThanOrEqual(17)
    expect(card.top + card.rows.length).toBe(17)
    const text = card.rows.map(plain)
    expect(text.some((row) => row.includes("Model 30"))).toBe(true)
    expect(text.some((row) => row.includes("31/40"))).toBe(true)
    expect(card.rows.every((row) => row.reduce((sum, span) => sum + textWidth(span.text), 0) === 80)).toBe(true)
    // Wider than the screen's own margins, it keeps a two-cell margin on each side.
    const wide = renderModelQuick({ state, report, prefs: NO_PREFS, width: 120, bottom: 30 })!
    expect(wide.left).toBe(18)
    expect(wide.rows.every((row) => row.reduce((sum, span) => sum + textWidth(span.text), 0) === 84)).toBe(true)
  })
})

describe("what a row starts with", () => {
  const model = (id: string) => REPORT.models.find((entry) => entry.id === id)!
  test("a pick, else the saved default, else the session's own effort, else the catalog default", () => {
    const state = createModelQuickState()
    const prefs: ModelPrefs = { favorites: [], recents: [], defaults: { "claude-opus": { effort: "high" } } }
    expect(quickValue({ model: model("gpt-6-luna"), state, report: REPORT, prefs })).toBe("low")
    expect(quickValue({ model: model("gpt-6.1-sol"), state, report: REPORT, prefs })).toBe("medium")
    expect(quickValue({ model: model("claude-opus"), state, report: REPORT, prefs })).toBe("high")
    expect(quickValue({ model: model("claude-opus"), state: { ...state, picks: { "claude-opus": "xhigh" } }, report: REPORT, prefs })).toBe("xhigh")
    expect(quickValue({ model: model("claude-haiku"), state, report: REPORT, prefs })).toBeUndefined()
  })

  test("← → walk the efforts and wrap; a model without any is left alone; Enter sends the pick or the saved default", () => {
    const state = createModelQuickState()
    const opus = model("claude-opus")
    const right = stepQuickValue({ state, model: opus, report: REPORT, prefs: NO_PREFS, direction: 1 })
    expect(right.picks["claude-opus"]).toBe("low")
    expect(stepQuickValue({ state: right, model: opus, report: REPORT, prefs: NO_PREFS, direction: -1 }).picks["claude-opus"]).toBe("xhigh")
    expect(stepQuickValue({ state, model: model("claude-haiku"), report: REPORT, prefs: NO_PREFS, direction: 1 })).toBe(state)
    expect(quickChoice({ model: opus, state: right, withDefault: (choice) => choice })).toEqual({ model: "claude-opus", effort: "low" })
    expect(quickChoice({ model: opus, state, withDefault: (choice) => ({ ...choice, effort: "high" }) })).toEqual({ model: "claude-opus", effort: "high" })
  })

  test("a variant model cycles its variants", () => {
    const provider = { id: "p:m", name: "M", efforts: [], provider: "p", variants: { fast: {}, deep: {} } } as ModelsReport["models"][number]
    const next = stepQuickValue({ state: createModelQuickState(), model: provider, report: REPORT, prefs: NO_PREFS, direction: 1 })
    expect(next.picks["p:m"]).toBe("fast")
    expect(quickChoice({ model: provider, state: next, withDefault: (choice) => choice })).toEqual({ model: "p:m", variant: "fast" })
  })
})

describe("a Claude Code alias reads by its resolved version from the first catalog", () => {
  test("`resolved` makes Opus read Opus 5.5 everywhere the label is used; an alias that never resolved stays Opus", () => {
    expect(modelLabel("claude-opus", REPORT)).toBe("Opus 5.5")
    expect(modelLabel("claude-sonnet", REPORT)).toBe("Sonnet")
    expect(modelLabel("claude-opus", { models: [{ id: "claude-opus", name: "Claude Opus · Claude Code", engine: "claude", resolved: "claude-opus-5-5-20260301" }] })).toBe("Opus 5.5")
    // A resolution the label rules do not know leaves the family name.
    expect(modelLabel("claude-opus", { models: [{ id: "claude-opus", name: "Claude Opus · Claude Code", engine: "claude", resolved: "some-internal-build" }] })).toBe("Opus")
  })

  test("the bottom bar and the status line name the alias with its version before any answer", async () => {
    const dataDir = tempDir()
    writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, pet: "off", images: "off", sidebar: "hidden", promptStatus: "border" })
    const claude: ModelsReport = { ...REPORT, effective: { model: "claude-opus", effort: "high" } }
    const h = appHarness({ width: 120, height: 40, dataDir, directory: "/work/app", reply: (command) => command.type === "models.list" ? { ok: true, result: claude } : undefined })
    h.app.applySettings({ onboarded: true, reducedMotion: true })
    conversation(h.sessionId, (event) => h.app.onEvent(event)).exchange("hello", "hi")
    await h.type("")
    expect(h.text().find((row) => row.includes("READY"))).toContain("READY › Opus 5.5 › high")
    const bar = await chat({ width: 120, height: 40 }, claude)
    expect(bar.text().find((row) => row.includes("Build ·"))).toContain("Build · Opus 5.5 · claude")
  })
})
