import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import type { ModelsReport } from "@mendcode/protocol"
import { normalizeModelPrefs, readModelPrefs, setModelDefault, withModelDefault, writeModelPrefs, modelPrefsPath } from "../src/view/model-prefs"
import { renderVariantPicker } from "../src/view/model-picker"
import { agentMentions } from "../src/view/mentions"
import { parseTokenCount } from "../src/view/token-count"
import { REPORT } from "./providers-harness"
import { appHarness, cleanTemps, conversation, ids, tempDir } from "./session-ui-harness"
import type { Line } from "../src/ui/theme"

afterEach(cleanTemps)
const text = (lines: Line[]) => lines.map((line) => line.map((span) => span.text).join("")).join("\n")

describe("per-model default effort", () => {
  test("defaults are kept per model, bad entries are dropped and an empty set is not stored", () => {
    const prefs = normalizeModelPrefs({ favorites: [], recents: [], defaults: { "gpt-6-sol": { effort: "high" }, bad: { effort: "no way!" }, "x": 5, "v": { variant: "max" } } })
    expect(prefs.defaults).toEqual({ "gpt-6-sol": { effort: "high" }, v: { variant: "max" } })
    expect(normalizeModelPrefs({ defaults: { a: {} } })).toEqual({ favorites: [], recents: [] })
    expect(normalizeModelPrefs({ defaults: [] })).toEqual({ favorites: [], recents: [] })
  })

  test("a picked model starts with its saved effort unless one was given", () => {
    const prefs = setModelDefault({ favorites: [], recents: [] }, { model: "gpt-6-sol", effort: "high" })
    expect(withModelDefault(prefs, { model: "gpt-6-sol" })).toEqual({ model: "gpt-6-sol", effort: "high" })
    expect(withModelDefault(prefs, { model: "gpt-6-sol", effort: "low" })).toEqual({ model: "gpt-6-sol", effort: "low" })
    expect(withModelDefault(prefs, { model: "gpt-6-luna" })).toEqual({ model: "gpt-6-luna" })
  })

  test("saving a choice without effort takes the default away; a variant is a default too", () => {
    let prefs = setModelDefault({ favorites: ["a"], recents: [] }, { model: "m", variant: "max" })
    expect(prefs).toEqual({ favorites: ["a"], recents: [], defaults: { m: { variant: "max" } } })
    prefs = setModelDefault(prefs, { model: "m" })
    expect(prefs).toEqual({ favorites: ["a"], recents: [] })
  })

  test("defaults survive a write and a read from the data directory", () => {
    const dir = tempDir()
    const prefs = setModelDefault({ favorites: [], recents: ["x"] }, { model: "gpt-6-sol", effort: "xhigh" })
    expect(writeModelPrefs(dir, prefs)).toEqual({ ok: true })
    expect(JSON.parse(readFileSync(modelPrefsPath(dir), "utf8")).defaults).toEqual({ "gpt-6-sol": { effort: "xhigh" } })
    expect(readModelPrefs(dir)).toEqual(prefs)
  })

  test("the variant page marks the saved default and names the keys", () => {
    const report: ModelsReport = { ...REPORT, effective: { model: "gpt-6-sol" } }
    const out = text(renderVariantPicker({ report, state: { selected: 0 }, error: "", prefs: { favorites: [], recents: [], defaults: { "gpt-6-sol": { effort: "high" } } }, width: 100, height: 20 }))
    expect(out).toMatch(/high · model default/)
    expect(out).toContain("d default for this model")
    expect(out).toContain("s save as startup default")
    expect(text(renderVariantPicker({ report, state: { selected: 0 }, error: "", width: 100, height: 20 }))).not.toContain("model default")
  })

  test("/model <id> sends the saved effort; an effort typed after it wins", async () => {
    const dataDir = tempDir()
    writeModelPrefs(dataDir, setModelDefault({ favorites: [], recents: [] }, { model: "gpt-6-sol", effort: "high" }))
    const id = ids("session")
    const h = appHarness({ sessionId: id, dataDir, directory: "/project", reply: (command) => command.type === "models.list" || command.type === "session.model.set" ? { ok: true, result: REPORT } : undefined })
    h.app.applySettings({ onboarded: true })
    await h.type("/model gpt-6-sol\r")
    expect(h.sentOf("session.model.set").at(-1)).toMatchObject({ choice: { model: "gpt-6-sol", effort: "high" } })
    await h.type("/model gpt-6-sol low\r")
    expect(h.sentOf("session.model.set").at(-1)).toMatchObject({ choice: { model: "gpt-6-sol", effort: "low" } })
    await h.type("/model gpt-6-luna\r")
    expect((h.sentOf("session.model.set").at(-1) as { choice: Record<string, unknown> }).choice).toEqual({ model: "gpt-6-luna" })
  })

  test("on the variant page d saves the highlighted effort for the model and s also makes it the startup main model", async () => {
    const dataDir = tempDir()
    const id = ids("session")
    const report: ModelsReport = { ...REPORT, effective: { model: "gpt-6-sol" } }
    const h = appHarness({ sessionId: id, dataDir, directory: "/project", reply: (command) => command.type === "models.list" || command.type === "session.model.set" ? { ok: true, result: report } : undefined })
    h.app.applySettings({ onboarded: true })
    conversation(id, h.app.onEvent).exchange("hello", "hi")
    await h.type("/variants\r")
    expect(h.app.page).toBe("variants")
    await h.app.onKey("\x1b[B")
    await h.app.onKey("\x1b[B")
    await h.app.onKey("\x1b[B")
    await h.app.onKey("d")
    expect(readModelPrefs(dataDir).defaults).toEqual({ "gpt-6-sol": { effort: "high" } })
    expect(h.sentOf("settings.set")).toHaveLength(0)
    await h.app.onKey("\x1b[B")
    await h.app.onKey("s")
    expect(readModelPrefs(dataDir).defaults).toEqual({ "gpt-6-sol": { effort: "xhigh" } })
    expect(h.sentOf("settings.set").at(-1)).toMatchObject({ patch: { models: { main: { model: "gpt-6-sol", effort: "xhigh" } } } })
    await h.app.onKey("\x1b[A")
    await h.app.onKey("\x1b[A")
    await h.app.onKey("\x1b[A")
    await h.app.onKey("\x1b[A")
    await h.app.onKey("d")
    expect(readModelPrefs(dataDir).defaults).toBeUndefined()
  })
})

describe("@agent mentions", () => {
  const agents = [
    { name: "build", description: "default", mode: "primary", trusted: true },
    { name: "explore", description: "Find files", mode: "subagent", trusted: true },
    { name: "general", description: "Research", mode: "subagent", trusted: true },
    { name: "reviewer", description: "Reviews a diff", mode: "all", trusted: true },
    { name: "secret", description: "hidden", mode: "subagent", trusted: true, hidden: true },
    { name: "off", description: "disabled", mode: "subagent", trusted: true, disable: true },
    { name: "untrusted", description: "project agent", mode: "subagent", trusted: false },
    { name: "has space", description: "bad name", mode: "subagent", trusted: true },
  ]

  test("only usable sub-agents are offered; names starting with the query come before names containing it", () => {
    expect(agentMentions(agents, "").map((entry) => entry.path)).toEqual(["explore", "general", "reviewer"])
    expect(agentMentions(agents, "ex")).toEqual([{ path: "explore", kind: "agent", description: "Find files" }])
    expect(agentMentions(agents, "e").map((entry) => entry.path)).toEqual(["explore", "general", "reviewer"])
    expect(agentMentions(agents, "view").map((entry) => entry.path)).toEqual(["reviewer"])
    expect(agentMentions(agents, "zzz")).toEqual([])
    expect(agentMentions(undefined, "")).toEqual([])
  })
})

describe("token counts", () => {
  test("k, m, plain and comma forms parse; out of range and words do not", () => {
    expect(parseTokenCount("200k")).toBe(200_000)
    expect(parseTokenCount("1m")).toBe(1_000_000)
    expect(parseTokenCount("1.5M")).toBe(1_500_000)
    expect(parseTokenCount("128000")).toBe(128_000)
    expect(parseTokenCount("128,000")).toBe(128_000)
    expect(parseTokenCount("999")).toBeUndefined()
    expect(parseTokenCount("11m")).toBeUndefined()
    expect(parseTokenCount("lots")).toBeUndefined()
    expect(parseTokenCount("-5k")).toBeUndefined()
  })
})
