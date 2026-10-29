import { describe, expect, test } from "bun:test"
import type { DreamRun, EvolutionSuggestion, MemoryCategoryInfo, MemoryEntry, Settings } from "@mendcode/protocol"
import { NOW, REPORT, run } from "./dream-fixtures"
import { appHarness } from "./extensions-harness"

const CATEGORIES: MemoryCategoryInfo[] = [
  { id: "commands", label: "Commands", description: "Recurring commands.", defaultPolicy: "review", policy: "review" },
  { id: "preferences", label: "Preferences", description: "How the user works.", defaultPolicy: "review", policy: "review" },
  { id: "volatile", label: "Volatile", description: "Temporary details.", defaultPolicy: "never", policy: "never" },
]

function memory(id: string, patch: Partial<MemoryEntry> = {}): MemoryEntry {
  return { memoryId: id, scope: "project", directory: "/work/app", text: `text of ${id}`, category: "commands", status: "saved", source: "user", createdAt: NOW - 10_000, updatedAt: NOW - 1_000, ...patch } as MemoryEntry
}

type Reply = (command: Record<string, unknown>) => unknown

/** The /memory page open on `tab`, with mocked daemon replies on top of sensible defaults. */
async function open(tab: string, extra: Reply = () => undefined, memories: MemoryEntry[] = [memory("mem_1", { text: "Run bun test" }), memory("mem_2", { text: "Answer tersely", scope: "user", category: "preferences" })], settings: Settings = {}) {
  let categories = CATEGORIES
  const h = await appHarness({
    reply: async (command) => {
      const custom = extra(command)
      if (custom !== undefined) return custom
      if (command.type === "memory.list") return { ok: true, result: { memories } }
      if (command.type === "memory.categories") return { ok: true, result: { categories } }
      if (command.type === "memory.policy") {
        categories = categories.map((category) => (category.id === command.category ? { ...category, policy: command.policy as MemoryCategoryInfo["policy"] } : category))
        return { ok: true, result: { categories } }
      }
      if (command.type === "dream.list") return { ok: true, result: { runs: [] } }
      if (command.type === "evolution.list") return { ok: true, result: { mode: "suggest", suggestions: [], observed: { corrections: 0, preferences: 0, recurring: 0 } } }
      return undefined
    },
  })
  await h.start(settings)
  await h.type("/memory")
  await h.key("\r")
  await h.key(tab)
  return h
}
const commands = (h: Awaited<ReturnType<typeof open>>, type: string) => h.sent.filter((command) => command.type === type)

describe("/memory commands from the new keys", () => {
  test("the page lists session memories too and loads the categories", async () => {
    const h = await open("2")
    expect(commands(h, "memory.list")[0]).toMatchObject({ directory: "/work/app", session: "all" })
    expect(commands(h, "memory.categories")).toHaveLength(1)
  })

  test("p pins the selected saved memory and p again unpins a pinned one", async () => {
    const h = await open("2", () => undefined, [memory("mem_1", { text: "Run bun test" }), memory("mem_2", { text: "Answer tersely", pinned: true, updatedAt: NOW - 2_000 })])
    await h.key("p")
    expect(commands(h, "memory.update")[0]).toEqual({ type: "memory.update", memoryId: "mem_1", pinned: true })
    await h.key("j")
    await h.key("p")
    expect(commands(h, "memory.update")[1]).toEqual({ type: "memory.update", memoryId: "mem_2", pinned: false })
  })

  test("a failed pin (over the limit) shows the daemon's message and changes nothing else", async () => {
    const h = await open("2", (command) => (command.type === "memory.update" ? { ok: false, error: { code: "invalid_command", message: "[MEMORY]: at most 20 pinned memories" } } : undefined))
    await h.key("p")
    expect(h.text()).toContain("at most 20 pinned memories")
  })

  test("c then a category sends memory.update with it", async () => {
    const h = await open("2")
    await h.key("c")
    expect(h.text()).toContain("set category")
    await h.key("2")
    expect(commands(h, "memory.update")[0]).toEqual({ type: "memory.update", memoryId: "mem_1", category: "preferences" })
    expect(h.text()).not.toContain("set category")
  })

  test("s then a scope saves a copy in the new scope and deletes the old one, keeping category and pin", async () => {
    const h = await open("2", () => undefined, [memory("mem_1", { text: "Run bun test", pinned: true, category: "commands" })])
    await h.key("s")
    await h.key("1")
    const order = h.sent.filter((command) => command.type === "memory.add" || command.type === "memory.delete").map((command) => command.type)
    expect(order).toEqual(["memory.add", "memory.delete"])
    expect(commands(h, "memory.add")[0]).toEqual({ type: "memory.add", scope: "user", text: "Run bun test", category: "commands", pinned: true })
    expect(commands(h, "memory.delete")[0]).toEqual({ type: "memory.delete", memoryId: "mem_1" })
    expect(h.text()).toContain("moved to user scope")
  })

  test("moving to session scope names this session and the project; to project scope, the project", async () => {
    const h = await open("2", () => undefined, [memory("mem_2", { scope: "user", text: "Answer tersely", category: "preferences", directory: undefined } as never)])
    await h.key("s")
    await h.key("3")
    expect(commands(h, "memory.add")[0]).toMatchObject({ scope: "session", directory: "/work/app", sessionId: h.sessionId, text: "Answer tersely" })
    const again = await open("2", () => undefined, [memory("mem_2", { scope: "user", text: "Answer tersely", category: "preferences", directory: undefined } as never)])
    await again.key("s")
    await again.key("2")
    expect(commands(again, "memory.add")[0]).toMatchObject({ scope: "project", directory: "/work/app" })
    expect(commands(again, "memory.add")[0]).not.toHaveProperty("sessionId")
  })

  test("when the copy cannot be saved the old memory is kept", async () => {
    const h = await open("2", (command) => (command.type === "memory.add" ? { ok: false, error: { code: "invalid_command", message: "[MEMORY]: at most 20 pinned memories" } } : undefined), [memory("mem_1", { pinned: true })])
    await h.key("s")
    await h.key("1")
    expect(commands(h, "memory.delete")).toHaveLength(0)
    expect(h.text()).toContain("at most 20 pinned memories")
  })

  test("a notice explains keys that do not apply instead of starting a filter", async () => {
    const h = await open("1", () => undefined, [memory("mem_1", { status: "pending", source: "agent" })])
    await h.key("s")
    expect(h.text()).toContain("approve it first to change its scope")
    await h.key("p")
    expect(h.text()).toContain("only saved memories can be pinned")
    expect(h.text()).not.toContain("/ s")
  })
})

describe("/memory Policies tab", () => {
  test("opening it asks for the categories; a then sets the category's policy and the row follows the reply", async () => {
    const h = await open("6")
    expect(commands(h, "memory.categories").length).toBeGreaterThanOrEqual(2)
    expect(h.text()).toContain("Commands")
    await h.key("a")
    expect(commands(h, "memory.policy")[0]).toEqual({ type: "memory.policy", category: "commands", policy: "auto" })
    expect(h.rows().find((row) => row.includes("Commands"))).toContain("‹ auto ›")
    expect(h.rows().find((row) => row.includes("Commands"))).toContain("default review")
    await h.key("j")
    await h.key("\x1b[D")
    expect(commands(h, "memory.policy")[1]).toEqual({ type: "memory.policy", category: "preferences", policy: "auto" })
    await h.key("j")
    await h.key("d")
    expect(commands(h, "memory.policy")).toHaveLength(2)
  })

  test("a refused change is an error toast and the row stays as it was", async () => {
    const h = await open("6", (command) => (command.type === "memory.policy" ? { ok: false, error: { code: "invalid_command", message: "[SETTINGS]: could not save" } } : undefined))
    await h.key("n")
    expect(h.text()).toContain("could not save")
    expect(h.rows().find((row) => row.includes("Commands"))).toContain("‹ review ›")
  })
})

describe("/memory Evolution tab", () => {
  const SUGGESTION: EvolutionSuggestion = { suggestionId: 4, directory: "/work/app", kind: "skill", name: "release-checks", description: "Run the release checks before tagging.", content: "# Release\nbun test", evidence: 3, status: "pending", createdAt: NOW - 3_600_000 }
  const withSuggestion = (resolve: Reply = () => undefined): Reply => (command) =>
    command.type === "evolution.list" ? { ok: true, result: { mode: "suggest", suggestions: [SUGGESTION], observed: { corrections: 3, preferences: 1, recurring: 2 } } } : resolve(command)

  test("opening it lists this project's suggestions with what was seen", async () => {
    const h = await open("7", withSuggestion(), undefined, { evolution: "suggest" })
    expect(commands(h, "evolution.list")[0]).toMatchObject({ directory: "/work/app" })
    expect(h.text()).toContain("release-checks")
    expect(h.text()).toContain("3 corrections · 1 preferences · 2 recurring")
    expect(h.text()).toContain("mode     ‹ suggest ›")
  })

  test("with Evolution off (the default) the tab says it is not recording", async () => {
    const h = await open("7", withSuggestion())
    expect(h.text()).toContain("mode     ‹ off ›")
    expect(h.text()).toContain("not recording")
  })

  test("the right arrow sets the next mode through settings.set, and the tab shows it at once", async () => {
    const h = await open("7", withSuggestion())
    await h.key("\x1b[C")
    expect(commands(h, "settings.set")[0]).toEqual({ type: "settings.set", patch: { evolution: "observe" } })
    expect(h.text()).toContain("‹ observe ›")
    await h.key("\x1b[C")
    expect(commands(h, "settings.set")[1]).toEqual({ type: "settings.set", patch: { evolution: "suggest" } })
  })

  test("a accepts a pending suggestion: a skill reports its path, and the row turns accepted", async () => {
    const accepted = { ...SUGGESTION, status: "accepted" as const, resolvedAt: NOW }
    const h = await open("7", withSuggestion((command) => (command.type === "evolution.resolve" ? { ok: true, result: { suggestion: accepted, path: "/work/app/.mendcode/skills/release-checks/SKILL.md" } } : undefined)))
    await h.key("a")
    expect(commands(h, "evolution.resolve")[0]).toEqual({ type: "evolution.resolve", suggestionId: 4, decision: "accept" })
    // The toast wraps the long path; both halves are there.
    expect(h.text()).toContain("skill written to")
    expect(h.text()).toContain("/work/app/.mendcode/skills/release-checks/SKILL.md")
    expect(h.text()).toContain("3 evidence · accepted")
    await h.key("a")
    expect(commands(h, "evolution.resolve")).toHaveLength(1)
  })

  test("x rejects, and a daemon refusal shows its message and reloads the list", async () => {
    const h = await open("7", withSuggestion((command) => (command.type === "evolution.resolve" ? { ok: false, error: { code: "conflict", message: "[EVOLUTION]: the skill already exists" } } : undefined)))
    await h.key("x")
    expect(commands(h, "evolution.resolve")[0]).toEqual({ type: "evolution.resolve", suggestionId: 4, decision: "reject" })
    expect(h.text()).toContain("the skill already exists")
    expect(commands(h, "evolution.list")).toHaveLength(2)
  })
})

describe("/memory Dream tab", () => {
  const RUNS: DreamRun[] = [run({ runId: 7 }), run({ runId: 6, trigger: "scheduled", proposed: 0, report: undefined } as never)]
  const withRuns = (extra: Reply = () => undefined): Reply => (command) => {
    if (command.type === "dream.list" && command.runId === undefined) return { ok: true, result: { runs: RUNS } }
    return extra(command)
  }

  test("the selected run's safety report is drawn under the list", async () => {
    const h = await open("4", withRuns())
    const text = h.text()
    expect(text).toContain("safety report")
    expect(text).toContain("read      2 sessions (1 reused) · 14 memories")
    expect(text).toContain("refused   3")
    expect(text).toContain("budget    5k / 60k tokens (8%)")
    expect(text).toContain("budget 60k tokens (default)")
  })

  test("moving to a run without a report asks for it by id, once, and draws it", async () => {
    const older = run({ runId: 6, trigger: "recovered", proposed: 0, report: { ...REPORT, budget: { limit: 60_000, used: 60_000, stopped: true, reason: "no room for the first call" } } })
    const h = await open("4", withRuns((command) => (command.type === "dream.list" && command.runId === 6 ? { ok: true, result: { runs: [older] } } : undefined)))
    expect(commands(h, "dream.list").filter((command) => command.runId !== undefined)).toHaveLength(0)
    await h.key("j")
    expect(commands(h, "dream.list").filter((command) => command.runId !== undefined)).toEqual([{ type: "dream.list", runId: 6, directory: "/work/app" }])
    expect(h.text()).toContain("stopped: no room for the first call")
    expect(h.text()).toContain("recovered")
    await h.key("k")
    await h.key("j")
    expect(commands(h, "dream.list").filter((command) => command.runId !== undefined)).toHaveLength(1)
  })

  test("b then a number sets dreamMaxTokens; an empty field resets it", async () => {
    const h = await open("4", withRuns())
    for (const key of ["b", "1", "2", "0", "k", "\r"]) await h.key(key)
    expect(commands(h, "settings.set")[0]).toEqual({ type: "settings.set", patch: { dreamMaxTokens: 120_000 } })
    expect(h.text()).toContain("budget 120k tokens")
    expect(h.text()).not.toContain("(default)")
    await h.key("b")
    await h.key("\r")
    expect(commands(h, "settings.set")[1]).toEqual({ type: "settings.set", patch: { dreamMaxTokens: null } })
    expect(h.text()).toContain("budget 60k tokens (default)")
  })

  test("v opens the full report and esc returns to the list, not to the chat", async () => {
    const h = await open("4", withRuns())
    await h.key("v")
    expect(h.text()).toContain("Fix the login redirect — 12 msgs · built")
    await h.key("\x1b")
    expect(h.app.page).toBe("memory")
    expect(h.text()).not.toContain("Fix the login redirect — 12 msgs")
    await h.key("\x1b")
    expect(h.app.page).toBe("chat")
  })
})
