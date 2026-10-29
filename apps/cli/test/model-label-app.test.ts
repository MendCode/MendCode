import { afterEach, expect, test } from "bun:test"
import type { ModelsReport } from "@mendcode/protocol"
import { renderModelPicker, createModelPickerState } from "../src/view/model-picker"
import { DEFAULT_TUI_PROFILE, writeTuiProfile } from "../src/view/tui-profile"
import { appHarness, cleanTemps, conversation, ids, plain, tempDir } from "./session-ui-harness"

afterEach(cleanTemps)

const REPORT: ModelsReport = {
  engine: "native",
  selectable: true,
  models: [
    { id: "anthropic:claude-opus-5-5", name: "claude-opus-5-5 · Anthropic", efforts: ["low", "high"], provider: "anthropic" },
    { id: "openrouter:anthropic/claude-opus-5-5", name: "claude-opus-5-5 · OpenRouter", efforts: ["low", "high"], provider: "openrouter" },
    { id: "gpt-6.1-sol", name: "GPT-6.1-Sol", efforts: ["low", "medium"], contextWindow: 272_000 },
  ],
  defaults: { model: "gpt-6.1-sol" },
  roles: {},
  effective: { model: "gpt-6.1-sol", effort: "medium" },
}

async function chat(promptStatus: "off" | "border") {
  const dataDir = tempDir()
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, pet: "off", images: "off", sidebar: "hidden", promptStatus })
  const h = appHarness({ width: 120, height: 40, dataDir, directory: "/work/app", reply: (command) => command.type === "models.list" ? { ok: true, result: REPORT } : command.type === "agents.list" ? { ok: true, result: { current: "build", agents: [], problems: [] } } : undefined })
  h.app.applySettings({ onboarded: true, reducedMotion: true })
  const talk = conversation(h.sessionId, (event) => h.app.onEvent(event))
  talk.exchange("hello", "hi")
  talk.emit({ type: "usage.recorded", turnId: ids("turn"), provider: "p", model: "gpt-6.1-sol", input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
  await h.type("")
  return h
}

test("the bottom bar and the turn's end line show the model's name, never its id", async () => {
  const h = await chat("off")
  const frame = h.text().join("\n")
  expect(frame).toContain("GPT-6.1-Sol")
  expect(frame).not.toContain("gpt-6.1-sol")
})

test("the status line in the prompt border shows the name with the effort", async () => {
  const h = await chat("border")
  expect(h.text().find((row) => row.includes("READY"))).toContain("READY › GPT-6.1-Sol › medium")
})

test("the status line and bottom bar do not add a provider suffix to the name", async () => {
  const dataDir = tempDir()
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, pet: "off", images: "off", sidebar: "hidden", promptStatus: "border" })
  const h = appHarness({ width: 120, height: 40, dataDir, directory: "/work/app", reply: (command) => command.type === "models.list" ? { ok: true, result: { ...REPORT, effective: { model: "anthropic:claude-opus-5-5", effort: "high" } } } : undefined })
  h.app.applySettings({ onboarded: true, reducedMotion: true })
  await h.type("")
  const row = h.text().find((line) => line.includes("READY"))
  expect(row).toContain("READY › Opus 5.5 › high")
  expect(h.text().join("\n")).not.toContain("Opus 5.5 (")
})

test("a Claude Code alias reads as its family until the engine reports what it resolved to, and is served by claude", async () => {
  const claude: ModelsReport = { engine: "native", selectable: true, models: [
    { id: "claude-opus", name: "Claude Opus · Claude Code", efforts: ["low", "high"], engine: "claude" },
    { id: "gpt-6-luna", name: "GPT-6-Luna", efforts: ["low"] },
  ], defaults: { model: "gpt-6-luna" }, roles: {}, effective: { model: "claude-opus", effort: "high" } }
  const h = appHarness({ width: 120, height: 40, dataDir: tempDir(), directory: "/work/app", reply: (command) => command.type === "models.list" ? { ok: true, result: claude } : undefined })
  h.app.applySettings({ onboarded: true, reducedMotion: true })
  const talk = conversation(h.sessionId, (event) => h.app.onEvent(event))
  talk.exchange("hello", "hi")
  await h.type("")
  const bar = () => h.text().find((row) => row.includes("Build ·"))
  expect(bar()).toContain("Build · Opus · claude")
  expect(bar()).not.toContain("native")
  talk.emit({ type: "usage.recorded", turnId: ids("turn"), provider: "claude", model: "claude-opus-5-5-20260301", input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
  await h.type("")
  expect(bar()).toContain("Build · Opus 5.5 · claude")
})

test("the /model page and the picker keep the exact id, muted, next to the name", async () => {
  const h = await chat("off")
  await h.type("/model\r")
  const page = h.text().find((row) => row.includes("GPT-6.1-Sol") && row.includes("gpt-6.1-sol"))
  expect(page).toBeDefined()
  const lines = renderModelPicker({ state: createModelPickerState(), report: REPORT, prefs: { favorites: [], recents: [] }, width: 120, height: 20, error: "" })
  const row = lines.find((line) => line.some((span) => span.text.includes("GPT-6.1-Sol")) && line.some((span) => span.text.includes("gpt-6.1-sol")))
  expect(row?.find((span) => span.text.includes("gpt-6.1-sol"))?.fg).toBe("muted")
})

test("the same model through two providers stays distinguishable in the picker list", () => {
  const rows = renderModelPicker({ state: createModelPickerState(), report: REPORT, prefs: { favorites: [], recents: [] }, width: 120, height: 20, error: "" }).map(plain)
  const opus = rows.filter((row) => row.includes("Opus 5.5"))
  expect(opus).toHaveLength(2)
  expect(opus.some((row) => row.includes("anthropic:claude-opus-5-5"))).toBe(true)
  expect(opus.some((row) => row.includes("openrouter:anthropic/claude-opus-5-5"))).toBe(true)
})
