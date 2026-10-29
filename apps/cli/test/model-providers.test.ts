import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { MODEL_ROLES, type ModelsReport } from "@mendcode/protocol"
import { createModelPageState, groupModels, MODEL_PAGE_ROWS, modelPageKey, renderModelPage } from "../src/view/model-page"
import { MAX_RECENTS, modelPrefsPath, normalizeModelPrefs, noteRecent, readModelPrefs, toggleFavorite, writeModelPrefs } from "../src/view/model-prefs"
import { textWidth } from "../src/view/wrap"
import { plain, providersHarness, REPORT } from "./providers-harness"

const RIGHT = "\x1b[C"
const LEFT = "\x1b[D"
const DOWN = "\x1b[B"

/** The catalog in the order a daemon might list it: provider models before the subscription's. */
const mixed: ModelsReport = {
  ...REPORT,
  models: [REPORT.models[3]!, REPORT.models[0]!, REPORT.models[4]!, REPORT.models[2]!, REPORT.models[1]!],
}

const dirs: string[] = []
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mendcode-models-"))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const lines = (over: Partial<Parameters<typeof renderModelPage>[0]> = {}) => renderModelPage({ state: createModelPageState(), report: REPORT, width: 100, height: 50, ...over }).map((line) => plain(line).replace(/^│\s*/, "").replace(/\s*│$/, ""))

describe("groups", () => {
  test("subscription first, then Claude Code, then each provider in the order its models first appear", () => {
    expect(groupModels(mixed.models).map((group) => [group.title, group.models.map((model) => model.id)])).toEqual([
      ["ChatGPT subscription", ["gpt-6-luna", "gpt-6-sol"]],
      ["Claude Code", ["claude-opus"]],
      ["Anthropic", ["anthropic:claude-sonnet-5-5"]],
      ["OpenRouter", ["openrouter:google/gemini-3-pro"]],
    ])
  })

  test("pi models form their own group after Claude Code", () => {
    const models = [...mixed.models, { id: "pi", name: "pi · its own model", efforts: [], engine: "pi" as const }, { id: "pi:anthropic/sonnet", name: "anthropic/sonnet · pi", efforts: [], engine: "pi" as const }]
    expect(groupModels(models).map((group) => [group.title, group.models.map((model) => model.id)]).slice(0, 4)).toEqual([
      ["ChatGPT subscription", ["gpt-6-luna", "gpt-6-sol"]],
      ["Claude Code", ["claude-opus"]],
      ["pi", ["pi", "pi:anthropic/sonnet"]],
      ["Anthropic", ["anthropic:claude-sonnet-5-5"]],
    ])
  })

  test("a group with no models is not listed, and an unknown provider goes by its id", () => {
    expect(groupModels([{ id: "corp:m", name: "m", efforts: [], provider: "corp" }]).map((group) => group.title)).toEqual(["corp"])
    expect(groupModels([])).toEqual([])
  })

  test("the page headings follow the groups and each model sits under its heading", () => {
    const out = lines()
    const at = (text: string) => out.findIndex((line) => line.trimStart().startsWith(text))
    const order = ["ChatGPT subscription", "Claude Code", "Anthropic", "OpenRouter"].map(at)
    expect(order.every((index) => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(at("GPT-6 Luna")).toBeGreaterThan(order[0]!)
    expect(at("Opus")).toBeGreaterThan(order[1]!)
    expect(at("Sonnet 5.5")).toBeGreaterThan(order[2]!)
    expect(at("Gemini 3 Pro")).toBeGreaterThan(order[3]!)
  })

  test("→ cycles models in the order the page lists them", () => {
    const state = createModelPageState()
    const walk = (session: string | undefined) => {
      const action = modelPageKey(state, RIGHT, { ...mixed, ...(session ? { session: { model: session } } : {}) }).action
      return action.type === "session" ? (action.choice?.model ?? null) : undefined
    }
    expect(walk(undefined)).toBe("gpt-6-luna")
    expect(walk("gpt-6-luna")).toBe("gpt-6-sol")
    expect(walk("gpt-6-sol")).toBe("claude-opus")
    expect(walk("claude-opus")).toBe("anthropic:claude-sonnet-5-5")
    expect(walk("anthropic:claude-sonnet-5-5")).toBe("openrouter:google/gemini-3-pro")
    expect(walk("openrouter:google/gemini-3-pro")).toBeNull()
    const back = modelPageKey(state, LEFT, mixed).action
    expect(back).toEqual({ type: "session", choice: { model: "openrouter:google/gemini-3-pro" } })
  })

  test("a provider's model carries its provider's name wherever the model is named in Favorites", () => {
    const out = lines({ prefs: { favorites: ["anthropic:claude-sonnet-5-5"], recents: [] } })
    expect(out.find((line) => line.includes("* Sonnet 5.5") && line.includes("Anthropic"))).toBeDefined()
  })
})

describe("roles", () => {
  test("the rows are this session and every settings role, aside and small included", () => {
    expect(MODEL_PAGE_ROWS).toEqual(["session", ...MODEL_ROLES])
    const out = lines()
    for (const role of ["aside", "small"]) expect(out.some((line) => line.replace(/^│\s*/, "").trimStart().replace(/^❯ /, "").startsWith(role))).toBe(true)
  })

  test("→ on aside and small sets those roles and leaves the others alone", () => {
    const base: ModelsReport = { ...REPORT, roles: { main: { model: "gpt-6-sol" } } }
    const onAside = { row: MODEL_PAGE_ROWS.indexOf("aside") }
    expect(modelPageKey(onAside, RIGHT, base).action).toEqual({ type: "roles", roles: { main: { model: "gpt-6-sol" }, aside: { model: "gpt-6-luna" } } })
    const onSmall = { row: MODEL_PAGE_ROWS.indexOf("small") }
    expect(modelPageKey(onSmall, RIGHT, base).action).toEqual({ type: "roles", roles: { main: { model: "gpt-6-sol" }, small: { model: "gpt-6-luna" } } })
    expect(modelPageKey(onSmall, "e", { ...base, roles: { small: { model: "gpt-6-luna" } } }).action).toEqual({ type: "roles", roles: { small: { model: "gpt-6-luna", effort: "low" } } })
  })

  test("an unset aside says what /btw will use; a set small shows through", () => {
    expect(lines().find((line) => line.includes("aside"))).toContain("small, else this session's model")
    const withSmall = lines({ report: { ...REPORT, roles: { small: { model: "gpt-6-luna", effort: "low" } } } })
    expect(withSmall.find((line) => line.includes("aside"))).toContain("small · GPT-6 Luna · low")
    const smallRow = (out: string[]) => out.find((line) => line.replace(/^│\s*/, "").trimStart().replace(/^❯ /, "").startsWith("small "))
    expect(smallRow(withSmall)).toContain("‹ GPT-6 Luna › low")
    expect(smallRow(lines())).toContain("same as main")
  })

  test("the focused new rows stay on screen on a short page", () => {
    for (const role of ["aside", "small"] as const) {
      const out = renderModelPage({ state: { row: MODEL_PAGE_ROWS.indexOf(role) }, report: REPORT, width: 80, height: 14 }).map(plain)
      expect(out.some((line) => line.includes("❯") && line.includes(role))).toBe(true)
    }
  })
})

describe("favorites", () => {
  test("f on a row with a model asks to star it; on an unset row it does nothing", () => {
    const onSession = createModelPageState()
    expect(modelPageKey(onSession, "f", { ...REPORT, session: { model: "gpt-6-sol" } }).action).toEqual({ type: "favorite", model: "gpt-6-sol" })
    expect(modelPageKey(onSession, "f", REPORT).action).toEqual({ type: "none" })
    const onMain = { row: MODEL_PAGE_ROWS.indexOf("main") }
    expect(modelPageKey(onMain, "f", { ...REPORT, roles: { main: { model: "claude-opus" } } }).action).toEqual({ type: "favorite", model: "claude-opus" })
    expect(modelPageKey(onSession, "f", { ...REPORT, selectable: false }).action).toEqual({ type: "none" })
  })

  test("a Favorites section leads the catalog and stars show next to the models everywhere", () => {
    const out = lines({ prefs: { favorites: ["gpt-6-sol", "openrouter:google/gemini-3-pro", "gone:model"], recents: [] } })
    const favorites = out.findIndex((line) => line.trimStart().startsWith("Favorites"))
    const subscription = out.findIndex((line) => line.trimStart().startsWith("ChatGPT subscription"))
    expect(favorites).toBeGreaterThan(0)
    expect(favorites).toBeLessThan(subscription)
    // The favorites, in the order they were starred, then the group lists; a model the catalog no longer has is left out.
    expect(out[favorites + 1]).toMatch(/\* GPT-6 Sol\s+gpt-6-sol\s+ChatGPT subscription · /)
    expect(out[favorites + 2]).toMatch(/\* Gemini 3 Pro\s+openrouter:google\/gemini-3-pro\s+OpenRouter · /)
    expect(out.join("\n")).not.toContain("gone:model")
    expect(out.filter((line) => line.includes("* GPT-6 Sol"))).toHaveLength(2)
    expect(out.find((line) => line.includes("GPT-6 Luna") && line.includes("*"))).toBeUndefined()
  })

  test("no Favorites or Recent heading when there are none", () => {
    const out = lines().join("\n")
    expect(out).not.toContain("Favorites")
    expect(out).not.toContain("Recent")
  })

  test("toggling adds at the end and removes", () => {
    const empty = { favorites: [], recents: [] }
    const one = toggleFavorite(empty, "a")
    const two = toggleFavorite(one, "b")
    expect(two.favorites).toEqual(["a", "b"])
    expect(toggleFavorite(two, "a").favorites).toEqual(["b"])
  })

  test("f in the app stars the focused row's model, writes the file, and f again unstars", async () => {
    const dataDir = tempDir()
    const withMain: ModelsReport = { ...REPORT, roles: { main: { model: "anthropic:claude-sonnet-5-5" } } }
    const first = providersHarness({ dataDir, height: 50, reply: (command) => (command.type === "models.list" ? { ok: true, result: withMain } : undefined) })
    await first.run("/model roles")
    await first.type(DOWN) // main
    await first.type("f")
    expect(readModelPrefs(dataDir).favorites).toEqual(["anthropic:claude-sonnet-5-5"])
    expect(first.text()).toContain("favorite: Sonnet 5.5")
    expect(first.text()).toMatch(/Favorites/)
    expect(first.text()).toContain("* Sonnet 5.5")

    // Another terminal on the same data dir starts with it.
    const second = providersHarness({ dataDir, reply: (command) => (command.type === "models.list" ? { ok: true, result: withMain } : undefined) })
    await second.run("/model roles")
    expect(second.text()).toContain("* Sonnet 5.5")

    await first.type("f")
    expect(readModelPrefs(dataDir).favorites).toEqual([])
    expect(first.text()).not.toContain("Favorites")
    expect(first.text()).toContain("unfavorited")
  })

  test("without a data dir nothing is written and starring still works for the session", async () => {
    const h = providersHarness({ reply: (command) => (command.type === "models.list" ? { ok: true, result: { ...REPORT, roles: { main: { model: "claude-opus" } } } } : undefined) })
    await h.run("/model roles")
    await h.type(DOWN)
    await h.type("f")
    expect(h.text()).toContain("* Opus")
  })
})

describe("recents", () => {
  test("the last five used models, newest first, each once", () => {
    let prefs = { favorites: [], recents: [] as string[] }
    for (const id of ["a", "b", "c", "d", "e", "f", "c"]) prefs = noteRecent(prefs, id)
    expect(prefs.recents).toEqual(["c", "f", "e", "d", "b"])
    expect(prefs.recents).toHaveLength(MAX_RECENTS)
    expect(noteRecent(prefs, "c")).toBe(prefs)
  })

  test("a Recent section lists them with who serves each, under Favorites", () => {
    const out = lines({ prefs: { favorites: ["gpt-6-sol"], recents: ["anthropic:claude-sonnet-5-5", "claude-opus"] } })
    const favorites = out.findIndex((line) => line.trimStart().startsWith("Favorites"))
    const recent = out.findIndex((line) => line.trimStart().startsWith("Recent"))
    expect(recent).toBeGreaterThan(favorites)
    expect(out[recent + 1]).toMatch(/Sonnet 5\.5\s+anthropic:claude-sonnet-5-5\s+Anthropic · /)
    expect(out[recent + 2]).toMatch(/Opus\s+claude-opus\s+Claude Code/)
  })

  test("choosing models through /model <id> and the page records them in models.json", async () => {
    const dataDir = tempDir()
    const h = providersHarness({ dataDir })
    await h.run("/model gpt-6-sol")
    await h.run("/model anthropic:claude-sonnet-5-5 high")
    await h.run("/model gpt-6-sol")
    await h.run("/model reset")
    expect(readModelPrefs(dataDir).recents).toEqual(["gpt-6-sol", "anthropic:claude-sonnet-5-5"])
    await h.run("/model roles")
    await h.type(RIGHT) // this session: the first model
    expect(readModelPrefs(dataDir).recents).toEqual(["gpt-6-luna", "gpt-6-sol", "anthropic:claude-sonnet-5-5"])
    expect(h.text()).toContain("Recent")
    // Used more than five different models: only the last five are kept.
    await h.type("\x1b")
    for (const id of ["corp:a", "corp:b", "corp:c", "gpt-6-sol"]) await h.run(`/model ${id}`)
    expect(readModelPrefs(dataDir).recents).toEqual(["gpt-6-sol", "corp:c", "corp:b", "corp:a", "gpt-6-luna"])
  })

  test("a role set from the page counts as used", async () => {
    const dataDir = tempDir()
    const h = providersHarness({ dataDir })
    await h.run("/model roles")
    await h.type(DOWN)
    await h.type(RIGHT)
    expect(h.commands("settings.set")[0]).toMatchObject({ patch: { models: { main: { model: "gpt-6-luna" } } } })
    expect(readModelPrefs(dataDir).recents).toEqual(["gpt-6-luna"])
  })
})

describe("model preferences file", () => {
  test("a missing, broken or hostile file is empty and never throws", () => {
    const dataDir = tempDir()
    expect(readModelPrefs(dataDir)).toEqual({ favorites: [], recents: [] })
    fs.mkdirSync(path.dirname(modelPrefsPath(dataDir)), { recursive: true })
    fs.writeFileSync(modelPrefsPath(dataDir), "{ nope")
    expect(readModelPrefs(dataDir)).toEqual({ favorites: [], recents: [] })
    expect(normalizeModelPrefs(null)).toEqual({ favorites: [], recents: [] })
    expect(normalizeModelPrefs([])).toEqual({ favorites: [], recents: [] })
    expect(normalizeModelPrefs({ favorites: [1, "", "ok", "ok", "x".repeat(101)], recents: "no" })).toEqual({ favorites: ["ok"], recents: [] })
    expect(normalizeModelPrefs({ recents: ["1", "2", "3", "4", "5", "6", "7"] }).recents).toHaveLength(MAX_RECENTS)
  })

  test("writes whole and leaves no temporary file behind", () => {
    const dataDir = tempDir()
    expect(writeModelPrefs(dataDir, { favorites: ["a"], recents: ["b"] })).toEqual({ ok: true })
    expect(fs.readdirSync(path.dirname(modelPrefsPath(dataDir)))).toEqual(["models.json"])
    expect(readModelPrefs(dataDir)).toEqual({ favorites: ["a"], recents: ["b"] })
  })

  test("a write that cannot happen is reported, not thrown", () => {
    const dataDir = tempDir()
    fs.writeFileSync(path.join(dataDir, "tui"), "a file where the folder should be")
    const result = writeModelPrefs(dataDir, { favorites: [], recents: [] })
    expect(result.ok).toBe(false)
  })
})

describe("renderModelPage with providers", () => {
  test.each([[60, 20], [100, 35], [140, 50]])("fits exactly at %ix%i", (width, height) => {
    for (const prefs of [undefined, { favorites: ["gpt-6-sol"], recents: ["claude-opus", "anthropic:claude-sonnet-5-5"] }]) {
      const out = renderModelPage({ state: createModelPageState(), report: mixed, prefs, width, height })
      expect(out).toHaveLength(height)
      for (const line of out) expect(textWidth(plain(line))).toBe(width)
    }
  })
})
