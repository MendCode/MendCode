import { afterEach, describe, expect, test } from "bun:test"
import type { CommandInput } from "@mendcode/client"
import type { ModelInfo, ModelsReport } from "@mendcode/protocol"
import { createModelPageState, renderModelPage } from "../src/view/model-page"
import { readModelPrefs, writeModelPrefs } from "../src/view/model-prefs"
import { DEFAULT_TUI_PROFILE, writeTuiProfile } from "../src/view/tui-profile"
import { appHarness, cleanTemps, conversation, plain, tempDir } from "./session-ui-harness"

afterEach(cleanTemps)

/** The owner's catalog: the native engine's seven ChatGPT-subscription models and the four Claude Code aliases, the session on a native model. */
const SUBSCRIPTION = ["gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-6-astra"]
const CLAUDE = ["claude-opus", "claude-sonnet", "claude-haiku", "claude-fable"]
const models: ModelInfo[] = [
  ...SUBSCRIPTION.map((id): ModelInfo => ({ id, name: id, efforts: ["low", "medium", "high"], defaultEffort: "medium" })),
  ...CLAUDE.map((id): ModelInfo => ({ id, name: `${id} · Claude Code`, efforts: ["low", "high"], engine: "claude" })),
]
const REPORT: ModelsReport = { engine: "native", selectable: true, models, defaults: { model: "gpt-6-sol", effort: "medium" }, roles: {}, effective: { model: "gpt-6-astra", effort: "medium" } }

async function start(input: { withSession: boolean; report?: ModelsReport }) {
  const dataDir = tempDir()
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, pet: "off", images: "off", sidebar: "hidden" })
  // Recents as the owner had them, Claude Code models among them.
  writeModelPrefs(dataDir, { favorites: [], recents: ["gpt-6-astra", "claude-opus", "gpt-6.1-sol", "claude-fable", "gpt-5.6-luna"] })
  const h = appHarness({ width: 120, height: 40, dataDir, directory: "/work/app", reply: (command: CommandInput) => {
    if (command.type === "models.list") return { ok: true, result: input.report ?? REPORT }
    if (command.type === "agents.list") return { ok: true, result: { current: "build", agents: [], problems: [] } }
    return undefined
  } })
  h.app.applySettings({ onboarded: true, reducedMotion: true })
  if (input.withSession) conversation(h.sessionId, (event) => h.app.onEvent(event)).exchange("hello", "hi")
  await h.type("")
  return Object.assign(h, { dataDir })
}

/** Every model id a surface shows while its highlight walks the whole list. */
async function idsWalked(h: Awaited<ReturnType<typeof start>>, ids: readonly string[], steps: number) {
  const seen = new Set<string>()
  const collect = () => { for (const row of h.text()) for (const id of ids) if (new RegExp(`(^|\\s)${id.replace(/\./g, "\\.")}(\\s|$)`).test(row)) seen.add(id) }
  collect()
  for (let step = 0; step < steps; step++) { await h.type("\x1b[B"); collect() }
  return seen
}

const ALL = [...SUBSCRIPTION, ...CLAUDE]

describe("the quick switch and the full model page list the same models", () => {
  for (const withSession of [true, false]) {
    const where = withSession ? "in a chat" : "on the home screen"

    test(`${where}: the quick switch walks to all seven ChatGPT and all four Claude Code models`, async () => {
      const h = await start({ withSession })
      await h.type("/model\r")
      expect(h.app.page).toBe("chat")
      expect(await idsWalked(h, ALL, ALL.length + 2)).toEqual(new Set(ALL))
    })

    test(`${where}: /model roles counts the same eleven and /model search walks to all of them`, async () => {
      const h = await start({ withSession })
      await h.type("/model roles\r")
      expect(h.app.page).toBe("model")
      // The page's model panel is as tall as the terminal lets it be, so its own rows are read from a render with room for all of them.
      const tall = renderModelPage({ state: createModelPageState(), report: REPORT, prefs: readModelPrefs(h.dataDir), width: 120, height: 80 }).map(plain).join("\n")
      for (const id of ALL) expect(tall).toMatch(new RegExp(`(^|\\s)${id.replace(/\./g, "\\.")}(\\s|$)`, "m"))
      expect(tall).toMatch(/ChatGPT subscription\s+7\b/)
      expect(tall).toMatch(/Claude Code\s+4\b/)
      await h.type("\x1b")
      await h.type("/model search\r")
      expect(h.app.page).toBe("model-picker")
      expect(await idsWalked(h, ALL, ALL.length + 2)).toEqual(new Set(ALL))
      await h.type("\x01")
      const groups = h.text().join("\n")
      expect(groups).toContain("ChatGPT subscription · 7")
      expect(groups).toContain("Claude Code · 4")
    })

    test(`${where}: the bottom bar names the ChatGPT subscription, not the daemon's engine, next to a subscription model`, async () => {
      const h = await start({ withSession })
      const bar = h.text().find((row) => row.includes("Build ·"))
      expect(bar).toContain("GPT-6-Astra · chatgpt")
      expect(bar).not.toContain("native")
    })

    test(`${where}: a recent Claude Code model is listed while the catalog has it, and kept in models.json while it does not`, async () => {
      const without = { ...REPORT, models: models.filter((model) => !model.engine) }
      const h = await start({ withSession, report: without })
      await h.type("/model\r")
      expect(h.text().join("\n")).not.toContain("claude-opus")
      await h.type("\x1b")
      expect(readModelPrefs(h.dataDir).recents).toContain("claude-opus")
    })
  }
})
