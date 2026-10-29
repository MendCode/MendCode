import { describe, expect, test } from "bun:test"
import type { EvolutionSuggestion, MemoryCategoryInfo, MemoryEntry } from "@mendcode/protocol"
import type { Line } from "../src/ui/theme"
import { createEvolutionState, evolutionKey, renderEvolutionTab, type EvolutionData } from "../src/view/memory-evolution"
import { createMemoryPageState, memoryPageKey, renderMemoryPage, type MemoryPageData, type MemoryPageState } from "../src/view/memory-page"
import { createPoliciesState, policiesKey, renderPoliciesTab } from "../src/view/memory-policies"

const NOW = Date.UTC(2026, 8, 30, 12)
const plain = (rows: Line[]) => rows.map((row) => row.map((span) => span.text).join(""))

const CATEGORIES: MemoryCategoryInfo[] = [
  { id: "commands", label: "Commands", description: "Recurring commands, validation gates, release commands.", defaultPolicy: "review", policy: "review" },
  { id: "preferences", label: "Preferences", description: "How the user likes to work and be answered.", defaultPolicy: "review", policy: "auto" },
  { id: "security", label: "Security", description: "Security posture, secret handling and permission rules.", defaultPolicy: "review", policy: "review" },
  { id: "volatile", label: "Volatile", description: "One-off or temporary details; proposals in it are dropped.", defaultPolicy: "never", policy: "never" },
]

function suggestion(id: number, patch: Partial<EvolutionSuggestion> = {}): EvolutionSuggestion {
  return { suggestionId: id, directory: "/work/app", kind: "skill", name: `skill-${id}`, description: "Run the release checks before tagging.", content: "# Release\n\n1. bun test\n2. bun run typecheck", evidence: 3, status: "pending", createdAt: NOW - 2 * 3_600_000, ...patch }
}

describe("policies tab keys", () => {
  test("arrows move between categories and stop at the ends", () => {
    const start = createPoliciesState()
    expect(policiesKey(start, "k", CATEGORIES).state).toBe(start)
    const down = policiesKey(start, "j", CATEGORIES).state
    expect(down.row).toBe(1)
    expect(policiesKey(policiesKey(policiesKey(down, "\x1b[B", CATEGORIES).state, "\x1b[B", CATEGORIES).state, "\x1b[B", CATEGORIES).state.row).toBe(3)
  })

  test("left and right cycle the policy of the selected category through auto, review and never", () => {
    const at = (row: number, key: string) => policiesKey({ row }, key, CATEGORIES).action
    expect(at(0, "\x1b[C")).toEqual({ type: "policy", category: "commands", policy: "never" })
    expect(at(0, "\x1b[D")).toEqual({ type: "policy", category: "commands", policy: "auto" })
    expect(at(1, "l")).toEqual({ type: "policy", category: "preferences", policy: "review" })
    expect(at(3, "\r")).toEqual({ type: "policy", category: "volatile", policy: "auto" })
  })

  test("a, r and n set a policy directly; choosing the one already in force does nothing", () => {
    const at = (row: number, key: string) => policiesKey({ row }, key, CATEGORIES).action
    expect(at(0, "a")).toEqual({ type: "policy", category: "commands", policy: "auto" })
    expect(at(0, "n")).toEqual({ type: "policy", category: "commands", policy: "never" })
    expect(at(0, "r")).toEqual({ type: "none" })
    expect(at(1, "a")).toEqual({ type: "none" })
  })

  test("d returns a category to its default, and does nothing when it already is", () => {
    const at = (row: number) => policiesKey({ row }, "d", CATEGORIES).action
    expect(at(1)).toEqual({ type: "policy", category: "preferences", policy: "review" })
    expect(at(0)).toEqual({ type: "none" })
  })

  test("esc closes; with the categories not loaded nothing happens", () => {
    expect(policiesKey(createPoliciesState(), "\x1b", CATEGORIES).action).toEqual({ type: "close" })
    expect(policiesKey(createPoliciesState(), "a", undefined).action).toEqual({ type: "none" })
    expect(policiesKey(createPoliciesState(), "j", undefined).state.row).toBe(0)
  })
})

describe("policies tab render", () => {
  test("every category with its policy, what differs from the default, and what the selection means", () => {
    const rows = plain(renderPoliciesTab({ categories: CATEGORIES, state: { row: 1 }, width: 100, height: 20 }))
    const text = rows.join("\n")
    expect(text).toContain("a proposal in which a secret was redacted always waits for review")
    expect(rows.some((row) => row.startsWith("  Commands") && row.includes("‹ review ›"))).toBe(true)
    const preferences = rows.find((row) => row.startsWith("❯ Preferences"))!
    expect(preferences).toContain("‹ auto ›")
    expect(preferences).toContain("default review")
    expect(rows.find((row) => row.includes("Volatile"))).toContain("‹ never ›")
    expect(rows.find((row) => row.includes("Volatile"))).not.toContain("default never")
    expect(text).toContain("Preferences: a proposal is saved straight away")
    expect(text).toContain("How the user likes to work and be answered.")
  })

  test("loading, a narrow width without descriptions, and never outside its box", () => {
    expect(plain(renderPoliciesTab({ categories: undefined, state: createPoliciesState(), width: 60, height: 6 })).join("\n")).toContain("loading categories")
    const narrow = plain(renderPoliciesTab({ categories: CATEGORIES, state: createPoliciesState(), width: 60, height: 20 })).join("\n")
    expect(narrow).not.toContain("How the user likes")
    for (const [width, height] of [[20, 3], [40, 8], [60, 12], [120, 30]] as const) {
      const rows = renderPoliciesTab({ categories: CATEGORIES, state: { row: 2 }, width, height })
      expect(rows.length).toBeLessThanOrEqual(height)
      for (const row of plain(rows)) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(width)
    }
  })
})

describe("evolution tab keys", () => {
  const SUGGESTIONS = [suggestion(3), suggestion(2, { status: "accepted", kind: "instruction" }), suggestion(1, { status: "rejected" })]
  const press = (state: { selected: number }, key: string, mode: "off" | "observe" | "suggest" | "auto-safe" = "suggest") => evolutionKey(state, key, { mode, suggestions: SUGGESTIONS })

  test("left and right move the mode through off, observe, suggest and auto-safe, wrapping", () => {
    expect(press({ selected: 0 }, "\x1b[C", "off").action).toEqual({ type: "mode", mode: "observe" })
    expect(press({ selected: 0 }, "l", "suggest").action).toEqual({ type: "mode", mode: "auto-safe" })
    expect(press({ selected: 0 }, "m", "auto-safe").action).toEqual({ type: "mode", mode: "off" })
    expect(press({ selected: 0 }, "\x1b[D", "off").action).toEqual({ type: "mode", mode: "auto-safe" })
    expect(press({ selected: 0 }, "h", "suggest").action).toEqual({ type: "mode", mode: "observe" })
  })

  test("a accepts and x rejects only a pending suggestion", () => {
    expect(press({ selected: 0 }, "a").action).toEqual({ type: "suggestion", suggestionId: 3, decision: "accept" })
    expect(press({ selected: 0 }, "x").action).toEqual({ type: "suggestion", suggestionId: 3, decision: "reject" })
    expect(press({ selected: 1 }, "a").action).toEqual({ type: "none" })
    expect(press({ selected: 2 }, "x").action).toEqual({ type: "none" })
  })

  test("up and down move within the suggestions; esc closes", () => {
    const start = createEvolutionState()
    expect(press(start, "k").state).toBe(start)
    expect(press(start, "j").state.selected).toBe(1)
    expect(press({ selected: 2 }, "j").state.selected).toBe(2)
    expect(press(start, "\x1b").action).toEqual({ type: "close" })
    expect(evolutionKey(start, "a", { mode: "suggest", suggestions: undefined }).action).toEqual({ type: "none" })
  })
})

describe("evolution tab render", () => {
  const DATA: EvolutionData = { mode: "suggest", suggestions: [suggestion(3), suggestion(2, { status: "accepted", kind: "instruction", name: "answer-in-spanish", description: "Answer in Spanish when the user writes in Spanish." })], observed: { corrections: 4, preferences: 2, recurring: 1 } }

  test("the mode with its meaning, what was seen, the list and the selected suggestion's content", () => {
    const text = plain(renderEvolutionTab({ mode: "suggest", data: DATA, state: createEvolutionState(), width: 100, height: 30, now: NOW })).join("\n")
    expect(text).toContain("mode     ‹ suggest ›  proposes memories (to review) and skill or instruction suggestions")
    expect(text).toContain("seen     4 corrections · 2 preferences · 1 recurring")
    expect(text).toContain("suggestions  1 pending · 2 shown")
    expect(text).toContain("› skill skill-3")
    expect(text).toContain("3 evidence · pending · 2h")
    expect(text).toContain("instr answer-in-spanish")
    expect(text).toContain(".mendcode/skills/skill-3/SKILL.md once accepted")
    expect(text).toContain("1. bun test")
  })

  test("off says nothing is recorded; observe explains why there is nothing to read", () => {
    const empty: EvolutionData = { mode: "off", suggestions: [], observed: { corrections: 0, preferences: 0, recurring: 0 } }
    const off = plain(renderEvolutionTab({ mode: "off", data: empty, state: createEvolutionState(), width: 100, height: 10, now: NOW })).join("\n")
    expect(off).toContain("nothing is recorded and no model is called")
    expect(off).toContain("not recording")
    expect(off).toContain("Evolution is off")
    expect(plain(renderEvolutionTab({ mode: "observe", data: empty, state: createEvolutionState(), width: 100, height: 10, now: NOW })).join("\n")).toContain("observe keeps no text")
    expect(plain(renderEvolutionTab({ mode: "suggest", data: empty, state: createEvolutionState(), width: 100, height: 10, now: NOW })).join("\n")).toContain("no suggestions yet")
    expect(plain(renderEvolutionTab({ mode: "suggest", data: undefined, state: createEvolutionState(), width: 100, height: 10, now: NOW })).join("\n")).toContain("loading suggestions")
  })

  test("never outside its box", () => {
    for (const [width, height] of [[20, 3], [40, 8], [60, 12], [120, 40]] as const) {
      const rows = renderEvolutionTab({ mode: "suggest", data: DATA, state: { selected: 1 }, width, height, now: NOW })
      expect(rows.length).toBeLessThanOrEqual(height)
      for (const row of plain(rows)) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(width)
    }
  })
})

describe("memory page: pin, scope and category on the list tabs", () => {
  function entry(id: string, patch: Partial<MemoryEntry> = {}): MemoryEntry {
    return { memoryId: id, scope: "project", directory: "/work/app", text: `text of ${id}`, category: "commands", status: "saved", source: "user", createdAt: NOW - 10_000, updatedAt: NOW - 1_000, ...patch } as MemoryEntry
  }
  const MEMORIES = [
    entry("s1", { text: "Run bun test", updatedAt: NOW - 1_000 }),
    entry("s2", { text: "Answer tersely", scope: "user", pinned: true, category: "preferences", updatedAt: NOW - 2_000 }),
    entry("s3", { text: "Scratch note", scope: "session", sessionId: "ses_abc", category: "volatile", updatedAt: NOW - 3_000 }),
    entry("p1", { status: "pending", source: "agent", text: "Proposal", updatedAt: NOW - 500 }),
    entry("a1", { status: "archived", text: "Old rule" }),
  ]
  const DATA: MemoryPageData = { categories: CATEGORIES }
  const start = (tab: MemoryPageState["tab"] = "saved") => ({ ...createMemoryPageState(), tab })
  function press(state: MemoryPageState, ...keys: string[]) {
    let current = state
    let action: ReturnType<typeof memoryPageKey>["action"] = { type: "none" }
    for (const key of keys) ({ state: current, action } = memoryPageKey(current, key, MEMORIES, 3, undefined, undefined, DATA))
    return { state: current, action }
  }
  const render = (state: MemoryPageState, width = 100, height = 30) => plain(renderMemoryPage({ memories: MEMORIES, state, width, height, now: NOW, directory: "/work/app", data: DATA }))

  test("p pins a saved memory and unpins a pinned one", () => {
    expect(press(start(), "p").action).toEqual({ type: "pin", memoryId: "s1", pinned: true })
    expect(press(start(), "j", "p").action).toEqual({ type: "pin", memoryId: "s2", pinned: false })
  })

  test("p on a pending or archived memory says why it cannot pin, instead of starting a filter", () => {
    expect(press(start("pending"), "p")).toMatchObject({ action: { type: "notice", text: "only saved memories can be pinned" }, state: { filter: "" } })
    expect(press(start("archived"), "p").action).toEqual({ type: "notice", text: "only saved memories can be pinned" })
  })

  test("s opens the scope picker on the current scope; enter or a number moves the memory", () => {
    const picker = press(start(), "s")
    expect(picker.state.pick).toEqual({ kind: "scope", index: 1 })
    expect(press(start(), "s", "\r").action).toEqual({ type: "notice", text: "already in project scope" })
    expect(press(start(), "s", "j", "\r").action).toEqual({ type: "scope", memoryId: "s1", scope: "session" })
    expect(press(start(), "s", "1").action).toEqual({ type: "scope", memoryId: "s1", scope: "user" })
    expect(press(start(), "s", "k", "k", "k", "\r").action).toEqual({ type: "scope", memoryId: "s1", scope: "user" })
    expect(press(start(), "s", "\x1b")).toMatchObject({ action: { type: "none" }, state: { tab: "saved" } })
    expect(press(start(), "s", "\x1b").state.pick).toBeUndefined()
  })

  test("s on a pending or archived memory asks to approve or restore it first", () => {
    expect(press(start("pending"), "s").action).toEqual({ type: "notice", text: "approve it first to change its scope" })
    expect(press(start("archived"), "s").action).toEqual({ type: "notice", text: "restore it first to change its scope" })
  })

  test("c opens the category picker on the current category; choosing another sets it", () => {
    expect(press(start(), "c").state.pick).toEqual({ kind: "category", index: 0 })
    expect(press(start(), "c", "j", "\r").action).toEqual({ type: "category", memoryId: "s1", category: "preferences" })
    expect(press(start(), "c", "3").action).toEqual({ type: "category", memoryId: "s1", category: "security" })
    expect(press(start(), "c", "\r").action).toEqual({ type: "notice", text: "already in commands" })
    expect(press(start("pending"), "c", "4").action).toEqual({ type: "category", memoryId: "p1", category: "volatile" })
  })

  test("c before the categories loaded says so", () => {
    const result = memoryPageKey(start(), "c", MEMORIES, 3, undefined, undefined, {})
    expect(result.action).toEqual({ type: "notice", text: "categories are still loading" })
  })

  test("while a picker is open other keys do nothing, and switching tab closes it", () => {
    const open = press(start(), "s").state
    expect(memoryPageKey(open, "x", MEMORIES, 3, undefined, undefined, DATA)).toEqual({ state: open, action: { type: "none" } })
    expect(memoryPageKey(open, "a", MEMORIES, 3, undefined, undefined, DATA).state).toBe(open)
    expect(memoryPageKey(open, "\t", MEMORIES, 3, undefined, undefined, DATA)).toEqual({ state: open, action: { type: "none" } })
  })

  test("the list shows scope, pin and session; the filter finds them by word", () => {
    const rows = render(start())
    expect(rows.find((row) => row.includes("Answer tersely") || row.includes("user · pinned"))).toBeDefined()
    expect(rows.join("\n")).toContain("user · pinned · preferences")
    expect(rows.join("\n")).toContain("session · volatile")
    expect(rows.join("\n")).toContain("project · commands")
    expect(render({ ...start(), filter: "pinned" }).join("\n")).toContain("Answer tersely")
    expect(render({ ...start(), filter: "pinned" }).join("\n")).not.toContain("Run bun test")
    expect(render({ ...start(), filter: "session" }).join("\n")).toContain("Scratch note")
  })

  test("the picker draws over the list with the current choice marked and its own footer", () => {
    const scope = render(press(start(), "s").state).join("\n")
    expect(scope).toContain("move to scope")
    expect(scope).toContain("re-creates the memory: its links are lost")
    expect(scope).toContain("› 2 project (current)")
    expect(scope).toContain("↑↓ choose · 1-9 pick · enter set · esc cancel")
    const category = render(press(start(), "c").state).join("\n")
    expect(category).toContain("set category")
    expect(category).toContain("› 1 commands (current)")
    expect(category).toContain("Recurring commands")
  })

  test("the wide detail names the session and the pin", () => {
    const wide = renderMemoryPage({ memories: MEMORIES, state: { ...start(), selected: 2 }, width: 130, height: 35, now: NOW, directory: "/work/app", data: DATA })
    expect(plain(wide).join("\n")).toContain("session ses_abc")
    const pinned = renderMemoryPage({ memories: MEMORIES, state: { ...start(), selected: 1 }, width: 130, height: 35, now: NOW, directory: "/work/app", data: DATA })
    expect(plain(pinned).join("\n")).toContain("user · pinned · preferences")
  })

  test("the hints of each list tab name the new keys", () => {
    expect(render(start("saved")).join("\n")).toContain("p pin")
    expect(render(start("saved")).join("\n")).toContain("s scope")
    expect(render(start("pending")).join("\n")).toContain("c category")
    expect(render(start("pending")).join("\n")).not.toContain("s scope")
  })

  test("the Policies and Evolution tabs render inside the page with their hints", () => {
    const policies = render({ ...start("policies") }).join("\n")
    expect(policies).toContain("6 Pol")
    expect(policies).toContain("↑↓ category")
    expect(policies).toContain("‹ auto ›")
    const evolution = plain(renderMemoryPage({ memories: MEMORIES, state: start("evolution"), width: 100, height: 30, now: NOW, directory: "/work/app", data: { evolutionMode: "observe" } })).join("\n")
    expect(evolution).toContain("←→ mode")
    expect(evolution).toContain("‹ observe ›")
  })

  test("policies and evolution keys come back as page actions", () => {
    expect(memoryPageKey({ ...start("policies") }, "a", MEMORIES, 3, undefined, undefined, DATA).action).toEqual({ type: "policy", category: "commands", policy: "auto" })
    expect(memoryPageKey({ ...start("evolution") }, "\x1b[C", MEMORIES, 3, undefined, undefined, { evolutionMode: "suggest" }).action).toEqual({ type: "evolutionMode", mode: "auto-safe" })
    const data: MemoryPageData = { evolutionMode: "suggest", evolution: { mode: "suggest", suggestions: [suggestion(9)], observed: { corrections: 0, preferences: 0, recurring: 0 } } }
    expect(memoryPageKey({ ...start("evolution") }, "x", MEMORIES, 3, undefined, undefined, data).action).toEqual({ type: "suggestion", suggestionId: 9, decision: "reject" })
    expect(memoryPageKey({ ...start("policies") }, "\x1b", MEMORIES, 3, undefined, undefined, DATA).action).toEqual({ type: "close" })
  })

  test("typing the dream budget does not switch tabs on digits", () => {
    const typing = { ...start("dream"), dream: { selected: 0, typing: "" } }
    const after = memoryPageKey(typing, "5", MEMORIES, 3, undefined, [], DATA)
    expect(after.state.tab).toBe("dream")
    expect(after.state.dream.typing).toBe("5")
    const saved = memoryPageKey(after.state, "k", MEMORIES, 3, undefined, [], DATA)
    expect(memoryPageKey(saved.state, "\r", MEMORIES, 3, undefined, [], DATA).action).toEqual({ type: "dreamBudget", tokens: 5_000 })
  })
})
